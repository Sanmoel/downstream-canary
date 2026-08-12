import { build } from 'esbuild';
import { chmod, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const outputDirectory = resolve(process.argv[2] ?? 'dist');
await mkdir(outputDirectory, { recursive: true });

await Promise.all([
  build({
    entryPoints: ['src/cli.ts'],
    outfile: resolve(outputDirectory, 'cli.js'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    sourcemap: false,
    legalComments: 'none',
    alias: {
      yaml: resolve('node_modules/yaml/browser/index.js'),
      'jsonc-parser': resolve('node_modules/jsonc-parser/lib/esm/main.js'),
    },
  }),
  build({
    entryPoints: ['src/action.ts'],
    outfile: resolve(outputDirectory, 'action.js'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    sourcemap: false,
    legalComments: 'none',
    alias: {
      yaml: resolve('node_modules/yaml/browser/index.js'),
      'jsonc-parser': resolve('node_modules/jsonc-parser/lib/esm/main.js'),
    },
  }),
  build({
    entryPoints: ['src/index.ts'],
    outfile: resolve(outputDirectory, 'index.js'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    sourcemap: false,
    legalComments: 'none',
    alias: {
      yaml: resolve('node_modules/yaml/browser/index.js'),
      'jsonc-parser': resolve('node_modules/jsonc-parser/lib/esm/main.js'),
    },
  }),
  build({
    entryPoints: ['src/demo.ts'],
    outfile: resolve(outputDirectory, 'demo.js'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    sourcemap: false,
    legalComments: 'none',
    alias: {
      yaml: resolve('node_modules/yaml/browser/index.js'),
      'jsonc-parser': resolve('node_modules/jsonc-parser/lib/esm/main.js'),
    },
  }),
]);
await chmod(resolve(outputDirectory, 'cli.js'), 0o755);
