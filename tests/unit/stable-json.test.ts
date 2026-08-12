import { describe, expect, it } from 'vitest';
import { stableStringify } from '../../src/util/stable-json.js';

describe('stable JSON serialization', () => {
  it('sorts object keys recursively without reordering arrays', () => {
    const first = stableStringify({ z: 1, a: { y: 2, b: 3 }, list: [{ d: 4, c: 5 }] });
    const second = stableStringify({ list: [{ c: 5, d: 4 }], a: { b: 3, y: 2 }, z: 1 });
    expect(first).toBe(second);
    expect(first.indexOf('"a"')).toBeLessThan(first.indexOf('"list"'));
    expect(first.endsWith('\n')).toBe(true);
  });

  it('serializes prototype-like keys as ordinary JSON data', () => {
    const value = JSON.parse('{"__proto__":{"polluted":true},"constructor":"safe"}') as unknown;
    expect(JSON.parse(stableStringify(value))).toEqual(value);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
