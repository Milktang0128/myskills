#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';

const root = process.cwd();
const previewDirName = 'myskills-tauri-preview';
const timeoutMs = Number(process.env.MYSKILLS_SMOKE_TIMEOUT_MS ?? 15_000);

function parseArgs(argv) {
  const args = { dmg: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dmg') {
      args.dmg = argv[++i] ?? '';
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function defaultDmgPath() {
  const dmgDir = path.join(root, 'src-tauri/target/release/bundle/dmg');
  if (!fs.existsSync(dmgDir)) return '';
  const candidates = fs
    .readdirSync(dmgDir)
    .filter((name) => name.endsWith('.dmg') && name.startsWith('MySkills_'))
    .map((name) => path.join(dmgDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0] ?? '';
}

function expectedDbPath(home) {
  return path.join(home, 'Library/Application Support', previewDirName, 'myskills.db');
}

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
  return result.stdout.trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return true;
    await sleep(250);
  }
  return false;
}

async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(1500).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }),
  ]);
}

if (process.platform !== 'darwin') {
  console.error('DMG smoke is macOS-only.');
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const dmgPath = path.resolve(args.dmg || defaultDmgPath());
if (!dmgPath || !fs.existsSync(dmgPath)) {
  console.error(`Tauri DMG not found: ${dmgPath || '(none)'}`);
  console.error('Run `npm run build:tauri` before this smoke test.');
  process.exit(1);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myskills-tauri-dmg-smoke-'));
const mountPoint = path.join(tempRoot, 'mount');
const home = path.join(tempRoot, 'home');
fs.mkdirSync(mountPoint, { recursive: true });
fs.mkdirSync(home, { recursive: true });

let attached = false;
try {
  run('hdiutil', ['attach', dmgPath, '-nobrowse', '-readonly', '-mountpoint', mountPoint]);
  attached = true;

  const appPath = path.join(mountPoint, 'MySkills.app');
  const binary = path.join(appPath, 'Contents/MacOS/myskills');
  const infoPlist = path.join(appPath, 'Contents/Info.plist');
  if (!fs.existsSync(binary)) {
    throw new Error(`Mounted app binary not found: ${binary}`);
  }
  const bundleId = run('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleIdentifier', infoPlist]);
  if (bundleId !== 'com.kanbenzhi.myskills.tauri-preview') {
    throw new Error(`Unexpected bundle id: ${bundleId}`);
  }

  const dbPath = expectedDbPath(home);
  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: path.join(home, '.local/share'),
    APPDATA: path.join(home, 'AppData/Roaming'),
  };
  const child = spawn(binary, [], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const exitedEarly = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const dbReady = waitFor(() => fs.existsSync(dbPath), timeoutMs).then((ok) =>
    ok ? { dbReady: true } : { dbReady: false },
  );
  const result = await Promise.race([exitedEarly, dbReady]);
  await terminate(child);

  if (!result.dbReady) {
    const details = [];
    details.push(`expected DB: ${dbPath}`);
    if ('code' in result) details.push(`process exit: code=${result.code} signal=${result.signal}`);
    if (stdout.trim()) details.push(`stdout:\n${stdout.trim()}`);
    if (stderr.trim()) details.push(`stderr:\n${stderr.trim()}`);
    throw new Error(`Mounted DMG smoke failed: preview DB was not created.\n${details.join('\n')}`);
  }

  console.log(`tauri DMG smoke passed: ${dmgPath}`);
  console.log(`bundle id: ${bundleId}`);
  console.log(`created isolated preview DB at ${dbPath}`);
} finally {
  if (attached) {
    spawnSync('hdiutil', ['detach', mountPoint, '-quiet'], { encoding: 'utf8' });
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
