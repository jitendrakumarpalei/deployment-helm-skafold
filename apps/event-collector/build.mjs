import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outdir = path.join(__dirname, 'dist');

const entryPoints = [
  path.join(__dirname, 'src', 'index.ts'),
  path.join(__dirname, 'src', 'server.ts'),
  path.join(__dirname, 'src', 'db.ts'),
];

await build({
  entryPoints,
  outdir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node18'],
  sourcemap: false,
  splitting: false,
  packages: 'external',
});
