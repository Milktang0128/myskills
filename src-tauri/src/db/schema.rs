pub const SCHEMA_V1: &str = r#"
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
  mtime           INTEGER,
  birthtime       INTEGER,
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
  skill_id TEXT NOT NULL REFERENCES skills(id),
  tag_id   INTEGER NOT NULL REFERENCES tags(id),
  PRIMARY KEY (skill_id, tag_id)
);

CREATE TABLE IF NOT EXISTS sync_history (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id                 TEXT NOT NULL,
  action                   TEXT NOT NULL,
  from_path                TEXT,
  to_path                  TEXT,
  platform_id              TEXT,
  before_hash              TEXT,
  after_hash               TEXT,
  backup_path              TEXT,
  dry_run_plan             TEXT,
  conflict_resolution      TEXT,
  rolled_back_at           INTEGER,
  success                  INTEGER NOT NULL,
  message                  TEXT,
  created_at               INTEGER NOT NULL,
  installed_from_source    TEXT,
  installed_from_skill_id  TEXT,
  op_group_id              TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_skill ON sync_history(skill_id);
CREATE INDEX IF NOT EXISTS idx_history_created ON sync_history(created_at);
CREATE INDEX IF NOT EXISTS idx_history_op_group ON sync_history(op_group_id);

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

CREATE TABLE IF NOT EXISTS catalog_descriptions (
  source       TEXT NOT NULL,
  skill_id     TEXT NOT NULL,
  description  TEXT,
  fetched_at   INTEGER NOT NULL,
  PRIMARY KEY (source, skill_id)
);
CREATE INDEX IF NOT EXISTS idx_catalog_descriptions_fetched ON catalog_descriptions(fetched_at);

CREATE TABLE IF NOT EXISTS library_overview (
  id             INTEGER PRIMARY KEY,
  set_hash       TEXT NOT NULL,
  overview_json  TEXT NOT NULL,
  generated_at   INTEGER NOT NULL,
  model          TEXT,
  language       TEXT
);

CREATE TABLE IF NOT EXISTS skill_creation_drafts (
  id                       TEXT PRIMARY KEY,
  status                   TEXT NOT NULL,
  raw_prompt               TEXT NOT NULL,
  intent_frame_json         TEXT,
  skill_spec_json           TEXT,
  followup_questions_json   TEXT NOT NULL DEFAULT '[]',
  answers_json              TEXT NOT NULL DEFAULT '{}',
  draft_markdown            TEXT,
  target_platform_ids_json  TEXT NOT NULL DEFAULT '[]',
  target_scenario_ids_json  TEXT NOT NULL DEFAULT '[]',
  target_basename           TEXT,
  staged_dir                TEXT,
  draft_hash                TEXT,
  validation_json           TEXT,
  plan_token                TEXT,
  installed_skill_id        TEXT REFERENCES skills(id) ON DELETE SET NULL,
  clarify_round             INTEGER NOT NULL DEFAULT 0,
  understanding             TEXT,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  installed_at              INTEGER,
  discarded_at              INTEGER
);
CREATE INDEX IF NOT EXISTS idx_skill_creation_status ON skill_creation_drafts(status);
CREATE INDEX IF NOT EXISTS idx_skill_creation_updated ON skill_creation_drafts(updated_at);

CREATE TABLE IF NOT EXISTS skill_audits (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id      TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  content_hash  TEXT NOT NULL,
  language      TEXT NOT NULL,
  report_json   TEXT NOT NULL,
  model         TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE(skill_id, content_hash, language)
);
CREATE INDEX IF NOT EXISTS idx_skill_audits_skill ON skill_audits(skill_id);

CREATE TABLE IF NOT EXISTS catalog_skill_md (
  source      TEXT NOT NULL,
  skill_id    TEXT NOT NULL,
  markdown    TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL,
  PRIMARY KEY (source, skill_id)
);

CREATE TABLE IF NOT EXISTS skill_optimizations (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id                  TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  status                    TEXT NOT NULL,
  finding_json              TEXT NOT NULL,
  baseline_hash             TEXT NOT NULL,
  baseline_markdown         TEXT NOT NULL,
  proposed_markdown         TEXT NOT NULL,
  expected_improvement      TEXT NOT NULL,
  verification_prompts_json TEXT NOT NULL DEFAULT '[]',
  gate_json                 TEXT NOT NULL,
  language                  TEXT NOT NULL,
  model                     TEXT,
  sync_history_id           INTEGER,
  before_hash               TEXT,
  after_hash                TEXT,
  created_at                INTEGER NOT NULL,
  applied_at                INTEGER
);
CREATE INDEX IF NOT EXISTS idx_skill_optimizations_skill ON skill_optimizations(skill_id);
"#;

pub const IDEMPOTENT_MIGRATIONS: &[(i64, &str, &str)] = &[
    (2, "per_location_hash_and_canonical_platform", "INSERT OR IGNORE INTO settings (key, value) VALUES ('canonical_platform', 'shared');"),
    (3, "per_location_mtime", ""),
    (4, "sync_history_install_provenance", ""),
    (5, "ai_scenario_suggestions", "INSERT OR IGNORE INTO settings (key, value) VALUES ('ai.categorize.minIntervalMs', '10000');"),
    (6, "drop_stale_schema_version_setting", "DELETE FROM settings WHERE key = 'schema_version';"),
    (7, "rename_shared_pool_label", "UPDATE platforms SET label = 'User Agents Folder' WHERE id = 'shared' AND label = 'Shared Pool';"),
    (8, "catalog_descriptions_cache", ""),
    (9, "library_overview", ""),
    (10, "sync_history_op_group", "CREATE INDEX IF NOT EXISTS idx_history_op_group ON sync_history(op_group_id);"),
    (11, "skill_creation_drafts", r#"
CREATE TABLE IF NOT EXISTS skill_creation_drafts (
  id                       TEXT PRIMARY KEY,
  status                   TEXT NOT NULL,
  raw_prompt               TEXT NOT NULL,
  intent_frame_json         TEXT,
  skill_spec_json           TEXT,
  followup_questions_json   TEXT NOT NULL DEFAULT '[]',
  answers_json              TEXT NOT NULL DEFAULT '{}',
  draft_markdown            TEXT,
  target_platform_ids_json  TEXT NOT NULL DEFAULT '[]',
  target_scenario_ids_json  TEXT NOT NULL DEFAULT '[]',
  target_basename           TEXT,
  staged_dir                TEXT,
  draft_hash                TEXT,
  validation_json           TEXT,
  plan_token                TEXT,
  installed_skill_id        TEXT REFERENCES skills(id) ON DELETE SET NULL,
  clarify_round             INTEGER NOT NULL DEFAULT 0,
  understanding             TEXT,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  installed_at              INTEGER,
  discarded_at              INTEGER
);
CREATE INDEX IF NOT EXISTS idx_skill_creation_status ON skill_creation_drafts(status);
CREATE INDEX IF NOT EXISTS idx_skill_creation_updated ON skill_creation_drafts(updated_at);
"#),
    (12, "skill_optimization_phase1", r#"
CREATE TABLE IF NOT EXISTS skill_audits (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id      TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  content_hash  TEXT NOT NULL,
  language      TEXT NOT NULL,
  report_json   TEXT NOT NULL,
  model         TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE(skill_id, content_hash, language)
);
CREATE INDEX IF NOT EXISTS idx_skill_audits_skill ON skill_audits(skill_id);

CREATE TABLE IF NOT EXISTS catalog_skill_md (
  source      TEXT NOT NULL,
  skill_id    TEXT NOT NULL,
  markdown    TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL,
  PRIMARY KEY (source, skill_id)
);
"#),
    (13, "skill_optimizations_phase2", r#"
CREATE TABLE IF NOT EXISTS skill_optimizations (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id                  TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  status                    TEXT NOT NULL,
  finding_json              TEXT NOT NULL,
  baseline_hash             TEXT NOT NULL,
  baseline_markdown         TEXT NOT NULL,
  proposed_markdown         TEXT NOT NULL,
  expected_improvement      TEXT NOT NULL,
  verification_prompts_json TEXT NOT NULL DEFAULT '[]',
  gate_json                 TEXT NOT NULL,
  language                  TEXT NOT NULL,
  model                     TEXT,
  sync_history_id           INTEGER,
  before_hash               TEXT,
  after_hash                TEXT,
  created_at                INTEGER NOT NULL,
  applied_at                INTEGER
);
CREATE INDEX IF NOT EXISTS idx_skill_optimizations_skill ON skill_optimizations(skill_id);
"#),
    // Provenance: who authored a skill — 'human' (hand-written or scanner-found,
    // the default) vs 'agent' (written via the MCP authoring tools). Metadata is
    // a small JSON blob (tool name, model, timestamp). Lives in the DB only —
    // never written into the skill directory (see CLAUDE.md invariant).
    (14, "skill_provenance", r#"
ALTER TABLE skills ADD COLUMN authored_by TEXT NOT NULL DEFAULT 'human';
ALTER TABLE skills ADD COLUMN authored_meta TEXT;
CREATE INDEX IF NOT EXISTS idx_skills_authored_by ON skills(authored_by);
"#),
];
