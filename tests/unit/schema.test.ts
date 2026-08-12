import { readFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { createReport } from '../../src/report.js';
import type { CandidateArtifact, ConsumerResult } from '../../src/types.js';

async function schema(path: string): Promise<object> {
  return JSON.parse(await readFile(path, 'utf8')) as object;
}

describe('published JSON Schemas', () => {
  it('compile and accept representative configuration and report documents', async () => {
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      formats: { uri: true, 'date-time': true },
    });
    const validateConfig = ajv.compile(
      await schema('schemas/downstream-canary-config.schema.json'),
    );
    expect(
      validateConfig({
        version: 1,
        consumers: [
          'acme/tool@0123456789abcdef0123456789abcdef01234567',
        ],
      }),
      JSON.stringify(validateConfig.errors),
    ).toBe(true);

    const artifact: CandidateArtifact = {
      tarballPath: '/tmp/candidate.tgz',
      fileName: 'candidate.tgz',
      packageName: 'tiny-parser',
      packageVersion: '1.0.0',
      sha256: 'a'.repeat(64),
      packageJsonSha256: 'b'.repeat(64),
      contents: ['package/package.json'],
      packageFileHashes: { 'package.json': 'b'.repeat(64) },
      packageFileModes: { 'package.json': 0o644 },
      packageLinks: {},
    };
    const phase = {
      status: 'pass',
      installStatus: 'pass',
      testStatus: 'pass',
      durationMs: 1,
    } as const;
    const result: ConsumerResult = {
      repositoryUrl: 'https://github.com/acme/tool',
      commit: '0123456789abcdef0123456789abcdef01234567',
      packageManager: 'npm',
      declaredPackageManagerVersion: '11.17.0',
      actualPackageManagerVersion: '11.17.0',
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
      candidateTarballSha256: artifact.sha256,
      originalLockfileHash: 'c'.repeat(64),
      candidateLockfileHash: 'd'.repeat(64),
      dependencyFieldReplaced: 'dependencies',
      timeoutOrInfrastructureReason: null,
      diagnosticExcerpt: '',
    };
    const validateReport = ajv.compile(
      await schema('schemas/downstream-canary-report.schema.json'),
    );
    const report = createReport(artifact, 'pinned-image', [result], '2026-08-12T00:00:00.000Z');
    expect(validateReport(report), JSON.stringify(validateReport.errors)).toBe(true);
  });
});
