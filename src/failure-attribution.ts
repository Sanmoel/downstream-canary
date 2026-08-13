import type {
  CandidateInstallFailureAttribution,
  PackageManagerName,
  ProcessResult,
} from './types.js';

export interface FailureDisposition {
  readonly classification: 'candidate-regression' | 'tool-error';
  readonly attribution: CandidateInstallFailureAttribution;
  readonly reason: string;
}

export interface CandidateLockfileFailureDisposition {
  readonly classification: 'tool-error';
  readonly failurePhase: 'candidate-lockfile';
  readonly reason: string;
}

const NETWORK_FAILURE =
  /\b(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENETUNREACH|ENOTFOUND|ETIMEDOUT|ERR_SOCKET_TIMEOUT)\b|network (?:error|failure)|socket hang up|fetch failed/i;
const REGISTRY_FAILURE =
  /\b(?:E401|E403|E404|ERR_PNPM_FETCH_[0-9]+|YN0035)\b|registry(?:\.npmjs\.org)?[^\n]*(?:unavailable|error|failed)/i;
const COREPACK_FAILURE =
  /\bcorepack\b[^\n]*(?:error|failed|unable|download)|cannot find matching keyid|package manager signature/i;

const RESOLUTION_FAILURE: Readonly<Record<PackageManagerName, RegExp>> = {
  npm: /\bERESOLVE\b|unable to resolve dependency tree/i,
  pnpm: /\bERR_PNPM_(?:PEER_DEP_ISSUES|BAD_PEER_DEPENDENCY|UNSUPPORTED_ENGINE)\b/i,
  yarn: /\bYN(?:0001|0027|0060|0082|0086)\b[^\n]*(?:resolution|peer|range|version|engine)/i,
};

const LIFECYCLE_FAILURE: Readonly<Record<PackageManagerName, RegExp>> = {
  npm: /(?:npm (?:error|ERR!) command failed|\bELIFECYCLE\b)/i,
  pnpm: /\bELIFECYCLE\b|lifecycle script failed/i,
  yarn: /\bYN0009\b|could(?:n't| not) be built successfully/i,
};

function infrastructureAttribution(
  output: string,
): CandidateInstallFailureAttribution | undefined {
  if (COREPACK_FAILURE.test(output)) return 'corepack';
  if (NETWORK_FAILURE.test(output)) return 'network';
  if (REGISTRY_FAILURE.test(output)) return 'registry';
  return undefined;
}

export function candidateLockfileFailureDisposition(
  result: Pick<ProcessResult, 'output' | 'timedOut' | 'exitCode'>,
): CandidateLockfileFailureDisposition {
  const reason = result.timedOut
    ? 'Candidate lockfile generation timed out; no compatibility conclusion is possible.'
    : 'Candidate lockfile generation failed; registry, tooling, and resolution causes are not trusted regression evidence.';
  return {
    classification: 'tool-error',
    failurePhase: 'candidate-lockfile',
    reason,
  };
}

export function attributeCandidateInstallFailure(
  manager: PackageManagerName,
  failedInstall: Pick<ProcessResult, 'output' | 'timedOut' | 'exitCode'>,
  scriptsDisabledInstall: Pick<ProcessResult, 'output' | 'timedOut' | 'exitCode'>,
): FailureDisposition {
  if (failedInstall.timedOut || scriptsDisabledInstall.timedOut) {
    return {
      classification: 'tool-error',
      attribution: 'unknown',
      reason: 'Candidate installation or its attribution probe timed out.',
    };
  }

  const infrastructure =
    infrastructureAttribution(scriptsDisabledInstall.output) ??
    infrastructureAttribution(failedInstall.output);
  if (infrastructure) {
    return {
      classification: 'tool-error',
      attribution: infrastructure,
      reason: `Candidate installation has an untrusted ${infrastructure} failure.`,
    };
  }

  if (
    scriptsDisabledInstall.exitCode === 0 &&
    LIFECYCLE_FAILURE[manager].test(failedInstall.output)
  ) {
    return {
      classification: 'candidate-regression',
      attribution: 'lifecycle-incompatibility',
      reason: 'The frozen install succeeds with lifecycle scripts disabled and fails with a manager-attributed lifecycle error.',
    };
  }

  if (
    scriptsDisabledInstall.exitCode !== 0 &&
    RESOLUTION_FAILURE[manager].test(scriptsDisabledInstall.output)
  ) {
    return {
      classification: 'candidate-regression',
      attribution: 'dependency-resolution',
      reason: 'The scripts-disabled frozen install reports a package-manager dependency-resolution incompatibility.',
    };
  }

  return {
    classification: 'tool-error',
    attribution: 'unknown',
    reason: 'Candidate installation failed without positive dependency-resolution or lifecycle incompatibility evidence.',
  };
}
