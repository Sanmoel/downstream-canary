import { describe, expect, it } from 'vitest';
import { parseArguments } from '../../src/options.js';

describe('CLI trust-boundary flags', () => {
  it('parses an explicit local flag separately from path values', () => {
    const parsed = parseArguments([
      '--local',
      '--candidate-root',
      '.',
      '--consumers',
      'acme/tool@0123456789abcdef0123456789abcdef01234567',
    ]);
    expect(parsed.flags.has('local')).toBe(true);
    expect(parsed.values.get('candidate-root')).toBe('.');
  });
});
