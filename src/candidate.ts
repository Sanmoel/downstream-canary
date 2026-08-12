import { cp, lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_PACKAGE_MANAGER_VERSIONS } from './constants.js';
import type { DockerRunner } from './docker.js';
import { CanaryError } from './errors.js';
import {
  detectPackageManager,
  managerRunCommand,
  managerEnvironment,
  managerVersionCommand,
  readManifest,
} from './package-manager.js';
import { validateCandidateTarball } from './tarball.js';
import type {
  CandidateArtifact,
  CandidateConfig,
  CommandArray,
  PackageManagerDetection,
  ProcessResult,
} from './types.js';
import { diagnosticExcerpt } from './util/logs.js';
import {
  validateRelativeWorkingDirectory,
  validatePackageVersion,
  validateSafePackageName,
} from './validation.js';

export interface BuiltCandidate {
  readonly artifact: CandidateArtifact;
  readonly manager: PackageManagerDetection;
}

const COPY_EXCLUSIONS = new Set([
  '.git',
  'node_modules',
  '.downstream-canary',
  '.downstream-canary-results',
]);

async function copyCandidateSource(source: string, destination: string): Promise<void> {
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
    filter: (path) => {
      const relativePath = relative(source, path);
      if (relativePath === '') return true;
      return !relativePath
        .split(sep)
        .some((component) => COPY_EXCLUSIONS.has(component));
    },
  });
}

function requireSuccess(result: ProcessResult, message: string): void {
  if (result.timedOut) {
    throw new CanaryError('infrastructure', 'timeout', `${message} timed out.`, {
      diagnostic: result.output,
    });
  }
  if (result.exitCode !== 0) {
    throw new CanaryError('tooling', 'configuration', message, {
      diagnostic: result.output,
    });
  }
}

async function identifyManager(
  docker: DockerRunner,
  manager: PackageManagerDetection,
  workspace: string,
  cacheDirectory: string,
  timeoutSeconds: number,
): Promise<PackageManagerDetection> {
  const versionResult = await docker.run({
    workspace,
    cacheDirectory,
    command: managerVersionCommand(manager),
    timeoutSeconds,
    network: 'bridge',
    phase: 'candidate-manager-version',
  });
  requireSuccess(versionResult, `Unable to run ${manager.name}@${manager.requestedVersion}.`);
  const actualVersion = versionResult.stdout.trim();
  if (actualVersion !== manager.requestedVersion) {
    throw new CanaryError(
      'tooling',
      'configuration',
      `Requested ${manager.name}@${manager.requestedVersion}, but ${actualVersion} executed.`,
    );
  }
  return { ...manager, actualVersion };
}

