#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const root = process.cwd();
const previewDirName = 'myskills-tauri-preview';
const timeoutMs = Number(process.env.MYSKILLS_SMOKE_TIMEOUT_MS ?? 15_000);

function appBinary() {
  if (process.platform === 'darwin') {
    return path.join(
      root,
      'src-tauri/target/release/bundle/macos/MySkills.app/Contents/MacOS/myskills',
    );
  }
  if (process.platform === 'win32') {
    return path.join(root, 'src-tauri/target/release/myskills.exe');
  }
  return path.join(root, 'src-tauri/target/release/myskills');
}

function expectedDbPath(home) {
  if (process.platform === 'darwin') {
    return path.join(home, 'Library/Application Support', previewDirName, 'myskills.db');
  }
  if (process.platform === 'win32') {
    return path.join(home, 'AppData/Roaming', previewDirName, 'myskills.db');
  }
  return path.join(home, '.local/share', previewDirName, 'myskills.db');
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

const binary = appBinary();
if (!fs.existsSync(binary)) {
  console.error(`Tauri release binary not found: ${binary}`);
  console.error('Run `npm run build:tauri` before this smoke test.');
  process.exit(1);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myskills-tauri-smoke-'));
const home = path.join(tempRoot, 'home');
fs.mkdirSync(home, { recursive: true });
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
  console.error('Tauri launch smoke failed: preview DB was not created before app exit/timeout.');
  console.error(`expected DB: ${dbPath}`);
  if ('code' in result) console.error(`process exit: code=${result.code} signal=${result.signal}`);
  if (stdout.trim()) console.error(`stdout:\n${stdout.trim()}`);
  if (stderr.trim()) console.error(`stderr:\n${stderr.trim()}`);
  fs.rmSync(tempRoot, { recursive: true, force: true });
  process.exit(1);
}

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log(`tauri launch smoke passed: created isolated preview DB at ${dbPath}`);
