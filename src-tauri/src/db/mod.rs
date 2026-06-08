use std::path::Path;

use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, Connection};

use crate::error::AppResult;

mod schema;

pub fn init_pool(db_path: &Path) -> AppResult<Pool<SqliteConnectionManager>> {
    let manager = SqliteConnectionManager::file(db_path);
    let pool = Pool::new(manager)?;
    {
        let conn = pool.get()?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_millis(5000))?;
        run_migrations(&conn)?;
        ensure_schema_compatibility(&conn)?;
        seed_defaults(&conn)?;
    }
    Ok(pool)
}

fn run_migrations(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name    TEXT NOT NULL,
          run_at  INTEGER NOT NULL
        );",
    )?;

    let applied = {
        let mut stmt = conn.prepare("SELECT version FROM schema_migrations")?;
        let rows = stmt.query_map([], |row| row.get::<_, i64>(0))?;
        let mut versions = std::collections::HashSet::new();
        for row in rows {
            versions.insert(row?);
        }
        versions
    };

    if !applied.contains(&1) {
        conn.execute_batch(schema::SCHEMA_V1)?;
        conn.execute(
            "INSERT INTO schema_migrations (version, name, run_at) VALUES (1, 'init', ?1)",
            params![now_ms()],
        )?;
    }

    for (version, name, sql) in schema::IDEMPOTENT_MIGRATIONS {
        if applied.contains(version) {
            continue;
        }
        conn.execute_batch(sql)?;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations (version, name, run_at) VALUES (?1, ?2, ?3)",
            params![version, name, now_ms()],
        )?;
    }
    Ok(())
}

fn ensure_schema_compatibility(conn: &Connection) -> AppResult<()> {
    ensure_column(conn, "skill_locations", "content_hash", "TEXT")?;
    ensure_column(conn, "skill_locations", "mtime", "INTEGER")?;
    ensure_column(conn, "sync_history", "installed_from_source", "TEXT")?;
    ensure_column(conn, "sync_history", "installed_from_skill_id", "TEXT")?;
    ensure_column(conn, "sync_history", "op_group_id", "TEXT")?;

    conn.execute_batch(
        r#"
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
        CREATE INDEX IF NOT EXISTS idx_history_op_group ON sync_history(op_group_id);
        CREATE INDEX IF NOT EXISTS idx_skill_creation_status ON skill_creation_drafts(status);
        CREATE INDEX IF NOT EXISTS idx_skill_creation_updated ON skill_creation_drafts(updated_at);
        "#,
    )?;

    // 自适应澄清循环新增列：累积轮次计数 + 当前 AI 理解复述。旧草稿行靠 ADD COLUMN 惰性补齐，
    // 无需独立 SQL 迁移；clarify_round 默认 0，understanding 可空。
    ensure_column(
        conn,
        "skill_creation_drafts",
        "clarify_round",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(conn, "skill_creation_drafts", "understanding", "TEXT")?;

    conn.execute(
        "INSERT OR IGNORE INTO settings (key, value) VALUES ('canonical_platform', 'shared')",
        [],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO settings (key, value) VALUES ('ai.categorize.minIntervalMs', '10000')",
        [],
    )?;
    conn.execute("DELETE FROM settings WHERE key = 'schema_version'", [])?;
    conn.execute(
        "UPDATE platforms SET label = 'User Agents Folder' WHERE id = 'shared' AND label = 'Shared Pool'",
        [],
    )?;
    Ok(())
}

fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) -> AppResult<()> {
    if !table_exists(conn, table)? || column_exists(conn, table, column)? {
        return Ok(());
    }
    let sql = format!("ALTER TABLE {table} ADD COLUMN {column} {definition}");
    conn.execute_batch(&sql)?;
    Ok(())
}

