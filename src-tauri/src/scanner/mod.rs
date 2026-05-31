pub mod parser;

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::db::now_ms;
use crate::error::{AppError, AppResult};

use self::parser::parse_skill_dir;

pub fn scan_all(conn: &Connection) -> AppResult<Value> {
    let started = now_ms();
    let platforms = list_enabled_platforms(conn)?;
    let mut discovered = Vec::new();
    let mut errors = Vec::new();

    for platform in platforms {
        let root = PathBuf::from(&platform.skills_dir);
        if !root.is_dir() {
            continue;
        }
        scan_root(&root, &platform.id, false, &mut discovered, &mut errors);
        let disabled = root.join(".disabled");
        if disabled.is_dir() {
            scan_root(&disabled, &platform.id, true, &mut discovered, &mut errors);
        }
    }

    let (new_skills, updated_skills, removed_skills) = reconcile(conn, &discovered, started)?;
    let finished = now_ms();
    let result = json!({
        "totalFound": discovered.len(),
        "newSkills": new_skills,
        "updatedSkills": updated_skills,
        "removedSkills": removed_skills,
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
            new_skills,
            updated_skills,
            removed_skills,
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
) -> AppResult<(i64, i64, i64)> {
    let mut new_count = 0;
    let mut updated_count = 0;

    for d in discovered {
        let skill_id = format!("local:{}", d.parsed.name);
        let existing: Option<String> = conn
            .query_row(
                "SELECT content_hash FROM skills WHERE id = ?1",
                params![skill_id],
                |r| r.get(0),
            )
            .ok();
        if existing.is_none() {
            new_count += 1;
        } else if existing != Some(d.parsed.content_hash.clone()) {
            updated_count += 1;
        }
        conn.execute(
            "INSERT INTO skills
             (id, name, source_key, description, version, author, license, body_excerpt, content_hash, size_bytes, file_count, created_at, updated_at, last_scanned_at)
             VALUES (?1, ?2, 'local', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?11)
             ON CONFLICT(id) DO UPDATE SET
               description=excluded.description,
               version=excluded.version,
               author=excluded.author,
               license=excluded.license,
               body_excerpt=excluded.body_excerpt,
               content_hash=excluded.content_hash,
               size_bytes=excluded.size_bytes,
               file_count=excluded.file_count,
               updated_at=CASE WHEN skills.content_hash != excluded.content_hash THEN excluded.updated_at ELSE skills.updated_at END,
               last_scanned_at=excluded.last_scanned_at",
            params![
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
            ],
        )?;
        conn.execute(
            "INSERT INTO skill_locations
             (skill_id, platform_id, install_path, real_path, is_symlink, is_broken_link, is_disabled, content_hash, mtime, last_seen_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(platform_id, install_path) DO UPDATE SET
               skill_id=excluded.skill_id,
               real_path=excluded.real_path,
               is_symlink=excluded.is_symlink,
               is_broken_link=excluded.is_broken_link,
               is_disabled=excluded.is_disabled,
               content_hash=excluded.content_hash,
               mtime=excluded.mtime,
               last_seen_at=excluded.last_seen_at",
            params![
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
            ],
        )?;
    }

    let removed = conn.execute(
        "DELETE FROM skill_locations WHERE last_seen_at < ?1",
        params![scanned_at],
    )? as i64;
    conn.execute(
        "DELETE FROM skills
         WHERE id NOT IN (SELECT DISTINCT skill_id FROM skill_locations)
           AND id NOT IN (SELECT DISTINCT skill_id FROM skill_scenarios)",
        [],
    )?;
    Ok((new_count, updated_count, removed))
}
