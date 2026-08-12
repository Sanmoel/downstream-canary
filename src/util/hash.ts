import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function sha256(data: string | NodeJS.ArrayBufferView): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function sha256File(path: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}
