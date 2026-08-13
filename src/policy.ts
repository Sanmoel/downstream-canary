import { sha256 } from './util/hash.js';
import { stableStringify } from './util/stable-json.js';
import type {
  CommandArray,
  ConsumerResult,
  PackageManagerDetection,
  ResolvedPolicy,
  RunConfig,
} from './types.js';
import {
  DEFAULT_RUN_TIMEOUT_SECONDS,
  MAX_GENERATED_BYTES_PER_LANE,
  MAX_GENERATED_FILES_PER_LANE,
} from './constants.js';

export interface ResolvedPolicyContext {
  readonly config: RunConfig;
  readonly candidateManager: PackageManagerDetection;
  readonly candidateBuildCommand: CommandArray | null;
}

export function resolvePolicy(
  results: readonly ConsumerResult[],
  context?: ResolvedPolicyContext,
): ResolvedPolicy {
  const config = context?.config;
  return {
    version: 1,
    source: config?.executionMode ?? 'library',
    candidate: {
      workingDirectory: config?.candidate.workingDirectory ?? '.',
      packageManager: context?.candidateManager.name ?? null,
      packageManagerVersion: context?.candidateManager.requestedVersion ?? null,
      buildCommand: context?.candidateBuildCommand ?? null,
    },
    consumers: results.map((result) => ({
      repositoryUrl: result.repositoryUrl,
      commit: result.commit,
      packageManager: result.packageManager,
      packageManagerVersion: result.requestedPackageManagerVersion,
      testCommand: result.executedTestCommand,
    })),
    limits: {
      commandTimeoutSeconds: config?.timeoutSeconds ?? 0,
      wholeRunTimeoutSeconds:
        config?.runTimeoutSeconds ?? DEFAULT_RUN_TIMEOUT_SECONDS,
      generatedFileCountPerLane: MAX_GENERATED_FILES_PER_LANE,
      generatedBytesPerLane: MAX_GENERATED_BYTES_PER_LANE,
    },
  };
}

export function policySha256(policy: ResolvedPolicy): string {
  return sha256(stableStringify(policy));
}
