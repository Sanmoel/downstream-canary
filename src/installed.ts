import { lstat, readlink, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { CanaryError } from './errors.js';
import type { CandidateArtifact } from './types.js';
import { sha256File } from './util/hash.js';

function packagePath(projectDirectory: string, packageName: string): string {
  return join(projectDirectory, 'node_modules', ...packageName.split('/'));
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..');
}

export async function verifyInstalledCandidate(
  projectDirectory: string,
  artifact: CandidateArtifact,
): Promise<void> {
  const logicalRoot = packagePath(projectDirectory, artifact.packageName);
  let installedRoot: string;
  let realProjectRoot: string;
  try {
    realProjectRoot = await realpath(projectDirectory);
    installedRoot = await realpath(logicalRoot);
  } catch (error) {
    throw new CanaryError(
      'tooling',
      'candidate-verification',
      `Installed candidate package was not found at ${logicalRoot}.`,
      { cause: error },
    );
  }
  if (!isWithin(realProjectRoot, installedRoot)) {
    throw new CanaryError(
      'tooling',
      'candidate-verification',
      'Installed candidate resolves outside the isolated consumer workspace.',
    );
  }

  for (const [path, expectedHash] of Object.entries(artifact.packageFileHashes)) {
    const installedPath = join(installedRoot, ...path.split('/'));
    const resolvedInstalledPath = await realpath(installedPath).catch((error: unknown) => {
      throw new CanaryError(
        'tooling',
        'candidate-verification',
        `Installed candidate is missing tarball file ${path}.`,
        { cause: error },
      );
    });
    if (!isWithin(installedRoot, resolvedInstalledPath)) {
      throw new CanaryError(
        'tooling',
        'candidate-verification',
        `Installed candidate file ${path} resolves outside its package root.`,
      );
    }
    const metadata = await lstat(installedPath).catch((error: unknown) => {
      throw new CanaryError(
        'tooling',
        'candidate-verification',
        `Installed candidate is missing tarball file ${path}.`,
        { cause: error },
      );
    });
    if (!metadata.isFile()) {
      throw new CanaryError(
        'tooling',
        'candidate-verification',
        `Installed candidate entry ${path} is not a regular file.`,
      );
    }
    const expectedMode = artifact.packageFileModes[path];
    if (expectedMode === undefined || (metadata.mode & 0o777) !== expectedMode) {
      throw new CanaryError(
        'tooling',
        'candidate-verification',
        `Installed candidate file mode for ${path} does not match the verified tarball.`,
      );
    }
    const actualHash = await sha256File(installedPath);
    if (actualHash !== expectedHash) {
      throw new CanaryError(
        'tooling',
        'candidate-verification',
        `Installed candidate file ${path} does not match the verified tarball.`,
      );
    }
  }
  for (const [path, expectedTarget] of Object.entries(artifact.packageLinks)) {
    const installedPath = join(installedRoot, ...path.split('/'));
    const installedParent = await realpath(dirname(installedPath)).catch(
      (error: unknown) => {
        throw new CanaryError(
          'tooling',
          'candidate-verification',
          `Installed candidate link parent is missing for ${path}.`,
          { cause: error },
        );
      },
    );
    if (!isWithin(installedRoot, installedParent)) {
      throw new CanaryError(
        'tooling',
        'candidate-verification',
        `Installed candidate link ${path} has a parent outside its package root.`,
      );
    }
    const metadata = await lstat(installedPath);
    if (!metadata.isSymbolicLink() || (await readlink(installedPath)) !== expectedTarget) {
      throw new CanaryError(
        'tooling',
        'candidate-verification',
        `Installed candidate link ${path} does not match the verified tarball.`,
      );
    }
    const resolvedTarget = resolve(dirname(installedPath), expectedTarget);
    if (!isWithin(installedRoot, resolvedTarget)) {
      throw new CanaryError(
        'tooling',
        'candidate-verification',
        `Installed candidate link ${path} escapes its package root.`,
      );
    }
  }
}
