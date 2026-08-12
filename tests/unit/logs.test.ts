import { describe, expect, it } from 'vitest';
import { redactSecrets, truncateUtf8 } from '../../src/util/logs.js';

describe('bounded diagnostics', () => {
  it('redacts secret environment values and inline credentials', () => {
    const secret = 'super-secret-value-123';
    const redacted = redactSecrets(
      `value=${secret}\ntoken=visible\nAuthorization: Bearer generic-value\n\u001b[31mred\u001b[0m\u0000github_pat_abcdefghijklmnopqrstuvwxyz123456`,
      [secret],
    );
    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain('visible');
    expect(redacted).not.toContain('generic-value');
    expect(redacted).not.toContain('github_pat_');
    expect(redacted).not.toContain('\u001b');
    expect(redacted).toContain('\\x00');
    expect(redacted).toContain('[REDACTED]');
  });

  it('truncates logs to a strict UTF-8 byte bound while retaining both ends', () => {
    const result = truncateUtf8(`start-${'界'.repeat(10_000)}-end`, 200);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(200);
    expect(result).toContain('start-');
    expect(result).toContain('-end');
    expect(result).toContain('truncated');
    expect(result).not.toContain('�');
  });
});
