import process from 'node:process';
import { resolveRunConfig, parseJsonCommandInput } from './config.js';
import { CanaryError } from './errors.js';
import type {
  PackageManagerName,
  ProjectOverrides,
} from './types.js';
import { parsePackageManagerName, validateExactVersion } from './validation.js';

export interface InvocationValues {
  readonly config: string | undefined;
  readonly consumers: string | undefined;
  readonly candidateRoot: string | undefined;
  readonly outputDirectory: string | undefined;
  readonly timeoutSeconds: string | undefined;
  readonly candidatePackageManager: string | undefined;
  readonly candidatePackageManagerVersion: string | undefined;
  readonly candidateBuildCommand: string | undefined;
  readonly consumerPackageManager: string | undefined;
  readonly consumerPackageManagerVersion: string | undefined;
  readonly consumerTestCommand: string | undefined;
}

function optionalManager(value: string | undefined, label: string): PackageManagerName | undefined {
  return value === undefined ? undefined : parsePackageManagerName(value, label);
}

function optionalVersion(value: string | undefined, label: string): string | undefined {
  return value === undefined ? undefined : validateExactVersion(value, label);
}

function withoutUndefined(value: Record<string, unknown>): ProjectOverrides {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

function candidateOverrides(values: InvocationValues): ProjectOverrides {
  return withoutUndefined({
    packageManager: optionalManager(
      values.candidatePackageManager,
      'candidate package manager',
    ),
    packageManagerVersion: optionalVersion(
      values.candidatePackageManagerVersion,
      'candidate package-manager version',
    ),
    buildCommand: parseJsonCommandInput(
      values.candidateBuildCommand,
      'candidate build command',
    ),
  });
}

function consumerOverrides(values: InvocationValues): ProjectOverrides {
  return withoutUndefined({
    packageManager: optionalManager(
      values.consumerPackageManager,
      'consumer package manager',
    ),
    packageManagerVersion: optionalVersion(
      values.consumerPackageManagerVersion,
      'consumer package-manager version',
    ),
    testCommand: parseJsonCommandInput(
      values.consumerTestCommand,
      'consumer test command',
    ),
  });
}

export async function configFromInvocation(
  cwd: string,
  values: InvocationValues,
) {
  let timeoutSeconds: number | undefined;
  if (values.timeoutSeconds !== undefined) {
    timeoutSeconds = Number(values.timeoutSeconds);
    if (!Number.isInteger(timeoutSeconds)) {
      throw new CanaryError(
        'configuration',
        'configuration',
        'timeout-seconds must be an integer.',
      );
    }
  }
  return await resolveRunConfig({
    cwd,
    ...(values.config ? { configPath: values.config } : {}),
    ...(values.consumers ? { consumersText: values.consumers } : {}),
    ...(values.candidateRoot ? { candidateRoot: values.candidateRoot } : {}),
    ...(values.outputDirectory ? { outputDirectory: values.outputDirectory } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    candidateOverrides: candidateOverrides(values),
    consumerOverrides: consumerOverrides(values),
  });
}

export function currentWorkspace(): string {
  return process.env.GITHUB_WORKSPACE ?? process.cwd();
}
