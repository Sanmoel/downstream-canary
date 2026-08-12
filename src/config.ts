import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_TIMEOUT_SECONDS,
  MAX_CONSUMERS,
  MAX_TIMEOUT_SECONDS,
  MIN_TIMEOUT_SECONDS,
  RUNNER_IMAGE,
} from './constants.js';
import { CanaryError } from './errors.js';
import type {
  CandidateConfig,
  CommandArray,
  ConsumerSpec,
  PackageManagerName,
  ProjectOverrides,
  RunConfig,
} from './types.js';
import {
  isPlainObject,
  parseProjectOverrides,
  rejectUnknownKeys,
  validateCommandArray,
  validateFullCommitSha,
  validatePublicGitHubUrl,
  validateRelativeWorkingDirectory,
} from './validation.js';

interface RawConfig {
  readonly candidate: CandidateConfig;
  readonly consumers: readonly ConsumerSpec[];
  readonly defaults: ProjectOverrides;
  readonly outputDirectory?: string;
  readonly timeoutSeconds?: number;
}

export interface ResolveConfigOptions {
  readonly cwd: string;
  readonly configPath?: string;
  readonly candidateRoot?: string;
  readonly outputDirectory?: string;
  readonly timeoutSeconds?: number;
  readonly consumersText?: string;
  readonly candidateOverrides?: ProjectOverrides;
  readonly consumerOverrides?: ProjectOverrides;
  readonly dockerExecutable?: string;
  readonly dockerImage?: string;
}

async function regularFileExists(path: string, label: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new CanaryError(
        'configuration',
        'configuration',
        `${label} must be a regular file, not a directory or symbolic link.`,
      );
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function assertSafeDirectoryPath(
  root: string,
  relativePath: string,
  label: string,
): Promise<void> {
  if (relativePath === '.') return;
  let current = resolve(root);
  for (const component of relativePath.split(sep)) {
    current = join(current, component);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new CanaryError(
        'configuration',
        'configuration',
        `${label} cannot contain symbolic-link path components.`,
      );
    }
    if (!metadata.isDirectory()) {
      throw new CanaryError(
        'configuration',
        'configuration',
        `${label} must resolve to a directory path.`,
      );
    }
  }
}

function parseConsumerReference(reference: string): ConsumerSpec {
  const splitAt = reference.lastIndexOf('@');
  if (splitAt <= 0) {
    throw new CanaryError(
      'configuration',
      'configuration',
      `Consumer ${JSON.stringify(reference)} must use OWNER/REPOSITORY@FULL_SHA.`,
    );
  }
  const repository = reference.slice(0, splitAt).trim();
  const commit = validateFullCommitSha(reference.slice(splitAt + 1).trim());
  const repositoryUrl = repository.startsWith('https://')
    ? validatePublicGitHubUrl(repository)
    : validatePublicGitHubUrl(`https://github.com/${repository}`);
  return { repositoryUrl, commit, workingDirectory: '.' };
}

