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
  const args = { dmg: '', fixtureSmoke: false, syncSmoke: false, historySmoke: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dmg') {
      args.dmg = argv[++i] ?? '';
    } else if (arg === '--fixture-smoke') {
      args.fixtureSmoke = true;
    } else if (arg === '--sync-smoke') {
      args.fixtureSmoke = true;
      args.syncSmoke = true;
    } else if (arg === '--history-smoke') {
      args.fixtureSmoke = true;
      args.syncSmoke = true;
      args.historySmoke = true;
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
    let rolledBackAt = null;
    if (options.syncSmoke) {
      const syncRow = queryJson(
        dbPath,
        "SELECT backup_path AS backupPath, success, rolled_back_at AS rolledBackAt FROM sync_history WHERE op_group_id = 'internal-smoke-sync' ORDER BY id DESC LIMIT 1",
      )[0];
      if (!syncRow || syncRow.success !== 1 || !syncRow.backupPath) return null;
      const expectedBackupRoot = path.join(path.dirname(dbPath), 'backups');
      if (!syncRow.backupPath.startsWith(expectedBackupRoot)) {
        return null;
      }
      if (options.historySmoke) {
        if (!syncRow.rolledBackAt) return null;
        const sharedDir = platformDirs.shared;
        const restoredSkill = fs.readFileSync(
          path.join(sharedDir, 'fixture-stale', 'SKILL.md'),
          'utf8',
        );
        if (!restoredSkill.includes('Canonical copy for stale drift smoke.')) return null;
        if (fs.existsSync(syncRow.backupPath)) return null;
        rolledBackAt = syncRow.rolledBackAt;
      } else if (!fs.existsSync(syncRow.backupPath)) {
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
      ...(rolledBackAt ? { rolledBackAt } : {}),
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
const manifest = args.fixtureSmoke ? createFixtures(tempRoot) : null;

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
  const smokeDataDir = path.dirname(dbPath);
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
  if (args.historySmoke) {
    env.MYSKILLS_INTERNAL_SMOKE_ROLLBACK = '1';
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
    fixtureResult = inspectFixtureDb(dbPath, manifest, {
      syncSmoke: args.syncSmoke,
      historySmoke: args.historySmoke,
    });
    return Boolean(fixtureResult);
  }, timeoutMs).then((ok) => (ok ? { dbReady: true } : { dbReady: false }));
  const result = await Promise.race([exitedEarly, dbReady]);
  await terminate(child);

  if (!result.dbReady) {
    const details = [];
    details.push(`expected DB: ${dbPath}`);
    if (manifest) details.push(`fixture manifest: ${path.join(manifest.root, 'manifest.json')}`);
    if ('code' in result) details.push(`process exit: code=${result.code} signal=${result.signal}`);
    if (stdout.trim()) details.push(`stdout:\n${stdout.trim()}`);
    if (stderr.trim()) details.push(`stderr:\n${stderr.trim()}`);
    throw new Error(`Mounted DMG smoke failed: preview DB was not created.\n${details.join('\n')}`);
  }

  console.log(`tauri DMG smoke passed: ${dmgPath}`);
  console.log(`bundle id: ${bundleId}`);
  if (fixtureResult) {
    console.log(`fixture result: ${JSON.stringify(fixtureResult)}`);
  } else {
    console.log(`created isolated preview DB at ${dbPath}`);
  }
} finally {
  if (attached) {
    spawnSync('hdiutil', ['detach', mountPoint, '-quiet'], { encoding: 'utf8' });
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
