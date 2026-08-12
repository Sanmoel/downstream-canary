import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CanaryError } from './errors.js';
import { runProcess, safeHostEnvironment } from './process.js';
import { FIXTURE_LOCAL_PATH, type CommandArray, type ConsumerSpec } from './types.js';
import { validateFullCommitSha, validatePublicGitHubUrl } from './validation.js';

function gitEnvironment(configDirectory: string): Record<string, string> {
  return safeHostEnvironment({
    HOME: configDirectory,
    XDG_CONFIG_HOME: configDirectory,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
  });
}

async function git(
  args: readonly string[],
  cwd: string,
  configDirectory: string,
  timeoutMs: number,
): Promise<string> {
  const command = ['git', '-c', 'credential.helper=', ...args] as unknown as CommandArray;
  const result = await runProcess(command, {
    cwd,
    environment: gitEnvironment(configDirectory),
    timeoutMs,
  });
  if (result.exitCode !== 0) {
    throw new CanaryError(
      'infrastructure',
      'checkout',
      `Git command failed while checking out a pinned consumer: git ${args.join(' ')}`,
      { diagnostic: result.output },
    );
  }
  return result.stdout.trim();
}

export async function checkoutConsumer(
  consumer: ConsumerSpec,
  destination: string,
  configDirectory: string,
  timeoutSeconds: number,
): Promise<void> {
  validatePublicGitHubUrl(consumer.repositoryUrl);
  validateFullCommitSha(consumer.commit);
  await mkdir(destination, { recursive: true });
  await mkdir(configDirectory, { recursive: true });
  const timeoutMs = timeoutSeconds * 1000;
  await git(['init', '--quiet', '--initial-branch=canary'], destination, configDirectory, timeoutMs);
  await git(
    [
      'remote',
      'add',
      'origin',
      consumer[FIXTURE_LOCAL_PATH] ?? consumer.repositoryUrl,
    ],
    destination,
    configDirectory,
    timeoutMs,
  );
  await git(
    ['fetch', '--quiet', '--depth=1', '--no-tags', 'origin', consumer.commit],
    destination,
    configDirectory,
    timeoutMs,
  );
  await git(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], destination, configDirectory, timeoutMs);
  const actual = await git(['rev-parse', 'HEAD'], destination, configDirectory, timeoutMs);
  if (actual !== consumer.commit) {
    throw new CanaryError(
      'infrastructure',
      'checkout',
      `Requested consumer commit ${consumer.commit}, but checked out ${actual}.`,
    );
  }
  const stagedFiles = await git(
    ['ls-files', '--stage'],
    destination,
    configDirectory,
    timeoutMs,
  );
  if (stagedFiles.split('\n').some((line) => line.startsWith('160000 '))) {
    throw new CanaryError(
      'unsupported-project',
      'checkout',
      'Git submodules are unsupported in v0.1.',
    );
  }
  try {
    await lstat(join(destination, '.gitmodules'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    throw error;
  }
  throw new CanaryError(
    'unsupported-project',
    'checkout',
    'Git submodules are unsupported in v0.1.',
  );
}
