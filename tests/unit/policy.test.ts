import { describe, expect, it } from 'vitest';
import { policySha256, resolvePolicy } from '../../src/policy.js';
import type { ConsumerResult } from '../../src/types.js';

function result(command: readonly [string, ...string[]]): ConsumerResult {
  const phase = {
    status: 'pass',
    installStatus: 'pass',
    testStatus: 'pass',
    durationMs: 1,
  } as const;
  return {
    repositoryUrl: 'https://github.com/acme/tool',
    commit: '0123456789abcdef0123456789abcdef01234567',
    packageManager: 'npm',
    declaredPackageManagerVersion: '11.17.0',
    actualPackageManagerVersion: '11.17.0',
    requestedPackageManagerVersion: '11.17.0',
    nodeVersion: 'v24.19.0',
    operatingSystem: 'linux',
    architecture: 'x64',
    baseline: phase,
    candidate: phase,
    classification: 'compatible',
    failurePhase: null,
    durationMs: 2,
    candidatePackageName: 'tiny-parser',
    candidatePackageVersion: '1.0.0',
    candidateTarballSha256: 'a'.repeat(64),
    originalLockfileHash: 'b'.repeat(64),
    candidateLockfileHash: 'c'.repeat(64),
    dependencyFieldReplaced: 'dependencies',
    timeoutOrInfrastructureReason: null,
    diagnosticExcerpt: '',
    executedTestCommand: command,
    candidateInstallFailureAttribution: null,
    packageManagerProvisionSha256: 'd'.repeat(64),
    generatedPaths: { baseline: [], candidate: [] },
  };
}

describe('resolved policy identity', () => {
  it('hashes exact executed test arguments canonically', () => {
    const first = resolvePolicy([result(['node', 'test.cjs'])]);
    const same = resolvePolicy([result(['node', 'test.cjs'])]);
    const changed = resolvePolicy([result(['node', 'noop.cjs'])]);
    expect(policySha256(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(policySha256(first)).toBe(policySha256(same));
    expect(policySha256(first)).not.toBe(policySha256(changed));
  });
});
