import { spawnSync } from 'node:child_process';
import process from 'node:process';

const commands = [
  ['npm', 'run', 'lint'],
  ['npm', 'run', 'typecheck'],
  ['npm', 'run', 'build'],
  ['npm', 'test'],
  ['npm', 'run', 'integration'],
  ['npm', 'run', 'action:smoke'],
  ['npm', 'run', 'check:dist'],
  ['npm', 'run', 'check:notices'],
];

for (const command of commands) {
  const result = spawnSync(command[0], command.slice(1), {
    stdio: 'inherit',
    shell: false,
    env: process.env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
