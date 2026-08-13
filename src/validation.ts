import { isAbsolute, normalize, sep } from 'node:path';
import { CanaryError } from './errors.js';
import type {
  CommandArray,
  PackageManagerName,
  ProjectOverrides,
} from './types.js';

const FULL_SHA = /^[0-9a-f]{40}$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PACKAGE_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const GITHUB_COMPONENT = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/;

export function validateFullCommitSha(value: string): string {
  if (!FULL_SHA.test(value)) {
    throw new CanaryError(
      'configuration',
      'configuration',
      `Consumer commit must be an exact lowercase 40-character SHA, received ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

export function validatePublicGitHubUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new CanaryError(
      'configuration',
      'configuration',
      `Consumer repository must be a public HTTPS GitHub URL, received ${JSON.stringify(value)}.`,
      { cause: error },
    );
  }

  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new CanaryError(
      'configuration',
      'configuration',
      'Only anonymous https://github.com/OWNER/REPOSITORY URLs are supported in v0.1.',
    );
  }

  const components = url.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/');
  if (
    components.length !== 2 ||
    !components[0] ||
    !components[1] ||
    !GITHUB_COMPONENT.test(components[0]) ||
    !GITHUB_COMPONENT.test(components[1])
  ) {
    throw new CanaryError(
      'configuration',
      'configuration',
      'GitHub repositories must use exactly https://github.com/OWNER/REPOSITORY.',
    );
  }

  return `https://github.com/${components[0]}/${components[1]}`;
}

export function validateExactVersion(value: string, label: string): string {
  if (!EXACT_VERSION.test(value)) {
    throw new CanaryError(
      'configuration',
      'configuration',
      `${label} must be an exact version such as 11.17.0; ranges and tags are not accepted.`,
    );
  }
  return value;
}

export function validateRelativeWorkingDirectory(value: string): string {
  if (value.length === 0 || value.includes('\0') || isAbsolute(value)) {
    throw new CanaryError(
      'configuration',
      'configuration',
      `Working directory must be a non-empty safe relative path, received ${JSON.stringify(value)}.`,
    );
  }
  const normalized = normalize(value);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new CanaryError(
      'configuration',
      'configuration',
      'Working directory cannot escape the repository checkout.',
    );
  }
  return normalized;
}

export function validateSafePackageName(value: string): string {
  if (
    value.length === 0 ||
    value.length > 214 ||
    value.includes('\0') ||
    value.includes('\\') ||
    isAbsolute(value)
  ) {
    throw new CanaryError(
      'configuration',
      'configuration',
      `Candidate package name is not a safe npm package path: ${JSON.stringify(value)}.`,
    );
  }
  const components = value.startsWith('@')
    ? value.slice(1).split('/')
    : value.split('/');
  const safeComponent = /^[a-z0-9][a-z0-9._~-]*$/;
  if (
    components.length !== (value.startsWith('@') ? 2 : 1) ||
    components.some(
      (component) =>
        component === '' ||
        component === '.' ||
        component === '..' ||
        !safeComponent.test(component),
    )
  ) {
    throw new CanaryError(
      'configuration',
      'configuration',
      `Candidate package name is not a safe npm package path: ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

export function validatePackageVersion(value: string): string {
  if (!PACKAGE_VERSION.test(value)) {
    throw new CanaryError(
      'configuration',
      'configuration',
      `Candidate package version must be an exact semantic version, received ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

export function validateCommandArray(value: unknown, label: string): CommandArray {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (part) => typeof part !== 'string' || part.length === 0 || part.includes('\0'),
    )
  ) {
    throw new CanaryError(
      'configuration',
      'configuration',
      `${label} must be a non-empty array of non-empty arguments, not a shell command string.`,
    );
  }
  const command = value as string[];
  const executable = command[0]?.split(/[\\/]/).at(-1)?.toLowerCase();
  const shellStringFlag =
    executable !== undefined &&
    ((['sh', 'bash', 'dash', 'ksh', 'zsh'].includes(executable) &&
      command.includes('-c')) ||
      (['cmd', 'cmd.exe'].includes(executable) &&
        command.some((part) => part.toLowerCase() === '/c')) ||
      (['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(executable) &&
        command.some((part) =>
          ['-command', '-encodedcommand'].includes(part.toLowerCase()),
        )));
  if (shellStringFlag) {
    throw new CanaryError(
      'configuration',
      'configuration',
      `${label} cannot invoke a shell command-string mode; pass the executable and arguments directly.`,
    );
  }
  return value as unknown as CommandArray;
}

export function parsePackageManagerName(
  value: unknown,
  label: string,
): PackageManagerName {
  if (value !== 'npm' && value !== 'pnpm' && value !== 'yarn') {
    throw new CanaryError(
      'configuration',
      'configuration',
      `${label} must be one of npm, pnpm, or yarn.`,
    );
  }
  return value;
}

export function parseProjectOverrides(
  value: unknown,
  label: string,
): ProjectOverrides {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    throw new CanaryError(
      'configuration',
      'configuration',
      `${label} must be a mapping.`,
    );
  }

  const allowed = new Set([
    'packageManager',
    'packageManagerVersion',
    'lockfile',
    'testCommand',
    'buildCommand',
  ]);
  rejectUnknownKeys(value, allowed, label);

  const result: {
    packageManager?: PackageManagerName;
    packageManagerVersion?: string;
    lockfile?: string;
    testCommand?: CommandArray;
    buildCommand?: CommandArray;
  } = {};
  if (value.packageManager !== undefined) {
    result.packageManager = parsePackageManagerName(
      value.packageManager,
      `${label}.packageManager`,
    );
  }
  if (value.packageManagerVersion !== undefined) {
    if (typeof value.packageManagerVersion !== 'string') {
      throw new CanaryError(
        'configuration',
        'configuration',
        `${label}.packageManagerVersion must be a string.`,
      );
    }
    result.packageManagerVersion = validateExactVersion(
      value.packageManagerVersion,
      `${label}.packageManagerVersion`,
    );
  }
  if (value.lockfile !== undefined) {
    if (typeof value.lockfile !== 'string' || value.lockfile.includes('/')) {
      throw new CanaryError(
        'configuration',
        'configuration',
        `${label}.lockfile must be a root lockfile name.`,
      );
    }
    result.lockfile = value.lockfile;
  }
  for (const commandName of [
    'testCommand',
    'buildCommand',
  ] as const) {
    if (value[commandName] !== undefined) {
      result[commandName] = validateCommandArray(
        value[commandName],
        `${label}.${commandName}`,
      );
    }
  }
  return result;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

export function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new CanaryError(
      'configuration',
      'configuration',
      `${label} contains unsupported key(s): ${unknown.join(', ')}.`,
    );
  }
}
