import { spawn } from 'node:child_process';
import process from 'node:process';
import { delimiter, isAbsolute } from 'node:path';
import { MAX_PROCESS_OUTPUT_BYTES } from './constants.js';
import {
  redactSecrets,
  secretValuesFromEnvironment,
  truncateUtf8,
} from './util/logs.js';
import type { CommandArray, ProcessResult } from './types.js';

export interface RunProcessOptions {
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maximumOutputBytes?: number;
}

export function safeHostEnvironment(
  additions: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const safePath = (process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin')
    .split(delimiter)
    .filter((component) => component.length > 0 && isAbsolute(component))
    .join(delimiter);
  const environment: Record<string, string> = {
    PATH: safePath || '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
    ...additions,
  };
  if (process.env.SystemRoot) environment.SystemRoot = process.env.SystemRoot;
  return environment;
}

function killProcessTree(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === 'win32') process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    // The process may have exited between the timer and the signal.
  }
}

export async function runProcess(
  command: CommandArray,
  options: RunProcessOptions = {},
): Promise<ProcessResult> {
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? 0;
  const maximumOutputBytes =
    options.maximumOutputBytes ?? MAX_PROCESS_OUTPUT_BYTES;
  const secretValues = [
    ...new Set([
      ...secretValuesFromEnvironment(),
      ...secretValuesFromEnvironment(options.environment),
    ]),
  ].sort((left, right) => right.length - left.length);

  return await new Promise<ProcessResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let observedOutputBytes = 0;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const child = spawn(command[0], command.slice(1), {
      cwd: options.cwd,
      env: options.environment ?? safeHostEnvironment(),
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      observedOutputBytes += Buffer.byteLength(chunk);
      stdout = truncateUtf8(stdout + chunk, maximumOutputBytes);
    });
    child.stderr.on('data', (chunk: string) => {
      observedOutputBytes += Buffer.byteLength(chunk);
      stderr = truncateUtf8(stderr + chunk, maximumOutputBytes);
    });

    const timeout =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killProcessTree(child.pid ?? 0, 'SIGTERM');
            forceKillTimer = setTimeout(() => {
              killProcessTree(child.pid ?? 0, 'SIGKILL');
            }, 750);
            forceKillTimer.unref();
          }, timeoutMs)
        : undefined;
    timeout?.unref();

    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      spawnError?: Error,
    ): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (spawnError) stderr = `${stderr}\n${spawnError.message}`;
      const redactedStdout = truncateUtf8(
        redactSecrets(stdout, secretValues),
        maximumOutputBytes,
      );
      const redactedStderr = truncateUtf8(
        redactSecrets(stderr, secretValues),
        maximumOutputBytes,
      );
      const output = truncateUtf8(
        [redactedStdout, redactedStderr].filter(Boolean).join('\n'),
        maximumOutputBytes,
      );
      resolve({
        command,
        exitCode,
        signal,
        stdout: redactedStdout,
        stderr: redactedStderr,
        output,
        durationMs: Math.round(performance.now() - started),
        timedOut,
        truncated: observedOutputBytes > maximumOutputBytes,
      });
    };

    child.once('error', (error) => finish(null, null, error));
    child.once('close', (code, signal) => finish(code, signal));
  });
}
