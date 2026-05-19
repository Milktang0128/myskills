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
  {
    version: 3,
    name: 'per_location_mtime',
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info('skill_locations')").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'mtime')) {
        db.exec('ALTER TABLE skill_locations ADD COLUMN mtime INTEGER');
      }
    },
  },
  {
    version: 4,
    name: 'sync_history_install_provenance',
    up: (db) => {
      // Catalog-install provenance — records which skills.sh (source, skillId)
      // each install came from. Fresh installs that already materialized the
      // columns from SCHEMA_V1 skip the ALTERs.
      const cols = db.prepare("PRAGMA table_info('sync_history')").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'installed_from_source')) {
        db.exec('ALTER TABLE sync_history ADD COLUMN installed_from_source TEXT');
      }
      if (!cols.some((c) => c.name === 'installed_from_skill_id')) {
        db.exec('ALTER TABLE sync_history ADD COLUMN installed_from_skill_id TEXT');
      }
    },
  },
  {
    version: 5,
    name: 'ai_scenario_suggestions',
    up: (db) => {
      // Pending / accepted / dismissed AI suggestions for (skill, scenario)
      // pairs. Idempotent — fresh installs that already created the table via
      // SCHEMA_V1 skip silently.
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_scenario_suggestions (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          skill_id      TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
          scenario_key  TEXT NOT NULL,
          reason        TEXT,
          suggested_at  INTEGER NOT NULL,
          accepted_at   INTEGER,
          dismissed_at  INTEGER,
          UNIQUE(skill_id, scenario_key)
        );
        CREATE INDEX IF NOT EXISTS idx_ai_suggestions_skill ON ai_scenario_suggestions(skill_id);
      `);
      // Rate-limit between auto-categorize batches (ms). 10s default.
      db.prepare(
        "INSERT INTO settings (key, value) VALUES ('ai.categorize.minIntervalMs', '10000') ON CONFLICT(key) DO NOTHING",
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
