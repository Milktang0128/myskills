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
