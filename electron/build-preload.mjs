// Bundle electron/preload.ts into a single CJS file with no external imports
// (other than `electron`). This lets us run the window with `sandbox: true`,
// which otherwise blocks preload from `require`-ing relative siblings.
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

await esbuild.build({
  entryPoints: [path.join(repoRoot, 'electron', 'preload.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron'],
  outfile: path.join(repoRoot, 'dist-electron', 'electron', 'preload.js'),
  logLevel: 'info',
  sourcemap: false,
});
