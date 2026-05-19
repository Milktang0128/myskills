/**
 * SQLite schema for MySkills, inlined as TypeScript so `tsc` ships it
 * inside dist-electron/ without a separate copy step.
 * Mirrors SPEC §6.2 (v0.2). Schema v1.
 */
export const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS platforms (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  skills_dir  TEXT NOT NULL,
  is_builtin  INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS skills (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  source_key      TEXT NOT NULL DEFAULT 'local',
  description     TEXT,
  version         TEXT,
  author          TEXT,
  license         TEXT,
  body_excerpt    TEXT,
  content_hash    TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL DEFAULT 0,
  file_count      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_scanned_at INTEGER NOT NULL,
  UNIQUE(name, source_key)
);
CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);
CREATE INDEX IF NOT EXISTS idx_skills_updated ON skills(updated_at);
CREATE INDEX IF NOT EXISTS idx_skills_hash ON skills(content_hash);

CREATE TABLE IF NOT EXISTS skill_locations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id        TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  platform_id     TEXT NOT NULL REFERENCES platforms(id),
  install_path    TEXT NOT NULL,
  real_path       TEXT NOT NULL,
  is_symlink      INTEGER NOT NULL DEFAULT 0,
  is_broken_link  INTEGER NOT NULL DEFAULT 0,
  is_disabled     INTEGER NOT NULL DEFAULT 0,
  content_hash    TEXT,
  last_seen_at    INTEGER NOT NULL,
  UNIQUE(platform_id, install_path)
);
CREATE INDEX IF NOT EXISTS idx_loc_skill ON skill_locations(skill_id);
CREATE INDEX IF NOT EXISTS idx_loc_realpath ON skill_locations(real_path);

CREATE TABLE IF NOT EXISTS scenarios (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  color       TEXT,
  icon        TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_builtin  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_scenarios (
  skill_id    TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (skill_id, scenario_id)
);

CREATE TABLE IF NOT EXISTS tags (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL UNIQUE,
  color TEXT
);

CREATE TABLE IF NOT EXISTS skill_tags (
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (skill_id, tag_id)
);

CREATE TABLE IF NOT EXISTS sync_history (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id            TEXT NOT NULL,
  action              TEXT NOT NULL,
  from_path           TEXT,
  to_path             TEXT,
  platform_id         TEXT,
  before_hash         TEXT,
  after_hash          TEXT,
  backup_path         TEXT,
  dry_run_plan        TEXT,
  conflict_resolution TEXT,
  rolled_back_at      INTEGER,
  success             INTEGER NOT NULL,
  message             TEXT,
  created_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_skill ON sync_history(skill_id);
CREATE INDEX IF NOT EXISTS idx_history_created ON sync_history(created_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  total_found     INTEGER NOT NULL DEFAULT 0,
  new_count       INTEGER NOT NULL DEFAULT 0,
  updated_count   INTEGER NOT NULL DEFAULT 0,
  removed_count   INTEGER NOT NULL DEFAULT 0,
  duration_ms     INTEGER,
  errors_json     TEXT NOT NULL DEFAULT '[]'
);
`;
