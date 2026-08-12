#!/usr/bin/env node
import process from 'node:process';
import { VERSION } from './constants.js';
import { runCanary } from './engine.js';
import { errorDiagnostic } from './errors.js';
import { configFromInvocation, type InvocationValues } from './invocation.js';
import { parseArguments, rejectUnknownOptions } from './options.js';
import { terminalTable } from './report.js';
import { diagnosticExcerpt } from './util/logs.js';

const HELP = `Downstream Canary ${VERSION}

Usage:
  downstream-canary --consumers "OWNER/REPO@FULL_SHA" [options]
  downstream-canary --config .downstream-canary.yml [options]

Options:
  --consumers <lines>                    Pinned public GitHub consumers
  --config <path>                        Optional YAML configuration
  --candidate-root <path>                Candidate repository root (default: .)
  --output-directory <path>              Report directory
  --timeout-seconds <integer>            Per-command timeout
  --candidate-package-manager <name>     npm, pnpm, or yarn override
  --candidate-package-manager-version <v> Exact candidate manager version
  --candidate-build-command <json-array> Candidate build command
  --consumer-package-manager <name>      Consumer manager override
  --consumer-package-manager-version <v> Exact consumer manager version
  --consumer-test-command <json-array>   Identical lane test command
  --help                                 Show help
  --version                              Show version
`;

const ALLOWED = new Set([
  'consumers',
  'config',
  'candidate-root',
  'output-directory',
  'timeout-seconds',
  'candidate-package-manager',
  'candidate-package-manager-version',
  'candidate-build-command',
  'consumer-package-manager',
  'consumer-package-manager-version',
  'consumer-test-command',
]);

function invocationValues(values: ReadonlyMap<string, string>): InvocationValues {
  return {
    config: values.get('config'),
    consumers: values.get('consumers'),
    candidateRoot: values.get('candidate-root'),
    outputDirectory: values.get('output-directory'),
    timeoutSeconds: values.get('timeout-seconds'),
    candidatePackageManager: values.get('candidate-package-manager'),
    candidatePackageManagerVersion: values.get('candidate-package-manager-version'),
    candidateBuildCommand: values.get('candidate-build-command'),
    consumerPackageManager: values.get('consumer-package-manager'),
    consumerPackageManagerVersion: values.get('consumer-package-manager-version'),
    consumerTestCommand: values.get('consumer-test-command'),
  };
}

async function main(): Promise<number> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.flags.has('help')) {
    process.stdout.write(HELP);
    return 0;
  }
  if (parsed.flags.has('version')) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  rejectUnknownOptions(parsed, ALLOWED);
  const config = await configFromInvocation(process.cwd(), invocationValues(parsed.values));
  const run = await runCanary(config);
  process.stdout.write(`${terminalTable(run.report)}\n\n`);
  process.stdout.write(`JSON report: ${run.paths.json}\n`);
  process.stdout.write(`Markdown report: ${run.paths.markdown}\n`);
  process.stdout.write(`Regressions: ${run.report.summary.candidateRegressions}\n`);
  return run.report.summary.exitCode;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`downstream-canary: ${diagnosticExcerpt(errorDiagnostic(error))}\n`);
  process.exitCode = 2;
}
