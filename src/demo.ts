import process from 'node:process';
import { join } from 'node:path';
import { createFixtureWorld } from '../fixtures/factory.js';
import { DEFAULT_PACKAGE_MANAGER_VERSIONS, RUNNER_IMAGE } from './constants.js';
import { DockerRunner } from './docker.js';
import { runCanary } from './engine.js';
import { terminalTable } from './report.js';

type DemoMode = 'regression' | 'compatible' | 'preexisting';

function parseMode(value: string | undefined): DemoMode {
  if (value === 'regression' || value === 'compatible' || value === 'preexisting') {
    return value;
  }
  throw new Error('Demo mode must be regression, compatible, or preexisting.');
}

async function runCandidateTests(
  candidateRoot: string,
  fixtureRoot: string,
  dockerExecutable: string,
): Promise<void> {
  const runner = new DockerRunner(dockerExecutable, RUNNER_IMAGE);
  const cacheDirectory = join(fixtureRoot, 'demo-candidate-test-cache');
  try {
    await runner.ensureReady();
    const managerProvision = await runner.provisionManager(
      candidateRoot,
      join(fixtureRoot, 'demo-candidate-manager-provision'),
      {
        name: 'npm',
        requestedVersion: DEFAULT_PACKAGE_MANAGER_VERSIONS.npm,
      },
      180,
    );
    const test = await runner.run({
      workspace: candidateRoot,
      cacheDirectory,
      command: [
        'corepack',
        `npm@${DEFAULT_PACKAGE_MANAGER_VERSIONS.npm}`,
        'test',
      ],
      timeoutSeconds: 180,
      network: 'none',
      phase: 'demo-candidate-test',
      managerProvision,
    });
    if (test.exitCode !== 0) throw new Error(test.output);
    process.stdout.write('1. Candidate library tests: pass\n');
  } finally {
    await runner.dispose();
  }
}

async function main(): Promise<number> {
  const mode = parseMode(process.argv[2]);
  const dockerExecutable = process.env.DOWNSTREAM_CANARY_DOCKER ?? 'docker';
  process.stdout.write(`Downstream Canary self-contained ${mode} demo\n\n`);
  const world = await createFixtureWorld(dockerExecutable);
  const candidate =
    mode === 'compatible' ? world.candidateCompatible : world.candidateBreaking;
  const consumerId =
    mode === 'regression'
      ? 'npm-regression'
      : mode === 'compatible'
        ? 'npm-compatible'
        : 'npm-preexisting';
  const fixture = world.consumers[consumerId];
  if (!fixture) throw new Error(`Missing demo fixture ${consumerId}.`);
  await runCandidateTests(candidate.root, world.root, dockerExecutable);
  const run = await runCanary({
    candidate,
    consumers: [fixture.consumer],
    outputDirectory: join(world.root, `demo-output-${mode}`),
    timeoutSeconds: 180,
    dockerExecutable,
    dockerImage: RUNNER_IMAGE,
  });
  const result = run.report.results[0];
  if (!result) throw new Error('Demo produced no result.');
  process.stdout.write(`2. Baseline downstream tests: ${result.baseline.status}\n`);
  process.stdout.write(`3. Candidate downstream tests: ${result.candidate.status}\n`);
  process.stdout.write(`4. Classification: ${result.classification}\n`);
  process.stdout.write(`5. Exit code: ${run.report.summary.exitCode}\n\n`);
  process.stdout.write(`${terminalTable(run.report)}\n\n`);
  process.stdout.write(`JSON report: ${run.paths.json}\n`);
  process.stdout.write(`Markdown report: ${run.paths.markdown}\n`);
  return run.report.summary.exitCode;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
