import { gunzipSync } from 'node:zlib';
import { posix } from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import {
  MAX_TARBALL_BYTES,
  MAX_TARBALL_ENTRIES,
  MAX_UNPACKED_TARBALL_BYTES,
} from './constants.js';
import { CanaryError } from './errors.js';
import type { CandidateArtifact } from './types.js';
import { sha256, sha256File } from './util/hash.js';

interface TarEntry {
  readonly path: string;
  readonly type: string;
  readonly linkPath: string;
  readonly mode: number;
  readonly body: Buffer;
}

function stringField(header: Buffer, start: number, length: number): string {
  const field = header.subarray(start, start + length);
  const zero = field.indexOf(0);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      field.subarray(0, zero === -1 ? field.length : zero),
    );
  } catch (error) {
    throw new CanaryError(
      'tooling',
      'configuration',
      'Candidate tarball contains an invalid UTF-8 header field.',
      { cause: error },
    );
  }
}

function octalField(header: Buffer, start: number, length: number): number {
  const field = header.subarray(start, start + length);
  if ((field[0] ?? 0) & 0x80) {
    throw new CanaryError(
      'tooling',
      'configuration',
      'Base-256 tar numeric fields are unsupported for candidate packages.',
    );
  }
  const value = field.toString('ascii').replace(/\0/g, '').trim();
  if (value === '') return 0;
  if (!/^[0-7]+$/.test(value)) {
    throw new CanaryError('tooling', 'configuration', 'Malformed tar numeric field.');
  }
  return Number.parseInt(value, 8);
}

function validateChecksum(header: Buffer): void {
  const expected = octalField(header, 148, 8);
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  let actual = 0;
  for (const byte of copy) actual += byte;
  if (expected !== actual) {
    throw new CanaryError('tooling', 'configuration', 'Candidate tarball has an invalid tar checksum.');
  }
}

function parsePax(body: Buffer): Map<string, string> {
  const values = new Map<string, string>();
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) {
      throw new CanaryError('tooling', 'configuration', 'Malformed PAX tar header.');
    }
    const lengthText = body.subarray(offset, space).toString('ascii');
    const length = Number.parseInt(lengthText, 10);
    if (
      !/^[1-9]\d*$/.test(lengthText) ||
      !Number.isSafeInteger(length) ||
      offset + length > body.length ||
      space >= offset + length - 1 ||
      body[offset + length - 1] !== 0x0a
    ) {
      throw new CanaryError('tooling', 'configuration', 'Malformed PAX record length.');
    }
    let record: string;
    try {
      record = new TextDecoder('utf-8', { fatal: true }).decode(
        body.subarray(space + 1, offset + length - 1),
      );
    } catch (error) {
      throw new CanaryError(
        'tooling',
        'configuration',
        'Malformed UTF-8 in a PAX tar header.',
        { cause: error },
      );
    }
    const equals = record.indexOf('=');
    if (equals <= 0) {
      throw new CanaryError('tooling', 'configuration', 'Malformed PAX record value.');
    }
    const key = record.slice(0, equals);
    if (values.has(key)) {
      throw new CanaryError(
        'tooling',
        'configuration',
        `Duplicate PAX tar key: ${key}.`,
      );
    }
    values.set(key, record.slice(equals + 1));
    offset += length;
  }
  return values;
}

function validatePaxKeys(values: ReadonlyMap<string, string>): void {
  const unsupported = [...values.keys()].filter(
    (key) => key !== 'path' && key !== 'linkpath',
  );
  if (unsupported.length > 0) {
    throw new CanaryError(
      'tooling',
      'configuration',
      `Unsupported PAX tar metadata: ${unsupported.join(', ')}.`,
    );
  }
}

function hasUnsafeControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

function validateMetadataPath(value: string): void {
  if (
    hasUnsafeControl(value) ||
    value.includes('\\') ||
    posix.isAbsolute(value) ||
    value.split('/').includes('..')
  ) {
    throw new CanaryError(
      'tooling',
      'configuration',
      `Unsafe tar metadata path: ${JSON.stringify(value)}.`,
    );
  }
}

function longHeaderField(body: Buffer, label: string): string {
  const zero = body.indexOf(0);
  const field = body.subarray(0, zero === -1 ? body.length : zero);
  try {
    return new TextDecoder('utf-8', { fatal: true })
      .decode(field)
      .replace(/\n$/, '');
  } catch (error) {
    throw new CanaryError(
      'tooling',
      'configuration',
      `Candidate tarball contains invalid UTF-8 in its GNU ${label} header.`,
      { cause: error },
    );
  }
}

