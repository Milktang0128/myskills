#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const root = process.cwd();
const previewDirName = 'myskills-tauri-preview';
const stableDirName = 'myskills';
const timeoutMs = Number(process.env.MYSKILLS_SMOKE_TIMEOUT_MS ?? 15_000);
const expectedFrontendSequence = [
  'matrix',
  'library-list',
  'library-kanban',
  'library-ai-lens',
  'discover',
  'scenarios',
  'history',
  'settings',
].join(',');

function parseArgs(argv) {
  const args = {
    fixtureSmoke: false,
    syncSmoke: false,
    historySmoke: false,
    workflowSmoke: false,
    coverageSmoke: false,
    frontendSmoke: false,
    stableSmoke: false,
    stableMigrationSmoke: false,
  };
  for (const arg of argv) {
    if (arg === '--fixture-smoke') {
      args.fixtureSmoke = true;
    } else if (arg === '--sync-smoke') {
      args.fixtureSmoke = true;
      args.syncSmoke = true;
    } else if (arg === '--history-smoke') {
      args.fixtureSmoke = true;
      args.syncSmoke = true;
      args.historySmoke = true;
    } else if (arg === '--workflow-smoke') {
      args.fixtureSmoke = true;
      args.workflowSmoke = true;
    } else if (arg === '--coverage-smoke') {
      args.fixtureSmoke = true;
      args.coverageSmoke = true;
    } else if (arg === '--frontend-smoke') {
      args.frontendSmoke = true;
    } else if (arg === '--stable-smoke') {
      args.stableSmoke = true;
    } else if (arg === '--stable-migration-smoke') {
      args.stableSmoke = true;
      args.stableMigrationSmoke = true;
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

function expectedDbPath(home, stable = false) {
  const dirName = stable ? stableDirName : previewDirName;
  if (process.platform === 'darwin') {
    return path.join(home, 'Library/Application Support', dirName, 'myskills.db');
  }
  if (process.platform === 'win32') {
    return path.join(home, 'AppData/Roaming', dirName, 'myskills.db');
  }
  return path.join(home, '.local/share', dirName, 'myskills.db');
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

async function cleanupTempRoot(tempRoot) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.rmSync(tempRoot, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
      return;
    } catch (error) {
      lastError = error;
      await sleep(250 * (attempt + 1));
    }
  }
  throw lastError;
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

function createStableMigrationFixture(tempRoot) {
  const electronDir = path.join(tempRoot, 'electron-user-data');
  const backupRoot = path.join(electronDir, 'backups');
  const backupItem = path.join(backupRoot, 'skill-1');
  fs.mkdirSync(backupItem, { recursive: true });
  fs.writeFileSync(path.join(backupItem, 'SKILL.md'), 'stable migration backup fixture\n');
  const sourceDb = path.join(electronDir, 'myskills.db');
  const now = Date.now();
  const sql = `
    CREATE TABLE platforms (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      skills_dir TEXT NOT NULL,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_key TEXT NOT NULL DEFAULT 'local',
      description TEXT,
      version TEXT,
      author TEXT,
      license TEXT,
      body_excerpt TEXT,
      content_hash TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      file_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_scanned_at INTEGER NOT NULL,
      UNIQUE(name, source_key)
    );
    CREATE TABLE skill_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_id TEXT NOT NULL,
      platform_id TEXT NOT NULL,
      install_path TEXT NOT NULL,
      real_path TEXT NOT NULL,
      is_symlink INTEGER NOT NULL DEFAULT 0,
      is_broken_link INTEGER NOT NULL DEFAULT 0,
      is_disabled INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT,
      mtime INTEGER,
      last_seen_at INTEGER NOT NULL,
      UNIQUE(platform_id, install_path)
    );
    CREATE TABLE scenarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      color TEXT,
      icon TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE skill_scenarios (
      skill_id TEXT NOT NULL,
      scenario_id INTEGER NOT NULL,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (skill_id, scenario_id)
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sync_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_id TEXT NOT NULL,
      action TEXT NOT NULL,
      from_path TEXT,
      to_path TEXT,
      platform_id TEXT,
      before_hash TEXT,
      after_hash TEXT,
      backup_path TEXT,
      dry_run_plan TEXT,
      conflict_resolution TEXT,
      rolled_back_at INTEGER,
      success INTEGER NOT NULL,
      message TEXT,
      created_at INTEGER NOT NULL,
      installed_from_source TEXT,
      installed_from_skill_id TEXT,
      op_group_id TEXT
    );
    INSERT INTO platforms (id, label, skills_dir, is_builtin, enabled, sort_order)
    VALUES ('shared', 'Shared Pool', '${path.join(electronDir, 'skills').replaceAll("'", "''")}', 1, 1, 0);
    INSERT INTO settings (key, value) VALUES ('canonical_platform', 'shared');
    INSERT INTO sync_history (skill_id, action, backup_path, success, message, created_at)
    VALUES ('skill-1', 'symlink_replace', '${backupItem.replaceAll("'", "''")}', 1, 'ok', ${now});
  `;
  const result = spawnSync('sqlite3', [sourceDb], { input: sql, encoding: 'utf8' });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`stable migration fixture creation failed\n${output}`);
  }
  const sourceHash = sha256File(sourceDb);
  const confirmationFile = path.join(tempRoot, 'stable-migration-confirmation.json');
  fs.writeFileSync(
    confirmationFile,
    JSON.stringify(
      {
        sourceDb,
        backupRoot,
        sourceSha256: sourceHash,
        confirmedAt: now,
      },
      null,
      2,
    ),
  );
  return {
    sourceDb,
    backupRoot,
    sourceHash,
    confirmationFile,
    backupItem,
  };
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
    let workflowScenario = null;
    if (options.workflowSmoke) {
      const settings = Object.fromEntries(
        queryJson(
          dbPath,
          "SELECT key, value FROM settings WHERE key IN ('allow_external_network', 'theme', 'language', 'smoke.workflows.completed', 'smoke.scenarios.exported')",
        ).map((row) => [row.key, row.value]),
      );
      if (
        settings.allow_external_network !== '0' ||
        settings.theme !== 'dark' ||
        settings.language !== 'zh' ||
        settings['smoke.workflows.completed'] !== '1' ||
        settings['smoke.scenarios.exported'] !== '1'
      ) {
        return null;
      }
      const scenario = queryJson(
        dbPath,
        "SELECT sc.name AS name, COUNT(ss.skill_id) AS skillCount FROM scenarios sc LEFT JOIN skill_scenarios ss ON ss.scenario_id = sc.id WHERE sc.key = 'packaged-smoke-import' GROUP BY sc.id",
      )[0];
      if (!scenario || scenario.name !== 'Packaged Smoke Updated' || scenario.skillCount !== 1) {
        return null;
      }
      const deletedCount = queryJson(
        dbPath,
        "SELECT COUNT(*) AS count FROM scenarios WHERE key = 'packaged-smoke-delete'",
      )[0]?.count;
      if (deletedCount !== 0) return null;
      workflowScenario = scenario.name;
    }
    let coverageRows = null;
    if (options.coverageSmoke) {
      const settings = Object.fromEntries(
        queryJson(
          dbPath,
          "SELECT key, value FROM settings WHERE key IN ('smoke.coverage.matrix', 'smoke.coverage.rows')",
        ).map((row) => [row.key, row.value]),
      );
      if (settings['smoke.coverage.matrix'] !== '1') return null;
      coverageRows = Number(settings['smoke.coverage.rows']);
      if (coverageRows !== 4) return null;

      const coverageFacts = queryJson(
        dbPath,
        `SELECT
           SUM(CASE WHEN s.name = 'fixture-in-sync' AND l.platform_id IN ('shared', 'claude', 'codex') AND l.is_disabled = 0 AND l.is_broken_link = 0 THEN 1 ELSE 0 END) AS inSyncLocations,
           COUNT(DISTINCT CASE WHEN s.name = 'fixture-in-sync' THEN l.content_hash END) AS inSyncHashes,
           COUNT(DISTINCT CASE WHEN s.name = 'fixture-stale' THEN l.content_hash END) AS staleHashes,
           SUM(CASE WHEN s.name = 'fixture-claude-only' AND l.platform_id = 'claude' THEN 1 ELSE 0 END) AS orphanClaudeLocations,
           SUM(CASE WHEN s.name = 'fixture-claude-only' AND l.platform_id = 'shared' THEN 1 ELSE 0 END) AS orphanSharedLocations,
           SUM(CASE WHEN s.name = 'fixture-disabled' AND l.platform_id = 'shared' AND l.is_disabled = 1 THEN 1 ELSE 0 END) AS disabledSharedLocations
         FROM skills s
         LEFT JOIN skill_locations l ON l.skill_id = s.id`,
      )[0];
      if (
        coverageFacts.inSyncLocations !== 3 ||
        coverageFacts.inSyncHashes !== 1 ||
        coverageFacts.staleHashes !== 2 ||
        coverageFacts.orphanClaudeLocations !== 1 ||
        coverageFacts.orphanSharedLocations !== 0 ||
        coverageFacts.disabledSharedLocations !== 1
      ) {
        return null;
      }
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
      ...(workflowScenario ? { workflowScenario } : {}),
      ...(coverageRows ? { coverageRows } : {}),
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

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function inspectStableMigrationDb(dbPath, fixture) {
  if (!fs.existsSync(dbPath)) return null;
  try {
    const settings = Object.fromEntries(
      queryJson(
        dbPath,
        "SELECT key, value FROM settings WHERE key IN ('migration.electron_v0_1.source_path', 'migration.electron_v0_1.source_sha256', 'migration.electron_v0_1.migrated_at')",
      ).map((row) => [row.key, row.value]),
    );
    if (settings['migration.electron_v0_1.source_path'] !== fixture.sourceDb) return null;
    if (settings['migration.electron_v0_1.source_sha256'] !== fixture.sourceHash) return null;
    if (!settings['migration.electron_v0_1.migrated_at']) return null;
    if (sha256File(fixture.sourceDb) !== fixture.sourceHash) return null;
    if (!fs.existsSync(path.join(fixture.backupItem, 'SKILL.md'))) return null;

    const history = queryJson(
      dbPath,
      "SELECT backup_path AS backupPath FROM sync_history WHERE skill_id = 'skill-1' LIMIT 1",
    )[0];
    if (!history?.backupPath) return null;
    const expectedPrefix = path.join(path.dirname(dbPath), 'migration-backups');
    if (!history.backupPath.startsWith(expectedPrefix)) return null;
    if (!fs.existsSync(path.join(history.backupPath, 'SKILL.md'))) return null;
    return {
      stableMigrationReady: true,
      migrationSourceHash: settings['migration.electron_v0_1.source_sha256'],
      migrationBackupRewritten: true,
    };
  } catch {
    return null;
  }
}

function inspectFrontendReady(dbPath) {
  if (!fs.existsSync(dbPath)) return null;
  try {
    const settings = Object.fromEntries(
      queryJson(
        dbPath,
        "SELECT key, value FROM settings WHERE key IN ('smoke.frontend.expected', 'smoke.frontend.ready', 'smoke.frontend.view', 'smoke.frontend.ui.ready', 'smoke.frontend.ui.sequence', 'smoke.frontend.ui.error')",
      ).map((row) => [row.key, row.value]),
    );
    if (
      settings['smoke.frontend.expected'] !== '1' ||
      settings['smoke.frontend.ready'] !== '1' ||
      settings['smoke.frontend.view'] !== 'workspace' ||
      settings['smoke.frontend.ui.ready'] !== '1' ||
      settings['smoke.frontend.ui.sequence'] !== expectedFrontendSequence
    ) {
      return null;
    }
    return {
      frontendReady: true,
      frontendView: settings['smoke.frontend.view'],
      frontendUiReady: true,
      frontendUiSequence: settings['smoke.frontend.ui.sequence'],
    };
  } catch {
    return null;
  }
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
const dbPath = expectedDbPath(home, args.stableSmoke);
const smokeDataDir = path.dirname(dbPath);
const manifest = args.fixtureSmoke ? createFixtures(tempRoot) : null;
const stableMigrationFixture = args.stableMigrationSmoke
  ? createStableMigrationFixture(tempRoot)
  : null;

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
if (args.workflowSmoke) {
  env.MYSKILLS_INTERNAL_SMOKE_WORKFLOWS = '1';
}
if (args.coverageSmoke) {
  env.MYSKILLS_INTERNAL_SMOKE_COVERAGE = '1';
}
if (args.frontendSmoke) {
  env.MYSKILLS_INTERNAL_SMOKE_FRONTEND = '1';
}
if (args.stableSmoke) {
  env.MYSKILLS_INTERNAL_STABLE_APP = '1';
}
if (stableMigrationFixture) {
  env.MYSKILLS_STABLE_MIGRATE_CONFIRMATION_FILE = stableMigrationFixture.confirmationFile;
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
let frontendResult = null;
let stableMigrationResult = null;
const dbReady = waitFor(() => {
  if (stableMigrationFixture) {
    stableMigrationResult = inspectStableMigrationDb(dbPath, stableMigrationFixture);
    if (!stableMigrationResult) return false;
  }
  if (args.frontendSmoke) {
    frontendResult = inspectFrontendReady(dbPath);
    if (!frontendResult) return false;
  }
  if (!manifest) return fs.existsSync(dbPath);
  fixtureResult = inspectFixtureDb(dbPath, manifest, {
    syncSmoke: args.syncSmoke,
    historySmoke: args.historySmoke,
    workflowSmoke: args.workflowSmoke,
    coverageSmoke: args.coverageSmoke,
  });
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
  await cleanupTempRoot(tempRoot);
  process.exit(1);
}

await cleanupTempRoot(tempRoot);
if (fixtureResult) {
  console.log(
    `tauri launch fixture smoke passed: ${JSON.stringify({ ...fixtureResult, ...frontendResult, ...stableMigrationResult })}`,
  );
} else if (stableMigrationResult || frontendResult) {
  console.log(
    `tauri launch smoke passed: ${JSON.stringify({ ...stableMigrationResult, ...frontendResult })}`,
  );
} else {
  console.log(`tauri launch smoke passed: created isolated preview DB at ${dbPath}`);
}
