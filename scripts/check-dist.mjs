import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const temporary = await mkdtemp(join(tmpdir(), 'downstream-canary-dist-'));
const expectedFiles = ['action.js', 'cli.js', 'demo.js', 'index.js'];
try {
  const build = spawnSync(process.execPath, ['scripts/build.mjs', temporary], {
    cwd: resolve('.'),
    encoding: 'utf8',
    shell: false,
  });
  if (build.status !== 0) {
    process.stderr.write(build.stderr || build.stdout);
    process.exitCode = 1;
  } else {
    const committedFiles = (await readdir(resolve('dist'))).sort();
    if (JSON.stringify(committedFiles) !== JSON.stringify(expectedFiles)) {
      throw new Error(
        `dist/ contains unexpected or missing files: ${committedFiles.join(', ')}.`,
      );
    }
    for (const file of expectedFiles) {
      const committed = await readFile(resolve('dist', file));
      const generated = await readFile(join(temporary, file));
      if (!committed.equals(generated)) {
        throw new Error(`dist/${file} does not match the source build.`);
      }
    }
    const cliMode = (await lstat(resolve('dist', 'cli.js'))).mode;
    if ((cliMode & 0o111) === 0) {
      throw new Error('dist/cli.js must be executable.');
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
