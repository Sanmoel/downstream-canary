import { lstat, readdir, readlink } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { sha256File } from './hash.js';
import {
  MAX_GENERATED_BYTES_PER_LANE,
  MAX_GENERATED_FILES_PER_LANE,
} from '../constants.js';
import { CanaryError } from '../errors.js';
import type { FailurePhase, GeneratedPath } from '../types.js';

export type FileSnapshot = ReadonlyMap<string, string>;

function portablePath(path: string): string {
  return path.split(sep).join('/');
}

export async function snapshotTree(
  root: string,
  excludedTopLevel: ReadonlySet<string> = new Set([
    '.git',
    '.downstream-canary',
    'node_modules',
  ]),
): Promise<FileSnapshot> {
  const result = new Map<string, string>();

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const relativePath = portablePath(relative(root, absolute));
      const topLevel = relativePath.split('/')[0] ?? relativePath;
      if (excludedTopLevel.has(topLevel)) continue;

      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isSymbolicLink()) {
        result.set(relativePath, `symlink:${await readlink(absolute)}`);
      } else if (entry.isFile()) {
        const metadata = await lstat(absolute);
        result.set(relativePath, `file:${metadata.mode & 0o777}:${await sha256File(absolute)}`);
      } else {
        result.set(relativePath, `unsupported:${entry.name}`);
      }
    }
  }

  await visit(root);
  return result;
}

export interface SnapshotDifference {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export function diffSnapshots(
  before: FileSnapshot,
  after: FileSnapshot,
): SnapshotDifference {
  const added = [...after.keys()].filter((path) => !before.has(path)).sort();
  const removed = [...before.keys()].filter((path) => !after.has(path)).sort();
  const changed = [...before.keys()]
    .filter((path) => after.has(path) && before.get(path) !== after.get(path))
    .sort();
  return { added, removed, changed };
}

export interface LaneOutputValidation {
  readonly root: string;
  readonly originalTracked: FileSnapshot;
  readonly after: FileSnapshot;
  readonly protectedExpected: FileSnapshot;
  readonly protectedPaths: ReadonlySet<string>;
  readonly phase: Extract<FailurePhase, 'baseline-test' | 'candidate-test'>;
  readonly lane: 'Baseline' | 'Candidate';
}

export async function validateLaneOutputs(
  options: LaneOutputValidation,
): Promise<readonly GeneratedPath[]> {
  const trackedViolations: string[] = [];
  for (const [path, originalIdentity] of options.originalTracked) {
    if (options.protectedPaths.has(path)) continue;
    const actualIdentity = options.after.get(path);
    if (actualIdentity === undefined) trackedViolations.push(`removed:${path}`);
    else if (actualIdentity !== originalIdentity) {
      trackedViolations.push(`changed:${path}`);
    }
  }
  if (trackedViolations.length > 0) {
    throw new CanaryError(
      'unsupported-project',
      options.phase,
      `${options.lane} install or test modified tracked files: ${trackedViolations.join(', ')}.`,
    );
  }

  const protectedViolations: string[] = [];
  for (const path of options.protectedPaths) {
    const expected = options.protectedExpected.get(path);
    const actual = options.after.get(path);
    if (expected === undefined) {
      if (actual !== undefined) protectedViolations.push(`added:${path}`);
    } else if (actual === undefined) {
      protectedViolations.push(`removed:${path}`);
    } else if (actual !== expected) {
      protectedViolations.push(`changed:${path}`);
    }
  }
  if (protectedViolations.length > 0) {
    throw new CanaryError(
      'unsupported-project',
      options.phase,
      `${options.lane} install or test modified protected files: ${protectedViolations.join(', ')}.`,
    );
  }

  const generatedNames = [...options.after.keys()]
    .filter((path) => !options.originalTracked.has(path))
    .sort();
  if (generatedNames.length > MAX_GENERATED_FILES_PER_LANE) {
    throw new CanaryError(
      'unsupported-project',
      options.phase,
      `${options.lane} generated ${generatedNames.length} files, exceeding the ${MAX_GENERATED_FILES_PER_LANE}-file limit.`,
    );
  }

  const generated: GeneratedPath[] = [];
  let totalBytes = 0;
  for (const path of generatedNames) {
    if (options.protectedPaths.has(path)) continue;
    const metadata = await lstat(join(options.root, ...path.split('/')));
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new CanaryError(
        'unsupported-project',
        options.phase,
        `${options.lane} generated path ${path} is not an ordinary regular file.`,
      );
    }
    totalBytes += metadata.size;
    if (totalBytes > MAX_GENERATED_BYTES_PER_LANE) {
      throw new CanaryError(
        'unsupported-project',
        options.phase,
        `${options.lane} generated output exceeds the ${MAX_GENERATED_BYTES_PER_LANE}-byte limit.`,
      );
    }
    generated.push({ path, sizeBytes: metadata.size });
  }
  return generated;
}
