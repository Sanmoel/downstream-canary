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
  ProcessResult,
} from './types.js';

export interface ContainerRuntimeInfo {
  readonly nodeVersion: string;
  readonly operatingSystem: 'linux';
  readonly architecture: string;
}

export class DockerRunner {
  readonly #executable: string;
  readonly #image: string;
  #configDirectory: string | undefined;
  #dockerHost: string | undefined = process.env.DOCKER_HOST;

  public constructor(executable: string, image: string) {
    this.#executable = executable;
    this.#image = image;
  }

  async #environment(): Promise<Record<string, string>> {
    this.#configDirectory ??= await mkdtemp(join(tmpdir(), 'downstream-canary-docker-'));
    return safeHostEnvironment({
      DOCKER_CONFIG: this.#configDirectory,
      ...(this.#dockerHost ? { DOCKER_HOST: this.#dockerHost } : {}),
    });
  }

  public async ensureReady(): Promise<void> {
    let environment = await this.#environment();
    let version = await runProcess(
      [this.#executable, 'version', '--format', '{{.Server.Version}}'],
      { environment, timeoutMs: 30_000 },
    );
    if (version.exitCode !== 0 && !this.#dockerHost && process.env.HOME) {
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
          timeoutMs: 30_000,
        },
      );
      const discoveredHost = context.stdout.trim();
      if (context.exitCode === 0 && /^unix:\/\/.+/.test(discoveredHost)) {
        this.#dockerHost = discoveredHost;
        environment = await this.#environment();
        version = await runProcess(
          [this.#executable, 'version', '--format', '{{.Server.Version}}'],
          { environment, timeoutMs: 30_000 },
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
      { environment, timeoutMs: 30_000 },
    );
    if (inspect.exitCode !== 0) {
      const pull = await runProcess([this.#executable, 'pull', this.#image], {
        environment,
        timeoutMs: 10 * 60_000,
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
  }

  public async run(options: DockerRunOptions): Promise<ProcessResult> {
    const cacheDirectory =
      options.cacheDirectory ?? join(options.workspace, '.downstream-canary', 'runtime-cache');
    const packageCacheDirectory = join(cacheDirectory, 'package-cache');
    const corepackDirectory = join(cacheDirectory, 'corepack');
    await mkdir(packageCacheDirectory, { recursive: true });
    await mkdir(corepackDirectory, { recursive: true });
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
      npm_config_cache: '/canary-cache/npm',
      npm_config_userconfig: '/dev/null',
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
      `type=bind,src=${corepackDirectory},dst=/corepack-home${options.corepackReadOnly ? ',readonly' : ''}`,
      '--workdir',
      '/workspace',
    ];
    for (const [key, value] of Object.entries(environment)) {
      args.push('--env', `${key}=${value}`);
    }
    args.push(this.#image, ...options.command);
    const command = args as unknown as CommandArray;
    const result = await runProcess(command, {
      environment: await this.#environment(),
      timeoutMs: options.timeoutSeconds * 1000,
    });

    if (result.timedOut || result.exitCode !== 0) {
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

  async #cleanupContainer(name: string): Promise<void> {
    const environment = await this.#environment();
    await runProcess([this.#executable, 'kill', name], {
      environment,
      timeoutMs: 10_000,
    });
    await runProcess([this.#executable, 'rm', '--force', name], {
      environment,
      timeoutMs: 10_000,
    });
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
    if (this.#configDirectory) {
      await rm(this.#configDirectory, { recursive: true, force: true });
      this.#configDirectory = undefined;
    }
  }
}
