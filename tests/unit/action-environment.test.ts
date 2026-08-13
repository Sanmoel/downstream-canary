import { describe, expect, it } from 'vitest';
import {
  enforceTrustedActionEnvironment,
  validateLocalDockerHost,
} from '../../src/action-environment.js';

const SAFE = {
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'pull_request',
  GITHUB_WORKSPACE: '/github/workspace',
  RUNNER_OS: 'Linux',
  RUNNER_ENVIRONMENT: 'github-hosted',
} as const;

describe('trusted Action environment', () => {
  it('accepts only the GitHub-hosted Linux Action boundary', () => {
    expect(enforceTrustedActionEnvironment(SAFE)).toEqual({
      workspace: '/github/workspace',
      dockerHost: undefined,
    });
    expect(
      enforceTrustedActionEnvironment({
        ...SAFE,
        DOCKER_HOST: 'unix:///var/run/docker.sock',
      }),
    ).toMatchObject({ dockerHost: 'unix:///var/run/docker.sock' });
  });

  it.each([
    [{ ...SAFE, GITHUB_ACTIONS: 'false' }, /only inside GitHub Actions/],
    [{ ...SAFE, GITHUB_EVENT_NAME: 'pull_request_target' }, /forbidden/],
    [{ ...SAFE, RUNNER_OS: 'macOS' }, /Linux runner/],
    [{ ...SAFE, RUNNER_ENVIRONMENT: 'self-hosted' }, /GitHub-hosted/],
  ] as const)('rejects an unsafe Action environment', (environment, message) => {
    expect(() => enforceTrustedActionEnvironment(environment)).toThrow(message);
  });

  it.each([
    'tcp://127.0.0.1:2375',
    'ssh://runner@example.com',
    'http://127.0.0.1:2375',
    'unix://relative.sock',
  ])('rejects remote or non-absolute Docker endpoint %s', (dockerHost) => {
    expect(() => validateLocalDockerHost(dockerHost)).toThrow(/local.*Unix|Remote Docker/i);
  });
});
