import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { checkoutConsumer } from './checkout.js';
import { classifyCompatibility } from './classifier.js';
import { applyDependencyPatch, planDependencyPatch } from './dependency.js';
import type { ContainerRuntimeInfo, DockerRunner } from './docker.js';
import { asCanaryError, CanaryError } from './errors.js';
import { verifyInstalledCandidate } from './installed.js';
import {
  detectPackageManager,
  managerVersionCommand,
  managerEnvironment,
  managerLockfileEnvironment,
  readManifest,
} from './package-manager.js';
import type {
  CandidateArtifact,
  ConsumerResult,
  ConsumerSpec,
  DependencyField,
  FailurePhase,
  PackageManagerDetection,
  PhaseResult,
  ProcessResult,
} from './types.js';
import { diffSnapshots, snapshotTree } from './util/files.js';
import { sha256File } from './util/hash.js';
import { diagnosticExcerpt } from './util/logs.js';

interface MutableRunState {
  manager: PackageManagerDetection | null;
  baseline: PhaseResult;
  candidate: PhaseResult;
  originalLockfileHash: string | null;
  candidateLockfileHash: string | null;
  dependencyFieldReplaced: DependencyField | null;
  diagnostic: string;
  infrastructureReason: string | null;
}

const NOT_RUN: PhaseResult = {
  status: 'not-run',
  installStatus: 'not-run',
  testStatus: 'not-run',
  durationMs: 0,
};

function isWithin(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..');
}

