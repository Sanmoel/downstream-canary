import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConsumersInput, resolveRunConfig } from '../../src/config.js';
import { temporaryDirectory } from '../helpers.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('configuration validation', () => {
  it('parses one to ten pinned consumer references', () => {
    expect(parseConsumersInput(`acme/tool@${SHA}`)).toEqual([
      {
        repositoryUrl: 'https://github.com/acme/tool',
        commit: SHA,
        workingDirectory: '.',
      },
    ]);
  });

  it('loads command overrides only as arrays', async () => {
    const root = await temporaryDirectory();
    cleanups.push(root);
    await writeFile(
      `${root}/.downstream-canary.yml`,
      `version: 1\nconsumers:\n  - repository: acme/tool\n    commit: ${SHA}\n    testCommand: npm test\n`,
    );
    await expect(resolveRunConfig({ cwd: root })).rejects.toThrow(/array/);
  });

  it('rejects zero consumers and unknown configuration keys', async () => {
    const root = await temporaryDirectory();
    cleanups.push(root);
    await expect(resolveRunConfig({ cwd: root })).rejects.toThrow(/between 1 and 10/);
    await writeFile(
      `${root}/.downstream-canary.yml`,
      `version: 1\nunknown: true\nconsumers:\n  - acme/tool@${SHA}\n`,
    );
    await expect(resolveRunConfig({ cwd: root })).rejects.toThrow(/unsupported key/);
  });

  it('rejects invalid working-directory types instead of silently defaulting them', async () => {
    const root = await temporaryDirectory();
    cleanups.push(root);
    await writeFile(
      `${root}/.downstream-canary.yml`,
      `version: 1\ncandidate:\n  workingDirectory: 42\nconsumers:\n  - acme/tool@${SHA}\n`,
    );
    await expect(resolveRunConfig({ cwd: root })).rejects.toThrow(
      /candidate\.workingDirectory must be a string/,
    );
  });

  it('rejects nested consumer package roots in the single-package contract', async () => {
    const root = await temporaryDirectory();
    cleanups.push(root);
    await writeFile(
      `${root}/.downstream-canary.yml`,
      `version: 1\nconsumers:\n  - repository: acme/tool\n    commit: ${SHA}\n    workingDirectory: packages/tool\n`,
    );
    await expect(resolveRunConfig({ cwd: root })).rejects.toThrow(
      /Nested consumer package roots/,
    );
  });

  it('rejects command settings in configuration sections where they are not used', async () => {
    const root = await temporaryDirectory();
    cleanups.push(root);
    await writeFile(
      `${root}/.downstream-canary.yml`,
      `version: 1\ndefaults:\n  buildCommand: [npm, run, build]\nconsumers:\n  - acme/tool@${SHA}\n`,
    );
    await expect(resolveRunConfig({ cwd: root })).rejects.toThrow(
      /defaults\.buildCommand is unsupported/,
    );
  });

  it('rejects a symbolic-link report directory before any host write', async () => {
    const root = await temporaryDirectory();
    cleanups.push(root);
    await mkdir(`${root}/redirect-target`);
    await symlink('redirect-target', `${root}/.downstream-canary-results`);
    await expect(
      resolveRunConfig({ cwd: root, consumersText: `acme/tool@${SHA}` }),
    ).rejects.toThrow(/Output directory cannot contain symbolic-link/);
  });
});
