import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureWorld, type FixtureWorld } from '../../fixtures/factory.js';
import { RUNNER_IMAGE } from '../../src/constants.js';
import { DockerRunner } from '../../src/docker.js';
import { runCanary, type CanaryRun } from '../../src/engine.js';
import { snapshotTree } from '../../src/util/files.js';
import { FIXTURE_LOCAL_PATH } from '../../src/types.js';

const dockerExecutable = process.env.DOWNSTREAM_CANARY_DOCKER ?? 'docker';
let world: FixtureWorld;
let compatibleRun: CanaryRun;
let breakingRun: CanaryRun;
let originalSnapshots: Record<string, ReadonlyMap<string, string>>;

function consumers(ids: readonly string[]) {
  return ids.map((id) => {
    const fixture = world.consumers[id];
    if (!fixture) throw new Error(`Missing fixture ${id}`);
    return fixture.consumer;
  });
}

function result(run: CanaryRun, id: string) {
  const found = run.report.results.find((item) => item.repositoryUrl.endsWith(`/${id}`));
  if (!found) throw new Error(`Missing result ${id}`);
  return found;
}

beforeAll(async () => {
  world = await createFixtureWorld(dockerExecutable);
  originalSnapshots = {};
  for (const [id, fixture] of Object.entries(world.consumers)) {
    originalSnapshots[id] = await snapshotTree(fixture.path);
  }
  compatibleRun = await runCanary({
    candidate: world.candidateCompatible,
    consumers: consumers(['npm-compatible', 'pnpm-compatible', 'yarn-compatible']),
    outputDirectory: join(world.root, 'reports-compatible'),
    timeoutSeconds: 180,
    dockerExecutable,
    dockerImage: RUNNER_IMAGE,
  });
  process.env.DOWNSTREAM_CANARY_TEST_SECRET = 'downstream-canary-secret-sentinel';
  breakingRun = await runCanary({
    candidate: world.candidateBreaking,
    consumers: consumers([
      'npm-regression',
      'pnpm-regression',
      'yarn-regression',
      'npm-preexisting',
      'npm-improvement',
      'npm-security',
      'npm-injection-failure',
    ]),
    outputDirectory: join(world.root, 'reports-breaking'),
    timeoutSeconds: 180,
    dockerExecutable,
    dockerImage: RUNNER_IMAGE,
  });
  delete process.env.DOWNSTREAM_CANARY_TEST_SECRET;
});

afterAll(async () => {
  if (world?.root) await rm(world.root, { recursive: true, force: true });
});

describe('end-to-end package-manager fixture matrix', () => {
  it.each(['npm', 'pnpm', 'yarn'] as const)('%s compatible is a verified nonblocking comparison', (manager) => {
    const item = result(compatibleRun, `${manager}-compatible`);
    expect(item).toMatchObject({
      packageManager: manager,
      baseline: { status: 'pass', installStatus: 'pass', testStatus: 'pass' },
      candidate: { status: 'pass', installStatus: 'pass', testStatus: 'pass' },
      classification: 'compatible',
      dependencyFieldReplaced: 'dependencies',
    });
    expect(item.actualPackageManagerVersion).toBe(item.declaredPackageManagerVersion);
    expect(item.originalLockfileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(item.candidateLockfileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(item.candidateLockfileHash).not.toBe(item.originalLockfileHash);
  });

  it.each(['npm', 'pnpm', 'yarn'] as const)('%s candidate regression blocks', (manager) => {
    expect(result(breakingRun, `${manager}-regression`)).toMatchObject({
      packageManager: manager,
      baseline: { status: 'pass' },
      candidate: { status: 'fail' },
      classification: 'candidate-regression',
      failurePhase: 'candidate-test',
    });
  });

  it('handles pre-existing failure and candidate improvement without blocking', () => {
    expect(result(breakingRun, 'npm-preexisting')).toMatchObject({
      baseline: { status: 'fail' },
      candidate: { status: 'fail' },
      classification: 'inconclusive-preexisting',
    });
    expect(result(breakingRun, 'npm-improvement')).toMatchObject({
      baseline: { status: 'fail' },
      candidate: { status: 'pass' },
      classification: 'candidate-improvement',
    });
  });

  it('treats injection failure as a tool error', () => {
    expect(result(breakingRun, 'npm-injection-failure')).toMatchObject({
      classification: 'tool-error',
      failurePhase: 'candidate-injection',
    });
  });

  it('proves secret omission, test-time network isolation, and read-only root and manager filesystems', () => {
    expect(result(breakingRun, 'npm-security')).toMatchObject({
      baseline: { status: 'pass' },
      candidate: { status: 'pass' },
      classification: 'compatible',
    });
  });

  it('writes versioned JSON and Markdown reports and records tarball identity', async () => {
    expect(compatibleRun.report.schemaVersion).toBe('1.0.0');
    expect(compatibleRun.report.candidate.tarballSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(compatibleRun.report.candidate.contents).toContain('package/package.json');
    await expect(access(compatibleRun.paths.json)).resolves.toBeUndefined();
    await expect(access(compatibleRun.paths.markdown)).resolves.toBeUndefined();
    const reportDocument = JSON.parse(
      await readFile(compatibleRun.paths.json, 'utf8'),
    ) as unknown;
    const reportSchema = JSON.parse(
      await readFile('schemas/downstream-canary-report.schema.json', 'utf8'),
    ) as object;
    const validate = new Ajv2020({
      allErrors: true,
      strict: true,
      formats: { uri: true, 'date-time': true },
    }).compile(reportSchema);
    expect(validate(reportDocument), JSON.stringify(validate.errors)).toBe(true);
    expect(reportDocument).toEqual(compatibleRun.report);
  });

  it('never modifies the original fixture repositories', async () => {
    for (const [id, fixture] of Object.entries(world.consumers)) {
      expect(await snapshotTree(fixture.path)).toEqual(originalSnapshots[id]);
    }
  });
});

describe('Docker timeout cleanup', () => {
  it('terminates the complete container process tree', async () => {
    const runner = new DockerRunner(dockerExecutable, RUNNER_IMAGE);
    const workspace = join(world.root, 'timeout-workspace');
    const marker = join(workspace, 'child-survived');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace, { recursive: true }));
    try {
      await runner.ensureReady();
      const result = await runner.run({
        workspace,
        cacheDirectory: join(world.root, 'timeout-cache'),
        command: [
          'node',
          '-e',
          "const{spawn}=require('node:child_process');spawn(process.execPath,['-e',\"setTimeout(()=>require('node:fs').writeFileSync('/workspace/child-survived','bad'),3000)\"],{stdio:'ignore'});setInterval(()=>{},1000)",
        ],
        timeoutSeconds: 1,
        network: 'none',
        phase: 'timeout-tree-test',
      });
      expect(result.timedOut).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 3500));
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await runner.dispose();
    }
  });
});

