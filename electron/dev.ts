/**
 * Dev launcher: compile electron sources, then spawn Electron pointed at this repo.
 * `npm run dev:electron` waits for Next.js on tcp:4477 before invoking this.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import electronExec from 'electron';

const repoRoot = path.resolve(__dirname, '..');

function compile(): void {
  const tsc = require.resolve('typescript/lib/tsc.js');
  const result = spawnSync(process.execPath, [tsc, '-p', path.join(repoRoot, 'electron', 'tsconfig.json')], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function launch(): void {
  // `electron` npm package exports the binary path as default.
  const electronBin = electronExec as unknown as string;
  const child = spawn(electronBin, ['.'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development' },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

compile();
launch();