export async function buildCandidate(
  config: CandidateConfig,
  docker: DockerRunner,
  temporaryRoot: string,
  timeoutSeconds: number,
): Promise<BuiltCandidate> {
  const sourceRoot = resolve(config.root);
  const workingDirectory = validateRelativeWorkingDirectory(config.workingDirectory);
  if (workingDirectory !== '.') {
    throw new CanaryError(
      'unsupported-project',
      'configuration',
      'Nested candidate package roots are unsupported; set the candidate root to the package directory.',
    );
  }
  const sourceProject = resolve(sourceRoot, workingDirectory);
  const relativeProject = relative(sourceRoot, sourceProject);
  if (relativeProject === '..' || relativeProject.startsWith(`..${sep}`)) {
    throw new CanaryError(
      'configuration',
      'configuration',
      'Candidate working directory escapes the candidate root.',
    );
  }
  const rootMetadata = await lstat(sourceRoot).catch((error: unknown) => {
    throw new CanaryError(
      'configuration',
      'configuration',
      'Candidate root does not exist.',
      { cause: error },
    );
  });
  const projectMetadata = await lstat(sourceProject).catch((error: unknown) => {
    throw new CanaryError(
      'configuration',
      'configuration',
      'Candidate working directory does not exist.',
      { cause: error },
    );
  });
  if (
    !rootMetadata.isDirectory() ||
    rootMetadata.isSymbolicLink() ||
    !projectMetadata.isDirectory() ||
    projectMetadata.isSymbolicLink()
  ) {
    throw new CanaryError(
      'configuration',
      'configuration',
      'Candidate root and working directory must be real directories, not symbolic links.',
    );
  }
  const realSourceRoot = await realpath(sourceRoot);
  const realSourceProject = await realpath(sourceProject);
  const realRelativeProject = relative(realSourceRoot, realSourceProject);
  if (
    realRelativeProject === '..' ||
    realRelativeProject.startsWith(`..${sep}`)
  ) {
    throw new CanaryError(
      'configuration',
      'configuration',
      'Candidate working directory resolves outside the candidate root.',
    );
  }
  const manifest = await readManifest(sourceProject);
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    throw new CanaryError(
      'configuration',
      'configuration',
      'Candidate package.json must declare a package name.',
    );
  }
  validateSafePackageName(manifest.name);
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new CanaryError(
      'configuration',
      'configuration',
      'Candidate package.json must declare a package version.',
    );
  }
  validatePackageVersion(manifest.version);

  const checkout = join(temporaryRoot, 'candidate-source');
  await copyCandidateSource(sourceRoot, checkout);
  const project = resolve(checkout, workingDirectory);
  const cacheDirectory = join(temporaryRoot, 'candidate-cache');
  const outputDirectory = join(cacheDirectory, 'package-cache', 'packed');
  await mkdir(outputDirectory, { recursive: true });

  let manager = await detectPackageManager(
    project,
    workingDirectory,
    config,
    false,
  );
  manager = await identifyManager(
    docker,
    manager,
    project,
    cacheDirectory,
    timeoutSeconds,
  );

  const install = await docker.run({
    workspace: project,
    cacheDirectory,
    command: manager.immutableInstallCommand,
    timeoutSeconds,
    network: 'bridge',
    phase: 'candidate-build-install',
    corepackReadOnly: true,
    extraEnvironment: managerEnvironment(manager),
  });
  requireSuccess(install, 'Candidate dependency installation failed.');

  const copiedManifest = await readManifest(project);
  const buildCommand: CommandArray | undefined =
    config.buildCommand ??
    (typeof copiedManifest.scripts?.build === 'string'
      ? managerRunCommand(manager, 'build')
      : undefined);
  if (buildCommand) {
    const build = await docker.run({
      workspace: project,
      cacheDirectory,
      command: buildCommand,
      timeoutSeconds,
      network: 'none',
      phase: 'candidate-build',
      corepackReadOnly: true,
      extraEnvironment: managerEnvironment(manager),
    });
    requireSuccess(build, `Candidate build failed: ${diagnosticExcerpt(build.output)}`);
  }

  if (manager.name !== 'npm') {
    const npmWarmup = await docker.run({
      workspace: project,
      cacheDirectory,
      command: [
        'corepack',
        `npm@${DEFAULT_PACKAGE_MANAGER_VERSIONS.npm}`,
        '--version',
      ],
      timeoutSeconds,
      network: 'bridge',
      phase: 'candidate-pack-manager',
    });
    requireSuccess(
      npmWarmup,
      `Unable to provision npm@${DEFAULT_PACKAGE_MANAGER_VERSIONS.npm} for candidate packing.`,
    );
  }

  const pack = await docker.run({
    workspace: project,
    cacheDirectory,
    command: [
      'corepack',
      `npm@${DEFAULT_PACKAGE_MANAGER_VERSIONS.npm}`,
      'pack',
      '--json',
      '--pack-destination',
      '/canary-cache/packed',
    ],
    timeoutSeconds,
    network: 'none',
    phase: 'candidate-pack',
    corepackReadOnly: true,
    extraEnvironment: { npm_config_ignore_scripts: 'false' },
  });
  requireSuccess(pack, 'Candidate npm pack failed.');
  const outputMetadata = await lstat(outputDirectory).catch((error: unknown) => {
    throw new CanaryError(
      'tooling',
      'configuration',
      'Candidate pack output directory disappeared.',
      { cause: error },
    );
  });
  if (!outputMetadata.isDirectory() || outputMetadata.isSymbolicLink()) {
    throw new CanaryError(
      'tooling',
      'configuration',
      'Candidate pack output must remain a real directory.',
    );
  }
  const tarballs = (await readdir(outputDirectory)).filter((file) => file.endsWith('.tgz'));
  if (tarballs.length !== 1 || !tarballs[0]) {
    throw new CanaryError(
      'tooling',
      'configuration',
      `Candidate pack must produce exactly one .tgz; found ${tarballs.length}.`,
      { diagnostic: pack.output },
    );
  }
  const tarballPath = join(outputDirectory, basename(tarballs[0]));
  const artifact = await validateCandidateTarball(tarballPath, {
    expectedName: manifest.name,
    expectedVersion: manifest.version,
  });
  return { artifact, manager };
}
