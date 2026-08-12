import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { validateCandidateTarball } from '../../src/tarball.js';
import { temporaryDirectory, writeTarball } from '../helpers.js';

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function validate(entries: Parameters<typeof writeTarball>[1]) {
  const directory = await temporaryDirectory();
  cleanups.push(directory);
  const path = await writeTarball(directory, entries);
  return await validateCandidateTarball(path, {
    expectedName: 'tiny-parser',
    expectedVersion: '1.0.0',
  });
}

describe('candidate tarball validation', () => {
  it('records identity, contents, and hashes for a valid npm package', async () => {
    const artifact = await validate([
      { path: 'package/package.json', body: '{"name":"tiny-parser","version":"1.0.0"}' },
      { path: 'package/index.js', body: 'export const parse = () => 1;\n' },
    ]);
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.contents).toEqual(['package/index.js', 'package/package.json']);
    expect(artifact.packageFileHashes['index.js']).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    [[{ path: '../escape', body: 'bad' }], /traversal|outside package/],
    [[{ path: '/absolute', body: 'bad' }], /absolute/],
    [
      [
        { path: 'package/package.json', body: '{"name":"tiny-parser","version":"1.0.0"}' },
        { path: 'package/link', type: '2', linkPath: '../../escape' },
      ],
      /escapes/,
    ],
  ] as const)('rejects unsafe archive paths or symlinks', async (entries, expected) => {
    await expect(validate(entries)).rejects.toThrow(expected);
  });

  it('requires package/package.json identity to match', async () => {
    await expect(
      validate([{ path: 'package/package.json', body: '{"name":"other","version":"1.0.0"}' }]),
    ).rejects.toThrow(/does not match/);
  });

  it('rejects duplicate archive entries', async () => {
    await expect(
      validate([
        { path: 'package/package.json', body: '{"name":"tiny-parser","version":"1.0.0"}' },
        { path: 'package/package.json', body: '{"name":"other","version":"1.0.0"}' },
      ]),
    ).rejects.toThrow(/duplicate entry/);
  });

  it('requires package/ itself to be a directory entry', async () => {
    await expect(
      validate([
        { path: 'package', body: 'not a directory' },
        { path: 'package/package.json', body: '{"name":"tiny-parser","version":"1.0.0"}' },
      ]),
    ).rejects.toThrow(/archive root must be a directory/);
  });
});
