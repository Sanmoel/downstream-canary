import { describe, expect, it } from 'vitest';
import {
  attributeCandidateInstallFailure,
  candidateLockfileFailureDisposition,
} from '../../src/failure-attribution.js';
import { exitCodeForResults } from '../../src/classifier.js';

function outcome(output: string, exitCode = 1, timedOut = false) {
  return { output, exitCode, timedOut };
}

describe('candidate lockfile failure disposition', () => {
  it.each([
    ['registry', 'npm error E404 registry.npmjs.org unavailable'],
    ['tooling', 'internal package manager exception'],
    ['invalid manager', 'corepack: invalid package manager request'],
  ])('keeps %s lockfile failures as tool errors in candidate-lockfile', (_kind, output) => {
    const disposition = candidateLockfileFailureDisposition(outcome(output));
    expect(disposition.classification).toBe('tool-error');
    expect(disposition.failurePhase).toBe('candidate-lockfile');
    expect(exitCodeForResults([disposition])).toBe(2);
    expect(disposition.reason).toContain('lockfile generation failed');
  });

  it('never lets lifecycle wording override network evidence', () => {
    expect(
      attributeCandidateInstallFailure(
        'npm',
        outcome('npm error command failed\nnpm error code ENOTFOUND'),
        outcome('', 0),
      ),
    ).toMatchObject({
      classification: 'tool-error',
      attribution: 'network',
    });
  });
});

describe('candidate install attribution', () => {
  it('attributes a reproducible lifecycle-only failure as a regression', () => {
    expect(
      attributeCandidateInstallFailure(
        'npm',
        outcome('npm error command failed\nnpm error command sh -c node preinstall.js'),
        outcome('', 0),
      ),
    ).toMatchObject({
      classification: 'candidate-regression',
      attribution: 'lifecycle-incompatibility',
    });
  });

  it('attributes manager resolution evidence with scripts disabled as a regression', () => {
    expect(
      attributeCandidateInstallFailure(
        'npm',
        outcome('npm error ERESOLVE'),
        outcome('npm error code ERESOLVE\nunable to resolve dependency tree'),
      ),
    ).toMatchObject({
      classification: 'candidate-regression',
      attribution: 'dependency-resolution',
    });
  });

  it.each([
    ['registry', 'npm error E404 registry.npmjs.org'],
    ['network', 'npm error code ENOTFOUND'],
    ['corepack', 'Corepack failed to download package manager'],
    ['unknown', 'unexpected manager failure'],
  ] as const)('keeps %s failures as tool errors', (attribution, output) => {
    expect(
      attributeCandidateInstallFailure('npm', outcome(output), outcome(output)),
    ).toMatchObject({ classification: 'tool-error', attribution });
  });
});
