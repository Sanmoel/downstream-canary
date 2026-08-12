import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const temporary = await mkdtemp(join(tmpdir(), 'downstream-canary-action-smoke-'));
try {
  const output = join(temporary, 'output');
  const summary = join(temporary, 'summary');
  const workspace = join(temporary, 'workspace');
  await mkdir(workspace);
  await writeFile(output, '');
  await writeFile(summary, '');
  await writeFile(
    join(workspace, '.downstream-canary.yml'),
    'version: 1\nconsumers:\n  - invalid-without-a-full-sha\n',
  );
  const result = spawnSync(process.execPath, [resolve('dist/action.js')], {
    cwd: resolve('.'),
    encoding: 'utf8',
    shell: false,
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      GITHUB_WORKSPACE: workspace,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      'INPUT_CANDIDATE-ROOT': '.',
      'INPUT_OUTPUT-DIRECTORY': join(temporary, 'reports'),
      'INPUT_TIMEOUT-SECONDS': '60',
    },
  });
  if (result.status !== 2) {
    throw new Error(`Action entry point returned ${result.status}; expected configuration exit 2.\n${result.stdout}\n${result.stderr}`);
  }
  if (!result.stderr.includes('::error::') || !result.stderr.includes('FULL_SHA')) {
    throw new Error(`Action entry point did not emit a GitHub error command.\n${result.stderr}`);
  }
  if ((await readFile(output, 'utf8')) !== '' || (await readFile(summary, 'utf8')) !== '') {
    throw new Error('Failing Action smoke test unexpectedly wrote outputs or a summary.');
  }
  process.stdout.write('Action entry-point smoke test: pass (expected configuration exit 2)\n');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
