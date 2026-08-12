import type { FailurePhase } from './types.js';

export type CanaryErrorKind =
  | 'configuration'
  | 'unsupported-project'
  | 'tooling'
  | 'infrastructure';

export class CanaryError extends Error {
  public readonly kind: CanaryErrorKind;
  public readonly phase: FailurePhase;
  public readonly diagnostic: string;

  public constructor(
    kind: CanaryErrorKind,
    phase: FailurePhase,
    message: string,
    options: { readonly cause?: unknown; readonly diagnostic?: string } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'CanaryError';
    this.kind = kind;
    this.phase = phase;
    this.diagnostic = options.diagnostic ?? message;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorDiagnostic(error: unknown): string {
  if (!(error instanceof CanaryError) || error.diagnostic === error.message) {
    return errorMessage(error);
  }
  return `${error.message}\n${error.diagnostic}`;
}

export function asCanaryError(
  error: unknown,
  fallbackPhase: FailurePhase,
): CanaryError {
  if (error instanceof CanaryError) return error;
  return new CanaryError('tooling', fallbackPhase, errorMessage(error), {
    cause: error,
  });
}
