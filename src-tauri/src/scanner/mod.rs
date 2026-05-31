pub mod parser;

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::db::now_ms;
use crate::error::{AppError, AppResult};

use self::parser::parse_skill_dir;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanPlatformProgress {
    pub platform_id: String,
    pub index: usize,
    pub total: usize,
    pub found: usize,
    pub skipped: bool,
}

pub fn scan_all(conn: &Connection) -> AppResult<Value> {
    scan_all_with_progress(conn, |_| {})
}

pub fn scan_all_with_progress<F>(conn: &Connection, mut on_platform_done: F) -> AppResult<Value>
where
    F: FnMut(ScanPlatformProgress),
{
    let started = now_ms();
    let platforms = list_enabled_platforms(conn)?;
    let total = platforms.len();
    let mut discovered = Vec::new();
    let mut errors = Vec::new();

    for (idx, platform) in platforms.into_iter().enumerate() {
        let root = PathBuf::from(&platform.skills_dir);
        if !root.is_dir() {
            on_platform_done(ScanPlatformProgress {
                platform_id: platform.id,
                index: idx + 1,
                total,
                found: 0,
                skipped: true,
            });
            continue;
        }
        let before = discovered.len();
        scan_root(&root, &platform.id, false, &mut discovered, &mut errors);
        let disabled = root.join(".disabled");
        if disabled.is_dir() {
            scan_root(&disabled, &platform.id, true, &mut discovered, &mut errors);
        }
        on_platform_done(ScanPlatformProgress {
            platform_id: platform.id,
            index: idx + 1,
            total,
            found: discovered.len() - before,
            skipped: false,
        });
    }

    let reconcile = reconcile(conn, &discovered, started)?;
    let finished = now_ms();
    let result = json!({
        "totalFound": discovered.len(),
        "newSkills": reconcile.new_count,
        "updatedSkills": reconcile.updated_count,
        "removedSkills": reconcile.removed_count,
        "addedSkillIds": reconcile.added_skill_ids,
        "errors": errors,
        "durationMs": finished - started,
        "scannedAt": finished
    });
    conn.execute(
        "INSERT INTO scan_runs (started_at, finished_at, total_found, new_count, updated_count, removed_count, duration_ms, errors_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            started,
            finished,
            discovered.len() as i64,
            reconcile.new_count,
            reconcile.updated_count,
            reconcile.removed_count,
            finished - started,
            serde_json::to_string(result["errors"].as_array().unwrap()).unwrap_or_else(|_| "[]".to_string())
        ],
    )?;
    Ok(result)
}

struct PlatformRow {
    id: String,
    skills_dir: String,
}

struct Discovered {
    platform_id: String,
    install_path: String,
    real_path: String,
    is_symlink: bool,
    is_broken: bool,
    is_disabled: bool,
    parsed: parser::ParsedSkill,
}

#[derive(Debug, PartialEq, Eq)]
struct ReconcileResult {
    new_count: i64,
    updated_count: i64,
    removed_count: i64,
    added_skill_ids: Vec<String>,
}

fn list_enabled_platforms(conn: &Connection) -> AppResult<Vec<PlatformRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, skills_dir FROM platforms WHERE enabled = 1 ORDER BY sort_order, id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(PlatformRow {
            id: row.get(0)?,
            skills_dir: row.get(1)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn scan_root(
    root: &Path,
    platform_id: &str,
    disabled: bool,
    out: &mut Vec<Discovered>,
    errors: &mut Vec<Value>,
) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(original) = icloud_evicted_name(&name) {
            errors.push(json!({
                "path": root.join(original).to_string_lossy(),
                "kind": "icloud_evicted",
                "message": "iCloud has evicted this skill - download it in the file manager, then rescan"
            }));
            continue;
        }
        if name.starts_with('.') && !disabled {
            continue;
        }
        if name == ".disabled" {
            continue;
        }
        let install_path = entry.path();
        let is_symlink = entry.file_type().map(|t| t.is_symlink()).unwrap_or(false);
        let (real_path, is_broken) = if is_symlink {
            match fs::canonicalize(&install_path) {
                Ok(p) => (p, false),
                Err(err) => {
                    errors.push(json!({
                        "path": install_path.to_string_lossy(),
                        "kind": "broken_symlink",
                        "message": err.to_string()
                    }));
                    (install_path.clone(), true)
                }
            }
        } else {
            (install_path.clone(), false)
        };
        if is_broken {
            continue;
        }
        match parse_skill_dir(&real_path) {
            Ok(Some(parsed)) => out.push(Discovered {
                platform_id: platform_id.to_string(),
                install_path: install_path.to_string_lossy().to_string(),
                real_path: real_path.to_string_lossy().to_string(),
                is_symlink,
                is_broken,
                is_disabled: disabled,
                parsed,
            }),
            Ok(None) => {}
            Err(err) => errors.push(json!({
                "path": install_path.to_string_lossy(),
                "kind": error_kind(&err),
                "message": err.message
            })),
        }
    }
}

