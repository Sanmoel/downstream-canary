export const PRODUCT_NAME = 'Downstream Canary';
export const PACKAGE_NAME = 'downstream-canary';
export const VERSION = '0.1.0';
export const REPORT_SCHEMA_VERSION = '1.0.0';
export const CONFIG_SCHEMA_VERSION = 1;

export const NODE_VERSION = '24.19.0';
export const RUNNER_IMAGE =
  'node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03';

export const DEFAULT_PACKAGE_MANAGER_VERSIONS = {
  npm: '11.17.0',
  pnpm: '11.21.0',
  yarn: '4.18.0',
} as const;

export const DEFAULT_TIMEOUT_SECONDS = 10 * 60;
export const MIN_TIMEOUT_SECONDS = 1;
export const MAX_TIMEOUT_SECONDS = 60 * 60;
export const MAX_CONSUMERS = 10;
export const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
export const MAX_DIAGNOSTIC_BYTES = 8 * 1024;
export const MAX_TARBALL_BYTES = 50 * 1024 * 1024;
export const MAX_UNPACKED_TARBALL_BYTES = 200 * 1024 * 1024;
export const MAX_TARBALL_ENTRIES = 20_000;

export const DOCKER_LIMITS = {
  cpus: '2',
  memory: '1g',
  pids: '256',
  tmpfsSize: '256m',
} as const;

export const RECOGNIZED_LOCKFILES = {
  npm: 'package-lock.json',
  pnpm: 'pnpm-lock.yaml',
  yarn: 'yarn.lock',
} as const;
