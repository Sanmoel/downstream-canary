import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectPackageManager,
  managerLockfileEnvironment,
} from '../../src/package-manager.js';
import { temporaryDirectory, writeProject } from '../helpers.js';

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function project(
  manifest: Record<string, unknown>,
  lockfiles: Record<string, string>,
  files: Record<string, string> = {},
): Promise<string> {
  const path = await temporaryDirectory();
  cleanups.push(path);
  await writeProject(path, manifest, lockfiles, files);
  return path;
}

describe('package-manager detection', () => {
  it('uses an exact packageManager declaration ahead of the pinned default', async () => {
    const path = await project(
      { packageManager: 'pnpm@11.20.0', scripts: { test: 'node test.js' } },
      { 'pnpm-lock.yaml': 'lockfileVersion: 9\n' },
    );
    const result = await detectPackageManager(path, '.');
    expect(result).toMatchObject({
      name: 'pnpm',
      declaredVersion: '11.20.0',
      requestedVersion: '11.20.0',
      lockfile: 'pnpm-lock.yaml',
    });
    expect(result.immutableInstallCommand).toContain('--frozen-lockfile');
  });

  it('uses the action-pinned npm default for one npm lockfile', async () => {
    const path = await project(
      { scripts: { test: 'node test.js' } },
      { 'package-lock.json': '{}' },
    );
    expect(await detectPackageManager(path, '.')).toMatchObject({
      name: 'npm',
      requestedVersion: '11.17.0',
    });
  });

  it('rejects conflicting metadata and lockfiles', async () => {
    const mismatch = await project(
      { packageManager: 'pnpm@11.21.0', scripts: { test: 'node test.js' } },
      { 'package-lock.json': '{}' },
    );
    await expect(detectPackageManager(mismatch, '.')).rejects.toThrow(/declares pnpm/);

    const multiple = await project(
      { scripts: { test: 'node test.js' } },
      { 'package-lock.json': '{}', 'yarn.lock': '' },
    );
    await expect(detectPackageManager(multiple, '.')).rejects.toThrow(/Multiple/);
  });

  it('rejects unsupported Yarn linker modes', async () => {
    const path = await project(
      { packageManager: 'yarn@4.18.0', scripts: { test: 'node test.js' } },
      { 'yarn.lock': '' },
      { '.yarnrc.yml': 'nodeLinker: pnp\n' },
    );
    await expect(detectPackageManager(path, '.')).rejects.toThrow(/node-modules/);
  });

  it('disables scripts explicitly during lockfile generation', () => {
    expect(managerLockfileEnvironment({ name: 'yarn' })).toMatchObject({
      npm_config_ignore_scripts: 'true',
      YARN_ENABLE_SCRIPTS: 'false',
      YARN_NPM_REGISTRY_SERVER: 'https://registry.npmjs.org',
    });
  });

  it('rejects workspace and credential-bearing package-manager configuration', async () => {
    const workspace = await project(
      { packageManager: 'pnpm@11.21.0', scripts: { test: 'node test.js' } },
      { 'pnpm-lock.yaml': 'lockfileVersion: 9\n' },
      { 'pnpm-workspace.yaml': 'packages:\n  - packages/*\n' },
    );
    await expect(detectPackageManager(workspace, '.')).rejects.toThrow(/workspace/);

    const yarnCredentials = await project(
      { packageManager: 'yarn@4.18.0', scripts: { test: 'node test.js' } },
      { 'yarn.lock': '' },
      {
        '.yarnrc.yml':
          'nodeLinker: node-modules\nnpmAuthToken: ${NPM_TOKEN}\n',
      },
    );
    await expect(detectPackageManager(yarnCredentials, '.')).rejects.toThrow(
      /Credential-bearing Yarn setting/,
    );
  });

  it('rejects install overrides that bypass the exact manager or frozen contract', async () => {
    const path = await project(
      { packageManager: 'npm@11.17.0', scripts: { test: 'node test.js' } },
      { 'package-lock.json': '{}' },
    );
    await expect(
      detectPackageManager(path, '.', { installCommand: ['npm', 'install'] }),
    ).rejects.toThrow(/must invoke corepack npm@11\.17\.0/);
    await expect(
      detectPackageManager(path, '.', {
        installCommand: ['corepack', 'npm@11.17.0', 'install'],
      }),
    ).rejects.toThrow(/frozen installation/);
  });

  it('rejects private, authenticated, and non-registry lockfile sources', async () => {
    const path = await project(
      { packageManager: 'npm@11.17.0', scripts: { test: 'node test.js' } },
      {
        'package-lock.json': JSON.stringify({
          lockfileVersion: 3,
          packages: {
            'node_modules/private': {
              resolved: 'https://packages.example.invalid/private.tgz',
            },
          },
        }),
      },
    );
    await expect(detectPackageManager(path, '.')).rejects.toThrow(
      /outside the public npm registry contract/,
    );
  });
});
