#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const dmgDir = path.join(root, 'src-tauri/target/release/bundle/dmg');
const appPath = path.join(root, 'src-tauri/target/release/bundle/macos/MySkills.app');
const profile = process.env.MYSKILLS_NOTARY_PROFILE || 'myskills-notary';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed\n${output}`);
  }
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
}

function latestDmg() {
  if (!fs.existsSync(dmgDir)) return '';
  const candidates = fs
    .readdirSync(dmgDir)
    .filter((name) => name.startsWith('MySkills_') && name.endsWith('.dmg'))
    .map((name) => path.join(dmgDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0] || '';
}

const dmgPath = process.argv[2] ? path.resolve(process.argv[2]) : latestDmg();
if (!dmgPath || !fs.existsSync(dmgPath)) {
  console.error('No Tauri DMG found. Run `npm run build:tauri:mac:signed` first.');
  process.exit(1);
}
if (!fs.existsSync(appPath)) {
  console.error(`No Tauri app bundle found: ${appPath}`);
  process.exit(1);
}

console.log(`[tauri-notary] Verifying Developer ID signature on ${appPath}`);
run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
const signature = run('codesign', ['-dv', '--verbose=4', appPath]);
if (!signature.includes('Authority=Developer ID Application: Zhi Tang (LB8ZBRDP63)')) {
  throw new Error(`Unexpected signing authority for ${appPath}\n${signature}`);
}
if (!signature.includes('TeamIdentifier=LB8ZBRDP63')) {
  throw new Error(`Unexpected team identifier for ${appPath}\n${signature}`);
}

console.log(`[tauri-notary] Submitting ${dmgPath} with keychain profile "${profile}"`);
run('xcrun', ['notarytool', 'submit', dmgPath, '--keychain-profile', profile, '--wait']);

console.log(`[tauri-notary] Stapling ${dmgPath}`);
run('xcrun', ['stapler', 'staple', dmgPath]);
run('xcrun', ['stapler', 'validate', dmgPath]);

console.log('[tauri-notary] Assessing stapled DMG with Gatekeeper');
run('spctl', ['-a', '-vvv', '-t', 'open', '--context', 'context:primary-signature', dmgPath]);

console.log(`[tauri-notary] notarized and stapled: ${dmgPath}`);
