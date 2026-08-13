import process from 'node:process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DOCKER_LIMITS, NODE_VERSION } from './constants.js';
import { CanaryError } from './errors.js';
import { runProcess, safeHostEnvironment } from './process.js';
import { isSecretName } from './util/logs.js';
import type {
  CommandArray,
  DockerRunOptions,
  ManagerProvision,
  PackageManagerDetection,
  ProcessResult,
} from './types.js';
import { validateLocalDockerHost } from './action-environment.js';
import { snapshotTree } from './util/files.js';
import { stableStringify } from './util/stable-json.js';
import { sha256 } from './util/hash.js';
import { managerVersionCommand } from './package-manager.js';
import type { RunBudget } from './budget.js';
import { diagnosticExcerpt } from './util/logs.js';

export interface ContainerRuntimeInfo {
  readonly nodeVersion: string;
  readonly operatingSystem: 'linux';
  readonly architecture: string;
}

export interface DockerRunnerOptions {
  readonly allowContextDiscovery?: boolean;
  readonly requireLocalDocker?: boolean;
  readonly runId?: string;
  readonly budget?: RunBudget;
}

export const DOCKER_RUN_LABEL = 'io.github.sanmoel.downstream-canary.run-id';

export class DockerRunner {
  readonly #executable: string;
  readonly #image: string;
  #configDirectory: string | undefined;
  #dockerHost: string | undefined;
  readonly #allowContextDiscovery: boolean;
  readonly #runId: string;
  readonly #budget: RunBudget | undefined;
  readonly #activeContainers = new Set<string>();
  readonly #cleanupInFlight = new Map<string, Promise<void>>();
  #ready = false;
  #disposePromise: Promise<void> | undefined;
  #closing = false;

  public constructor(
    executable: string,
    image: string,
    options: DockerRunnerOptions = {},
  ) {
    this.#executable = executable;
    this.#image = image;
    this.#allowContextDiscovery = options.allowContextDiscovery ?? true;
    this.#runId = options.runId ?? randomUUID();
    if (!/^[0-9a-f-]{8,64}$/i.test(this.#runId)) {
      throw new CanaryError(
        'configuration',
        'docker',
        'Docker run IDs must contain only hexadecimal characters and hyphens.',
      );
    }
    this.#budget = options.budget;
    this.#dockerHost = options.requireLocalDocker
      ? validateLocalDockerHost(process.env.DOCKER_HOST)
      : process.env.DOCKER_HOST;
  }

  public get runId(): string {
    return this.#runId;
  }

  #timeoutMs(requestedMs: number, phase: string): number {
    return this.#budget?.timeoutMilliseconds(phase, requestedMs) ?? requestedMs;
  }

