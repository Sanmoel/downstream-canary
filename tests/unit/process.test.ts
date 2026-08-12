import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcess } from '../../src/process.js';
import { temporaryDirectory } from '../helpers.js';

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('process controls', () => {
  it('times out and terminates the complete process group', async () => {
    const directory = await temporaryDirectory();
    cleanups.push(directory);
    const marker = join(directory, 'grandchild-survived');
    const script = `
      const {spawn}=require('node:child_process');
      spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad'),700)`) }],{stdio:'ignore'});
      setInterval(()=>{},1000);
    `;
    const result = await runProcess([process.execPath, '-e', script], {
      timeoutMs: 100,
      maximumOutputBytes: 1024,
    });
    expect(result.timedOut).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 900));
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('bounds captured subprocess output', async () => {
    const result = await runProcess(
      [process.execPath, '-e', "process.stdout.write('x'.repeat(10000))"],
      { maximumOutputBytes: 256 },
    );
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(256);
  });
});
