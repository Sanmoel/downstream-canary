import { gzipSync } from 'node:zlib';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DockerRunner } from '../src/docker.js';
import { runProcess, safeHostEnvironment } from '../src/process.js';
import {
  FIXTURE_LOCAL_PATH,
  type CandidateConfig,
  type CommandArray,
  type ConsumerSpec,
  type PackageManagerName,
} from '../src/types.js';
import {
  DEFAULT_PACKAGE_MANAGER_VERSIONS,
  RUNNER_IMAGE,
} from '../src/constants.js';
import { managerLockfileEnvironment } from '../src/package-manager.js';

export type FixtureExpectation =
  | 'compatible'
  | 'regression'
  | 'preexisting'
  | 'improvement'
  | 'security'
  | 'injection-failure';

export interface FixtureRepository {
  readonly path: string;
  readonly commit: string;
  readonly consumer: ConsumerSpec;
}

export interface FixtureWorld {
  readonly root: string;
  readonly candidateBreaking: CandidateConfig;
  readonly candidateCompatible: CandidateConfig;
  readonly consumers: Readonly<Record<string, FixtureRepository>>;
}

function tarHeader(path: string, body: Buffer): Buffer {
  const header = Buffer.alloc(512);
  const octal = (value: number, length: number): Buffer =>
    Buffer.from(`${value.toString(8).padStart(length - 1, '0')}\0`, 'ascii');
  header.write(path, 0, 100, 'utf8');
  octal(0o644, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(body.length, 12).copy(header, 124);
  octal(0, 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  Buffer.from(`${checksum.toString(8).padStart(6, '0')}\0 `, 'ascii').copy(header, 148);
  return Buffer.concat([
    header,
    body,
    Buffer.alloc((512 - (body.length % 512)) % 512),
  ]);
}

function baselineTarball(): Buffer {
  const manifest = Buffer.from(
    `${JSON.stringify({ name: 'tiny-parser', version: '1.0.0', main: 'index.cjs' }, null, 2)}\n`,
  );
  const implementation = Buffer.from(
    "exports.parse = value => ({ value });\n",
  );
  const tar = Buffer.concat([
    tarHeader('package/package.json', manifest),
    tarHeader('package/index.cjs', implementation),
    Buffer.alloc(1024),
  ]);
  return gzipSync(tar);
}

function candidateManifest(): Record<string, unknown> {
  return {
    name: 'tiny-parser',
    version: '1.0.0',
    private: true,
    main: 'index.cjs',
    packageManager: `npm@${DEFAULT_PACKAGE_MANAGER_VERSIONS.npm}`,
    scripts: { test: 'node test.cjs' },
  };
}

function npmLock(manifest: Record<string, unknown>): string {
  return `${JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: manifest.name,
          version: manifest.version,
        },
      },
    },
    null,
    2,
  )}\n`;
}

async function createCandidate(
  root: string,
  name: string,
  compatible: boolean,
): Promise<CandidateConfig> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  const manifest = candidateManifest();
  await writeFile(join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(directory, 'package-lock.json'), npmLock(manifest));
  await writeFile(
    join(directory, 'index.cjs'),
    compatible
      ? "exports.parse = value => ({ value });\n"
      : "exports.parse = value => ({ text: value });\n",
  );
  await writeFile(
    join(directory, 'test.cjs'),
    compatible
      ? "const assert=require('node:assert/strict');assert.deepEqual(require('./').parse('ok'),{value:'ok'});console.log('candidate library tests: pass');\n"
      : "const assert=require('node:assert/strict');assert.deepEqual(require('./').parse('ok'),{text:'ok'});console.log('candidate library tests: pass');\n",
  );
  return { root: directory, workingDirectory: '.' };
}

function testSource(expectation: FixtureExpectation): string {
  switch (expectation) {
    case 'compatible':
    case 'regression':
      return "const assert=require('node:assert/strict');assert.deepEqual(require('tiny-parser').parse('hello'),{value:'hello'});console.log('downstream test: pass');\n";
    case 'preexisting':
      return "const assert=require('node:assert/strict');assert.deepEqual(require('tiny-parser').parse('hello'),{missing:'hello'});\n";
    case 'improvement':
      return "const assert=require('node:assert/strict');assert.deepEqual(require('tiny-parser').parse('hello'),{text:'hello'});console.log('candidate-only downstream test: pass');\n";
    case 'security':
      return `
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
for (const [name,value] of Object.entries(process.env)) {
  assert.doesNotMatch(name, /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH/i);
  assert.notEqual(value, 'downstream-canary-secret-sentinel');
}
const parsed=require('tiny-parser').parse('hello');
assert.equal(parsed.value ?? parsed.text, 'hello');
assert.throws(()=>fs.writeFileSync('/downstream-canary-forbidden','bad'));
assert.throws(()=>fs.writeFileSync('/corepack-home/tampered','bad'));
const request=http.get({host:'1.1.1.1',port:80,path:'/',timeout:1000},()=>{throw new Error('network unexpectedly available')});
request.on('error',()=>{console.log('secret, network, and filesystem controls: pass')});
request.on('timeout',()=>request.destroy(new Error('network timeout is isolated')));
`;
    case 'injection-failure':
      return "console.log('no candidate dependency');\n";
  }
}

function lockfileGenerationCommand(manager: PackageManagerName): CommandArray {
  const version = DEFAULT_PACKAGE_MANAGER_VERSIONS[manager];
  if (manager === 'npm') {
    return [
      'corepack',
      `npm@${version}`,
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ];
  }
  if (manager === 'pnpm') {
    return [
      'corepack',
      `pnpm@${version}`,
      'install',
      '--lockfile-only',
      '--ignore-scripts',
    ];
  }
  return [
    'corepack',
    `yarn@${version}`,
    'install',
    '--mode=update-lockfile',
  ];
}

async function commitRepository(directory: string): Promise<string> {
  const environment = safeHostEnvironment({
    GIT_AUTHOR_NAME: 'Downstream Canary Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Downstream Canary Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  });
  for (const command of [
    ['git', 'init', '--quiet', '--initial-branch=main'],
    ['git', 'add', '--all'],
    ['git', 'commit', '--quiet', '-m', 'fixture'],
  ] as CommandArray[]) {
    const result = await runProcess(command, { cwd: directory, environment, timeoutMs: 30_000 });
    if (result.exitCode !== 0) throw new Error(result.output);
  }
  const result = await runProcess(['git', 'rev-parse', 'HEAD'], {
    cwd: directory,
    environment,
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) throw new Error(result.output);
  return result.stdout.trim();
}

async function createConsumer(
  root: string,
  docker: DockerRunner,
  id: string,
  manager: PackageManagerName,
  expectation: FixtureExpectation,
): Promise<FixtureRepository> {
  const directory = join(root, id);
  await mkdir(join(directory, 'vendor'), { recursive: true });
  await writeFile(join(directory, 'vendor', 'tiny-parser-1.0.0.tgz'), baselineTarball());
  const manifest: Record<string, unknown> = {
    name: id,
    version: '1.0.0',
    private: true,
    packageManager: `${manager}@${DEFAULT_PACKAGE_MANAGER_VERSIONS[manager]}`,
    scripts: { test: 'node test.cjs' },
  };
  if (expectation !== 'injection-failure') {
    manifest.dependencies = { 'tiny-parser': 'file:vendor/tiny-parser-1.0.0.tgz' };
  }
  await writeFile(join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(directory, 'test.cjs'), testSource(expectation));
  if (manager === 'yarn') {
    await writeFile(join(directory, '.yarnrc.yml'), 'nodeLinker: node-modules\n');
    await writeFile(join(directory, '.gitignore'), '.yarn/install-state.gz\nnode_modules/\n');
  }
  const result = await docker.run({
    workspace: directory,
    cacheDirectory: join(root, `${id}-lock-cache`),
    command: lockfileGenerationCommand(manager),
    timeoutSeconds: 180,
    network: 'bridge',
    phase: `${id}-fixture-lock`,
    extraEnvironment: managerLockfileEnvironment({ name: manager }),
  });
  if (result.exitCode !== 0) {
    throw new Error(`Unable to create ${id} lockfile: ${result.output}`);
  }
  const commit = await commitRepository(directory);
  return {
    path: directory,
    commit,
    consumer: {
      repositoryUrl: `https://github.com/downstream-canary-fixtures/${id}`,
      commit,
      workingDirectory: '.',
      [FIXTURE_LOCAL_PATH]: directory,
    },
  };
}

export async function createFixtureWorld(
  dockerExecutable = 'docker',
): Promise<FixtureWorld> {
  const root = await mkdtemp(join(tmpdir(), 'downstream-canary-fixtures-'));
  const docker = new DockerRunner(dockerExecutable, RUNNER_IMAGE);
  try {
    await docker.ensureReady();
    const candidateBreaking = await createCandidate(root, 'candidate-breaking', false);
    const candidateCompatible = await createCandidate(root, 'candidate-compatible', true);
    const definitions: readonly [string, PackageManagerName, FixtureExpectation][] = [
      ['npm-compatible', 'npm', 'compatible'],
      ['npm-regression', 'npm', 'regression'],
      ['pnpm-compatible', 'pnpm', 'compatible'],
      ['pnpm-regression', 'pnpm', 'regression'],
      ['yarn-compatible', 'yarn', 'compatible'],
      ['yarn-regression', 'yarn', 'regression'],
      ['npm-preexisting', 'npm', 'preexisting'],
      ['npm-improvement', 'npm', 'improvement'],
      ['npm-security', 'npm', 'security'],
      ['npm-injection-failure', 'npm', 'injection-failure'],
    ];
    const consumers: Record<string, FixtureRepository> = {};
    for (const [id, manager, expectation] of definitions) {
      consumers[id] = await createConsumer(root, docker, id, manager, expectation);
    }
    return { root, candidateBreaking, candidateCompatible, consumers };
  } catch (error) {
    await import('node:fs/promises').then(({ rm }) =>
      rm(root, { recursive: true, force: true }),
    );
    throw error;
  } finally {
    await docker.dispose();
  }
}