export function parseConsumersInput(input: string): readonly ConsumerSpec[] {
  const references = input
    .split(/\r?\n|,/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  return references.map(parseConsumerReference);
}

function mergeOverrides<T extends ProjectOverrides>(
  base: T,
  ...overrides: readonly (ProjectOverrides | undefined)[]
): T & ProjectOverrides {
  return overrides.reduce<T & ProjectOverrides>(
    (current, override) => ({ ...current, ...override }),
    { ...base },
  );
}

function parseConsumerObject(
  value: unknown,
  defaults: ProjectOverrides,
  index: number,
): ConsumerSpec {
  if (typeof value === 'string') {
    return mergeOverrides(parseConsumerReference(value), defaults);
  }
  if (!isPlainObject(value)) {
    throw new CanaryError(
      'configuration',
      'configuration',
      `consumers[${index}] must be a pinned reference or mapping.`,
    );
  }
  const allowed = new Set([
    'repository',
    'commit',
    'workingDirectory',
    'packageManager',
    'packageManagerVersion',
    'lockfile',
    'installCommand',
    'lockfileCommand',
    'testCommand',
  ]);
  rejectUnknownKeys(value, allowed, `consumers[${index}]`);
  if (typeof value.repository !== 'string' || typeof value.commit !== 'string') {
    throw new CanaryError(
      'configuration',
      'configuration',
      `consumers[${index}] requires repository and commit strings.`,
    );
  }
  const repositoryUrl = value.repository.startsWith('https://')
    ? validatePublicGitHubUrl(value.repository)
    : validatePublicGitHubUrl(`https://github.com/${value.repository}`);
  const projectValues = { ...value };
  delete projectValues.repository;
  delete projectValues.commit;
  delete projectValues.workingDirectory;
  const overrides = parseProjectOverrides(projectValues, `consumers[${index}]`);
  if (value.workingDirectory !== undefined && typeof value.workingDirectory !== 'string') {
    throw new CanaryError(
      'configuration',
      'configuration',
      `consumers[${index}].workingDirectory must be a string.`,
    );
  }
  const workingDirectory =
    typeof value.workingDirectory === 'string'
      ? validateRelativeWorkingDirectory(value.workingDirectory)
      : '.';
  if (workingDirectory !== '.') {
    throw new CanaryError(
      'unsupported-project',
      'configuration',
      'Nested consumer package roots are unsupported in v0.1.',
    );
  }
  const base: ConsumerSpec = {
    repositoryUrl,
    commit: validateFullCommitSha(value.commit),
    workingDirectory,
  };
  return mergeOverrides<ConsumerSpec>(
    base,
    defaults,
    overrides,
  );
}

function parseRawConfig(value: unknown, candidateRoot: string): RawConfig {
  if (!isPlainObject(value)) {
    throw new CanaryError(
      'configuration',
      'configuration',
      '.downstream-canary.yml must contain a mapping.',
    );
  }
  rejectUnknownKeys(
    value,
    new Set(['version', 'candidate', 'defaults', 'consumers', 'outputDirectory', 'timeoutSeconds']),
    'configuration',
  );
  if (value.version !== CONFIG_SCHEMA_VERSION) {
    throw new CanaryError(
      'configuration',
      'configuration',
      `Configuration version must be ${CONFIG_SCHEMA_VERSION}.`,
    );
  }

  const defaults = parseProjectOverrides(value.defaults, 'defaults');
  if (defaults.buildCommand) {
    throw new CanaryError(
      'configuration',
      'configuration',
      'defaults.buildCommand is unsupported because consumer builds are not a separate lane phase.',
    );
  }
  const candidateValue = value.candidate;
  if (candidateValue !== undefined && !isPlainObject(candidateValue)) {
    throw new CanaryError('configuration', 'configuration', 'candidate must be a mapping.');
  }
  const candidateRecord = candidateValue ?? {};
  rejectUnknownKeys(
    candidateRecord,
    new Set([
      'workingDirectory',
      'packageManager',
      'packageManagerVersion',
      'lockfile',
      'installCommand',
      'buildCommand',
    ]),
    'candidate',
  );
  const candidateWorkingDirectory = candidateRecord.workingDirectory;
  if (
    candidateWorkingDirectory !== undefined &&
    typeof candidateWorkingDirectory !== 'string'
  ) {
    throw new CanaryError(
      'configuration',
      'configuration',
      'candidate.workingDirectory must be a string.',
    );
  }
  const normalizedCandidateWorkingDirectory =
    typeof candidateWorkingDirectory === 'string'
      ? validateRelativeWorkingDirectory(candidateWorkingDirectory)
      : '.';
  if (normalizedCandidateWorkingDirectory !== '.') {
    throw new CanaryError(
      'unsupported-project',
      'configuration',
      'Nested candidate package roots are unsupported; point candidate-root at the package root instead.',
    );
  }
  const candidateProjectValues = { ...candidateRecord };
  delete candidateProjectValues.workingDirectory;
  const candidate: CandidateConfig = {
    root: candidateRoot,
    workingDirectory: normalizedCandidateWorkingDirectory,
    ...parseProjectOverrides(candidateProjectValues, 'candidate'),
  };

  if (value.consumers !== undefined && !Array.isArray(value.consumers)) {
    throw new CanaryError('configuration', 'configuration', 'consumers must be a list.');
  }
  const consumers = (value.consumers ?? []).map((consumer, index) =>
    parseConsumerObject(consumer, defaults, index),
  );

  if (
    value.outputDirectory !== undefined &&
    (typeof value.outputDirectory !== 'string' || value.outputDirectory.length === 0)
  ) {
    throw new CanaryError(
      'configuration',
      'configuration',
      'outputDirectory must be a non-empty path string.',
    );
  }
  if (
    value.timeoutSeconds !== undefined &&
    (!Number.isInteger(value.timeoutSeconds) ||
      (value.timeoutSeconds as number) < MIN_TIMEOUT_SECONDS ||
      (value.timeoutSeconds as number) > MAX_TIMEOUT_SECONDS)
  ) {
    throw new CanaryError(
      'configuration',
      'configuration',
      `timeoutSeconds must be an integer from ${MIN_TIMEOUT_SECONDS} to ${MAX_TIMEOUT_SECONDS}.`,
    );
  }
  return {
    candidate,
    consumers,
    defaults,
    ...(typeof value.outputDirectory === 'string'
      ? { outputDirectory: value.outputDirectory }
      : {}),
    ...(typeof value.timeoutSeconds === 'number'
      ? { timeoutSeconds: value.timeoutSeconds }
      : {}),
  };
}

function validateConsumerCount(consumers: readonly ConsumerSpec[]): void {
  if (consumers.length < 1 || consumers.length > MAX_CONSUMERS) {
    throw new CanaryError(
      'configuration',
      'configuration',
      `Configure between 1 and ${MAX_CONSUMERS} pinned consumers; received ${consumers.length}.`,
    );
  }
  const identities = new Set<string>();
  for (const consumer of consumers) {
    const identity = `${consumer.repositoryUrl}@${consumer.commit}`;
    if (identities.has(identity)) {
      throw new CanaryError(
        'configuration',
        'configuration',
        `Duplicate consumer ${identity}.`,
      );
    }
    identities.add(identity);
  }
}

export async function resolveRunConfig(
  options: ResolveConfigOptions,
): Promise<RunConfig> {
  const candidateRootRelative = validateRelativeWorkingDirectory(
    options.candidateRoot ?? '.',
  );
  await assertSafeDirectoryPath(
    options.cwd,
    candidateRootRelative,
    'Candidate root',
  );
  const candidateRoot = resolve(options.cwd, candidateRootRelative);
  const configPathRelative = validateRelativeWorkingDirectory(
    options.configPath ?? '.downstream-canary.yml',
  );
  await assertSafeDirectoryPath(
    options.cwd,
    dirname(configPathRelative),
    'Configuration parent directory',
  );
  const configPath = resolve(options.cwd, configPathRelative);
  const hasConfig = await regularFileExists(configPath, 'Configuration file');
  if (options.configPath && !hasConfig) {
    throw new CanaryError(
      'configuration',
      'configuration',
      `Configuration file does not exist: ${configPath}`,
    );
  }
  const raw = hasConfig
    ? parseRawConfig(
        parseYaml(await readFile(configPath, 'utf8'), { maxAliasCount: 0 }),
        candidateRoot,
      )
    : {
        candidate: { root: candidateRoot, workingDirectory: '.' },
        consumers: [],
        defaults: {},
      };

  const inputConsumers = options.consumersText
    ? parseConsumersInput(options.consumersText).map((consumer) =>
        mergeOverrides(consumer, raw.defaults, options.consumerOverrides),
      )
    : raw.consumers.map((consumer) =>
        mergeOverrides(consumer, options.consumerOverrides),
      );
  validateConsumerCount(inputConsumers);

  const timeoutSeconds =
    options.timeoutSeconds ?? raw.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < MIN_TIMEOUT_SECONDS ||
    timeoutSeconds > MAX_TIMEOUT_SECONDS
  ) {
    throw new CanaryError(
      'configuration',
      'configuration',
      `Timeout must be an integer from ${MIN_TIMEOUT_SECONDS} to ${MAX_TIMEOUT_SECONDS} seconds.`,
    );
  }

  const outputDirectoryRelative = validateRelativeWorkingDirectory(
    options.outputDirectory ?? raw.outputDirectory ?? '.downstream-canary-results',
  );
  if (outputDirectoryRelative === '.') {
    throw new CanaryError(
      'configuration',
      'configuration',
      'Output directory must be a dedicated directory below the workspace root.',
    );
  }
  await assertSafeDirectoryPath(
    options.cwd,
    outputDirectoryRelative,
    'Output directory',
  );

  return {
    candidate: mergeOverrides(
      { ...raw.candidate, root: candidateRoot },
      options.candidateOverrides,
    ),
    consumers: inputConsumers,
    outputDirectory: resolve(options.cwd, outputDirectoryRelative),
    timeoutSeconds,
    dockerExecutable: options.dockerExecutable ?? 'docker',
    dockerImage: options.dockerImage ?? RUNNER_IMAGE,
  };
}

export function parseJsonCommandInput(
  input: string | undefined,
  label: string,
): CommandArray | undefined {
  if (!input) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(input) as unknown;
  } catch (error) {
    throw new CanaryError(
      'configuration',
      'configuration',
      `${label} must be a JSON array of arguments.`,
      { cause: error },
    );
  }
  return validateCommandArray(value, label);
}

export function projectOverrideFromInputs(input: {
  readonly packageManager?: PackageManagerName;
  readonly packageManagerVersion?: string;
  readonly testCommand?: CommandArray;
  readonly buildCommand?: CommandArray;
}): ProjectOverrides {
  return { ...input };
}
