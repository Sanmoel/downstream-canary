import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_CONSUMERS,
  MAX_TIMEOUT_SECONDS,
  MIN_TIMEOUT_SECONDS,
  DEFAULT_RUN_TIMEOUT_SECONDS,
  MAX_RUN_TIMEOUT_SECONDS,
  MIN_RUN_TIMEOUT_SECONDS,
} from './constants.js';
import { buildCandidate } from './candidate.js';
import { runConsumer } from './consumer.js';
import { DockerRunner } from './docker.js';
import { createReport, writeReports, type ReportPaths } from './report.js';
import type { CanaryReport, RunConfig } from './types.js';
import { CanaryError } from './errors.js';
import { RunBudget } from './budget.js';
import { diagnosticExcerpt } from './util/logs.js';
import process from 'node:process';

export interface CanaryRun {
  readonly report: CanaryReport;
  readonly paths: ReportPaths;
}

function installTerminationCleanup(cleanup: () => Promise<void>): () => void {
  let handling = false;
  const handlers = new Map<NodeJS.Signals, () => void>();
  const remove = (): void => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const handler = (): void => {
      if (handling) return;
      handling = true;
      void cleanup()
        .then(() => {
          remove();
          process.kill(process.pid, signal);
        })
        .catch((error: unknown) => {
          remove();
          process.stderr.write(
            `downstream-canary cleanup failure: ${diagnosticExcerpt(
              error instanceof Error ? error.message : String(error),
            )}\n`,
          );
          process.exit(2);
        });
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return remove;
}

export async function runCanary(config: RunConfig): Promise<CanaryRun> {
  if (config.consumers.length < 1 || config.consumers.length > MAX_CONSUMERS) {
    throw new CanaryError(
      'configuration',
      'configuration',
      `Configure between 1 and ${MAX_CONSUMERS} pinned consumers; received ${config.consumers.length}.`,
    );
  }
  if (
    !Number.isInteger(config.timeoutSeconds) ||
    config.timeoutSeconds < MIN_TIMEOUT_SECONDS ||
    config.timeoutSeconds > MAX_TIMEOUT_SECONDS
  ) {
    throw new CanaryError(
      'configuration',
      'configuration',
      `Timeout must be an integer from ${MIN_TIMEOUT_SECONDS} to ${MAX_TIMEOUT_SECONDS} seconds.`,
    );
  }
  const runTimeoutSeconds =
    config.runTimeoutSeconds ?? DEFAULT_RUN_TIMEOUT_SECONDS;
  if (
    !Number.isInteger(runTimeoutSeconds) ||
    runTimeoutSeconds < MIN_RUN_TIMEOUT_SECONDS ||
    runTimeoutSeconds > MAX_RUN_TIMEOUT_SECONDS
  ) {
    throw new CanaryError(
      'configuration',
      'configuration',
      `Whole-run timeout must be an integer from ${MIN_RUN_TIMEOUT_SECONDS} to ${MAX_RUN_TIMEOUT_SECONDS} seconds.`,
    );
  }
  const budget = new RunBudget(
    config.timeoutSeconds,
    runTimeoutSeconds,
  );
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'downstream-canary-run-'));
  const actionMode = config.executionMode === 'github-action';
  const docker = new DockerRunner(config.dockerExecutable, config.dockerImage, {
    allowContextDiscovery: !actionMode,
    requireLocalDocker: actionMode,
    budget,
  });
  const cleanup = async (): Promise<void> => {
    await docker.dispose();
    await rm(temporaryRoot, { recursive: true, force: true });
  };
  const removeSignalHandlers = installTerminationCleanup(cleanup);
  try {
    await docker.ensureReady();
    const built = await buildCandidate(
      config.candidate,
      docker,
      temporaryRoot,
      budget,
    );
    const runtime = await docker.runtimeInfo(
      join(temporaryRoot, 'candidate-source', config.candidate.workingDirectory),
      budget.timeoutSeconds('runner identity inspection'),
    );
    const results = [];
    for (const [index, consumer] of config.consumers.entries()) {
      const consumerBudget = budget.forRemainingConsumer(
        `${consumer.repositoryUrl}@${consumer.commit}`,
        config.consumers.length - index,
      );
      results.push(
        await runConsumer(
          consumer,
          built.artifact,
          docker,
          runtime,
          consumerBudget,
        ),
      );
    }
    const report = createReport(
      built.artifact,
      config.dockerImage,
      results,
      undefined,
      {
        config,
        candidateManager: built.manager,
        candidateBuildCommand: built.buildCommand,
      },
    );
    const paths = await writeReports(report, config.outputDirectory);
    return { report, paths };
  } finally {
    removeSignalHandlers();
    await cleanup();
  }
}
