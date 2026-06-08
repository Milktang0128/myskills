#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

function readPackageVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return String(pkg.version);
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return [full];
  });
}

function normalizeArch(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.includes('aarch64') || lower.includes('arm64')) return 'aarch64';
  if (lower.includes('x86_64') || lower.includes('x64') || lower.includes('amd64')) return 'x86_64';
  return process.env.RUNNER_ARCH === 'ARM64' ? 'aarch64' : 'x86_64';
}

function platformKey(filePath) {
  const name = path.basename(filePath);
  const lower = name.toLowerCase();
  const arch = normalizeArch(filePath);

  if (lower.endsWith('.app.tar.gz')) return `darwin-${arch}-app`;
  if (lower.endsWith('.appimage')) return `linux-${arch}-appimage`;
  if (lower.endsWith('.deb')) return `linux-${arch}-deb`;
  if (lower.endsWith('.rpm')) return `linux-${arch}-rpm`;
  if (lower.endsWith('.msi')) return `windows-${arch}-msi`;
  if (lower.endsWith('.exe')) return `windows-${arch}-nsis`;

  return null;
}

function assetUrl({ repo, tag, fileName }) {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(fileName)}`;
}

function main() {
  const artifactsDir = path.resolve(argValue('--artifacts-dir', path.join(root, 'dist', 'tauri-updater-artifacts')));
  const outFile = path.resolve(argValue('--out', path.join(artifactsDir, 'latest.json')));
  const version = argValue('--version', process.env.MYSKILLS_UPDATE_VERSION ?? readPackageVersion());
  const notes = argValue('--notes', process.env.MYSKILLS_UPDATE_NOTES ?? `MySkills Tauri preview ${version}`);
  const tag = argValue('--tag', process.env.MYSKILLS_UPDATE_TAG ?? 'tauri-preview');
  const repo = argValue('--repo', process.env.GITHUB_REPOSITORY ?? 'Milktang0128/myskills');
  const requireSignatures = !flag('--allow-missing-signatures');

  const platforms = {};
  const bundles = walk(artifactsDir)
    .filter((file) => !file.endsWith('.sig'))
    .filter((file) => path.basename(file) !== path.basename(outFile))
    .map((file) => ({ file, key: platformKey(file) }))
    .filter((entry) => entry.key);

  for (const { file, key } of bundles) {
    const sigFile = `${file}.sig`;
    if (!fs.existsSync(sigFile)) {
      if (requireSignatures) {
        throw new Error(`Missing updater signature for ${file}`);
      }
      continue;
    }

    const fileName = path.basename(file);
    platforms[key] = {
      signature: fs.readFileSync(sigFile, 'utf8').trim(),
      url: assetUrl({ repo, tag, fileName }),
    };
  }

  if (Object.keys(platforms).length === 0) {
    throw new Error(`No signed Tauri updater bundles found in ${artifactsDir}`);
  }

  const manifest = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms,
  };

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${outFile}`);
  console.log(`platforms: ${Object.keys(platforms).sort().join(', ')}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
