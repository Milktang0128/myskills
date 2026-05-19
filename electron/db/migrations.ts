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