fn table_exists(conn: &Connection, table: &str) -> AppResult<bool> {
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![table],
        |r| r.get(0),
    )?;
    Ok(exists > 0)
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> AppResult<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info('{table}')"))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for row in rows {
        if row? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn seed_defaults(conn: &Connection) -> AppResult<()> {
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let platforms = [
        (
            "claude",
            "Claude Code",
            home.join(".claude").join("skills"),
            0,
        ),
        ("codex", "Codex", home.join(".codex").join("skills"), 1),
        (
            "shared",
            "User Agents Folder",
            home.join(".agents").join("skills"),
            2,
        ),
    ];
    for (id, label, dir, order) in platforms {
        conn.execute(
            "INSERT OR IGNORE INTO platforms (id, label, skills_dir, is_builtin, enabled, sort_order)
             VALUES (?1, ?2, ?3, 1, 1, ?4)",
            params![id, label, dir.to_string_lossy(), order],
        )?;
    }

    let settings = [
        ("theme", "system"),
        ("auto_scan_on_launch", "1"),
        ("default_sync_mode", "symlink"),
        ("backup_retention_days", "30"),
        ("canonical_platform", "shared"),
        ("allow_external_network", "1"),
        ("llm.provider", "deepseek"),
        ("llm.model", "deepseek-v4-flash"),
        ("llm.baseUrl", ""),
        ("llm.feature.search", "0"),
        ("llm.feature.autoCategorize", "0"),
        ("llm.feature.recommend", "0"),
        ("llm.feature.createSkill", "0"),
        ("ai.categorize.minIntervalMs", "10000"),
    ];
    for (key, value) in settings {
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
    }
    Ok(())
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::OptionalExtension;

    #[test]
    fn schema_repair_adds_missing_legacy_columns_and_tables() {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            r#"
            CREATE TABLE platforms (
              id TEXT PRIMARY KEY,
              label TEXT NOT NULL,
              skills_dir TEXT NOT NULL,
              is_builtin INTEGER NOT NULL DEFAULT 0,
              enabled INTEGER NOT NULL DEFAULT 1,
              sort_order INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO platforms (id, label, skills_dir, is_builtin, enabled, sort_order)
            VALUES ('shared', 'Shared Pool', '/tmp/shared', 1, 1, 0);

            CREATE TABLE skills (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              source_key TEXT NOT NULL DEFAULT 'local',
              content_hash TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              last_scanned_at INTEGER NOT NULL
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
              last_seen_at INTEGER NOT NULL
            );
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
              created_at INTEGER NOT NULL
            );
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO settings (key, value) VALUES ('schema_version', '5');
            "#,
        )
        .expect("create legacy schema");

        ensure_schema_compatibility(&conn).expect("repair schema");
        ensure_schema_compatibility(&conn).expect("repair is idempotent");

        assert!(column_exists(&conn, "skill_locations", "content_hash").unwrap());
        assert!(column_exists(&conn, "skill_locations", "mtime").unwrap());
        assert!(column_exists(&conn, "sync_history", "installed_from_source").unwrap());
        assert!(column_exists(&conn, "sync_history", "installed_from_skill_id").unwrap());
        assert!(column_exists(&conn, "sync_history", "op_group_id").unwrap());
        assert!(table_exists(&conn, "skill_creation_drafts").unwrap());
        assert!(column_exists(&conn, "skill_creation_drafts", "draft_markdown").unwrap());
        assert!(column_exists(&conn, "skill_creation_drafts", "target_platform_ids_json").unwrap());
        assert!(column_exists(&conn, "skill_creation_drafts", "installed_skill_id").unwrap());
        assert!(table_exists(&conn, "ai_scenario_suggestions").unwrap());
        assert!(table_exists(&conn, "catalog_descriptions").unwrap());
        assert!(table_exists(&conn, "library_overview").unwrap());

        let shared_label: String = conn
            .query_row("SELECT label FROM platforms WHERE id = 'shared'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(shared_label, "User Agents Folder");

        let stale_version: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'schema_version'",
                [],
                |r| r.get(0),
            )
            .optional()
            .unwrap();
        assert!(stale_version.is_none());

        let canonical: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'canonical_platform'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(canonical, "shared");
    }
}
