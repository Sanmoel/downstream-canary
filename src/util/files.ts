import { lstat, readdir, readlink } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { sha256File } from './hash.js';

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