async function projectPath(checkout: string, workingDirectory: string): Promise<string> {
  if (workingDirectory !== '.') {
    throw new CanaryError(
      'unsupported-project',
      'configuration',
      'Nested consumer package roots are unsupported in v0.1.',
    );
  }
  const path = resolve(checkout, workingDirectory);
  if (!isWithin(checkout, path)) {
    throw new CanaryError(
      'configuration',
      'configuration',
      'Consumer working directory escapes its checkout.',
    );
  }
  const metadata = await lstat(path).catch((error: unknown) => {
    throw new CanaryError(
      'unsupported-project',
      'configuration',
      'Consumer working directory does not exist.',
      { cause: error },
    );
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new CanaryError(
      'unsupported-project',
      'configuration',
      'Consumer working directory must be a real directory, not a symbolic link.',
    );
  }
  const realCheckout = await realpath(checkout);
  const realProject = await realpath(path);
  if (!isWithin(realCheckout, realProject)) {
    throw new CanaryError(
      'unsupported-project',
      'configuration',
      'Consumer working directory resolves outside its checkout.',
    );
  }
  return path;
}

async function requireReservedPathsAbsent(project: string): Promise<void> {
  for (const reserved of ['.downstream-canary', 'node_modules']) {
    try {
      await lstat(join(project, reserved));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    throw new CanaryError(
      'unsupported-project',
      'candidate-injection',
      `Clean consumer checkouts must not contain the reserved ${reserved} path.`,
    );
  }
}

function snapshotsEqual(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  const diff = diffSnapshots(left, right);
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}

function requireNoUnexpectedChanges(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  expectedChanged: ReadonlySet<string>,
  message: string,
): void {
  const diff = diffSnapshots(before, after);
  const unexpected = [
    ...diff.added.map((path) => `added:${path}`),
    ...diff.removed.map((path) => `removed:${path}`),
    ...diff.changed
      .filter((path) => !expectedChanged.has(path))
      .map((path) => `changed:${path}`),
  ];
  const missing = [...expectedChanged].filter((path) => !diff.changed.includes(path));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new CanaryError(
      'tooling',
      'candidate-injection',
      `${message} Unexpected: ${unexpected.join(', ') || 'none'}; missing expected changes: ${missing.join(', ') || 'none'}.`,
    );
  }
}

async function actualManagerVersion(
  docker: DockerRunner,
  manager: PackageManagerDetection,
  workspace: string,
  cacheDirectory: string,
  timeoutSeconds: number,
): Promise<string> {
  const result = await docker.run({
    workspace,
    cacheDirectory,
    command: managerVersionCommand(manager),
    timeoutSeconds,
    network: 'bridge',
    phase: `${manager.name}-version`,
  });
  if (result.timedOut || result.exitCode !== 0) {
    throw new CanaryError(
      'infrastructure',
      result.timedOut ? 'timeout' : 'docker',
      `Unable to run ${manager.name}@${manager.requestedVersion}.`,
      { diagnostic: result.output },
    );
  }
  const actual = result.stdout.trim();
  if (actual !== manager.requestedVersion) {
    throw new CanaryError(
      'tooling',
      'configuration',
      `Requested ${manager.name}@${manager.requestedVersion}, but ${actual} executed.`,
    );
  }
  return actual;
}

function testPhase(
  install: ProcessResult,
  test: ProcessResult | undefined,
): PhaseResult {
  return {
    status: test?.exitCode === 0 && !test.timedOut ? 'pass' : 'fail',
    installStatus: install.exitCode === 0 && !install.timedOut ? 'pass' : 'fail',
    testStatus:
      test === undefined
        ? 'not-run'
        : test.exitCode === 0 && !test.timedOut
          ? 'pass'
          : 'fail',
    durationMs: install.durationMs + (test?.durationMs ?? 0),
  };
}

function appendDiagnostic(state: MutableRunState, label: string, result: ProcessResult): void {
  const content = result.output.trim();
  if (content) state.diagnostic += `${state.diagnostic ? '\n\n' : ''}[${label}]\n${content}`;
}

function buildResult(
  consumer: ConsumerSpec,
  artifact: CandidateArtifact,
  runtime: ContainerRuntimeInfo,
  state: MutableRunState,
  classification: ConsumerResult['classification'],
  failurePhase: FailurePhase | null,
  durationMs: number,
): ConsumerResult {
  return {
    repositoryUrl: consumer.repositoryUrl,
    commit: consumer.commit,
    packageManager: state.manager?.name ?? null,
    declaredPackageManagerVersion: state.manager?.declaredVersion ?? null,
    actualPackageManagerVersion: state.manager?.actualVersion ?? null,
    nodeVersion: runtime.nodeVersion,
    operatingSystem: runtime.operatingSystem,
    architecture: runtime.architecture,
    baseline: state.baseline,
    candidate: state.candidate,
    classification,
    failurePhase,
    durationMs,
    candidatePackageName: artifact.packageName,
    candidatePackageVersion: artifact.packageVersion,
    candidateTarballSha256: artifact.sha256,
    originalLockfileHash: state.originalLockfileHash,
    candidateLockfileHash: state.candidateLockfileHash,
    dependencyFieldReplaced: state.dependencyFieldReplaced,
    timeoutOrInfrastructureReason: state.infrastructureReason,
    diagnosticExcerpt: diagnosticExcerpt(state.diagnostic),
  };
}

async function cleanNodeModules(project: string): Promise<void> {
  const nodeModules = join(project, 'node_modules');
  const resolved = resolve(nodeModules);
  if (!isWithin(project, resolved) || resolved === resolve(project)) {
    throw new CanaryError(
      'tooling',
      'candidate-injection',
      'Refusing to clean an unsafe node_modules path.',
    );
  }
  await rm(nodeModules, { recursive: true, force: true });
}

export async function runConsumer(
  consumer: ConsumerSpec,
  artifact: CandidateArtifact,
  docker: DockerRunner,
  runtime: ContainerRuntimeInfo,
  timeoutSeconds: number,
): Promise<ConsumerResult> {
  const started = performance.now();
  const root = await mkdtemp(join(tmpdir(), 'downstream-canary-consumer-'));
  const state: MutableRunState = {
    manager: null,
    baseline: NOT_RUN,
    candidate: NOT_RUN,
    originalLockfileHash: null,
    candidateLockfileHash: null,
    dependencyFieldReplaced: null,
    diagnostic: '',
    infrastructureReason: null,
  };

  try {
    const baselineCheckout = join(root, 'baseline-checkout');
    const candidateCheckout = join(root, 'candidate-checkout');
    await checkoutConsumer(
      consumer,
      baselineCheckout,
      join(root, 'git-config-baseline'),
      timeoutSeconds,
    );
    await checkoutConsumer(
      consumer,
      candidateCheckout,
      join(root, 'git-config-candidate'),
      timeoutSeconds,
    );
    const baselineProject = await projectPath(
      baselineCheckout,
      consumer.workingDirectory,
    );
    const candidateProject = await projectPath(
      candidateCheckout,
      consumer.workingDirectory,
    );
    await requireReservedPathsAbsent(baselineProject);
    await requireReservedPathsAbsent(candidateProject);
    const baselineOriginal = await snapshotTree(baselineProject);
    const candidateOriginal = await snapshotTree(candidateProject);
    if (!snapshotsEqual(baselineOriginal, candidateOriginal)) {
      throw new CanaryError(
        'infrastructure',
        'checkout',
        'Baseline and candidate lane checkouts are not byte-identical.',
      );
    }

    const manager = await detectPackageManager(
      baselineProject,
      consumer.workingDirectory,
      consumer,
    );
    const candidateManager = await detectPackageManager(
      candidateProject,
      consumer.workingDirectory,
      consumer,
    );
    if (JSON.stringify(manager) !== JSON.stringify(candidateManager)) {
      throw new CanaryError(
        'infrastructure',
        'checkout',
        'Package-manager detection differs between identical lanes.',
      );
    }
    const originalLockPath = join(baselineProject, manager.lockfile);
    state.originalLockfileHash = await sha256File(originalLockPath);
    const baselineCache = join(root, 'baseline-cache');
    const actualVersion = await actualManagerVersion(
      docker,
      manager,
      baselineProject,
      baselineCache,
      timeoutSeconds,
    );
    state.manager = { ...manager, actualVersion };

    const baselineInstall = await docker.run({
      workspace: baselineProject,
      cacheDirectory: baselineCache,
      command: manager.immutableInstallCommand,
      timeoutSeconds,
      network: 'bridge',
      phase: 'baseline-install',
      corepackReadOnly: true,
      extraEnvironment: managerEnvironment(manager),
    });
    appendDiagnostic(state, 'baseline install', baselineInstall);
    if (baselineInstall.timedOut || baselineInstall.exitCode !== 0) {
      state.baseline = testPhase(baselineInstall, undefined);
      state.infrastructureReason = baselineInstall.timedOut
        ? `Baseline installation exceeded ${timeoutSeconds} seconds.`
        : 'Baseline dependency installation failed, so the comparison is not trustworthy.';
      return buildResult(
        consumer,
        artifact,
        runtime,
        state,
        'tool-error',
        baselineInstall.timedOut ? 'timeout' : 'baseline-install',
        Math.round(performance.now() - started),
      );
    }

    const baselineTest = await docker.run({
      workspace: baselineProject,
      cacheDirectory: baselineCache,
      command: manager.testCommand,
      timeoutSeconds,
      network: 'none',
      phase: 'baseline-test',
      corepackReadOnly: true,
      extraEnvironment: managerEnvironment(manager),
    });
    appendDiagnostic(state, 'baseline test', baselineTest);
    state.baseline = testPhase(baselineInstall, baselineTest);
    if (baselineTest.timedOut) {
      state.infrastructureReason = `Baseline test exceeded ${timeoutSeconds} seconds.`;
    }
    const baselineAfter = await snapshotTree(baselineProject);
    if (!snapshotsEqual(baselineOriginal, baselineAfter)) {
      throw new CanaryError(
        'unsupported-project',
        'baseline-test',
        'Baseline install or test added, removed, or modified project files; the baseline must remain byte-identical.',
      );
    }
    if (baselineTest.timedOut) {
      return buildResult(
        consumer,
        artifact,
        runtime,
        state,
        'tool-error',
        'timeout',
        Math.round(performance.now() - started),
      );
    }

    const privateDirectory = join(candidateProject, '.downstream-canary');
    await mkdir(privateDirectory, { recursive: true });
    const candidateTarballPath = join(privateDirectory, 'candidate.tgz');
    await cp(artifact.tarballPath, candidateTarballPath, {
      force: false,
      errorOnExist: true,
    });
    if ((await sha256File(candidateTarballPath)) !== artifact.sha256) {
      throw new CanaryError(
        'tooling',
        'candidate-injection',
        'Copied candidate tarball hash does not match the verified artifact.',
      );
    }
    const candidateManifest = await readManifest(candidateProject);
    const plan = planDependencyPatch(
      candidateManifest,
      artifact.packageName,
      'file:.downstream-canary/candidate.tgz',
    );
    await applyDependencyPatch(candidateProject, plan);
    state.dependencyFieldReplaced = plan.field;
    const afterPatch = await snapshotTree(candidateProject);
    requireNoUnexpectedChanges(
      candidateOriginal,
      afterPatch,
      new Set(['package.json']),
      'Candidate manifest patch was not mechanically isolated.',
    );

    const candidateCache = join(root, 'candidate-cache');
    const candidateActualVersion = await actualManagerVersion(
      docker,
      candidateManager,
      candidateProject,
      candidateCache,
      timeoutSeconds,
    );
    if (candidateActualVersion !== actualVersion) {
      throw new CanaryError(
        'infrastructure',
        'docker',
        'Baseline and candidate lanes executed different package-manager versions.',
      );
    }

    const lockfileResult = await docker.run({
      workspace: candidateProject,
      cacheDirectory: candidateCache,
      command: candidateManager.lockfileCommand,
      timeoutSeconds,
      network: 'bridge',
      phase: 'candidate-lockfile',
      corepackReadOnly: true,
      extraEnvironment: managerLockfileEnvironment(candidateManager),
    });
    appendDiagnostic(state, 'candidate lockfile', lockfileResult);
    if (lockfileResult.timedOut) {
      state.infrastructureReason = `Candidate lockfile generation exceeded ${timeoutSeconds} seconds.`;
      throw new CanaryError(
        'infrastructure',
        'timeout',
        state.infrastructureReason,
        { diagnostic: lockfileResult.output },
      );
    }
    if (lockfileResult.exitCode !== 0) {
      state.candidate = testPhase(lockfileResult, undefined);
      const classification = classifyCompatibility(
        state.baseline.status === 'pass',
        false,
      );
      return buildResult(
        consumer,
        artifact,
        runtime,
        state,
        classification,
        state.baseline.status === 'pass' ? 'candidate-install' : 'baseline-test',
        Math.round(performance.now() - started),
      );
    }

    const afterLock = await snapshotTree(candidateProject);
    requireNoUnexpectedChanges(
      afterPatch,
      afterLock,
      new Set([candidateManager.lockfile]),
      'Candidate lockfile generation changed files outside the expected lockfile.',
    );
    const candidateLockPath = join(candidateProject, candidateManager.lockfile);
    const candidateLockMetadata = await lstat(candidateLockPath).catch(
      (error: unknown) => {
        throw new CanaryError(
          'tooling',
          'candidate-injection',
          'Candidate lockfile generation did not produce a regular lockfile.',
          { cause: error },
        );
      },
    );
    if (!candidateLockMetadata.isFile() || candidateLockMetadata.isSymbolicLink()) {
      throw new CanaryError(
        'tooling',
        'candidate-injection',
        'Candidate lockfile generation did not produce a regular lockfile.',
      );
    }
    state.candidateLockfileHash = await sha256File(candidateLockPath);
    if (state.candidateLockfileHash === state.originalLockfileHash) {
      throw new CanaryError(
        'tooling',
        'candidate-injection',
        'Candidate lockfile hash did not change after package injection.',
      );
    }
    const lockText = await readFile(candidateLockPath, 'utf8');
    if (!lockText.includes('.downstream-canary/candidate.tgz')) {
      throw new CanaryError(
        'tooling',
        'candidate-injection',
        'Generated candidate lockfile does not reference the private candidate tarball.',
      );
    }

    await cleanNodeModules(candidateProject);
    const candidateInstall = await docker.run({
      workspace: candidateProject,
      cacheDirectory: candidateCache,
      command: candidateManager.immutableInstallCommand,
      timeoutSeconds,
      network: 'bridge',
      phase: 'candidate-install',
      corepackReadOnly: true,
      extraEnvironment: managerEnvironment(candidateManager),
    });
    appendDiagnostic(state, 'candidate install', candidateInstall);
    if (candidateInstall.timedOut) {
      state.candidate = testPhase(candidateInstall, undefined);
      state.infrastructureReason = `Candidate installation exceeded ${timeoutSeconds} seconds.`;
      return buildResult(
        consumer,
        artifact,
        runtime,
        state,
        'tool-error',
        'timeout',
        Math.round(performance.now() - started),
      );
    }
    if (candidateInstall.exitCode !== 0) {
      state.candidate = testPhase(candidateInstall, undefined);
      return buildResult(
        consumer,
        artifact,
        runtime,
        state,
        classifyCompatibility(state.baseline.status === 'pass', false),
        state.baseline.status === 'pass' ? 'candidate-install' : 'baseline-test',
        Math.round(performance.now() - started),
      );
    }

    state.candidate = {
      status: 'not-run',
      installStatus: 'pass',
      testStatus: 'not-run',
      durationMs: candidateInstall.durationMs,
    };
    await verifyInstalledCandidate(candidateProject, artifact);
    const candidateTest = await docker.run({
      workspace: candidateProject,
      cacheDirectory: candidateCache,
      command: manager.testCommand,
      timeoutSeconds,
      network: 'none',
      phase: 'candidate-test',
      corepackReadOnly: true,
      extraEnvironment: managerEnvironment(candidateManager),
    });
    appendDiagnostic(state, 'candidate test', candidateTest);
    state.candidate = testPhase(candidateInstall, candidateTest);
    if (candidateTest.timedOut) {
      state.infrastructureReason = `Candidate test exceeded ${timeoutSeconds} seconds.`;
    }
    const candidateAfter = await snapshotTree(candidateProject);
    const finalDifference = diffSnapshots(candidateOriginal, candidateAfter);
    const unexpectedFinalChanges = [
      ...finalDifference.added,
      ...finalDifference.removed,
      ...finalDifference.changed.filter(
        (path) => path !== 'package.json' && path !== candidateManager.lockfile,
      ),
    ];
    if (unexpectedFinalChanges.length > 0) {
      throw new CanaryError(
        'unsupported-project',
        'candidate-test',
        `Candidate install or test modified original files outside the planned manifest and lockfile: ${unexpectedFinalChanges.join(', ')}.`,
      );
    }
    for (const protectedPath of ['package.json', candidateManager.lockfile]) {
      if (candidateAfter.get(protectedPath) !== afterLock.get(protectedPath)) {
        throw new CanaryError(
          'unsupported-project',
          'candidate-test',
          `Candidate install or test modified protected file ${protectedPath}.`,
        );
      }
    }
    if (candidateTest.timedOut) {
      return buildResult(
        consumer,
        artifact,
        runtime,
        state,
        'tool-error',
        'timeout',
        Math.round(performance.now() - started),
      );
    }

    const classification = classifyCompatibility(
      state.baseline.status === 'pass',
      state.candidate.status === 'pass',
    );
    const failurePhase: FailurePhase | null =
      classification === 'candidate-regression'
        ? 'candidate-test'
        : classification === 'inconclusive-preexisting' ||
            classification === 'candidate-improvement'
          ? 'baseline-test'
          : null;
    return buildResult(
      consumer,
      artifact,
      runtime,
      state,
      classification,
      failurePhase,
      Math.round(performance.now() - started),
    );
  } catch (error) {
    const canaryError = asCanaryError(error, 'configuration');
    state.diagnostic += `${state.diagnostic ? '\n\n' : ''}${canaryError.diagnostic}`;
    if (canaryError.kind === 'infrastructure') {
      state.infrastructureReason = canaryError.message;
    }
    return buildResult(
      consumer,
      artifact,
      runtime,
      state,
      'tool-error',
      canaryError.phase,
      Math.round(performance.now() - started),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
