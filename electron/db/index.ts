import Database from 'better-sqlite3';
import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runMigrations } from './migrations';
import { seedDefaults } from './seed';

let _db: Database.Database | null = null;
let _dbPath: string | null = null;

/** Initialize SQLite at userData/myskills.db. Idempotent. */
export function initDb(): Database.Database {
  if (_db) return _db;
  const userData = app.getPath('userData');
  fs.mkdirSync(userData, { recursive: true });
  _dbPath = path.join(userData, 'myskills.db');
  _db = new Database(_dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  runMigrations(_db);
  seedDefaults(_db);
  return _db;
}

export function getDb(): Database.Database {
  if (!_db) throw new Error('DB not initialized — call initDb() first');
  return _db;
}

export function getDbPath(): string {
  if (!_dbPath) throw new Error('DB not initialized');
  return _dbPath;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    _dbPath = null;
  }
}
