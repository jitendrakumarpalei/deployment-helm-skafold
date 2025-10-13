import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outdir = path.join(__dirname, 'dist');

const commonOptions = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node18'],
  sourcemap: false,
  external: [],
};

await build({
  entryPoints: [path.join(__dirname, 'src', 'server.ts')],
  outfile: path.join(outdir, 'server.js'),
  ...commonOptions,
});
