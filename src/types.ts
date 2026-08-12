import type { REPORT_SCHEMA_VERSION } from './constants.js';

export type PackageManagerName = 'npm' | 'pnpm' | 'yarn';
export type DependencyField =
  | 'dependencies'
  | 'devDependencies'
  | 'optionalDependencies';

export type CommandArray = readonly [string, ...string[]];

/** Internal-only fixture transport; it is not accepted by CLI, Action, or YAML input. */
export const FIXTURE_LOCAL_PATH: unique symbol = Symbol('fixture-local-path');

export interface ProjectOverrides {
  readonly packageManager?: PackageManagerName;
  readonly packageManagerVersion?: string;
  readonly lockfile?: string;
  readonly installCommand?: CommandArray;
  readonly lockfileCommand?: CommandArray;
  readonly testCommand?: CommandArray;
  readonly buildCommand?: CommandArray;
}

export interface ConsumerSpec extends ProjectOverrides {
  readonly repositoryUrl: string;
  readonly commit: string;
  readonly workingDirectory: string;
  readonly [FIXTURE_LOCAL_PATH]?: string;
}

export interface CandidateConfig extends ProjectOverrides {
  readonly root: string;
  readonly workingDirectory: string;
}

export interface RunConfig {
  readonly candidate: CandidateConfig;
  readonly consumers: readonly ConsumerSpec[];
  readonly outputDirectory: string;
  readonly timeoutSeconds: number;
  readonly dockerExecutable: string;
  readonly dockerImage: string;
}

export interface PackageManagerDetection {
  readonly name: PackageManagerName;
  readonly declaredVersion: string | null;
  readonly requestedVersion: string;
  readonly actualVersion: string | null;
  readonly lockfile: string;
  readonly workingDirectory: string;
  readonly immutableInstallCommand: CommandArray;
  readonly lockfileCommand: CommandArray;
  readonly testCommand: CommandArray;
}

export interface CandidateArtifact {
  readonly tarballPath: string;
  readonly fileName: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly sha256: string;
  readonly packageJsonSha256: string;
  readonly contents: readonly string[];
  readonly packageFileHashes: Readonly<Record<string, string>>;
  readonly packageFileModes: Readonly<Record<string, number>>;
  readonly packageLinks: Readonly<Record<string, string>>;
}

export type CompatibilityClassification =
  | 'compatible'
  | 'candidate-regression'
  | 'inconclusive-preexisting'
  | 'candidate-improvement';

export type ResultClassification = CompatibilityClassification | 'tool-error';

export type FailurePhase =
  | 'configuration'
  | 'checkout'
  | 'baseline-install'
  | 'baseline-test'
  | 'candidate-injection'
  | 'candidate-lockfile'
  | 'candidate-install'
  | 'candidate-verification'
  | 'candidate-test'
  | 'docker'
  | 'timeout';

export interface PhaseResult {
  readonly status: 'pass' | 'fail' | 'not-run';
  readonly installStatus: 'pass' | 'fail' | 'not-run';
  readonly testStatus: 'pass' | 'fail' | 'not-run';
  readonly durationMs: number;
}

export interface ConsumerResult {
  readonly repositoryUrl: string;
  readonly commit: string;
  readonly packageManager: PackageManagerName | null;
  readonly declaredPackageManagerVersion: string | null;
  readonly actualPackageManagerVersion: string | null;
  readonly nodeVersion: string;
  readonly operatingSystem: 'linux';
  readonly architecture: string;
  readonly baseline: PhaseResult;
  readonly candidate: PhaseResult;
  readonly classification: ResultClassification;
  readonly failurePhase: FailurePhase | null;
  readonly durationMs: number;
  readonly candidatePackageName: string;
  readonly candidatePackageVersion: string;
  readonly candidateTarballSha256: string;
  readonly originalLockfileHash: string | null;
  readonly candidateLockfileHash: string | null;
  readonly dependencyFieldReplaced: DependencyField | null;
  readonly timeoutOrInfrastructureReason: string | null;
  readonly diagnosticExcerpt: string;
}

export interface CanaryReport {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
  readonly tool: {
    readonly name: 'downstream-canary';
    readonly version: string;
  };
  readonly generatedAt: string;
  readonly candidate: {
    readonly packageName: string;
    readonly packageVersion: string;
    readonly tarballSha256: string;
    readonly contents: readonly string[];
  };
  readonly environment: {
    readonly dockerImage: string;
    readonly nodeVersion: string;
  };
  readonly results: readonly ConsumerResult[];
  readonly summary: {
    readonly compatible: number;
    readonly candidateRegressions: number;
    readonly inconclusivePreexisting: number;
    readonly candidateImprovements: number;
    readonly toolErrors: number;
    readonly exitCode: 0 | 1 | 2;
  };
}

export interface ProcessResult {
  readonly command: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly output: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

export interface DockerRunOptions {
  readonly workspace: string;
  readonly cacheDirectory?: string;
  readonly command: CommandArray;
  readonly timeoutSeconds: number;
  readonly network: 'bridge' | 'none';
  readonly phase: string;
  readonly corepackReadOnly?: boolean;
  readonly extraEnvironment?: Readonly<Record<string, string>> | undefined;
}
