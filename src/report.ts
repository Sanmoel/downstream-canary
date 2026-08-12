import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PACKAGE_NAME,
  REPORT_SCHEMA_VERSION,
  VERSION,
} from './constants.js';
import { exitCodeForResults } from './classifier.js';
import { CanaryError } from './errors.js';
import type {
  CanaryReport,
  CandidateArtifact,
  ConsumerResult,
} from './types.js';
import { stableStringify } from './util/stable-json.js';

export interface ReportPaths {
  readonly json: string;
  readonly markdown: string;
}

export function createReport(
  artifact: CandidateArtifact,
  dockerImage: string,
  results: readonly ConsumerResult[],
  generatedAt = new Date().toISOString(),
): CanaryReport {
  const count = (classification: ConsumerResult['classification']): number =>
    results.filter((result) => result.classification === classification).length;
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: { name: PACKAGE_NAME, version: VERSION },
    generatedAt,
    candidate: {
      packageName: artifact.packageName,
      packageVersion: artifact.packageVersion,
      tarballSha256: artifact.sha256,
      contents: artifact.contents,
    },
    environment: {
      dockerImage,
      nodeVersion: results[0]?.nodeVersion ?? 'unknown',
    },
    results,
    summary: {
      compatible: count('compatible'),
      candidateRegressions: count('candidate-regression'),
      inconclusivePreexisting: count('inconclusive-preexisting'),
      candidateImprovements: count('candidate-improvement'),
      toolErrors: count('tool-error'),
      exitCode: exitCodeForResults(results),
    },
  };
}

function escapeMarkdown(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function terminalTable(report: CanaryReport): string {
  const rows = report.results.map((result) => ({
    consumer: result.repositoryUrl.replace('https://github.com/', ''),
    manager:
      result.packageManager && result.actualPackageManagerVersion
        ? `${result.packageManager}@${result.actualPackageManagerVersion}`
        : 'n/a',
    baseline: result.baseline.status,
    candidate: result.candidate.status,
    classification: result.classification,
    phase: result.failurePhase ?? '-',
  }));
  const headers = ['Consumer', 'Manager', 'Baseline', 'Candidate', 'Classification', 'Failure phase'];
  const values = rows.map((row) => [
    row.consumer,
    row.manager,
    row.baseline,
    row.candidate,
    row.classification,
    row.phase,
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...values.map((row) => row[index]?.length ?? 0)),
  );
  const format = (row: readonly string[]): string =>
    row.map((value, index) => value.padEnd(widths[index] ?? value.length)).join('  ');
  return [
    format(headers),
    format(widths.map((width) => '-'.repeat(width))),
    ...values.map(format),
  ].join('\n');
}

export function markdownReport(report: CanaryReport): string {
  const lines = [
    '# Downstream Canary report',
    '',
    `Candidate: \`${report.candidate.packageName}@${report.candidate.packageVersion}\``,
    '',
    `Tarball SHA-256: \`${report.candidate.tarballSha256}\``,
    '',
    '| Consumer | Commit | Manager | Baseline | Candidate | Classification | Failure phase |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.results.map((result) =>
      [
        escapeMarkdown(result.repositoryUrl),
        `\`${result.commit}\``,
        result.packageManager
          ? `${result.packageManager}@${result.actualPackageManagerVersion ?? result.declaredPackageManagerVersion ?? 'unknown'}`
          : 'n/a',
        result.baseline.status,
        result.candidate.status,
        `**${result.classification}**`,
        result.failurePhase ?? '-',
      ].join(' | '),
    ).map((line) => `| ${line} |`),
    '',
    `Regressions: **${report.summary.candidateRegressions}**`,
    '',
    `Tool errors: **${report.summary.toolErrors}**`,
    '',
    `Exit code: **${report.summary.exitCode}**`,
  ];
  const diagnostics = report.results.filter((result) => result.diagnosticExcerpt);
  if (diagnostics.length > 0) {
    lines.push('', '## Bounded diagnostics', '');
    for (const result of diagnostics) {
      lines.push(
        `### ${result.repositoryUrl.replace('https://github.com/', '')}`,
        '',
        '```text',
        result.diagnosticExcerpt.replaceAll('```', '` ` `'),
        '```',
        '',
      );
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export async function writeReports(
  report: CanaryReport,
  outputDirectory: string,
): Promise<ReportPaths> {
  await mkdir(outputDirectory, { recursive: true });
  const outputMetadata = await lstat(outputDirectory);
  if (!outputMetadata.isDirectory() || outputMetadata.isSymbolicLink()) {
    throw new CanaryError(
      'configuration',
      'configuration',
      'Report output must be a real directory, not a symbolic link.',
    );
  }
  const json = join(outputDirectory, 'downstream-canary-report.v1.json');
  const markdown = join(outputDirectory, 'downstream-canary-report.md');
  for (const target of [json, markdown]) {
    try {
      const metadata = await lstat(target);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new CanaryError(
          'configuration',
          'configuration',
          `Refusing to overwrite a non-regular report target: ${target}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  await writeFile(json, stableStringify(report), 'utf8');
  await writeFile(markdown, markdownReport(report), 'utf8');
  return { json, markdown };
}