fn error_kind(err: &AppError) -> &str {
    match err.code.as_str() {
        "MISSING_FRONTMATTER" => "missing_frontmatter",
        "PARSE_ERROR" => "parse_error",
        "ICLOUD_EVICTED" => "icloud_evicted",
        "TOO_LARGE" => "too_large",
        _ => "unreadable",
    }
}

fn reconcile(
    conn: &Connection,
    discovered: &[Discovered],
    scanned_at: i64,
) -> AppResult<ReconcileResult> {
    let mut new_count = 0;
    let mut updated_count = 0;
    let mut added_skill_ids = Vec::new();
    let mut seen_location_ids = std::collections::HashSet::new();
    let mut seen_skill_ids = std::collections::HashSet::new();

    let pre_scan_skill_ids = {
        let mut stmt = conn.prepare("SELECT id FROM skills")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<std::collections::HashSet<_>, _>>()?
    };

    let tx = conn.unchecked_transaction()?;
    {
        let mut find_skill = tx.prepare(
            "SELECT id, content_hash FROM skills WHERE name = ?1 AND source_key = 'local'",
        )?;
        let mut insert_skill = tx.prepare(
            "INSERT INTO skills
             (id, name, source_key, description, version, author, license, body_excerpt, content_hash, size_bytes, file_count, created_at, updated_at, last_scanned_at)
             VALUES (?1, ?2, 'local', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?11)",
        )?;
        let mut update_skill = tx.prepare(
            "UPDATE skills SET
               description = ?1,
               version = ?2,
               author = ?3,
               license = ?4,
               body_excerpt = ?5,
               content_hash = ?6,
               size_bytes = ?7,
               file_count = ?8,
               updated_at = ?9,
               last_scanned_at = ?10
             WHERE id = ?11",
        )?;
        let mut touch_skill = tx.prepare("UPDATE skills SET last_scanned_at = ?1 WHERE id = ?2")?;
        let mut find_location = tx.prepare(
            "SELECT id FROM skill_locations WHERE platform_id = ?1 AND install_path = ?2",
        )?;
        let mut insert_location = tx.prepare(
            "INSERT INTO skill_locations
             (skill_id, platform_id, install_path, real_path, is_symlink, is_broken_link, is_disabled, content_hash, mtime, last_seen_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )?;
        let mut update_location = tx.prepare(
            "UPDATE skill_locations SET
               skill_id = ?1,
               real_path = ?2,
               is_symlink = ?3,
               is_broken_link = ?4,
               is_disabled = ?5,
               content_hash = ?6,
               mtime = ?7,
               last_seen_at = ?8
             WHERE id = ?9",
        )?;

        for d in discovered {
            let existing: Option<(String, String)> = find_skill
                .query_row(params![d.parsed.name], |r| Ok((r.get(0)?, r.get(1)?)))
                .ok();
            let skill_id = if let Some((skill_id, content_hash)) = existing {
                if content_hash != d.parsed.content_hash {
                    update_skill.execute(params![
                        d.parsed.description,
                        d.parsed.version,
                        d.parsed.author,
                        d.parsed.license,
                        d.parsed.body_excerpt,
                        d.parsed.content_hash,
                        d.parsed.size_bytes,
                        d.parsed.file_count,
                        scanned_at,
                        scanned_at,
                        skill_id
                    ])?;
                    updated_count += 1;
                } else {
                    touch_skill.execute(params![scanned_at, skill_id])?;
                }
                skill_id
            } else {
                let skill_id = Uuid::new_v4().to_string();
                insert_skill.execute(params![
                    skill_id,
                    d.parsed.name,
                    d.parsed.description,
                    d.parsed.version,
                    d.parsed.author,
                    d.parsed.license,
                    d.parsed.body_excerpt,
                    d.parsed.content_hash,
                    d.parsed.size_bytes,
                    d.parsed.file_count,
                    scanned_at
                ])?;
                new_count += 1;
                added_skill_ids.push(skill_id.clone());
                skill_id
            };
            seen_skill_ids.insert(skill_id.clone());

            let existing_location: Option<i64> = find_location
                .query_row(params![d.platform_id, d.install_path], |r| r.get(0))
                .ok();
            if let Some(location_id) = existing_location {
                update_location.execute(params![
                    skill_id,
                    d.real_path,
                    d.is_symlink as i64,
                    d.is_broken as i64,
                    d.is_disabled as i64,
                    d.parsed.content_hash,
                    d.parsed.mtime,
                    scanned_at,
                    location_id
                ])?;
                seen_location_ids.insert(location_id);
            } else {
                insert_location.execute(params![
                    skill_id,
                    d.platform_id,
                    d.install_path,
                    d.real_path,
                    d.is_symlink as i64,
                    d.is_broken as i64,
                    d.is_disabled as i64,
                    d.parsed.content_hash,
                    d.parsed.mtime,
                    scanned_at
                ])?;
                seen_location_ids.insert(tx.last_insert_rowid());
            }
        }
    }

    let all_location_ids = {
        let mut stmt = tx.prepare("SELECT id FROM skill_locations")?;
        let rows = stmt.query_map([], |r| r.get::<_, i64>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for location_id in all_location_ids
        .into_iter()
        .filter(|id| !seen_location_ids.contains(id))
    {
        tx.execute(
            "DELETE FROM skill_locations WHERE id = ?1",
            params![location_id],
        )?;
    }
    tx.execute(
        "DELETE FROM skills
         WHERE id NOT IN (SELECT DISTINCT skill_id FROM skill_locations)
           AND id NOT IN (SELECT DISTINCT skill_id FROM skill_scenarios)",
        [],
    )?;
    tx.commit()?;

    let mut removed = 0;
    for id in pre_scan_skill_ids {
        if seen_skill_ids.contains(&id) {
            continue;
        }
        let still_there: Option<i64> = conn
            .query_row("SELECT 1 FROM skills WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .ok();
        if still_there.is_none() {
            removed += 1;
        }
    }
    Ok(ReconcileResult {
        new_count,
        updated_count,
        removed_count: removed,
        added_skill_ids,
    })
}

fn icloud_evicted_name(name: &str) -> Option<&str> {
    name.strip_prefix('.')
        .and_then(|rest| rest.strip_suffix(".icloud"))
        .filter(|original| !original.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counts(result: ReconcileResult) -> (i64, i64, i64) {
        (result.new_count, result.updated_count, result.removed_count)
    }

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            r#"
            CREATE TABLE skills (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              source_key TEXT NOT NULL DEFAULT 'local',
              description TEXT,
              version TEXT,
              author TEXT,
              license TEXT,
              body_excerpt TEXT,
              content_hash TEXT NOT NULL,
              size_bytes INTEGER NOT NULL DEFAULT 0,
              file_count INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              last_scanned_at INTEGER NOT NULL,
              UNIQUE(name, source_key)
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
              content_hash TEXT,
              mtime INTEGER,
              last_seen_at INTEGER NOT NULL,
              UNIQUE(platform_id, install_path)
            );
            CREATE TABLE skill_scenarios (
              skill_id TEXT NOT NULL,
              scenario_id INTEGER NOT NULL,
              added_at INTEGER NOT NULL,
              PRIMARY KEY (skill_id, scenario_id)
            );
            CREATE TABLE platforms (
              id TEXT PRIMARY KEY,
              label TEXT NOT NULL,
              skills_dir TEXT NOT NULL,
              is_builtin INTEGER NOT NULL DEFAULT 0,
              enabled INTEGER NOT NULL DEFAULT 1,
              sort_order INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE scan_runs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              started_at INTEGER NOT NULL,
              finished_at INTEGER,
              total_found INTEGER NOT NULL DEFAULT 0,
              new_count INTEGER NOT NULL DEFAULT 0,
              updated_count INTEGER NOT NULL DEFAULT 0,
              removed_count INTEGER NOT NULL DEFAULT 0,
              duration_ms INTEGER,
              errors_json TEXT NOT NULL DEFAULT '[]'
            );
            "#,
        )
        .expect("schema");
        conn
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("myskills-scanner-test-{name}-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn write_skill(root: &Path, dirname: &str, skill_name: &str) {
        let skill_dir = root.join(dirname);
        fs::create_dir_all(&skill_dir).expect("create skill dir");
        fs::write(
            skill_dir.join("SKILL.md"),
            format!("---\nname: {skill_name}\ndescription: test skill\n---\nbody\n"),
        )
        .expect("write SKILL.md");
    }

    fn discovered(name: &str, hash: &str, platform: &str, path: &str) -> Discovered {
        Discovered {
            platform_id: platform.to_string(),
            install_path: path.to_string(),
            real_path: path.to_string(),
            is_symlink: false,
            is_broken: false,
            is_disabled: false,
            parsed: parser::ParsedSkill {
                name: name.to_string(),
                description: None,
                version: None,
                author: None,
                license: None,
                body_excerpt: None,
                content_hash: hash.to_string(),
                size_bytes: 10,
                file_count: 1,
                mtime: 1,
            },
        }
    }

    #[test]
    fn reconcile_counts_removed_skills_not_removed_locations() {
        let conn = test_conn();
        let first = vec![
            discovered("Alpha", "hash-a", "claude", "/tmp/claude/alpha"),
            discovered("Alpha", "hash-a", "codex", "/tmp/codex/alpha"),
        ];
        assert_eq!(counts(reconcile(&conn, &first, 100).unwrap()), (1, 0, 0));

        let second = vec![discovered("Alpha", "hash-a", "claude", "/tmp/claude/alpha")];
        assert_eq!(counts(reconcile(&conn, &second, 200).unwrap()), (0, 0, 0));
        let location_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM skill_locations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(location_count, 1);

        let third: Vec<Discovered> = Vec::new();
        assert_eq!(counts(reconcile(&conn, &third, 300).unwrap()), (0, 0, 1));
    }

    #[test]
    fn reconcile_preserves_scenario_orphans_without_counting_removed() {
        let conn = test_conn();
        let first = vec![discovered("Alpha", "hash-a", "claude", "/tmp/claude/alpha")];
        assert_eq!(counts(reconcile(&conn, &first, 100).unwrap()), (1, 0, 0));
        let skill_id: String = conn
            .query_row("SELECT id FROM skills WHERE name = 'Alpha'", [], |r| {
                r.get(0)
            })
            .unwrap();
        conn.execute(
            "INSERT INTO skill_scenarios (skill_id, scenario_id, added_at) VALUES (?1, 1, 100)",
            params![skill_id],
        )
        .unwrap();

        let empty: Vec<Discovered> = Vec::new();
        assert_eq!(counts(reconcile(&conn, &empty, 200).unwrap()), (0, 0, 0));
        let skill_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM skills", [], |r| r.get(0))
            .unwrap();
        assert_eq!(skill_count, 1);
    }

    #[test]
    fn scan_all_reports_platform_progress_for_scanned_and_skipped_platforms() {
        let conn = test_conn();
        let root = temp_dir("progress");
        let missing = root.join("missing");
        let present = root.join("present");
        fs::create_dir_all(&present).expect("create present root");
        write_skill(&present, "alpha", "alpha");
        conn.execute(
            "INSERT INTO platforms (id, label, skills_dir, enabled, sort_order)
             VALUES ('present', 'Present', ?1, 1, 0)",
            params![present.to_string_lossy()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO platforms (id, label, skills_dir, enabled, sort_order)
             VALUES ('missing', 'Missing', ?1, 1, 1)",
            params![missing.to_string_lossy()],
        )
        .unwrap();

        let mut progress = Vec::new();
        let result = scan_all_with_progress(&conn, |event| progress.push(event)).unwrap();

        assert_eq!(result["totalFound"].as_u64(), Some(1));
        assert_eq!(progress.len(), 2);
        assert_eq!(progress[0].platform_id, "present");
        assert_eq!(progress[0].index, 1);
        assert_eq!(progress[0].total, 2);
        assert_eq!(progress[0].found, 1);
        assert!(!progress[0].skipped);
        assert_eq!(progress[1].platform_id, "missing");
        assert_eq!(progress[1].index, 2);
        assert_eq!(progress[1].total, 2);
        assert_eq!(progress[1].found, 0);
        assert!(progress[1].skipped);

        fs::remove_dir_all(root).ok();
    }
}