describe('candidate install failure classification', () => {
  it('is a candidate regression after a healthy baseline', async () => {
    const original = world.consumers['npm-regression'];
    if (!original) throw new Error('Missing npm regression fixture');
    const path = join(world.root, 'npm-candidate-install-failure');
    await import('node:fs/promises').then(({ cp }) =>
      cp(original.path, path, {
        recursive: true,
        filter: (source) => !source.includes('/.git'),
      }),
    );
    await mkdir(join(path, '.git'), { recursive: true });
    await writeFile(
      join(path, 'package.json'),
      `${JSON.stringify(
        {
          name: 'npm-candidate-install-failure',
          version: '1.0.0',
          private: true,
          packageManager: 'npm@11.17.0',
          dependencies: { 'tiny-parser': 'file:vendor/tiny-parser-1.0.0.tgz' },
          scripts: {
            preinstall:
              "node -e \"const p=require('./package.json');if(String(p.dependencies['tiny-parser']).includes('.downstream-canary'))process.exit(42)\"",
            test: 'node test.cjs',
          },
        },
        null,
        2,
      )}\n`,
    );
    const { runProcess, safeHostEnvironment } = await import('../../src/process.js');
    const environment = safeHostEnvironment({
      GIT_AUTHOR_NAME: 'Downstream Canary Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Downstream Canary Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    });
    await rm(join(path, '.git'), { recursive: true, force: true });
    for (const command of [
      ['git', 'init', '--quiet', '--initial-branch=main'],
      ['git', 'add', '--all'],
      ['git', 'commit', '--quiet', '-m', 'fixture'],
    ] as const) {
      const commandResult = await runProcess(command, { cwd: path, environment });
      expect(commandResult.exitCode).toBe(0);
    }
    const revision = await runProcess(['git', 'rev-parse', 'HEAD'], { cwd: path, environment });
    const commit = revision.stdout.trim();
    const run = await runCanary({
      candidate: world.candidateBreaking,
      consumers: [
        {
          repositoryUrl:
            'https://github.com/downstream-canary-fixtures/npm-candidate-install-failure',
          commit,
          workingDirectory: '.',
          [FIXTURE_LOCAL_PATH]: path,
        },
      ],
      outputDirectory: join(world.root, 'reports-install-failure'),
      timeoutSeconds: 180,
      dockerExecutable,
      dockerImage: RUNNER_IMAGE,
    });
    expect(run.report.results[0]).toMatchObject({
      baseline: { status: 'pass', installStatus: 'pass' },
      candidate: { status: 'fail', installStatus: 'fail' },
      classification: 'candidate-regression',
      failurePhase: 'candidate-install',
    });
  });
});
