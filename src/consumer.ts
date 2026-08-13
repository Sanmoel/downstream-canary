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
  GeneratedPath,
  PackageManagerDetection,
  PhaseResult,
  ProcessResult,
} from './types.js';
import {
  diffSnapshots,
  snapshotTree,
  validateLaneOutputs,
} from './util/files.js';
import { sha256File } from './util/hash.js';
import { diagnosticExcerpt } from './util/logs.js';
import {
  attributeCandidateInstallFailure,
  candidateLockfileFailureDisposition,
} from './failure-attribution.js';
import type { CandidateInstallFailureAttribution } from './types.js';
import type { RunBudget } from './budget.js';

interface MutableRunState {
  manager: PackageManagerDetection | null;
  baseline: PhaseResult;
  candidate: PhaseResult;
  originalLockfileHash: string | null;
  candidateLockfileHash: string | null;
  dependencyFieldReplaced: DependencyField | null;
  diagnostic: string;
  infrastructureReason: string | null;
  testCommand: PackageManagerDetection['testCommand'] | null;
  candidateInstallFailureAttribution: CandidateInstallFailureAttribution | null;
  managerProvisionSha256: string | null;
  baselineGeneratedPaths: readonly GeneratedPath[];
  candidateGeneratedPaths: readonly GeneratedPath[];
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
    requestedPackageManagerVersion: state.manager?.requestedVersion ?? null,
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
    executedTestCommand: state.testCommand,
    candidateInstallFailureAttribution:
      state.candidateInstallFailureAttribution,
    packageManagerProvisionSha256: state.managerProvisionSha256,
    generatedPaths: {
      baseline: state.baselineGeneratedPaths,
      candidate: state.candidateGeneratedPaths,
    },
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
  budget: RunBudget,
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
    testCommand: null,
    candidateInstallFailureAttribution: null,
    managerProvisionSha256: null,
    baselineGeneratedPaths: [],
    candidateGeneratedPaths: [],
  };

  try {
    const baselineCheckout = join(root, 'baseline-checkout');
    const candidateCheckout = join(root, 'candidate-checkout');
    await checkoutConsumer(
      consumer,
      baselineCheckout,
      join(root, 'git-config-baseline'),
      budget,
    );
    await checkoutConsumer(
      consumer,
      candidateCheckout,
      join(root, 'git-config-candidate'),
      budget,
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
    const managerProvision = await docker.provisionManager(
      baselineProject,
      join(root, 'manager-provision'),
      manager,
      budget.timeoutSeconds('consumer package-manager provisioning'),
      budget,
    );
    state.manager = { ...manager, actualVersion: managerProvision.version };
    state.managerProvisionSha256 = managerProvision.sha256;
    const baselineCache = join(root, 'baseline-cache');
    state.testCommand = manager.testCommand;

    const baselineInstall = await docker.run({
      workspace: baselineProject,
      cacheDirectory: baselineCache,
      command: manager.immutableInstallCommand,
      timeoutSeconds: budget.timeoutSeconds('baseline dependency installation'),
      network: 'bridge',
      phase: 'baseline-install',
      managerProvision,
      extraEnvironment: managerEnvironment(manager),
      budget,
    });
    appendDiagnostic(state, 'baseline install', baselineInstall);
    if (baselineInstall.timedOut || baselineInstall.exitCode !== 0) {
      state.baseline = testPhase(baselineInstall, undefined);
      state.infrastructureReason = baselineInstall.timedOut
        ? 'Baseline installation exceeded its command or consumer budget.'
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
      timeoutSeconds: budget.timeoutSeconds('baseline test'),
      network: 'none',
      phase: 'baseline-test',
      managerProvision,
      extraEnvironment: managerEnvironment(manager),
      budget,
    });
    appendDiagnostic(state, 'baseline test', baselineTest);
    state.baseline = testPhase(baselineInstall, baselineTest);
    if (baselineTest.timedOut) {
      state.infrastructureReason = 'Baseline test exceeded its command or consumer budget.';
    }
    const protectedPaths = new Set([
      'package.json',
      manager.lockfile,
      '.npmrc',
      '.yarnrc.yml',
      '.corepack.env',
      'pnpm-workspace.yaml',
      'pnpm-workspace.yml',
      '.pnp.cjs',
      '.pnp.loader.mjs',
    ]);
    const baselineAfter = await snapshotTree(baselineProject);
    state.baselineGeneratedPaths = await validateLaneOutputs({
      root: baselineProject,
      originalTracked: baselineOriginal,
      after: baselineAfter,
      protectedExpected: baselineOriginal,
      protectedPaths,
      phase: 'baseline-test',
      lane: 'Baseline',
    });
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
    const lockfileResult = await docker.run({
      workspace: candidateProject,
      cacheDirectory: candidateCache,
      command: candidateManager.lockfileCommand,
      timeoutSeconds: budget.timeoutSeconds('candidate lockfile generation'),
      network: 'bridge',
      phase: 'candidate-lockfile',
      managerProvision,
      extraEnvironment: managerLockfileEnvironment(candidateManager),
      budget,
    });
    appendDiagnostic(state, 'candidate lockfile', lockfileResult);
    if (lockfileResult.timedOut || lockfileResult.exitCode !== 0) {
      const disposition = candidateLockfileFailureDisposition(lockfileResult);
      state.infrastructureReason = disposition.reason;
      return buildResult(
        consumer,
        artifact,
        runtime,
        state,
        disposition.classification,
        disposition.failurePhase,
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
    let candidateInstall: ProcessResult;
    try {
      candidateInstall = await docker.run({
        workspace: candidateProject,
        cacheDirectory: candidateCache,
        command: candidateManager.immutableInstallCommand,
        timeoutSeconds: budget.timeoutSeconds('candidate dependency installation'),
        network: 'bridge',
        phase: 'candidate-install',
        managerProvision,
        extraEnvironment: managerEnvironment(candidateManager),
        budget,
      });
    } catch (error) {
      if (error instanceof CanaryError && error.phase === 'docker') {
        state.candidateInstallFailureAttribution = 'docker';
      }
      throw error;
    }
    appendDiagnostic(state, 'candidate install', candidateInstall);
    if (candidateInstall.timedOut) {
      state.candidate = testPhase(candidateInstall, undefined);
      state.infrastructureReason = 'Candidate installation exceeded its command or consumer budget.';
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
      await cleanNodeModules(candidateProject);
      let attributionInstall: ProcessResult;
      try {
        attributionInstall = await docker.run({
          workspace: candidateProject,
          cacheDirectory: candidateCache,
          command: candidateManager.immutableInstallCommand,
          timeoutSeconds: budget.timeoutSeconds('candidate install attribution'),
          network: 'bridge',
          phase: 'candidate-install-attribution',
          managerProvision,
          extraEnvironment: managerLockfileEnvironment(candidateManager),
          budget,
        });
      } catch (error) {
        if (error instanceof CanaryError && error.phase === 'docker') {
          state.candidateInstallFailureAttribution = 'docker';
        }
        throw error;
      }
      appendDiagnostic(
        state,
        'candidate install scripts-disabled attribution',
        attributionInstall,
      );
      const disposition = attributeCandidateInstallFailure(
        candidateManager.name,
        candidateInstall,
        attributionInstall,
      );
      state.candidateInstallFailureAttribution = disposition.attribution;
      state.candidate = {
        ...state.candidate,
        durationMs:
          state.candidate.durationMs + attributionInstall.durationMs,
      };
      const classification =
        state.baseline.status === 'pass'
          ? disposition.classification
          : 'tool-error';
      if (classification === 'tool-error') {
        state.infrastructureReason =
          state.baseline.status === 'pass'
            ? disposition.reason
            : 'Candidate installation failed before a candidate test while the baseline test was already failing.';
      }
      return buildResult(
        consumer,
        artifact,
        runtime,
        state,
        classification,
        'candidate-install',
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
      timeoutSeconds: budget.timeoutSeconds('candidate test'),
      network: 'none',
      phase: 'candidate-test',
      managerProvision,
      extraEnvironment: managerEnvironment(candidateManager),
      budget,
    });
    appendDiagnostic(state, 'candidate test', candidateTest);
    state.candidate = testPhase(candidateInstall, candidateTest);
    if (candidateTest.timedOut) {
      state.infrastructureReason = 'Candidate test exceeded its command or consumer budget.';
    }
    const candidateAfter = await snapshotTree(candidateProject);
    state.candidateGeneratedPaths = await validateLaneOutputs({
      root: candidateProject,
      originalTracked: candidateOriginal,
      after: candidateAfter,
      protectedExpected: afterLock,
      protectedPaths,
      phase: 'candidate-test',
      lane: 'Candidate',
    });
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
