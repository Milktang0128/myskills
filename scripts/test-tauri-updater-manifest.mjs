#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myskills-updater-manifest-'));

function touchBundle(name) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, `bundle:${name}`);
  fs.writeFileSync(`${file}.sig`, `signature:${name}`);
}

touchBundle('MySkills_0.2.0-tauri.1_aarch64.app.tar.gz');
touchBundle('MySkills_0.2.0-tauri.1_x64-setup.exe');
touchBundle('MySkills_0.2.0-tauri.1_amd64.AppImage');

const result = spawnSync(
  process.execPath,
  [
    path.join(root, 'scripts/write-tauri-updater-manifest.mjs'),
    '--artifacts-dir',
    tmp,
    '--version',
    '0.2.0-tauri.1',
    '--tag',
    'tauri-preview',
    '--repo',
    'Milktang0128/myskills',
  ],
  { cwd: root, encoding: 'utf8' },
);

if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.stderr.write(result.stdout);
  process.exit(result.status ?? 1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'latest.json'), 'utf8'));
const expected = ['darwin-aarch64-app', 'linux-x86_64-appimage', 'windows-x86_64-nsis'];
for (const key of expected) {
  if (!manifest.platforms?.[key]) {
    console.error(`missing platform ${key}`);
    process.exit(1);
  }
  if (!manifest.platforms[key].url.includes('/releases/download/tauri-preview/')) {
    console.error(`bad url for ${key}: ${manifest.platforms[key].url}`);
    process.exit(1);
  }
}

console.log('tauri updater manifest smoke passed');
