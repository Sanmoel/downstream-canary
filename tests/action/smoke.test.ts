import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureWorld, type FixtureWorld } from '../../fixtures/factory.js';
import { sha256 } from '../../src/util/hash.js';
import { stableStringify } from '../../src/util/stable-json.js';

let temporary: string;
let world: FixtureWorld;
let wrapperDirectory: string;
let dockerHost: string | undefined;

async function executableOnPath(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const path = join(directory, name);
    try {
      await access(path, fsConstants.X_OK);
      return path;
    } catch {
      // Continue to the next PATH component.
    }
  }
  throw new Error(`Could not locate executable ${name} on PATH.`);
}

async function writeGitWrapper(realGit: string, fixtureUrl: string, fixturePath: string) {
  const target = join(wrapperDirectory, 'git');
  await writeFile(
    target,
    `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2).map(value => value === ${JSON.stringify(fixtureUrl)} ? ${JSON.stringify(fixturePath)} : value);
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit', env: process.env, shell: false });
process.exit(result.status ?? 127);
`,
  );
  await chmod(target, 0o755);
}

function actionEnvironment(
  workspace: string,
  output: string,
  summary: string,
  values: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    PATH: `${wrapperDirectory}${delimiter}${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
    LANG: process.env.LANG ?? 'C.UTF-8',
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
    RUNNER_OS: 'Linux',
    RUNNER_ENVIRONMENT: 'github-hosted',
    ...(dockerHost ? { DOCKER_HOST: dockerHost } : {}),
    ...values,
  };
}

function runAction(environment: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [resolve('dist/action.js')], {
    cwd: resolve('.'),
    encoding: 'utf8',
    shell: false,
    env: environment,
    timeout: 15 * 60_000,
  });
}

function parseOutputs(source: string): ReadonlyMap<string, string> {
  const outputs = new Map<string, string>();
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([^<]+)<<(.+)$/.exec(lines[index] ?? '');
    if (!match?.[1] || !match[2]) continue;
    const values: string[] = [];
    index += 1;
    while (index < lines.length && lines[index] !== match[2]) {
      values.push(lines[index] ?? '');
      index += 1;
    }
    outputs.set(match[1], values.join('\n'));
  }
  return outputs;
}

beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'downstream-canary-action-smoke-'));
  const dockerExecutable = process.env.DOWNSTREAM_CANARY_DOCKER ?? 'docker';
  world = await createFixtureWorld(dockerExecutable);
  wrapperDirectory = join(temporary, 'bin');
  await import('node:fs/promises').then(({ mkdir }) =>
    mkdir(wrapperDirectory, { recursive: true }),
  );
  const fixture = world.consumers['npm-coverage'];
  if (!fixture) throw new Error('Missing npm-coverage fixture.');
  await writeGitWrapper(
    await executableOnPath('git'),
    fixture.consumer.repositoryUrl,
    fixture.path,
  );
  const context = spawnSync(
    dockerExecutable,
    [
      'context',
      'inspect',
      '--format',
      '{{(index .Endpoints "docker").Host}}',
    ],
    { encoding: 'utf8', shell: false, env: process.env },
  );
  const detectedHost = context.stdout.trim();
  if (context.status === 0 && detectedHost.startsWith('unix:///')) {
    dockerHost = detectedHost;
  }
});

afterAll(async () => {
  if (world?.root) await rm(world.root, { recursive: true, force: true });
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

describe('bundled GitHub Action entry point', () => {
  it('writes successful outputs and summary while ignoring candidate YAML policy', async () => {
    const fixture = world.consumers['npm-coverage'];
    if (!fixture) throw new Error('Missing npm-coverage fixture.');
    await writeFile(
      join(world.candidateCompatible.root, '.downstream-canary.yml'),
      `version: 1\ncandidate:\n  packageManager: yarn\ndefaults:\n  packageManager: yarn\n  testCommand: [node, -e, process.exit(0)]\ntimeoutSeconds: 3600\nrunTimeoutSeconds: 3600\nconsumers:\n  - attacker/no-op@0123456789abcdef0123456789abcdef01234567\n`,
    );
    const output = join(temporary, 'output');
    const summary = join(temporary, 'summary');
    await writeFile(output, '');
    await writeFile(summary, '');
    const run = runAction(
      actionEnvironment(world.candidateCompatible.root, output, summary, {
        INPUT_CONSUMERS: `${fixture.consumer.repositoryUrl}@${fixture.commit}`,
        'INPUT_OUTPUT-DIRECTORY': 'action-results',
        'INPUT_TIMEOUT-SECONDS': '180',
        'INPUT_RUN-TIMEOUT-SECONDS': '900',
      }),
    );
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);

    const outputs = parseOutputs(await readFile(output, 'utf8'));
    expect(outputs.get('regression-count')).toBe('0');
    const reportPath = outputs.get('report-path');
    expect(reportPath).toBe(resolve(world.candidateCompatible.root, 'action-results/downstream-canary-report.v1.json'));
    const report = JSON.parse(await readFile(reportPath as string, 'utf8')) as {
      readonly policy: {
        readonly sha256: string;
        readonly resolved: {
          readonly source: string;
          readonly candidate: { readonly packageManager: string | null };
          readonly consumers: readonly { readonly repositoryUrl: string }[];
          readonly limits: {
            readonly commandTimeoutSeconds: number;
            readonly wholeRunTimeoutSeconds: number;
          };
        };
      };
      readonly results: readonly {
        readonly classification: string;
        readonly executedTestCommand: readonly string[];
        readonly generatedPaths: {
          readonly baseline: readonly { readonly path: string }[];
          readonly candidate: readonly { readonly path: string }[];
        };
      }[];
    };
    const reportSchema = JSON.parse(
      await readFile('schemas/downstream-canary-report.schema.json', 'utf8'),
    ) as object;
    const validate = new Ajv2020({
      allErrors: true,
      strict: true,
      formats: { uri: true, 'date-time': true },
    }).compile(reportSchema);
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(report.policy.sha256).toBe(sha256(stableStringify(report.policy.resolved)));
    expect(report.policy.resolved).toMatchObject({
      source: 'github-action',
      candidate: { packageManager: 'npm' },
      consumers: [{ repositoryUrl: fixture.consumer.repositoryUrl }],
      limits: {
        commandTimeoutSeconds: 180,
        wholeRunTimeoutSeconds: 900,
      },
    });
    expect(report.results[0]).toMatchObject({
      classification: 'compatible',
      executedTestCommand: ['corepack', 'npm@11.17.0', 'test'],
      generatedPaths: {
        baseline: [{ path: 'coverage/summary.json' }],
        candidate: [{ path: 'coverage/summary.json' }],
      },
    });
    const markdown = await readFile(summary, 'utf8');
    expect(markdown).toContain('# Downstream Canary report');
    expect(markdown).toContain('compatible');
  });

  it('emits a GitHub error and no outputs for invalid invocation policy', async () => {
    const output = join(temporary, 'invalid-output');
    const summary = join(temporary, 'invalid-summary');
    await writeFile(output, '');
    await writeFile(summary, '');
    const run = runAction(
      actionEnvironment(world.candidateCompatible.root, output, summary, {
        INPUT_CONSUMERS: 'invalid-without-a-full-sha',
        'INPUT_TIMEOUT-SECONDS': '60',
        'INPUT_RUN-TIMEOUT-SECONDS': '120',
      }),
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('::error::');
    expect(await readFile(output, 'utf8')).toBe('');
    expect(await readFile(summary, 'utf8')).toBe('');
  });

  it('fails closed if the removed Action config input is supplied', async () => {
    const fixture = world.consumers['npm-coverage'];
    if (!fixture) throw new Error('Missing npm-coverage fixture.');
    const output = join(temporary, 'config-output');
    const summary = join(temporary, 'config-summary');
    await writeFile(output, '');
    await writeFile(summary, '');
    const run = runAction(
      actionEnvironment(world.candidateCompatible.root, output, summary, {
        INPUT_CONFIG: '.downstream-canary.yml',
        INPUT_CONSUMERS: `${fixture.consumer.repositoryUrl}@${fixture.commit}`,
      }),
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('rejects the removed config input');
    expect(await readFile(output, 'utf8')).toBe('');
    expect(await readFile(summary, 'utf8')).toBe('');
  });
});
