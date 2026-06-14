#!/usr/bin/env node
// Build the `myskills-mcp` binary and stage it where Tauri's `externalBin`
// expects a sidecar: src-tauri/binaries/myskills-mcp-<target-triple>[.exe].
//
// Tauri bundles that file into the app (signed, on macOS) and strips the triple
// suffix, so it lands next to the main executable (Contents/MacOS/myskills-mcp).
//
// Usage:
//   node scripts/build-mcp-sidecar.mjs                       # host triple
//   node scripts/build-mcp-sidecar.mjs universal-apple-darwin
//   node scripts/build-mcp-sidecar.mjs x86_64-pc-windows-msvc
//
// The triple may also come from $TAURI_ENV_TARGET_TRIPLE.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcTauri = join(repoRoot, 'src-tauri');
const manifest = join(srcTauri, 'Cargo.toml');
const outDir = join(srcTauri, 'binaries');

function run(cmd, args) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit' });
}

function hostTriple() {
  const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const m = out.match(/^host:\s*(.+)$/m);
  if (!m) throw new Error('could not determine host triple from `rustc -vV`');
  return m[1].trim();
}

function cargoBuild(target) {
  const args = ['build', '--release', '--bin', 'myskills-mcp', '--manifest-path', manifest];
  if (target) args.push('--target', target);
  run('cargo', args);
}

const triple = (process.env.TAURI_ENV_TARGET_TRIPLE || process.argv[2] || hostTriple()).trim();
const isWindows = triple.includes('windows');
const ext = isWindows ? '.exe' : '';
const dest = join(outDir, `myskills-mcp-${triple}${ext}`);
mkdirSync(outDir, { recursive: true });

if (triple === 'universal-apple-darwin') {
  // Build both arches and lipo them into one fat binary.
  const arches = ['aarch64-apple-darwin', 'x86_64-apple-darwin'];
  const built = arches.map((arch) => {
    cargoBuild(arch);
    return join(srcTauri, 'target', arch, 'release', 'myskills-mcp');
  });
  run('lipo', ['-create', '-output', dest, ...built]);
} else if (triple === hostTriple()) {
  // Host build — no explicit --target so it reuses the main target/ dir.
  cargoBuild(null);
  copyFileSync(join(srcTauri, 'target', 'release', `myskills-mcp${ext}`), dest);
} else {
  // Cross build for an explicit triple (the rustup target must be installed).
  cargoBuild(triple);
  copyFileSync(join(srcTauri, 'target', triple, 'release', `myskills-mcp${ext}`), dest);
}

console.log(`✓ staged MCP sidecar → ${dest}`);
