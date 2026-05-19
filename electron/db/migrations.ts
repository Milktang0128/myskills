import type { Database } from 'better-sqlite3';
import { SCHEMA_V1 } from './schema';

interface Migration {
  version: number;
  name: string;
  up: (db: Database) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'init',
    up: (db) => db.exec(SCHEMA_V1),
  },
  {
    version: 2,
    name: 'per_location_hash_and_canonical_platform',
    up: (db) => {
      // Add per-location content_hash if not present (idempotent for fresh installs
      // that already created the column from schema_v1+).
      const cols = db.prepare("PRAGMA table_info('skill_locations')").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'content_hash')) {
        db.exec('ALTER TABLE skill_locations ADD COLUMN content_hash TEXT');
      }
      // Default canonical platform setting (writers later can change it).
      db.prepare(
        "INSERT INTO settings (key, value) VALUES ('canonical_platform', 'shared') ON CONFLICT(key) DO NOTHING",
      ).run();
    },
  },
];

export function runMigrations(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name    TEXT NOT NULL,
    run_at  INTEGER NOT NULL
  )`);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[])
      .map((r) => r.version),
  );

  const insert = db.prepare(
    'INSERT INTO schema_migrations (version, name, run_at) VALUES (?, ?, ?)',
  );

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const tx = db.transaction(() => {
      m.up(db);
      insert.run(m.version, m.name, Date.now());
    });
    tx();
  }
}
