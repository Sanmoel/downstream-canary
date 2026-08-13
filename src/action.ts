import { appendFile } from 'node:fs/promises';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { runCanary } from './engine.js';
import { errorDiagnostic } from './errors.js';
import { enforceTrustedActionEnvironment } from './action-environment.js';
import { configFromActionInvocation, type InvocationValues } from './invocation.js';
import { terminalTable } from './report.js';
import { diagnosticExcerpt } from './util/logs.js';

function input(name: string): string | undefined {
  const value = process.env[`INPUT_${name.toUpperCase()}`]?.trim();
  return value ? value : undefined;
}

function actionValues(): InvocationValues {
  if (input('CONFIG') !== undefined) {
    throw new Error(
      'The v0.1 GitHub Action rejects the removed config input; declare policy in the Action invocation.',
    );
  }
  return {
    consumers: input('CONSUMERS'),
    config: undefined,
    candidateRoot: input('CANDIDATE-ROOT'),
    outputDirectory: input('OUTPUT-DIRECTORY'),
    timeoutSeconds: input('TIMEOUT-SECONDS'),
    runTimeoutSeconds: input('RUN-TIMEOUT-SECONDS'),
    candidatePackageManager: input('CANDIDATE-PACKAGE-MANAGER'),
    candidatePackageManagerVersion: input('CANDIDATE-PACKAGE-MANAGER-VERSION'),
    candidateBuildCommand: input('CANDIDATE-BUILD-COMMAND'),
    consumerPackageManager: input('CONSUMER-PACKAGE-MANAGER'),
    consumerPackageManagerVersion: input('CONSUMER-PACKAGE-MANAGER-VERSION'),
    consumerTestCommand: input('CONSUMER-TEST-COMMAND'),
  };
}

async function setOutput(name: string, value: string): Promise<void> {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  const delimiter = `DOWNSTREAM_CANARY_${randomUUID()}`;
  await appendFile(
    outputPath,
    `${name}<<${delimiter}\n${value}\n${delimiter}\n`,
    'utf8',
  );
}

function escapeWorkflowCommand(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

async function main(): Promise<number> {
  const trustedEnvironment = enforceTrustedActionEnvironment();
  const config = await configFromActionInvocation(
    trustedEnvironment.workspace,
    actionValues(),
  );
  const run = await runCanary(config);
  process.stdout.write(`${terminalTable(run.report)}\n`);
  await setOutput('report-path', run.paths.json);
  await setOutput(
    'regression-count',
    String(run.report.summary.candidateRegressions),
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    const markdown = await import('node:fs/promises').then(({ readFile }) =>
      readFile(run.paths.markdown, 'utf8'),
    );
    await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown, 'utf8');
  }
  return run.report.summary.exitCode;
}

try {
  process.exitCode = await main();
} catch (error) {
  const message = diagnosticExcerpt(errorDiagnostic(error));
  process.stderr.write(`::error::${escapeWorkflowCommand(message)}\n`);
  process.exitCode = 2;
}
