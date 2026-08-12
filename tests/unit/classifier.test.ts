import { describe, expect, it } from 'vitest';
import { classifyCompatibility, exitCodeForResults } from '../../src/classifier.js';

describe('compatibility classifier', () => {
  it.each([
    [true, true, 'compatible'],
    [true, false, 'candidate-regression'],
    [false, false, 'inconclusive-preexisting'],
    [false, true, 'candidate-improvement'],
  ] as const)('classifies baseline=%s candidate=%s as %s', (baseline, candidate, expected) => {
    expect(classifyCompatibility(baseline, candidate)).toBe(expected);
  });

  it('uses exit 2 for any tool error, then 1 for regressions, otherwise 0', () => {
    expect(exitCodeForResults([{ classification: 'compatible' }])).toBe(0);
    expect(exitCodeForResults([{ classification: 'candidate-regression' }])).toBe(1);
    expect(
      exitCodeForResults([
        { classification: 'candidate-regression' },
        { classification: 'tool-error' },
      ]),
    ).toBe(2);
  });
});
