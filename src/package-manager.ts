import { lstat, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  DEFAULT_PACKAGE_MANAGER_VERSIONS,
  RECOGNIZED_LOCKFILES,
} from './constants.js';
import { CanaryError } from './errors.js';
import type {
  CommandArray,
  PackageManagerDetection,
  PackageManagerName,
  ProjectOverrides,
} from './types.js';
import { isPlainObject, validateExactVersion } from './validation.js';

async function metadataIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function regularFileExists(path: string, label: string): Promise<boolean> {
  const metadata = await metadataIfPresent(path);
  if (!metadata) return false;
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new CanaryError(
      'unsupported-project',
      'configuration',
      `${label} must be a regular file, not a directory or symbolic link.`,
    );
  }
  return true;
}

export interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly packageManager?: string;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly workspaces?: unknown;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly [key: string]: unknown;
}

export async function readManifest(projectDirectory: string): Promise<PackageManifest> {
  const manifestPath = join(projectDirectory, 'package.json');
  if (!(await regularFileExists(manifestPath, manifestPath))) {
    throw new CanaryError(
      'unsupported-project',
      'configuration',
      `A root package.json is required at ${manifestPath}.`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    throw new CanaryError(
      'unsupported-project',
      'configuration',
      `A valid root package.json is required at ${manifestPath}.`,
      { cause: error },
    );
  }
  if (!isPlainObject(value)) {
    throw new CanaryError(
      'unsupported-project',
      'configuration',
      `${manifestPath} must contain a JSON object.`,
    );
  }
  return value;
}

function isPublicNpmRegistry(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'registry.npmjs.org' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      (url.pathname === '' || url.pathname === '/') &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

async function validateLockfileSources(
  projectDirectory: string,
  lockfile: string,
): Promise<void> {
  const contents = await readFile(join(projectDirectory, lockfile), 'utf8');
  const sources = contents.match(
    /(?:git\+https?|git\+ssh|https?|ssh):\/\/[^\s"'`<>{}[\]]+|git@[A-Za-z0-9.-]+:[^\s"'`]+|github:[^\s"'`]+/gi,
  ) ?? [];
  for (const source of sources) {
    if (!source.toLowerCase().startsWith('https://')) {
      throw new CanaryError(
        'unsupported-project',
        'configuration',
        `Lockfile source ${JSON.stringify(source)} is not an anonymous public npm-registry URL.`,
      );
    }
    let url: URL;
    try {
      url = new URL(source);
    } catch (error) {
      throw new CanaryError(
        'unsupported-project',
        'configuration',
        `Lockfile contains a malformed package source URL: ${JSON.stringify(source)}.`,
        { cause: error },
      );
    }
    if (
      url.hostname !== 'registry.npmjs.org' ||
      url.port !== '' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      throw new CanaryError(
        'unsupported-project',
        'configuration',
        `Lockfile source ${JSON.stringify(source)} is outside the public npm registry contract.`,
      );
    }
  }
}

function validateYarnRegistryConfiguration(value: unknown, path = '.yarnrc.yml'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      validateYarnRegistryConfiguration(item, `${path}[${index}]`),
    );
    return;
  }
  if (!isPlainObject(value)) return;

  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${path}.${key}`;
    if (/^npmAuth(?:Token|Ident)$/i.test(key)) {
      throw new CanaryError(
        'unsupported-project',
        'configuration',
        `Credential-bearing Yarn setting ${itemPath} is unsupported and is never forwarded.`,
      );
    }
    if (key === 'npmRegistries') {
      throw new CanaryError(
        'unsupported-project',
        'configuration',
        'Per-registry Yarn configuration is unsupported in v0.1.',
      );
    }
    if (key === 'npmRegistryServer' && !isPublicNpmRegistry(item)) {
      throw new CanaryError(
        'unsupported-project',
        'configuration',
        'Private or alternate Yarn registries are unsupported in v0.1.',
      );
    }
    if (key === 'httpProxy' || key === 'httpsProxy') {
      throw new CanaryError(
        'unsupported-project',
        'configuration',
        'Project-defined Yarn proxy configuration is unsupported in v0.1.',
      );
    }
    if (
      (key === 'enableStrictSsl' && item === false) ||
      (key === 'checksumBehavior' && item !== 'throw')
    ) {
      throw new CanaryError(
        'unsupported-project',
        'configuration',
        `Yarn setting ${itemPath} bypasses required registry or checksum validation.`,
      );
    }
    if (
      key === 'cacheFolder' ||
      key === 'globalFolder' ||
      key === 'installStatePath' ||
      (key === 'enableGlobalCache' && item !== true) ||
      (key === 'enableImmutableCache' && item === true)
    ) {
      throw new CanaryError(
        'unsupported-project',
        'configuration',
        'Yarn Zero-Install, local-cache, and custom state paths are unsupported in v0.1.',
      );
    }
    validateYarnRegistryConfiguration(item, itemPath);
  }
}

function parsePackageManagerDeclaration(
  declaration: string,
): { readonly name: PackageManagerName; readonly version: string } {
  if (/^(?:npm|pnpm|yarn)@[^\s]+\+sha(?:224|256|384|512)\./.test(declaration)) {
    throw new CanaryError(
      'unsupported-project',
      'configuration',
      'packageManager integrity suffixes are rejected in v0.1 because their bytes are not yet independently verified.',
    );
  }
  const match = /^(npm|pnpm|yarn)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(
    declaration,
  );
  if (!match?.[1] || !match[2]) {
    throw new CanaryError(
      'configuration',
      'configuration',
      `packageManager must declare an exact npm, pnpm, or yarn version; received ${JSON.stringify(declaration)}.`,
    );
  }
  return { name: match[1] as PackageManagerName, version: match[2] };
}

function managerCommands(
  name: PackageManagerName,
  version: string,
): {
  readonly install: CommandArray;
  readonly lockfile: CommandArray;
  readonly test: CommandArray;
} {
  const executable = `${name}@${version}`;
  switch (name) {
    case 'npm':
      return {
        install: ['corepack', executable, 'ci', '--no-audit', '--no-fund'],
        lockfile: [
          'corepack',
          executable,
          'install',
          '--package-lock-only',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
        ],
        test: ['corepack', executable, 'test'],
      };
    case 'pnpm':
      return {
        install: ['corepack', executable, 'install', '--frozen-lockfile'],
        lockfile: [
          'corepack',
          executable,
          'install',
          '--lockfile-only',
          '--ignore-scripts',
        ],
        test: ['corepack', executable, 'test'],
      };
    case 'yarn':
      return {
        install: ['corepack', executable, 'install', '--immutable'],
        lockfile: [
          'corepack',
          executable,
          'install',
          '--mode=update-lockfile',
        ],
        test: ['corepack', executable, 'test'],
      };
  }
}

async function validateProjectConfiguration(
  projectDirectory: string,
  manager: PackageManagerName,
): Promise<void> {
  if (await metadataIfPresent(join(projectDirectory, '.corepack.env'))) {
    throw new CanaryError(
      'unsupported-project',
      'configuration',
      'Project .corepack.env files are unsupported; Downstream Canary sets COREPACK_ENV_FILE=0 and fails closed.',
    );
  }
  const npmrcPath = join(projectDirectory, '.npmrc');
  if (await regularFileExists(npmrcPath, 'Project .npmrc')) {
    const npmrc = await readFile(npmrcPath, 'utf8');
    for (const line of npmrc.split(/\r?\n/)) {
      const match = /^\s*([^#;][^=]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match?.[1]) continue;
      const key = match[1].trim();
      const setting = match[2] ?? '';
      if (/(?:auth|token|password|credential|username|certfile|keyfile)/i.test(key)) {
        throw new CanaryError(
          'unsupported-project',
          'configuration',
          'Credential-bearing project .npmrc files are unsupported and are never forwarded.',
        );
      }
      if (/(?:^|:)registry$/i.test(key) && !isPublicNpmRegistry(setting)) {
        throw new CanaryError(
          'unsupported-project',
          'configuration',
          'Private or alternate package registries are unsupported in v0.1.',
        );
      }
      if (/^(?:https?-)?proxy$/i.test(key)) {
        throw new CanaryError(
          'unsupported-project',
          'configuration',
          'Project-defined package-manager proxy configuration is unsupported in v0.1.',
        );
      }
      const normalizedKey = key.toLowerCase();
      const normalizedSetting = setting.toLowerCase();
      if (
        ['lockfile', 'package-lock', 'strict-ssl', 'verify-store-integrity'].includes(
          normalizedKey,
        ) &&
        normalizedSetting === 'false'
      ) {
        throw new CanaryError(
          'unsupported-project',
          'configuration',
          `Project package-manager setting ${key}=false bypasses required validation.`,
        );
      }
      if (
        ['legacy-peer-deps', 'force'].includes(normalizedKey) &&
        normalizedSetting === 'true'
      ) {
        throw new CanaryError(
          'unsupported-project',
          'configuration',
          `Project package-manager setting ${key}=true bypasses required validation.`,
        );
      }
    }
  }

  for (const workspaceFile of ['pnpm-workspace.yaml', 'pnpm-workspace.yml']) {
    if (await metadataIfPresent(join(projectDirectory, workspaceFile))) {
      throw new CanaryError(
        'unsupported-project',
        'configuration',
        `${workspaceFile} indicates a workspace, which is unsupported in v0.1.`,
      );
    }
  }

  if (manager === 'yarn') {
    for (const unsupportedPath of ['.yarn/cache', '.pnp.cjs', '.pnp.loader.mjs']) {
      if (await metadataIfPresent(join(projectDirectory, unsupportedPath))) {
        throw new CanaryError(
          'unsupported-project',
          'configuration',
          `Yarn project path ${unsupportedPath} is unsupported by the v0.1 node-modules adapter.`,
        );
      }
    }
    const yarnrcPath = join(projectDirectory, '.yarnrc.yml');
    if (!(await regularFileExists(yarnrcPath, 'Project .yarnrc.yml'))) {
      throw new CanaryError(
        'unsupported-project',
        'configuration',
        'Yarn v0.1 support requires .yarnrc.yml with nodeLinker: node-modules.',
      );
    }
    const yarnrc = parseYaml(await readFile(yarnrcPath, 'utf8'), {
      maxAliasCount: 0,
    }) as unknown;
    if (!isPlainObject(yarnrc) || yarnrc.nodeLinker !== 'node-modules') {
      throw new CanaryError(
        'unsupported-project',
        'configuration',
        'Only modern Yarn with nodeLinker: node-modules is supported in v0.1.',
      );
    }
    if (yarnrc.yarnPath !== undefined || yarnrc.plugins !== undefined) {
      throw new CanaryError(
        'unsupported-project',
        'configuration',
        'Custom Yarn binaries and plugins are unsupported in v0.1.',
      );
    }
    validateYarnRegistryConfiguration(yarnrc);
  }
}

export async function detectPackageManager(
  projectDirectory: string,
  workingDirectory: string,
  overrides: ProjectOverrides = {},
  requireTest = true,
): Promise<PackageManagerDetection> {
  const manifest = await readManifest(projectDirectory);
  if (manifest.workspaces !== undefined) {
    throw new CanaryError(
      'unsupported-project',
      'configuration',
      'Monorepos and package.json workspaces are unsupported in v0.1.',
    );
  }

  const presentLockfiles: { name: PackageManagerName; file: string }[] = [];
  for (const [name, file] of Object.entries(RECOGNIZED_LOCKFILES) as [
    PackageManagerName,
    string,
  ][]) {
    if (await regularFileExists(join(projectDirectory, file), file)) {
      presentLockfiles.push({ name, file });
    }
  }
  if (presentLockfiles.length !== 1) {
    throw new CanaryError(
      'configuration',
      'configuration',
      presentLockfiles.length === 0
        ? 'Exactly one recognized lockfile is required (package-lock.json, pnpm-lock.yaml, or yarn.lock).'
        : `Multiple package-manager lockfiles are ambiguous: ${presentLockfiles.map(({ file }) => file).join(', ')}.`,
    );
  }

  const declared = manifest.packageManager
    ? parsePackageManagerDeclaration(manifest.packageManager)
    : undefined;
  const lock = presentLockfiles[0];
  if (!lock) throw new Error('Lockfile invariant failed');
  if (declared && declared.name !== lock.name) {
    throw new CanaryError(
      'configuration',
      'configuration',
      `packageManager declares ${declared.name}, but ${lock.file} selects ${lock.name}.`,
    );
  }

  const name = overrides.packageManager ?? declared?.name ?? lock.name;
  if (name !== lock.name) {
    throw new CanaryError(
      'configuration',
      'configuration',
      `Explicit package manager ${name} conflicts with detected lockfile ${lock.file}.`,
    );
  }
  if (overrides.lockfile && basename(overrides.lockfile) !== lock.file) {
    throw new CanaryError(
      'configuration',
      'configuration',
      `Explicit lockfile ${overrides.lockfile} conflicts with detected ${lock.file}.`,
    );
  }
  await validateLockfileSources(projectDirectory, lock.file);

  const requestedVersion = validateExactVersion(
    overrides.packageManagerVersion ??
      declared?.version ??
      DEFAULT_PACKAGE_MANAGER_VERSIONS[name],
    `${name} version`,
  );
  const defaults = managerCommands(name, requestedVersion);
  if (requireTest && !overrides.testCommand && typeof manifest.scripts?.test !== 'string') {
    throw new CanaryError(
      'unsupported-project',
      'configuration',
      'No root test script was detected. Configure testCommand as an argument array.',
    );
  }
  await validateProjectConfiguration(projectDirectory, name);

  return {
    name,
    declaredVersion: declared?.version ?? null,
    requestedVersion,
    actualVersion: null,
    lockfile: lock.file,
    workingDirectory,
    immutableInstallCommand: defaults.install,
    lockfileCommand: defaults.lockfile,
    testCommand: overrides.testCommand ?? defaults.test,
  };
}

export function managerVersionCommand(
  manager: Pick<PackageManagerDetection, 'name' | 'requestedVersion'>,
): CommandArray {
  return ['corepack', `${manager.name}@${manager.requestedVersion}`, '--version'];
}

export function managerRunCommand(
  manager: Pick<PackageManagerDetection, 'name' | 'requestedVersion'>,
  script: string,
): CommandArray {
  return ['corepack', `${manager.name}@${manager.requestedVersion}`, 'run', script];
}

export function managerEnvironment(
  manager: Pick<PackageManagerDetection, 'name'>,
): Readonly<Record<string, string>> | undefined {
  return manager.name === 'yarn'
    ? {
        YARN_INSTALL_STATE_PATH: '/tmp/downstream-canary-yarn-install-state.gz',
        YARN_NPM_REGISTRY_SERVER: 'https://registry.npmjs.org',
      }
    : undefined;
}

export function managerLockfileEnvironment(
  manager: Pick<PackageManagerDetection, 'name'>,
): Readonly<Record<string, string>> {
  return {
    ...managerEnvironment(manager),
    npm_config_ignore_scripts: 'true',
    YARN_ENABLE_SCRIPTS: 'false',
  };
}
