/**
 * Central path provider for the main process.
 *
 * Why this exists: business modules (db/, sync/backup, catalog/install) used
 * to call `app.getPath('userData')` directly, which coupled them to Electron.
 * Routing every userData-derived path through this module means:
 *
 *   - electron/main.ts is the only file that touches `app.getPath`. A future
 *     CLI shell can call `initPaths({ userDataDir })` with its own value
 *     (e.g. `~/.myskills/`) and the rest of the codebase doesn't notice.
 *   - Tests can point everything at a tmpdir with one call.
 *
 * Initialization is required — calling any getter before `initPaths` throws.
 * That's deliberate: we'd rather fail fast at startup than silently write
 * to a default that surprises someone later.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

interface Paths {
  userDataDir: string;
  dbPath: string;
  stagingRoot: string;
  backupRoot: string;
}

let _paths: Paths | null = null;

export interface InitPathsOptions {
  /** Root directory for all per-user state (DB, backups, staging). */
  userDataDir: string;
}

export function initPaths(opts: InitPathsOptions): void {
  if (_paths) {
    // Idempotent if called with the same dir; otherwise refuse — silently
    // re-pointing would be a footgun (open DB handles would still point at
    // the old path).
    if (_paths.userDataDir === opts.userDataDir) return;
    throw new Error(
      `initPaths already initialized at ${_paths.userDataDir}; refusing to switch to ${opts.userDataDir}`,
    );
  }
  fs.mkdirSync(opts.userDataDir, { recursive: true });
  _paths = {
    userDataDir: opts.userDataDir,
    dbPath: path.join(opts.userDataDir, 'myskills.db'),
    stagingRoot: path.join(opts.userDataDir, 'staging'),
    backupRoot: path.join(opts.userDataDir, 'backups'),
  };
}

function require_(): Paths {
  if (!_paths) throw new Error('paths not initialized — call initPaths() first');
  return _paths;
}

export function getUserDataDir(): string {
  return require_().userDataDir;
}

export function getDbPath(): string {
  return require_().dbPath;
}

export function getStagingRoot(): string {
  const root = require_().stagingRoot;
  fs.mkdirSync(root, { recursive: true });
  return root;
}

export function getBackupRoot(): string {
  const root = require_().backupRoot;
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** Test-only reset. Not exported via index — import directly when needed. */
export function _resetPathsForTests(): void {
  _paths = null;
}
