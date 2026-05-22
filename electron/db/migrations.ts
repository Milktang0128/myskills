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
  {
    version: 6,
    name: 'drop_stale_schema_version_setting',
    up: (db) => {
      // The old seed wrote `settings.schema_version = '5'` via INSERT OR IGNORE,
      // which froze the value at whatever version was current the very first
      // time the user launched MySkills — so DBs seeded at v1 still showed
      // `schema_version=1` after running every migration up to v5. The
      // authoritative version tracker is `schema_migrations`, so just delete
      // the misleading row.
      db.prepare("DELETE FROM settings WHERE key = 'schema_version'").run();
    },
  },
  {
    version: 7,
    name: 'rename_shared_pool_label',
    up: (db) => {
      // Rebrand the built-in `shared` platform's label from "Shared Pool" to
      // "User Agents Folder" — the old name was MySkills-internal jargon,
      // the new one matches the cross-tool convention (OpenClaw etc. call it
      // "Personal/User agent skills"). Only update DBs that still hold the
      // original label; any user customization (e.g. "我的共享池") is preserved.
      // The DB `id` stays 'shared' so saved data isn't touched.
      db.prepare(
        "UPDATE platforms SET label = 'User Agents Folder' WHERE id = 'shared' AND label = 'Shared Pool'",
      ).run();
    },
  },
  {
    version: 8,
    name: 'catalog_descriptions_cache',
    up: (db) => {
      // Persistent cache for skills.sh search-result descriptions. The search
      // API doesn't include description, so we fetch each skill's SKILL.md
      // frontmatter from GitHub raw and cache it. Persisting across launches
      // means second-time-opening Discover is instant instead of refetching
      // 10+ rows from GitHub. SkillsGate uses the same "sync once, store,
      // browse locally" pattern.
      db.exec(`
        CREATE TABLE IF NOT EXISTS catalog_descriptions (
          source       TEXT NOT NULL,
          skill_id     TEXT NOT NULL,
          description  TEXT,
          fetched_at   INTEGER NOT NULL,
          PRIMARY KEY (source, skill_id)
        );
        CREATE INDEX IF NOT EXISTS idx_catalog_descriptions_fetched ON catalog_descriptions(fetched_at);
      `);
    },
  },
  {
    version: 9,
    name: 'library_overview',
    up: (db) => {
      // Single-row cache for the AI-generated Skill Map view. Fresh installs
      // already have the table from SCHEMA_V1; existing DBs get it here.
      db.exec(`
        CREATE TABLE IF NOT EXISTS library_overview (
          id             INTEGER PRIMARY KEY,
          set_hash       TEXT NOT NULL,
          overview_json  TEXT NOT NULL,
          generated_at   INTEGER NOT NULL,
          model          TEXT,
          language       TEXT
        );
      `);
    },
  },
  {
    version: 10,
    name: 'sync_history_op_group',
    up: (db) => {
      // Persist the opGroupId that buildSync/buildPromote/buildInstall
      // already generate in memory, so the rollback handler can recover all
      // FS steps that belong to one user-level action. Existing rows stay
      // NULL — they roll back as singletons (the UI treats NULL groups as
      // groups-of-one). Idempotent: skipped for fresh installs that already
      // got the column via SCHEMA_V1.
      const cols = db.prepare("PRAGMA table_info('sync_history')").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'op_group_id')) {
        db.exec('ALTER TABLE sync_history ADD COLUMN op_group_id TEXT');
      }
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_history_op_group ON sync_history(op_group_id)',
      );
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
