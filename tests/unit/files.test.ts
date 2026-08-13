import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  snapshotTree,
  validateLaneOutputs,
} from '../../src/util/files.js';
import { temporaryDirectory } from '../helpers.js';

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('post-test lane validation', () => {
  it('allows bounded regular generated output while preserving tracked files', async () => {
    const root = await temporaryDirectory();
    cleanups.push(root);
    await writeFile(join(root, 'package.json'), '{}\n');
    await writeFile(join(root, 'package-lock.json'), '{}\n');
    const original = await snapshotTree(root);
    await mkdir(join(root, 'coverage'));
    await writeFile(join(root, 'coverage', 'summary.json'), '{}\n');
    const after = await snapshotTree(root);
    await expect(
      validateLaneOutputs({
        root,
        originalTracked: original,
        after,
        protectedExpected: original,
        protectedPaths: new Set(['package.json', 'package-lock.json', '.npmrc']),
        phase: 'baseline-test',
        lane: 'Baseline',
      }),
    ).resolves.toEqual([{ path: 'coverage/summary.json', sizeBytes: 3 }]);
  });

  it('rejects tracked changes and newly added protected files separately', async () => {
    const root = await temporaryDirectory();
    cleanups.push(root);
    await writeFile(join(root, 'package.json'), '{}\n');
    const original = await snapshotTree(root);
    await writeFile(join(root, 'package.json'), '{"changed":true}\n');
    await writeFile(join(root, '.npmrc'), 'registry=https://example.invalid\n');
    const after = await snapshotTree(root);
    await expect(
      validateLaneOutputs({
        root,
        originalTracked: original,
        after,
        protectedExpected: original,
        protectedPaths: new Set(['package.json', '.npmrc']),
        phase: 'baseline-test',
        lane: 'Baseline',
      }),
    ).rejects.toThrow(/protected files/);
  });
});
