import { isAbsolute } from 'node:path';
import { CanaryError } from './errors.js';

export interface TrustedActionEnvironment {
  readonly workspace: string;
  readonly dockerHost: string | undefined;
}

export function validateLocalDockerHost(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const normalized = value.trim();
  let url: URL;
  try {
    url = new URL(normalized);
  } catch (error) {
    throw new CanaryError(
      'configuration',
      'docker',
      'DOCKER_HOST must be unset or select a local absolute Unix-domain socket.',
      { cause: error },
    );
  }
  if (
    url.protocol !== 'unix:' ||
    url.hostname !== '' ||
    !isAbsolute(decodeURIComponent(url.pathname)) ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new CanaryError(
      'configuration',
      'docker',
      'Remote Docker endpoints are forbidden; DOCKER_HOST must be unset or use a local unix:///absolute/path socket.',
    );
  }
  return normalized;
}

export function enforceTrustedActionEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): TrustedActionEnvironment {
  if (environment.GITHUB_ACTIONS !== 'true') {
    throw new CanaryError(
      'configuration',
      'configuration',
      'The GitHub Action entry point may run only inside GitHub Actions. Use the CLI for explicit local execution.',
    );
  }
  if (!environment.GITHUB_EVENT_NAME) {
    throw new CanaryError(
      'configuration',
      'configuration',
      'GITHUB_EVENT_NAME is required in Action mode.',
    );
  }
  if (environment.GITHUB_EVENT_NAME === 'pull_request_target') {
    throw new CanaryError(
      'configuration',
      'configuration',
      'pull_request_target is forbidden; use pull_request without secrets.',
    );
  }
  if (environment.RUNNER_OS !== 'Linux') {
    throw new CanaryError(
      'configuration',
      'configuration',
      'Action mode requires a Linux runner.',
    );
  }
  if (environment.RUNNER_ENVIRONMENT !== 'github-hosted') {
    throw new CanaryError(
      'configuration',
      'configuration',
      'Action mode requires a GitHub-hosted runner; self-hosted runners are unsupported.',
    );
  }
  const workspace = environment.GITHUB_WORKSPACE;
  if (!workspace || !isAbsolute(workspace)) {
    throw new CanaryError(
      'configuration',
      'configuration',
      'GITHUB_WORKSPACE must be an absolute path in Action mode.',
    );
  }
  return {
    workspace,
    dockerHost: validateLocalDockerHost(environment.DOCKER_HOST),
  };
}
