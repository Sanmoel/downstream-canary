import { describe, expect, it } from 'vitest';
import {
  validateCommandArray,
  validateFullCommitSha,
  validatePackageVersion,
  validatePublicGitHubUrl,
  validateSafePackageName,
} from '../../src/validation.js';

describe('configuration primitives', () => {
  it('accepts only lowercase full commit SHAs', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    expect(validateFullCommitSha(sha)).toBe(sha);
    for (const invalid of ['main', sha.slice(0, 39), sha.toUpperCase(), `${sha}0`]) {
      expect(() => validateFullCommitSha(invalid)).toThrow(/40-character SHA/);
    }
  });

  it('accepts only anonymous public HTTPS GitHub repository URLs', () => {
    expect(validatePublicGitHubUrl('https://github.com/acme/example.git')).toBe(
      'https://github.com/acme/example',
    );
    for (const invalid of [
      'http://github.com/acme/example',
      'git@github.com:acme/example.git',
      'https://token@github.com/acme/example',
      'https://gitlab.com/acme/example',
      'https://github.com/acme/example/issues',
    ]) {
      expect(() => validatePublicGitHubUrl(invalid)).toThrow();
    }
  });

  it('rejects shell command strings and empty arguments', () => {
    expect(validateCommandArray(['npm', 'test'], 'test')).toEqual(['npm', 'test']);
    expect(validateCommandArray(['bash', './test.sh'], 'test')).toEqual([
      'bash',
      './test.sh',
    ]);
    expect(() => validateCommandArray('npm test', 'test')).toThrow(/argument/);
    expect(() => validateCommandArray(['npm', ''], 'test')).toThrow(/argument/);
    expect(() => validateCommandArray(['sh', '-c', 'npm test'], 'test')).toThrow(
      /shell command-string mode/,
    );
  });

  it('accepts ordinary and scoped package names but rejects path-like names', () => {
    expect(validateSafePackageName('tiny-parser')).toBe('tiny-parser');
    expect(validateSafePackageName('@acme/tiny-parser')).toBe('@acme/tiny-parser');
    for (const invalid of [
      '../escape',
      '@acme/../escape',
      '/absolute',
      'a/b',
      'Bad-Name',
      'bad`name',
    ]) {
      expect(() => validateSafePackageName(invalid)).toThrow(/safe npm package path/);
    }
  });

  it('requires an exact semantic candidate package version', () => {
    expect(validatePackageVersion('1.2.3-beta.1+build.7')).toBe(
      '1.2.3-beta.1+build.7',
    );
    for (const invalid of ['v1.2.3', '1.2', '01.2.3', 'latest', '1.2.3`bad']) {
      expect(() => validatePackageVersion(invalid)).toThrow(/exact semantic version/);
    }
  });
});
