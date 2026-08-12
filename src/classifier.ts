import type {
  CompatibilityClassification,
  ConsumerResult,
} from './types.js';

export function classifyCompatibility(
  baselinePassed: boolean,
  candidatePassed: boolean,
): CompatibilityClassification {
  if (baselinePassed) {
    return candidatePassed ? 'compatible' : 'candidate-regression';
  }
  return candidatePassed
    ? 'candidate-improvement'
    : 'inconclusive-preexisting';
}

export function exitCodeForResults(
  results: readonly Pick<ConsumerResult, 'classification'>[],
): 0 | 1 | 2 {
  if (results.some(({ classification }) => classification === 'tool-error')) return 2;
  if (
    results.some(
      ({ classification }) => classification === 'candidate-regression',
    )
  ) {
    return 1;
  }
  return 0;
}
