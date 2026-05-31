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
  const args = { fixtureSmoke: false, syncSmoke: false };
  for (const arg of argv) {
    if (arg === '--fixture-smoke') {
      args.fixtureSmoke = true;
    } else if (arg === '--sync-smoke') {
      args.fixtureSmoke = true;
      args.syncSmoke = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

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

function createFixtures(tempRoot) {
  const result = spawnSync(
    process.execPath,
    ['scripts/create-tauri-smoke-fixtures.mjs', '--json', '--root', path.join(tempRoot, 'fixtures')],
    { cwd: root, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`fixture creation failed\n${output}`);
  }
  return JSON.parse(result.stdout);
}

function inspectFixtureDb(dbPath, manifest, options = {}) {
  if (!fs.existsSync(dbPath)) return null;
  try {
    const platformRows = queryJson(dbPath, 'SELECT id, skills_dir FROM platforms');
    const platformDirs = Object.fromEntries(platformRows.map((row) => [row.id, row.skills_dir]));
    for (const platformId of ['shared', 'claude', 'codex']) {
      if (platformDirs[platformId] !== manifest.platforms[platformId]) return null;
    }
    const totalSkills = queryJson(dbPath, 'SELECT COUNT(*) AS count FROM skills')[0]?.count;
    const disabledLocations = queryJson(
      dbPath,
      'SELECT COUNT(*) AS count FROM skill_locations WHERE is_disabled = 1',
    )[0]?.count;
    const scan = queryJson(
      dbPath,
      'SELECT total_found AS totalFound, new_count AS newSkills, updated_count AS updatedSkills, errors_json AS errorsJson FROM scan_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1',
    )[0];
    if (!scan) return null;
    const errors = JSON.parse(scan.errorsJson || '[]');
    const errorKinds = new Set(errors.map((error) => error.kind));
    const expectedNewSkills = options.syncSmoke ? 0 : 4;
    if (
      totalSkills !== 4 ||
      disabledLocations !== 1 ||
      scan.totalFound !== 7 ||
      scan.newSkills !== expectedNewSkills ||
      !errorKinds.has('missing_frontmatter') ||
      (manifest.expected.brokenLink.length > 0 && !errorKinds.has('broken_symlink'))
    ) {
      return null;
    }
    let syncBackupPath = null;
    if (options.syncSmoke) {
      const syncRow = queryJson(
        dbPath,
        "SELECT backup_path AS backupPath, success FROM sync_history WHERE op_group_id = 'internal-smoke-sync' ORDER BY id DESC LIMIT 1",
      )[0];
      if (!syncRow || syncRow.success !== 1 || !syncRow.backupPath) return null;
      const expectedBackupRoot = path.join(path.dirname(dbPath), 'backups');
      if (!syncRow.backupPath.startsWith(expectedBackupRoot) || !fs.existsSync(syncRow.backupPath)) {
        return null;
      }
      syncBackupPath = syncRow.backupPath;
    }
    return {
      totalSkills,
      disabledLocations,
      totalFound: scan.totalFound,
      newSkills: scan.newSkills,
      updatedSkills: scan.updatedSkills,
      errorKinds: [...errorKinds].sort(),
      ...(syncBackupPath ? { syncBackupPath } : {}),
    };
  } catch {
    return null;
  }
}

function queryJson(dbPath, sql) {
  const result = spawnSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || `sqlite3 failed for query: ${sql}`);
  }
  return JSON.parse(result.stdout || '[]');
}

const args = parseArgs(process.argv.slice(2));
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
const smokeDataDir = path.dirname(dbPath);
const manifest = args.fixtureSmoke ? createFixtures(tempRoot) : null;

const env = {
  ...process.env,
  HOME: home,
  XDG_DATA_HOME: path.join(home, '.local/share'),
  APPDATA: path.join(home, 'AppData/Roaming'),
  MYSKILLS_INTERNAL_SMOKE_DATA_DIR: smokeDataDir,
};
if (manifest) {
  env.MYSKILLS_INTERNAL_SMOKE_FIXTURE_MANIFEST = path.join(manifest.root, 'manifest.json');
}
if (args.syncSmoke) {
  env.MYSKILLS_INTERNAL_SMOKE_SYNC = '1';
}

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
let fixtureResult = null;
const dbReady = waitFor(() => {
  if (!manifest) return fs.existsSync(dbPath);
  fixtureResult = inspectFixtureDb(dbPath, manifest, { syncSmoke: args.syncSmoke });
  return Boolean(fixtureResult);
}, timeoutMs).then((ok) => (ok ? { dbReady: true } : { dbReady: false }));

const result = await Promise.race([exitedEarly, dbReady]);
await terminate(child);

if (!result.dbReady) {
  console.error('Tauri launch smoke failed: preview DB was not created before app exit/timeout.');
  console.error(`expected DB: ${dbPath}`);
  if (manifest) console.error(`fixture manifest: ${path.join(manifest.root, 'manifest.json')}`);
  if ('code' in result) console.error(`process exit: code=${result.code} signal=${result.signal}`);
  if (stdout.trim()) console.error(`stdout:\n${stdout.trim()}`);
  if (stderr.trim()) console.error(`stderr:\n${stderr.trim()}`);
  fs.rmSync(tempRoot, { recursive: true, force: true });
  process.exit(1);
}

fs.rmSync(tempRoot, { recursive: true, force: true });
if (fixtureResult) {
  console.log(`tauri launch fixture smoke passed: ${JSON.stringify(fixtureResult)}`);
} else {
  console.log(`tauri launch smoke passed: created isolated preview DB at ${dbPath}`);
}