function safeEntryPath(value: string): string {
  if (
    hasUnsafeControl(value) ||
    value.includes('\\') ||
    posix.isAbsolute(value)
  ) {
    throw new CanaryError('tooling', 'configuration', `Unsafe absolute tar path: ${JSON.stringify(value)}.`);
  }
  const components = value.split('/');
  if (components.includes('..')) {
    throw new CanaryError('tooling', 'configuration', `Tar path traversal rejected: ${JSON.stringify(value)}.`);
  }
  const normalized = posix.normalize(value).replace(/^\.\//, '').replace(/\/$/, '');
  if (normalized !== 'package' && !normalized.startsWith('package/')) {
    throw new CanaryError(
      'tooling',
      'configuration',
      `Candidate tar entry is outside package/: ${JSON.stringify(value)}.`,
    );
  }
  return normalized;
}

function validateLink(entryPath: string, linkPath: string): void {
  if (
    linkPath.length === 0 ||
    hasUnsafeControl(linkPath) ||
    linkPath.includes('\\') ||
    posix.isAbsolute(linkPath)
  ) {
    throw new CanaryError(
      'tooling',
      'configuration',
      `Unsafe tar link target: ${JSON.stringify(linkPath)}.`,
    );
  }
  const resolved = posix.normalize(posix.join(posix.dirname(entryPath), linkPath));
  if (resolved !== 'package' && !resolved.startsWith('package/')) {
    throw new CanaryError(
      'tooling',
      'configuration',
      `Tar link escapes package/: ${entryPath} -> ${linkPath}.`,
    );
  }
}

function parseTar(archive: Buffer): readonly TarEntry[] {
  if (archive.length % 512 !== 0) {
    throw new CanaryError(
      'tooling',
      'configuration',
      'Candidate tarball length is not aligned to a tar block.',
    );
  }
  const entries: TarEntry[] = [];
  let offset = 0;
  let headerCount = 0;
  let sawEnd = false;
  let nextPax = new Map<string, string>();
  let globalPax = new Map<string, string>();
  let longName: string | undefined;
  let longLink: string | undefined;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (
        offset + 1024 > archive.length ||
        !archive.subarray(offset).every((byte) => byte === 0)
      ) {
        throw new CanaryError(
          'tooling',
          'configuration',
          'Candidate tarball has malformed end-of-archive blocks.',
        );
      }
      sawEnd = true;
      break;
    }
    const magic = header.subarray(257, 263).toString('ascii');
    if (magic !== 'ustar\0' && magic !== 'ustar ') {
      throw new CanaryError(
        'tooling',
        'configuration',
        'Candidate tarball entry is not in the supported USTAR format.',
      );
    }
    headerCount += 1;
    if (headerCount > MAX_TARBALL_ENTRIES) {
      throw new CanaryError(
        'tooling',
        'configuration',
        `Candidate tarball exceeds the ${MAX_TARBALL_ENTRIES}-entry limit.`,
      );
    }
    validateChecksum(header);
    const size = octalField(header, 124, 12);
    const mode = octalField(header, 100, 8) & 0o777;
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (!Number.isSafeInteger(size) || bodyEnd > archive.length) {
      throw new CanaryError('tooling', 'configuration', 'Truncated candidate tarball entry.');
    }
    const body = archive.subarray(bodyStart, bodyEnd);
    const type = String.fromCharCode(header[156] ?? 0) || '0';
    const rawName = stringField(header, 0, 100);
    const prefix = stringField(header, 345, 155);
    const headerPath = prefix ? `${prefix}/${rawName}` : rawName;
    const headerLink = stringField(header, 157, 100);

    if (type === 'x') {
      validateMetadataPath(headerPath);
      nextPax = parsePax(body);
      validatePaxKeys(nextPax);
    } else if (type === 'g') {
      validateMetadataPath(headerPath);
      const parsedGlobalPax = parsePax(body);
      validatePaxKeys(parsedGlobalPax);
      globalPax = new Map([...globalPax, ...parsedGlobalPax]);
    } else if (type === 'L') {
      validateMetadataPath(headerPath);
      longName = longHeaderField(body, 'long-name');
    } else if (type === 'K') {
      validateMetadataPath(headerPath);
      longLink = longHeaderField(body, 'long-link');
    } else {
      const path = globalPax.get('path') ?? nextPax.get('path') ?? longName ?? headerPath;
      const linkPath =
        globalPax.get('linkpath') ?? nextPax.get('linkpath') ?? longLink ?? headerLink;
      entries.push({ path, type, linkPath, mode, body });
      nextPax = new Map();
      longName = undefined;
      longLink = undefined;
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  if (entries.length === 0) {
    throw new CanaryError('tooling', 'configuration', 'Candidate tarball contains no files.');
  }
  if (!sawEnd || nextPax.size > 0 || longName !== undefined || longLink !== undefined) {
    throw new CanaryError(
      'tooling',
      'configuration',
      'Candidate tarball is missing a complete end-of-archive marker.',
    );
  }
  return entries;
}

export interface ValidateTarballOptions {
  readonly expectedName: string;
  readonly expectedVersion: string;
}

export async function validateCandidateTarball(
  tarballPath: string,
  options: ValidateTarballOptions,
): Promise<CandidateArtifact> {
  const metadata = await lstat(tarballPath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > MAX_TARBALL_BYTES
  ) {
    throw new CanaryError(
      'tooling',
      'configuration',
      `Candidate tarball must be a regular file no larger than ${MAX_TARBALL_BYTES} bytes.`,
    );
  }
  const compressed = await readFile(tarballPath);
  let archive: Buffer;
  try {
    archive = gunzipSync(compressed, {
      maxOutputLength: MAX_UNPACKED_TARBALL_BYTES,
    });
  } catch (error) {
    throw new CanaryError(
      'tooling',
      'configuration',
      'Candidate package is not a valid gzip-compressed tarball.',
      { cause: error },
    );
  }

  const entries = parseTar(archive);
  const contents = new Set<string>();
  const packageFileHashes = Object.create(null) as Record<string, string>;
  const packageFileModes = Object.create(null) as Record<string, number>;
  const packageLinks = Object.create(null) as Record<string, string>;
  let packageJson: Buffer | undefined;
  for (const entry of entries) {
    const path = safeEntryPath(entry.path);
    if (contents.has(path)) {
      throw new CanaryError(
        'tooling',
        'configuration',
        `Candidate tarball contains duplicate entry: ${path}.`,
      );
    }
    if (path === 'package' && entry.type !== '5') {
      throw new CanaryError(
        'tooling',
        'configuration',
        'The package/ archive root must be a directory.',
      );
    }
    if (entry.type === '1') {
      throw new CanaryError(
        'tooling',
        'configuration',
        `Hard-link tar entries are unsupported: ${path}.`,
      );
    }
    if (entry.type === '2') validateLink(path, entry.linkPath);
    if (entry.type === '0' || entry.type === '\0' || entry.type === '') {
      contents.add(path);
      packageFileHashes[path.slice('package/'.length)] = sha256(entry.body);
      packageFileModes[path.slice('package/'.length)] = entry.mode;
      if (path === 'package/package.json') packageJson = entry.body;
    } else if (entry.type === '2') {
      contents.add(path);
      packageLinks[path.slice('package/'.length)] = entry.linkPath;
    } else if (entry.type === '5') {
      contents.add(path);
    } else {
      throw new CanaryError(
        'tooling',
        'configuration',
        `Unsupported tar entry type ${JSON.stringify(entry.type)} at ${path}.`,
      );
    }
  }
  if (!packageJson) {
    throw new CanaryError(
      'tooling',
      'configuration',
      'Candidate tarball must contain package/package.json.',
    );
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(packageJson.toString('utf8')) as unknown;
  } catch (error) {
    throw new CanaryError(
      'tooling',
      'configuration',
      'Candidate package/package.json is malformed.',
      { cause: error },
    );
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new CanaryError(
      'tooling',
      'configuration',
      'Candidate package/package.json must contain a JSON object.',
    );
  }
  const record = manifest as { readonly name?: unknown; readonly version?: unknown };
  if (record.name !== options.expectedName || record.version !== options.expectedVersion) {
    throw new CanaryError(
      'tooling',
      'configuration',
      `Candidate tarball identity ${String(record.name)}@${String(record.version)} does not match ${options.expectedName}@${options.expectedVersion}.`,
    );
  }
  return {
    tarballPath,
    fileName: tarballPath.split(/[\\/]/).at(-1) ?? 'candidate.tgz',
    packageName: options.expectedName,
    packageVersion: options.expectedVersion,
    sha256: await sha256File(tarballPath),
    packageJsonSha256: sha256(packageJson),
    contents: [...contents].sort(),
    packageFileHashes,
    packageFileModes,
    packageLinks,
  };
}
