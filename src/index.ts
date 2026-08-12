export { runCanary, type CanaryRun } from './engine.js';
export { DockerRunner, type ContainerRuntimeInfo } from './docker.js';
export { createReport, markdownReport, terminalTable, writeReports } from './report.js';
export { classifyCompatibility, exitCodeForResults } from './classifier.js';
export { validateCandidateTarball } from './tarball.js';
export type {
  CanaryReport,
  CandidateArtifact,
  ConsumerResult,
  ConsumerSpec,
  RunConfig,
} from './types.js';
