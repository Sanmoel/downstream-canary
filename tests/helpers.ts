import { gzipSync } from 'node:zlib';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function temporaryDirectory(prefix = 'downstream-canary-test-'): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

export interface TestTarEntry {
  readonly path: string;
  readonly body?: string | Buffer;
  readonly type?: '0' | '2' | '5';
  readonly linkPath?: string;
}

function octal(value: number, length: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(length - 1, '0')}\0`, 'ascii');
}

function tarEntry(entry: TestTarEntry): Buffer {
  const body = Buffer.isBuffer(entry.body)
    ? entry.body
    : Buffer.from(entry.body ?? '', 'utf8');
  const header = Buffer.alloc(512);
  header.write(entry.path, 0, 100, 'utf8');
  octal(entry.type === '5' ? 0o755 : 0o644, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(body.length, 12).copy(header, 124);
  octal(0, 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header.write(entry.type ?? '0', 156, 1, 'ascii');
  if (entry.linkPath) header.write(entry.linkPath, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  Buffer.from(`${checksum.toString(8).padStart(6, '0')}\0 `, 'ascii').copy(
    header,
    148,
  );
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}

export async function writeTarball(
  directory: string,
  entries: readonly TestTarEntry[],
  name = 'candidate.tgz',
): Promise<string> {
  const tar = Buffer.concat([
    ...entries.map(tarEntry),
    Buffer.alloc(1024),
  ]);
  const path = join(directory, name);
  await writeFile(path, gzipSync(tar));
  return path;
}

export async function writeProject(
  directory: string,
  manifest: Record<string, unknown>,
  lockfiles: Readonly<Record<string, string>>,
  files: Readonly<Record<string, string>> = {},
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(directory + '/package.json', `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [path, content] of Object.entries({ ...lockfiles, ...files })) {
    await mkdir(join(directory, path, '..'), { recursive: true });
    await writeFile(join(directory, path), content);
  }
}
