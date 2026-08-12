import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyEdits, modify } from 'jsonc-parser';
import { CanaryError } from './errors.js';
import type { DependencyField } from './types.js';
import { readManifest, type PackageManifest } from './package-manager.js';

const DIRECT_FIELDS: readonly DependencyField[] = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
];

export interface DependencyPatchPlan {
  readonly packageName: string;
  readonly field: DependencyField;
  readonly oldSpecifier: string;
  readonly newSpecifier: string;
}

function dependencyValue(
  manifest: PackageManifest,
  field: DependencyField,
  packageName: string,
): string | undefined {
  const section = manifest[field];
  const value = section?.[packageName];
  return typeof value === 'string' ? value : undefined;
}

function validateSupportedSpecifier(specifier: string): void {
  if (specifier.startsWith('npm:')) {
    throw new CanaryError(
      'unsupported-project',
      'candidate-injection',
      'Package aliases are unsupported in v0.1.',
    );
  }
  if (specifier.startsWith('workspace:') || specifier.startsWith('link:')) {
    throw new CanaryError(
      'unsupported-project',
      'candidate-injection',
      'Workspace and linked dependencies are unsupported in v0.1.',
    );
  }
  if (specifier.startsWith('file:')) {
    const target = specifier.slice('file:'.length);
    if (
      !target.toLowerCase().endsWith('.tgz') ||
      target.startsWith('/') ||
      target.startsWith('~') ||
      target.includes('\\') ||
      target.split('/').includes('..')
    ) {
      throw new CanaryError(
        'unsupported-project',
        'candidate-injection',
        'Directory, absolute, and escaping file dependencies are unsupported; only safe relative file:.tgz baselines are accepted.',
      );
    }
    return;
  }
  if (
    specifier.length === 0 ||
    /^[a-z][a-z0-9+.-]*:/i.test(specifier) ||
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.includes('\\') ||
    specifier.includes('/')
  ) {
    throw new CanaryError(
      'unsupported-project',
      'candidate-injection',
      'Path, protocol, Git shorthand, and arbitrary URL dependency specifiers are unsupported in v0.1.',
    );
  }
}

export function planDependencyPatch(
  manifest: PackageManifest,
  packageName: string,
  newSpecifier: string,
): DependencyPatchPlan {
  if (manifest.name === packageName) {
    throw new CanaryError(
      'unsupported-project',
      'candidate-injection',
      'A consumer cannot be a self-reference to the candidate package.',
    );
  }
  const matches = DIRECT_FIELDS.flatMap((field) => {
    const value = dependencyValue(manifest, field, packageName);
    return value === undefined ? [] : [{ field, value }];
  });
  if (matches.length === 0) {
    const peer = manifest.peerDependencies?.[packageName];
    throw new CanaryError(
      'unsupported-project',
      'candidate-injection',
      peer
        ? 'Peer-only dependencies are unsupported in v0.1.'
        : 'The candidate is not a root direct dependency; transitive-only dependencies are unsupported.',
    );
  }
  if (matches.length > 1) {
    throw new CanaryError(
      'unsupported-project',
      'candidate-injection',
      `The candidate dependency appears in multiple manifest fields: ${matches.map(({ field }) => field).join(', ')}.`,
    );
  }
  const match = matches[0];
  if (!match) throw new Error('Dependency match invariant failed');
  validateSupportedSpecifier(match.value);
  return {
    packageName,
    field: match.field,
    oldSpecifier: match.value,
    newSpecifier,
  };
}

export async function applyDependencyPatch(
  projectDirectory: string,
  plan: DependencyPatchPlan,
): Promise<void> {
  const manifestPath = join(projectDirectory, 'package.json');
  const source = await readFile(manifestPath, 'utf8');
  const edits = modify(source, [plan.field, plan.packageName], plan.newSpecifier, {
    formattingOptions: {
      insertSpaces: !source.includes('\t'),
      tabSize: 2,
      eol: source.includes('\r\n') ? '\r\n' : '\n',
    },
  });
  if (edits.length === 0) {
    throw new CanaryError(
      'tooling',
      'candidate-injection',
      'Dependency patch produced no manifest edit.',
    );
  }
  await writeFile(manifestPath, applyEdits(source, edits), 'utf8');
  await verifyDependencyPatch(projectDirectory, plan);
}

export async function verifyDependencyPatch(
  projectDirectory: string,
  plan: DependencyPatchPlan,
): Promise<void> {
  const manifest = await readManifest(projectDirectory);
  if (manifest[plan.field]?.[plan.packageName] !== plan.newSpecifier) {
    throw new CanaryError(
      'tooling',
      'candidate-injection',
      'The planned direct dependency field was not patched exactly.',
    );
  }
  for (const field of DIRECT_FIELDS) {
    if (field !== plan.field && manifest[field]?.[plan.packageName] !== undefined) {
      throw new CanaryError(
        'tooling',
        'candidate-injection',
        'Candidate injection unexpectedly changed another dependency field.',
      );
    }
  }
}
