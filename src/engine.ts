import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_CONSUMERS,
  MAX_TIMEOUT_SECONDS,
  MIN_TIMEOUT_SECONDS,
} from './constants.js';
import { buildCandidate } from './candidate.js';
import { runConsumer } from './consumer.js';
import { DockerRunner } from './docker.js';
import { createReport, writeReports, type ReportPaths } from './report.js';
import type { CanaryReport, RunConfig } from './types.js';
import { CanaryError } from './errors.js';

export interface CanaryRun {
  readonly report: CanaryReport;
  readonly paths: ReportPaths;
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
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'downstream-canary-run-'));
  const docker = new DockerRunner(config.dockerExecutable, config.dockerImage);
  try {
    await docker.ensureReady();
    const built = await buildCandidate(
      config.candidate,
      docker,
      temporaryRoot,
      config.timeoutSeconds,
    );
    const runtime = await docker.runtimeInfo(
      join(temporaryRoot, 'candidate-source', config.candidate.workingDirectory),
      config.timeoutSeconds,
    );
    const results = [];
    for (const consumer of config.consumers) {
      results.push(
        await runConsumer(
          consumer,
          built.artifact,
          docker,
          runtime,
          config.timeoutSeconds,
        ),
      );
    }
    const report = createReport(built.artifact, config.dockerImage, results);
    const paths = await writeReports(report, config.outputDirectory);
    return { report, paths };
  } finally {
    await docker.dispose();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
