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
mkdirSync(outDir, { recursive: true });

function stage(targetTriple) {
  const isWindows = targetTriple.includes('windows');
  const ext = isWindows ? '.exe' : '';
  const dest = join(outDir, `myskills-mcp-${targetTriple}${ext}`);
  if (targetTriple === hostTriple()) {
    // Host build — no explicit --target so it reuses the main target/ dir.
    cargoBuild(null);
    copyFileSync(join(srcTauri, 'target', 'release', `myskills-mcp${ext}`), dest);
  } else {
    // Cross build for an explicit triple (the rustup target must be installed).
    cargoBuild(targetTriple);
    copyFileSync(join(srcTauri, 'target', targetTriple, 'release', `myskills-mcp${ext}`), dest);
  }
  console.log(`✓ staged MCP sidecar → ${dest}`);
}

if (triple === 'universal-apple-darwin') {
  // Universal builds are finicky (tauri-apps/tauri#8152). Tauri needs the
  // sidecar in three places:
  //   1. binaries/myskills-mcp-<arch>      — tauri-build's per-arch externalBin
  //      existence check (TAURI_ENV_TARGET_TRIPLE is the per-arch triple).
  //   2. target/<arch>/release/myskills-mcp — Tauri lipo's these two into
  //      target/universal-apple-darwin/release/myskills-mcp itself, mirroring
  //      how it lipo's the main binary. So both arches MUST be built with an
  //      explicit --target (NOT a host-default build into target/release).
  //   3. binaries/myskills-mcp-universal-apple-darwin — the bundler's copy.
  const arches = ['aarch64-apple-darwin', 'x86_64-apple-darwin'];
  const archBins = [];
  for (const arch of arches) {
    cargoBuild(arch);
    const built = join(srcTauri, 'target', arch, 'release', 'myskills-mcp');
    archBins.push(built);
    copyFileSync(built, join(outDir, `myskills-mcp-${arch}`));
  }
  // The bundler copies the universal externalBin from the universal target's
  // release dir (it does NOT lipo it for us — tauri-apps/tauri#8152). Create it
  // there ourselves, plus binaries/...-universal-apple-darwin for good measure.
  const universalTargetDir = join(srcTauri, 'target', 'universal-apple-darwin', 'release');
  mkdirSync(universalTargetDir, { recursive: true });
  run('lipo', ['-create', '-output', join(universalTargetDir, 'myskills-mcp'), ...archBins]);
  run('lipo', [
    '-create',
    '-output',
    join(outDir, 'myskills-mcp-universal-apple-darwin'),
    ...archBins,
  ]);
  console.log(`✓ staged MCP sidecars (per-arch + universal in binaries/ and target/)`);
} else {
  stage(triple);
}
