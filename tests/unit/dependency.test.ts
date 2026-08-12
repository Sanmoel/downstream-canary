import { describe, expect, it } from 'vitest';
import { planDependencyPatch } from '../../src/dependency.js';

describe('dependency patch planning', () => {
  it.each(['dependencies', 'devDependencies', 'optionalDependencies'] as const)(
    'plans a single direct %s patch',
    (field) => {
      expect(
        planDependencyPatch(
          { [field]: { 'tiny-parser': '^1.0.0' } },
          'tiny-parser',
          'file:.downstream-canary/candidate.tgz',
        ),
      ).toEqual({
        packageName: 'tiny-parser',
        field,
        oldSpecifier: '^1.0.0',
        newSpecifier: 'file:.downstream-canary/candidate.tgz',
      });
    },
  );

  it.each([
    [{ peerDependencies: { lib: '^1' } }, /Peer-only/],
    [{ dependencies: { lib: 'npm:other@1' } }, /aliases/],
    [{ dependencies: { lib: 'workspace:*' } }, /Workspace/],
    [{ dependencies: { lib: 'link:../lib' } }, /Workspace/],
    [{ dependencies: { lib: 'file:../lib' } }, /Directory/],
    [{ dependencies: { lib: 'file:../../lib.tgz' } }, /escaping file/],
    [{ dependencies: { lib: 'portal:../lib' } }, /protocol/],
    [{ dependencies: { lib: 'owner/repository' } }, /Git shorthand/],
    [{ dependencies: { other: '^1' } }, /transitive-only/],
  ] as const)('rejects an unsupported dependency type', (manifest, message) => {
    expect(() =>
      planDependencyPatch(manifest, 'lib', 'file:.downstream-canary/candidate.tgz'),
    ).toThrow(message);
  });
});
