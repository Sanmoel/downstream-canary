import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createReport, writeReports } from '../../src/report.js';
import type { CandidateArtifact } from '../../src/types.js';
import { temporaryDirectory } from '../helpers.js';

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('report target safety', () => {
  it('refuses to follow a pre-existing report-file symbolic link', async () => {
    const root = await temporaryDirectory();
    cleanups.push(root);
    const output = join(root, 'output');
    const outside = join(root, 'outside');
    await mkdir(output);
    await writeFile(outside, 'unchanged');
    await symlink(outside, join(output, 'downstream-canary-report.v1.json'));
    const artifact: CandidateArtifact = {
      tarballPath: join(root, 'candidate.tgz'),
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

    await expect(writeReports(createReport(artifact, 'image', []), output)).rejects.toThrow(
      /non-regular report target/,
    );
    expect(await readFile(outside, 'utf8')).toBe('unchanged');
  });
});