  #assertOpen(): void {
    if (this.#closing) {
      throw new CanaryError(
        'infrastructure',
        'docker',
        'Docker runner cleanup has started; no new containers may be created.',
      );
    }
  }

  async #environment(): Promise<Record<string, string>> {
    this.#configDirectory ??= await mkdtemp(join(tmpdir(), 'downstream-canary-docker-'));
    return safeHostEnvironment({
      DOCKER_CONFIG: this.#configDirectory,
      ...(this.#dockerHost ? { DOCKER_HOST: this.#dockerHost } : {}),
    });
  }

  public async ensureReady(): Promise<void> {
    this.#assertOpen();
    let environment = await this.#environment();
    let version = await runProcess(
      [this.#executable, 'version', '--format', '{{.Server.Version}}'],
      { environment, timeoutMs: this.#timeoutMs(30_000, 'Docker readiness check') },
    );
    if (
      version.exitCode !== 0 &&
      !this.#dockerHost &&
      this.#allowContextDiscovery &&
      process.env.HOME
    ) {
      const context = await runProcess(
        [
          this.#executable,
          'context',
          'inspect',
          '--format',
          '{{(index .Endpoints "docker").Host}}',
        ],
        {
          environment: safeHostEnvironment({ HOME: process.env.HOME }),
          timeoutMs: this.#timeoutMs(30_000, 'Docker context discovery'),
        },
      );
      const discoveredHost = context.stdout.trim();
      if (context.exitCode === 0 && /^unix:\/\/.+/.test(discoveredHost)) {
        this.#dockerHost = discoveredHost;
        environment = await this.#environment();
        version = await runProcess(
          [this.#executable, 'version', '--format', '{{.Server.Version}}'],
          {
            environment,
            timeoutMs: this.#timeoutMs(30_000, 'Docker readiness check'),
          },
        );
      }
    }
    if (version.exitCode !== 0) {
      throw new CanaryError(
        'infrastructure',
        'docker',
        'Docker Engine is required and was not reachable.',
        { diagnostic: version.output },
      );
    }
    const inspect = await runProcess(
      [this.#executable, 'image', 'inspect', this.#image],
      { environment, timeoutMs: this.#timeoutMs(30_000, 'Docker image inspection') },
    );
    if (inspect.exitCode !== 0) {
      const pull = await runProcess([this.#executable, 'pull', this.#image], {
        environment,
        timeoutMs: this.#timeoutMs(10 * 60_000, 'Docker image pull'),
      });
      if (pull.exitCode !== 0) {
        throw new CanaryError(
          'infrastructure',
          'docker',
          `Unable to pull the pinned runner image ${this.#image}.`,
          { diagnostic: pull.output },
        );
      }
    }
    this.#ready = true;
  }

  async #provisionDigest(directory: string): Promise<string> {
    const snapshot = await snapshotTree(directory, new Set());
    return sha256(stableStringify([...snapshot.entries()]));
  }

  public async verifyManagerProvision(
    provision: ManagerProvision,
  ): Promise<void> {
    const actual = await this.#provisionDigest(provision.corepackDirectory);
    if (actual !== provision.sha256) {
      throw new CanaryError(
        'infrastructure',
        'docker',
        `The verified ${provision.name}@${provision.version} manager provision changed after it was sealed read-only.`,
      );
    }
  }

  public async provisionManager(
    workspace: string,
    cacheDirectory: string,
    manager: Pick<PackageManagerDetection, 'name' | 'requestedVersion'>,
    timeoutSeconds: number,
    budget?: RunBudget,
  ): Promise<ManagerProvision> {
    this.#assertOpen();
    const corepackDirectory = join(cacheDirectory, 'corepack');
    await mkdir(corepackDirectory, { recursive: true });
    const result = await this.#run(
      {
        workspace,
        cacheDirectory,
        command: managerVersionCommand(manager),
        timeoutSeconds,
        network: 'bridge',
        phase: `provision-${manager.name}-${manager.requestedVersion}`,
        ...(budget ? { budget } : {}),
      },
      corepackDirectory,
      false,
    );
    if (result.timedOut || result.exitCode !== 0) {
      throw new CanaryError(
        'infrastructure',
        result.timedOut ? 'timeout' : 'docker',
        `Unable to provision ${manager.name}@${manager.requestedVersion}.`,
        { diagnostic: result.output },
      );
    }
    const actualVersion = result.stdout.trim();
    if (actualVersion !== manager.requestedVersion) {
      throw new CanaryError(
        'tooling',
        'configuration',
        `Requested ${manager.name}@${manager.requestedVersion}, but ${actualVersion} executed.`,
      );
    }
    return {
      name: manager.name,
      version: actualVersion,
      corepackDirectory,
      sha256: await this.#provisionDigest(corepackDirectory),
    };
  }

  public async run(options: DockerRunOptions): Promise<ProcessResult> {
    this.#assertOpen();
    const cacheDirectory =
      options.cacheDirectory ?? join(options.workspace, '.downstream-canary', 'runtime-cache');
    const corepackDirectory =
      options.managerProvision?.corepackDirectory ?? join(cacheDirectory, 'empty-corepack');
    await mkdir(corepackDirectory, { recursive: true });
    if (options.managerProvision) {
      await this.verifyManagerProvision(options.managerProvision);
    }
    const result = await this.#run(options, corepackDirectory, true);
    if (options.managerProvision) {
      await this.verifyManagerProvision(options.managerProvision);
    }
    return result;
  }

  async #run(
    options: DockerRunOptions,
    corepackDirectory: string,
    corepackReadOnly: boolean,
  ): Promise<ProcessResult> {
    const cacheDirectory =
      options.cacheDirectory ?? join(options.workspace, '.downstream-canary', 'runtime-cache');
    const packageCacheDirectory = join(cacheDirectory, 'package-cache');
    await mkdir(packageCacheDirectory, { recursive: true });
    const name = `downstream-canary-${options.phase.replace(/[^a-z0-9_.-]/gi, '-')}-${randomUUID()}`;
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
    const gid = typeof process.getgid === 'function' ? process.getgid() : 1000;
    if (uid === 0 || gid === 0) {
      throw new CanaryError(
        'infrastructure',
        'docker',
        'Downstream Canary refuses to map containers to a root host user or group.',
      );
    }
    const environment: Record<string, string> = {
      CI: '1',
      HOME: '/tmp/home',
      COREPACK_HOME: '/corepack-home',
      COREPACK_ENV_FILE: '0',
      COREPACK_DEFAULT_TO_LATEST: '0',
      COREPACK_ENABLE_AUTO_PIN: '0',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      COREPACK_NPM_REGISTRY: 'https://registry.npmjs.org',
      npm_config_cache: '/canary-cache/npm',
      npm_config_userconfig: '/dev/null',
      npm_config_registry: 'https://registry.npmjs.org',
      XDG_CACHE_HOME: '/canary-cache/xdg',
      NO_COLOR: '1',
      ...options.extraEnvironment,
    };
    for (const name of Object.keys(environment)) {
      if (isSecretName(name)) {
        throw new CanaryError(
          'configuration',
          'configuration',
          `Refusing to forward secret-like environment variable ${name}.`,
        );
      }
    }

    const args: string[] = [
      this.#executable,
      'run',
      '--rm',
      '--init',
      '--name',
      name,
      '--label',
      `${DOCKER_RUN_LABEL}=${this.#runId}`,
      '--user',
      `${uid}:${gid}`,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges=true',
      '--read-only',
      '--pids-limit',
      DOCKER_LIMITS.pids,
      '--memory',
      DOCKER_LIMITS.memory,
      '--memory-swap',
      DOCKER_LIMITS.memory,
      '--cpus',
      DOCKER_LIMITS.cpus,
      '--network',
      options.network,
      '--tmpfs',
      `/tmp:rw,exec,nosuid,nodev,size=${DOCKER_LIMITS.tmpfsSize}`,
      '--mount',
      `type=bind,src=${options.workspace},dst=/workspace`,
      '--mount',
      `type=bind,src=${packageCacheDirectory},dst=/canary-cache`,
      '--mount',
      `type=bind,src=${corepackDirectory},dst=/corepack-home${corepackReadOnly ? ',readonly' : ''}`,
      '--workdir',
      '/workspace',
    ];
    for (const [key, value] of Object.entries(environment)) {
      args.push('--env', `${key}=${value}`);
    }
    args.push(this.#image, ...options.command);
    const command = args as unknown as CommandArray;
    this.#activeContainers.add(name);
    let result: ProcessResult;
    try {
      result = await runProcess(command, {
        environment: await this.#environment(),
        timeoutMs: this.#timeoutMs(
          options.budget?.timeoutMilliseconds(
            `Docker phase ${options.phase}`,
            options.timeoutSeconds * 1000,
          ) ?? options.timeoutSeconds * 1000,
          `Docker phase ${options.phase}`,
        ),
      });
    } finally {
      await this.#cleanupContainer(name);
    }
    if (!result.timedOut && (result.exitCode === null || result.exitCode === 125)) {
      throw new CanaryError(
        'infrastructure',
        'docker',
        `Docker could not start or supervise the ${options.phase} container.`,
        { diagnostic: result.output },
      );
    }
    return result;
  }

  async #inspectContainer(name: string): Promise<boolean> {
    const environment = await this.#environment();
    const result = await runProcess(
      [this.#executable, 'container', 'inspect', '--format', '{{.Id}}', name],
      {
        environment,
        timeoutMs: 10_000,
      },
    );
    if (result.exitCode === 0 && !result.timedOut) return true;
    if (
      !result.timedOut &&
      result.exitCode !== null &&
      /no such (?:object|container)/i.test(result.output)
    ) {
      return false;
    }
    throw new CanaryError(
      'infrastructure',
      'docker',
      `Unable to verify cleanup of container ${name}.`,
      { diagnostic: result.output },
    );
  }

  async #cleanupContainerAttempt(name: string): Promise<void> {
    const diagnostics: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (!(await this.#inspectContainer(name))) {
        this.#activeContainers.delete(name);
        return;
      }
      const environment = await this.#environment();
      const kill = await runProcess([this.#executable, 'kill', name], {
        environment,
        timeoutMs: 10_000,
      });
      if (
        kill.exitCode !== 0 &&
        !/no such (?:object|container)|is not running/i.test(kill.output)
      ) {
        diagnostics.push(`kill attempt ${attempt}: ${kill.output}`);
      }
      const remove = await runProcess(
        [this.#executable, 'rm', '--force', name],
        {
          environment,
          timeoutMs: 10_000,
        },
      );
      if (
        remove.exitCode !== 0 &&
        !/no such (?:object|container)/i.test(remove.output)
      ) {
        diagnostics.push(`remove attempt ${attempt}: ${remove.output}`);
      }
      if (!(await this.#inspectContainer(name))) {
        this.#activeContainers.delete(name);
        return;
      }
      await new Promise<void>((resolveDelay) => {
        setTimeout(resolveDelay, 100 * attempt);
      });
    }
    throw new CanaryError(
      'infrastructure',
      'docker',
      `Container ${name} remained after three verified cleanup attempts.`,
      { diagnostic: diagnosticExcerpt(diagnostics.join('\n')) },
    );
  }

  async #cleanupContainer(name: string): Promise<void> {
    const existing = this.#cleanupInFlight.get(name);
    if (existing) return await existing;
    const cleanup = this.#cleanupContainerAttempt(name).finally(() => {
      this.#cleanupInFlight.delete(name);
    });
    this.#cleanupInFlight.set(name, cleanup);
    return await cleanup;
  }

  async #containersForRun(): Promise<readonly string[]> {
    const result = await runProcess(
      [
        this.#executable,
        'container',
        'ls',
        '--all',
        '--quiet',
        '--filter',
        `label=${DOCKER_RUN_LABEL}=${this.#runId}`,
      ],
      {
        environment: await this.#environment(),
        timeoutMs: 10_000,
      },
    );
    if (result.timedOut || result.exitCode !== 0) {
      throw new CanaryError(
        'infrastructure',
        'docker',
        'Unable to perform the final run-label container sweep.',
        { diagnostic: result.output },
      );
    }
    const identifiers = result.stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (identifiers.some((identifier) => !/^[0-9a-f]{12,64}$/i.test(identifier))) {
      throw new CanaryError(
        'infrastructure',
        'docker',
        'Docker returned an invalid container identifier during cleanup.',
      );
    }
    return identifiers;
  }

  async #dispose(): Promise<void> {
    let cleanupError: unknown;
    try {
      if (this.#ready || this.#activeContainers.size > 0) {
        for (const name of [...this.#activeContainers]) {
          await this.#cleanupContainer(name);
        }
        for (const identifier of await this.#containersForRun()) {
          await this.#cleanupContainer(identifier);
        }
        const remaining = await this.#containersForRun();
        if (remaining.length > 0) {
          throw new CanaryError(
            'infrastructure',
            'docker',
            `Final cleanup left ${remaining.length} run-labeled container(s).`,
          );
        }
      }
    } catch (error) {
      cleanupError = error;
    }
    if (this.#configDirectory) {
      await rm(this.#configDirectory, { recursive: true, force: true });
      this.#configDirectory = undefined;
    }
    if (cleanupError) {
      throw cleanupError instanceof Error
        ? cleanupError
        : new CanaryError(
            'infrastructure',
            'docker',
            'Container cleanup failed with a non-error value.',
          );
    }
  }

  public async runtimeInfo(workspace: string, timeoutSeconds: number): Promise<ContainerRuntimeInfo> {
    const result = await this.run({
      workspace,
      timeoutSeconds,
      network: 'none',
      phase: 'runtime-info',
      command: [
        'node',
        '-e',
        'process.stdout.write(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch}))',
      ],
    });
    if (result.exitCode !== 0) {
      throw new CanaryError('infrastructure', 'docker', 'Unable to inspect the runner container.', {
        diagnostic: result.output,
      });
    }
    const value = JSON.parse(result.stdout) as {
      readonly node: string;
      readonly platform: string;
      readonly arch: string;
    };
    if (value.node !== `v${NODE_VERSION}` || value.platform !== 'linux') {
      throw new CanaryError(
        'infrastructure',
        'docker',
        `Pinned runner identity mismatch: ${value.node} ${value.platform}/${value.arch}.`,
      );
    }
    return {
      nodeVersion: value.node,
      operatingSystem: 'linux',
      architecture: value.arch,
    };
  }

  public async dispose(): Promise<void> {
    if (!this.#disposePromise) {
      this.#closing = true;
      this.#disposePromise = this.#dispose();
    }
    await this.#disposePromise;
  }
}
