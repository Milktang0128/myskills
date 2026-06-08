use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{atomic::Ordering, Arc, Mutex};
use std::time::{Duration, SystemTime};

use arboard::Clipboard;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::{params, types::Value as SqlValue, Connection, OptionalExtension};
use serde_json::Map;
use serde_json::{json, Value};
use sha2::Digest;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::paths::AppPaths;
use crate::scanner;
use crate::scanner::parser::load_skill_body;
use crate::secret_vault;
use crate::state::{AiJob, AppState, StoredPlan};

fn conn(
    state: &State<'_, AppState>,
) -> AppResult<r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>> {
    Ok(state.db.get()?)
}

fn ai_job_to_value(job: &AiJob) -> Value {
    json!({
        "jobId": job.id,
        "kind": job.kind,
        "key": job.key,
        "status": job.status,
        "createdAt": job.created_at,
        "updatedAt": job.updated_at,
        "result": job.result,
        "error": job.error
    })
}

fn ai_job_error_value(err: AppError) -> Value {
    json!({
        "code": err.code,
        "message": err.message,
        "detail": err.detail
    })
}

fn ai_find_active_job(
    jobs: &Arc<Mutex<std::collections::HashMap<String, AiJob>>>,
    kind: &str,
    key: &str,
) -> Option<Value> {
    let jobs = jobs.lock().ok()?;
    jobs.values()
        .filter(|job| {
            job.kind == kind
                && job.key == key
                && matches!(job.status.as_str(), "queued" | "running")
        })
        .max_by_key(|job| job.created_at)
        .map(ai_job_to_value)
}

fn ai_spawn_job<F>(state: &State<'_, AppState>, kind: &str, key: &str, run: F) -> AppResult<Value>
where
    F: FnOnce() -> AppResult<Value> + Send + 'static,
{
    if let Some(job) = ai_find_active_job(&state.ai_jobs, kind, key) {
        return Ok(job);
    }

    let now = now_ms();
    let job = AiJob {
        id: Uuid::new_v4().to_string(),
        kind: kind.to_string(),
        key: key.to_string(),
        status: "queued".to_string(),
        created_at: now,
        updated_at: now,
        result: None,
        error: None,
    };
    let job_id = job.id.clone();
    {
        let mut jobs = state
            .ai_jobs
            .lock()
            .map_err(|_| AppError::new("AI_JOB_STORE_FAILED", "AI job store is unavailable."))?;
        jobs.insert(job_id.clone(), job.clone());
    }

    let jobs = Arc::clone(&state.ai_jobs);
    std::thread::spawn(move || {
        ai_update_job(&jobs, &job_id, "running", None, None);
        match run() {
            Ok(result) => ai_update_job(&jobs, &job_id, "succeeded", Some(result), None),
            Err(err) => ai_update_job(
                &jobs,
                &job_id,
                "failed",
                None,
                Some(ai_job_error_value(err)),
            ),
        }
    });

    Ok(ai_job_to_value(&job))
}

fn ai_update_job(
    jobs: &Arc<Mutex<std::collections::HashMap<String, AiJob>>>,
    job_id: &str,
    status: &str,
    result: Option<Value>,
    error: Option<Value>,
) {
    if let Ok(mut jobs) = jobs.lock() {
        if let Some(job) = jobs.get_mut(job_id) {
            job.status = status.to_string();
            job.updated_at = now_ms();
            job.result = result;
            job.error = error;
        }
        if jobs.len() > 50 {
            let mut completed = jobs
                .values()
                .filter(|job| matches!(job.status.as_str(), "succeeded" | "failed"))
                .map(|job| (job.id.clone(), job.updated_at))
                .collect::<Vec<_>>();
            completed.sort_by_key(|(_, updated_at)| *updated_at);
            let drop_count = jobs.len().saturating_sub(50);
            for (id, _) in completed.into_iter().take(drop_count) {
                jobs.remove(&id);
            }
        }
    }
}

#[tauri::command]
pub fn ai_job_get(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let job_id = required_str(&payload, "jobId")?;
    let jobs = state
        .ai_jobs
        .lock()
        .map_err(|_| AppError::new("AI_JOB_STORE_FAILED", "AI job store is unavailable."))?;
    let job = jobs
        .get(job_id)
        .ok_or_else(|| AppError::new("AI_JOB_NOT_FOUND", "AI job not found."))?;
    Ok(ai_job_to_value(job))
}

#[tauri::command]
pub fn ai_job_latest(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let kind = required_str(&payload, "kind")?;
    let key = payload
        .as_ref()
        .and_then(|p| p.get("key"))
        .and_then(Value::as_str);
    let jobs = state
        .ai_jobs
        .lock()
        .map_err(|_| AppError::new("AI_JOB_STORE_FAILED", "AI job store is unavailable."))?;
    let job = jobs
        .values()
        .filter(|job| job.kind == kind && key.is_none_or(|key| job.key == key))
        .max_by_key(|job| job.created_at)
        .map(ai_job_to_value)
        .unwrap_or(Value::Null);
    Ok(job)
}

fn required_str<'a>(payload: &'a Option<Value>, key: &str) -> AppResult<&'a str> {
    payload
        .as_ref()
        .and_then(|p| p.get(key))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::new("INVALID_INPUT", format!("{key} required")))
}

fn optional_i64(payload: &Option<Value>, key: &str) -> Option<i64> {
    payload
        .as_ref()
        .and_then(|p| p.get(key))
        .and_then(Value::as_i64)
}

fn ok() -> Value {
    json!({ "ok": true })
}

#[derive(Clone)]
struct LocRow {
    id: i64,
    skill_id: String,
    platform_id: String,
    install_path: String,
    real_path: String,
    is_symlink: bool,
    is_broken_link: bool,
    is_disabled: bool,
    content_hash: Option<String>,
    mtime: Option<i64>,
}

struct SuggestionActionRow {
    id: i64,
    skill_id: String,
    scenario_key: String,
    accepted_at: Option<i64>,
    dismissed_at: Option<i64>,
}

struct SyncSkillRow {
    id: String,
    name: String,
}

struct SyncPlatformRow {
    id: String,
    skills_dir: String,
}

#[tauri::command]
pub fn platforms_list(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let _ = payload;
    let db = conn(&state)?;
    let mut stmt = db.prepare("SELECT id, label, skills_dir, is_builtin, enabled, sort_order FROM platforms ORDER BY sort_order, id")?;
    let rows = stmt.query_map([], |row| {
        Ok(json!({
            "id": row.get::<_, String>(0)?,
            "label": row.get::<_, String>(1)?,
            "skillsDir": row.get::<_, String>(2)?,
            "isBuiltin": row.get::<_, i64>(3)? != 0,
            "enabled": row.get::<_, i64>(4)? != 0,
            "sortOrder": row.get::<_, i64>(5)?,
        }))
    })?;
    Ok(Value::Array(rows.collect::<Result<Vec<_>, _>>()?))
}

#[tauri::command]
pub fn platforms_update(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let id = required_str(&payload, "id")?;
    let skills_dir = expand_home(required_str(&payload, "skillsDir")?);
    conn(&state)?.execute(
        "UPDATE platforms SET skills_dir = ?1 WHERE id = ?2",
        params![skills_dir, id],
    )?;
    Ok(ok())
}

#[tauri::command]
pub fn platforms_create(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let id = required_str(&payload, "id")?.trim().to_string();
    let label = required_str(&payload, "label")?.trim().to_string();
    let skills_dir = expand_home(required_str(&payload, "skillsDir")?);
    if !valid_platform_id(&id) {
        return Err(AppError::new(
            "INVALID_INPUT",
            "platform id must be lowercase alphanumeric/underscore/dash, 1-64 chars",
        ));
    }
    let db = conn(&state)?;
    let next: i64 = db.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM platforms",
        [],
        |r| r.get(0),
    )?;
    db.execute(
        "INSERT INTO platforms (id, label, skills_dir, is_builtin, enabled, sort_order) VALUES (?1, ?2, ?3, 0, 1, ?4)",
        params![id, label, skills_dir, next],
    )?;
    let row = db.query_row(
        "SELECT id, label, skills_dir, is_builtin, enabled, sort_order FROM platforms WHERE id = ?1",
        params![id],
        platform_json,
    )?;
    Ok(row)
}

#[tauri::command]
pub fn platforms_delete(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let id = required_str(&payload, "id")?;
    let db = conn(&state)?;
    let builtin: Option<i64> = db
        .query_row(
            "SELECT is_builtin FROM platforms WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(builtin) = builtin else {
        return Err(AppError::new("NOT_FOUND", format!("platform {id}")));
    };
    if builtin != 0 {
        return Err(AppError::new(
            "DELETE_FAILED",
            format!("cannot delete built-in platform {id}"),
        ));
    }
    let tx = db.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM skill_locations WHERE platform_id = ?1",
        params![id],
    )?;
    tx.execute(
        "DELETE FROM skills WHERE id NOT IN (SELECT DISTINCT skill_id FROM skill_locations)",
        [],
    )?;
    tx.execute("DELETE FROM platforms WHERE id = ?1", params![id])?;
    let canonical: Option<String> = tx
        .query_row(
            "SELECT value FROM settings WHERE key = 'canonical_platform'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if canonical.as_deref() == Some(id) {
        tx.execute(
            "INSERT INTO settings (key, value) VALUES ('canonical_platform', 'shared')
             ON CONFLICT(key) DO UPDATE SET value = 'shared'",
            [],
        )?;
    }
    tx.commit()?;
    Ok(ok())
}

#[tauri::command]
pub fn platforms_probe(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let path = expand_home(required_str(&payload, "path")?);
    let p = PathBuf::from(&path);
    let exists = p.is_dir();
    let readable = exists && fs::read_dir(&p).is_ok();
    let mut skill_count = 0;
    if readable {
        if let Ok(entries) = fs::read_dir(&p) {
            for entry in entries.flatten().take(200) {
                let ep = entry.path();
                if ep
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with('.'))
                {
                    continue;
                }
                if ep.join("SKILL.md").is_file() {
                    skill_count += 1;
                }
            }
        }
    }
    let db = conn(&state)?;
    let registered = db
        .prepare("SELECT id, skills_dir FROM platforms")?
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .filter_map(Result::ok)
        .find(|(_, dir)| {
            PathBuf::from(expand_home(dir))
                .canonicalize()
                .unwrap_or_else(|_| PathBuf::from(expand_home(dir)))
                == p.canonicalize().unwrap_or_else(|_| p.clone())
        });
    Ok(json!({
        "resolvedPath": path,
        "exists": exists,
        "readable": readable,
        "skillCount": skill_count,
        "alreadyRegistered": registered.is_some(),
        "registeredAs": registered.map(|r| r.0),
    }))
}

#[tauri::command]
pub async fn platforms_pick_dir(payload: Option<Value>, app: AppHandle) -> AppResult<Value> {
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Select skills folder")
        .set_can_create_directories(true);

    if let Some(start_dir) = payload
        .as_ref()
        .and_then(|p| p.get("startDir"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let start = PathBuf::from(expand_home(start_dir));
        let dir = if start.is_dir() {
            Some(start)
        } else {
            start
                .parent()
                .filter(|parent| parent.is_dir())
                .map(Path::to_path_buf)
        };
        if let Some(dir) = dir {
            dialog = dialog.set_directory(dir);
        }
    }

    let selected = dialog
        .blocking_pick_folder()
        .map(|path| {
            path.into_path()
                .map(|path| path.to_string_lossy().to_string())
                .map_err(|err| AppError::new("PICK_DIR_FAILED", err.to_string()))
        })
        .transpose()?;

    Ok(json!({ "path": selected }))
}

#[tauri::command]
pub fn platforms_known_candidates(payload: Option<Value>) -> AppResult<Value> {
    let _ = payload;
    Ok(json!([
        { "id": "shared", "label": "User Agents Folder", "defaultDir": "~/.agents/skills", "description": "User-scoped folder shared across agent tools" },
        { "id": "claude", "label": "Claude Code", "defaultDir": "~/.claude/skills", "description": "Anthropic's Claude Code CLI" },
        { "id": "codex", "label": "Codex", "defaultDir": "~/.codex/skills", "description": "Codex CLI" },
        { "id": "openclaw", "label": "OpenClaw", "defaultDir": "~/.openclaw/skills", "description": "OpenClaw — open-source Claude-Code-compatible agent" }
    ]))
}

#[tauri::command]
pub fn platforms_open_dir(
    payload: Option<Value>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> AppResult<Value> {
    let id = required_str(&payload, "id")?;
    let path: String = conn(&state)?.query_row(
        "SELECT skills_dir FROM platforms WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )?;
    tauri_plugin_opener::open_path(path.clone(), None::<&str>).map_err(|err| {
        AppError::detail("OPEN_PATH_FAILED", err.to_string(), json!({ "path": path }))
    })?;
    let _ = app;
    Ok(json!({ "ok": true, "path": path }))
}

/// Open an external https URL in the user's default browser. Used by the
/// About section's repository link. Only https URLs are accepted so this can
/// never be coaxed into launching arbitrary local handlers.
#[tauri::command]
pub fn app_open_url(payload: Option<Value>) -> AppResult<Value> {
    let url = required_str(&payload, "url")?.to_string();
    if !url.starts_with("https://") {
        return Err(AppError::new(
            "OPEN_URL_REJECTED",
            "only https URLs are allowed",
        ));
    }
    tauri_plugin_opener::open_url(url.clone(), None::<&str>).map_err(|err| {
        AppError::detail("OPEN_URL_FAILED", err.to_string(), json!({ "url": url }))
    })?;
    Ok(json!({ "ok": true, "url": url }))
}

#[tauri::command]
pub fn settings_get(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let key = required_str(&payload, "key")?;
    let value: Option<String> = conn(&state)?
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |r| r.get(0),
        )
        .optional()?;
    Ok(value.map(Value::String).unwrap_or(Value::Null))
}

#[tauri::command]
pub fn settings_set(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let key = required_str(&payload, "key")?;
    let value = required_str(&payload, "value")?;
    conn(&state)?.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(ok())
}

#[tauri::command]
pub fn settings_stats(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let _ = payload;
    let db = conn(&state)?;
    settings_stats_response(&db, &state.paths.db_path)
}

fn settings_stats_response(db: &Connection, db_path: &Path) -> AppResult<Value> {
    let total: i64 = db.query_row("SELECT COUNT(*) FROM skills", [], |r| r.get(0))?;
    let scenarios: i64 = db.query_row("SELECT COUNT(*) FROM scenarios", [], |r| r.get(0))?;
    let broken: i64 = db.query_row(
        "SELECT COUNT(*) FROM skill_locations WHERE is_broken_link = 1",
        [],
        |r| r.get(0),
    )?;
    let unscenarized: i64 = db.query_row(
        "SELECT COUNT(*) FROM skills WHERE id NOT IN (SELECT skill_id FROM skill_scenarios)",
        [],
        |r| r.get(0),
    )?;
    let disabled: i64 = db.query_row(
        "SELECT COUNT(*) FROM skills s WHERE EXISTS (SELECT 1 FROM skill_locations WHERE skill_id = s.id) AND NOT EXISTS (SELECT 1 FROM skill_locations WHERE skill_id = s.id AND is_disabled = 0)",
        [],
        |r| r.get(0),
    )?;
    let duplicates: i64 = db.query_row(
        "SELECT COUNT(*) FROM skills WHERE content_hash IN (SELECT content_hash FROM skills GROUP BY content_hash HAVING COUNT(*) > 1)",
        [],
        |r| r.get(0),
    )?;
    let mut by_platform = serde_json::Map::new();
    let mut stmt = db.prepare(
        "SELECT platform_id, COUNT(DISTINCT skill_id) FROM skill_locations GROUP BY platform_id",
    )?;
    for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
        let (id, count) = row?;
        by_platform.insert(id, json!(count));
    }
    let last_scan: Option<i64> = db
        .query_row("SELECT finished_at FROM scan_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1", [], |r| r.get(0))
        .optional()?;
    Ok(json!({
        "totalSkills": total,
        "byPlatform": by_platform,
        "scenarios": scenarios,
        "brokenSymlinks": broken,
        "duplicates": duplicates,
        "unscenarized": unscenarized,
        "disabledSkills": disabled,
        "dbPath": db_path.to_string_lossy(),
        "lastScanAt": last_scan,
    }))
}

#[tauri::command]
pub fn settings_cleanup_backups(
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> AppResult<Value> {
    let _ = payload;
    let db = conn(&state)?;
    let days = backup_retention_days(&db)?;
    cleanup_old_backups(&db, &state.paths.backup_root, days)
}

#[tauri::command]
pub fn scan_run(
    payload: Option<Value>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> AppResult<Value> {
    let _ = payload;
    let started_at = now_ms();
    let _ = app.emit("event:scanStarted", json!({ "startedAt": started_at }));
    let db = conn(&state)?;
    let result = scanner::scan_all_with_progress(&db, |progress| {
        let _ = app.emit(
            "event:scanPlatformDone",
            json!({
                "platformId": progress.platform_id,
                "index": progress.index,
                "total": progress.total,
                "found": progress.found,
                "skipped": progress.skipped,
            }),
        );
    })?;
    if let Ok(mut last) = state.last_scan.lock() {
        *last = Some(result.clone());
    }
    enqueue_ai_suggestions(&state, scan_added_skill_ids(&result));
    let _ = app.emit("event:scanFinished", result.clone());
    Ok(result)
}

#[tauri::command]
pub fn scan_last_result(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let _ = payload;
    if let Ok(last) = state.last_scan.lock() {
        if let Some(value) = last.clone() {
            return Ok(value);
        }
    }
    let db = conn(&state)?;
    let row: Option<(i64, i64, i64, i64, i64, i64, String)> = db
        .query_row(
            "SELECT total_found, new_count, updated_count, removed_count, duration_ms, finished_at, errors_json FROM scan_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )
        .optional()?;
    Ok(row
        .map(|r| {
            json!({
                "totalFound": r.0,
                "newSkills": r.1,
                "updatedSkills": r.2,
                "removedSkills": r.3,
                "errors": serde_json::from_str::<Value>(&r.6).unwrap_or_else(|_| json!([])),
                "durationMs": r.4,
                "scannedAt": r.5,
            })
        })
        .unwrap_or(Value::Null))
}

#[tauri::command]
pub fn skills_list(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let db = conn(&state)?;
    skills_list_response(&db, payload.as_ref())
}

fn skills_list_response(db: &Connection, payload: Option<&Value>) -> AppResult<Value> {
    let mut where_sql = Vec::new();
    let mut bind_values: Vec<SqlValue> = Vec::new();
    if let Some(search) = payload
        .and_then(|p| p.get("search"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        where_sql
            .push("(s.name LIKE ? OR s.description LIKE ? OR s.body_excerpt LIKE ?)".to_string());
        let like = format!("%{search}%");
        bind_values.push(SqlValue::Text(like.clone()));
        bind_values.push(SqlValue::Text(like.clone()));
        bind_values.push(SqlValue::Text(like));
    }
    if let Some(platforms) = payload
        .and_then(|p| p.get("platforms"))
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
    {
        let ids = platforms
            .iter()
            .filter_map(Value::as_str)
            .filter(|id| !id.is_empty())
            .collect::<Vec<_>>();
        if !ids.is_empty() {
            let placeholders = std::iter::repeat_n("?", ids.len())
                .collect::<Vec<_>>()
                .join(",");
            where_sql.push(format!(
                "s.id IN (SELECT skill_id FROM skill_locations WHERE platform_id IN ({placeholders}))"
            ));
            bind_values.extend(ids.into_iter().map(|id| SqlValue::Text(id.to_string())));
        }
    }
    if let Some(scenario_id) = payload
        .and_then(|p| p.get("scenarioId"))
        .and_then(Value::as_i64)
    {
        where_sql.push(
            "s.id IN (SELECT skill_id FROM skill_scenarios WHERE scenario_id = ?)".to_string(),
        );
        bind_values.push(SqlValue::Integer(scenario_id));
    }
    if let Some(scope) = payload.and_then(|p| p.get("scope")).and_then(Value::as_str) {
        match scope {
            "broken" => where_sql.push("s.id IN (SELECT skill_id FROM skill_locations WHERE is_broken_link = 1)".to_string()),
            "duplicate" => where_sql.push("s.content_hash IN (SELECT content_hash FROM skills GROUP BY content_hash HAVING COUNT(*) > 1)".to_string()),
            "unscenarized" => where_sql.push("s.id NOT IN (SELECT skill_id FROM skill_scenarios)".to_string()),
            "disabled" => where_sql.push("NOT EXISTS (SELECT 1 FROM skill_locations WHERE skill_id = s.id AND is_disabled = 0)".to_string()),
            _ => {}
        }
    }
    let where_clause = if where_sql.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", where_sql.join(" AND "))
    };
    let order = match payload.and_then(|p| p.get("sort")).and_then(Value::as_str) {
        // Sort by real filesystem times, not DB scan times: on a fresh bulk
        // import every row shares one created_at/updated_at (the scan moment),
        // so those degenerate to ties. "recently modified" → max location
        // mtime; "recently added" → max location birthtime. Both fall back to
        // the DB column for legacy rows not yet rescanned.
        Some("updated") => "ORDER BY COALESCE((SELECT MAX(mtime) FROM skill_locations WHERE skill_id = s.id), s.updated_at) DESC, s.name COLLATE NOCASE",
        Some("created") => "ORDER BY COALESCE((SELECT MAX(birthtime) FROM skill_locations WHERE skill_id = s.id), s.created_at) DESC, s.name COLLATE NOCASE",
        Some("mtime") => "ORDER BY COALESCE((SELECT MAX(mtime) FROM skill_locations WHERE skill_id = s.id), 0) DESC, s.name COLLATE NOCASE",
        _ => "ORDER BY s.name COLLATE NOCASE",
    };
    let sql = format!("SELECT s.id FROM skills s {where_clause} {order}");
    let mut stmt = db.prepare(&sql)?;
    let ids = stmt
        .query_map(rusqlite::params_from_iter(bind_values), |r| {
            r.get::<_, String>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    load_skills(db, &ids)
}

#[tauri::command]
pub fn skills_get(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let id = required_str(&payload, "id")?.to_string();
    let db = conn(&state)?;
    let mut items = load_skills(&db, std::slice::from_ref(&id))?;
    let Some(mut skill) = items.as_array_mut().and_then(|a| a.pop()) else {
        return Err(AppError::new("NOT_FOUND", format!("skill {id}")));
    };
    if let Some(loc) = skill["locations"].as_array().and_then(|a| a.first()) {
        if let Some(real) = loc.get("realPath").and_then(Value::as_str) {
            if let Some(body) = load_skill_body(real) {
                skill["bodyExcerpt"] = Value::String(body);
            }
        }
    }
    Ok(skill)
}

#[tauri::command]
pub fn skills_open_location(
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> AppResult<Value> {
    let db = conn(&state)?;
    let (path, kind) = location_action(&db, &payload)?;
    if kind == "target" {
        tauri_plugin_opener::open_path(path.clone(), None::<&str>).map_err(|err| {
            AppError::detail("OPEN_PATH_FAILED", err.to_string(), json!({ "path": path }))
        })?;
    } else {
        tauri_plugin_opener::reveal_item_in_dir(Path::new(&path)).map_err(|err| {
            AppError::detail("OPEN_PATH_FAILED", err.to_string(), json!({ "path": path }))
        })?;
    }
    Ok(json!({ "ok": true, "path": path }))
}

#[tauri::command]
pub fn skills_copy_location_path(
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> AppResult<Value> {
    let db = conn(&state)?;
    let path = location_action_path(&db, &payload)?;
    if let Ok(mut clipboard) = Clipboard::new() {
        let _ = clipboard.set_text(path.clone());
    }
    Ok(json!({ "ok": true, "path": path }))
}

/// Read the effective SKILL.md text at a location (following symlinks). Used by
/// the 需要确认 drawer to show a read-only diff between diverging copies. Read
/// ONLY — it never writes, so it is safe to expose for comparison.
#[tauri::command]
pub fn skills_read_location(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let db = conn(&state)?;
    let id = optional_i64(&payload, "locationId")
        .ok_or_else(|| AppError::new("INVALID_INPUT", "locationId required"))?;
    let install: String = db.query_row(
        "SELECT install_path FROM skill_locations WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )?;
    let skill_md = Path::new(&install).join("SKILL.md");
    let content = std::fs::read_to_string(&skill_md).map_err(|err| {
        AppError::detail(
            "READ_FAILED",
            err.to_string(),
            json!({ "path": skill_md.to_string_lossy() }),
        )
    })?;
    Ok(json!({ "content": content, "path": skill_md.to_string_lossy() }))
}

#[tauri::command]
pub fn scenarios_list(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let _ = payload;
    let db = conn(&state)?;
    let mut stmt = db.prepare(
        "SELECT sc.id, sc.key, sc.name, sc.description, sc.color, sc.icon, sc.sort_order, sc.is_builtin,
                (SELECT COUNT(*) FROM skill_scenarios ss WHERE ss.scenario_id = sc.id)
         FROM scenarios sc ORDER BY sc.sort_order, sc.name",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(json!({
            "id": r.get::<_, i64>(0)?,
            "key": r.get::<_, String>(1)?,
            "name": r.get::<_, String>(2)?,
            "description": r.get::<_, Option<String>>(3)?,
            "color": r.get::<_, Option<String>>(4)?,
            "icon": r.get::<_, Option<String>>(5)?,
            "sortOrder": r.get::<_, i64>(6)?,
            "isBuiltin": r.get::<_, i64>(7)? != 0,
            "skillCount": r.get::<_, i64>(8)?,
        }))
    })?;
    Ok(Value::Array(rows.collect::<Result<Vec<_>, _>>()?))
}

#[tauri::command]
pub fn scenarios_create(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let p = payload.ok_or_else(|| AppError::new("INVALID_INPUT", "payload required"))?;
    let name = p
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::new("INVALID_INPUT", "name required"))?;
    let key = p
        .get("key")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| slugify(name));
    if !valid_scenario_key(&key) {
        return Err(AppError::new("INVALID_INPUT", "key must be kebab-case"));
    }
    let db = conn(&state)?;
    let sort_order = p.get("sortOrder").and_then(Value::as_i64).unwrap_or(999);
    db.execute(
        "INSERT INTO scenarios (key, name, description, color, icon, sort_order, is_builtin, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)",
        params![
            key,
            name,
            p.get("description").and_then(Value::as_str),
            p.get("color").and_then(Value::as_str),
            p.get("icon").and_then(Value::as_str),
            sort_order,
            now_ms()
        ],
    )?;
    let id = db.last_insert_rowid();
    scenario_by_id(&db, id)
}

#[tauri::command]
pub fn scenarios_update(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let p = payload.ok_or_else(|| AppError::new("INVALID_INPUT", "payload required"))?;
    let id = p
        .get("id")
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::new("INVALID_INPUT", "id required"))?;
    let db = conn(&state)?;
    db_update_scenario(&db, id, &p)?;
    scenario_by_id(&db, id)
}

#[tauri::command]
pub fn scenarios_delete(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let id = optional_i64(&payload, "id")
        .ok_or_else(|| AppError::new("INVALID_INPUT", "id required"))?;
    let db = conn(&state)?;
    let builtin: i64 = db.query_row(
        "SELECT is_builtin FROM scenarios WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )?;
    if builtin != 0 {
        return Err(AppError::new(
            "DELETE_FAILED",
            "built-in scenario cannot be deleted",
        ));
    }
    db.execute("DELETE FROM scenarios WHERE id = ?1", params![id])?;
    Ok(ok())
}

#[tauri::command]
pub fn scenarios_add_skill(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let p = payload.ok_or_else(|| AppError::new("INVALID_INPUT", "payload required"))?;
    let skill = p
        .get("skillId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new("INVALID_INPUT", "skillId required"))?;
    let scenario = p
        .get("scenarioId")
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::new("INVALID_INPUT", "scenarioId required"))?;
    conn(&state)?.execute(
        "INSERT OR IGNORE INTO skill_scenarios (skill_id, scenario_id, added_at) VALUES (?1, ?2, ?3)",
        params![skill, scenario, now_ms()],
    )?;
    Ok(ok())
}

#[tauri::command]
pub fn scenarios_remove_skill(
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> AppResult<Value> {
    let p = payload.ok_or_else(|| AppError::new("INVALID_INPUT", "payload required"))?;
    let skill = p
        .get("skillId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new("INVALID_INPUT", "skillId required"))?;
    let scenario = p
        .get("scenarioId")
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::new("INVALID_INPUT", "scenarioId required"))?;
    conn(&state)?.execute(
        "DELETE FROM skill_scenarios WHERE skill_id = ?1 AND scenario_id = ?2",
        params![skill, scenario],
    )?;
    Ok(ok())
}

#[tauri::command]
pub fn scenarios_export(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let _ = payload;
    let db = conn(&state)?;
    scenarios_export_response(&db)
}

pub(crate) fn scenarios_export_response(db: &Connection) -> AppResult<Value> {
    let scenario_rows = db
        .prepare("SELECT id, key, name, description, color, icon FROM scenarios ORDER BY sort_order, name")?
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut scenarios = Vec::new();
    for (id, key, name, description, color, icon) in scenario_rows {
        let skills = db
            .prepare(
                "SELECT s.name, s.source_key
                 FROM skill_scenarios ss
                 JOIN skills s ON s.id = ss.skill_id
                 WHERE ss.scenario_id = ?1
                 ORDER BY s.name COLLATE NOCASE",
            )?
            .query_map(params![id], |r| {
                Ok(json!({
                    "name": r.get::<_, String>(0)?,
                    "sourceKey": r.get::<_, String>(1)?,
                }))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        scenarios.push(json!({
            "key": key,
            "name": name,
            "description": description,
            "color": color,
            "icon": icon,
            "skills": skills,
        }));
    }
    Ok(json!({ "version": "1", "exportedAt": now_ms(), "scenarios": scenarios }))
}

#[tauri::command]
pub fn scenarios_import(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let p = payload.ok_or_else(|| AppError::new("INVALID_INPUT", "export payload required"))?;
    let mut db = conn(&state)?;
    scenarios_import_payload(&mut db, &p)
}

pub(crate) fn scenarios_import_payload(db: &mut Connection, payload: &Value) -> AppResult<Value> {
    if payload.get("version").and_then(Value::as_str) != Some("1") {
        let version = payload.get("version").cloned().unwrap_or(Value::Null);
        return Err(AppError::new(
            "UNSUPPORTED_VERSION",
            format!("version {version}"),
        ));
    }
    let scenarios = payload
        .get("scenarios")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::new("INVALID_INPUT", "scenarios[] required"))?;
    let tx = db.transaction()?;
    let now = now_ms();
    let mut created = 0;
    let mut merged = 0;
    let mut linked = 0;
    let mut not_found = Vec::new();

    for sc in scenarios {
        let key = sc
            .get("key")
            .and_then(Value::as_str)
            .filter(|s| valid_scenario_key(s))
            .ok_or_else(|| AppError::new("INVALID_INPUT", "scenario key must be kebab-case"))?;
        let name = sc
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::new("INVALID_INPUT", "scenario name required"))?;
        let scenario_id: Option<i64> = tx
            .query_row(
                "SELECT id FROM scenarios WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()?;
        let scenario_id = if let Some(id) = scenario_id {
            merged += 1;
            id
        } else {
            tx.execute(
                "INSERT INTO scenarios (key, name, description, color, icon, sort_order, is_builtin, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 999, 0, ?6)",
                params![
                    key,
                    name,
                    sc.get("description").and_then(Value::as_str),
                    sc.get("color").and_then(Value::as_str),
                    sc.get("icon").and_then(Value::as_str),
                    now
                ],
            )?;
            created += 1;
            tx.last_insert_rowid()
        };

        let skills = sc
            .get("skills")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for sk in skills {
            let Some(skill_name) = sk.get("name").and_then(Value::as_str) else {
                continue;
            };
            let Some(source_key) = sk.get("sourceKey").and_then(Value::as_str) else {
                continue;
            };
            let found: Option<String> = tx
                .query_row(
                    "SELECT id FROM skills WHERE name = ?1 AND source_key = ?2",
                    params![skill_name, source_key],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(skill_id) = found {
                let inserted = tx.execute(
                    "INSERT OR IGNORE INTO skill_scenarios (skill_id, scenario_id, added_at) VALUES (?1, ?2, ?3)",
                    params![skill_id, scenario_id, now],
                )?;
                if inserted > 0 {
                    linked += 1;
                }
            } else {
                not_found.push(json!({
                    "scenarioKey": key,
                    "skillName": skill_name,
                    "sourceKey": source_key,
                }));
            }
        }
    }
    tx.commit()?;
    Ok(json!({
        "scenariosCreated": created,
        "scenariosMerged": merged,
        "skillsLinked": linked,
        "skillsNotFound": not_found,
    }))
}

#[tauri::command]
pub fn scenarios_create_from_cluster(
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> AppResult<Value> {
    let p = payload.ok_or_else(|| AppError::new("INVALID_INPUT", "payload required"))?;
    let name = p
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new("INVALID_INPUT", "name required"))?;
    let skill_ids = p
        .get("skillIds")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut db = conn(&state)?;
    let key = slugify(name);
    if key.is_empty() {
        return Err(AppError::new(
            "INVALID_INPUT",
            format!("cannot derive a key from \"{name}\""),
        ));
    }
    let tx = db.transaction()?;
    let existing: Option<i64> = tx
        .query_row(
            "SELECT id FROM scenarios WHERE key = ?1",
            params![key],
            |r| r.get(0),
        )
        .optional()?;
    let (scenario_id, created) = if let Some(id) = existing {
        (id, false)
    } else {
        tx.execute(
            "INSERT INTO scenarios (key, name, color, sort_order, is_builtin, created_at) VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM scenarios), 0, ?4)",
            params![key, name, p.get("color").and_then(Value::as_str), now_ms()],
        )?;
        (tx.last_insert_rowid(), true)
    };
    // Cluster→scenario conversions don't pick a colour, which used to persist
    // NULL → all-grey dots in the sidebar. Backfill a stable palette colour for
    // any scenario still missing one (covers both freshly-created clusters and
    // older grey scenarios from before this fix — re-running the conversion
    // repairs them). Colour by sort_order so dots stay distinct; the
    // `color IS NULL OR color = ''` guard means a user-picked colour is never
    // overridden. Mirrors the frontend PALETTE in scenario-form.tsx.
    const SCENARIO_PALETTE: [&str; 8] = [
        "#3B82F6", "#10B981", "#F59E0B", "#EC4899", "#8B5CF6", "#6366F1", "#EF4444", "#14B8A6",
    ];
    let sort_order: i64 = tx
        .query_row(
            "SELECT sort_order FROM scenarios WHERE id = ?1",
            params![scenario_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let auto_color = SCENARIO_PALETTE[(sort_order.max(0) as usize) % SCENARIO_PALETTE.len()];
    tx.execute(
        "UPDATE scenarios SET color = ?2 WHERE id = ?1 AND (color IS NULL OR color = '')",
        params![scenario_id, auto_color],
    )?;
    let mut seen = std::collections::HashSet::new();
    let mut linked = 0;
    let mut skipped = 0;
    for id in skill_ids.iter().filter_map(Value::as_str) {
        if !seen.insert(id.to_string()) {
            continue;
        }
        let exists: Option<i64> = tx
            .query_row("SELECT 1 FROM skills WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .optional()?;
        if exists.is_none() {
            skipped += 1;
            continue;
        }
        let inserted = tx.execute(
            "INSERT OR IGNORE INTO skill_scenarios (skill_id, scenario_id, added_at) VALUES (?1, ?2, ?3)",
            params![id, scenario_id, now_ms()],
        )?;
        if inserted > 0 {
            linked += 1;
        } else {
            skipped += 1;
        }
    }
    tx.commit()?;
    Ok(
        json!({ "scenarioId": scenario_id, "created": created, "skillsLinked": linked, "skillsSkipped": skipped }),
    )
}

#[tauri::command]
pub fn coverage_matrix(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let _ = payload;
    let db = conn(&state)?;
    coverage_matrix_response(&db)
}

pub(crate) fn coverage_matrix_response(db: &Connection) -> AppResult<Value> {
    let all_platform_ids = db
        .prepare("SELECT id FROM platforms WHERE enabled = 1 ORDER BY sort_order, id")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let configured = get_setting(db, "canonical_platform")?.unwrap_or_else(|| "shared".to_string());
    let canonical = if all_platform_ids.iter().any(|id| id == &configured) {
        configured
    } else {
        all_platform_ids.first().cloned().unwrap_or(configured)
    };
    let mut platform_ids = Vec::new();
    if !canonical.is_empty() {
        platform_ids.push(canonical.clone());
    }
    platform_ids.extend(all_platform_ids.into_iter().filter(|id| id != &canonical));

    let skill_rows = db
        .prepare(
            "SELECT id, name, source_key, description FROM skills ORDER BY name COLLATE NOCASE",
        )?
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let loc_rows = db
        .prepare(
            "SELECT id, skill_id, platform_id, install_path, real_path, is_symlink, is_broken_link, is_disabled, content_hash, mtime
             FROM skill_locations",
        )?
        .query_map([], |r| {
            Ok(LocRow {
                id: r.get(0)?,
                skill_id: r.get(1)?,
                platform_id: r.get(2)?,
                install_path: r.get(3)?,
                real_path: r.get(4)?,
                is_symlink: r.get::<_, i64>(5)? != 0,
                is_broken_link: r.get::<_, i64>(6)? != 0,
                is_disabled: r.get::<_, i64>(7)? != 0,
                content_hash: r.get(8)?,
                mtime: r.get(9)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut locs_by_skill: std::collections::HashMap<String, Vec<LocRow>> =
        std::collections::HashMap::new();
    for loc in &loc_rows {
        locs_by_skill
            .entry(loc.skill_id.clone())
            .or_default()
            .push(loc.clone());
    }
    let mut owner_candidates = loc_rows.clone();
    owner_candidates.sort_by_key(|loc| {
        if loc.is_symlink {
            30
        } else if loc.platform_id == canonical {
            0
        } else {
            10
        }
    });
    let mut real_path_owner = std::collections::HashMap::new();
    for loc in owner_candidates {
        real_path_owner
            .entry(loc.real_path)
            .or_insert(loc.platform_id);
    }

    let rows = skill_rows.into_iter().map(|(skill_id, name, source_key, description)| {
        let locs = locs_by_skill.get(&skill_id).cloned().unwrap_or_default();
        let mut cells = serde_json::Map::new();
        for p in &platform_ids {
            cells.insert(p.clone(), json!({ "state": "missing" }));
        }
        let canonical_loc = locs
            .iter()
            .find(|loc| loc.platform_id == canonical && !loc.is_disabled);
        let canonical_hash = canonical_loc.and_then(|loc| loc.content_hash.clone());
        let canonical_real_path = canonical_loc.map(|loc| loc.real_path.clone());
        let has_canonical_source = canonical_loc.is_some();
        for loc in locs {
            let state = cell_state_for(
                &loc,
                &real_path_owner,
                &canonical,
                canonical_real_path.as_deref(),
            );
            let mut cell = json!({
                "state": state,
                "locationId": loc.id,
                "installPath": loc.install_path,
                "realPath": loc.real_path,
                "contentHash": loc.content_hash,
                "mtime": loc.mtime,
                "drift": drift_for(&loc, state, &canonical, canonical_hash.as_deref(), canonical_real_path.as_deref(), has_canonical_source),
            });
            if (state == "symlink" || state == "symlink_other")
                && real_path_owner.contains_key(cell["realPath"].as_str().unwrap_or_default())
            {
                cell["resolvesToPlatformId"] = json!(real_path_owner
                    .get(cell["realPath"].as_str().unwrap_or_default())
                    .cloned());
            }
            cells.insert(loc.platform_id, cell);
        }
        let missing: Vec<String> = cells.iter().filter(|(_, c)| c.get("state").and_then(Value::as_str) == Some("missing")).map(|(k, _)| k.clone()).collect();
        let has_drift = cells
            .values()
            .any(|cell| cell.get("drift").and_then(Value::as_str) == Some("stale"));
        json!({
            "skillId": skill_id,
            "skillName": name,
            "sourceKey": source_key,
            "description": description,
            "cells": cells,
            "missingOn": missing,
            "hasCanonicalSource": has_canonical_source,
            "hasDrift": has_drift
        })
    }).collect::<Vec<_>>();
    Ok(json!({ "platforms": platform_ids, "canonicalPlatform": canonical, "rows": rows }))
}

#[tauri::command]
pub fn sync_plan(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let p = payload.unwrap_or_else(|| json!({}));
    let operation = p
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("sync_from_canonical");
    let requests = p
        .get("requests")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::new("INVALID_INPUT", "requests[] required"))?;
    let db = conn(&state)?;
    let plan = match operation {
        "sync_from_canonical" => plan_sync_from_canonical(&db, requests)?,
        "promote_to_canonical" => plan_promote_to_canonical(&db, requests)?,
        "copy_to_platform" => plan_copy_to_platform(&db, requests)?,
        _ => return Err(AppError::new("INVALID_INPUT", "unknown plan kind")),
    };
    store_plan(&state, &plan)?;
    Ok(plan)
}

fn plan_sync_from_canonical(db: &Connection, requests: &[Value]) -> AppResult<Value> {
    let platforms = sync_platforms(db)?;
    let platform_ids = platforms.iter().map(|p| p.id.clone()).collect::<Vec<_>>();
    let canonical = canonical_platform(db, &platform_ids)?;
    let op_group_id = Uuid::new_v4().to_string();
    let mut items = Vec::new();
    for req in requests {
        let Some(skill_id) = req.get("skillId").and_then(Value::as_str) else {
            continue;
        };
        let Some(skill) = sync_skill(db, skill_id)? else {
            continue;
        };
        // Source defaults to the canonical platform, but the caller may name an
        // explicit `sourcePlatformId` — this is how "enable on platform X" links
        // from wherever the skill already lives (e.g. the shared pool) instead
        // of forcing a promote when the canonical platform doesn't have it.
        let source_platform = req
            .get("sourcePlatformId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| canonical.clone());
        let source = sync_location(db, skill_id, &source_platform, false)?;
        let target_ids = req
            .get("targetPlatformIds")
            .and_then(Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| platform_ids.clone());
        let force_replace = req
            .get("forceReplace")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        for target_id in target_ids
            .into_iter()
            .filter(|id| id != &source_platform)
            .filter(|id| platforms.iter().any(|p| p.id == *id))
        {
            let target_platform = platforms.iter().find(|p| p.id == target_id).unwrap();
            let target = sync_location(db, skill_id, &target_id, false)?;
            items.push(build_sync_item(SyncBuildItemArgs {
                skill: &skill,
                source: source.as_ref(),
                target: target.as_ref(),
                source_platform_id: &source_platform,
                target_platform_id: &target_id,
                target_platform_dir: &target_platform.skills_dir,
                op_group_id: &op_group_id,
                override_action: force_replace.then_some("symlink_replace"),
            }));
        }
    }
    Ok(finalize_sync_plan("sync_from_canonical", items))
}

fn plan_promote_to_canonical(db: &Connection, requests: &[Value]) -> AppResult<Value> {
    let platforms = sync_platforms(db)?;
    let platform_ids = platforms.iter().map(|p| p.id.clone()).collect::<Vec<_>>();
    let canonical = canonical_platform(db, &platform_ids)?;
    let Some(canonical_platform) = platforms.iter().find(|p| p.id == canonical) else {
        return Ok(finalize_sync_plan("promote_to_canonical", Vec::new()));
    };
    let mut items = Vec::new();
    for req in requests {
        let Some(skill_id) = req.get("skillId").and_then(Value::as_str) else {
            continue;
        };
        let Some(skill) = sync_skill(db, skill_id)? else {
            continue;
        };
        let locs = sync_locations_for_skill(db, skill_id)?;
        let source = if let Some(id) = req.get("sourceLocationId").and_then(Value::as_i64) {
            locs.iter()
                .find(|loc| loc.id == id && loc.platform_id != canonical && !loc.is_disabled)
                .cloned()
        } else {
            locs.iter()
                .find(|loc| loc.platform_id != canonical && !loc.is_disabled)
                .cloned()
        };
        let Some(source) = source else {
            continue;
        };
        let op_group_id = Uuid::new_v4().to_string();
        let existing_canonical = locs
            .iter()
            .find(|loc| loc.platform_id == canonical && !loc.is_disabled)
            .cloned();
        let copy_item = build_sync_item(SyncBuildItemArgs {
            skill: &skill,
            source: Some(&source),
            target: existing_canonical.as_ref(),
            source_platform_id: &source.platform_id,
            target_platform_id: &canonical,
            target_platform_dir: &canonical_platform.skills_dir,
            op_group_id: &op_group_id,
            override_action: Some("copy_to_canonical"),
        });
        let canonical_target = copy_item
            .get("targetPath")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let basename = copy_item
            .get("targetBasename")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let can_replace =
            copy_item.get("action").and_then(Value::as_str) == Some("copy_to_canonical");
        items.push(copy_item);
        if !can_replace {
            continue;
        }
        for loc in locs
            .iter()
            .filter(|loc| loc.platform_id != canonical && !loc.is_disabled)
        {
            let Some(platform) = platforms.iter().find(|p| p.id == loc.platform_id) else {
                continue;
            };
            let target_path = PathBuf::from(&platform.skills_dir).join(&basename);
            items.push(json!({
                "skillName": skill.name,
                "skillId": skill.id,
                "opGroupId": op_group_id,
                "targetBasename": basename,
                "sourcePlatformId": canonical,
                "sourceLocationId": -1,
                "sourceRealPath": canonical_target,
                "sourceDev": 0,
                "sourceIno": 0,
                "sourceHash": source.content_hash,
                "targetPlatformId": loc.platform_id,
                "targetPath": target_path.to_string_lossy(),
                "targetHash": loc.content_hash,
                "mode": "symlink",
                "action": "symlink_replace"
            }));
        }
    }
    Ok(finalize_sync_plan("promote_to_canonical", items))
}

/// Plan an independent REAL copy of a skill onto a non-source platform. Unlike
/// sync_from_canonical (which links) this writes a real directory, so the user
/// ends up with a second editable copy. The source designation is unchanged —
/// this is the "存放技能副本 / place a real copy here" action. The source must be
/// a real directory (do_copy_item rejects symlinked trees), so we pick the
/// canonical platform's real copy when it has one, else any real copy.
fn plan_copy_to_platform(db: &Connection, requests: &[Value]) -> AppResult<Value> {
    let platforms = sync_platforms(db)?;
    let platform_ids = platforms.iter().map(|p| p.id.clone()).collect::<Vec<_>>();
    let canonical = canonical_platform(db, &platform_ids)?;
    let mut items = Vec::new();
    for req in requests {
        let Some(skill_id) = req.get("skillId").and_then(Value::as_str) else {
            continue;
        };
        let Some(target_id) = req.get("targetPlatformId").and_then(Value::as_str) else {
            continue;
        };
        let Some(skill) = sync_skill(db, skill_id)? else {
            continue;
        };
        let Some(target_platform) = platforms.iter().find(|p| p.id == target_id) else {
            continue;
        };
        let locs = sync_locations_for_skill(db, skill_id)?;
        let source = locs
            .iter()
            .find(|loc| loc.platform_id == canonical && !loc.is_symlink && !loc.is_disabled)
            .or_else(|| locs.iter().find(|loc| !loc.is_symlink && !loc.is_disabled))
            .cloned();
        let Some(source) = source else {
            continue;
        };
        if source.platform_id == target_id {
            continue; // target already holds the real source
        }
        let op_group_id = Uuid::new_v4().to_string();
        let target = sync_location(db, skill_id, target_id, false)?;
        items.push(build_sync_item(SyncBuildItemArgs {
            skill: &skill,
            source: Some(&source),
            target: target.as_ref(),
            source_platform_id: &source.platform_id,
            target_platform_id: target_id,
            target_platform_dir: &target_platform.skills_dir,
            op_group_id: &op_group_id,
            override_action: Some("copy_real"),
        }));
    }
    Ok(finalize_sync_plan("copy_to_platform", items))
}

#[tauri::command]
pub fn sync_plan_toggle_disabled(
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> AppResult<Value> {
    let p = payload.unwrap_or_else(|| json!({}));
    let requests = p
        .get("requests")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::new("INVALID_INPUT", "requests[] required"))?;
    let db = conn(&state)?;
    let platforms = sync_platforms(&db)?;
    let mut items = Vec::new();
    let mut operation = "enable";
    for req in requests {
        let skill_id = req
            .get("skillId")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::new("INVALID_INPUT", "skillId required"))?;
        let location_id = req
            .get("locationId")
            .and_then(Value::as_i64)
            .ok_or_else(|| AppError::new("INVALID_INPUT", "locationId required"))?;
        let disable = req
            .get("disable")
            .and_then(Value::as_bool)
            .ok_or_else(|| AppError::new("INVALID_INPUT", "disable required"))?;
        if disable {
            operation = "disable";
        }
        let Some(skill) = sync_skill(&db, skill_id)? else {
            continue;
        };
        let Some(loc) = sync_location_by_id(&db, location_id)? else {
            continue;
        };
        if loc.skill_id != skill_id {
            continue;
        }
        let Some(platform) = platforms.iter().find(|p| p.id == loc.platform_id) else {
            continue;
        };
        items.push(build_toggle_item(
            &db,
            &skill,
            &loc,
            &platform.skills_dir,
            disable,
        )?);
    }
    let plan = finalize_sync_plan(operation, items);
    store_plan(&state, &plan)?;
    Ok(plan)
}

#[tauri::command]
pub fn sync_execute(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let token = required_str(&payload, "token")?;
    let _lock = state
        .sync_lock
        .lock()
        .map_err(|_| AppError::new("SYNC_LOCK_POISONED", "sync lock poisoned"))?;
    let stored = state
        .plan_store
        .lock()
        .map_err(|_| AppError::new("PLAN_STORE_POISONED", "plan store poisoned"))?
        .remove(token)
        .ok_or_else(|| AppError::new("PLAN_EXPIRED", "sync plan token is missing or expired"))?;
    if stored.expires_at <= SystemTime::now() {
        return Err(AppError::new(
            "PLAN_EXPIRED",
            "sync plan token is missing or expired",
        ));
    }
    let db = conn(&state)?;
    let plan = stored.plan;
    let plan_json = serde_json::to_string(&plan)
        .map_err(|err| AppError::new("SERIALIZE_FAILED", err.to_string()))?;
    let items = plan
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let result = execute_sync_items(&db, &state.paths.backup_root, items, &plan_json)?;
    let scan = scanner::scan_all(&db)?;
    if let Ok(mut last) = state.last_scan.lock() {
        *last = Some(scan.clone());
    }
    enqueue_ai_suggestions(&state, scan_added_skill_ids(&scan));
    Ok(result)
}

pub(crate) fn execute_sync_items(
    db: &Connection,
    backup_root: &Path,
    items: Vec<Value>,
    plan_json: &str,
) -> AppResult<Value> {
    let mut applied = Vec::new();
    let mut skipped = Vec::new();
    let mut failed = Vec::new();
    let mut aborted_groups = std::collections::HashSet::new();
    // Newest applied history id per op-group → one undo handle per user action.
    // Drives the "undo" affordance on safe-instant toggles; rolling back any one
    // id sweeps its whole group, so one representative per group is enough.
    let mut undo_by_group: std::collections::HashMap<String, i64> = std::collections::HashMap::new();

    for item in items {
        let group = item
            .get("opGroupId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if aborted_groups.contains(&group) {
            skipped.push(item);
            continue;
        }
        let action = item
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("conflict");
        if action == "skip" || action == "conflict" {
            skipped.push(item);
            continue;
        }
        let history_id = insert_pending_history(db, &item, plan_json)?;
        match execute_sync_item(db, history_id, backup_root, &item) {
            Ok(outcome) => {
                db.execute(
                    "UPDATE sync_history SET success = 1, message = NULL, before_hash = ?1, after_hash = ?2, backup_path = ?3 WHERE id = ?4",
                    params![outcome.before_hash, outcome.after_hash, outcome.backup_path, history_id],
                )?;
                undo_by_group
                    .entry(group)
                    .and_modify(|prev| {
                        if history_id > *prev {
                            *prev = history_id;
                        }
                    })
                    .or_insert(history_id);
                applied.push(item);
            }
            Err(err) => {
                let message = err.message;
                db.execute(
                    "UPDATE sync_history SET success = 0, message = ?1 WHERE id = ?2",
                    params![message, history_id],
                )?;
                failed.push(json!({ "item": item, "message": message }));
                aborted_groups.insert(group);
            }
        }
    }
    let undoable_history_ids: Vec<i64> = undo_by_group.into_values().collect();
    Ok(json!({
        "applied": applied,
        "skipped": skipped,
        "failed": failed,
        "undoableHistoryIds": undoable_history_ids,
    }))
}

#[tauri::command]
pub fn sync_history(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let limit = payload
        .as_ref()
        .and_then(|p| p.get("limit"))
        .and_then(Value::as_i64)
        .unwrap_or(50)
        .clamp(1, 500);
    let db = conn(&state)?;
    let skill_id = payload
        .as_ref()
        .and_then(|p| p.get("skillId"))
        .and_then(Value::as_str);
    let (sql, params): (&str, Vec<SqlValue>) = if let Some(skill_id) = skill_id {
        (
            "SELECT id, skill_id, action, from_path, to_path, platform_id, before_hash, after_hash, backup_path, conflict_resolution, rolled_back_at, success, message, created_at, op_group_id
             FROM sync_history WHERE skill_id = ?1 ORDER BY id DESC LIMIT ?2",
            vec![SqlValue::Text(skill_id.to_string()), SqlValue::Integer(limit)],
        )
    } else {
        (
            "SELECT id, skill_id, action, from_path, to_path, platform_id, before_hash, after_hash, backup_path, conflict_resolution, rolled_back_at, success, message, created_at, op_group_id
             FROM sync_history ORDER BY id DESC LIMIT ?1",
            vec![SqlValue::Integer(limit)],
        )
    };
    let mut stmt = db.prepare(sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(params), |r| {
        let backup_path = r.get::<_, Option<String>>(8)?;
        let backup_orphaned = backup_path
            .as_ref()
            .is_some_and(|path| !PathBuf::from(path).exists());
        Ok(json!({
            "id": r.get::<_, i64>(0)?,
            "skill_id": r.get::<_, String>(1)?,
            "action": r.get::<_, String>(2)?,
            "from_path": r.get::<_, Option<String>>(3)?,
            "to_path": r.get::<_, Option<String>>(4)?,
            "platform_id": r.get::<_, Option<String>>(5)?,
            "before_hash": r.get::<_, Option<String>>(6)?,
            "after_hash": r.get::<_, Option<String>>(7)?,
            "backup_path": backup_path,
            "conflict_resolution": r.get::<_, Option<String>>(9)?,
            "rolled_back_at": r.get::<_, Option<i64>>(10)?,
            "success": r.get::<_, i64>(11)?,
            "message": r.get::<_, Option<String>>(12)?,
            "created_at": r.get::<_, i64>(13)?,
            "op_group_id": r.get::<_, Option<String>>(14)?,
            "backup_orphaned": backup_orphaned
        }))
    })?;
    Ok(Value::Array(rows.collect::<Result<Vec<_>, _>>()?))
}

#[tauri::command]
pub fn sync_rollback(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let history_id = optional_i64(&payload, "historyId")
        .ok_or_else(|| AppError::new("INVALID_INPUT", "historyId required"))?;
    let db = conn(&state)?;
    let target: Option<(i64, Option<String>, i64, Option<i64>)> = db
        .query_row(
            "SELECT id, op_group_id, success, rolled_back_at FROM sync_history WHERE id = ?1",
            params![history_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((id, op_group_id, success, rolled_back_at)) = target else {
        return Err(AppError::new("NOT_FOUND", format!("history {history_id}")));
    };
    if success == 0 {
        return Err(AppError::new(
            "INVALID_STATE",
            "cannot rollback a failed write",
        ));
    }
    if rolled_back_at.is_some() {
        return Err(AppError::new("INVALID_STATE", "already rolled back"));
    }

    let rows = rollback_rows(&db, id, op_group_id.as_deref())?;
    let rolled_back = rollback_history_rows(&db, &rows, || {
        let _ = scanner::scan_all(&db).map(|scan| {
            if let Ok(mut last) = state.last_scan.lock() {
                *last = Some(scan.clone());
            }
            enqueue_ai_suggestions(&state, scan_added_skill_ids(&scan));
        });
    })?;
    let scan = scanner::scan_all(&db)?;
    if let Ok(mut last) = state.last_scan.lock() {
        *last = Some(scan.clone());
    }
    enqueue_ai_suggestions(&state, scan_added_skill_ids(&scan));
    Ok(json!({ "ok": true, "rolledBack": rolled_back }))
}

pub(crate) fn rollback_history_group(db: &Connection, op_group_id: &str) -> AppResult<usize> {
    let rows = rollback_rows(db, -1, Some(op_group_id))?;
    rollback_history_rows(db, &rows, || {})
}

struct RollbackRow {
    id: i64,
    action: String,
    from_path: Option<String>,
    to_path: Option<String>,
    backup_path: Option<String>,
}

fn rollback_rows(
    db: &Connection,
    history_id: i64,
    op_group_id: Option<&str>,
) -> AppResult<Vec<RollbackRow>> {
    if let Some(group) = op_group_id {
        let mut stmt = db.prepare(
            "SELECT id, action, from_path, to_path, backup_path
             FROM sync_history
             WHERE op_group_id = ?1 AND success = 1 AND rolled_back_at IS NULL
             ORDER BY id DESC",
        )?;
        let rows = stmt.query_map(params![group], rollback_row_from_sql)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    } else {
        let row = db.query_row(
            "SELECT id, action, from_path, to_path, backup_path
             FROM sync_history WHERE id = ?1",
            params![history_id],
            rollback_row_from_sql,
        )?;
        Ok(vec![row])
    }
}

fn rollback_row_from_sql(r: &rusqlite::Row<'_>) -> rusqlite::Result<RollbackRow> {
    Ok(RollbackRow {
        id: r.get(0)?,
        action: r.get(1)?,
        from_path: r.get(2)?,
        to_path: r.get(3)?,
        backup_path: r.get(4)?,
    })
}

fn rollback_one_row(row: &RollbackRow) -> AppResult<()> {
    match row.action.as_str() {
        "symlink_create" | "symlink_replace" => rollback_symlink_row(row),
        "disable" | "enable" => rollback_move_row(row),
        "copy_to_canonical" | "copy_real" => rollback_copy_row(row),
        action => Err(AppError::new(
            "UNSUPPORTED",
            format!("rollback unsupported for action={action}"),
        )),
    }
}

fn rollback_history_rows<F>(
    db: &Connection,
    rows: &[RollbackRow],
    mut on_error: F,
) -> AppResult<usize>
where
    F: FnMut(),
{
    let mark_time = now_ms();
    let mut rolled_back = 0;
    for row in rows {
        if let Err(err) = rollback_one_row(row) {
            on_error();
            return Err(AppError::new(
                err.code,
                format!("Row {}: {}", row.id, err.message),
            ));
        }
        db.execute(
            "UPDATE sync_history SET rolled_back_at = ?1 WHERE id = ?2",
            params![mark_time, row.id],
        )?;
        rolled_back += 1;
    }
    Ok(rolled_back)
}

fn rollback_symlink_row(row: &RollbackRow) -> AppResult<()> {
    let to = required_history_path(row.to_path.as_deref(), "to_path")?;
    match fs::symlink_metadata(&to) {
        Ok(meta) if meta.file_type().is_symlink() => {
            if let Some(from) = &row.from_path {
                let resolved = fs::canonicalize(&to).map_err(|_| {
                    AppError::new(
                        "UNSAFE",
                        format!(
                            "{} is a broken symlink - refusing to rollback",
                            to.display()
                        ),
                    )
                })?;
                let expected = fs::canonicalize(from).unwrap_or_else(|_| PathBuf::from(from));
                if resolved != expected {
                    return Err(AppError::new(
                        "UNSAFE",
                        format!(
                            "{} now points to {}, not {} - refusing to rollback",
                            to.display(),
                            resolved.display(),
                            expected.display()
                        ),
                    ));
                }
            }
            fs::remove_file(&to)?;
        }
        Ok(_) => {
            return Err(AppError::new(
                "UNSAFE",
                format!(
                    "{} is no longer a symlink - refusing to rollback",
                    to.display()
                ),
            ));
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err.into()),
    }
    if let Some(backup) = &row.backup_path {
        restore_sync_backup(Path::new(backup), &to)?;
    }
    Ok(())
}

fn rollback_move_row(row: &RollbackRow) -> AppResult<()> {
    let from = required_history_path(row.from_path.as_deref(), "from_path")?;
    let to = required_history_path(row.to_path.as_deref(), "to_path")?;
    match fs::symlink_metadata(&to) {
        Ok(_) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err.into()),
    }
    if path_exists_lstat(&from) {
        return Err(AppError::new(
            "UNSAFE",
            format!(
                "{} already exists - refusing to reverse the move",
                from.display()
            ),
        ));
    }
    if let Some(parent) = from.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(&to, &from)?;
    Ok(())
}

fn rollback_copy_row(row: &RollbackRow) -> AppResult<()> {
    let to = required_history_path(row.to_path.as_deref(), "to_path")?;
    match fs::symlink_metadata(&to) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(AppError::new(
                "UNSAFE",
                format!(
                    "{} is unexpectedly a symlink - refusing to rollback",
                    to.display()
                ),
            ));
        }
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(&to)?,
        Ok(_) => fs::remove_file(&to)?,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err.into()),
    }
    if let Some(backup) = &row.backup_path {
        restore_sync_backup(Path::new(backup), &to)?;
    }
    Ok(())
}

fn required_history_path(value: Option<&str>, field: &str) -> AppResult<PathBuf> {
    value
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| AppError::new("UNSAFE", format!("history row missing {field}")))
}

fn restore_sync_backup(backup: &Path, target: &Path) -> AppResult<()> {
    if !path_exists_lstat(backup) {
        return Err(AppError::new(
            "BACKUP_MISSING",
            format!("backup not found: {}", backup.display()),
        ));
    }
    if path_exists_lstat(target) {
        let conflict = target.with_file_name(format!(
            "{}.myskills-conflict-{}",
            target
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("target"),
            Uuid::new_v4()
                .to_string()
                .chars()
                .take(8)
                .collect::<String>()
        ));
        fs::rename(target, conflict)?;
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    match fs::rename(backup, target) {
        Ok(_) => Ok(()),
        Err(_) => {
            let meta = fs::symlink_metadata(backup)?;
            if meta.file_type().is_symlink() {
                let link = fs::read_link(backup)?;
                create_dir_symlink(&link, target)?;
                fs::remove_file(backup)?;
            } else if meta.is_dir() {
                copy_tree(backup, target)?;
                fs::remove_dir_all(backup)?;
            } else {
                fs::copy(backup, target)?;
                fs::remove_file(backup)?;
            }
            Ok(())
        }
    }
}

fn path_exists_lstat(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

struct ExecuteOutcome {
    before_hash: Option<String>,
    after_hash: Option<String>,
    backup_path: Option<String>,
}

fn finalize_sync_plan(operation: &str, items: Vec<Value>) -> Value {
    let token = Uuid::new_v4().to_string();
    let now = now_ms();
    json!({
        "token": token,
        "generatedAt": now,
        "expiresAt": now + 5 * 60 * 1000,
        "operation": operation,
        "items": items
    })
}

fn store_plan(state: &State<'_, AppState>, plan: &Value) -> AppResult<()> {
    let token = plan
        .get("token")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new("INVALID_STATE", "plan token missing"))?
        .to_string();
    state.evict_expired_plans();
    let mut store = state
        .plan_store
        .lock()
        .map_err(|_| AppError::new("PLAN_STORE_POISONED", "plan store poisoned"))?;
    store.insert(
        token,
        StoredPlan {
            plan: plan.clone(),
            expires_at: SystemTime::now() + AppState::plan_ttl(),
        },
    );
    Ok(())
}

fn sync_platforms(db: &Connection) -> AppResult<Vec<SyncPlatformRow>> {
    let mut stmt = db.prepare(
        "SELECT id, skills_dir FROM platforms WHERE enabled = 1 ORDER BY sort_order, id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(SyncPlatformRow {
            id: r.get(0)?,
            skills_dir: r.get(1)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn canonical_platform(db: &Connection, enabled: &[String]) -> AppResult<String> {
    let configured = get_setting(db, "canonical_platform")?.unwrap_or_else(|| "shared".to_string());
    if enabled.iter().any(|id| id == &configured) {
        Ok(configured)
    } else {
        Ok(enabled.first().cloned().unwrap_or(configured))
    }
}

fn sync_skill(db: &Connection, skill_id: &str) -> AppResult<Option<SyncSkillRow>> {
    Ok(db
        .query_row(
            "SELECT id, name FROM skills WHERE id = ?1",
            params![skill_id],
            |r| {
                Ok(SyncSkillRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                })
            },
        )
        .optional()?)
}

fn sync_location(
    db: &Connection,
    skill_id: &str,
    platform_id: &str,
    include_disabled: bool,
) -> AppResult<Option<LocRow>> {
    let disabled_sql = if include_disabled {
        ""
    } else {
        " AND is_disabled = 0"
    };
    Ok(db
        .query_row(
            &format!(
                "SELECT id, skill_id, platform_id, install_path, real_path, is_symlink, is_broken_link, is_disabled, content_hash, mtime
                 FROM skill_locations WHERE skill_id = ?1 AND platform_id = ?2{disabled_sql}"
            ),
            params![skill_id, platform_id],
            loc_row_from_sql,
        )
        .optional()?)
}

fn sync_location_by_id(db: &Connection, id: i64) -> AppResult<Option<LocRow>> {
    Ok(db
        .query_row(
            "SELECT id, skill_id, platform_id, install_path, real_path, is_symlink, is_broken_link, is_disabled, content_hash, mtime
             FROM skill_locations WHERE id = ?1",
            params![id],
            loc_row_from_sql,
        )
        .optional()?)
}

fn sync_locations_for_skill(db: &Connection, skill_id: &str) -> AppResult<Vec<LocRow>> {
    let mut stmt = db.prepare(
        "SELECT id, skill_id, platform_id, install_path, real_path, is_symlink, is_broken_link, is_disabled, content_hash, mtime
         FROM skill_locations WHERE skill_id = ?1",
    )?;
    let rows = stmt.query_map(params![skill_id], loc_row_from_sql)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn loc_row_from_sql(r: &rusqlite::Row<'_>) -> rusqlite::Result<LocRow> {
    Ok(LocRow {
        id: r.get(0)?,
        skill_id: r.get(1)?,
        platform_id: r.get(2)?,
        install_path: r.get(3)?,
        real_path: r.get(4)?,
        is_symlink: r.get::<_, i64>(5)? != 0,
        is_broken_link: r.get::<_, i64>(6)? != 0,
        is_disabled: r.get::<_, i64>(7)? != 0,
        content_hash: r.get(8)?,
        mtime: r.get(9)?,
    })
}

struct SyncBuildItemArgs<'a> {
    skill: &'a SyncSkillRow,
    source: Option<&'a LocRow>,
    target: Option<&'a LocRow>,
    source_platform_id: &'a str,
    target_platform_id: &'a str,
    target_platform_dir: &'a str,
    op_group_id: &'a str,
    override_action: Option<&'a str>,
}

fn build_sync_item(args: SyncBuildItemArgs<'_>) -> Value {
    let SyncBuildItemArgs {
        skill,
        source,
        target,
        source_platform_id,
        target_platform_id,
        target_platform_dir,
        op_group_id,
        override_action,
    } = args;
    let Some(source) = source else {
        return sync_placeholder(
            skill,
            source_platform_id,
            target_platform_id,
            "conflict",
            "canonical_missing",
            op_group_id,
        );
    };
    let basename = Path::new(&source.real_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();
    if !is_safe_basename(&basename) {
        return sync_placeholder(
            skill,
            source_platform_id,
            target_platform_id,
            "conflict",
            "unsafe_target_name",
            op_group_id,
        );
    }
    let target_path = PathBuf::from(target_platform_dir).join(&basename);
    if !target_inside_platform(&target_path, target_platform_dir) {
        return sync_placeholder_with_path(
            skill,
            source_platform_id,
            target_platform_id,
            &target_path,
            "target_outside_root",
            op_group_id,
            &basename,
        );
    }
    if has_case_collision(target_platform_dir, &basename) {
        return sync_placeholder_with_path(
            skill,
            source_platform_id,
            target_platform_id,
            &target_path,
            "case_collision",
            op_group_id,
            &basename,
        );
    }
    let (source_dev, source_ino) = if source.id < 0 {
        (0, 0)
    } else {
        match fs::metadata(&source.real_path) {
            Ok(m) if m.is_dir() => metadata_dev_ino(&m),
            _ => {
                return sync_placeholder_with_path(
                    skill,
                    source_platform_id,
                    target_platform_id,
                    &target_path,
                    "unreadable",
                    op_group_id,
                    &basename,
                )
            }
        }
    };
    let action = override_action
        .map(str::to_string)
        .unwrap_or_else(|| classify_sync_target(&target_path, &source.real_path, source, target));
    let reason = if action == "skip" {
        if target.and_then(|t| t.content_hash.as_deref()) == source.content_hash.as_deref() {
            Some("same_hash")
        } else {
            Some("already_linked")
        }
    } else if action == "conflict" {
        Some("target_exists_file")
    } else {
        None
    };
    json!({
        "skillName": skill.name,
        "skillId": skill.id,
        "opGroupId": op_group_id,
        "targetBasename": basename,
        "sourcePlatformId": source_platform_id,
        "sourceLocationId": source.id,
        "sourceRealPath": source.real_path,
        "sourceDev": source_dev,
        "sourceIno": source_ino,
        "sourceHash": source.content_hash,
        "targetPlatformId": target_platform_id,
        "targetPath": target_path.to_string_lossy(),
        "targetHash": target.and_then(|t| t.content_hash.clone()),
        "mode": "symlink",
        "action": action,
        "reason": reason,
    })
}

fn build_toggle_item(
    db: &Connection,
    skill: &SyncSkillRow,
    loc: &LocRow,
    skills_dir: &str,
    disable: bool,
) -> AppResult<Value> {
    let op_group_id = Uuid::new_v4().to_string();
    if disable && loc.is_disabled {
        return Ok(sync_placeholder(
            skill,
            &loc.platform_id,
            &loc.platform_id,
            "skip",
            "already_disabled",
            &op_group_id,
        ));
    }
    if !disable && !loc.is_disabled {
        return Ok(sync_placeholder(
            skill,
            &loc.platform_id,
            &loc.platform_id,
            "skip",
            "already_enabled",
            &op_group_id,
        ));
    }
    if disable && !loc.is_symlink && canonical_has_dependents(db, loc)? {
        return Ok(sync_placeholder(
            skill,
            &loc.platform_id,
            &loc.platform_id,
            "conflict",
            "canonical_has_dependents",
            &op_group_id,
        ));
    }
    let basename = Path::new(&loc.install_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();
    if !is_safe_basename(&basename) {
        return Ok(sync_placeholder(
            skill,
            &loc.platform_id,
            &loc.platform_id,
            "conflict",
            "unsafe_target_name",
            &op_group_id,
        ));
    }
    let target_path = if disable {
        PathBuf::from(skills_dir).join(".disabled").join(&basename)
    } else {
        PathBuf::from(skills_dir).join(&basename)
    };
    if target_path.exists() || is_broken_symlink(&target_path) {
        return Ok(sync_placeholder_with_path(
            skill,
            &loc.platform_id,
            &loc.platform_id,
            &target_path,
            "target_exists_dir",
            &op_group_id,
            &basename,
        ));
    }
    let (source_dev, source_ino) = fs::symlink_metadata(&loc.install_path)
        .map(|m| metadata_dev_ino(&m))
        .unwrap_or((0, 0));
    Ok(json!({
        "skillName": skill.name,
        "skillId": skill.id,
        "opGroupId": op_group_id,
        "targetBasename": basename,
        "sourcePlatformId": loc.platform_id,
        "sourceLocationId": loc.id,
        "sourceRealPath": loc.install_path,
        "sourceDev": source_dev,
        "sourceIno": source_ino,
        "sourceHash": loc.content_hash,
        "targetPlatformId": loc.platform_id,
        "targetPath": target_path.to_string_lossy(),
        "targetHash": Value::Null,
        "mode": "symlink",
        "action": if disable { "disable" } else { "enable" },
    }))
}

fn canonical_has_dependents(db: &Connection, loc: &LocRow) -> AppResult<bool> {
    let source_real =
        fs::canonicalize(&loc.install_path).unwrap_or_else(|_| PathBuf::from(&loc.real_path));
    let mut stmt = db.prepare(
        "SELECT real_path FROM skill_locations
         WHERE skill_id = ?1 AND id != ?2 AND is_disabled = 0 AND is_symlink = 1",
    )?;
    let rows = stmt.query_map(params![loc.skill_id, loc.id], |r| r.get::<_, String>(0))?;
    for row in rows {
        let real_path = row?;
        let dependent_real =
            fs::canonicalize(&real_path).unwrap_or_else(|_| PathBuf::from(&real_path));
        if dependent_real == source_real {
            return Ok(true);
        }
    }
    Ok(false)
}

fn sync_placeholder(
    skill: &SyncSkillRow,
    source_platform_id: &str,
    target_platform_id: &str,
    action: &str,
    reason: &str,
    op_group_id: &str,
) -> Value {
    json!({
        "skillName": skill.name,
        "skillId": skill.id,
        "opGroupId": op_group_id,
        "targetBasename": "",
        "sourcePlatformId": source_platform_id,
        "sourceLocationId": -1,
        "sourceRealPath": "",
        "sourceDev": 0,
        "sourceIno": 0,
        "sourceHash": Value::Null,
        "targetPlatformId": target_platform_id,
        "targetPath": "",
        "targetHash": Value::Null,
        "mode": "symlink",
        "action": action,
        "reason": reason,
    })
}

fn sync_placeholder_with_path(
    skill: &SyncSkillRow,
    source_platform_id: &str,
    target_platform_id: &str,
    target_path: &Path,
    reason: &str,
    op_group_id: &str,
    basename: &str,
) -> Value {
    let mut item = sync_placeholder(
        skill,
        source_platform_id,
        target_platform_id,
        "conflict",
        reason,
        op_group_id,
    );
    item["targetPath"] = json!(target_path.to_string_lossy());
    item["targetBasename"] = json!(basename);
    item
}

fn classify_sync_target(
    target_path: &Path,
    source_real: &str,
    source: &LocRow,
    target: Option<&LocRow>,
) -> String {
    if let Some(target) = target {
        if target.is_broken_link {
            return "symlink_create".to_string();
        }
        if target.is_symlink {
            if target.real_path == source_real {
                return "skip".to_string();
            }
            return "symlink_replace".to_string();
        }
        if source.content_hash.is_some()
            && target.content_hash.is_some()
            && source.content_hash == target.content_hash
        {
            return "skip".to_string();
        }
        return "symlink_replace".to_string();
    }
    match fs::symlink_metadata(target_path) {
        Ok(meta) if meta.file_type().is_symlink() => match fs::canonicalize(target_path) {
            Ok(real) if real.as_path() == Path::new(source_real) => "skip".to_string(),
            Ok(_) => "symlink_replace".to_string(),
            Err(_) => "symlink_create".to_string(),
        },
        Ok(meta) if meta.is_dir() => "symlink_replace".to_string(),
        Ok(_) => "conflict".to_string(),
        Err(_) => "symlink_create".to_string(),
    }
}

fn insert_pending_history(db: &Connection, item: &Value, plan_json: &str) -> AppResult<i64> {
    db.execute(
        "INSERT INTO sync_history
           (skill_id, action, from_path, to_path, platform_id, before_hash, after_hash, backup_path,
            dry_run_plan, conflict_resolution, success, message, created_at,
            installed_from_source, installed_from_skill_id, op_group_id)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, NULL, ?6, ?7, 0, '_pending_', ?8, ?9, ?10, ?11)",
        params![
            item.get("skillId")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            item.get("action")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            item.get("sourceRealPath").and_then(Value::as_str),
            item.get("targetPath").and_then(Value::as_str),
            item.get("targetPlatformId").and_then(Value::as_str),
            plan_json,
            item.get("action").and_then(Value::as_str),
            now_ms(),
            item.get("installedFromSource").and_then(Value::as_str),
            item.get("installedFromSkillId").and_then(Value::as_str),
            item.get("opGroupId").and_then(Value::as_str),
        ],
    )?;
    Ok(db.last_insert_rowid())
}

fn execute_sync_item(
    db: &Connection,
    history_id: i64,
    backup_root: &Path,
    item: &Value,
) -> AppResult<ExecuteOutcome> {
    match item
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "symlink_create" => do_symlink_item(db, history_id, backup_root, item, false),
        "symlink_replace" => do_symlink_item(db, history_id, backup_root, item, true),
        "copy_to_canonical" | "copy_real" => do_copy_item(db, history_id, backup_root, item),
        "disable" | "enable" => do_move_item(item),
        action => Err(AppError::new(
            "SYNC_EXECUTE_FAILED",
            format!("refusing to execute unknown action: {action}"),
        )),
    }
}

fn do_move_item(item: &Value) -> AppResult<ExecuteOutcome> {
    let from = value_path(item, "sourceRealPath")?;
    let to = value_path(item, "targetPath")?;
    let meta = fs::symlink_metadata(&from)
        .map_err(|_| AppError::new("SOURCE_CHANGED", "source entry disappeared since plan"))?;
    let (dev, ino) = metadata_dev_ino(&meta);
    if item.get("sourceDev").and_then(Value::as_i64).unwrap_or(0) != dev
        || item.get("sourceIno").and_then(Value::as_i64).unwrap_or(0) != ino
    {
        return Err(AppError::new(
            "SOURCE_CHANGED",
            "source entry changed since plan",
        ));
    }
    if to.exists() || is_broken_symlink(&to) {
        return Err(AppError::new("TARGET_EXISTS", "destination already exists"));
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(&from, &to)?;
    Ok(ExecuteOutcome {
        before_hash: item
            .get("sourceHash")
            .and_then(Value::as_str)
            .map(str::to_string),
        after_hash: item
            .get("sourceHash")
            .and_then(Value::as_str)
            .map(str::to_string),
        backup_path: None,
    })
}

fn do_symlink_item(
    db: &Connection,
    history_id: i64,
    backup_root: &Path,
    item: &Value,
    allow_replace: bool,
) -> AppResult<ExecuteOutcome> {
    let source = value_path(item, "sourceRealPath")?;
    let target = value_path(item, "targetPath")?;
    let source_real = fs::canonicalize(&source).map_err(|_| {
        AppError::new(
            "SOURCE_CHANGED",
            "source disappeared since plan was generated",
        )
    })?;
    let meta = fs::metadata(&source_real)?;
    if !meta.is_dir() {
        return Err(AppError::new(
            "SOURCE_CHANGED",
            "source is no longer a directory",
        ));
    }
    let planned_dev = item.get("sourceDev").and_then(Value::as_i64).unwrap_or(0);
    let planned_ino = item.get("sourceIno").and_then(Value::as_i64).unwrap_or(0);
    if planned_dev != 0 || planned_ino != 0 {
        let (dev, ino) = metadata_dev_ino(&meta);
        if dev != planned_dev || ino != planned_ino {
            return Err(AppError::new("SOURCE_CHANGED", "source changed since plan"));
        }
    }
    if let Some(expected_hash) = item.get("sourceHash").and_then(Value::as_str) {
        let current_hash = hash_skill_md(&source_real)?;
        if current_hash != expected_hash {
            return Err(AppError::new(
                "SOURCE_CHANGED",
                "source content changed since plan",
            ));
        }
    }
    reassert_target_in_platform(db, item)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut backup_path = None;
    let mut before_hash = None;
    if target.exists() || is_broken_symlink(&target) {
        let meta = fs::symlink_metadata(&target)?;
        if meta.file_type().is_symlink() {
            if let Ok(resolved) = fs::canonicalize(&target) {
                if resolved == source_real {
                    return Ok(ExecuteOutcome {
                        before_hash: None,
                        after_hash: None,
                        backup_path: None,
                    });
                }
            }
            if !allow_replace {
                return Err(AppError::new(
                    "TARGET_EXISTS",
                    "target is a symlink to a different path",
                ));
            }
        } else if !allow_replace {
            return Err(AppError::new(
                "TARGET_EXISTS",
                "target already exists and replace was not authorized",
            ));
        }
        let backup = create_sync_backup(db, history_id, backup_root, &target, item)?;
        before_hash = hash_skill_md(Path::new(&backup)).ok();
        backup_path = Some(backup);
    }
    let tmp = target.with_file_name(format!(
        "{}.myskills-tmp-{}",
        target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("skill"),
        Uuid::new_v4()
    ));
    if let Err(err) = create_dir_symlink(&source_real, &tmp) {
        return Err(restore_after_failed_replace(
            db,
            history_id,
            &backup_path,
            &target,
            err,
        ));
    }
    if let Err(err) = fs::rename(&tmp, &target) {
        let _ = fs::remove_file(&tmp);
        return Err(restore_after_failed_replace(
            db,
            history_id,
            &backup_path,
            &target,
            err.into(),
        ));
    }
    Ok(ExecuteOutcome {
        before_hash,
        after_hash: item
            .get("sourceHash")
            .and_then(Value::as_str)
            .map(str::to_string),
        backup_path,
    })
}

fn do_copy_item(
    db: &Connection,
    history_id: i64,
    backup_root: &Path,
    item: &Value,
) -> AppResult<ExecuteOutcome> {
    let source = value_path(item, "sourceRealPath")?;
    let target = value_path(item, "targetPath")?;
    let source_real = fs::canonicalize(&source)?;
    let meta = fs::metadata(&source_real)?;
    let (dev, ino) = metadata_dev_ino(&meta);
    let planned_dev = item.get("sourceDev").and_then(Value::as_i64).unwrap_or(0);
    let planned_ino = item.get("sourceIno").and_then(Value::as_i64).unwrap_or(0);
    if (planned_dev != 0 || planned_ino != 0) && (planned_dev != dev || planned_ino != ino) {
        return Err(AppError::new("SOURCE_CHANGED", "source changed since plan"));
    }
    if has_symlink_in_tree(&source_real)? {
        return Err(AppError::new(
            "SOURCE_HAS_SYMLINK",
            "source tree contains a symlink",
        ));
    }
    reassert_target_in_platform(db, item)?;
    let mut backup_path = None;
    let mut before_hash = None;
    if target.exists() || is_broken_symlink(&target) {
        let backup = create_sync_backup(db, history_id, backup_root, &target, item)?;
        before_hash = hash_skill_md(Path::new(&backup)).ok();
        backup_path = Some(backup);
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = target.with_file_name(format!(
        "{}.myskills-copy-{}",
        target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("skill"),
        Uuid::new_v4()
    ));
    if let Err(err) = copy_tree(&source_real, &tmp) {
        let _ = fs::remove_dir_all(&tmp);
        return Err(restore_after_failed_replace(
            db,
            history_id,
            &backup_path,
            &target,
            err,
        ));
    }
    if let Some(expected) = item.get("sourceHash").and_then(Value::as_str) {
        let copied_hash = hash_skill_md(&tmp)?;
        if copied_hash != expected {
            let _ = fs::remove_dir_all(&tmp);
            return Err(restore_after_failed_replace(
                db,
                history_id,
                &backup_path,
                &target,
                AppError::new("COPY_VERIFY_FAILED", "copy hash mismatch"),
            ));
        }
    }
    if let Err(err) = fs::rename(&tmp, &target) {
        let _ = fs::remove_dir_all(&tmp);
        return Err(restore_after_failed_replace(
            db,
            history_id,
            &backup_path,
            &target,
            err.into(),
        ));
    }
    Ok(ExecuteOutcome {
        before_hash,
        after_hash: item
            .get("sourceHash")
            .and_then(Value::as_str)
            .map(str::to_string),
        backup_path,
    })
}

fn value_path(item: &Value, key: &str) -> AppResult<PathBuf> {
    item.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| AppError::new("INVALID_PLAN", format!("{key} required")))
}

fn metadata_dev_ino(meta: &fs::Metadata) -> (i64, i64) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (meta.dev() as i64, meta.ino() as i64)
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        (0, 0)
    }
}

fn is_safe_basename(name: &str) -> bool {
    if name.is_empty() || name == "." || name == ".." || name.len() > 240 {
        return false;
    }
    if name.starts_with('.')
        || name.ends_with('.')
        || name.chars().last().is_some_and(char::is_whitespace)
    {
        return false;
    }
    !name.contains('/') && !name.contains('\\') && !name.contains('\0')
}

fn target_inside_platform(target: &Path, platform_dir: &str) -> bool {
    let root = fs::canonicalize(platform_dir).unwrap_or_else(|_| PathBuf::from(platform_dir));
    let parent = target.parent().unwrap_or_else(|| Path::new(platform_dir));
    let real_parent = nearest_existing_realpath(parent);
    path_inside(
        &real_parent.join(target.file_name().unwrap_or_default()),
        &root,
    )
}

fn nearest_existing_realpath(path: &Path) -> PathBuf {
    let mut probe = path.to_path_buf();
    let mut tail = Vec::new();
    loop {
        if let Ok(real) = fs::canonicalize(&probe) {
            return tail
                .into_iter()
                .rev()
                .fold(real, |acc: PathBuf, part| acc.join(part));
        }
        let Some(name) = probe.file_name().map(|n| n.to_os_string()) else {
            return path.to_path_buf();
        };
        tail.push(name);
        if !probe.pop() {
            return path.to_path_buf();
        }
    }
}

fn path_inside(child: &Path, parent: &Path) -> bool {
    let child = child.components().collect::<Vec<_>>();
    let parent = parent.components().collect::<Vec<_>>();
    child.len() > parent.len() && child.iter().zip(parent.iter()).all(|(a, b)| a == b)
}

fn has_case_collision(dir: &str, basename: &str) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    let target = basename.to_lowercase();
    entries.filter_map(Result::ok).any(|entry| {
        let name = entry.file_name().to_string_lossy().to_string();
        name != basename && name.to_lowercase() == target
    })
}

fn is_broken_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink() && fs::metadata(path).is_err())
        .unwrap_or(false)
}

fn reassert_target_in_platform(db: &Connection, item: &Value) -> AppResult<()> {
    let platform_id = item
        .get("targetPlatformId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new("INVALID_PLAN", "targetPlatformId required"))?;
    let target = value_path(item, "targetPath")?;
    let skills_dir: String = db.query_row(
        "SELECT skills_dir FROM platforms WHERE id = ?1",
        params![platform_id],
        |r| r.get(0),
    )?;
    if target_inside_platform(&target, &skills_dir) {
        Ok(())
    } else {
        Err(AppError::new(
            "TARGET_OUTSIDE_ROOT",
            "target resolves outside platform root",
        ))
    }
}

fn restore_after_failed_replace(
    db: &Connection,
    history_id: i64,
    backup_path: &Option<String>,
    target: &Path,
    original: AppError,
) -> AppError {
    let Some(backup) = backup_path else {
        return original;
    };
    match restore_sync_backup(Path::new(backup), target) {
        Ok(_) => {
            let _ = db.execute(
                "UPDATE sync_history SET backup_path = NULL WHERE id = ?1",
                params![history_id],
            );
            original
        }
        Err(restore_err) => AppError::new(
            "SYNC_RECOVERY_FAILED",
            format!(
                "{}; restoring backup failed: {}",
                original.message, restore_err.message
            ),
        ),
    }
}

fn create_sync_backup(
    db: &Connection,
    history_id: i64,
    backup_root: &Path,
    src: &Path,
    item: &Value,
) -> AppResult<String> {
    fs::create_dir_all(backup_root)?;
    let platform = item
        .get("targetPlatformId")
        .and_then(Value::as_str)
        .unwrap_or("platform");
    let skill = item
        .get("skillName")
        .and_then(Value::as_str)
        .unwrap_or("skill")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>();
    let dest = backup_root.join(format!("{}_{}_{}", now_ms(), platform, skill));
    let dest_string = dest.to_string_lossy().to_string();
    db.execute(
        "UPDATE sync_history SET backup_path = ?1 WHERE id = ?2",
        params![dest_string, history_id],
    )?;
    match fs::rename(src, &dest) {
        Ok(_) => return Ok(dest_string),
        Err(_) => {
            let backup_result: AppResult<()> = (|| {
                let meta = fs::symlink_metadata(src)?;
                if meta.file_type().is_symlink() {
                    let link = fs::read_link(src)?;
                    create_dir_symlink(&link, &dest)?;
                    fs::remove_file(src)?;
                } else if meta.is_dir() {
                    copy_tree(src, &dest)?;
                    fs::remove_dir_all(src)?;
                } else {
                    fs::copy(src, &dest)?;
                    fs::remove_file(src)?;
                }
                Ok(())
            })();
            if let Err(err) = backup_result {
                if !path_exists_lstat(&dest) {
                    let _ = db.execute(
                        "UPDATE sync_history SET backup_path = NULL WHERE id = ?1",
                        params![history_id],
                    );
                }
                return Err(err);
            }
        }
    }
    Ok(dest_string)
}

fn create_dir_symlink(source: &Path, link: &Path) -> AppResult<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(source, link)?;
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(source, link)?;
    }
    Ok(())
}

fn copy_tree(src: &Path, dest: &Path) -> AppResult<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        let meta = fs::symlink_metadata(&from)?;
        if meta.file_type().is_symlink() {
            let target = fs::read_link(&from)?;
            create_dir_symlink(&target, &to)?;
        } else if meta.is_dir() {
            copy_tree(&from, &to)?;
        } else if meta.is_file() {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

fn has_symlink_in_tree(root: &Path) -> AppResult<bool> {
    let mut stack = vec![root.to_path_buf()];
    let mut visited = 0usize;
    while let Some(dir) = stack.pop() {
        visited += 1;
        if visited > 5000 {
            return Err(AppError::new("SOURCE_HAS_SYMLINK", "source tree too large"));
        }
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let meta = fs::symlink_metadata(&path)?;
            if meta.file_type().is_symlink() {
                return Ok(true);
            }
            if meta.is_dir() {
                stack.push(path);
            }
        }
    }
    Ok(false)
}

fn hash_skill_md(dir: &Path) -> AppResult<String> {
    let bytes = fs::read(dir.join("SKILL.md"))?;
    Ok(hex::encode(sha2::Sha256::digest(bytes)))
}

pub(crate) fn recover_pending_history(conn: &Connection) -> AppResult<usize> {
    let cutoff = now_ms() - 30_000;
    let changed = conn.execute(
        "UPDATE sync_history
         SET success = 0, message = '_interrupted_'
         WHERE message = '_pending_' AND created_at <= ?1",
        params![cutoff],
    )?;
    Ok(changed)
}

pub(crate) fn recover_pending_backups(conn: &Connection) -> AppResult<usize> {
    let cutoff = now_ms() - 30_000;
    let mut stmt = conn.prepare(
        "SELECT id, to_path, backup_path FROM sync_history
         WHERE message = '_pending_'
           AND success = 0
           AND backup_path IS NOT NULL
           AND to_path IS NOT NULL
           AND created_at <= ?1",
    )?;
    let rows = stmt.query_map(params![cutoff], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    let rows = rows.collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    let mut recovered = 0;
    for row in rows {
        let (id, target, backup) = row;
        let target = PathBuf::from(target);
        let backup = PathBuf::from(backup);
        if path_exists_lstat(&backup) && !path_exists_lstat(&target) {
            restore_sync_backup(&backup, &target)?;
            conn.execute(
                "UPDATE sync_history
                 SET message = '_recovered_backup_', backup_path = NULL
                 WHERE id = ?1",
                params![id],
            )?;
            recovered += 1;
        }
    }
    Ok(recovered)
}

pub(crate) fn backup_retention_days(conn: &Connection) -> AppResult<i64> {
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'backup_retention_days'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(value.and_then(|v| v.parse::<i64>().ok()).unwrap_or(30))
}

pub(crate) fn cleanup_old_backups(
    conn: &Connection,
    backup_root: &Path,
    retention_days: i64,
) -> AppResult<Value> {
    if retention_days <= 0 {
        return Ok(json!({
            "deletedDirs": 0,
            "deletedBytes": 0,
            "nulledRows": 0,
            "remainingBytes": backup_disk_usage(backup_root)
        }));
    }

    let cutoff = SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(
            retention_days as u64 * 24 * 60 * 60,
        ))
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let mut to_delete = Vec::new();
    if let Ok(entries) = fs::read_dir(backup_root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(".pending-") {
                continue;
            }
            let path = entry.path();
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            if !(meta.is_dir() || meta.file_type().is_symlink()) {
                continue;
            }
            let Ok(mtime) = meta.modified() else {
                continue;
            };
            if mtime <= cutoff {
                to_delete.push(path);
            }
        }
    }

    let mut deleted_dirs = 0;
    let mut deleted_bytes = 0;
    let mut deleted_paths = Vec::new();
    for path in to_delete {
        deleted_bytes += path_size(&path);
        let result = if fs::symlink_metadata(&path)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
        {
            fs::remove_file(&path)
        } else {
            fs::remove_dir_all(&path)
        };
        if result.is_ok() {
            deleted_dirs += 1;
            deleted_paths.push(path.to_string_lossy().to_string());
        }
    }

    let mut nulled_rows = 0;
    for path in deleted_paths {
        nulled_rows += conn.execute(
            "UPDATE sync_history SET backup_path = NULL WHERE backup_path = ?1",
            params![path],
        )?;
    }

    Ok(json!({
        "deletedDirs": deleted_dirs,
        "deletedBytes": deleted_bytes,
        "nulledRows": nulled_rows,
        "remainingBytes": backup_disk_usage(backup_root)
    }))
}

fn backup_disk_usage(root: &Path) -> i64 {
    if !root.exists() {
        return 0;
    }
    path_size(root)
}

fn path_size(path: &Path) -> i64 {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.file_type().is_symlink() {
        return 0;
    }
    if meta.is_file() {
        return meta.len() as i64;
    }
    if !meta.is_dir() {
        return 0;
    }
    let mut total = 0;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            total += path_size(&entry.path());
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, VecDeque};
    use std::sync::{atomic::AtomicBool, Arc, Mutex, OnceLock};
    use tauri::Manager;

    static CREATE_SKILL_ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    fn history_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            r#"
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
              created_at INTEGER NOT NULL,
              installed_from_source TEXT,
              installed_from_skill_id TEXT,
              op_group_id TEXT
            );
            "#,
        )
        .expect("schema");
        conn
    }

    fn sync_conn() -> Connection {
        let conn = history_conn();
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
            CREATE TABLE skills (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              source_key TEXT NOT NULL DEFAULT 'local',
              description TEXT,
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
              content_hash TEXT,
              mtime INTEGER,
              last_seen_at INTEGER NOT NULL
            );
            "#,
        )
        .expect("sync schema");
        conn
    }

    fn settings_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            r#"
            CREATE TABLE settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            CREATE TABLE scenarios (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              key TEXT NOT NULL UNIQUE,
              name TEXT NOT NULL UNIQUE,
              description TEXT,
              color TEXT,
              icon TEXT,
              sort_order INTEGER NOT NULL DEFAULT 0,
              is_builtin INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL
            );
            "#,
        )
        .expect("settings schema");
        conn
    }

    fn coverage_conn() -> Connection {
        let conn = settings_conn();
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
            CREATE TABLE skills (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              source_key TEXT NOT NULL DEFAULT 'local',
              description TEXT,
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
              content_hash TEXT,
              mtime INTEGER,
              last_seen_at INTEGER NOT NULL
            );
            CREATE TABLE skill_scenarios (
              skill_id TEXT NOT NULL,
              scenario_id INTEGER NOT NULL,
              added_at INTEGER NOT NULL,
              PRIMARY KEY (skill_id, scenario_id)
            );
            INSERT INTO settings (key, value) VALUES ('canonical_platform', 'shared');
            INSERT INTO platforms (id, label, skills_dir, enabled, sort_order) VALUES
              ('shared', 'User Agents Folder', '/tmp/shared', 1, 0),
              ('claude', 'Claude Code', '/tmp/claude', 1, 1),
              ('codex', 'Codex', '/tmp/codex', 1, 2);
            "#,
        )
        .expect("coverage schema");
        conn
    }

    fn insert_coverage_skill(conn: &Connection, id: &str, name: &str) {
        conn.execute(
            "INSERT INTO skills
             (id, name, source_key, description, content_hash, created_at, updated_at, last_scanned_at)
             VALUES (?1, ?2, 'local', 'fixture', ?3, 1, 1, 1)",
            params![id, name, format!("{id}-hash")],
        )
        .unwrap();
    }

    fn insert_test_scenario(conn: &Connection, key: &str, name: &str) -> i64 {
        conn.execute(
            "INSERT INTO scenarios
             (key, name, description, color, icon, sort_order, is_builtin, created_at)
             VALUES (?1, ?2, 'desc', '#111111', 'tag', 10, 0, 1)",
            params![key, name],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_coverage_location(
        conn: &Connection,
        skill_id: &str,
        platform_id: &str,
        install_path: &str,
        real_path: &str,
        is_symlink: bool,
        is_broken_link: bool,
        is_disabled: bool,
        content_hash: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO skill_locations
             (skill_id, platform_id, install_path, real_path, is_symlink, is_broken_link, is_disabled, content_hash, mtime, last_seen_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, 1)",
            params![
                skill_id,
                platform_id,
                install_path,
                real_path,
                is_symlink as i64,
                is_broken_link as i64,
                is_disabled as i64,
                content_hash,
            ],
        )
        .unwrap();
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("myskills-commands-test-{name}-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn write_skill(root: &Path, dirname: &str, skill_name: &str) -> PathBuf {
        let skill_dir = root.join(dirname);
        fs::create_dir_all(&skill_dir).expect("create skill dir");
        fs::write(
            skill_dir.join("SKILL.md"),
            format!("---\nname: {skill_name}\ndescription: test skill\n---\nbody\n"),
        )
        .expect("write SKILL.md");
        skill_dir
    }

    fn create_skill_smoke_app() -> (tauri::App<tauri::test::MockRuntime>, PathBuf) {
        let root = temp_dir("create-skill-smoke");
        let paths = crate::paths::AppPaths::new(root.join("app-data")).expect("app paths");
        let pool = crate::db::init_pool(&paths.db_path).expect("db pool");
        {
            let db = pool.get().expect("db conn");
            for platform_id in ["shared", "claude", "codex"] {
                let dir = root.join(platform_id);
                fs::create_dir_all(&dir).expect("platform dir");
                db.execute(
                    "UPDATE platforms SET skills_dir = ?1, enabled = 1 WHERE id = ?2",
                    params![dir.to_string_lossy(), platform_id],
                )
                .expect("platform update");
            }
            db.execute(
                "INSERT INTO settings (key, value) VALUES ('canonical_platform', 'shared')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [],
            )
            .expect("canonical setting");
        }
        let state = AppState {
            paths,
            db: pool,
            last_scan: Mutex::new(None),
            plan_store: Mutex::new(HashMap::new()),
            sync_lock: Mutex::new(()),
            ai_queue: Arc::new(Mutex::new(VecDeque::new())),
            ai_worker_running: Arc::new(AtomicBool::new(false)),
            ai_jobs: Arc::new(Mutex::new(HashMap::new())),
        };
        let app = tauri::test::mock_builder()
            .manage(state)
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        (app, root)
    }

    fn configure_create_skill_mock_llm(state: State<'_, AppState>) {
        let db = state.db.get().expect("db conn");
        for (key, value) in [
            ("allow_external_network", "1"),
            ("llm.provider", "ollama"),
            ("llm.model", "mock-create-skill"),
            (LLM_CONNECTION_OK_SETTING, "1"),
        ] {
            db.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .expect("mock llm setting");
        }
    }

    fn with_create_skill_mock_responses<T>(
        start_response: Option<&str>,
        generate_response: Option<&str>,
        f: impl FnOnce() -> T,
    ) -> T {
        let lock = CREATE_SKILL_ENV_LOCK.get_or_init(|| Mutex::new(()));
        let _guard = lock.lock().expect("create skill env lock");
        if let Some(response) = start_response {
            std::env::set_var("MYSKILLS_CREATE_SKILL_START_RESPONSE", response);
        } else {
            std::env::remove_var("MYSKILLS_CREATE_SKILL_START_RESPONSE");
        }
        if let Some(response) = generate_response {
            std::env::set_var("MYSKILLS_CREATE_SKILL_GENERATE_RESPONSE", response);
        } else {
            std::env::remove_var("MYSKILLS_CREATE_SKILL_GENERATE_RESPONSE");
        }
        let result = f();
        std::env::remove_var("MYSKILLS_CREATE_SKILL_START_RESPONSE");
        std::env::remove_var("MYSKILLS_CREATE_SKILL_GENERATE_RESPONSE");
        result
    }

    /// 与 with_create_skill_mock_responses 并列：额外桩住追问回灌路径的 LLM 响应。
    /// answer_response = None 时移除 env，模拟 LLM 失败 → 走确定性 fallback。
    fn with_create_skill_answer_mock<T>(answer_response: Option<&str>, f: impl FnOnce() -> T) -> T {
        let lock = CREATE_SKILL_ENV_LOCK.get_or_init(|| Mutex::new(()));
        let _guard = lock.lock().expect("create skill env lock");
        if let Some(response) = answer_response {
            std::env::set_var("MYSKILLS_CREATE_SKILL_ANSWER_RESPONSE", response);
        } else {
            std::env::remove_var("MYSKILLS_CREATE_SKILL_ANSWER_RESPONSE");
        }
        let result = f();
        std::env::remove_var("MYSKILLS_CREATE_SKILL_ANSWER_RESPONSE");
        result
    }

    fn create_skill_mock_start_response(prompt: &str) -> String {
        json!({
            "schemaVersion": "create-skill.v1",
            "command": "start",
            "status": "intent_draft",
            "skillSpec": {
                "name": "release-risk-review",
                "description": "当用户需要审查 Tauri 桌面发布风险、CI 结果和安装包验证路径时使用。",
                "language": "zh",
                "intentFrame": {
                    "whenToUse": prompt,
                    "userInput": "用户提供发布说明、CI 结果、安装包路径或待发布变更，希望得到发布风险判断。",
                    "output": "一份发布风险 checklist，标注阻断项、警告项和下一步验证动作。",
                    "outputParts": ["阻断项与警告项分层", "每个风险对应的下一步验证动作"],
                    "workflow": ["核对发布范围和平台差异。", "检查 CI、签名、安装包和更新机制风险。", "输出阻断项、警告项和下一步验证清单。"],
                    "boundaries": ["缺少安装包路径时先追问。", "不得假设签名或 notarization 已完成。", "不直接发布版本。"],
                    "successCriteria": ["阻断项明确", "每个风险都有下一步验证动作"],
                    "safety": {
                        "network": "no",
                        "fileWrites": "none",
                        "overwrite": "never",
                        "privacy": "local_only",
                        "artifactType": "checklist"
                    }
                },
                "ready": false,
                "missing": ["strictness"]
            },
            "questions": [
                {
                    "id": "strictness",
                    "question": "发布前遇到不确定项时如何处理？",
                    "options": [
                        { "id": "confirm", "label": "阻断并确认", "effect": "strictness=confirm" },
                        { "id": "advisory_only", "label": "只提示风险", "effect": "strictness=advisory_only" }
                    ],
                    "allowFreeform": true
                }
            ]
        })
        .to_string()
    }

    fn create_skill_mock_generate_response() -> String {
        json!({
            "schemaVersion": "create-skill.v1",
            "command": "generate",
            "draftMarkdown": "---\nname: release-risk-review\ndescription: 当用户需要审查 Tauri 桌面发布风险、CI 结果和安装包验证路径时使用。\n---\n\n# release-risk-review\n\n## 输入\n\n- 发布说明\n- CI 结果\n- 安装包路径\n\n## 工作流\n\n1. 核对发布范围和三端差异。\n2. 检查 CI、签名、安装包和更新机制。\n3. 输出阻断项、警告项和下一步验证清单。\n\n## 输出\n\n- 发布风险 checklist\n\n## 边界\n\n- 不直接发布版本。\n- 缺少安装包路径时先追问。\n\n## 质量标准\n\n- 阻断项明确。\n- 每个风险都有验证动作。\n"
        })
        .to_string()
    }

    fn create_skill_mock_answer_response() -> String {
        json!({
            "schemaVersion": "create-skill.v1",
            "command": "start",
            "status": "intent_draft",
            "skillSpec": {
                "name": "release-risk-review",
                "description": "当用户需要审查 Tauri 桌面发布风险并在不确定时阻断确认时使用。",
                "language": "zh",
                "intentFrame": {
                    "whenToUse": "审查 Tauri 桌面发布风险，并在遇到不确定项时阻断确认。",
                    "userInput": "用户提供发布说明、CI 结果、安装包路径或待发布变更。",
                    "output": "一份发布风险 checklist，遇到不确定项时停下来请求用户确认。",
                    "outputParts": ["阻断项与警告项分层", "需要用户确认的不确定项清单"],
                    "workflow": ["核对发布范围和平台差异。", "检查 CI、签名、安装包和更新机制风险。", "遇到不确定项时阻断并请求确认，再输出验证清单。"],
                    "boundaries": ["缺少安装包路径时先追问。", "遇到不确定项必须阻断并请求用户确认。", "不直接发布版本。"],
                    "successCriteria": ["阻断项明确", "不确定项均已请求确认"],
                    "safety": {
                        "network": "no",
                        "fileWrites": "none",
                        "overwrite": "confirm_each_time",
                        "privacy": "local_only",
                        "artifactType": "checklist"
                    }
                },
                "ready": false,
                "missing": []
            },
            "questions": [
                {
                    "id": "strictness",
                    "question": "发布前遇到不确定项时如何处理？",
                    "options": [
                        { "id": "confirm", "label": "阻断并确认", "effect": "strictness=confirm" },
                        { "id": "advisory_only", "label": "只提示风险", "effect": "strictness=advisory_only" }
                    ],
                    "allowFreeform": true
                }
            ]
        })
        .to_string()
    }

    fn create_skill_answer(
        state: State<'_, AppState>,
        draft_id: &str,
        question_id: &str,
        answer: &str,
    ) -> Value {
        tauri::async_runtime::block_on(ai_create_skill_answer(
            Some(json!({
                "draftId": draft_id,
                "questionId": question_id,
                "answer": answer
            })),
            state,
        ))
        .expect("answer question")
    }

    fn assert_create_skill_draft_count(state: State<'_, AppState>, expected: i64) {
        let db = state.db.get().expect("db conn");
        let count: i64 = db
            .query_row("SELECT COUNT(*) FROM skill_creation_drafts", [], |row| {
                row.get(0)
            })
            .expect("draft count");
        assert_eq!(count, expected);
    }

    #[test]
    fn recover_pending_history_marks_only_old_pending_rows() {
        let conn = history_conn();
        let now = now_ms();
        conn.execute(
            "INSERT INTO sync_history (skill_id, action, success, message, created_at)
             VALUES ('a', 'symlink_create', 0, '_pending_', ?1)",
            params![now - 60_000],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_history (skill_id, action, success, message, created_at)
             VALUES ('b', 'symlink_create', 0, '_pending_', ?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_history (skill_id, action, success, message, created_at)
             VALUES ('c', 'symlink_create', 0, 'failed', ?1)",
            params![now - 60_000],
        )
        .unwrap();

        assert_eq!(recover_pending_history(&conn).unwrap(), 1);
        let interrupted: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_history WHERE message = '_interrupted_'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(interrupted, 1);
        let pending: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_history WHERE message = '_pending_'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(pending, 1);
    }

    #[test]
    fn copy_execute_reasserts_target_inside_platform_root() {
        let conn = sync_conn();
        let root = temp_dir("copy-root");
        let platform_root = root.join("platform");
        let outside_root = root.join("outside");
        fs::create_dir_all(&platform_root).unwrap();
        fs::create_dir_all(&outside_root).unwrap();
        conn.execute(
            "INSERT INTO platforms (id, label, skills_dir) VALUES ('shared', 'Shared', ?1)",
            params![platform_root.to_string_lossy()],
        )
        .unwrap();
        let source = write_skill(&root, "source", "copy-source");
        let source_hash = hash_skill_md(&source).unwrap();
        let item = json!({
            "skillName": "copy-source",
            "skillId": "skill-1",
            "sourceRealPath": source.to_string_lossy(),
            "sourceDev": 0,
            "sourceIno": 0,
            "sourceHash": source_hash,
            "targetPlatformId": "shared",
            "targetPath": outside_root.join("copy-source").to_string_lossy(),
        });

        let err = match do_copy_item(&conn, 0, &root.join("backups"), &item) {
            Ok(_) => panic!("copy should reject a target outside the platform root"),
            Err(err) => err,
        };

        assert_eq!(err.code, "TARGET_OUTSIDE_ROOT");
        assert!(!outside_root.join("copy-source").exists());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn copy_failure_restores_existing_target_and_clears_backup_path() {
        let conn = sync_conn();
        let root = temp_dir("copy-restore");
        let platform_root = root.join("platform");
        fs::create_dir_all(&platform_root).unwrap();
        conn.execute(
            "INSERT INTO platforms (id, label, skills_dir) VALUES ('shared', 'Shared', ?1)",
            params![platform_root.to_string_lossy()],
        )
        .unwrap();
        let source = write_skill(&root, "source", "copy-source");
        let target = write_skill(&platform_root, "target", "target-original");
        let item = json!({
            "skillName": "copy-source",
            "skillId": "skill-1",
            "sourceRealPath": source.to_string_lossy(),
            "sourceDev": 0,
            "sourceIno": 0,
            "sourceHash": "deliberately-wrong-hash",
            "targetPlatformId": "shared",
            "targetPath": target.to_string_lossy(),
        });
        let history_id = insert_pending_history(&conn, &item, "{}").unwrap();

        let err = match do_copy_item(&conn, history_id, &root.join("backups"), &item) {
            Ok(_) => panic!("copy should fail hash verification"),
            Err(err) => err,
        };

        assert_eq!(err.code, "COPY_VERIFY_FAILED");
        let restored = fs::read_to_string(target.join("SKILL.md")).unwrap();
        assert!(restored.contains("name: target-original"));
        let backup_path: Option<String> = conn
            .query_row(
                "SELECT backup_path FROM sync_history WHERE id = ?1",
                params![history_id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(backup_path.is_none());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn recover_pending_backups_restores_missing_target_before_marking_interrupted() {
        let conn = sync_conn();
        let root = temp_dir("pending-backup");
        let target = root.join("target");
        let backup = write_skill(&root, "backup", "pending-backup");
        conn.execute(
            "INSERT INTO sync_history
             (skill_id, action, to_path, backup_path, success, message, created_at)
             VALUES ('skill-1', 'symlink_replace', ?1, ?2, 0, '_pending_', ?3)",
            params![
                target.to_string_lossy(),
                backup.to_string_lossy(),
                now_ms() - 60_000
            ],
        )
        .unwrap();

        assert_eq!(recover_pending_backups(&conn).unwrap(), 1);

        assert!(target.join("SKILL.md").exists());
        assert!(!backup.exists());
        let row: (String, Option<String>) = conn
            .query_row(
                "SELECT message, backup_path FROM sync_history WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(row.0, "_recovered_backup_");
        assert!(row.1.is_none());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn disable_plan_blocks_real_source_with_live_symlink_dependents() {
        let conn = sync_conn();
        let root = temp_dir("dependents");
        let source = write_skill(&root, "source", "shared-source");
        conn.execute(
            "INSERT INTO skill_locations
             (id, skill_id, platform_id, install_path, real_path, is_symlink, is_broken_link, is_disabled, last_seen_at)
             VALUES (2, 'skill-1', 'codex', '/virtual/codex/source', ?1, 1, 0, 0, 100)",
            params![source.to_string_lossy()],
        )
        .unwrap();
        let skill = SyncSkillRow {
            id: "skill-1".to_string(),
            name: "shared-source".to_string(),
        };
        let loc = LocRow {
            id: 1,
            skill_id: "skill-1".to_string(),
            platform_id: "shared".to_string(),
            install_path: source.to_string_lossy().to_string(),
            real_path: source.to_string_lossy().to_string(),
            is_symlink: false,
            is_broken_link: false,
            is_disabled: false,
            content_hash: None,
            mtime: None,
        };

        let item = build_toggle_item(&conn, &skill, &loc, &root.to_string_lossy(), true).unwrap();

        assert_eq!(item["action"].as_str(), Some("conflict"));
        assert_eq!(item["reason"].as_str(), Some("canonical_has_dependents"));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn sync_execute_records_history_and_rollback_restores_copy_target() {
        let conn = sync_conn();
        let root = temp_dir("sync-copy-workflow");
        let shared_root = root.join("shared");
        let claude_root = root.join("claude");
        let backup_root = root.join("backups");
        fs::create_dir_all(&shared_root).unwrap();
        fs::create_dir_all(&claude_root).unwrap();
        conn.execute(
            "INSERT INTO platforms (id, label, skills_dir, enabled, sort_order) VALUES
             ('shared', 'User Agents Folder', ?1, 1, 0),
             ('claude', 'Claude Code', ?2, 1, 1)",
            params![shared_root.to_string_lossy(), claude_root.to_string_lossy()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO skills
             (id, name, source_key, description, content_hash, created_at, updated_at, last_scanned_at)
             VALUES ('skill-1', 'copy-source', 'local', 'fixture', 'unused', 1, 1, 1)",
            [],
        )
        .unwrap();
        let source = write_skill(&claude_root, "copy-source", "copy-source");
        let source_hash = hash_skill_md(&source).unwrap();
        let meta = fs::metadata(&source).unwrap();
        let (dev, ino) = metadata_dev_ino(&meta);
        let target = shared_root.join("copy-source");
        let item = json!({
            "skillName": "copy-source",
            "skillId": "skill-1",
            "opGroupId": "group-1",
            "targetBasename": "copy-source",
            "sourcePlatformId": "claude",
            "sourceLocationId": 1,
            "sourceRealPath": source.to_string_lossy(),
            "sourceDev": dev,
            "sourceIno": ino,
            "sourceHash": source_hash,
            "targetPlatformId": "shared",
            "targetPath": target.to_string_lossy(),
            "targetHash": Value::Null,
            "mode": "copy",
            "action": "copy_to_canonical"
        });

        let result = execute_sync_items(&conn, &backup_root, vec![item], "{}").unwrap();

        assert_eq!(
            result
                .get("applied")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(1)
        );
        assert_eq!(
            result.get("failed").and_then(Value::as_array).map(Vec::len),
            Some(0)
        );
        assert!(target.join("SKILL.md").exists());
        let history_id: i64 = conn
            .query_row(
                "SELECT id FROM sync_history WHERE skill_id = 'skill-1' AND success = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let rows = rollback_rows(&conn, history_id, Some("group-1")).unwrap();
        assert_eq!(rows.len(), 1);
        rollback_one_row(&rows[0]).unwrap();
        conn.execute(
            "UPDATE sync_history SET rolled_back_at = ?1 WHERE id = ?2",
            params![now_ms(), history_id],
        )
        .unwrap();

        assert!(!target.exists());
        let rolled_back: Option<i64> = conn
            .query_row(
                "SELECT rolled_back_at FROM sync_history WHERE id = ?1",
                params![history_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(rolled_back.is_some());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn sync_plan_from_canonical_classifies_fixture_targets() {
        let conn = sync_conn();
        let root = temp_dir("sync-plan");
        let shared_root = root.join("shared");
        let claude_root = root.join("claude");
        let codex_root = root.join("codex");
        fs::create_dir_all(&shared_root).unwrap();
        fs::create_dir_all(&claude_root).unwrap();
        fs::create_dir_all(&codex_root).unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('canonical_platform', 'shared')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO platforms (id, label, skills_dir, enabled, sort_order) VALUES
             ('shared', 'User Agents Folder', ?1, 1, 0),
             ('claude', 'Claude Code', ?2, 1, 1),
             ('codex', 'Codex', ?3, 1, 2)",
            params![
                shared_root.to_string_lossy(),
                claude_root.to_string_lossy(),
                codex_root.to_string_lossy()
            ],
        )
        .unwrap();

        let cases = [
            ("skill-missing", "plan-missing", "codex", "symlink_create"),
            ("skill-same", "plan-same", "claude", "skip"),
            ("skill-stale", "plan-stale", "claude", "symlink_replace"),
            ("skill-conflict", "plan-conflict", "codex", "conflict"),
        ];
        for (skill_id, name, _, _) in cases {
            insert_coverage_skill(&conn, skill_id, name);
            let source = write_skill(&shared_root, name, name);
            let source_hash = hash_skill_md(&source).unwrap();
            insert_coverage_location(
                &conn,
                skill_id,
                "shared",
                &source.to_string_lossy(),
                &source.to_string_lossy(),
                false,
                false,
                false,
                Some(&source_hash),
            );
        }

        let same_target = write_skill(&claude_root, "plan-same", "plan-same");
        let same_hash = hash_skill_md(&same_target).unwrap();
        insert_coverage_location(
            &conn,
            "skill-same",
            "claude",
            &same_target.to_string_lossy(),
            &same_target.to_string_lossy(),
            false,
            false,
            false,
            Some(&same_hash),
        );

        let stale_target = write_skill(&claude_root, "plan-stale", "plan-stale-old");
        let stale_hash = hash_skill_md(&stale_target).unwrap();
        insert_coverage_location(
            &conn,
            "skill-stale",
            "claude",
            &stale_target.to_string_lossy(),
            &stale_target.to_string_lossy(),
            false,
            false,
            false,
            Some(&stale_hash),
        );

        fs::write(codex_root.join("plan-conflict"), "not a directory").unwrap();

        let requests = cases
            .iter()
            .map(|(skill_id, _, platform_id, _)| {
                json!({ "skillId": skill_id, "targetPlatformIds": [platform_id] })
            })
            .collect::<Vec<_>>();
        let plan = plan_sync_from_canonical(&conn, &requests).unwrap();

        assert_eq!(
            plan.get("operation").and_then(Value::as_str),
            Some("sync_from_canonical")
        );
        assert!(plan.get("token").and_then(Value::as_str).is_some());
        let items = plan.get("items").and_then(Value::as_array).unwrap();
        let action_by_skill = items
            .iter()
            .map(|item| {
                (
                    item.get("skillId").and_then(Value::as_str).unwrap(),
                    item.get("action").and_then(Value::as_str).unwrap(),
                )
            })
            .collect::<std::collections::HashMap<_, _>>();

        for (skill_id, _, _, expected_action) in cases {
            assert_eq!(
                action_by_skill.get(skill_id).copied(),
                Some(expected_action)
            );
        }
        assert_eq!(
            items
                .iter()
                .find(|item| item.get("skillId").and_then(Value::as_str) == Some("skill-same"))
                .and_then(|item| item.get("reason"))
                .and_then(Value::as_str),
            Some("same_hash")
        );
        let force_plan = plan_sync_from_canonical(
            &conn,
            &[json!({
                "skillId": "skill-same",
                "targetPlatformIds": ["claude"],
                "forceReplace": true
            })],
        )
        .unwrap();
        assert_eq!(
            force_plan
                .get("items")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|item| item.get("action"))
                .and_then(Value::as_str),
            Some("symlink_replace")
        );
        assert_eq!(
            items
                .iter()
                .find(|item| item.get("skillId").and_then(Value::as_str) == Some("skill-conflict"))
                .and_then(|item| item.get("reason"))
                .and_then(Value::as_str),
            Some("target_exists_file")
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn scanner_populates_library_list_and_settings_stats() {
        let root = temp_dir("library-scan");
        let db_path = root.join("myskills.db");
        let shared_root = root.join("shared");
        let claude_root = root.join("claude");
        let codex_root = root.join("codex");
        fs::create_dir_all(&shared_root).unwrap();
        fs::create_dir_all(&claude_root).unwrap();
        fs::create_dir_all(&codex_root).unwrap();
        write_skill(&shared_root, "fixture-library-main", "fixture-library-main");
        write_skill(
            &shared_root.join(".disabled"),
            "fixture-disabled",
            "fixture-disabled",
        );
        write_skill(&claude_root, "fixture-claude-only", "fixture-claude-only");
        let invalid = shared_root.join("fixture-missing-frontmatter");
        fs::create_dir_all(&invalid).unwrap();
        fs::write(invalid.join("SKILL.md"), "body without frontmatter\n").unwrap();

        let pool = crate::db::init_pool(&db_path).unwrap();
        let db = pool.get().unwrap();
        db.execute(
            "UPDATE platforms SET skills_dir = ?1 WHERE id = 'shared'",
            params![shared_root.to_string_lossy()],
        )
        .unwrap();
        db.execute(
            "UPDATE platforms SET skills_dir = ?1 WHERE id = 'claude'",
            params![claude_root.to_string_lossy()],
        )
        .unwrap();
        db.execute(
            "UPDATE platforms SET skills_dir = ?1 WHERE id = 'codex'",
            params![codex_root.to_string_lossy()],
        )
        .unwrap();

        let scan = scanner::scan_all(&db).unwrap();

        assert_eq!(scan.get("totalFound").and_then(Value::as_i64), Some(3));
        assert_eq!(scan.get("newSkills").and_then(Value::as_i64), Some(3));
        assert_eq!(
            scan.get("errors")
                .and_then(Value::as_array)
                .and_then(|errors| errors.first())
                .and_then(|error| error.get("kind"))
                .and_then(Value::as_str),
            Some("missing_frontmatter")
        );

        let all = skills_list_response(&db, None).unwrap();
        let names = all
            .as_array()
            .unwrap()
            .iter()
            .map(|skill| skill.get("name").and_then(Value::as_str).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec![
                "fixture-claude-only",
                "fixture-disabled",
                "fixture-library-main"
            ]
        );
        assert_eq!(
            all.as_array().unwrap()[1]["locations"][0]["isDisabled"].as_bool(),
            Some(true)
        );

        let shared = skills_list_response(&db, Some(&json!({ "platforms": ["shared"] }))).unwrap();
        let shared_names = shared
            .as_array()
            .unwrap()
            .iter()
            .map(|skill| skill.get("name").and_then(Value::as_str).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            shared_names,
            vec!["fixture-disabled", "fixture-library-main"]
        );

        let disabled = skills_list_response(&db, Some(&json!({ "scope": "disabled" }))).unwrap();
        assert_eq!(disabled.as_array().unwrap().len(), 1);
        assert_eq!(
            disabled.as_array().unwrap()[0]
                .get("name")
                .and_then(Value::as_str),
            Some("fixture-disabled")
        );

        let stats = settings_stats_response(&db, &db_path).unwrap();
        assert_eq!(stats.get("totalSkills").and_then(Value::as_i64), Some(3));
        assert_eq!(
            stats.pointer("/byPlatform/shared").and_then(Value::as_i64),
            Some(2)
        );
        assert_eq!(
            stats.pointer("/byPlatform/claude").and_then(Value::as_i64),
            Some(1)
        );
        assert_eq!(stats.get("disabledSkills").and_then(Value::as_i64), Some(1));
        assert_eq!(stats.get("unscenarized").and_then(Value::as_i64), Some(3));
        assert_eq!(
            stats.get("dbPath").and_then(Value::as_str),
            Some(db_path.to_string_lossy().as_ref())
        );
        assert!(stats.get("lastScanAt").and_then(Value::as_i64).is_some());
        drop(db);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn coverage_matrix_reports_fixture_states_and_drift() {
        let conn = coverage_conn();
        insert_coverage_skill(&conn, "skill-in-sync", "fixture-in-sync");
        insert_coverage_skill(&conn, "skill-stale", "fixture-stale");
        insert_coverage_skill(&conn, "skill-orphan", "fixture-claude-only");
        insert_coverage_skill(&conn, "skill-broken", "fixture-broken-link");
        insert_coverage_skill(&conn, "skill-disabled", "fixture-disabled");

        insert_coverage_location(
            &conn,
            "skill-in-sync",
            "shared",
            "/tmp/shared/fixture-in-sync",
            "/tmp/shared/fixture-in-sync",
            false,
            false,
            false,
            Some("same"),
        );
        insert_coverage_location(
            &conn,
            "skill-in-sync",
            "claude",
            "/tmp/claude/fixture-in-sync",
            "/tmp/shared/fixture-in-sync",
            true,
            false,
            false,
            Some("same"),
        );

        insert_coverage_location(
            &conn,
            "skill-stale",
            "shared",
            "/tmp/shared/fixture-stale",
            "/tmp/shared/fixture-stale",
            false,
            false,
            false,
            Some("canonical"),
        );
        insert_coverage_location(
            &conn,
            "skill-stale",
            "claude",
            "/tmp/claude/fixture-stale",
            "/tmp/claude/fixture-stale",
            false,
            false,
            false,
            Some("stale"),
        );

        insert_coverage_location(
            &conn,
            "skill-orphan",
            "claude",
            "/tmp/claude/fixture-claude-only",
            "/tmp/claude/fixture-claude-only",
            false,
            false,
            false,
            Some("orphan"),
        );
        insert_coverage_location(
            &conn,
            "skill-broken",
            "codex",
            "/tmp/codex/fixture-broken-link",
            "/tmp/missing",
            true,
            true,
            false,
            None,
        );
        insert_coverage_location(
            &conn,
            "skill-disabled",
            "shared",
            "/tmp/shared/.disabled/fixture-disabled",
            "/tmp/shared/.disabled/fixture-disabled",
            false,
            false,
            true,
            Some("disabled"),
        );

        let matrix = coverage_matrix_response(&conn).unwrap();
        assert_eq!(
            matrix.get("canonicalPlatform").and_then(Value::as_str),
            Some("shared")
        );
        assert_eq!(
            matrix.get("platforms").and_then(Value::as_array).unwrap(),
            &vec![json!("shared"), json!("claude"), json!("codex")]
        );
        let rows = matrix.get("rows").and_then(Value::as_array).unwrap();
        let by_id = rows
            .iter()
            .map(|row| (row.get("skillId").and_then(Value::as_str).unwrap(), row))
            .collect::<std::collections::HashMap<_, _>>();

        assert_eq!(
            by_id["skill-in-sync"]["cells"]["claude"]["state"].as_str(),
            Some("symlink")
        );
        assert_eq!(
            by_id["skill-stale"]["cells"]["claude"]["drift"].as_str(),
            Some("stale")
        );
        assert_eq!(by_id["skill-stale"]["hasDrift"].as_bool(), Some(true));
        assert_eq!(
            by_id["skill-orphan"]["cells"]["shared"]["state"].as_str(),
            Some("missing")
        );
        assert_eq!(
            by_id["skill-orphan"]["cells"]["claude"]["drift"].as_str(),
            Some("only_here")
        );
        assert_eq!(
            by_id["skill-broken"]["cells"]["codex"]["state"].as_str(),
            Some("broken")
        );
        assert_eq!(
            by_id["skill-disabled"]["cells"]["shared"]["state"].as_str(),
            Some("disabled")
        );
        assert_eq!(
            by_id["skill-disabled"]["hasCanonicalSource"].as_bool(),
            Some(false)
        );
    }

    #[test]
    fn coverage_matrix_treats_symlink_to_canonical_real_path_as_in_sync() {
        let conn = coverage_conn();
        insert_coverage_skill(&conn, "skill-shared-real", "fixture-shared-real");
        insert_coverage_location(
            &conn,
            "skill-shared-real",
            "shared",
            "/tmp/shared/fixture-shared-real",
            "/tmp/real/fixture-shared-real",
            true,
            false,
            false,
            Some("same"),
        );
        insert_coverage_location(
            &conn,
            "skill-shared-real",
            "claude",
            "/tmp/claude/fixture-shared-real",
            "/tmp/real/fixture-shared-real",
            true,
            false,
            false,
            Some("same"),
        );
        insert_coverage_location(
            &conn,
            "skill-shared-real",
            "codex",
            "/tmp/codex/fixture-shared-real",
            "/tmp/real/fixture-shared-real",
            true,
            false,
            false,
            Some("same"),
        );

        let matrix = coverage_matrix_response(&conn).unwrap();
        let rows = matrix.get("rows").and_then(Value::as_array).unwrap();
        let row = rows
            .iter()
            .find(|row| row.get("skillId").and_then(Value::as_str) == Some("skill-shared-real"))
            .unwrap();

        assert_eq!(row["cells"]["shared"]["state"].as_str(), Some("symlink"));
        assert_eq!(row["cells"]["claude"]["state"].as_str(), Some("symlink"));
        assert_eq!(row["cells"]["codex"]["state"].as_str(), Some("symlink"));
        assert_eq!(row["cells"]["claude"]["drift"].as_str(), Some("in_sync"));
        assert_eq!(row["cells"]["codex"]["drift"].as_str(), Some("in_sync"));
        assert_eq!(row["hasDrift"].as_bool(), Some(false));
    }

    #[test]
    fn scenarios_export_import_round_trips_skill_links() {
        let mut conn = coverage_conn();
        insert_coverage_skill(&conn, "skill-1", "fixture-in-sync");
        insert_coverage_skill(&conn, "skill-2", "fixture-stale");
        let scenario_id = insert_test_scenario(&conn, "daily-work", "Daily Work");
        conn.execute(
            "INSERT INTO skill_scenarios (skill_id, scenario_id, added_at)
             VALUES ('skill-1', ?1, 1)",
            params![scenario_id],
        )
        .unwrap();

        let exported = scenarios_export_response(&conn).unwrap();
        assert_eq!(exported.get("version").and_then(Value::as_str), Some("1"));
        assert_eq!(
            exported["scenarios"][0]["skills"][0]["name"].as_str(),
            Some("fixture-in-sync")
        );

        conn.execute("DELETE FROM skill_scenarios", []).unwrap();
        conn.execute("DELETE FROM scenarios", []).unwrap();
        let imported = scenarios_import_payload(&mut conn, &exported).unwrap();

        assert_eq!(
            imported.get("scenariosCreated").and_then(Value::as_i64),
            Some(1)
        );
        assert_eq!(
            imported.get("skillsLinked").and_then(Value::as_i64),
            Some(1)
        );
        let restored_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM skill_scenarios", [], |row| row.get(0))
            .unwrap();
        assert_eq!(restored_count, 1);

        let imported_again = scenarios_import_payload(&mut conn, &exported).unwrap();
        assert_eq!(
            imported_again
                .get("scenariosMerged")
                .and_then(Value::as_i64),
            Some(1)
        );
        assert_eq!(
            imported_again.get("skillsLinked").and_then(Value::as_i64),
            Some(0)
        );
    }

    #[test]
    fn scenarios_import_reports_missing_skills_without_failing() {
        let mut conn = coverage_conn();
        let payload = json!({
            "version": "1",
            "scenarios": [{
                "key": "missing-skill",
                "name": "Missing Skill",
                "skills": [{ "name": "does-not-exist", "sourceKey": "local" }]
            }]
        });

        let imported = scenarios_import_payload(&mut conn, &payload).unwrap();

        assert_eq!(
            imported.get("scenariosCreated").and_then(Value::as_i64),
            Some(1)
        );
        assert_eq!(
            imported.get("skillsLinked").and_then(Value::as_i64),
            Some(0)
        );
        assert_eq!(
            imported
                .get("skillsNotFound")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(1)
        );
    }

    #[test]
    fn network_gate_fails_closed_when_disabled_or_missing() {
        let conn = settings_conn();
        let missing = require_network(&conn).unwrap_err();
        assert_eq!(missing.code, "EXTERNAL_NETWORK_DISABLED");

        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('allow_external_network', '0')",
            [],
        )
        .unwrap();
        let disabled = require_network(&conn).unwrap_err();
        assert_eq!(disabled.code, "EXTERNAL_NETWORK_DISABLED");

        conn.execute(
            "UPDATE settings SET value = '1' WHERE key = 'allow_external_network'",
            [],
        )
        .unwrap();
        assert!(require_network(&conn).is_ok());
    }

    #[test]
    fn llm_config_response_never_returns_legacy_api_key_secret() {
        let conn = settings_conn();
        let paths = crate::paths::AppPaths::new(temp_dir("llm-legacy-secret").join("app-data"))
            .expect("app paths");
        conn.execute_batch(
            r#"
            INSERT INTO settings (key, value) VALUES
              ('llm.provider', 'openai'),
              ('llm.model', 'gpt-test'),
              ('llm.baseUrl', 'https://example.invalid/v1'),
              ('secret:llm.apiKey', 'plaintext-legacy-secret');
            "#,
        )
        .unwrap();

        let response = llm_config_response(&conn, &paths).unwrap();

        assert_eq!(
            response.get("hasApiKey").and_then(Value::as_bool),
            Some(true)
        );
        assert!(response.get("apiKey").is_none());
        assert!(response.get("key").is_none());
        assert!(!response.to_string().contains("plaintext-legacy-secret"));
    }

    #[test]
    fn llm_config_response_requires_vault_record_not_stale_marker() {
        let conn = settings_conn();
        let paths = crate::paths::AppPaths::new(temp_dir("llm-stale-marker").join("app-data"))
            .expect("app paths");
        conn.execute_batch(
            r#"
            INSERT INTO settings (key, value) VALUES
              ('llm.provider', 'deepseek'),
              ('llm.model', 'deepseek-v4-flash'),
              ('llm.apiKeyStored', '1');
            "#,
        )
        .unwrap();

        let response = llm_config_response(&conn, &paths).unwrap();

        assert_eq!(
            response.get("hasApiKey").and_then(Value::as_bool),
            Some(false)
        );
        assert!(response.get("apiKey").is_none());
        assert!(response.get("key").is_none());
    }

    #[test]
    fn llm_config_response_uses_encrypted_vault_record() {
        let conn = settings_conn();
        let paths = crate::paths::AppPaths::new(temp_dir("llm-vault-secret").join("app-data"))
            .expect("app paths");
        conn.execute_batch(
            r#"
            INSERT INTO settings (key, value) VALUES
              ('llm.provider', 'deepseek'),
              ('llm.model', 'deepseek-v4-flash'),
              ('llm.apiKeyStored', '1');
            "#,
        )
        .unwrap();
        secret_vault::write(&paths, LLM_API_KEY_NAME, "sk-test-secret").expect("vault write");

        let response = llm_config_response(&conn, &paths).unwrap();

        assert_eq!(
            response.get("hasApiKey").and_then(Value::as_bool),
            Some(true)
        );
        assert!(response.get("apiKey").is_none());
        assert!(response.get("key").is_none());
        assert!(!response.to_string().contains("sk-test-secret"));
    }

    #[test]
    fn ai_queue_waits_without_touching_llm_when_network_is_disabled() {
        let conn = settings_conn();
        conn.execute_batch(
            r#"
            INSERT INTO settings (key, value) VALUES
              ('allow_external_network', '0'),
              ('llm.feature.autoCategorize', '1'),
              ('llm.model', 'gpt-test'),
              ('secret:llm.apiKey', 'plaintext-legacy-secret');
            "#,
        )
        .unwrap();

        let paths = crate::paths::AppPaths::new(temp_dir("ai-queue-network").join("app-data"))
            .expect("app paths");

        match ai_queue_can_process(&conn, &paths).unwrap() {
            AiQueueDecision::Wait => {}
            _ => panic!("AI queue should wait when external network is disabled"),
        }
    }

    #[test]
    fn create_skill_review_blocks_unsafe_markdown() {
        let review = create_skill_review_markdown(
            "---\nname: unsafe\n---\nRun `rm -rf /` and store api_key: value.",
            Some("unsafe"),
        );
        let codes = review
            .get("blocking")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| v.get("code").and_then(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>();
        assert!(codes.iter().any(|code| code == "PRIVATE_FIELD"));
        assert!(codes.iter().any(|code| code == "DANGEROUS_SHELL"));
    }

    #[test]
    fn create_skill_local_draft_reviews_cleanly() {
        let spec = create_skill_local_spec(
            "Create a reusable PR review checklist focused on regressions.",
            "en",
            &json!({
                "target_context": "code_review",
                "input_scope": "codebase",
                "artifact": "checklist",
                "strictness": "confirm"
            }),
        );
        let markdown = create_skill_local_markdown(&spec);
        let review =
            create_skill_review_markdown(&markdown, spec.get("name").and_then(Value::as_str));
        assert_eq!(
            review
                .get("blocking")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(0)
        );
    }

    #[test]
    fn create_skill_repair_frontmatter_fills_missing_name_from_spec() {
        let spec = create_skill_local_spec(
            "Product iteration synthesis",
            "en",
            &json!({
                "target_context": "general_agent_workflow",
                "input_scope": "materials",
                "artifact": "markdown",
                "strictness": "confirm"
            }),
        );
        let markdown = "---\ndescription: Use when synthesizing scattered product notes into an iteration plan.\n---\n\n# Product Iteration\n\n## Inputs\n\n- Notes\n";

        let repaired = create_skill_repair_frontmatter(markdown, &spec);
        let review =
            create_skill_review_markdown(&repaired, spec.get("name").and_then(Value::as_str));

        assert!(repaired.starts_with("---\nname: product-iteration-synthesis\n"));
        assert_eq!(
            review
                .get("blocking")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(0)
        );
    }

    #[test]
    fn create_skill_repair_frontmatter_prefers_zh_description_for_zh_spec() {
        let mut spec = create_skill_local_spec(
            "把零散想法收敛为产品迭代方案",
            "zh",
            &json!({
                "target_context": "general_agent_workflow",
                "input_scope": "materials",
                "artifact": "markdown",
                "strictness": "confirm"
            }),
        );
        spec["name"] = json!("product-iteration-synthesizer");
        let markdown = "---\nname: product-iteration-synthesizer\ndescription: \"Use when turning scattered notes into a product plan.\"\n---\n\n# 产品迭代方案合成器\n\n## 输入\n\n- 零散想法\n";

        let repaired = create_skill_repair_frontmatter(markdown, &spec);

        assert!(repaired.contains("description: \"当用户需要"));
        assert!(!repaired.contains("Use when turning scattered notes"));
    }

    #[test]
    fn create_skill_repair_frontmatter_replaces_generic_empty_trigger() {
        let mut spec = create_skill_local_spec(
            "把零散想法、会议记录和焦虑点收敛成产品迭代方案",
            "zh",
            &json!({
                "target_context": "general_agent_workflow",
                "input_scope": "materials",
                "artifact": "markdown",
                "strictness": "confirm"
            }),
        );
        spec["description"] =
            json!("当用户需要把零散想法、会议记录和焦虑点收敛成产品迭代方案时使用。");
        let markdown = "---\nname: product-iteration-convergence\ndescription: \"当用户需要一个可复用的Agent 工作技能时使用：\"\n---\n\n# 产品迭代收敛技能\n\n## 输入\n\n- 零散想法\n";

        let repaired = create_skill_repair_frontmatter(markdown, &spec);

        assert!(repaired.contains(
            "description: \"当用户需要把零散想法、会议记录和焦虑点收敛成产品迭代方案时使用。\""
        ));
        assert!(!repaired.contains("可复用的Agent 工作技能时使用："));
    }

    #[test]
    fn create_skill_repair_frontmatter_replaces_generic_name() {
        let mut spec = create_skill_local_spec(
            "把零散想法、会议记录和焦虑点收敛成产品迭代方案",
            "zh",
            &json!({
                "target_context": "general_agent_workflow",
                "input_scope": "materials",
                "artifact": "markdown",
                "strictness": "confirm"
            }),
        );
        spec["name"] = json!("product-iteration-convergence");
        let markdown = "---\nname: agent\ndescription: \"当用户需要把零散想法收敛成产品迭代方案时使用。\"\n---\n\n# 产品迭代收敛技能\n";

        let repaired = create_skill_repair_frontmatter(markdown, &spec);

        assert!(repaired.starts_with("---\nname: product-iteration-convergence\n"));
    }

    #[test]
    fn create_skill_repair_frontmatter_keeps_spec_name_over_model_rename() {
        let mut spec = create_skill_local_spec(
            "把零散想法、会议记录和焦虑点收敛成产品迭代方案",
            "zh",
            &json!({
                "target_context": "general_agent_workflow",
                "input_scope": "materials",
                "artifact": "markdown",
                "strictness": "confirm"
            }),
        );
        spec["name"] = json!("product-iteration-planner");
        let markdown = "---\nname: idea-converge\ndescription: \"当用户需要把零散想法收敛成产品迭代方案时使用。\"\n---\n\n# 思路聚合技能\n";

        let repaired = create_skill_repair_frontmatter(markdown, &spec);

        assert!(repaired.starts_with("---\nname: product-iteration-planner\n"));
        assert!(!repaired.contains("name: idea-converge"));
    }

    #[test]
    fn create_skill_repair_frontmatter_replaces_english_prefix_in_zh_description() {
        let mut spec = create_skill_local_spec(
            "把零散想法、会议记录和焦虑点收敛成产品迭代方案",
            "zh",
            &json!({
                "target_context": "general_agent_workflow",
                "input_scope": "materials",
                "artifact": "markdown",
                "strictness": "confirm"
            }),
        );
        spec["description"] =
            json!("当用户需要把零散想法、会议记录和焦虑点收敛成产品迭代方案时使用。");
        let markdown = "---\nname: refine-ideas-to-product-iteration\ndescription: \"Use when 用户提供零散想法、会议记录或焦虑点，要求生成可执行的产品迭代方案\"\n---\n\n# 产品迭代方案\n";

        let repaired = create_skill_repair_frontmatter(markdown, &spec);

        assert!(repaired.contains("description: \"当用户需要把零散想法"));
        assert!(!repaired.contains("description: \"Use when"));
    }

    #[test]
    fn create_skill_user_simulation_generates_reviews_plans_and_installs() {
        let (app, root) = create_skill_smoke_app();
        let state = app.state::<AppState>();
        configure_create_skill_mock_llm(state.clone());
        let prompt = "release risk review for Tauri desktop builds: 用户给我变更说明、CI 结果和安装包路径，希望得到发布风险清单、阻断项和下一步验证方案。";
        let start_response = create_skill_mock_start_response(prompt);
        let generate_response = create_skill_mock_generate_response();

        with_create_skill_mock_responses(Some(&start_response), Some(&generate_response), || {
            let start = ai_create_skill_start(
                Some(json!({
                    "prompt": prompt,
                    "language": "zh"
                })),
                state.clone(),
            )
            .expect("start draft");
            let draft_id = start["draft"]["id"].as_str().expect("draft id");
            let initial_spec = &start["draft"]["skillSpec"];
            assert_eq!(start["aiUsed"].as_bool(), Some(true));
            assert_eq!(
                initial_spec["intentFrame"]["whenToUse"].as_str(),
                Some(prompt)
            );
            assert_eq!(
                start["draft"]["followupQuestions"].as_array().map(Vec::len),
                Some(1)
            );

            let answered = create_skill_answer(state.clone(), draft_id, "strictness", "confirm");
            let spec = answered["draft"]["skillSpec"].clone();
            assert_eq!(
                spec["intentFrame"]["safety"]["artifactType"].as_str(),
                Some("checklist")
            );
            assert_eq!(
                spec["intentFrame"]["safety"]["overwrite"].as_str(),
                Some("confirm_each_time")
            );

            let generated = tauri::async_runtime::block_on(ai_create_skill_generate(
                Some(json!({
                    "draftId": draft_id,
                    "skillSpec": spec
                })),
                state.clone(),
            ))
            .expect("generate markdown");
            let markdown = generated["draft"]["draftMarkdown"]
                .as_str()
                .expect("draft markdown");
            let target_basename = generated["draft"]["skillSpec"]["name"]
                .as_str()
                .expect("generated skill name");
            assert!(target_basename.starts_with("release-risk-review"));
            assert!(markdown.contains(target_basename));
            assert!(markdown.contains("## 输入"));
            assert!(markdown.contains("## 工作流"));
            assert!(markdown.contains("## 边界"));
            assert!(markdown.contains("发布风险 checklist"));
            assert!(!markdown.contains("Confirm the task framing"));

            let review = ai_create_skill_review(
                Some(json!({
                    "draftId": draft_id,
                    "markdown": markdown,
                    "targetBasename": target_basename
                })),
                state.clone(),
            )
            .expect("review markdown");
            assert_eq!(
                review["review"]["blocking"].as_array().map(Vec::len),
                Some(0)
            );
            assert_eq!(
                review["review"]["checks"]["noSilentNetwork"].as_bool(),
                Some(true)
            );
            assert_eq!(
                review["review"]["checks"]["noSilentOverwrite"].as_bool(),
                Some(true)
            );
            assert_eq!(
                review["review"]["warnings"].as_array().map(Vec::len),
                Some(0)
            );

            let planned = ai_create_skill_plan(
                Some(json!({
                    "draftId": draft_id,
                    "targetBasename": target_basename,
                    "targetPlatformIds": [],
                    "targetScenarioIds": []
                })),
                state.clone(),
            )
            .expect("plan install");
            let token = planned["plan"]["token"].as_str().expect("plan token");
            assert_eq!(planned["plan"]["operation"].as_str(), Some("create_skill"));
            assert_eq!(
                planned["plan"]["items"][0]["action"].as_str(),
                Some("copy_to_canonical")
            );

            let executed = ai_create_skill_execute(
                Some(json!({
                    "draftId": draft_id,
                    "token": token,
                    "targetScenarioIds": []
                })),
                state.clone(),
            )
            .expect("execute install");
            let skill_id = executed["skillId"].as_str().expect("installed skill id");
            assert_eq!(executed["draft"]["status"].as_str(), Some("installed"));
            assert_eq!(
                executed["draft"]["installedSkillId"].as_str(),
                Some(skill_id)
            );

            let installed = root.join("shared").join(target_basename).join("SKILL.md");
            assert!(installed.exists(), "installed SKILL.md should exist");
            let installed_markdown = fs::read_to_string(&installed).expect("installed markdown");
            assert_eq!(installed_markdown, markdown);
            assert!(installed_markdown.contains("发布风险 checklist"));

            let db = state.db.get().expect("db conn");
            let installed_count: i64 = db
                .query_row(
                    "SELECT COUNT(*) FROM skills WHERE id = ?1 AND name = ?2",
                    params![skill_id, target_basename],
                    |row| row.get(0),
                )
                .expect("installed skill row");
            assert_eq!(installed_count, 1);

            println!(
                "create skill smoke installed {} at {}",
                skill_id,
                installed.display()
            );
        });
    }

    fn create_skill_seed_draft(state: State<'_, AppState>, prompt: &str) -> String {
        let start_response = create_skill_mock_start_response(prompt);
        with_create_skill_mock_responses(Some(&start_response), None, || {
            let start = ai_create_skill_start(
                Some(json!({ "prompt": prompt, "language": "zh" })),
                state.clone(),
            )
            .expect("start draft");
            start["draft"]["id"]
                .as_str()
                .expect("draft id")
                .to_string()
        })
    }

    #[test]
    fn create_skill_answer_uses_llm_resynthesis_when_available() {
        // D：LLM mock 返回时，追问回灌走 LLM 路径并以重新归纳的 spec 更新草稿。
        let (app, _root) = create_skill_smoke_app();
        let state = app.state::<AppState>();
        configure_create_skill_mock_llm(state.clone());
        let prompt = "release risk review for Tauri desktop builds.";
        let draft_id = create_skill_seed_draft(state.clone(), prompt);
        let answer_response = create_skill_mock_answer_response();

        let answered = with_create_skill_answer_mock(Some(&answer_response), || {
            tauri::async_runtime::block_on(ai_create_skill_answer(
                Some(json!({
                    "draftId": draft_id,
                    "questionId": "strictness",
                    "answer": "confirm"
                })),
                state.clone(),
            ))
            .expect("answer via llm")
        });

        assert_eq!(answered["aiUsed"].as_bool(), Some(true));
        let spec = &answered["draft"]["skillSpec"];
        // 重新归纳后的 whenToUse 来自 LLM 回灌，而非原始 prompt 透传。
        assert_eq!(
            spec["intentFrame"]["whenToUse"].as_str(),
            Some("审查 Tauri 桌面发布风险，并在遇到不确定项时阻断确认。")
        );
        assert!(spec["intentFrame"]["boundaries"]
            .as_array()
            .is_some_and(|items| items
                .iter()
                .any(|v| v.as_str() == Some("遇到不确定项必须阻断并请求用户确认。"))));
    }

    #[test]
    fn create_skill_answer_falls_back_to_keyword_mapping_when_llm_unavailable() {
        // D：LLM 失败（未设 answer mock env）→ 回退确定性关键词映射，aiUsed=false。
        let (app, _root) = create_skill_smoke_app();
        let state = app.state::<AppState>();
        configure_create_skill_mock_llm(state.clone());
        let prompt = "release risk review for Tauri desktop builds.";
        let draft_id = create_skill_seed_draft(state.clone(), prompt);

        let answered = with_create_skill_answer_mock(None, || {
            tauri::async_runtime::block_on(ai_create_skill_answer(
                Some(json!({
                    "draftId": draft_id,
                    "questionId": "strictness",
                    "answer": "confirm"
                })),
                state.clone(),
            ))
            .expect("answer via fallback")
        });

        assert_eq!(answered["aiUsed"].as_bool(), Some(false));
        let spec = &answered["draft"]["skillSpec"];
        // 确定性映射：strictness=confirm → overwrite=confirm_each_time。
        assert_eq!(
            spec["intentFrame"]["safety"]["overwrite"].as_str(),
            Some("confirm_each_time")
        );
    }

    #[test]
    fn create_skill_start_rejects_empty_llm_response_without_draft() {
        let (app, _root) = create_skill_smoke_app();
        let state = app.state::<AppState>();
        configure_create_skill_mock_llm(state.clone());

        with_create_skill_mock_responses(Some(""), None, || {
            let err = ai_create_skill_start(
                Some(json!({
                    "prompt": "把长视频转成同目录 SRT 字幕，不合成视频。",
                    "language": "zh"
                })),
                state.clone(),
            )
            .expect_err("empty model response should fail");
            assert_eq!(err.code, "LLM_BAD_RESPONSE");
            assert_create_skill_draft_count(state.clone(), 0);
        });
    }

    #[test]
    fn create_skill_start_degrades_name_only_response_to_clarification() {
        // 澄清在先模型：一份只有名字、没有契约内容的稀薄响应不再硬失败，而是优雅降级为
        // needs_clarification —— 带追问、建草稿，让用户把输入/输出契约补清楚。
        let (app, _root) = create_skill_smoke_app();
        let state = app.state::<AppState>();
        configure_create_skill_mock_llm(state.clone());
        let response = json!({
            "schemaVersion": "create-skill.v1",
            "command": "start",
            "skillSpec": { "name": "video-to-srt", "language": "zh" },
            "questions": []
        })
        .to_string();

        with_create_skill_mock_responses(Some(&response), None, || {
            let result = ai_create_skill_start(
                Some(json!({
                    "prompt": "把长视频转成同目录 SRT 字幕，不合成视频。",
                    "language": "zh"
                })),
                state.clone(),
            )
            .expect("thin name-only response should degrade to clarification, not error");
            assert_eq!(
                result.get("status").and_then(Value::as_str),
                Some("needs_clarification")
            );
            assert!(
                result
                    .get("questions")
                    .and_then(Value::as_array)
                    .is_some_and(|q| !q.is_empty()),
                "should ask clarifying questions"
            );
            assert_create_skill_draft_count(state.clone(), 1);
        });
    }

    #[test]
    fn create_skill_start_degrades_empty_content_envelope_to_clarification() {
        let (app, _root) = create_skill_smoke_app();
        let state = app.state::<AppState>();
        configure_create_skill_mock_llm(state.clone());
        let response = json!({
            "schemaVersion": "create-skill.v1",
            "command": "start",
            "skillSpec": {
                "name": "video-to-srt",
                "description": "",
                "language": "zh",
                "intentFrame": {
                    "userJob": "",
                    "triggerContext": "",
                    "inputContract": { "acceptedInputs": [] },
                    "outputContract": { "artifactType": "markdown", "destination": "reply_only" },
                    "workflow": { "steps": [], "failClosedRules": [] },
                    "stylePreferences": [],
                    "nonGoals": [],
                    "successCriteria": []
                }
            },
            "questions": [
                { "id": "scope", "question": "范围？", "options": [], "allowFreeform": true }
            ]
        })
        .to_string();

        with_create_skill_mock_responses(Some(&response), None, || {
            let result = ai_create_skill_start(
                Some(json!({
                    "prompt": "把长视频转成同目录 SRT 字幕，不合成视频。",
                    "language": "zh"
                })),
                state.clone(),
            )
            .expect("schema-correct but empty-content envelope should degrade to clarification");
            assert_eq!(
                result.get("status").and_then(Value::as_str),
                Some("needs_clarification")
            );
            assert_create_skill_draft_count(state.clone(), 1);
        });
    }

    #[test]
    fn create_skill_live_llm_user_simulation_generates_reviewable_skill() {
        let Some(api_key) = std::env::var("MYSKILLS_LIVE_LLM_API_KEY")
            .ok()
            .filter(|value| !value.trim().is_empty())
        else {
            eprintln!("skipping live Create Skill LLM test; MYSKILLS_LIVE_LLM_API_KEY is not set");
            return;
        };
        let (app, root) = create_skill_smoke_app();
        let state = app.state::<AppState>();
        secret_vault::write(&state.paths, LLM_API_KEY_NAME, &api_key)
            .expect("live key vault write");
        {
            let db = state.db.get().expect("db conn");
            let model = std::env::var("MYSKILLS_LIVE_LLM_MODEL")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "deepseek-v4-flash".to_string());
            for (key, value) in [
                ("allow_external_network", "1".to_string()),
                ("llm.feature.createSkill", "1".to_string()),
                ("llm.provider", "deepseek".to_string()),
                ("llm.model", model),
                ("llm.baseUrl", "".to_string()),
                (LLM_API_KEY_STORED_SETTING, "1".to_string()),
                (LLM_CONNECTION_OK_SETTING, "1".to_string()),
            ] {
                db.execute(
                    "INSERT INTO settings (key, value) VALUES (?1, ?2)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    params![key, value],
                )
                .expect("live llm setting");
            }
        }

        let prompt = "我经常把一堆零散想法、会议记录和焦虑点发给 Agent，希望它帮我收敛成一个能执行的产品迭代方案：先识别真正的问题，再判断哪些想法只是噪音，最后输出版本目标、用户路径、风险和下一步验证清单。请为这个场景创造一个可复用技能。";
        let start = ai_create_skill_start(
            Some(json!({
                "prompt": prompt,
                "language": "zh"
            })),
            state.clone(),
        )
        .expect("live start draft");
        assert_eq!(
            start["aiUsed"].as_bool(),
            Some(true),
            "start must use the live LLM"
        );
        let draft_id = start["draft"]["id"].as_str().expect("draft id");
        assert!(
            start["draft"]["followupQuestions"]
                .as_array()
                .is_some_and(|items| !items.is_empty()),
            "live model should return option-based follow-up questions"
        );

        let mut answered = Value::Null;
        for (question_id, answer) in [
            ("target_context", "general_agent_workflow"),
            ("input_scope", "materials"),
            ("artifact", "markdown"),
            ("strictness", "confirm"),
        ] {
            answered = create_skill_answer(state.clone(), draft_id, question_id, answer);
        }
        assert_eq!(answered["draft"]["status"].as_str(), Some("spec_ready"));
        let spec = answered["draft"]["skillSpec"].clone();

        let generated = tauri::async_runtime::block_on(ai_create_skill_generate(
            Some(json!({
                "draftId": draft_id,
                "skillSpec": spec
            })),
            state.clone(),
        ))
        .expect("live generate markdown");
        assert_eq!(
            generated["aiUsed"].as_bool(),
            Some(true),
            "generate must use the live LLM"
        );
        let markdown = generated["draft"]["draftMarkdown"]
            .as_str()
            .expect("live draft markdown");
        let target_basename = generated["draft"]["targetBasename"]
            .as_str()
            .or_else(|| generated["draft"]["skillSpec"]["name"].as_str())
            .unwrap_or_else(|| {
                panic!(
                    "live skill name missing; draft={}",
                    generated["draft"].to_string()
                )
            });
        let review = ai_create_skill_review(
            Some(json!({
                "draftId": draft_id,
                "markdown": markdown,
                "targetBasename": target_basename
            })),
            state.clone(),
        )
        .expect("live review markdown");
        let blocking_len = review["review"]["blocking"]
            .as_array()
            .map(Vec::len)
            .unwrap_or(usize::MAX);
        let warning_len = review["review"]["warnings"]
            .as_array()
            .map(Vec::len)
            .unwrap_or(usize::MAX);
        assert!(
            markdown.contains("## 输入")
                || markdown.contains("## 工作流")
                || markdown.contains("## 输出")
                || markdown.contains("安全边界"),
            "live zh generation should keep the SKILL.md body in Chinese; markdown=\n{}",
            markdown
        );
        let live_frontmatter = markdown
            .strip_prefix("---\n")
            .and_then(|rest| rest.find("\n---").map(|end| &rest[..end]))
            .unwrap_or("");
        let live_description =
            frontmatter_scalar(live_frontmatter, "description").unwrap_or_default();
        assert!(
            contains_cjk(&live_description) && description_trigger_clear(&live_description),
            "live zh generation should keep a concrete Chinese trigger description; description={}; markdown=\n{}",
            live_description,
            markdown
        );
        assert!(
            !live_description.to_lowercase().starts_with("use when"),
            "live zh generation should not keep an English trigger prefix; description={}; markdown=\n{}",
            live_description,
            markdown
        );
        assert!(
            !live_description
                .trim()
                .ends_with("Agent 工作技能时使用"),
            "live zh generation should not keep a generic empty trigger description; description={}; markdown=\n{}",
            live_description,
            markdown
        );
        assert_ne!(
            target_basename, "agent",
            "live generation should not keep a generic skill name; markdown=\n{}",
            markdown
        );
        assert_eq!(
            blocking_len, 0,
            "live generated skill should not be blocked; blocking={}; markdown=\n{}",
            review["review"]["blocking"], markdown
        );
        assert_eq!(
            warning_len, 0,
            "live generated skill should not have quality warnings; warnings={}; markdown=\n{}",
            review["review"]["warnings"], markdown
        );

        let planned = ai_create_skill_plan(
            Some(json!({
                "draftId": draft_id,
                "targetBasename": target_basename,
                "targetPlatformIds": [],
                "targetScenarioIds": []
            })),
            state.clone(),
        )
        .expect("live plan install");
        let token = planned["plan"]["token"].as_str().expect("plan token");
        let executed = ai_create_skill_execute(
            Some(json!({
                "draftId": draft_id,
                "token": token,
                "targetScenarioIds": []
            })),
            state.clone(),
        )
        .expect("live execute install");
        let installed = root.join("shared").join(target_basename).join("SKILL.md");
        assert!(installed.exists(), "live installed SKILL.md should exist");
        println!(
            "live create skill smoke installed skillId={} at {}",
            executed["skillId"].as_str().unwrap_or(""),
            installed.display()
        );
        println!("live create skill name={target_basename}");
        println!(
            "live create skill review warnings={}",
            review["review"]["warnings"]
        );
        println!("live create skill markdown:\n{markdown}");
    }

    #[test]
    fn create_skill_review_warns_on_weak_trigger_and_missing_structure() {
        let review = create_skill_review_markdown(
            "---\nname: weak-skill\ndescription: Help with anything.\n---\n\n# weak-skill\n\nSome notes.",
            Some("weak-skill"),
        );
        let blocking = review
            .get("blocking")
            .and_then(Value::as_array)
            .map(Vec::len);
        let warnings = review
            .get("warnings")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| v.get("code").and_then(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>();
        assert_eq!(blocking, Some(0));
        assert!(warnings
            .iter()
            .any(|code| code == "WEAK_TRIGGER_DESCRIPTION"));
        assert!(warnings
            .iter()
            .any(|code| code == "MISSING_EXECUTABLE_WORKFLOW"));
        assert!(warnings.iter().any(|code| code == "MISSING_BOUNDARIES"));
        assert!(warnings.iter().any(|code| code == "MISSING_QUALITY_BAR"));
    }

    #[test]
    fn create_skill_review_accepts_creative_section_names() {
        let review = create_skill_review_markdown(
            "---\nname: creative-review\ndescription: Use when shaping an unusual critique workflow from rough notes.\n---\n\n# creative-review\n\n## Materials\n\n- Rough notes\n\n## Critic Ritual\n\n1. Find the core tension.\n2. Name the strongest counter-reading.\n\n## Deliverable\n\n- A compact critique memo.\n\n## Guardrails\n\n- Ask before using external sources.\n\n## Acceptance\n\n- The memo names the central tension and a serious counter-reading.\n",
            Some("creative-review"),
        );
        assert_eq!(
            review
                .get("blocking")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(0)
        );
        assert_eq!(
            review
                .get("checks")
                .and_then(|checks| checks.get("hasWorkflow"))
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            review
                .get("checks")
                .and_then(|checks| checks.get("hasBoundaries"))
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            review
                .get("warnings")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(0)
        );
    }

    #[test]
    fn create_skill_review_accepts_chinese_accepted_input_heading() {
        let review = create_skill_review_markdown(
            "---\nname: idea-convergent\ndescription: 使用技能将零散想法、会议记录和焦虑点收敛为可执行的产品迭代方案时使用。\n---\n\n# 想法收敛技能\n\n## 接受输入\n\n- 用户原始文本。\n\n## 工作流程\n\n1. 解析输入。\n2. 输出方案。\n\n## 输出格式\n\n- Markdown 文档。\n\n## 边界与限制\n\n- 不执行外部网络调用或文件写入，除非用户明确确认。\n\n## 质量要求\n\n- 输出必须可执行。\n",
            Some("idea-convergent"),
        );
        assert_eq!(
            review
                .get("warnings")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(0)
        );
    }

    #[test]
    fn create_skill_review_blocks_silent_network_and_destructive_write() {
        // 真实祈使命令行（curl / rm -rf）未 gate → 仍 blocking。
        let review = create_skill_review_markdown(
            "---\nname: unsafe-network\ndescription: Use when testing unsafe automation defaults.\n---\n\n# unsafe-network\n\n## Workflow\n\n1. Run `curl https://example.com/data` and save it.\n2. Run `rm -rf ./old-output`.\n\n## Output\n\n- Updated data.\n",
            Some("unsafe-network"),
        );
        let codes = review
            .get("blocking")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| v.get("code").and_then(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>();
        assert!(codes.iter().any(|code| code == "NETWORK_NEEDS_GATE"));
        assert!(codes.iter().any(|code| code == "WRITE_NEEDS_GATE"));
    }

    #[test]
    fn create_skill_review_warns_but_does_not_block_on_mere_mention() {
        // 纯引用 URL + 说明性句子（"不要覆盖 frontmatter"）→ 不 blocking，最多 warning。
        let review = create_skill_review_markdown(
            "---\nname: gentle-skill\ndescription: Use when documenting a workflow that references external docs.\n---\n\n# gentle-skill\n\n## Inputs\n\n- A draft document.\n\n## Workflow\n\n1. Read the spec at https://docs.example.com/guide for context.\n2. Do not overwrite the frontmatter when editing.\n\n## Output\n\n- An edited document.\n\n## Boundaries\n\n- Stay local.\n\n## Quality Bar\n\n- The frontmatter is preserved.\n",
            Some("gentle-skill"),
        );
        let blocking = review
            .get("blocking")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| v.get("code").and_then(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>();
        let warnings = review
            .get("warnings")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| v.get("code").and_then(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>();
        assert!(!blocking.iter().any(|code| code == "NETWORK_NEEDS_GATE"));
        assert!(!blocking.iter().any(|code| code == "WRITE_NEEDS_GATE"));
        assert!(warnings.iter().any(|code| code == "NETWORK_MENTION_UNGATED"));
        assert!(warnings.iter().any(|code| code == "WRITE_MENTION_UNGATED"));
    }

    #[test]
    fn create_skill_review_does_not_let_unrelated_confirmation_gate_network() {
        // 真实命令 curl，且同行用 "without asking" 显式否定 gate → 仍 blocking。
        let review = create_skill_review_markdown(
            "---\nname: unsafe-network\ndescription: Use when testing unsafe automation defaults.\n---\n\n# unsafe-network\n\n## Boundaries\n\n- Confirm before deleting files.\n\n## Workflow\n\n1. Run `curl https://example.com/data` without asking.\n\n## Output\n\n- Updated data.\n\n## Quality Bar\n\n- Data source is cited.\n",
            Some("unsafe-network"),
        );
        let codes = review
            .get("blocking")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| v.get("code").and_then(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>();
        assert!(codes.iter().any(|code| code == "NETWORK_NEEDS_GATE"));
    }

    #[test]
    fn create_skill_review_blocks_chinese_destructive_command_without_gate() {
        // 中文正文里嵌入真实 rm -rf 命令未 gate → 仍 blocking。
        let review = create_skill_review_markdown(
            "---\nname: unsafe-write\ndescription: Use when testing unsafe file changes.\n---\n\n# unsafe-write\n\n## 输入\n\n- 本地文件路径\n\n## 工作流\n\n1. 执行 `rm -rf ./output` 清理旧产物。\n\n## 输出\n\n- 新文件\n\n## 安全边界\n\n- 不联网。\n\n## 质量标准\n\n- 输出路径存在。\n",
            Some("unsafe-write"),
        );
        let codes = review
            .get("blocking")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| v.get("code").and_then(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>();
        assert!(codes.iter().any(|code| code == "WRITE_NEEDS_GATE"));
    }

    #[test]
    fn create_skill_review_downgrades_chinese_prose_destructive_to_warning() {
        // 中文散文式"删除旧文件并覆盖输出"（非真实命令）→ 不 blocking，降级为 warning。
        let review = create_skill_review_markdown(
            "---\nname: prose-write\ndescription: Use when testing prose-level file changes.\n---\n\n# prose-write\n\n## 输入\n\n- 本地文件路径\n\n## 工作流\n\n1. 删除旧文件并覆盖输出。\n\n## 输出\n\n- 新文件\n\n## 安全边界\n\n- 不联网。\n\n## 质量标准\n\n- 输出路径存在。\n",
            Some("prose-write"),
        );
        let blocking = review
            .get("blocking")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| v.get("code").and_then(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>();
        let warnings = review
            .get("warnings")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| v.get("code").and_then(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>();
        assert!(!blocking.iter().any(|code| code == "WRITE_NEEDS_GATE"));
        assert!(warnings.iter().any(|code| code == "WRITE_MENTION_UNGATED"));
    }

    #[test]
    fn create_skill_review_allows_explicit_network_prohibition() {
        let review = create_skill_review_markdown(
            "---\nname: local-only-skill\ndescription: 当需要整理本地输入并产出方案时使用。\n---\n\n# local-only-skill\n\n## 输入\n\n- 用户提供的文本\n\n## 工作流\n\n1. 整理输入。\n2. 生成方案。\n\n## 输出\n\n- Markdown 方案\n\n## 边界\n\n- 不访问外部网络或用户隐私数据。\n- 不得发送网络请求。\n- 不读取或写入文件。\n- 不删除任何数据。\n- 文件写入、删除、覆盖、联网调用或密钥处理前必须明确确认。\n\n## 质量要求\n\n- 输出可执行。\n",
            Some("local-only-skill"),
        );
        let codes = review
            .get("blocking")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| v.get("code").and_then(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>();
        assert!(!codes.iter().any(|code| code == "NETWORK_NEEDS_GATE"));
        assert!(!codes.iter().any(|code| code == "WRITE_NEEDS_GATE"));
    }

    #[test]
    fn create_skill_review_blocks_expanded_private_fields() {
        let review = create_skill_review_markdown(
            "---\nname: unsafe-secret\ndescription: Use when testing secret handling.\n---\n\n# unsafe-secret\n\n## Inputs\n\n- Bearer token: abc\n\n## Workflow\n\n1. Inspect the request.\n\n## Output\n\n- Report.\n\n## Boundaries\n\n- Keep secrets local.\n\n## Quality Bar\n\n- No credentials are exposed.\n",
            Some("unsafe-secret"),
        );
        let codes = review
            .get("blocking")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| v.get("code").and_then(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>();
        assert!(codes.iter().any(|code| code == "PRIVATE_FIELD"));
    }

    #[test]
    fn create_skill_installability_allows_quality_warnings() {
        // 只有质量类 warning（这里缺 Quality Bar 段）而无 blocking → 仍可安装。
        let review = create_skill_review_markdown(
            "---\nname: warning-only\ndescription: Use when reviewing pull requests for regressions and test gaps.\n---\n\n# warning-only\n\n## Inputs\n\n- PR diff\n\n## Workflow\n\n1. Inspect diff.\n\n## Output\n\n- Checklist.\n\n## Boundaries\n\n- Ask before writes.\n",
            Some("warning-only"),
        );
        assert_eq!(
            review
                .get("blocking")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(0)
        );
        assert!(
            review
                .get("warnings")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0)
                > 0,
            "fixture should still surface quality warnings"
        );
        assert!(create_skill_review_is_installable(&review));
    }

    #[test]
    fn create_skill_installability_rejects_blocking_only() {
        // 有 blocking（这里 name 与 basename 不匹配）→ 不可安装。
        let review = create_skill_review_markdown(
            "---\nname: actual-skill\ndescription: Use when reviewing pull requests for regressions and test gaps.\n---\n\n# actual-skill\n\n## Inputs\n\n- PR diff\n\n## Workflow\n\n1. Inspect diff.\n2. Check tests.\n3. Report risks.\n\n## Output\n\n- Checklist.\n\n## Boundaries\n\n- Ask before writes.\n\n## Quality Bar\n\n- Risks are listed.\n",
            Some("expected-skill"),
        );
        assert!(
            review
                .get("blocking")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0)
                > 0
        );
        assert!(!create_skill_review_is_installable(&review));
    }

    #[test]
    fn create_skill_start_coerces_spec_shaped_llm_payload() {
        let payload = create_skill_coerce_start_payload(
            json!({
                "name": "Product Iteration Synthesizer",
                "description": "当用户需要把零散想法收敛成产品迭代方案时使用。",
                "intentFrame": {
                    "whenToUse": "把零散想法收敛成产品迭代方案",
                    "userInput": "会议记录、零散想法",
                    "output": "一份产品迭代方案，含版本目标、用户路径和风险。",
                    "outputParts": ["版本目标", "风险与下一步验证"],
                    "workflow": ["识别真实问题", "判断哪些想法是噪音", "输出版本目标和验证清单"],
                    "boundaries": ["文件写入前确认", "不替用户决定优先级"],
                    "successCriteria": ["版本目标清晰"],
                    "safety": { "network": "no", "fileWrites": "none", "overwrite": "never", "privacy": "local_only", "artifactType": "markdown" }
                },
                "followupQuestions": [
                    { "id": "strictness", "question": "是否需要确认？", "options": [{ "id": "confirm", "label": "确认", "effect": "strictness=confirm" }] }
                ]
            }),
            "把零散想法收敛成产品迭代方案",
            "zh",
        );
        let (spec, questions) =
            create_skill_envelope_payload(payload, "start").expect("coerced start payload");

        assert_eq!(
            spec.get("name").and_then(Value::as_str),
            Some("product-iteration-synthesizer")
        );
        assert_eq!(
            spec["intentFrame"]["whenToUse"].as_str(),
            Some("把零散想法收敛成产品迭代方案")
        );
        assert_eq!(questions.as_array().map(Vec::len), Some(1));
    }

    #[test]
    fn create_skill_start_repairs_common_llm_array_aliases() {
        // 旧/别名形状（triggerContext、userJob、acceptedInputs、workflow.steps、acceptanceCriteria、nonGoals）
        // 应被惰性迁移层映射到新 5 支柱并通过 quality gate。
        let mut spec = json!({
            "name": "Obsidian Polish",
            "description": "当用户需要把 Obsidian 中文稿件润色得更犀利且保留口语感时使用。",
            "language": "zh",
            "intentFrame": {
                "userJob": "把 Obsidian 中文稿件润色得更犀利，同时保留口语感",
                "triggerContext": "用户提供一段中文草稿，希望调整表达力度和可读性。",
                "inputContract": { "acceptedInputs": ["Obsidian 中文草稿", "用户对口语感、犀利程度和保留内容的要求"] },
                "output": "一段更犀利但保留口语感的中文改写。",
                "outputParts": ["改写后的正文", "改动说明"],
                "workflow": { "steps": ["识别原稿意图和语气", "压缩解释性表达", "输出保留口语感的改写版本"] },
                "acceptanceCriteria": ["改写后更犀利但不丢失原始意思"]
            },
            "questions": []
        });

        create_skill_repair_start_spec(
            &mut spec,
            "帮我固定一套 Obsidian 中文稿件润色流程，保留口语感但更犀利。",
            "zh",
        );
        let issues =
            create_skill_start_quality_issues(&spec, &create_skill_default_questions(&spec));

        assert!(
            issues.is_empty(),
            "alias-shaped spec should pass quality gate: {issues:?}"
        );
        // 旧 triggerContext 迁入 whenToUse，旧 userJob + acceptedInputs 折叠进 userInput。
        assert_eq!(
            spec["intentFrame"]["whenToUse"].as_str(),
            Some("用户提供一段中文草稿，希望调整表达力度和可读性。")
        );
        assert!(spec["intentFrame"]["userInput"]
            .as_str()
            .is_some_and(|s| s.contains("Obsidian 中文草稿")));
        assert_eq!(
            spec["intentFrame"]["outputParts"].as_array().map(Vec::len),
            Some(2)
        );
        assert_eq!(
            spec["intentFrame"]["workflow"].as_array().map(Vec::len),
            Some(3)
        );
        assert_eq!(
            spec["intentFrame"]["successCriteria"]
                .as_array()
                .map(Vec::len),
            Some(1)
        );
    }

    #[test]
    fn create_skill_normalize_spec_repairs_bad_intent_shape_before_answer() {
        let mut spec = json!({
            "name": "bad-intent-shape",
            "description": "当用户需要把零散想法收敛成产品迭代方案时使用。",
            "language": "zh",
            "intentFrame": "not an object"
        });

        create_skill_normalize_spec(&mut spec);
        create_skill_apply_answer(&mut spec, "input_scope", "materials");

        assert!(spec["intentFrame"]["userInput"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty()));
    }

    #[test]
    fn create_skill_review_blocks_name_basename_mismatch() {
        let review = create_skill_review_markdown(
            "---\nname: actual-skill\ndescription: Use when reviewing pull requests for regressions and test gaps.\n---\n\n# actual-skill\n\n## Inputs\n\n- PR diff\n\n## Workflow\n\n1. Inspect diff\n2. Check tests\n3. Report risks\n\n## Output\n\n- Checklist\n\n## Boundaries\n\n- Ask before writes.\n",
            Some("expected-skill"),
        );
        let codes = review
            .get("blocking")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| v.get("code").and_then(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>();
        assert!(codes.iter().any(|code| code == "NAME_BASENAME_MISMATCH"));
    }
}

const CATALOG_USER_AGENT: &str =
    "MySkills/0.2.0-tauri.0 (+https://github.com/Milktang0128/myskills)";
const CATALOG_SEARCH_BASE: &str = "https://skills.sh/api/search";
const CATALOG_GH_REPO_API: &str = "https://api.github.com/repos";
const CATALOG_GH_RAW: &str = "https://raw.githubusercontent.com";
const CATALOG_CACHE_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const CATALOG_MAX_BATCH_SIZE: usize = 30;
const CATALOG_EXCERPT_CHARS: usize = 500;
const LLM_API_KEY_NAME: &str = "llm.apiKey";
const LLM_API_KEY_STORED_SETTING: &str = "llm.apiKeyStored";
const LLM_CONNECTION_OK_SETTING: &str = "llm.connectionOk";

/// 自适应澄清循环的硬轮数上界。连续这么多个澄清轮仍未自评 ready 时，Rust 用
/// 「必须结晶」prompt 强制最后一次 LLM 调用产出 spec —— 永不困在盘问里（用户也可随时
/// 点「够了，直接生成」提前强制结晶）。
const CREATE_SKILL_MAX_CLARIFY_ROUNDS: i64 = 3;

#[tauri::command]
pub async fn catalog_search(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let db = conn(&state)?;
    require_network(&db)?;
    let q = required_str(&payload, "q")?.trim().to_string();
    if q.is_empty() {
        return Ok(
            json!({ "query": "", "searchType": "fuzzy", "skills": [], "count": 0, "duration_ms": 0 }),
        );
    }
    let limit = clamp_i64(optional_i64(&payload, "limit").unwrap_or(30), 1, 100).to_string();
    let offset = optional_i64(&payload, "offset")
        .unwrap_or(0)
        .max(0)
        .to_string();
    let client = catalog_client()?;
    let res = client
        .get(CATALOG_SEARCH_BASE)
        .query(&[
            ("q", q.as_str()),
            ("limit", limit.as_str()),
            ("offset", offset.as_str()),
        ])
        .header(reqwest::header::USER_AGENT, CATALOG_USER_AGENT)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .map_err(|err| {
            AppError::new(
                "CATALOG_UNAVAILABLE",
                format!("Could not reach skills.sh - check your network connection. ({err})"),
            )
        })?;
    let status = res.status();
    if status.as_u16() == 429 {
        return Err(AppError::new(
            "CATALOG_RATE_LIMITED",
            "skills.sh rate-limited this request. Wait a moment and try again.",
        ));
    }
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(AppError::new(
            "CATALOG_UNAUTHORIZED",
            "Public search is no longer available on skills.sh.",
        ));
    }
    if !status.is_success() {
        return Err(AppError::new(
            "CATALOG_UNAVAILABLE",
            format!(
                "skills.sh returned HTTP {} {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("")
            ),
        ));
    }
    let body = res.json::<Value>().map_err(|err| {
        AppError::new(
            "CATALOG_BAD_RESPONSE",
            format!("skills.sh returned malformed JSON: {err}"),
        )
    })?;
    Ok(normalize_catalog_search_response(&body, &q))
}

#[tauri::command]
pub async fn catalog_preview(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let db = conn(&state)?;
    let source = required_str(&payload, "source")?;
    let skill_id = required_str(&payload, "skillId")?;
    let raw = catalog_fetch_skill_content(&db, source, skill_id)?;
    let (frontmatter, body) = catalog_parse_markdown(&raw)?;
    let excerpt = body
        .trim()
        .chars()
        .take(CATALOG_EXCERPT_CHARS)
        .collect::<String>();
    Ok(json!({
        "source": source,
        "skillId": skill_id,
        "rawMarkdown": raw,
        "frontmatter": frontmatter,
        "bodyExcerpt": if excerpt.is_empty() { Value::Null } else { Value::String(excerpt) },
    }))
}

#[tauri::command]
pub async fn catalog_enrich_descriptions(
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> AppResult<Value> {
    let db = conn(&state)?;
    let raw_items = payload
        .as_ref()
        .and_then(|p| p.get("items"))
        .and_then(Value::as_array)
        .ok_or_else(|| {
            AppError::new(
                "INVALID_INPUT",
                "items (array of {source, skillId}) required",
            )
        })?;
    let items = raw_items
        .iter()
        .filter_map(|item| {
            Some((
                item.get("source")?.as_str()?.to_string(),
                item.get("skillId")?.as_str()?.to_string(),
            ))
        })
        .take(CATALOG_MAX_BATCH_SIZE)
        .collect::<Vec<_>>();
    let now = now_ms();
    let mut results: Vec<Option<Value>> = vec![None; items.len()];
    let mut todo = Vec::new();

    for (index, (source, skill_id)) in items.iter().enumerate() {
        if let Some((description, fetched_at)) =
            catalog_read_description_cache(&db, source, skill_id)?
        {
            if now - fetched_at < CATALOG_CACHE_TTL_MS {
                results[index] = Some(json!({
                    "source": source,
                    "skillId": skill_id,
                    "description": description
                }));
                continue;
            }
        }
        todo.push(index);
    }

    if !todo.is_empty() && get_setting(&db, "allow_external_network")?.as_deref() == Some("1") {
        for index in todo.iter().copied() {
            let (source, skill_id) = &items[index];
            let description = catalog_fetch_skill_content(&db, source, skill_id)
                .ok()
                .and_then(|raw| catalog_description_from_markdown(&raw).ok().flatten());
            catalog_write_description_cache(&db, source, skill_id, description.as_deref())?;
            results[index] = Some(json!({
                "source": source,
                "skillId": skill_id,
                "description": description
            }));
        }
    }

    for index in todo {
        if results[index].is_none() {
            let (source, skill_id) = &items[index];
            results[index] = Some(json!({
                "source": source,
                "skillId": skill_id,
                "description": Value::Null
            }));
        }
    }

    Ok(Value::Array(results.into_iter().flatten().collect()))
}

#[tauri::command]
pub async fn catalog_plan_install(
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> AppResult<Value> {
    let source = required_str(&payload, "source")?;
    let skill_id = required_str(&payload, "skillId")?;
    let skill_name = required_str(&payload, "skillName")?;
    let target_platform_ids = payload
        .as_ref()
        .and_then(|p| p.get("targetPlatformIds"))
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::new("INVALID_INPUT", "targetPlatformIds (string[]) required"))?
        .iter()
        .map(|v| {
            v.as_str().map(str::to_string).ok_or_else(|| {
                AppError::new("INVALID_INPUT", "targetPlatformIds entries must be strings")
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    let db = conn(&state)?;
    let raw = catalog_fetch_skill_content(&db, source, skill_id)?;
    let (frontmatter, _) = catalog_parse_markdown(&raw)?;
    let fm_name = frontmatter
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if fm_name.is_none() {
        return Err(AppError::new(
            "MISSING_FRONTMATTER",
            format!("SKILL.md from {source}/{skill_id} has no `name` field - cannot install."),
        ));
    }
    let fm_name = fm_name.unwrap_or(skill_name);
    let basename = sanitize_catalog_basename(skill_id)
        .filter(|name| is_safe_basename(name))
        .ok_or_else(|| {
            AppError::new(
                "INVALID_INPUT",
                format!("cannot derive safe install basename from \"{skill_id}\""),
            )
        })?;
    let stage_wrap = state.paths.staging_root.join(Uuid::new_v4().to_string());
    let stage_dir = stage_wrap.join(&basename);
    if let Err(err) = (|| -> AppResult<()> {
        fs::create_dir_all(&stage_dir)?;
        fs::write(stage_dir.join("SKILL.md"), raw.as_bytes())?;
        Ok(())
    })() {
        let _ = fs::remove_dir_all(&stage_wrap);
        return Err(AppError::new(
            "STAGING_FAILED",
            format!("Could not stage skill for install: {}", err.message),
        ));
    }
    let source_hash = hex::encode(sha2::Sha256::digest(raw.as_bytes()));
    match catalog_plan_from_staging(
        &state,
        &db,
        &stage_dir,
        fm_name,
        &source_hash,
        source,
        skill_id,
        &target_platform_ids,
    ) {
        Ok(plan) => Ok(plan),
        Err(err) => {
            let _ = fs::remove_dir_all(&stage_wrap);
            Err(err)
        }
    }
}

fn build_catalog_client() -> AppResult<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|err| AppError::new("CATALOG_HTTP_CLIENT_FAILED", err.to_string()))
}

fn build_llm_client() -> AppResult<reqwest::blocking::Client> {
    let builder = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(300));
    #[cfg(test)]
    let builder = if let Ok(ip) = std::env::var("MYSKILLS_LIVE_LLM_RESOLVE_IP") {
        if let Ok(ip) = ip.parse::<std::net::IpAddr>() {
            builder.resolve("api.deepseek.com", std::net::SocketAddr::new(ip, 443))
        } else {
            builder
        }
    } else {
        builder
    };
    builder
        .build()
        .map_err(|err| AppError::new("LLM_HTTP_CLIENT_FAILED", err.to_string()))
}

// reqwest::blocking::Client owns an internal Tokio runtime. The LLM/catalog
// commands are `async` (so they never block the UI thread), which Tauri runs on
// an async worker; dropping that runtime there panics with "cannot drop a
// runtime in a context where blocking is not allowed". Cache each client
// process-wide (OnceLock — never dropped) and hand out cheap clones that share
// the runtime via Arc, so a per-call clone drop only decrements the refcount
// and never drops the runtime on an async worker (nor on shutdown).
fn catalog_client() -> AppResult<reqwest::blocking::Client> {
    static CLIENT: std::sync::OnceLock<reqwest::blocking::Client> = std::sync::OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c.clone());
    }
    let client = build_catalog_client()?;
    let _ = CLIENT.set(client.clone());
    Ok(client)
}

fn llm_client() -> AppResult<reqwest::blocking::Client> {
    static CLIENT: std::sync::OnceLock<reqwest::blocking::Client> = std::sync::OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c.clone());
    }
    let client = build_llm_client()?;
    let _ = CLIENT.set(client.clone());
    Ok(client)
}

fn llm_request_error(provider: &str, err: reqwest::Error) -> AppError {
    if err.is_timeout() {
        return AppError::new(
            "LLM_TIMEOUT",
            "LLM request timed out. Try again, or use a faster model in Settings -> AI.",
        );
    }
    if err.is_connect() {
        return AppError::new(
            "LLM_UNAVAILABLE",
            format!("Could not connect to {provider}: {err}"),
        );
    }
    AppError::new(
        "LLM_UNAVAILABLE",
        format!("Could not reach {provider}: {err}"),
    )
}

fn catalog_fetch_skill_content(db: &Connection, source: &str, skill_id: &str) -> AppResult<String> {
    require_network(db)?;
    if !is_valid_catalog_source(source) {
        return Err(AppError::new(
            "INVALID_INPUT",
            format!("bad source \"{source}\" - expected owner/repo"),
        ));
    }
    if !is_valid_catalog_skill_id(skill_id) {
        return Err(AppError::new(
            "INVALID_INPUT",
            format!("bad skillId \"{skill_id}\""),
        ));
    }
    let client = llm_client()?;
    let branch = catalog_default_branch(&client, source)?;
    let candidates = [
        format!("skills/{skill_id}/SKILL.md"),
        format!("skills/.curated/{skill_id}/SKILL.md"),
        format!("skills/.experimental/{skill_id}/SKILL.md"),
        format!("{skill_id}/SKILL.md"),
        "SKILL.md".to_string(),
    ];
    let mut last_err = None;
    for sub_path in candidates {
        let encoded_path = sub_path
            .split('/')
            .map(percent_encode_segment)
            .collect::<Vec<_>>()
            .join("/");
        let url = format!(
            "{}/{}/{}/{}",
            CATALOG_GH_RAW,
            source,
            percent_encode_segment(&branch),
            encoded_path
        );
        let res = match client
            .get(&url)
            .header(reqwest::header::USER_AGENT, CATALOG_USER_AGENT)
            .header(reqwest::header::ACCEPT, "text/plain")
            .send()
        {
            Ok(res) => res,
            Err(err) => {
                last_err = Some(err.to_string());
                continue;
            }
        };
        let status = res.status();
        if status.as_u16() == 404 {
            continue;
        }
        if status.as_u16() == 429 {
            return Err(AppError::new(
                "CATALOG_RATE_LIMITED",
                "GitHub rate-limited the SKILL.md fetch. Wait a moment and try again.",
            ));
        }
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(AppError::new(
                "CATALOG_UNAUTHORIZED",
                format!(
                    "GitHub denied the SKILL.md fetch for \"{source}\" (HTTP {}).",
                    status.as_u16()
                ),
            ));
        }
        if !status.is_success() {
            last_err = Some(format!(
                "HTTP {} {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("")
            ));
            continue;
        }
        let text = res
            .text()
            .map_err(|err| AppError::new("CATALOG_UNAVAILABLE", err.to_string()))?;
        if !text.is_empty() {
            return Ok(text);
        }
    }
    Err(AppError::new(
        "CONTENT_NOT_FOUND",
        format!(
            "Could not find SKILL.md for {source}/{skill_id} on any known path{}.",
            last_err
                .map(|err| format!(" (last error: {err})"))
                .unwrap_or_default()
        ),
    ))
}

fn catalog_default_branch(client: &reqwest::blocking::Client, source: &str) -> AppResult<String> {
    let url = format!("{CATALOG_GH_REPO_API}/{source}");
    let res = match client
        .get(&url)
        .header(reqwest::header::USER_AGENT, CATALOG_USER_AGENT)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
    {
        Ok(res) => res,
        Err(_) => return Ok("main".to_string()),
    };
    let status = res.status();
    if status.as_u16() == 404 {
        return Err(AppError::new(
            "CATALOG_REPO_NOT_FOUND",
            format!("GitHub repository \"{source}\" does not exist."),
        ));
    }
    if status.as_u16() == 429 {
        return Err(AppError::new(
            "CATALOG_RATE_LIMITED",
            "GitHub rate-limited the request. Wait a few minutes and try again.",
        ));
    }
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(AppError::new(
            "CATALOG_UNAUTHORIZED",
            format!(
                "GitHub denied the request for \"{source}\" (HTTP {}). Likely rate-limit on unauthenticated calls.",
                status.as_u16()
            ),
        ));
    }
    if !status.is_success() {
        return Ok("main".to_string());
    }
    let body = match res.json::<Value>() {
        Ok(body) => body,
        Err(_) => return Ok("main".to_string()),
    };
    Ok(body
        .get("default_branch")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("main")
        .to_string())
}

fn normalize_catalog_search_response(body: &Value, query: &str) -> Value {
    let skills = body
        .get("skills")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(normalize_catalog_result)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let count = number_to_i64(body.get("count")).unwrap_or(skills.len() as i64);
    json!({
        "query": body.get("query").and_then(Value::as_str).unwrap_or(query),
        "searchType": body.get("searchType").and_then(Value::as_str).unwrap_or("fuzzy"),
        "skills": skills,
        "count": count,
        "duration_ms": number_to_i64(body.get("duration_ms")).unwrap_or(0),
    })
}

fn normalize_catalog_result(raw: &Value) -> Option<Value> {
    let obj = raw.as_object()?;
    let name = obj.get("name")?.as_str()?;
    let source = obj.get("source")?.as_str()?;
    let id = obj.get("id").and_then(Value::as_str);
    let skill_id = obj
        .get("skillId")
        .and_then(Value::as_str)
        .or_else(|| obj.get("skill_id").and_then(Value::as_str))
        .or_else(|| obj.get("slug").and_then(Value::as_str))
        .map(str::to_string)
        .or_else(|| id.map(last_path_segment))
        .or_else(|| Some(last_path_segment(name)))?;
    if skill_id.is_empty() {
        return None;
    }
    let mut result = Map::new();
    let result_id = id
        .map(str::to_string)
        .unwrap_or_else(|| format!("{source}/{skill_id}"));
    result.insert("id".to_string(), Value::String(result_id));
    result.insert("skillId".to_string(), Value::String(skill_id));
    result.insert("name".to_string(), Value::String(name.to_string()));
    result.insert("source".to_string(), Value::String(source.to_string()));
    result.insert(
        "installs".to_string(),
        Value::Number(
            number_to_i64(obj.get("installs"))
                .or_else(|| number_to_i64(obj.get("install_count")))
                .unwrap_or(0)
                .into(),
        ),
    );
    if let Some(description) = obj.get("description").and_then(Value::as_str) {
        result.insert(
            "description".to_string(),
            Value::String(description.to_string()),
        );
    }
    Some(Value::Object(result))
}

fn catalog_parse_markdown(raw: &str) -> AppResult<(Value, String)> {
    let Some((frontmatter, body)) = catalog_split_frontmatter(raw) else {
        return Ok((json!({}), raw.to_string()));
    };
    let docs = yaml_rust2::YamlLoader::load_from_str(frontmatter).map_err(|err| {
        AppError::new(
            "PARSE_ERROR",
            format!("SKILL.md frontmatter is invalid: {err}"),
        )
    })?;
    let frontmatter_json = docs.first().map(yaml_to_json).unwrap_or_else(|| json!({}));
    Ok((frontmatter_json, body.to_string()))
}

fn catalog_split_frontmatter(raw: &str) -> Option<(&str, &str)> {
    let rest = raw
        .strip_prefix("---\n")
        .or_else(|| raw.strip_prefix("---\r\n"))?;
    if let Some(idx) = rest.find("\n---\n") {
        let body_start = idx + "\n---\n".len();
        return Some((&rest[..idx], &rest[body_start..]));
    }
    if let Some(idx) = rest.find("\r\n---\r\n") {
        let body_start = idx + "\r\n---\r\n".len();
        return Some((&rest[..idx], &rest[body_start..]));
    }
    None
}

fn catalog_description_from_markdown(raw: &str) -> AppResult<Option<String>> {
    let (frontmatter, _) = catalog_parse_markdown(raw)?;
    Ok(frontmatter
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string))
}

fn catalog_read_description_cache(
    db: &Connection,
    source: &str,
    skill_id: &str,
) -> AppResult<Option<(Option<String>, i64)>> {
    Ok(db
        .query_row(
            "SELECT description, fetched_at FROM catalog_descriptions WHERE source = ?1 AND skill_id = ?2",
            params![source, skill_id],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)?)),
        )
        .optional()?)
}

fn catalog_write_description_cache(
    db: &Connection,
    source: &str,
    skill_id: &str,
    description: Option<&str>,
) -> AppResult<()> {
    db.execute(
        "INSERT INTO catalog_descriptions (source, skill_id, description, fetched_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(source, skill_id) DO UPDATE SET
           description = excluded.description,
           fetched_at = excluded.fetched_at",
        params![source, skill_id, description, now_ms()],
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn catalog_plan_from_staging(
    state: &State<'_, AppState>,
    db: &Connection,
    staging_dir: &Path,
    skill_name: &str,
    source_hash: &str,
    installed_from_source: &str,
    installed_from_skill_id: &str,
    target_platform_ids: &[String],
) -> AppResult<Value> {
    let platforms = sync_platforms(db)?;
    let enabled_ids = platforms.iter().map(|p| p.id.clone()).collect::<Vec<_>>();
    let canonical = canonical_platform(db, &enabled_ids)?;
    let canonical_platform = platforms
        .iter()
        .find(|p| p.id == canonical)
        .ok_or_else(|| {
            AppError::new(
                "INVALID_STATE",
                format!("canonical platform \"{canonical}\" is not registered"),
            )
        })?;
    let op_group_id = Uuid::new_v4().to_string();
    let placeholder_skill_id = format!("pending:{installed_from_source}:{installed_from_skill_id}");
    let skill = SyncSkillRow {
        id: placeholder_skill_id,
        name: skill_name.to_string(),
    };
    let staging = LocRow {
        id: -1,
        skill_id: skill.id.clone(),
        platform_id: "staging".to_string(),
        install_path: staging_dir.to_string_lossy().to_string(),
        real_path: staging_dir.to_string_lossy().to_string(),
        is_symlink: false,
        is_broken_link: false,
        is_disabled: false,
        content_hash: Some(source_hash.to_string()),
        mtime: None,
    };
    let mut items = Vec::new();
    if has_symlink_in_tree(staging_dir)? {
        items.push(sync_placeholder(
            &skill,
            "staging",
            &canonical,
            "conflict",
            "source_has_symlink",
            &op_group_id,
        ));
        let plan = finalize_sync_plan("promote_to_canonical", items);
        store_plan(state, &plan)?;
        return Ok(plan);
    }
    let mut copy_item = build_sync_item(SyncBuildItemArgs {
        skill: &skill,
        source: Some(&staging),
        target: None,
        source_platform_id: "staging",
        target_platform_id: &canonical,
        target_platform_dir: &canonical_platform.skills_dir,
        op_group_id: &op_group_id,
        override_action: Some("copy_to_canonical"),
    });
    copy_item["installedFromSource"] = json!(installed_from_source);
    copy_item["installedFromSkillId"] = json!(installed_from_skill_id);
    let canonical_target = copy_item
        .get("targetPath")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let target_basename = copy_item
        .get("targetBasename")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let can_symlink = copy_item.get("action").and_then(Value::as_str) == Some("copy_to_canonical");
    items.push(copy_item);

    if can_symlink {
        for target_id in target_platform_ids {
            if target_id == &canonical {
                continue;
            }
            let Some(platform) = platforms.iter().find(|p| p.id == *target_id) else {
                continue;
            };
            let target_path = PathBuf::from(&platform.skills_dir).join(&target_basename);
            if !target_inside_platform(&target_path, &platform.skills_dir) {
                continue;
            }
            items.push(json!({
                "skillName": skill_name,
                "skillId": skill.id.clone(),
                "opGroupId": op_group_id.clone(),
                "targetBasename": target_basename.clone(),
                "sourcePlatformId": canonical,
                "sourceLocationId": -1,
                "sourceRealPath": canonical_target.clone(),
                "sourceDev": 0,
                "sourceIno": 0,
                "sourceHash": source_hash,
                "targetPlatformId": target_id,
                "targetPath": target_path.to_string_lossy(),
                "targetHash": Value::Null,
                "mode": "symlink",
                "action": "symlink_replace",
                "installedFromSource": installed_from_source,
                "installedFromSkillId": installed_from_skill_id,
            }));
        }
    }

    let plan = finalize_sync_plan("promote_to_canonical", items);
    store_plan(state, &plan)?;
    Ok(plan)
}

fn yaml_to_json(yaml: &yaml_rust2::Yaml) -> Value {
    match yaml {
        yaml_rust2::Yaml::Real(s) => s
            .parse::<f64>()
            .ok()
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number)
            .unwrap_or_else(|| Value::String(s.clone())),
        yaml_rust2::Yaml::Integer(i) => Value::Number((*i).into()),
        yaml_rust2::Yaml::String(s) => Value::String(s.clone()),
        yaml_rust2::Yaml::Boolean(b) => Value::Bool(*b),
        yaml_rust2::Yaml::Array(items) => Value::Array(items.iter().map(yaml_to_json).collect()),
        yaml_rust2::Yaml::Hash(hash) => {
            let mut map = Map::new();
            for (key, value) in hash {
                if let Some(key) = yaml_key_to_string(key) {
                    map.insert(key, yaml_to_json(value));
                }
            }
            Value::Object(map)
        }
        yaml_rust2::Yaml::Null | yaml_rust2::Yaml::BadValue | yaml_rust2::Yaml::Alias(_) => {
            Value::Null
        }
    }
}

fn yaml_key_to_string(yaml: &yaml_rust2::Yaml) -> Option<String> {
    match yaml {
        yaml_rust2::Yaml::String(s) => Some(s.clone()),
        yaml_rust2::Yaml::Integer(i) => Some(i.to_string()),
        yaml_rust2::Yaml::Boolean(b) => Some(b.to_string()),
        _ => None,
    }
}

fn is_valid_catalog_source(source: &str) -> bool {
    let mut parts = source.split('/');
    let Some(owner) = parts.next() else {
        return false;
    };
    let Some(repo) = parts.next() else {
        return false;
    };
    if parts.next().is_some()
        || owner.is_empty()
        || repo.is_empty()
        || owner.len() > 39
        || repo.len() > 100
    {
        return false;
    }
    let owner_ok = owner
        .chars()
        .enumerate()
        .all(|(idx, c)| c.is_ascii_alphanumeric() || (idx > 0 && c == '-'));
    let repo_ok = repo
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.');
    owner_ok && repo_ok
}

fn is_valid_catalog_skill_id(skill_id: &str) -> bool {
    !skill_id.is_empty()
        && skill_id.len() <= 100
        && skill_id.chars().enumerate().all(|(idx, c)| {
            c.is_ascii_alphanumeric() || (idx > 0 && (c == '-' || c == '_' || c == '.'))
        })
}

fn sanitize_catalog_basename(input: &str) -> Option<String> {
    let cleaned = input
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '/' | '\\' | ':' | '?' | '*' | '"' | '<' | '>' | '|')
        })
        .collect::<String>()
        .trim_start_matches('.')
        .trim()
        .chars()
        .take(100)
        .collect::<String>();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        None
    } else {
        Some(cleaned)
    }
}

fn percent_encode_segment(input: &str) -> String {
    let mut out = String::new();
    for byte in input.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn last_path_segment(input: &str) -> String {
    input
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_string()
}

fn number_to_i64(value: Option<&Value>) -> Option<i64> {
    value.and_then(|v| {
        v.as_i64()
            .or_else(|| v.as_u64().and_then(|u| i64::try_from(u).ok()))
            .or_else(|| v.as_f64().map(|f| f as i64))
    })
}

fn clamp_i64(n: i64, lo: i64, hi: i64) -> i64 {
    n.max(lo).min(hi)
}

#[tauri::command]
pub fn llm_get_config(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let _ = payload;
    let db = conn(&state)?;
    llm_config_response(&db, &state.paths)
}

fn llm_config_response(db: &Connection, paths: &AppPaths) -> AppResult<Value> {
    let provider = get_setting(db, "llm.provider")?.unwrap_or_else(|| "deepseek".to_string());
    let model = get_setting(db, "llm.model")?.unwrap_or_else(|| "deepseek-v4-flash".to_string());
    let base_url = get_setting(db, "llm.baseUrl")?.unwrap_or_default();
    let has_api_key = llm_has_api_key(db, paths)?;
    let connection_ok = get_setting(db, LLM_CONNECTION_OK_SETTING)?.as_deref() == Some("1");
    Ok(
        json!({ "provider": provider, "model": model, "baseUrl": base_url, "hasApiKey": has_api_key, "connectionOk": connection_ok }),
    )
}

#[tauri::command]
pub fn llm_set_config(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let p = payload.unwrap_or_else(|| json!({}));
    let db = conn(&state)?;
    for (json_key, setting_key) in [
        ("provider", "llm.provider"),
        ("model", "llm.model"),
        ("baseUrl", "llm.baseUrl"),
    ] {
        if let Some(v) = p.get(json_key).and_then(Value::as_str) {
            if json_key == "provider" && !is_valid_llm_provider(v) {
                return Err(AppError::new(
                    "INVALID_INPUT",
                    format!("unknown provider \"{v}\""),
                ));
            }
            db.execute("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![setting_key, v])?;
        }
    }
    db.execute(
        "DELETE FROM settings WHERE key = ?1",
        params![LLM_CONNECTION_OK_SETTING],
    )?;
    llm_get_config(None, state)
}

#[tauri::command]
pub fn llm_set_api_key(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let key = required_str(&payload, "key")?;
    let db = conn(&state)?;
    secret_vault::write(&state.paths, LLM_API_KEY_NAME, key)?;
    db.execute("DELETE FROM settings WHERE key = 'secret:llm.apiKey'", [])?;
    db.execute(
        "INSERT INTO settings (key, value) VALUES (?1, '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![LLM_API_KEY_STORED_SETTING],
    )?;
    db.execute(
        "DELETE FROM settings WHERE key = ?1",
        params![LLM_CONNECTION_OK_SETTING],
    )?;
    maybe_start_ai_worker(&state);
    Ok(json!({ "ok": true, "hasApiKey": true }))
}

#[tauri::command]
pub fn llm_delete_api_key(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let _ = payload;
    let db = conn(&state)?;
    secret_vault::delete(&state.paths, LLM_API_KEY_NAME)?;
    db.execute(
        "DELETE FROM settings WHERE key IN ('secret:llm.apiKey', ?1, ?2)",
        params![LLM_API_KEY_STORED_SETTING, LLM_CONNECTION_OK_SETTING],
    )?;
    Ok(json!({ "ok": true, "hasApiKey": false }))
}

#[tauri::command]
pub async fn llm_chat(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let db = conn(&state)?;
    require_network(&db)?;
    let req = payload
        .as_ref()
        .and_then(|p| p.get("req"))
        .ok_or_else(|| AppError::new("INVALID_INPUT", "req.messages required"))?;
    let messages = req
        .get("messages")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
        .ok_or_else(|| AppError::new("INVALID_INPUT", "req.messages required"))?;
    for message in messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::new("INVALID_INPUT", "message.role required"))?;
        if !matches!(role, "system" | "user" | "assistant") {
            return Err(AppError::new(
                "INVALID_INPUT",
                format!("unsupported message role \"{role}\""),
            ));
        }
        if message.get("content").and_then(Value::as_str).is_none() {
            return Err(AppError::new("INVALID_INPUT", "message.content required"));
        }
    }
    let config = llm_read_config(&db)?;
    if config.model.trim().is_empty() {
        return Err(AppError::new(
            "LLM_NO_MODEL",
            "No model configured. Set one in Settings -> AI.",
        ));
    }
    let api_key = llm_read_api_key(&db, &state.paths)?;
    llm_chat_with_config(&config, api_key.as_deref(), req)
}

#[tauri::command]
pub async fn llm_test_connection(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let _ = payload;
    let db = conn(&state)?;
    if get_setting(&db, "allow_external_network")?.as_deref() != Some("1") {
        return Ok(json!({
            "ok": false,
            "message": "External network is disabled in Settings. Toggle \"Allow external network requests\" to enable LLM calls."
        }));
    }
    let config = llm_read_config(&db)?;
    if config.model.trim().is_empty() {
        return Ok(json!({ "ok": false, "message": "No model configured." }));
    }
    let api_key = llm_read_api_key(&db, &state.paths)?;
    let req = if config.provider == "anthropic" {
        json!({
            "messages": [{ "role": "user", "content": "ping" }],
            "maxTokens": 8,
            "temperature": 0
        })
    } else {
        json!({
            "messages": [{ "role": "user", "content": "Reply with exactly: PONG" }],
            "maxTokens": 512,
            "temperature": 0
        })
    };
    match llm_chat_with_config(&config, api_key.as_deref(), &req) {
        Ok(response) => {
            let text = response.get("text").and_then(Value::as_str).unwrap_or("");
            db.execute(
                "INSERT INTO settings (key, value) VALUES (?1, '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![LLM_CONNECTION_OK_SETTING],
            )?;
            Ok(
                json!({ "ok": true, "message": if text.is_empty() { "OK".to_string() } else { format!("OK ({})", truncate(text, 60)) } }),
            )
        }
        Err(err) => {
            db.execute(
                "DELETE FROM settings WHERE key = ?1",
                params![LLM_CONNECTION_OK_SETTING],
            )?;
            Ok(json!({ "ok": false, "message": err.message }))
        }
    }
}

#[derive(Clone)]
struct LlmRuntimeConfig {
    provider: String,
    model: String,
    base_url: Option<String>,
}

fn llm_read_config(db: &Connection) -> AppResult<LlmRuntimeConfig> {
    let provider = get_setting(db, "llm.provider")?.unwrap_or_else(|| "deepseek".to_string());
    let provider = if is_valid_llm_provider(&provider) {
        provider
    } else {
        "openai".to_string()
    };
    let model = get_setting(db, "llm.model")?.unwrap_or_default();
    let base_url = get_setting(db, "llm.baseUrl")?
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty());
    Ok(LlmRuntimeConfig {
        provider,
        model,
        base_url,
    })
}

fn llm_read_api_key(db: &Connection, paths: &AppPaths) -> AppResult<Option<String>> {
    #[cfg(test)]
    if let Ok(value) = std::env::var("MYSKILLS_LIVE_LLM_API_KEY") {
        let value = value.trim().to_string();
        if !value.is_empty() {
            return Ok(Some(value));
        }
    }
    if let Some(value) = secret_vault::read(paths, LLM_API_KEY_NAME)? {
        return Ok(Some(value));
    }
    let Some(legacy) = get_setting(db, "secret:llm.apiKey")? else {
        return Ok(None);
    };
    let migrated = STANDARD
        .decode(legacy.as_bytes())
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or(legacy);
    secret_vault::write(paths, LLM_API_KEY_NAME, &migrated)?;
    db.execute("DELETE FROM settings WHERE key = 'secret:llm.apiKey'", [])?;
    db.execute(
        "INSERT INTO settings (key, value) VALUES (?1, '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![LLM_API_KEY_STORED_SETTING],
    )?;
    Ok(Some(migrated))
}

fn llm_has_api_key(db: &Connection, paths: &AppPaths) -> AppResult<bool> {
    if get_setting(db, "secret:llm.apiKey")?.is_some() {
        return Ok(true);
    }
    secret_vault::contains(paths, LLM_API_KEY_NAME)
}

fn llm_chat_with_config(
    config: &LlmRuntimeConfig,
    api_key: Option<&str>,
    req: &Value,
) -> AppResult<Value> {
    if config.provider == "anthropic" {
        llm_chat_anthropic(config, api_key, req)
    } else {
        llm_chat_openai_compatible(config, api_key, req)
    }
}

fn llm_chat_openai_compatible(
    config: &LlmRuntimeConfig,
    api_key: Option<&str>,
    req: &Value,
) -> AppResult<Value> {
    let base_url = llm_resolve_openai_base_url(config)?;
    let messages = req
        .get("messages")
        .cloned()
        .ok_or_else(|| AppError::new("INVALID_INPUT", "req.messages required"))?;
    let mut body = Map::new();
    body.insert("model".to_string(), Value::String(config.model.clone()));
    body.insert("messages".to_string(), messages);
    body.insert(
        "temperature".to_string(),
        req.get("temperature")
            .and_then(Value::as_f64)
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number)
            .unwrap_or_else(|| json!(0.2)),
    );
    body.insert(
        "max_tokens".to_string(),
        req.get("maxTokens")
            .and_then(Value::as_i64)
            .unwrap_or(4096)
            .into(),
    );
    if req.get("jsonMode").and_then(Value::as_bool) == Some(true) {
        body.insert(
            "response_format".to_string(),
            json!({ "type": "json_object" }),
        );
    }
    let client = llm_client()?;
    let mut request = client
        .post(format!("{base_url}/chat/completions"))
        .header(reqwest::header::CONTENT_TYPE, "application/json");
    if let Some(key) = api_key.filter(|_| config.provider != "ollama") {
        request = request.bearer_auth(key);
    }
    if config.provider == "openrouter" {
        request = request
            .header("http-referer", "https://myskills.local")
            .header("x-title", "MySkills");
    }
    let res = request
        .json(&Value::Object(body))
        .send()
        .map_err(|err| llm_request_error("LLM provider", err))?;
    let status = res.status();
    if !status.is_success() {
        let text = res.text().unwrap_or_default();
        return Err(AppError::new(
            "LLM_HTTP_ERROR",
            format!(
                "LLM request failed ({}): {}",
                status.as_u16(),
                truncate(&text, 400)
            ),
        ));
    }
    let json = res
        .json::<Value>()
        .map_err(|err| AppError::new("LLM_BAD_RESPONSE", err.to_string()))?;
    let choice = json
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first());
    let text = choice
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let finish_reason = choice
        .and_then(|choice| choice.get("finish_reason"))
        .and_then(Value::as_str);
    if text.is_empty() && finish_reason == Some("length") {
        let reasoning_tokens = json
            .pointer("/usage/completion_tokens_details/reasoning_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        return Err(AppError::new(
            "LLM_BUDGET_EXHAUSTED",
            if reasoning_tokens > 0 {
                format!("The model spent its entire token budget on internal reasoning ({reasoning_tokens} reasoning tokens) without producing output. Try a larger maxTokens or a non-reasoning model.")
            } else {
                "Response was truncated at max_tokens before any content was produced. Try a larger maxTokens.".to_string()
            },
        ));
    }
    Ok(llm_response(text, llm_openai_usage(&json)))
}

fn llm_chat_anthropic(
    config: &LlmRuntimeConfig,
    api_key: Option<&str>,
    req: &Value,
) -> AppResult<Value> {
    let api_key = api_key
        .ok_or_else(|| AppError::new("LLM_NO_KEY", "Anthropic provider requires an API key."))?;
    let base_url = config
        .base_url
        .clone()
        .unwrap_or_else(|| "https://api.anthropic.com/v1".to_string());
    let mut system_parts = Vec::new();
    let mut messages = Vec::new();
    for message in req
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::new("INVALID_INPUT", "req.messages required"))?
    {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::new("INVALID_INPUT", "message.role required"))?;
        let content = message
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::new("INVALID_INPUT", "message.content required"))?;
        if role == "system" {
            system_parts.push(content.to_string());
        } else {
            messages.push(json!({ "role": role, "content": content }));
        }
    }
    let mut body = Map::new();
    body.insert("model".to_string(), Value::String(config.model.clone()));
    body.insert("messages".to_string(), Value::Array(messages));
    body.insert(
        "max_tokens".to_string(),
        req.get("maxTokens")
            .and_then(Value::as_i64)
            .unwrap_or(1024)
            .into(),
    );
    body.insert(
        "temperature".to_string(),
        req.get("temperature")
            .and_then(Value::as_f64)
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number)
            .unwrap_or_else(|| json!(0.2)),
    );
    if req.get("jsonMode").and_then(Value::as_bool) == Some(true) {
        system_parts
            .push("Respond with a single JSON object and no surrounding prose.".to_string());
    }
    if !system_parts.is_empty() {
        body.insert(
            "system".to_string(),
            Value::String(system_parts.join("\n\n")),
        );
    }
    let client = llm_client()?;
    let res = client
        .post(format!("{base_url}/messages"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&Value::Object(body))
        .send()
        .map_err(|err| llm_request_error("Anthropic", err))?;
    let status = res.status();
    if !status.is_success() {
        let text = res.text().unwrap_or_default();
        return Err(AppError::new(
            "LLM_HTTP_ERROR",
            format!(
                "Anthropic request failed ({}): {}",
                status.as_u16(),
                truncate(&text, 400)
            ),
        ));
    }
    let json = res
        .json::<Value>()
        .map_err(|err| AppError::new("LLM_BAD_RESPONSE", err.to_string()))?;
    let text = json
        .get("content")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<String>()
        })
        .unwrap_or_default();
    Ok(llm_response(text, llm_anthropic_usage(&json)))
}

fn llm_response(text: String, usage: Value) -> Value {
    let mut response = Map::new();
    response.insert("text".to_string(), Value::String(text));
    if !usage.is_null() {
        response.insert("usage".to_string(), usage);
    }
    Value::Object(response)
}

fn llm_openai_usage(json: &Value) -> Value {
    let Some(usage) = json.get("usage") else {
        return Value::Null;
    };
    json!({
        "promptTokens": usage.get("prompt_tokens").and_then(Value::as_i64).unwrap_or(0),
        "completionTokens": usage.get("completion_tokens").and_then(Value::as_i64).unwrap_or(0),
        "totalTokens": usage.get("total_tokens").and_then(Value::as_i64).unwrap_or(0),
    })
}

fn llm_anthropic_usage(json: &Value) -> Value {
    let Some(usage) = json.get("usage") else {
        return Value::Null;
    };
    let prompt = usage
        .get("input_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let completion = usage
        .get("output_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    json!({
        "promptTokens": prompt,
        "completionTokens": completion,
        "totalTokens": prompt + completion,
    })
}

fn llm_resolve_openai_base_url(config: &LlmRuntimeConfig) -> AppResult<String> {
    if let Some(base_url) = &config.base_url {
        return Ok(base_url.clone());
    }
    match config.provider.as_str() {
        "openai" => Ok("https://api.openai.com/v1".to_string()),
        "openrouter" => Ok("https://openrouter.ai/api/v1".to_string()),
        "deepseek" => Ok("https://api.deepseek.com/v1".to_string()),
        "ollama" => Ok("http://localhost:11434/v1".to_string()),
        "custom" => Err(AppError::new(
            "INVALID_INPUT",
            "baseUrl is required for provider \"custom\"",
        )),
        provider => Err(AppError::new(
            "INVALID_INPUT",
            format!("unknown provider \"{provider}\""),
        )),
    }
}

fn is_valid_llm_provider(provider: &str) -> bool {
    matches!(
        provider,
        "openai" | "anthropic" | "deepseek" | "openrouter" | "ollama" | "custom"
    )
}

fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let mut truncated = s.chars().take(max_chars).collect::<String>();
    truncated.push_str("...");
    truncated
}

#[tauri::command]
pub fn llm_get_features(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let _ = payload;
    let db = conn(&state)?;
    Ok(json!({
        "search": get_setting(&db, "llm.feature.search")?.as_deref() == Some("1"),
        "autoCategorize": get_setting(&db, "llm.feature.autoCategorize")?.as_deref() == Some("1"),
        "recommend": get_setting(&db, "llm.feature.recommend")?.as_deref() == Some("1"),
        "createSkill": get_setting(&db, "llm.feature.createSkill")?.as_deref() == Some("1")
    }))
}

#[tauri::command]
pub fn llm_set_features(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let p = payload.unwrap_or_else(|| json!({}));
    let db = conn(&state)?;
    for (json_key, setting_key) in [
        ("search", "llm.feature.search"),
        ("autoCategorize", "llm.feature.autoCategorize"),
        ("recommend", "llm.feature.recommend"),
        ("createSkill", "llm.feature.createSkill"),
    ] {
        if let Some(v) = p.get(json_key).and_then(Value::as_bool) {
            db.execute("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![setting_key, if v { "1" } else { "0" }])?;
        }
    }
    maybe_start_ai_worker(&state);
    llm_get_features(None, state)
}

#[tauri::command]
pub fn ai_create_skill_start(
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> AppResult<Value> {
    let prompt = required_str(&payload, "prompt")?.trim().to_string();
    if prompt.chars().count() < 4 {
        return Err(AppError::new(
            "INVALID_INPUT",
            "Describe the need, problem, or workflow first.",
        ));
    }
    let language = payload
        .as_ref()
        .and_then(|p| p.get("language"))
        .and_then(Value::as_str)
        .filter(|v| matches!(*v, "zh" | "en"))
        .unwrap_or("zh");
    ai_create_skill_start_inner(&state.db, &state.paths, prompt, language.to_string())
}

#[tauri::command]
pub fn ai_create_skill_start_job(
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> AppResult<Value> {
    let prompt = required_str(&payload, "prompt")?.trim().to_string();
    if prompt.chars().count() < 4 {
        return Err(AppError::new(
            "INVALID_INPUT",
            "Describe the need, problem, or workflow first.",
        ));
    }
    let language = payload
        .as_ref()
        .and_then(|p| p.get("language"))
        .and_then(Value::as_str)
        .filter(|v| matches!(*v, "zh" | "en"))
        .unwrap_or("zh")
        .to_string();
    let key = format!("{}:{}", language, slugify_skill_name(&prompt));
    let pool = state.db.clone();
    let paths = state.paths.clone();
    ai_spawn_job(&state, "create_skill_start", &key, move || {
        ai_create_skill_start_inner(&pool, &paths, prompt, language)
    })
}

fn ai_create_skill_start_inner(
    pool: &r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
    paths: &AppPaths,
    prompt: String,
    language: String,
) -> AppResult<Value> {
    let db = pool.get()?;
    let draft_id = Uuid::new_v4().to_string();
    let now = now_ms();
    // 澄清循环第一轮：LLM 自评能否精准定义输入/输出契约。
    let turn = create_skill_start_spec(&db, paths, &prompt, &language)?;
    let ready = turn.status == "ready";
    // 第一轮即结晶 → spec_ready（前端 outline 步）；否则进入 clarifying（前端 clarify 步）。
    // 即便 ready，本次也是「第 1 轮」对话，clarify_round 记 1。
    let status = if ready { "spec_ready" } else { "clarifying" };
    let basename = turn
        .spec
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|name| is_safe_basename(name));
    db.execute(
        "INSERT INTO skill_creation_drafts
         (id, status, raw_prompt, intent_frame_json, skill_spec_json, followup_questions_json,
          answers_json, target_basename, clarify_round, understanding, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, '{}', ?7, 1, ?8, ?9, ?9)",
        params![
            draft_id,
            status,
            prompt,
            json_string(turn.spec.get("intentFrame").unwrap_or(&Value::Null))?,
            json_string(&turn.spec)?,
            json_string(&turn.questions)?,
            basename,
            (!turn.understanding.is_empty()).then_some(turn.understanding.as_str()),
            now
        ],
    )?;
    Ok(create_skill_clarify_envelope(
        &db,
        &draft_id,
        &turn,
        turn.ai_used,
    )?)
}

/// 把一轮澄清结果包成发给 renderer 的状态机 envelope：
/// `{ status, understanding, questions?, skillSpec?, draft, round, aiUsed }`。
/// ready 时附完整 skillSpec、questions 省略；needs_clarification 时附 understanding + questions。
fn create_skill_clarify_envelope(
    db: &Connection,
    draft_id: &str,
    turn: &CreateSkillClarifyTurn,
    ai_used: bool,
) -> AppResult<Value> {
    let draft = create_skill_get_draft_row(db, draft_id)?;
    let round = draft
        .get("clarifyRound")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let ready = turn.status == "ready";
    let mut envelope = json!({
        "status": turn.status,
        "understanding": turn.understanding,
        "draft": draft,
        "round": round,
        "maxRounds": CREATE_SKILL_MAX_CLARIFY_ROUNDS,
        "aiUsed": ai_used
    });
    if ready {
        envelope["skillSpec"] = turn.spec.clone();
    } else {
        envelope["questions"] = turn.questions.clone();
    }
    Ok(envelope)
}

#[tauri::command]
pub fn ai_create_skill_get(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let draft_id = required_str(&payload, "draftId")?;
    let db = conn(&state)?;
    create_skill_get_draft_row(&db, draft_id)
}

#[tauri::command]
pub fn ai_create_skill_refine(
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> AppResult<Value> {
    let p = payload.unwrap_or_else(|| json!({}));
    let draft_id = p
        .get("draftId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new("INVALID_INPUT", "draftId required"))?;
    let mut spec = p
        .get("skillSpec")
        .cloned()
        .ok_or_else(|| AppError::new("INVALID_INPUT", "skillSpec required"))?;
    create_skill_normalize_spec(&mut spec);
    // 决策3：结晶轮廓编辑后直接生效，不自动重入澄清循环。即便用户改空某字段使 ready=false，
    // 也停留在 spec_ready（结晶确认面），不退回 clarifying。
    let status = "spec_ready";
    let basename = p
        .get("targetBasename")
        .and_then(Value::as_str)
        .or_else(|| spec.get("name").and_then(Value::as_str))
        .map(str::to_string);
    let db = conn(&state)?;
    db.execute(
        "UPDATE skill_creation_drafts
         SET status = ?1,
             intent_frame_json = ?2,
             skill_spec_json = ?3,
             target_basename = ?4,
             updated_at = ?5
         WHERE id = ?6 AND discarded_at IS NULL AND installed_at IS NULL",
        params![
            status,
            json_string(spec.get("intentFrame").unwrap_or(&Value::Null))?,
            json_string(&spec)?,
            basename,
            now_ms(),
            draft_id
        ],
    )?;
    create_skill_get_draft_row(&db, draft_id)
}

#[tauri::command]
pub async fn ai_create_skill_answer(
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> AppResult<Value> {
    let p = payload.unwrap_or_else(|| json!({}));
    let draft_id = p
        .get("draftId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new("INVALID_INPUT", "draftId required"))?;
    let question_id = p
        .get("questionId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new("INVALID_INPUT", "questionId required"))?;
    let answer = p
        .get("answer")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new("INVALID_INPUT", "answer required"))?;
    let db = conn(&state)?;
    let draft = create_skill_get_draft_row(&db, draft_id)?;
    let mut answers = draft.get("answers").cloned().unwrap_or_else(|| json!({}));
    if let Some(obj) = answers.as_object_mut() {
        obj.insert(question_id.to_string(), Value::String(answer.to_string()));
    }
    let mut spec = draft.get("skillSpec").cloned().unwrap_or_else(|| {
        create_skill_local_spec(
            draft.get("rawPrompt").and_then(Value::as_str).unwrap_or(""),
            "zh",
            &answers,
        )
    });
    create_skill_normalize_spec(&mut spec);
    let language = spec
        .get("language")
        .and_then(Value::as_str)
        .filter(|v| matches!(*v, "zh" | "en"))
        .unwrap_or("zh")
        .to_string();
    // 性能：每答一题都回灌 LLM 会让 UI 逐题卡顿。改为——**中间答题即时本地应用**（零
    // LLM、不卡），**只在最后一题答完 / 用户点「够了」/ 到轮数上界时，才调一次 LLM**
    // 把「原始需求 + 全部回答」结晶成精准轮廓（前端配加载态）。问题集沿用 start 的
    // （LLM 已一次性给出该问的关键项），逐题秒答。
    let raw_prompt = draft
        .get("rawPrompt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let round = draft.get("clarifyRound").and_then(Value::as_i64).unwrap_or(1);
    let force = p
        .get("forceCrystallize")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let existing_questions = draft
        .get("followupQuestions")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let remaining_unanswered = existing_questions
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter(|q| {
                    q.get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| answers.get(id).is_none())
                })
                .count()
        })
        .unwrap_or(0);
    let crystallize = force || remaining_unanswered == 0 || (round + 1) >= CREATE_SKILL_MAX_CLARIFY_ROUNDS;
    let mut understanding = draft
        .get("understanding")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let (ai_used, questions) = if crystallize {
        // 唯一一次 LLM 调用：把全部回答结晶成精准 spec。失败则确定性兜底。
        match create_skill_clarify_spec(
            &db,
            &state.paths,
            &raw_prompt,
            &spec,
            &answers,
            &language,
            true,
        ) {
            Ok(turn) => {
                let mut updated = turn.spec;
                create_skill_normalize_spec(&mut updated);
                create_skill_remove_missing(&mut updated, question_id);
                spec = updated;
                understanding = turn.understanding;
                (turn.ai_used, json!([]))
            }
            Err(_) => {
                create_skill_apply_answer(&mut spec, question_id, answer);
                create_skill_normalize_spec(&mut spec);
                (false, json!([]))
            }
        }
    } else {
        // 中间答题：确定性本地应用，瞬时、不卡；保留 start 的剩余问题继续逐题。
        create_skill_apply_answer(&mut spec, question_id, answer);
        create_skill_normalize_spec(&mut spec);
        (false, existing_questions)
    };
    let ready = crystallize;
    let next_question = questions
        .as_array()
        .and_then(|items| {
            items.iter().find(|q| {
                q.get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| answers.get(id).is_none())
            })
        })
        .cloned();
    let status = if ready { "spec_ready" } else { "clarifying" };
    let new_round = round + 1;
    db.execute(
        "UPDATE skill_creation_drafts
         SET status = ?1,
             skill_spec_json = ?2,
             intent_frame_json = ?3,
             followup_questions_json = ?4,
             answers_json = ?5,
             clarify_round = ?6,
             understanding = ?7,
             updated_at = ?8
         WHERE id = ?9 AND discarded_at IS NULL AND installed_at IS NULL",
        params![
            status,
            json_string(&spec)?,
            json_string(spec.get("intentFrame").unwrap_or(&Value::Null))?,
            json_string(&questions)?,
            json_string(&answers)?,
            new_round,
            (!understanding.is_empty()).then_some(understanding.as_str()),
            now_ms(),
            draft_id
        ],
    )?;
    Ok(json!({
        "draft": create_skill_get_draft_row(&db, draft_id)?,
        "status": if ready { "ready" } else { "needs_clarification" },
        "understanding": understanding,
        "nextQuestion": next_question.unwrap_or(Value::Null),
        "aiUsed": ai_used
    }))
}

#[tauri::command]
pub async fn ai_create_skill_generate(
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> AppResult<Value> {
    let p = payload.unwrap_or_else(|| json!({}));
    let draft_id = p
        .get("draftId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new("INVALID_INPUT", "draftId required"))?;
    let db = conn(&state)?;
    let draft = create_skill_get_draft_row(&db, draft_id)?;
    let mut spec = p
        .get("skillSpec")
        .cloned()
        .or_else(|| draft.get("skillSpec").cloned())
        .ok_or_else(|| AppError::new("INVALID_STATE", "skillSpec required before generate"))?;
    create_skill_normalize_spec(&mut spec);
    let (markdown, ai_used) = create_skill_generate_markdown(&db, &state.paths, &spec)?;
    let generated_name = scanner::parser::parse_skill_markdown(&markdown)
        .ok()
        .map(|parsed| parsed.name);
    if spec.get("name").and_then(Value::as_str).is_none() {
        if let Some(name) = &generated_name {
            spec["name"] = json!(slugify_skill_name(name));
        }
    }
    create_skill_normalize_spec(&mut spec);
    let target_basename = spec
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| is_safe_basename(name))
        .map(str::to_string)
        .or_else(|| {
            generated_name
                .as_deref()
                .map(slugify_skill_name)
                .filter(|name| is_safe_basename(name))
        });
    let review = create_skill_review_markdown(&markdown, target_basename.as_deref());
    let status = if create_skill_review_is_installable(&review) {
        "artifact_draft"
    } else {
        "review_failed"
    };
    db.execute(
        "UPDATE skill_creation_drafts
         SET status = ?1,
             skill_spec_json = ?2,
             intent_frame_json = ?3,
             draft_markdown = ?4,
             validation_json = ?5,
             target_basename = COALESCE(target_basename, ?6),
             updated_at = ?7
         WHERE id = ?8 AND discarded_at IS NULL AND installed_at IS NULL",
        params![
            status,
            json_string(&spec)?,
            json_string(spec.get("intentFrame").unwrap_or(&Value::Null))?,
            markdown,
            json_string(&review)?,
            target_basename,
            now_ms(),
            draft_id
        ],
    )?;
    Ok(json!({
        "draft": create_skill_get_draft_row(&db, draft_id)?,
        "aiUsed": ai_used
    }))
}

#[tauri::command]
pub fn ai_create_skill_review(
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> AppResult<Value> {
    let p = payload.unwrap_or_else(|| json!({}));
    let draft_id = p
        .get("draftId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new("INVALID_INPUT", "draftId required"))?;
    let markdown = p.get("markdown").and_then(Value::as_str);
    let target_basename = p.get("targetBasename").and_then(Value::as_str);
    let db = conn(&state)?;
    let draft = create_skill_get_draft_row(&db, draft_id)?;
    let markdown = markdown
        .or_else(|| draft.get("draftMarkdown").and_then(Value::as_str))
        .ok_or_else(|| AppError::new("INVALID_STATE", "draftMarkdown required"))?;
    let expected_name = target_basename.or_else(|| {
        draft
            .get("skillSpec")
            .and_then(|s| s.get("name"))
            .and_then(Value::as_str)
    });
    let review = create_skill_review_markdown(markdown, expected_name);
    let status = if create_skill_review_is_installable(&review) {
        "reviewed"
    } else {
        "review_failed"
    };
    db.execute(
        "UPDATE skill_creation_drafts
         SET status = ?1,
             draft_markdown = ?2,
             target_basename = COALESCE(?3, target_basename),
             validation_json = ?4,
             updated_at = ?5
         WHERE id = ?6 AND discarded_at IS NULL AND installed_at IS NULL",
        params![
            status,
            markdown,
            target_basename,
            json_string(&review)?,
            now_ms(),
            draft_id
        ],
    )?;
    Ok(json!({
        "draft": create_skill_get_draft_row(&db, draft_id)?,
        "review": review
    }))
}

#[tauri::command]
pub fn ai_create_skill_plan(
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> AppResult<Value> {
    let p = payload.unwrap_or_else(|| json!({}));
    let draft_id = p
        .get("draftId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new("INVALID_INPUT", "draftId required"))?;
    let target_basename = p
        .get("targetBasename")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new("INVALID_INPUT", "targetBasename required"))?
        .trim();
    if !is_safe_basename(target_basename) {
        return Err(AppError::new("INVALID_INPUT", "targetBasename is not safe"));
    }
    let target_platform_ids = p
        .get("targetPlatformIds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let target_scenario_ids = p
        .get("targetScenarioIds")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_i64).collect::<Vec<_>>())
        .unwrap_or_default();
    let db = conn(&state)?;
    let draft = create_skill_get_draft_row(&db, draft_id)?;
    let markdown = p
        .get("markdown")
        .and_then(Value::as_str)
        .or_else(|| draft.get("draftMarkdown").and_then(Value::as_str))
        .ok_or_else(|| AppError::new("INVALID_STATE", "draftMarkdown required"))?;
    let review = create_skill_review_markdown(markdown, Some(target_basename));
    if !create_skill_review_is_installable(&review) {
        db.execute(
            "UPDATE skill_creation_drafts
             SET status = 'review_failed', validation_json = ?1, updated_at = ?2
             WHERE id = ?3",
            params![json_string(&review)?, now_ms(), draft_id],
        )?;
        return Err(AppError::detail(
            "CREATE_SKILL_REVIEW_BLOCKED",
            "Fix review issues before planning install.",
            review,
        ));
    }
    let parsed = scanner::parser::parse_skill_markdown(markdown)?;
    let source_hash = parsed.content_hash;
    let stage_wrap = state
        .paths
        .staging_root
        .join(format!("create-skill-{}", Uuid::new_v4()));
    let staging_dir = stage_wrap.join(target_basename);
    fs::create_dir_all(&staging_dir)?;
    fs::write(staging_dir.join("SKILL.md"), markdown)?;
    let plan = create_skill_plan_from_staging(
        &state,
        &db,
        &staging_dir,
        parsed.name.as_str(),
        &source_hash,
        draft_id,
        &target_platform_ids,
    )?;
    let plan_token = plan
        .get("token")
        .and_then(Value::as_str)
        .map(str::to_string);
    db.execute(
        "UPDATE skill_creation_drafts
         SET status = 'planned',
             draft_markdown = ?1,
             target_platform_ids_json = ?2,
             target_scenario_ids_json = ?3,
             target_basename = ?4,
             staged_dir = ?5,
             draft_hash = ?6,
             validation_json = ?7,
             plan_token = ?8,
             updated_at = ?9
         WHERE id = ?10 AND discarded_at IS NULL AND installed_at IS NULL",
        params![
            markdown,
            json_string(&Value::Array(
                target_platform_ids.iter().map(|id| json!(id)).collect()
            ))?,
            json_string(&Value::Array(
                target_scenario_ids.iter().map(|id| json!(id)).collect()
            ))?,
            target_basename,
            staging_dir.to_string_lossy().to_string(),
            source_hash,
            json_string(&review)?,
            plan_token,
            now_ms(),
            draft_id
        ],
    )?;
    Ok(json!({
        "draft": create_skill_get_draft_row(&db, draft_id)?,
        "plan": plan
    }))
}

#[tauri::command]
pub fn ai_create_skill_execute(
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> AppResult<Value> {
    let p = payload.unwrap_or_else(|| json!({}));
    let draft_id = p
        .get("draftId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new("INVALID_INPUT", "draftId required"))?;
    let token = p
        .get("token")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new("INVALID_INPUT", "token required"))?;
    let requested_scenarios = p
        .get("targetScenarioIds")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_i64).collect::<Vec<_>>());
    let _lock = state
        .sync_lock
        .lock()
        .map_err(|_| AppError::new("SYNC_LOCK_POISONED", "sync lock poisoned"))?;
    let stored = state
        .plan_store
        .lock()
        .map_err(|_| AppError::new("PLAN_STORE_POISONED", "plan store poisoned"))?
        .remove(token)
        .ok_or_else(|| AppError::new("PLAN_EXPIRED", "sync plan token is missing or expired"))?;
    if stored.expires_at <= SystemTime::now() {
        return Err(AppError::new(
            "PLAN_EXPIRED",
            "sync plan token is missing or expired",
        ));
    }
    let db = conn(&state)?;
    let plan = stored.plan;
    if plan.get("operation").and_then(Value::as_str) != Some("create_skill") {
        return Err(AppError::new(
            "INVALID_PLAN",
            "plan token does not belong to Create Skill",
        ));
    }
    let plan_draft_id = plan
        .get("draftId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if plan_draft_id != draft_id {
        return Err(AppError::new(
            "INVALID_PLAN",
            "plan token belongs to a different draft",
        ));
    }
    let plan_json = serde_json::to_string(&plan)
        .map_err(|err| AppError::new("SERIALIZE_FAILED", err.to_string()))?;
    let items = plan
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let result = execute_sync_items(&db, &state.paths.backup_root, items, &plan_json)?;
    let scan = scanner::scan_all(&db)?;
    if let Ok(mut last) = state.last_scan.lock() {
        *last = Some(scan.clone());
    }
    let skill_id = create_skill_find_installed_skill(&db, &plan)?;
    let mut warnings = Vec::new();
    if let Some(skill_id) = &skill_id {
        let scenarios = requested_scenarios.unwrap_or_else(|| {
            create_skill_get_draft_row(&db, draft_id)
                .ok()
                .and_then(|d| d.get("targetScenarioIds").cloned())
                .and_then(|v| v.as_array().cloned())
                .map(|items| items.iter().filter_map(Value::as_i64).collect())
                .unwrap_or_default()
        });
        for scenario_id in scenarios {
            let inserted = db.execute(
                "INSERT OR IGNORE INTO skill_scenarios (skill_id, scenario_id, added_at)
                 SELECT ?1, id, ?2 FROM scenarios WHERE id = ?3",
                params![skill_id, now_ms(), scenario_id],
            )?;
            if inserted == 0 {
                warnings.push(json!({
                    "code": "SCENARIO_NOT_FOUND",
                    "message": format!("Scenario {scenario_id} no longer exists.")
                }));
            }
        }
    }
    let now = now_ms();
    db.execute(
        "UPDATE skill_creation_drafts
         SET status = ?1,
             installed_skill_id = ?2,
             installed_at = CASE WHEN ?2 IS NULL THEN installed_at ELSE ?3 END,
             updated_at = ?3
         WHERE id = ?4",
        params![
            if skill_id.is_some() {
                "installed"
            } else {
                "planned"
            },
            skill_id,
            now,
            draft_id
        ],
    )?;
    Ok(json!({
        "draft": create_skill_get_draft_row(&db, draft_id)?,
        "sync": result,
        "scan": scan,
        "skillId": skill_id,
        "warnings": warnings
    }))
}

#[tauri::command]
pub fn ai_create_skill_discard(
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> AppResult<Value> {
    let draft_id = required_str(&payload, "draftId")?;
    let db = conn(&state)?;
    if let Some(staged_dir) = db
        .query_row(
            "SELECT staged_dir FROM skill_creation_drafts WHERE id = ?1",
            params![draft_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten()
    {
        let _ = fs::remove_dir_all(
            Path::new(&staged_dir)
                .parent()
                .unwrap_or(Path::new(&staged_dir)),
        );
    }
    db.execute(
        "UPDATE skill_creation_drafts
         SET status = 'discarded', discarded_at = ?1, updated_at = ?1
         WHERE id = ?2 AND installed_at IS NULL",
        params![now_ms(), draft_id],
    )?;
    Ok(ok())
}

fn create_skill_get_draft_row(db: &Connection, draft_id: &str) -> AppResult<Value> {
    db.query_row(
        "SELECT id, status, raw_prompt, intent_frame_json, skill_spec_json,
                followup_questions_json, answers_json, draft_markdown,
                target_platform_ids_json, target_scenario_ids_json, target_basename,
                validation_json, plan_token, installed_skill_id, created_at, updated_at,
                installed_at, discarded_at, clarify_round, understanding
         FROM skill_creation_drafts WHERE id = ?1",
        params![draft_id],
        |r| {
            let intent: Option<String> = r.get(3)?;
            let spec: Option<String> = r.get(4)?;
            let questions: String = r.get(5)?;
            let answers: String = r.get(6)?;
            let platforms: String = r.get(8)?;
            let scenarios: String = r.get(9)?;
            let validation: Option<String> = r.get(11)?;
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "status": r.get::<_, String>(1)?,
                "rawPrompt": r.get::<_, String>(2)?,
                "intentFrame": parse_json_opt(intent),
                "skillSpec": parse_json_opt(spec),
                "followupQuestions": parse_json_text(&questions, json!([])),
                "answers": parse_json_text(&answers, json!({})),
                "draftMarkdown": r.get::<_, Option<String>>(7)?,
                "targetPlatformIds": parse_json_text(&platforms, json!([])),
                "targetScenarioIds": parse_json_text(&scenarios, json!([])),
                "targetBasename": r.get::<_, Option<String>>(10)?,
                "validation": parse_json_opt(validation),
                "planToken": r.get::<_, Option<String>>(12)?,
                "installedSkillId": r.get::<_, Option<String>>(13)?,
                "createdAt": r.get::<_, i64>(14)?,
                "updatedAt": r.get::<_, i64>(15)?,
                "installedAt": r.get::<_, Option<i64>>(16)?,
                "discardedAt": r.get::<_, Option<i64>>(17)?,
                // 自适应澄清循环：累积轮次 + 当前 AI 理解复述。
                "clarifyRound": r.get::<_, i64>(18)?,
                "understanding": r.get::<_, Option<String>>(19)?,
            }))
        },
    )
    .map_err(Into::into)
}

/// 澄清循环单次调用的归一化结果（无论 start 还是 clarify）。
/// ready 分支：spec 已通过 repair + 质量门，可结晶呈现；questions 为空。
/// needs_clarification 分支：understanding 为一行复述，questions 为本轮 1~3 个选项题；spec 仅为草稿。
struct CreateSkillClarifyTurn {
    status: String,
    understanding: String,
    spec: Value,
    questions: Value,
    ai_used: bool,
}

/// 自适应澄清循环的第一轮：LLM 自评能否精准定义输入/输出契约。
/// 简单需求 → ready + 完整 spec；复杂需求 → needs_clarification + understanding + 1~3 问。
fn create_skill_start_spec(
    db: &Connection,
    paths: &AppPaths,
    prompt: &str,
    language: &str,
) -> AppResult<CreateSkillClarifyTurn> {
    create_skill_run_clarify_llm(
        db,
        paths,
        prompt,
        language,
        "MYSKILLS_CREATE_SKILL_START_RESPONSE",
        |attempt, previous_text, previous_issues| {
            if attempt == 1 {
                create_skill_start_prompt(prompt, language)
            } else {
                create_skill_start_repair_prompt(prompt, language, previous_text, previous_issues)
            }
        },
    )
}

/// start / clarify 共用的 LLM 调用循环：发起请求 → coerce → status envelope → 按 status 分支。
/// needs_clarification 时直接返回（不跑结晶质量门，spec 只是草稿）；ready 时跑
/// repair_start_spec + 质量门，未过则用 repair prompt 重试一次（沿用现有 2 次重试 + repair）。
/// `build_prompt(attempt, previous_text, previous_issues)` 决定每次尝试的 user content。
fn create_skill_run_clarify_llm(
    db: &Connection,
    paths: &AppPaths,
    prompt: &str,
    language: &str,
    test_env_key: &str,
    build_prompt: impl Fn(u8, &str, &[Value]) -> String,
) -> AppResult<CreateSkillClarifyTurn> {
    if !create_skill_llm_enabled(db, paths)? {
        return Err(AppError::new(
            "LLM_NOT_READY",
            "Create Skill requires a saved AI configuration and a successful connection test.",
        ));
    }
    require_network(db)?;
    let config = llm_read_config(db)?;
    if config.model.trim().is_empty() {
        return Err(AppError::new("LLM_NO_MODEL", "No model configured."));
    }
    let api_key = llm_read_api_key(db, paths)?;
    if config.provider != "ollama" && api_key.as_deref().unwrap_or("").trim().is_empty() {
        return Err(AppError::new("LLM_NO_KEY", "No API key configured."));
    }
    let mut previous_text = String::new();
    let mut previous_issues = Vec::new();
    let mut last_error = None;
    for attempt in 1..=2 {
        let user_content = build_prompt(attempt, &previous_text, &previous_issues);
        let req = json!({
            "messages": [
                { "role": "system", "content": create_skill_system_prompt(language) },
                { "role": "user", "content": user_content }
            ],
            "temperature": if attempt == 1 { 0.2 } else { 0.0 },
            "maxTokens": if attempt == 1 { 4096 } else { 8192 },
            "jsonMode": true
        });
        let text = create_skill_llm_text(test_env_key, &config, api_key.as_deref(), &req)?;
        previous_text = text.clone();
        let parsed = ai_parse_json_object(&text);
        let parsed = create_skill_coerce_start_payload(parsed, prompt, language);
        match create_skill_status_envelope(parsed, "start") {
            Ok(envelope) => {
                // needs_clarification：LLM 仍在问。直接返回本轮问题 + 理解复述，不跑结晶质量门。
                if envelope.status != "ready" {
                    let mut questions = envelope.questions;
                    if !create_skill_questions_have_options(&questions) {
                        questions = create_skill_default_questions(&envelope.spec);
                    }
                    return Ok(CreateSkillClarifyTurn {
                        status: "needs_clarification".to_string(),
                        understanding: envelope.understanding,
                        spec: envelope.spec,
                        questions,
                        ai_used: true,
                    });
                }
                // ready：跑结晶质量门。过 → 结晶返回；未过 → repair 重试。
                let mut spec = envelope.spec;
                create_skill_repair_start_spec(&mut spec, prompt, language);
                previous_issues = create_skill_start_quality_issues(
                    &spec,
                    &create_skill_default_questions(&spec),
                );
                if previous_issues.is_empty() {
                    return Ok(CreateSkillClarifyTurn {
                        status: "ready".to_string(),
                        understanding: envelope.understanding,
                        spec,
                        questions: json!([]),
                        ai_used: true,
                    });
                }
                last_error = Some(create_skill_start_quality_error(
                    &spec,
                    previous_issues.clone(),
                ));
            }
            Err(err) => {
                previous_issues =
                    vec![json!({ "field": "schema", "message": err.message.clone() })];
                last_error = Some(err);
            }
        }
    }
    Err(last_error.unwrap_or_else(|| {
        AppError::new(
            "LLM_BAD_SPEC",
            "The model returned an incomplete skill outline. Regenerate or revise the request.",
        )
    }))
}

/// 澄清循环回灌（演进自旧 create_skill_answer_spec）：把「原始需求 + 当前 spec 草稿 + 累积
/// Q&A（含本轮答案）」交回 LLM，让它重做同一个自评 → 返回状态机 envelope（再问 or 结晶）。
/// `force_crystallize`（轮数到顶或用户「够了直接生成」）时切「必须结晶」prompt 强制 ready。
/// 复用 start 路径的 system prompt / JSON 契约 / coerce / status envelope / 质量门 / repair 重试。
/// 失败/未配置返回 Err，由调用方回退到确定性关键词映射（create_skill_apply_answer）。
fn create_skill_clarify_spec(
    db: &Connection,
    paths: &AppPaths,
    raw_prompt: &str,
    current_spec: &Value,
    answers: &Value,
    language: &str,
    force_crystallize: bool,
) -> AppResult<CreateSkillClarifyTurn> {
    // whenToUse 仍是这条技能最贴近的原始意图，作为 repair / coerce 时的占位回退。
    let fallback_prompt = current_spec
        .get("intentFrame")
        .and_then(|i| i.get("whenToUse"))
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .or_else(|| current_spec.get("description").and_then(Value::as_str))
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| raw_prompt.to_string());
    create_skill_run_clarify_llm(
        db,
        paths,
        &fallback_prompt,
        language,
        "MYSKILLS_CREATE_SKILL_ANSWER_RESPONSE",
        |attempt, previous_text, previous_issues| {
            if attempt == 1 {
                create_skill_clarify_prompt(
                    raw_prompt,
                    current_spec,
                    answers,
                    language,
                    force_crystallize,
                )
            } else {
                create_skill_start_repair_prompt(
                    &fallback_prompt,
                    language,
                    previous_text,
                    previous_issues,
                )
            }
        },
    )
}

/// 澄清循环回灌 prompt：把「原始需求 + 当前 spec 草稿 + 累积 Q&A + 本轮答案」交回 LLM，
/// 让它重做同一个自评（再问 or 结晶）。`force_crystallize=true`（轮数到顶或用户「够了直接生成」）
/// 时切换为「必须结晶」措辞，强制 status=ready + 完整 spec、不再追问。
fn create_skill_clarify_prompt(
    raw_prompt: &str,
    current_spec: &Value,
    answers: &Value,
    language: &str,
    force_crystallize: bool,
) -> String {
    let language_rule = if language == "zh" {
        "All human-facing strings (understanding, questions, and every skillSpec value) must be Chinese. Keep only identifiers such as name in English kebab-case."
    } else {
        "All human-facing strings must be English."
    };
    let spec_json = json_string(current_spec).unwrap_or_else(|_| "{}".to_string());
    let answers_json = json_string(answers).unwrap_or_else(|_| "{}".to_string());
    let directive = if force_crystallize {
        "This is the FINAL turn. You MUST now crystallize: set status=\"ready\" and return a COMPLETE skillSpec, filling any remaining gaps with the most reasonable concrete defaults inferred from the need and the answers. Do NOT ask any more questions — return \"questions\": []."
    } else {
        create_skill_clarify_core_rules()
    };
    format!(
        "You are continuing an adaptive clarification loop for a MySkills skill.\n\
         The user has answered the previous round's questions. Re-run your self-assessment and either \
         ask the next 1-3 questions or crystallize the precise outline.\n\
         Return JSON only. Do not include markdown fences or explanatory text.\n\
         Set schemaVersion exactly to \"create-skill.v1\" and command exactly to \"start\".\n\
         {language_rule}\n\n\
         {directive}\n\n\
         Always preserve concrete details from the current draft that the new answers do not contradict.\n\n\
         Original user need:\n{raw_prompt}\n\n\
         Current skillSpec draft:\n{spec_json}\n\n\
         All answers so far (questionId -> answer), including this round:\n{answers_json}\n\n\
         JSON shape (status drives which fields matter):\n\
{}",
        create_skill_start_json_contract(language)
    )
}

fn create_skill_generate_markdown(
    db: &Connection,
    paths: &AppPaths,
    spec: &Value,
) -> AppResult<(String, bool)> {
    if !create_skill_llm_enabled(db, paths)? {
        return Err(AppError::new(
            "LLM_NOT_READY",
            "Create Skill requires a saved AI configuration and a successful connection test.",
        ));
    }
    require_network(db)?;
    let config = llm_read_config(db)?;
    if config.model.trim().is_empty() {
        return Err(AppError::new("LLM_NO_MODEL", "No model configured."));
    }
    let api_key = llm_read_api_key(db, paths)?;
    if config.provider != "ollama" && api_key.as_deref().unwrap_or("").trim().is_empty() {
        return Err(AppError::new("LLM_NO_KEY", "No API key configured."));
    }
    let req = json!({
        "messages": [
            { "role": "system", "content": create_skill_system_prompt(spec.get("language").and_then(Value::as_str).unwrap_or("zh")) },
            { "role": "user", "content": format!("Generate the final SKILL.md for this spec. Return JSON envelope only. Set command exactly to \"generate\".\n\n{}", json_string(spec)?) }
        ],
        "temperature": 0.2,
        "maxTokens": 8192,
        "jsonMode": true
    });
    let text = create_skill_llm_text(
        "MYSKILLS_CREATE_SKILL_GENERATE_RESPONSE",
        &config,
        api_key.as_deref(),
        &req,
    )?;
    let parsed = ai_parse_json_object(&text);
    if parsed.get("schemaVersion").and_then(Value::as_str) != Some("create-skill.v1") {
        return Err(AppError::new(
            "LLM_SCHEMA_MISMATCH",
            "Create Skill schema mismatch.",
        ));
    }
    if parsed.get("command").and_then(Value::as_str) != Some("generate") {
        let actual = parsed
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("<missing>");
        return Err(AppError::new(
            "LLM_COMMAND_MISMATCH",
            format!("Create Skill command mismatch: expected generate, got {actual}."),
        ));
    }
    let markdown = parsed
        .get("draftMarkdown")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| AppError::new("LLM_BAD_RESPONSE", "draftMarkdown missing"))?;
    let repaired = create_skill_repair_frontmatter(markdown, spec);
    let safety = spec.get("intentFrame").and_then(|i| i.get("safety"));
    let gated = ensure_safety_gates(&repaired, safety, spec);
    Ok((gated, true))
}

fn create_skill_llm_enabled(db: &Connection, paths: &AppPaths) -> AppResult<bool> {
    let config = llm_read_config(db)?;
    if config.model.trim().is_empty() {
        return Ok(false);
    }
    if config.provider == "ollama" {
        return Ok(get_setting(db, LLM_CONNECTION_OK_SETTING)?.as_deref() == Some("1"));
    }
    Ok(llm_has_api_key(db, paths)?
        && get_setting(db, LLM_CONNECTION_OK_SETTING)?.as_deref() == Some("1"))
}

fn create_skill_llm_text(
    test_env_key: &str,
    config: &LlmRuntimeConfig,
    api_key: Option<&str>,
    req: &Value,
) -> AppResult<String> {
    #[cfg(not(test))]
    let _ = test_env_key;
    // 测试环境下绝不发起真实网络调用：命中 mock env 返回桩文本，未命中则报错
    // （对追问回灌路径而言等同于 LLM 失败，触发确定性 fallback），保持单测 hermetic。
    #[cfg(test)]
    {
        let _ = (config, api_key, req);
        return match std::env::var(test_env_key) {
            Ok(value) if !value.trim().is_empty() => Ok(value),
            _ => Err(AppError::new(
                "LLM_BAD_RESPONSE",
                "The model returned an empty response.",
            )),
        };
    }
    #[cfg(not(test))]
    {
        let response = llm_chat_with_config(config, api_key, req)?;
        let text = response.get("text").and_then(Value::as_str).unwrap_or("");
        if text.trim().is_empty() {
            return Err(AppError::new(
                "LLM_BAD_RESPONSE",
                "The model returned an empty response.",
            ));
        }
        Ok(text.to_string())
    }
}

fn create_skill_start_quality_error(spec: &Value, issues: Vec<Value>) -> AppError {
    let language = spec.get("language").and_then(Value::as_str).unwrap_or("en");
    let message = if language == "zh" {
        "模型返回的技能轮廓仍不完整。请补充需求后重新生成。"
    } else {
        "The model returned an incomplete skill outline. Regenerate or revise the request."
    };
    AppError::detail("LLM_BAD_SPEC", message, json!({ "issues": issues }))
}

/// 自适应澄清循环共用的自评核心判据 + 两分支契约说明（中英按 language 取一份）。
/// 北极星：先自问「我能否现在就精准写出输入契约 + 输出契约（+ 何时触发）？」——
/// 能 → status=ready + 完整 skillSpec；不能 → status=needs_clarification + understanding +
/// 1~3 个只针对卡住契约位的选项题。禁止问能从描述推断的东西；简单需求第一轮必须直接 ready。
fn create_skill_clarify_core_rules() -> &'static str {
    "Self-assessment (the single decision): \"Can I write a PRECISE input contract and output contract (plus when-to-trigger) RIGHT NOW from what I know?\"\n\
     - If YES: set status=\"ready\" and return a COMPLETE skillSpec (every array filled with concrete strings). Leave questions empty.\n\
     - If NO: set status=\"needs_clarification\", set understanding to ONE short sentence restating what skill you think the user wants (so they can catch a wrong direction), and return 1 to 3 option-based questions that target ONLY the input/output contract pieces you are still missing. You may return a partial skillSpec draft.\n\
     Hard rules:\n\
     - A SIMPLE need (e.g. \"turn my notes into a teleprompter script\") MUST be status=\"ready\" on the FIRST turn with ZERO questions.\n\
     - NEVER ask about anything you can infer from the description. Only ask what genuinely blocks a precise input/output contract.\n\
     - Each question must be self-contained (state the situation) and option-based.\n\
     - When status=ready: whenToUse becomes the frontmatter description; userInput describes what the user provides; output describes in prose what the skill produces; outputParts has >=2 concrete parts; workflow has >=3 concrete steps; boundaries has >=1 limit; successCriteria has >=1 observable criterion. No placeholders, no generic \"structured agent workflow\", no empty arrays."
}

fn create_skill_start_prompt(prompt: &str, language: &str) -> String {
    let language_rule = if language == "zh" {
        "All human-facing strings (understanding, questions, and every skillSpec value) must be Chinese. Keep only identifiers such as name in English kebab-case."
    } else {
        "All human-facing strings must be English."
    };
    format!(
        "You are running the FIRST turn of an adaptive clarification loop for a MySkills skill.\n\
         Return JSON only. Do not include markdown fences or explanatory text.\n\
         Set schemaVersion exactly to \"create-skill.v1\" and command exactly to \"start\".\n\
         {language_rule}\n\n\
         {}\n\n\
         JSON shape (status drives which fields matter):\n\
{}\n\n\
         User need:\n{prompt}",
        create_skill_clarify_core_rules(),
        create_skill_start_json_contract(language)
    )
}

fn create_skill_start_repair_prompt(
    prompt: &str,
    language: &str,
    previous_text: &str,
    issues: &[Value],
) -> String {
    let issue_list = issues
        .iter()
        .filter_map(|issue| {
            let field = issue.get("field").and_then(Value::as_str)?;
            let message = issue.get("message").and_then(Value::as_str).unwrap_or("");
            Some(format!("- {field}: {message}"))
        })
        .collect::<Vec<_>>()
        .join("\n");
    let language_rule = if language == "zh" {
        "All user-facing text must be Chinese."
    } else {
        "All user-facing text must be English."
    };
    format!(
        "Your previous JSON did not pass MySkills quality validation.\n\
         Missing or invalid fields:\n{issue_list}\n\n\
         Repair the result for this user need. Return JSON only. Set schemaVersion exactly to \"create-skill.v1\" and command exactly to \"start\".\n\
         {language_rule}\n\
         The returned skillSpec MUST contain concrete, non-placeholder values for:\n\
         - name: lowercase kebab-case directory name\n\
         - description: concise trigger sentence\n\
         - intentFrame.whenToUse\n\
         - intentFrame.userInput\n\
         - intentFrame.output: a non-empty prose description of what the skill produces\n\
         - intentFrame.outputParts: at least two concrete parts\n\
         - intentFrame.workflow: at least three concrete steps\n\
         - intentFrame.boundaries: at least one limit or non-goal\n\
         - intentFrame.successCriteria: at least one string\n\
         - questions: at least one option-based follow-up question\n\n\
         Use this exact JSON shape and fill all arrays with concrete strings:\n{}\n\n\
         User need:\n{prompt}\n\n\
         Previous model output:\n{}",
        create_skill_start_json_contract(language),
        truncate(previous_text, 4000)
    )
}

fn create_skill_start_json_contract(language: &str) -> &'static str {
    if language == "en" {
        r#"{
  "schemaVersion": "create-skill.v1",
  "command": "start",
  "status": "ready | needs_clarification",
  "understanding": "One sentence restating the skill you think the user wants (required when needs_clarification).",
  "skillSpec": {
    "name": "short-kebab-case-name",
    "description": "Use when the user needs ...",
    "language": "en",
    "intentFrame": {
      "whenToUse": "When the user should invoke this skill and for what task.",
      "userInput": "What the user provides when invoking the skill.",
      "output": "What this skill produces for the user.",
      "outputParts": ["First part of the output", "Second part of the output"],
      "workflow": ["Step 1", "Step 2", "Step 3"],
      "boundaries": ["Ask before risky or irreversible work", "What this skill should not do"],
      "successCriteria": ["Observable success criterion"],
      "safety": {
        "network": "no",
        "fileWrites": "none",
        "overwrite": "never",
        "privacy": "local_only",
        "artifactType": "markdown"
      }
    },
    "ready": false,
    "missing": ["target_context", "input_scope", "artifact", "strictness"]
  },
  "questions": [
    {
      "id": "target_context",
      "question": "Which work context should this skill prioritize?",
      "options": [
        { "id": "writing", "label": "Writing", "effect": "target_context=writing" },
        { "id": "code_review", "label": "Code review", "effect": "target_context=code_review" }
      ],
      "allowFreeform": true
    }
  ]
}
// When status="ready": set skillSpec.ready=true, fill every array, and return "questions": [].
// When status="needs_clarification": fill "understanding" and return 1-3 questions that block the input/output contract.
"#
    } else {
        r#"{
  "schemaVersion": "create-skill.v1",
  "command": "start",
  "status": "ready | needs_clarification",
  "understanding": "用一句话复述你认为用户想要的技能（needs_clarification 时必填）。",
  "skillSpec": {
    "name": "short-kebab-case-name",
    "description": "当用户需要……时使用。",
    "language": "zh",
    "intentFrame": {
      "whenToUse": "用户应该在什么情境下、为完成什么任务调用这个技能。",
      "userInput": "用户调用时会提供什么。",
      "output": "这个技能为用户产出什么。",
      "outputParts": ["输出的第一部分", "输出的第二部分"],
      "workflow": ["步骤 1", "步骤 2", "步骤 3"],
      "boundaries": ["涉及风险或不可逆操作前必须追问", "这个技能不应该做的事"],
      "successCriteria": ["可观察的验收标准"],
      "safety": {
        "network": "no",
        "fileWrites": "none",
        "overwrite": "never",
        "privacy": "local_only",
        "artifactType": "markdown"
      }
    },
    "ready": false,
    "missing": ["target_context", "input_scope", "artifact", "strictness"]
  },
  "questions": [
    {
      "id": "target_context",
      "question": "这个技能应该优先服务哪类工作？",
      "options": [
        { "id": "writing", "label": "写作处理", "effect": "target_context=writing" },
        { "id": "code_review", "label": "代码审查", "effect": "target_context=code_review" }
      ],
      "allowFreeform": true
    }
  ]
}
// status="ready" 时：skillSpec.ready=true，填满所有数组，并返回 "questions": []。
// status="needs_clarification" 时：填 "understanding"，返回 1~3 个卡住输入/输出契约的选项题。
"#
    }
}

fn create_skill_start_quality_issues(spec: &Value, _questions: &Value) -> Vec<Value> {
    let mut issues = Vec::new();
    let name = spec.get("name").and_then(Value::as_str).unwrap_or("");
    if !is_safe_basename(name) || name != slugify_skill_name(name) {
        issues.push(json!({ "field": "name", "message": "Skill name must be a safe kebab-case directory name." }));
    }
    if weak_create_skill_text(spec.get("description").and_then(Value::as_str), 20) {
        issues.push(json!({ "field": "description", "message": "Description is missing or placeholder-like." }));
    }
    let intent = spec.get("intentFrame").unwrap_or(&Value::Null);
    if weak_create_skill_text(intent.get("whenToUse").and_then(Value::as_str), 12) {
        issues.push(json!({ "field": "intentFrame.whenToUse", "message": "When-to-use is missing." }));
    }
    if weak_create_skill_text(intent.get("userInput").and_then(Value::as_str), 12) {
        issues.push(json!({ "field": "intentFrame.userInput", "message": "User input is missing." }));
    }
    if weak_create_skill_text(intent.get("output").and_then(Value::as_str), 1) {
        issues.push(json!({ "field": "intentFrame.output", "message": "Output description is missing." }));
    }
    if non_empty_array_len(intent.get("outputParts")) < 2 {
        issues.push(json!({ "field": "intentFrame.outputParts", "message": "Output needs at least two concrete parts." }));
    }
    if non_empty_array_len(intent.get("workflow")) < 3 {
        issues.push(json!({ "field": "intentFrame.workflow", "message": "Workflow needs at least three concrete steps." }));
    }
    if non_empty_array_len(intent.get("successCriteria")) < 1 {
        issues.push(json!({ "field": "intentFrame.successCriteria", "message": "Success criteria are missing." }));
    }
    issues
}

fn weak_create_skill_text(value: Option<&str>, min_chars: usize) -> bool {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return true;
    };
    let lower = value.to_ascii_lowercase();
    value.chars().count() < min_chars
        || lower.contains("structured agent workflow")
        || lower.contains("new-skill")
        || lower.contains("placeholder")
}

fn non_empty_array_len(value: Option<&Value>) -> usize {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|item| !item.trim().is_empty())
                .count()
        })
        .unwrap_or(0)
}

fn create_skill_question_has_options(value: &Value) -> bool {
    value
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.trim().is_empty())
        && value
            .get("question")
            .and_then(Value::as_str)
            .is_some_and(|question| !question.trim().is_empty())
        && value
            .get("options")
            .and_then(Value::as_array)
            .is_some_and(|options| {
                options.iter().any(|option| {
                    option
                        .get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| !id.trim().is_empty())
                        && option
                            .get("label")
                            .and_then(Value::as_str)
                            .is_some_and(|label| !label.trim().is_empty())
                })
            })
}

fn create_skill_questions_have_options(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.iter().any(create_skill_question_has_options))
}

fn create_skill_repair_start_spec(spec: &mut Value, prompt: &str, language: &str) {
    if spec.get("language").and_then(Value::as_str).is_none() {
        spec["language"] = json!(language);
    }
    if !spec.get("intentFrame").is_some_and(Value::is_object) {
        spec["intentFrame"] = json!({});
    }
    create_skill_copy_string_alias(
        spec,
        &[
            "whenToUse",
            "trigger",
            "triggerContext",
            "useWhen",
            "activationContext",
        ],
        &["intentFrame", "whenToUse"],
    );
    create_skill_copy_string_alias(
        spec,
        &[
            "userInput",
            "userJob",
            "userNeed",
            "jobToBeDone",
            "problem",
            "need",
            "intent",
            "goal",
        ],
        &["intentFrame", "userInput"],
    );
    create_skill_copy_string_alias(
        spec,
        &["output", "result", "deliverable", "artifact"],
        &["intentFrame", "output"],
    );
    create_skill_copy_value_alias(spec, &["outputParts"], &["intentFrame", "outputParts"]);
    create_skill_copy_value_alias(spec, &["workflow"], &["intentFrame", "workflow"]);
    create_skill_copy_value_alias(spec, &["boundaries"], &["intentFrame", "boundaries"]);
    create_skill_copy_value_alias(spec, &["safety"], &["intentFrame", "safety"]);
    create_skill_copy_value_alias(
        spec,
        &["successCriteria"],
        &["intentFrame", "successCriteria"],
    );
    create_skill_normalize_spec(spec);
    if let Some(value) = spec
        .get("acceptedInputs")
        .and_then(create_skill_string_array_value)
        .or_else(|| spec.get("inputs").and_then(create_skill_string_array_value))
    {
        // 旧 acceptedInputs 数组合并进 userInput 自由文本（防止旧形状丢失输入约束）。
        create_skill_fold_inputs_into_user_input(spec, &value);
    }
    if let Some(value) = spec.get("steps").cloned().filter(|value| value.is_array()) {
        spec["intentFrame"]["workflow"] = value;
    }
    create_skill_repair_start_array_aliases(spec);
    if spec["intentFrame"]
        .get("whenToUse")
        .and_then(Value::as_str)
        .is_none_or(|value| value.trim().is_empty())
    {
        spec["intentFrame"]["whenToUse"] = json!(prompt.trim());
    }
    if spec["intentFrame"]
        .get("userInput")
        .and_then(Value::as_str)
        .is_none_or(|value| value.trim().is_empty())
    {
        spec["intentFrame"]["userInput"] = json!(prompt.trim());
    }
    create_skill_normalize_spec(spec);
    create_skill_repair_start_array_aliases(spec);
}

/// 把一组旧式 acceptedInputs 数组项折叠进 userInput 自由文本，避免迁移时丢失输入约束。
fn create_skill_fold_inputs_into_user_input(spec: &mut Value, inputs: &Value) {
    let Some(items) = inputs.as_array() else {
        return;
    };
    let joined = items
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if joined.is_empty() {
        return;
    }
    let current = spec["intentFrame"]
        .get("userInput")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let next = if current.is_empty() {
        joined
    } else if current.contains(&joined) {
        current
    } else {
        format!("{current}\n{joined}")
    };
    spec["intentFrame"]["userInput"] = json!(next);
}

fn create_skill_repair_start_array_aliases(spec: &mut Value) {
    if non_empty_array_len(
        spec.get("intentFrame")
            .and_then(|intent| intent.get("outputParts")),
    ) < 2
    {
        if let Some(value) = create_skill_first_non_empty_string_array(
            spec,
            &[
                &["intentFrame", "outputParts"],
                &["intentFrame", "output_parts"],
                &["intentFrame", "outputComponents"],
                &["intentFrame", "output_components"],
                &["intentFrame", "deliverables"],
                &["outputParts"],
                &["output_parts"],
                &["outputComponents"],
                &["deliverables"],
            ],
        ) {
            spec["intentFrame"]["outputParts"] = value;
        }
    }

    if non_empty_array_len(
        spec.get("intentFrame")
            .and_then(|intent| intent.get("workflow")),
    ) < 3
    {
        if let Some(value) = create_skill_first_non_empty_string_array(
            spec,
            &[
                &["intentFrame", "workflow"],
                &["intentFrame", "workflow", "steps"],
                &["intentFrame", "workflowSteps"],
                &["intentFrame", "workflow_steps"],
                &["intentFrame", "steps"],
                &["workflow"],
                &["workflow", "steps"],
                &["workflowSteps"],
                &["workflow_steps"],
                &["steps"],
                &["process"],
                &["procedure"],
            ],
        ) {
            spec["intentFrame"]["workflow"] = value;
        }
    }

    if non_empty_array_len(
        spec.get("intentFrame")
            .and_then(|intent| intent.get("successCriteria")),
    ) < 1
    {
        if let Some(value) = create_skill_first_non_empty_string_array(
            spec,
            &[
                &["intentFrame", "successCriteria"],
                &["intentFrame", "success_criteria"],
                &["intentFrame", "acceptanceCriteria"],
                &["intentFrame", "acceptance_criteria"],
                &["intentFrame", "qualityBar"],
                &["intentFrame", "quality_bar"],
                &["successCriteria"],
                &["success_criteria"],
                &["acceptanceCriteria"],
                &["acceptance_criteria"],
                &["qualityBar"],
                &["quality_bar"],
                &["criteria"],
            ],
        ) {
            spec["intentFrame"]["successCriteria"] = value;
        }
    }

    if non_empty_array_len(
        spec.get("intentFrame")
            .and_then(|intent| intent.get("boundaries")),
    ) < 1
    {
        if let Some(value) = create_skill_first_non_empty_string_array(
            spec,
            &[
                &["intentFrame", "boundaries"],
                &["intentFrame", "failClosedRules"],
                &["intentFrame", "fail_closed_rules"],
                &["intentFrame", "nonGoals"],
                &["intentFrame", "non_goals"],
                &["intentFrame", "guardrails"],
                &["intentFrame", "workflow", "failClosedRules"],
                &["intentFrame", "workflow", "fail_closed_rules"],
                &["boundaries"],
                &["failClosedRules"],
                &["fail_closed_rules"],
                &["nonGoals"],
                &["guardrails"],
                &["safetyRules"],
            ],
        ) {
            spec["intentFrame"]["boundaries"] = value;
        }
    }
}

fn create_skill_first_non_empty_string_array(spec: &Value, paths: &[&[&str]]) -> Option<Value> {
    paths
        .iter()
        .filter_map(|path| create_skill_get_path(spec, path))
        .find_map(create_skill_string_array_value)
}

fn create_skill_string_array_value(value: &Value) -> Option<Value> {
    let items = match value {
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>(),
        Value::String(text) => text
            .lines()
            .flat_map(|line| line.split(['；', ';']))
            .map(str::trim)
            .map(|line| line.trim_start_matches(['-', '*', '•']).trim())
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>(),
        _ => Vec::new(),
    };
    if items.is_empty() {
        None
    } else {
        Some(json!(items))
    }
}

fn create_skill_copy_string_alias(spec: &mut Value, from_keys: &[&str], to_path: &[&str]) {
    if create_skill_path_has_non_empty_string(spec, to_path) {
        return;
    }
    let Some(value) = from_keys
        .iter()
        .find_map(|key| spec.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
    else {
        return;
    };
    create_skill_set_path(spec, to_path, json!(value));
}

fn create_skill_copy_value_alias(spec: &mut Value, from_keys: &[&str], to_path: &[&str]) {
    if create_skill_path_has_value(spec, to_path) {
        return;
    }
    let Some(value) = from_keys.iter().find_map(|key| spec.get(*key).cloned()) else {
        return;
    };
    create_skill_set_path(spec, to_path, value);
}

fn create_skill_path_has_non_empty_string(spec: &Value, path: &[&str]) -> bool {
    create_skill_get_path(spec, path)
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
}

fn create_skill_path_has_value(spec: &Value, path: &[&str]) -> bool {
    create_skill_get_path(spec, path).is_some_and(|value| !value.is_null())
}

fn create_skill_get_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    Some(current)
}

fn create_skill_set_path(value: &mut Value, path: &[&str], next: Value) {
    let Some((last, parents)) = path.split_last() else {
        return;
    };
    let mut current = value;
    for segment in parents {
        if !current.get(*segment).is_some_and(Value::is_object) {
            current[*segment] = json!({});
        }
        current = &mut current[*segment];
    }
    current[*last] = next;
}

fn create_skill_coerce_start_payload(parsed: Value, prompt: &str, language: &str) -> Value {
    if parsed.get("schemaVersion").and_then(Value::as_str) == Some("create-skill.v1")
        && parsed.get("command").and_then(Value::as_str) == Some("start")
    {
        return parsed;
    }
    let Some(obj) = parsed.as_object() else {
        return parsed;
    };
    let nested = obj
        .get("payload")
        .or_else(|| obj.get("data"))
        .filter(|value| value.is_object());
    let source = nested.and_then(Value::as_object).unwrap_or(obj);
    let spec = source
        .get("skillSpec")
        .or_else(|| source.get("spec"))
        .cloned()
        .or_else(|| {
            if source.contains_key("name")
                || source.contains_key("description")
                || source.contains_key("intentFrame")
                || source.contains_key("userJob")
                || source.contains_key("triggerContext")
            {
                Some(Value::Object(source.clone()))
            } else {
                None
            }
        });
    let Some(mut spec) = spec else {
        return parsed;
    };
    if spec.get("language").and_then(Value::as_str).is_none() {
        spec["language"] = json!(language);
    }
    if spec.get("intentFrame").is_none() {
        if let Some(intent) = source.get("intentFrame").or_else(|| source.get("intent")) {
            spec["intentFrame"] = intent.clone();
        } else if source.contains_key("whenToUse")
            || source.contains_key("userInput")
            || source.contains_key("userJob")
            || source.contains_key("triggerContext")
        {
            spec["intentFrame"] = json!({
                "whenToUse": source.get("whenToUse").or_else(|| source.get("triggerContext")).and_then(Value::as_str).unwrap_or(""),
                "userInput": source.get("userInput").or_else(|| source.get("userJob")).and_then(Value::as_str).unwrap_or(""),
                "output": source.get("output").and_then(Value::as_str).unwrap_or(""),
                "outputParts": source.get("outputParts").cloned().unwrap_or_else(|| json!([])),
                "workflow": source.get("workflow").cloned().unwrap_or_else(|| json!([])),
                "boundaries": source.get("boundaries").cloned().unwrap_or_else(|| json!([])),
                "successCriteria": source.get("successCriteria").cloned().unwrap_or_else(|| json!([])),
                "safety": source.get("safety").cloned().unwrap_or_else(|| json!({}))
            });
        }
    }
    if !spec.get("intentFrame").is_some_and(Value::is_object) {
        spec["intentFrame"] = json!({});
    }
    if spec["intentFrame"]
        .get("whenToUse")
        .and_then(Value::as_str)
        .is_none_or(|value| value.trim().is_empty())
    {
        spec["intentFrame"]["whenToUse"] = json!(prompt);
    }
    if spec["intentFrame"]
        .get("userInput")
        .and_then(Value::as_str)
        .is_none_or(|value| value.trim().is_empty())
    {
        spec["intentFrame"]["userInput"] = json!(prompt);
    }
    create_skill_normalize_spec(&mut spec);
    json!({
        "schemaVersion": "create-skill.v1",
        "command": "start",
        "status": source.get("status").and_then(Value::as_str).unwrap_or("intent_draft"),
        // understanding：一行理解复述。coerce 阶段透传，下游 status envelope 会读它。
        "understanding": source.get("understanding").cloned().unwrap_or(Value::Null),
        "intentFrame": spec.get("intentFrame").cloned().unwrap_or(Value::Null),
        "skillSpec": spec,
        "questions": source
            .get("questions")
            .or_else(|| source.get("followupQuestions"))
            .cloned()
            .unwrap_or_else(|| json!([]))
    })
}

// Superseded in production by create_skill_status_envelope (which also reads
// status/understanding and no longer forces skillSpec); retained only for the
// coerce-shape unit test, so gate it to test builds to avoid a dead-code warn.
#[cfg(test)]
fn create_skill_envelope_payload(parsed: Value, command: &str) -> AppResult<(Value, Value)> {
    if parsed.get("schemaVersion").and_then(Value::as_str) != Some("create-skill.v1") {
        return Err(AppError::new(
            "LLM_SCHEMA_MISMATCH",
            "Create Skill schema mismatch.",
        ));
    }
    if parsed.get("command").and_then(Value::as_str) != Some(command) {
        let actual = parsed
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("<missing>");
        return Err(AppError::new(
            "LLM_COMMAND_MISMATCH",
            format!("Create Skill command mismatch: expected {command}, got {actual}."),
        ));
    }
    let mut spec = parsed
        .get("skillSpec")
        .cloned()
        .ok_or_else(|| AppError::new("LLM_BAD_RESPONSE", "skillSpec missing"))?;
    if spec.get("intentFrame").is_none() {
        if let Some(intent) = parsed.get("intentFrame") {
            spec["intentFrame"] = intent.clone();
        }
    }
    create_skill_normalize_spec(&mut spec);
    let questions = parsed
        .get("questions")
        .or_else(|| parsed.get("followupQuestions"))
        .cloned()
        .or_else(|| parsed.get("question").map(|q| json!([q])))
        .filter(|v| v.is_array())
        .filter(|v| v.as_array().is_some_and(|items| !items.is_empty()))
        .unwrap_or_else(|| create_skill_default_questions(&spec));
    Ok((spec, questions))
}

/// 自适应澄清循环的状态机 envelope（LLM 自评结果）。`status='ready'` 时 spec 必须完整可结晶；
/// `status='needs_clarification'` 时 understanding 必须为一行理解复述，questions 为 1~3 个
/// 只针对卡住的输入/输出契约的选项式问题（spec 可能只是部分草稿）。
struct CreateSkillStatusEnvelope {
    status: String,
    understanding: String,
    spec: Value,
    questions: Value,
}

/// 读取并校验 start/clarify 的状态机 envelope。复用 schema/command 校验；按 status 分支：
/// ready → 取完整 skillSpec；needs_clarification → spec 可缺，questions 必须有选项。
/// 与旧 create_skill_envelope_payload 的差异是不再强制 skillSpec 存在，并多读 status/understanding。
fn create_skill_status_envelope(
    parsed: Value,
    command: &str,
) -> AppResult<CreateSkillStatusEnvelope> {
    if parsed.get("schemaVersion").and_then(Value::as_str) != Some("create-skill.v1") {
        return Err(AppError::new(
            "LLM_SCHEMA_MISMATCH",
            "Create Skill schema mismatch.",
        ));
    }
    if parsed.get("command").and_then(Value::as_str) != Some(command) {
        let actual = parsed
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("<missing>");
        return Err(AppError::new(
            "LLM_COMMAND_MISMATCH",
            format!("Create Skill command mismatch: expected {command}, got {actual}."),
        ));
    }
    // status：归一到两态。除了显式 'ready' / 'spec_ready'，spec.ready==true 也视为 ready。
    let raw_status = parsed.get("status").and_then(Value::as_str).unwrap_or("");
    let mut spec = parsed
        .get("skillSpec")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if spec.get("intentFrame").is_none() {
        if let Some(intent) = parsed.get("intentFrame") {
            spec["intentFrame"] = intent.clone();
        }
    }
    create_skill_normalize_spec(&mut spec);
    let spec_self_ready = spec.get("ready").and_then(Value::as_bool) == Some(true);
    let status = if matches!(raw_status, "ready" | "spec_ready") || spec_self_ready {
        "ready"
    } else {
        "needs_clarification"
    }
    .to_string();
    let understanding = parsed
        .get("understanding")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_default();
    let questions = parsed
        .get("questions")
        .or_else(|| parsed.get("followupQuestions"))
        .cloned()
        .or_else(|| parsed.get("question").map(|q| json!([q])))
        .filter(|v| v.is_array())
        .unwrap_or_else(|| json!([]));
    Ok(CreateSkillStatusEnvelope {
        status,
        understanding,
        spec,
        questions,
    })
}

fn create_skill_system_prompt(language: &str) -> String {
    format!(
        "You are MySkills Create Skill compiler. Return JSON only with schemaVersion=create-skill.v1. Language: {language}. If language=zh, all human-facing questions, headings, instructions, and SKILL.md body text must be Chinese; keep only identifiers and unavoidable technical terms in English. Commands use this envelope: {{schemaVersion,command,status,intentFrame,skillSpec,questions,draftMarkdown,review,errors}}. Build local-first agent skills, not generic prompts. Final SKILL.md must begin with YAML frontmatter containing exactly name and description. The frontmatter description must be a concise trigger sentence that starts with or clearly means 'Use when ...'. Prefer a short procedural SKILL.md with accepted inputs, workflow, output, boundaries, and quality bar, but choose a different structure when it better fits the skill. Preserve useful creative framing as long as triggering, inputs, execution guidance, safety boundaries, and expected output are clear. Ask option-based follow-up questions only for decisions that materially change triggering, inputs, outputs, privacy, file writes, or network use. Never ask for secrets. Do not allow silent overwrite, deletion, external network, or irreversible work. Skill names must be lowercase kebab-case safe directory basenames. SAFETY GATES (hard rule): whenever the skill's safety declares network other than 'no', OR fileWrites other than 'none', OR overwrite='confirm_each_time', the generated SKILL.md '## 安全边界' / '## Boundaries' section MUST contain, for each such behavior, an explicit gate sentence using a word like 先确认/经用户授权/confirm — for example 'ask for confirmation before any file write' or '联网前先取得用户授权'. Never describe a risky behavior without its gate sentence in that section."
    )
}

fn create_skill_local_spec(prompt: &str, language: &str, answers: &Value) -> Value {
    let name = slugify_skill_name(prompt);
    let context = answers
        .get("target_context")
        .and_then(Value::as_str)
        .unwrap_or("general_agent_workflow");
    let input_scope = answers
        .get("input_scope")
        .and_then(Value::as_str)
        .unwrap_or("rough_need");
    let artifact = answers
        .get("artifact")
        .and_then(Value::as_str)
        .unwrap_or("markdown");
    let destination = answers
        .get("destination")
        .and_then(Value::as_str)
        .unwrap_or("none");
    let mut workflow = vec![
        if language == "en" {
            "Restate the user's need as a concrete job-to-be-done and list missing constraints."
        } else {
            "把用户需求复述成一个明确的待完成任务，并列出缺失约束。"
        },
        if language == "en" {
            "Identify the input material, target audience, expected artifact, and acceptance criteria."
        } else {
            "识别输入材料、目标对象、期望产物和验收标准。"
        },
        if language == "en" {
            "Execute the workflow step by step, surfacing assumptions before risky or irreversible work."
        } else {
            "按步骤执行工作流，在风险或不可逆操作前先暴露假设。"
        },
        if language == "en" {
            "Return the artifact with a short quality check and remaining open questions."
        } else {
            "输出产物，并附上简短质量检查和仍未解决的问题。"
        },
    ];
    let overwrite = if answers.get("strictness").and_then(Value::as_str) == Some("confirm") {
        workflow.push(if language == "en" {
            "Ask for confirmation before any file write."
        } else {
            "任何文件写入前都先请求确认。"
        });
        "confirm_each_time"
    } else {
        "never"
    };
    let user_input = match (language, input_scope) {
        ("en", "files_or_links") => "User-provided files, paths, links, and a short description of the desired result.",
        ("en", "codebase") => "Repository context, changed files, command output, and the user's review goal.",
        ("en", "materials") => "Source notes, drafts, transcripts, references, or other user-selected material.",
        ("en", _) => "A rough natural-language description of the problem, recurring need, or desired result.",
        (_, "files_or_links") => "用户提供的文件、路径、链接，以及对期望结果的简短描述。",
        (_, "codebase") => "代码仓库上下文、变更文件、命令输出，以及用户的审查目标。",
        (_, "materials") => "用户选择的笔记、草稿、转录稿、参考资料或其他素材。",
        (_, _) => "用户对困境、反复需求或期望结果的粗略自然语言描述。",
    };
    let description = if language == "en" {
        format!(
            "Use when the user needs a repeatable workflow for {}: {}",
            context_label(context, language),
            truncate(prompt, 96)
        )
    } else {
        format!(
            "当用户需要一个可复用的{}技能时使用：{}",
            context_label(context, language),
            truncate(prompt, 96)
        )
    };
    let output = if language == "en" {
        format!(
            "A reviewable {} the user can act on, plus the assumptions made along the way.",
            artifact
        )
    } else {
        format!("一份可复核的 {} 产物，附带过程中所做的关键假设。", artifact)
    };
    let output_parts = if language == "en" {
        json!([
            format!("The main {} body.", artifact),
            "Assumptions, skipped work, and remaining decision points."
        ])
    } else {
        json!([
            format!("{} 产物主体。", artifact),
            "关键假设、未执行的工作，以及仍需用户决定的问题。"
        ])
    };
    let missing = ["target_context", "input_scope", "artifact", "strictness"]
        .iter()
        .filter(|key| answers.get(**key).and_then(Value::as_str).is_none())
        .map(|key| json!(key))
        .collect::<Vec<_>>();
    json!({
        "name": name,
        "description": description,
        "language": language,
        "intentFrame": {
            "whenToUse": prompt,
            "userInput": user_input,
            "output": output,
            "outputParts": output_parts,
            "workflow": workflow,
            "boundaries": [
                if language == "en" { "Do not invent missing constraints; ask when a decision affects files, privacy, or irreversible work." } else { "不要编造缺失约束；当决策影响文件、隐私或不可逆操作时必须追问。" },
                if language == "en" { "Never expose secrets or send local content externally without explicit permission." } else { "不得泄露密钥；未经明确许可不得把本地内容发送到外部服务。" },
                if language == "en" { "Do not become a general-purpose editor or hidden automation runner." } else { "不做通用编辑器，也不做隐藏自动执行器。" }
            ],
            "successCriteria": [if language == "en" { "The user can run the skill on a similar need without re-explaining the whole workflow." } else { "用户下次遇到类似需求时，可以直接调用技能而无需重新解释整套流程。" }],
            "safety": {
                "network": "no",
                "fileWrites": if destination == "none" { "none" } else { destination },
                "overwrite": overwrite,
                "privacy": "local_only",
                "artifactType": artifact
            }
        },
        "ready": missing.is_empty(),
        "missing": missing
    })
}

fn create_skill_default_questions(spec: &Value) -> Value {
    let lang = spec.get("language").and_then(Value::as_str).unwrap_or("zh");
    json!([
        {
            "id": "target_context",
            "question": if lang == "en" { "Where will this skill be most useful?" } else { "这个技能主要服务哪类工作？" },
            "options": [
                { "id": "general_agent_workflow", "label": if lang == "en" { "General agent work" } else { "通用 Agent 工作" }, "effect": "target_context=general_agent_workflow" },
                { "id": "code_review", "label": if lang == "en" { "Code / review" } else { "代码 / 审查" }, "effect": "target_context=code_review" },
                { "id": "writing", "label": if lang == "en" { "Writing" } else { "写作处理" }, "effect": "target_context=writing" }
            ],
            "allowFreeform": true
        },
        {
            "id": "input_scope",
            "question": if lang == "en" { "What input should the skill expect from the user?" } else { "用户调用时通常会提供什么输入？" },
            "options": [
                { "id": "rough_need", "label": if lang == "en" { "Rough need" } else { "粗略需求" }, "effect": "input_scope=rough_need" },
                { "id": "files_or_links", "label": if lang == "en" { "Files / links" } else { "文件 / 链接" }, "effect": "input_scope=files_or_links" },
                { "id": "codebase", "label": if lang == "en" { "Repo context" } else { "仓库上下文" }, "effect": "input_scope=codebase" }
            ],
            "allowFreeform": true
        },
        {
            "id": "artifact",
            "question": if lang == "en" { "What should this skill usually produce?" } else { "这个技能通常应该产出什么？" },
            "options": [
                { "id": "markdown", "label": if lang == "en" { "Markdown answer" } else { "Markdown 方案" }, "effect": "artifact=markdown" },
                { "id": "checklist", "label": if lang == "en" { "Checklist" } else { "检查清单" }, "effect": "artifact=checklist" },
                { "id": "code_patch", "label": if lang == "en" { "Code patch" } else { "代码改动" }, "effect": "artifact=code_patch" }
            ],
            "allowFreeform": true
        },
        {
            "id": "strictness",
            "question": if lang == "en" { "How cautious should it be before taking action?" } else { "它在行动前应该有多保守？" },
            "options": [
                { "id": "confirm", "label": if lang == "en" { "Confirm writes" } else { "写入前确认" }, "effect": "strictness=confirm" },
                { "id": "ask_when_unclear", "label": if lang == "en" { "Ask when unclear" } else { "不确定就追问" }, "effect": "strictness=ask_when_unclear" },
                { "id": "advisory_only", "label": if lang == "en" { "Advice only" } else { "只给建议" }, "effect": "strictness=advisory_only" }
            ],
            "allowFreeform": true
        }
    ])
}

fn create_skill_apply_answer(spec: &mut Value, question_id: &str, answer: &str) {
    match question_id {
        // target_context 调整 whenToUse 措辞（旧 description 派生逻辑迁到 description + whenToUse）。
        "target_context" => {
            let context = if answer.contains("code_review")
                || answer.contains("代码")
                || answer.contains("审查")
            {
                "code_review"
            } else if answer.contains("writing") || answer.contains("写作") {
                "writing"
            } else {
                "general_agent_workflow"
            };
            let lang = spec.get("language").and_then(Value::as_str).unwrap_or("zh");
            let user_input = spec
                .get("intentFrame")
                .and_then(|i| i.get("userInput"))
                .and_then(Value::as_str)
                .unwrap_or("");
            spec["description"] = json!(if lang == "en" {
                format!(
                    "Use when the user needs a repeatable workflow for {}: {}",
                    context_label(context, lang),
                    truncate(user_input, 96)
                )
            } else {
                format!(
                    "当用户需要一个可复用的{}技能时使用：{}",
                    context_label(context, lang),
                    truncate(user_input, 96)
                )
            });
        }
        // input_scope 直写 userInput 自由文本。
        "input_scope" => {
            let lang = spec.get("language").and_then(Value::as_str).unwrap_or("zh");
            let input = if answer.contains("codebase") || answer.contains("仓库") {
                if lang == "en" {
                    "Repository context, changed files, command output, and the user's review goal."
                } else {
                    "代码仓库上下文、变更文件、命令输出，以及用户的审查目标。"
                }
            } else if answer.contains("files_or_links")
                || answer.contains("文件")
                || answer.contains("链接")
            {
                if lang == "en" {
                    "User-provided files, paths, links, and a short description of the desired result."
                } else {
                    "用户提供的文件、路径、链接，以及对期望结果的简短描述。"
                }
            } else if lang == "en" {
                "A rough natural-language description of the problem, recurring need, or desired result."
            } else {
                "用户对困境、反复需求或期望结果的粗略自然语言描述。"
            };
            spec["intentFrame"]["userInput"] = json!(input);
        }
        // artifact → safety.artifactType。
        "artifact" => {
            let artifact = if answer.contains("code_patch") || answer.contains("代码") {
                "code_patch"
            } else if answer.contains("checklist") || answer.contains("清单") {
                "checklist"
            } else {
                "markdown"
            };
            spec["intentFrame"]["safety"]["artifactType"] = json!(artifact);
        }
        // strictness → safety.overwrite（并补一条边界确认句）。
        "strictness" => {
            let policy = if answer.contains("confirm") || answer.contains("确认") {
                "confirm_each_time"
            } else {
                "never"
            };
            spec["intentFrame"]["safety"]["overwrite"] = json!(policy);
            if policy == "confirm_each_time" {
                let rules = spec["intentFrame"]["boundaries"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                let confirm_rule = if spec.get("language").and_then(Value::as_str) == Some("en") {
                    "Ask for explicit confirmation before file writes, deletion, overwrite, network calls, or secret handling."
                } else {
                    "文件写入、删除、覆盖、联网调用或密钥处理前必须明确确认。"
                };
                let mut next = rules;
                if !next.iter().any(|v| v.as_str() == Some(confirm_rule)) {
                    next.push(json!(confirm_rule));
                }
                spec["intentFrame"]["boundaries"] = json!(next);
            }
        }
        _ => {}
    }
    create_skill_remove_missing(spec, question_id);
}

fn create_skill_remove_missing(spec: &mut Value, question_id: &str) {
    if let Some(items) = spec.get("missing").and_then(Value::as_array) {
        let next = items
            .iter()
            .filter(|item| item.as_str() != Some(question_id))
            .cloned()
            .collect::<Vec<_>>();
        spec["missing"] = json!(next);
    }
}

fn context_label(context: &str, language: &str) -> &'static str {
    match (language, context) {
        ("en", "code_review") => "code and review work",
        ("en", "writing") => "writing and editing work",
        ("en", _) => "agent work",
        (_, "code_review") => "代码与审查",
        (_, "writing") => "写作处理",
        (_, _) => "Agent 工作",
    }
}

/// 旧→新惰性迁移读取层：把任何旧形状的 intentFrame 字段映射到新 5 支柱 + safety，
/// 这样旧草稿 DB 行无需 SQL 迁移即可被新 schema 读取。
/// 决策2：output 为空时保持空并把 "output" 加入 missing（强制用户/LLM 重填输出段）。
fn create_skill_normalize_spec(spec: &mut Value) {
    if !spec.get("intentFrame").is_some_and(Value::is_object) {
        spec["intentFrame"] = json!({});
    }

    // --- whenToUse：空 → 取旧 triggerContext，再退回旧 description。 ---
    create_skill_intent_string_migrate(
        spec,
        "whenToUse",
        &[&["intentFrame", "triggerContext"]],
        spec.get("description").and_then(Value::as_str).map(String::from),
    );

    // --- userInput：空 → 旧 userJob，再把旧 acceptedInputs 折叠进来。 ---
    create_skill_intent_string_migrate(
        spec,
        "userInput",
        &[
            &["intentFrame", "userJob"],
            &["intentFrame", "userIntention"],
        ],
        None,
    );
    if let Some(legacy_inputs) = spec
        .get("intentFrame")
        .and_then(|i| i.get("inputContract"))
        .and_then(|c| c.get("acceptedInputs"))
        .and_then(create_skill_string_array_value)
    {
        create_skill_fold_inputs_into_user_input(spec, &legacy_inputs);
    }

    // --- output：自由正文。决策2：空就留空，并把 "output" 加进 missing。 ---
    if !spec["intentFrame"]
        .get("output")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
    {
        spec["intentFrame"]["output"] = json!("");
    }

    // --- outputParts：保持已有数组，否则空数组。 ---
    if !spec["intentFrame"].get("outputParts").is_some_and(Value::is_array) {
        spec["intentFrame"]["outputParts"] = json!([]);
    }

    // --- workflow：去掉 .steps 嵌套（旧 workflow.steps → 顶层 workflow 数组）。 ---
    if !spec["intentFrame"].get("workflow").is_some_and(Value::is_array) {
        let migrated = spec
            .get("intentFrame")
            .and_then(|i| i.get("workflow"))
            .and_then(|w| w.get("steps"))
            .and_then(create_skill_string_array_value)
            .unwrap_or_else(|| json!([]));
        spec["intentFrame"]["workflow"] = migrated;
    }

    // --- boundaries：合并旧 failClosedRules + nonGoals。 ---
    if !spec["intentFrame"].get("boundaries").is_some_and(Value::is_array) {
        let mut merged: Vec<Value> = Vec::new();
        for path in [
            ["intentFrame", "workflow", "failClosedRules"].as_slice(),
            ["intentFrame", "failClosedRules"].as_slice(),
            ["intentFrame", "nonGoals"].as_slice(),
        ] {
            if let Some(arr) = create_skill_get_path(spec, path).and_then(Value::as_array) {
                for item in arr {
                    if let Some(text) = item.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                        if !merged.iter().any(|v| v.as_str() == Some(text)) {
                            merged.push(json!(text));
                        }
                    }
                }
            }
        }
        spec["intentFrame"]["boundaries"] = json!(merged);
    }

    if !spec["intentFrame"].get("successCriteria").is_some_and(Value::is_array) {
        spec["intentFrame"]["successCriteria"] = json!([]);
    }

    // --- safety：从旧顶层 needsNetwork / outputContract / overwritePolicy / privacyClass / artifactType 组装。 ---
    create_skill_normalize_safety(spec);

    // 清理旧结构，避免悬空的旧形状嵌套被下游误读。
    if let Some(intent) = spec
        .get_mut("intentFrame")
        .and_then(Value::as_object_mut)
    {
        for legacy in [
            "userJob",
            "userIntention",
            "triggerContext",
            "inputContract",
            "outputContract",
            "stylePreferences",
            "nonGoals",
            "failClosedRules",
        ] {
            intent.remove(legacy);
        }
    }
    if let Some(obj) = spec.as_object_mut() {
        for legacy in ["needsNetwork", "writesFiles", "overwritePolicy"] {
            obj.remove(legacy);
        }
    }

    if let Some(name) = spec.get("name").and_then(Value::as_str) {
        spec["name"] = json!(slugify_skill_name(name));
    } else {
        let fallback_name = spec
            .get("intentFrame")
            .and_then(|v| v.get("userInput"))
            .and_then(Value::as_str)
            .or_else(|| spec.get("description").and_then(Value::as_str))
            .map(slugify_skill_name)
            .filter(|name| !name.is_empty());
        if let Some(name) = fallback_name {
            spec["name"] = json!(name);
        }
    }
    if spec.get("language").and_then(Value::as_str).is_none() {
        spec["language"] = json!("zh");
    }
    let lang = spec.get("language").and_then(Value::as_str).unwrap_or("zh");
    let should_repair_description = spec
        .get("description")
        .and_then(Value::as_str)
        .is_none_or(|description| create_skill_description_needs_repair(lang, description));
    if should_repair_description {
        let when_to_use = spec
            .get("intentFrame")
            .and_then(|v| v.get("whenToUse"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                spec.get("intentFrame")
                    .and_then(|v| v.get("userInput"))
                    .and_then(Value::as_str)
            })
            .unwrap_or("structured agent workflow");
        spec["description"] = json!(if lang == "en" {
            format!(
                "Use when the user needs a repeatable workflow: {}",
                truncate(when_to_use, 120)
            )
        } else {
            format!(
                "当用户需要一个可复用技能时使用：{}",
                truncate(when_to_use, 120)
            )
        });
    }

    // 决策2：output 仍为空 → 把 "output" 加进 missing，强制重填输出段。
    let output_missing = spec["intentFrame"]
        .get("output")
        .and_then(Value::as_str)
        .is_none_or(|value| value.trim().is_empty());
    let mut missing: Vec<Value> = spec
        .get("missing")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let has_output_key = missing.iter().any(|item| item.as_str() == Some("output"));
    if output_missing && !has_output_key {
        missing.push(json!("output"));
    } else if !output_missing && has_output_key {
        missing.retain(|item| item.as_str() != Some("output"));
    }
    spec["missing"] = json!(missing);

    let required_content_ready = spec
        .get("description")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.trim().is_empty())
        && spec
            .get("intentFrame")
            .and_then(|v| v.get("whenToUse"))
            .and_then(Value::as_str)
            .is_some_and(|s| !s.trim().is_empty())
        && !output_missing;
    let ready = required_content_ready
        && spec
            .get("missing")
            .and_then(Value::as_array)
            .is_none_or(|items| items.is_empty());
    spec["ready"] = json!(ready);
}

/// 若 intentFrame.<key> 为空，依次尝试旧路径与额外 fallback 文本填入。
fn create_skill_intent_string_migrate(
    spec: &mut Value,
    key: &str,
    legacy_paths: &[&[&str]],
    extra_fallback: Option<String>,
) {
    if spec["intentFrame"]
        .get(key)
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
    {
        return;
    }
    let migrated = legacy_paths
        .iter()
        .filter_map(|path| create_skill_get_path(spec, path).and_then(Value::as_str))
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(String::from)
        .or_else(|| extra_fallback.filter(|value| !value.trim().is_empty()));
    spec["intentFrame"][key] = json!(migrated.unwrap_or_default());
}

/// 组装 safety 块：已有对象保留并补全缺省键；否则从旧顶层/旧 outputContract 字段迁移。
fn create_skill_normalize_safety(spec: &mut Value) {
    let legacy_needs_network = spec.get("needsNetwork").and_then(Value::as_bool);
    let legacy_writes_files = spec.get("writesFiles").and_then(Value::as_bool);
    let legacy_overwrite = spec
        .get("overwritePolicy")
        .and_then(Value::as_str)
        .map(String::from);
    let legacy_destination = spec
        .get("intentFrame")
        .and_then(|i| i.get("outputContract"))
        .and_then(|c| c.get("destination"))
        .and_then(Value::as_str)
        .map(String::from);
    let legacy_artifact = spec
        .get("intentFrame")
        .and_then(|i| i.get("outputContract"))
        .and_then(|c| c.get("artifactType"))
        .and_then(Value::as_str)
        .map(String::from);
    let legacy_privacy = spec
        .get("intentFrame")
        .and_then(|i| i.get("inputContract"))
        .and_then(|c| c.get("privacyClass"))
        .and_then(Value::as_str)
        .map(String::from);

    let existing = spec
        .get("intentFrame")
        .and_then(|i| i.get("safety"))
        .filter(|v| v.is_object())
        .cloned();

    let network = existing
        .as_ref()
        .and_then(|s| s.get("network"))
        .and_then(Value::as_str)
        .filter(|v| matches!(*v, "no" | "reads_only" | "reads_writes"))
        .map(String::from)
        .unwrap_or_else(|| match legacy_needs_network {
            Some(true) => "reads_only".to_string(),
            _ => "no".to_string(),
        });

    let file_writes = existing
        .as_ref()
        .and_then(|s| s.get("fileWrites"))
        .and_then(Value::as_str)
        .filter(|v| matches!(*v, "none" | "same_folder" | "user_selected"))
        .map(String::from)
        .unwrap_or_else(|| match legacy_destination.as_deref() {
            Some("same_folder") => "same_folder".to_string(),
            Some("user_selected") => "user_selected".to_string(),
            _ => {
                if legacy_writes_files == Some(true) {
                    "user_selected".to_string()
                } else {
                    "none".to_string()
                }
            }
        });

    let overwrite = existing
        .as_ref()
        .and_then(|s| s.get("overwrite"))
        .and_then(Value::as_str)
        .filter(|v| matches!(*v, "never" | "confirm_each_time"))
        .map(String::from)
        .or_else(|| {
            legacy_overwrite
                .as_deref()
                .filter(|v| matches!(*v, "never" | "confirm_each_time"))
                .map(String::from)
        })
        .unwrap_or_else(|| "never".to_string());

    let privacy = existing
        .as_ref()
        .and_then(|s| s.get("privacy"))
        .and_then(Value::as_str)
        .filter(|v| matches!(*v, "local_only" | "may_send_summary" | "may_send_content"))
        .map(String::from)
        .or_else(|| {
            legacy_privacy
                .as_deref()
                .filter(|v| {
                    matches!(*v, "local_only" | "may_send_summary" | "may_send_content")
                })
                .map(String::from)
        })
        .unwrap_or_else(|| "local_only".to_string());

    let artifact_type = existing
        .as_ref()
        .and_then(|s| s.get("artifactType"))
        .and_then(Value::as_str)
        .filter(|v| {
            matches!(
                *v,
                "markdown" | "report" | "checklist" | "code_patch" | "file" | "other"
            )
        })
        .map(String::from)
        .or_else(|| {
            legacy_artifact
                .as_deref()
                .filter(|v| {
                    matches!(
                        *v,
                        "markdown" | "report" | "checklist" | "code_patch" | "file" | "other"
                    )
                })
                .map(String::from)
        })
        .unwrap_or_else(|| "markdown".to_string());

    spec["intentFrame"]["safety"] = json!({
        "network": network,
        "fileWrites": file_writes,
        "overwrite": overwrite,
        "privacy": privacy,
        "artifactType": artifact_type
    });
}

#[cfg(test)]
fn create_skill_local_markdown(spec: &Value) -> String {
    let name = spec
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("new-skill");
    let description = spec
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("Use when the user needs a structured agent workflow.");
    let lang = spec.get("language").and_then(Value::as_str).unwrap_or("zh");
    let intent = spec.get("intentFrame").unwrap_or(&Value::Null);
    let when_to_use = intent
        .get("whenToUse")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(description);
    let user_input = intent
        .get("userInput")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(if lang == "en" {
            "A rough description of the need and desired result."
        } else {
            "用户对需求和期望结果的粗略描述。"
        });
    let output_body = intent
        .get("output")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(|| {
            if lang == "en" {
                "A reviewable artifact the user can act on.".to_string()
            } else {
                "一份用户可直接采用的可复核产物。".to_string()
            }
        });
    let output_parts = intent
        .get("outputParts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let steps = intent
        .get("workflow")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let criteria = intent
        .get("successCriteria")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let boundaries = intent
        .get("boundaries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let section_title = if lang == "en" {
        "Workflow"
    } else {
        "工作流"
    };
    let safety_title = if lang == "en" {
        "Boundaries"
    } else {
        "安全边界"
    };
    let input_title = if lang == "en" { "Inputs" } else { "输入" };
    let output_title = if lang == "en" { "Output" } else { "输出" };
    let quality_title = if lang == "en" {
        "Quality Bar"
    } else {
        "质量标准"
    };
    let step_block = if steps.is_empty() {
        if lang == "en" {
            "2. Clarify the user's goal.\n3. Execute the workflow conservatively.\n4. Return the result and assumptions.".to_string()
        } else {
            "2. 澄清用户目标。\n3. 保守地执行工作流。\n4. 返回结果和关键假设。".to_string()
        }
    } else {
        steps
            .iter()
            .filter_map(Value::as_str)
            .enumerate()
            .map(|(index, s)| format!("{}. {s}", index + 2))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let input_block = format!("- {}", user_input.replace('\n', "\n- "));
    let criteria_block = if criteria.is_empty() {
        "- The result is actionable.\n- Ambiguities are surfaced before risky work.".to_string()
    } else {
        criteria
            .iter()
            .filter_map(Value::as_str)
            .map(|s| format!("- {s}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let parts_block = list_block(
        &output_parts,
        if lang == "en" {
            "The main artifact body."
        } else {
            "产物主体。"
        },
    );
    let boundary_block = list_block(
        &boundaries,
        if lang == "en" {
            "Ask before file writes, deletion, external network, or irreversible work."
        } else {
            "文件写入、删除、外部联网或不可逆操作前必须追问。"
        },
    );
    let confirm_line = if lang == "en" {
        "Confirm the task framing"
    } else {
        "确认任务框架"
    };
    format!(
        "---\nname: {name}\ndescription: {}\n---\n\n# {name}\n\n## {input_title}\n\n{input_block}\n\n## {section_title}\n\n1. {confirm_line}: {when_to_use}\n{step_block}\n\n## {output_title}\n\n{output_body}\n\n{parts_block}\n\n## {safety_title}\n\n{boundary_block}\n\n## {quality_title}\n\n{criteria_block}\n",
        yaml_quote(description)
    )
}

fn create_skill_repair_frontmatter(markdown: &str, spec: &Value) -> String {
    let name = spec
        .get("name")
        .and_then(Value::as_str)
        .map(slugify_skill_name)
        .unwrap_or_else(|| "new-skill".to_string());
    let description = spec
        .get("description")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Use when the user needs a structured agent workflow.");
    let normalized = markdown.replace("\r\n", "\n");
    let (existing_name, existing_description, body) =
        if let Some(rest) = normalized.strip_prefix("---\n") {
            if let Some(end) = rest.find("\n---") {
                let frontmatter = &rest[..end];
                let body_start = end + "\n---".len();
                let body = rest
                    .get(body_start..)
                    .unwrap_or_default()
                    .trim_start_matches('\n');
                (
                    frontmatter_scalar(frontmatter, "name"),
                    frontmatter_scalar(frontmatter, "description"),
                    body.to_string(),
                )
            } else {
                (None, None, normalized)
            }
        } else {
            (None, None, normalized)
        };
    let preferred_name =
        (!name.is_empty() && !create_skill_name_too_generic(&name)).then_some(name.clone());
    let final_name = preferred_name.unwrap_or_else(|| {
        existing_name
            .as_deref()
            .map(slugify_skill_name)
            .filter(|value| !value.is_empty() && !create_skill_name_too_generic(value))
            .unwrap_or(name)
    });
    let lang = spec.get("language").and_then(Value::as_str).unwrap_or("zh");
    let final_description = match existing_description
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        Some(existing)
            if create_skill_description_needs_repair(lang, existing)
                && !create_skill_description_needs_repair(lang, description) =>
        {
            description
        }
        Some(existing) if lang == "zh" && !contains_cjk(existing) && contains_cjk(description) => {
            description
        }
        Some(existing) => existing,
        None => description,
    };
    format!(
        "---\nname: {final_name}\ndescription: {}\n---\n\n{}",
        yaml_quote(final_description),
        body.trim_start()
    )
}

/// 承重数据真相：安全门 create_skill_review_markdown 只扫 markdown 正文里的 gate 词，
/// 不读 safety 枚举。所以当 safety 声明了写文件/覆盖/联网时，必须确保正文 ## 安全边界 段
/// 含有对应的 gate 句（确认/授权/confirm 等），否则确定性地往该段注入对应确认规则。
fn ensure_safety_gates(markdown: &str, safety: Option<&Value>, spec: &Value) -> String {
    let Some(safety) = safety else {
        return markdown.to_string();
    };
    let lang = spec.get("language").and_then(Value::as_str).unwrap_or("zh");
    let network = safety.get("network").and_then(Value::as_str).unwrap_or("no");
    let file_writes = safety
        .get("fileWrites")
        .and_then(Value::as_str)
        .unwrap_or("none");
    let overwrite = safety
        .get("overwrite")
        .and_then(Value::as_str)
        .unwrap_or("never");

    // 收集需要 gate 的规则句：每句同时含「行为触发词 + gate 词」，命中安全门的同行规则。
    let mut required: Vec<&str> = Vec::new();
    if network != "no" {
        required.push(if lang == "en" {
            "Before any external network request, ask for explicit user confirmation."
        } else {
            "联网请求前先取得用户确认授权。"
        });
    }
    if file_writes != "none" {
        required.push(if lang == "en" {
            "Before writing any file, confirm with the user first."
        } else {
            "写入文件前先与用户确认。"
        });
    }
    if overwrite == "confirm_each_time" {
        required.push(if lang == "en" {
            "Before overwriting or deleting anything, ask for explicit confirmation each time."
        } else {
            "覆盖或删除任何内容前，每次都先请求用户确认。"
        });
    }
    if required.is_empty() {
        return markdown.to_string();
    }

    let normalized = markdown.replace("\r\n", "\n");
    let lower = normalized.to_lowercase();
    // 已被安全门视为「已 gate / 已声明禁止」的行为不再注入，避免重复堆叠。
    let gate_terms = [
        "ask",
        "confirm",
        "permission",
        "explicit user",
        "user approval",
        "用户确认",
        "确认",
        "许可",
        "授权",
        "明确同意",
        "先询问",
    ];
    let network_triggers = [
        "curl ",
        "wget ",
        "fetch(",
        "http://",
        "https://",
        "network request",
        "external source",
        "external network",
        "联网",
        "外部网络",
        "网络请求",
    ];
    let write_triggers = [
        "overwrite",
        "delete ",
        "delete.",
        "rm -r",
        "cp -f",
        "写入文件",
        "修改文件",
        "覆盖",
        "删除",
    ];
    let mut missing: Vec<&str> = Vec::new();
    for rule in &required {
        let rule_lower = rule.to_lowercase();
        let is_network = create_skill_line_has_any(&rule_lower, &network_triggers);
        let is_write = create_skill_line_has_any(&rule_lower, &write_triggers);
        // 若正文里相应风险已被 gate 或已声明禁止，则不再补这条。
        let already_covered = if is_network {
            !create_skill_has_ungated_line(&lower, &network_triggers, &gate_terms)
                && create_skill_markdown_has_gated_trigger(&lower, &network_triggers, &gate_terms)
        } else if is_write {
            !create_skill_has_ungated_line(&lower, &write_triggers, &gate_terms)
                && create_skill_markdown_has_gated_trigger(&lower, &write_triggers, &gate_terms)
        } else {
            false
        };
        if !already_covered {
            missing.push(rule);
        }
    }
    if missing.is_empty() {
        return normalized;
    }

    let safety_headings = [
        "## boundaries",
        "## boundary",
        "## safety",
        "## guardrails",
        "## constraints",
        "## non-goals",
        "## 安全边界",
        "## 边界",
        "## 约束",
    ];
    let bullet_block = missing
        .iter()
        .map(|rule| format!("- {rule}"))
        .collect::<Vec<_>>()
        .join("\n");
    let lines: Vec<&str> = normalized.lines().collect();
    let heading_idx = lines.iter().position(|line| {
        let trimmed = line.trim().to_lowercase();
        safety_headings.iter().any(|h| trimmed.starts_with(h))
    });

    match heading_idx {
        Some(idx) => {
            // 找到该段末尾（下一个 ## 标题前），在那里追加 gate bullet。
            let mut insert_at = lines.len();
            for (offset, line) in lines.iter().enumerate().skip(idx + 1) {
                if line.trim_start().starts_with("## ") {
                    insert_at = offset;
                    break;
                }
            }
            let mut out: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
            out.insert(insert_at, bullet_block);
            // 保证 bullet 与后续 section 之间有空行。
            if insert_at + 1 < out.len() && !out[insert_at + 1].trim().is_empty() {
                out.insert(insert_at + 1, String::new());
            }
            let mut joined = out.join("\n");
            if normalized.ends_with('\n') && !joined.ends_with('\n') {
                joined.push('\n');
            }
            joined
        }
        None => {
            // 没有边界段则新建一个。
            let heading = if lang == "en" {
                "## Boundaries"
            } else {
                "## 安全边界"
            };
            let mut joined = normalized.trim_end().to_string();
            joined.push_str(&format!("\n\n{heading}\n\n{bullet_block}\n"));
            joined
        }
    }
}

/// 正文里是否存在「触发词 + gate 词」同/邻行的已 gate 描述（与安全门检测同语义，正向版）。
fn create_skill_markdown_has_gated_trigger(
    markdown_lower: &str,
    triggers: &[&str],
    gates: &[&str],
) -> bool {
    let lines = markdown_lower.lines().collect::<Vec<_>>();
    for (idx, line) in lines.iter().enumerate() {
        if !create_skill_line_has_any(line, triggers) {
            continue;
        }
        if create_skill_line_has_gate(line, gates)
            || (idx > 0 && create_skill_line_has_gate(lines[idx - 1], gates))
        {
            return true;
        }
    }
    false
}

fn frontmatter_scalar(frontmatter: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    frontmatter.lines().find_map(|line| {
        let line = line.trim();
        line.strip_prefix(&prefix).map(|value| {
            value
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_string()
        })
    })
}

fn contains_cjk(value: &str) -> bool {
    value
        .chars()
        .any(|ch| ('\u{4e00}'..='\u{9fff}').contains(&ch))
}

#[cfg(test)]
fn list_block(items: &[Value], fallback: &str) -> String {
    let lines = items
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| format!("- {s}"))
        .collect::<Vec<_>>();
    if lines.is_empty() {
        format!("- {fallback}")
    } else {
        lines.join("\n")
    }
}

fn is_skill_kebab_name(name: &str) -> bool {
    let len = name.len();
    if len == 0 || len > 64 {
        return false;
    }
    let mut previous_hyphen = false;
    for (index, c) in name.chars().enumerate() {
        let allowed = c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-';
        if !allowed {
            return false;
        }
        if c == '-' {
            if index == 0 || previous_hyphen {
                return false;
            }
            previous_hyphen = true;
        } else {
            previous_hyphen = false;
        }
    }
    !previous_hyphen
}

fn create_skill_name_too_generic(value: &str) -> bool {
    matches!(
        value.trim().to_lowercase().as_str(),
        "agent" | "skill" | "new-skill" | "my-skill" | "assistant" | "workflow"
    )
}

fn create_skill_description_needs_repair(language: &str, description: &str) -> bool {
    !description_trigger_clear(description)
        || (language == "zh" && description.trim().to_lowercase().starts_with("use when"))
}

fn description_trigger_clear(description: &str) -> bool {
    let trimmed = description.trim();
    if trimmed.len() < 24 || trimmed.len() > 260 {
        return false;
    }
    if trimmed.ends_with(':') || trimmed.ends_with('：') {
        return false;
    }
    let lower = trimmed.to_lowercase();
    let compact = lower.replace(' ', "");
    if compact.starts_with("当用户需要一个可复用的agent工作技能时使用")
        && trimmed.chars().count() < 56
    {
        return false;
    }
    let has_trigger = lower.starts_with("use when")
        || lower.contains(" use when ")
        || trimmed.starts_with("当用户")
        || trimmed.starts_with("用于")
        || trimmed.contains("适用于")
        || trimmed.contains("时使用");
    let too_generic = [
        "needs help with",
        "help with:",
        "general assistant",
        "anything",
        "处理这个需求",
        "通用助手",
    ]
    .iter()
    .any(|needle| lower.contains(needle) || trimmed.contains(needle));
    has_trigger && !too_generic
}

fn create_skill_frontmatter_keys(markdown: &str) -> Vec<String> {
    let normalized = markdown.replace("\r\n", "\n");
    let Some(rest) = normalized.strip_prefix("---\n") else {
        return Vec::new();
    };
    let Some(end) = rest.find("\n---") else {
        return Vec::new();
    };
    rest[..end]
        .lines()
        .filter_map(|line| {
            if line.starts_with(' ') || line.starts_with('\t') {
                return None;
            }
            line.split_once(':')
                .map(|(key, _)| key.trim().to_string())
                .filter(|key| !key.is_empty())
        })
        .collect()
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

fn count_procedural_lines(markdown: &str) -> usize {
    markdown
        .lines()
        .filter(|line| {
            let trimmed = line.trim_start();
            trimmed.starts_with("- ")
                || trimmed.starts_with("* ")
                || trimmed
                    .split_once('.')
                    .is_some_and(|(prefix, _)| prefix.chars().all(|c| c.is_ascii_digit()))
                || trimmed
                    .split_once('、')
                    .is_some_and(|(prefix, _)| prefix.chars().all(|c| c.is_ascii_digit()))
        })
        .count()
}

fn yaml_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn create_skill_review_markdown(markdown: &str, expected_basename: Option<&str>) -> Value {
    let mut blocking = Vec::new();
    let mut warnings = Vec::new();
    let size_under_limit = markdown.len() <= 1024 * 1024;
    if !size_under_limit {
        blocking.push(json!({"code": "TOO_LARGE", "message": "SKILL.md must stay under 1MB."}));
    }
    let parsed_result = scanner::parser::parse_skill_markdown(markdown);
    let parseable = parsed_result.is_ok();
    let mut safe_name = false;
    let mut trigger_description = false;
    let mut name_matches_basename = expected_basename.is_none();
    let mut name_is_kebab = false;
    match parsed_result {
        Ok(parsed) => {
            safe_name = is_safe_basename(expected_basename.unwrap_or(&parsed.name));
            name_is_kebab = is_skill_kebab_name(&parsed.name);
            if let Some(expected) = expected_basename {
                name_matches_basename = expected == parsed.name;
            }
            if !safe_name {
                blocking.push(
                    json!({"code": "UNSAFE_NAME", "message": "Skill directory name is not safe."}),
                );
            }
            if !name_is_kebab {
                blocking.push(json!({"code": "NAME_NOT_KEBAB_CASE", "message": "Skill name must use lowercase kebab-case, for example pr-review-checklist."}));
            }
            if !name_matches_basename {
                blocking.push(json!({"code": "NAME_BASENAME_MISMATCH", "message": "Frontmatter name must match the selected directory name."}));
            }
            let description = parsed.description.as_deref().unwrap_or("").trim();
            trigger_description = description_trigger_clear(description);
            if description.is_empty() {
                warnings.push(json!({"code": "MISSING_DESCRIPTION", "message": "Add a clear trigger-style description."}));
            }
            if !trigger_description {
                warnings.push(json!({"code": "WEAK_TRIGGER_DESCRIPTION", "message": "Prefer a trigger-style description that says when to use this skill and for what task."}));
            }
        }
        Err(err) => {
            blocking.push(json!({"code": err.code, "message": err.message}));
        }
    }
    let frontmatter_keys = create_skill_frontmatter_keys(markdown);
    let frontmatter_only_name_description = frontmatter_keys
        .iter()
        .all(|key| key == "name" || key == "description");
    if !frontmatter_only_name_description {
        warnings.push(json!({"code": "EXTRA_FRONTMATTER", "message": "Keep generated skills to name and description frontmatter unless compatibility requires more."}));
    }
    let lower = markdown.to_lowercase();
    let has_inputs = contains_any(
        &lower,
        &[
            "## inputs",
            "## input",
            "## materials",
            "## 输入",
            "## 接受的输入",
            "## 接受输入",
            "accepted inputs",
            "输入材料",
        ],
    );
    if !has_inputs {
        warnings.push(json!({"code": "MISSING_INPUTS", "message": "Add an Inputs section so users know what to provide."}));
    }
    let procedural_lines = count_procedural_lines(markdown);
    let has_workflow = procedural_lines >= 2
        || contains_any(
            &lower,
            &[
                "## workflow",
                "## process",
                "## procedure",
                "## steps",
                "## 工作流",
                "## 流程",
                "## 步骤",
                "操作步骤",
            ],
        );
    if !has_workflow {
        warnings.push(json!({"code": "MISSING_EXECUTABLE_WORKFLOW", "message": "Add executable guidance. The structure can be creative, but the agent still needs clear steps or decision rules."}));
    }
    let has_output = contains_any(
        &lower,
        &[
            "## output",
            "## outputs",
            "## deliverable",
            "## result",
            "## 输出",
            "## 产物",
            "交付",
        ],
    );
    if !has_output {
        warnings.push(json!({"code": "MISSING_OUTPUT", "message": "Add the expected output artifact and delivery shape."}));
    }
    let has_boundaries = contains_any(
        &lower,
        &[
            "## boundaries",
            "## boundary",
            "## safety",
            "## guardrails",
            "## constraints",
            "## non-goals",
            "## 安全边界",
            "## 边界",
            "## 约束",
            "不做",
        ],
    );
    if !has_boundaries {
        warnings.push(json!({"code": "MISSING_BOUNDARIES", "message": "Add boundaries for privacy, network, file writes, and unclear constraints."}));
    }
    let has_quality_bar = contains_any(
        &lower,
        &[
            "## quality",
            "## quality bar",
            "## acceptance",
            "## success",
            "## 质量",
            "## 质量标准",
            "## 质量要求",
            "## 验收",
            "验收标准",
        ],
    );
    if !has_quality_bar {
        warnings.push(json!({"code": "MISSING_QUALITY_BAR", "message": "Add quality or acceptance criteria so the generated skill can self-check its output."}));
    }
    let concise_body = markdown.len() <= 12_000;
    if !concise_body {
        warnings.push(json!({"code": "BODY_TOO_LONG", "message": "Keep SKILL.md concise; move detailed background into references when needed."}));
    }
    if [
        "readme",
        "changelog",
        "installation guide",
        "quick reference",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        warnings.push(json!({"code": "EXTRANEOUS_DOCS", "message": "Avoid generating extra docs unless a skill resource is explicitly needed."}));
    }
    let no_private_fields = ![
        "api key",
        "api_key",
        "apikey",
        "secret:",
        "password:",
        "bearer ",
        "private key",
        "access token",
        "token:",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    if !no_private_fields {
        blocking.push(
            json!({"code": "PRIVATE_FIELD", "message": "Remove secrets or secret-shaped fields."}),
        );
    }
    let gate_terms = [
        "ask",
        "confirm",
        "permission",
        "explicit user",
        "user approval",
        "用户确认",
        "确认",
        "许可",
        "授权",
        "明确同意",
        "先询问",
    ];
    // 网络触发词：泛指任何提到网络/URL 的句子（用于 warning 级提示与 ensure_safety_gates）。
    let network_triggers = [
        "curl ",
        "wget ",
        "fetch(",
        "http://",
        "https://",
        "network request",
        "external source",
        "external network",
        "联网",
        "外部网络",
        "网络请求",
    ];
    // 只有「未 gate 且像真实祈使命令」的联网行才 blocking；纯引用 URL/说明句最多 warning。
    let has_ungated_network_command = create_skill_has_ungated_command_line(
        &lower,
        &network_triggers,
        &gate_terms,
        CREATE_SKILL_NETWORK_COMMAND_TOKENS,
    );
    let has_ungated_network_mention =
        create_skill_has_ungated_line(&lower, &network_triggers, &gate_terms);
    let no_silent_network = !has_ungated_network_command;
    if has_ungated_network_command {
        blocking.push(json!({"code": "NETWORK_NEEDS_GATE", "message": "Network use must require explicit user permission."}));
    } else if has_ungated_network_mention {
        warnings.push(json!({"code": "NETWORK_MENTION_UNGATED", "message": "This skill mentions network/URLs without a confirmation gate. If it actually makes requests, add an explicit confirmation step."}));
    }
    // 写入/删除触发词：泛指任何提到写入/覆盖/删除的句子。
    let write_triggers = [
        "overwrite",
        "delete ",
        "delete.",
        "rm -r",
        "cp -f",
        "写入文件",
        "修改文件",
        "覆盖",
        "删除",
    ];
    // 只有「未 gate 且像真实破坏性命令」的写入行才 blocking；讲"不要覆盖"之类说明句最多 warning。
    let has_ungated_write_command = create_skill_has_ungated_command_line(
        &lower,
        &write_triggers,
        &gate_terms,
        CREATE_SKILL_WRITE_COMMAND_TOKENS,
    );
    let has_ungated_write_mention =
        create_skill_has_ungated_line(&lower, &write_triggers, &gate_terms);
    let no_silent_overwrite = !has_ungated_write_command;
    if has_ungated_write_command {
        blocking.push(json!({"code": "WRITE_NEEDS_GATE", "message": "Destructive writes must require confirmation."}));
    } else if has_ungated_write_mention {
        warnings.push(json!({"code": "WRITE_MENTION_UNGATED", "message": "This skill mentions writes/overwrite/delete without a confirmation gate. If it actually modifies files, add an explicit confirmation step."}));
    }
    let no_dangerous_shell = !["rm -rf", "sudo ", "chmod 777"]
        .iter()
        .any(|needle| lower.contains(needle));
    if !no_dangerous_shell {
        blocking.push(
            json!({"code": "DANGEROUS_SHELL", "message": "Remove dangerous shell defaults."}),
        );
    }
    json!({
        "blocking": blocking,
        "warnings": warnings,
        "checks": {
            "safeName": safe_name,
            "parseableFrontmatter": parseable,
            "sizeUnderLimit": size_under_limit,
            "triggerDescription": trigger_description,
            "hasInputs": has_inputs,
            "hasWorkflow": has_workflow,
            "hasOutput": has_output,
            "hasBoundaries": has_boundaries,
            "hasQualityBar": has_quality_bar,
            "conciseBody": concise_body,
            "frontmatterOnlyNameDescription": frontmatter_only_name_description,
            "nameMatchesBasename": name_matches_basename,
            "nameIsKebabCase": name_is_kebab,
            "noPrivateFields": no_private_fields,
            "noSilentNetwork": no_silent_network,
            "noSilentOverwrite": no_silent_overwrite,
            "noSecretExfiltration": no_private_fields,
            "noDangerousShellDefault": no_dangerous_shell
        }
    })
}

/// 可安装性只看 blocking：质量类 warning（缺 Inputs/Output 段等）仍可安装，
/// 仅作非阻塞提示展示。前端 plan/安装按钮的 disabled 条件需与此保持一致。
fn create_skill_review_is_installable(review: &Value) -> bool {
    review
        .get("blocking")
        .and_then(Value::as_array)
        .is_some_and(|items| items.is_empty())
}

fn create_skill_line_has_any(line: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| line.contains(needle))
}

fn create_skill_line_has_gate(line: &str, gates: &[&str]) -> bool {
    if [
        "without ask",
        "without asking",
        "without confirm",
        "without confirmation",
        "without permission",
        "不询问",
        "不确认",
        "无需确认",
        "不经确认",
    ]
    .iter()
    .any(|needle| line.contains(needle))
    {
        return false;
    }
    create_skill_line_has_any(line, gates)
}

fn create_skill_line_denies_risky_action(line: &str) -> bool {
    [
        "do not access",
        "does not access",
        "never access",
        "no external network",
        "no network",
        "do not use external",
        "do not call external",
        "不访问",
        "不使用外部",
        "不联网",
        "不调用外部",
        "不主动调用外部",
        "不发送",
        "不得发送",
        "不得发起",
        "不得调用外部",
        "不删除",
        "不删除任何",
        "不覆盖",
        "不写入",
        "不读取或写入",
        "不修改文件",
        "不得保存或修改",
    ]
    .iter()
    .any(|needle| line.contains(needle))
}

fn create_skill_has_ungated_line(markdown_lower: &str, triggers: &[&str], gates: &[&str]) -> bool {
    let lines = markdown_lower.lines().collect::<Vec<_>>();
    for (idx, line) in lines.iter().enumerate() {
        if !create_skill_line_has_any(line, triggers) {
            continue;
        }
        if create_skill_line_denies_risky_action(line) {
            continue;
        }
        let gated_here = create_skill_line_has_gate(line, gates);
        let gated_before = idx > 0 && create_skill_line_has_gate(lines[idx - 1], gates);
        if !gated_here && !gated_before {
            return true;
        }
    }
    false
}

/// 真实可执行祈使命令标记：一行只有同时命中触发词「且」含这些可执行动作 token 时，
/// 才算「真的会跑」的命令——纯引用 URL、讲"不要覆盖"之类的说明句不在此列。
/// 联网类：curl/wget/fetch( 等会发起请求的调用。
const CREATE_SKILL_NETWORK_COMMAND_TOKENS: &[&str] = &[
    "curl ",
    "wget ",
    "fetch(",
    "http.get",
    "http.post",
    "requests.get",
    "requests.post",
    "urllib",
    "axios",
];
/// 写入/破坏类：会真正删/覆盖文件的命令调用。
const CREATE_SKILL_WRITE_COMMAND_TOKENS: &[&str] = &[
    "rm -r",
    "rm -f",
    "cp -f",
    "mv -f",
    "truncate ",
    "unlink",
    "shutil.rmtree",
    "os.remove",
    "fs.rm",
    "fs.unlink",
];
/// 通用危险 shell 动作：无论网络还是写入，出现即视为可执行命令。
const CREATE_SKILL_DANGEROUS_COMMAND_TOKENS: &[&str] = &["rm -rf", "sudo ", "chmod ", "chown "];

/// 该行是否像一条会真正执行的命令（含可执行动作 token）。
fn create_skill_line_is_command(line: &str, command_tokens: &[&str]) -> bool {
    create_skill_line_has_any(line, command_tokens)
        || create_skill_line_has_any(line, CREATE_SKILL_DANGEROUS_COMMAND_TOKENS)
}

/// 是否存在「未 gate 且像真实命令」的触发行——只有这种才升级为 blocking。
/// 与 create_skill_has_ungated_line 同样保留 gate 词豁免（同行/上一行）和否定句豁免，
/// 只是额外要求该行确实是可执行命令，把"仅仅提及"降级出 blocking 范围。
fn create_skill_has_ungated_command_line(
    markdown_lower: &str,
    triggers: &[&str],
    gates: &[&str],
    command_tokens: &[&str],
) -> bool {
    let lines = markdown_lower.lines().collect::<Vec<_>>();
    for (idx, line) in lines.iter().enumerate() {
        if !create_skill_line_has_any(line, triggers) {
            continue;
        }
        if !create_skill_line_is_command(line, command_tokens) {
            continue;
        }
        if create_skill_line_denies_risky_action(line) {
            continue;
        }
        let gated_here = create_skill_line_has_gate(line, gates);
        let gated_before = idx > 0 && create_skill_line_has_gate(lines[idx - 1], gates);
        if !gated_here && !gated_before {
            return true;
        }
    }
    false
}

fn create_skill_plan_from_staging(
    state: &State<'_, AppState>,
    db: &Connection,
    staging_dir: &Path,
    skill_name: &str,
    source_hash: &str,
    draft_id: &str,
    target_platform_ids: &[String],
) -> AppResult<Value> {
    let platforms = sync_platforms(db)?;
    let enabled_ids = platforms.iter().map(|p| p.id.clone()).collect::<Vec<_>>();
    let canonical = canonical_platform(db, &enabled_ids)?;
    let canonical_platform = platforms
        .iter()
        .find(|p| p.id == canonical)
        .ok_or_else(|| AppError::new("INVALID_STATE", "canonical platform missing"))?;
    let op_group_id = Uuid::new_v4().to_string();
    let placeholder_skill_id = format!("pending:create-skill:{draft_id}");
    let skill = SyncSkillRow {
        id: placeholder_skill_id,
        name: skill_name.to_string(),
    };
    let staging = LocRow {
        id: -1,
        skill_id: skill.id.clone(),
        platform_id: "staging".to_string(),
        install_path: staging_dir.to_string_lossy().to_string(),
        real_path: staging_dir.to_string_lossy().to_string(),
        is_symlink: false,
        is_broken_link: false,
        is_disabled: false,
        content_hash: Some(source_hash.to_string()),
        mtime: None,
    };
    let mut items = Vec::new();
    if has_symlink_in_tree(staging_dir)? {
        items.push(sync_placeholder(
            &skill,
            "staging",
            &canonical,
            "conflict",
            "source_has_symlink",
            &op_group_id,
        ));
    } else {
        let mut copy_item = build_sync_item(SyncBuildItemArgs {
            skill: &skill,
            source: Some(&staging),
            target: None,
            source_platform_id: "staging",
            target_platform_id: &canonical,
            target_platform_dir: &canonical_platform.skills_dir,
            op_group_id: &op_group_id,
            override_action: Some("copy_to_canonical"),
        });
        let canonical_target = copy_item
            .get("targetPath")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_default();
        if path_exists_lstat(Path::new(&canonical_target)) {
            copy_item["action"] = json!("conflict");
            copy_item["reason"] = json!("target_exists_dir");
        }
        copy_item["installedFromSource"] = json!("create-skill");
        copy_item["installedFromSkillId"] = json!(draft_id);
        items.push(copy_item);
        let target_basename = Path::new(staging_dir)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(skill_name)
            .to_string();
        let can_symlink = items
            .first()
            .and_then(|item| item.get("action"))
            .and_then(Value::as_str)
            == Some("copy_to_canonical");
        if can_symlink {
            for target_id in target_platform_ids {
                if target_id == &canonical {
                    continue;
                }
                let Some(platform) = platforms.iter().find(|p| p.id == *target_id) else {
                    continue;
                };
                let target_path = PathBuf::from(&platform.skills_dir).join(&target_basename);
                let (action, reason) =
                    if !target_inside_platform(&target_path, &platform.skills_dir) {
                        ("conflict", Some("target_outside_root"))
                    } else if has_case_collision(&platform.skills_dir, &target_basename) {
                        ("conflict", Some("case_collision"))
                    } else if path_exists_lstat(&target_path) {
                        ("conflict", Some("target_exists_dir"))
                    } else {
                        ("symlink_create", None)
                    };
                items.push(json!({
                    "skillName": skill_name,
                    "skillId": skill.id.clone(),
                    "opGroupId": op_group_id.clone(),
                    "targetBasename": target_basename.clone(),
                    "sourcePlatformId": canonical,
                    "sourceLocationId": -1,
                    "sourceRealPath": canonical_target.clone(),
                    "sourceDev": 0,
                    "sourceIno": 0,
                    "sourceHash": source_hash,
                    "targetPlatformId": target_id,
                    "targetPath": target_path.to_string_lossy(),
                    "targetHash": Value::Null,
                    "mode": "symlink",
                    "action": action,
                    "reason": reason,
                    "installedFromSource": "create-skill",
                    "installedFromSkillId": draft_id,
                }));
            }
        }
    }
    let mut plan = finalize_sync_plan("create_skill", items);
    plan["draftId"] = json!(draft_id);
    store_plan(state, &plan)?;
    Ok(plan)
}

fn create_skill_find_installed_skill(db: &Connection, plan: &Value) -> AppResult<Option<String>> {
    let Some(items) = plan.get("items").and_then(Value::as_array) else {
        return Ok(None);
    };
    for item in items {
        if item.get("action").and_then(Value::as_str) != Some("copy_to_canonical") {
            continue;
        }
        let Some(platform_id) = item.get("targetPlatformId").and_then(Value::as_str) else {
            continue;
        };
        let Some(target_path) = item.get("targetPath").and_then(Value::as_str) else {
            continue;
        };
        let found = db
            .query_row(
                "SELECT skill_id FROM skill_locations WHERE platform_id = ?1 AND install_path = ?2",
                params![platform_id, target_path],
                |r| r.get::<_, String>(0),
            )
            .optional()?;
        if found.is_some() {
            return Ok(found);
        }
    }
    Ok(None)
}

fn slugify_skill_name(input: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for c in input.to_lowercase().chars() {
        let mapped = if c.is_ascii_alphanumeric() {
            Some(c)
        } else if c.is_whitespace() || c == '-' || c == '_' {
            Some('-')
        } else {
            None
        };
        if let Some(ch) = mapped {
            if ch == '-' {
                if !last_dash && !out.is_empty() {
                    out.push('-');
                    last_dash = true;
                }
            } else {
                out.push(ch);
                last_dash = false;
            }
        }
        if out.len() >= 48 {
            break;
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() {
        format!(
            "skill-{}",
            Uuid::new_v4()
                .to_string()
                .chars()
                .take(8)
                .collect::<String>()
        )
    } else {
        out
    }
}

fn json_string(value: &Value) -> AppResult<String> {
    serde_json::to_string(value).map_err(|err| AppError::new("SERIALIZE_FAILED", err.to_string()))
}

fn parse_json_text(text: &str, fallback: Value) -> Value {
    serde_json::from_str(text).unwrap_or(fallback)
}

fn parse_json_opt(text: Option<String>) -> Value {
    text.and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub fn ai_get_suggestions_for_skill(
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> AppResult<Value> {
    let skill_id = required_str(&payload, "skillId")?;
    let db = conn(&state)?;
    let mut stmt = db.prepare(
        "SELECT a.id, a.skill_id, a.scenario_key, a.reason, a.suggested_at, sc.name, sc.color
         FROM ai_scenario_suggestions a
         LEFT JOIN scenarios sc ON sc.key = a.scenario_key
         WHERE a.skill_id = ?1
           AND a.accepted_at IS NULL
           AND a.dismissed_at IS NULL
         ORDER BY a.suggested_at DESC, a.id DESC",
    )?;
    let rows = stmt.query_map(params![skill_id], |r| {
        Ok(json!({
            "id": r.get::<_, i64>(0)?,
            "skillId": r.get::<_, String>(1)?,
            "scenarioKey": r.get::<_, String>(2)?,
            "reason": r.get::<_, Option<String>>(3)?,
            "suggestedAt": r.get::<_, i64>(4)?,
            "scenarioName": r.get::<_, Option<String>>(5)?,
            "scenarioColor": r.get::<_, Option<String>>(6)?,
        }))
    })?;
    Ok(Value::Array(rows.collect::<Result<Vec<_>, _>>()?))
}
#[tauri::command]
pub fn ai_accept_suggestion(
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> AppResult<Value> {
    let suggestion_id = optional_i64(&payload, "suggestionId")
        .ok_or_else(|| AppError::new("INVALID_INPUT", "suggestionId required"))?;
    let mut db = conn(&state)?;
    let row: Option<SuggestionActionRow> = db
        .query_row(
            "SELECT id, skill_id, scenario_key, accepted_at, dismissed_at
             FROM ai_scenario_suggestions WHERE id = ?1",
            params![suggestion_id],
            |r| {
                Ok(SuggestionActionRow {
                    id: r.get(0)?,
                    skill_id: r.get(1)?,
                    scenario_key: r.get(2)?,
                    accepted_at: r.get(3)?,
                    dismissed_at: r.get(4)?,
                })
            },
        )
        .optional()?;
    let Some(row) = row else {
        return Err(AppError::new(
            "NOT_FOUND",
            format!("suggestion {suggestion_id}"),
        ));
    };
    if row.accepted_at.is_some() {
        return Ok(ok());
    }
    if row.dismissed_at.is_some() {
        return Err(AppError::new("CONFLICT", "suggestion already dismissed"));
    }
    let scenario_id: Option<i64> = db
        .query_row(
            "SELECT id FROM scenarios WHERE key = ?1",
            params![row.scenario_key],
            |r| r.get(0),
        )
        .optional()?;
    let Some(scenario_id) = scenario_id else {
        db.execute(
            "UPDATE ai_scenario_suggestions SET dismissed_at = ?1 WHERE id = ?2",
            params![now_ms(), row.id],
        )?;
        return Err(AppError::new(
            "NOT_FOUND",
            format!("scenario \"{}\" no longer exists", row.scenario_key),
        ));
    };
    let tx = db.transaction()?;
    let now = now_ms();
    tx.execute(
        "INSERT OR IGNORE INTO skill_scenarios (skill_id, scenario_id, added_at) VALUES (?1, ?2, ?3)",
        params![row.skill_id, scenario_id, now],
    )?;
    tx.execute(
        "UPDATE ai_scenario_suggestions SET accepted_at = ?1 WHERE id = ?2",
        params![now, row.id],
    )?;
    tx.commit()?;
    Ok(ok())
}
#[tauri::command]
pub fn ai_dismiss_suggestion(
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> AppResult<Value> {
    let suggestion_id = optional_i64(&payload, "suggestionId")
        .ok_or_else(|| AppError::new("INVALID_INPUT", "suggestionId required"))?;
    let db = conn(&state)?;
    db.execute(
        "UPDATE ai_scenario_suggestions
         SET dismissed_at = ?1
         WHERE id = ?2 AND dismissed_at IS NULL AND accepted_at IS NULL",
        params![now_ms(), suggestion_id],
    )?;
    let exists: Option<i64> = db
        .query_row(
            "SELECT 1 FROM ai_scenario_suggestions WHERE id = ?1",
            params![suggestion_id],
            |r| r.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Err(AppError::new(
            "NOT_FOUND",
            format!("suggestion {suggestion_id}"),
        ));
    }
    Ok(ok())
}
#[tauri::command]
pub fn ai_queue_status(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let _ = payload;
    maybe_start_ai_worker(&state);
    let pending = state.ai_queue.lock().map(|q| q.len()).unwrap_or(0);
    Ok(json!({
        "pending": pending,
        "schedulerRunning": state.ai_worker_running.load(Ordering::SeqCst)
    }))
}

fn scan_added_skill_ids(scan: &Value) -> Vec<String> {
    scan.get("addedSkillIds")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn enqueue_ai_suggestions(state: &State<'_, AppState>, skill_ids: Vec<String>) {
    if skill_ids.is_empty() {
        return;
    }
    if let Ok(mut queue) = state.ai_queue.lock() {
        for skill_id in skill_ids {
            if !queue.iter().any(|queued| queued == &skill_id) {
                queue.push_back(skill_id);
            }
        }
    }
    maybe_start_ai_worker(state);
}

fn maybe_start_ai_worker(state: &State<'_, AppState>) {
    let has_pending = state
        .ai_queue
        .lock()
        .map(|queue| !queue.is_empty())
        .unwrap_or(false);
    if !has_pending {
        return;
    }
    if state
        .ai_worker_running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    let db = state.db.clone();
    let paths = state.paths.clone();
    let queue = state.ai_queue.clone();
    let running = state.ai_worker_running.clone();
    std::thread::spawn(move || {
        ai_queue_worker(db, paths, queue, running);
    });
}

fn ai_queue_worker(
    db: r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
    paths: AppPaths,
    queue: std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<String>>>,
    running: std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    loop {
        let Ok(conn) = db.get() else {
            break;
        };
        match ai_queue_can_process(&conn, &paths) {
            Ok(AiQueueDecision::Ready) => {}
            Ok(AiQueueDecision::DrainNoScenarios) => {
                if let Ok(mut queue) = queue.lock() {
                    queue.clear();
                }
                break;
            }
            Ok(AiQueueDecision::Wait) | Err(_) => break,
        }
        let batch = {
            let Ok(mut queue) = queue.lock() else {
                break;
            };
            let mut batch = Vec::new();
            while batch.len() < 5 {
                let Some(skill_id) = queue.pop_front() else {
                    break;
                };
                batch.push(skill_id);
            }
            batch
        };
        if batch.is_empty() {
            break;
        }
        if ai_process_suggestion_batch(&conn, &paths, &batch).is_err() {
            break;
        }
        std::thread::sleep(Duration::from_millis(ai_queue_interval_ms(&conn)));
    }
    running.store(false, Ordering::SeqCst);
}

enum AiQueueDecision {
    Ready,
    Wait,
    DrainNoScenarios,
}

fn ai_queue_can_process(db: &Connection, paths: &AppPaths) -> AppResult<AiQueueDecision> {
    if get_setting(db, "llm.feature.autoCategorize")?.as_deref() != Some("1") {
        return Ok(AiQueueDecision::Wait);
    }
    if get_setting(db, "allow_external_network")?.as_deref() != Some("1") {
        return Ok(AiQueueDecision::Wait);
    }
    let config = llm_read_config(db)?;
    if config.model.trim().is_empty() {
        return Ok(AiQueueDecision::Wait);
    }
    let api_key = llm_read_api_key(db, paths)?;
    if api_key.is_none() && config.provider != "ollama" {
        return Ok(AiQueueDecision::Wait);
    }
    let scenario_count: i64 = db.query_row("SELECT COUNT(*) FROM scenarios", [], |r| r.get(0))?;
    if scenario_count == 0 {
        return Ok(AiQueueDecision::DrainNoScenarios);
    }
    Ok(AiQueueDecision::Ready)
}

fn ai_queue_interval_ms(db: &Connection) -> u64 {
    get_setting(db, "ai.categorize.minIntervalMs")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|v| *v >= 1_000)
        .unwrap_or(10_000)
}

fn ai_process_suggestion_batch(
    db: &Connection,
    paths: &AppPaths,
    skill_ids: &[String],
) -> AppResult<()> {
    let config = llm_read_config(db)?;
    let api_key = llm_read_api_key(db, paths)?;
    let scenarios = ai_bulk_read_scenarios(db)?;
    if scenarios.is_empty() {
        return Ok(());
    }
    let skills = ai_bulk_read_skills(db, skill_ids)?;
    if skills.is_empty() {
        return Ok(());
    }
    let (system, user) = ai_suggestion_prompt(&scenarios, &skills);
    let response = llm_chat_with_config(
        &config,
        api_key.as_deref(),
        &json!({
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user }
            ],
            "temperature": 0.2,
            "jsonMode": true,
            "maxTokens": 4096
        }),
    )?;
    let parsed =
        ai_suggestion_parse_response(response.get("text").and_then(Value::as_str).unwrap_or(""));
    let valid_keys = scenarios
        .iter()
        .map(|scenario| scenario.key.clone())
        .collect::<std::collections::HashSet<_>>();
    let known_skill_ids = skills
        .iter()
        .map(|skill| skill.id.clone())
        .collect::<std::collections::HashSet<_>>();
    let now = now_ms();
    for result in parsed {
        let skill_id = result.get("skillId").and_then(Value::as_str).unwrap_or("");
        if !known_skill_ids.contains(skill_id) {
            continue;
        }
        let reason = result.get("reason").and_then(Value::as_str);
        for key in result
            .get("scenarios")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .take(3)
        {
            if !valid_keys.contains(key) {
                continue;
            }
            db.execute(
                "INSERT OR IGNORE INTO ai_scenario_suggestions
                   (skill_id, scenario_key, reason, suggested_at, accepted_at, dismissed_at)
                 VALUES (?1, ?2, ?3, ?4, NULL, NULL)",
                params![skill_id, key, reason, now],
            )?;
        }
    }
    Ok(())
}

fn ai_suggestion_prompt(
    scenarios: &[BulkScenarioRow],
    skills: &[BulkSkillRow],
) -> (String, String) {
    let system =
        "You are a skill classifier. For each skill, suggest 0-3 scenarios from the provided list that best match. \
         Echo each skillId exactly as given. Use scenario keys verbatim. \
         Return strict JSON: {\"results\":[{\"skillId\":string,\"scenarios\":[scenarioKey],\"reason\":string}]}";
    let scenario_block = scenarios
        .iter()
        .map(|s| {
            format!(
                "- {}: {} ({})",
                s.key,
                s.name,
                compact_for_prompt(s.description.as_deref().unwrap_or(""), 100)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let skill_block = skills
        .iter()
        .map(|s| {
            format!(
                "- skillId={}, name=\"{}\", description=\"{}\"\nbody excerpt:\n{}\n---",
                s.id,
                s.name,
                compact_for_prompt(s.description.as_deref().unwrap_or(""), 250),
                compact_for_prompt(s.body_excerpt.as_deref().unwrap_or(""), 500)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    (
        system.to_string(),
        format!(
            "Scenarios (use the key before the colon):\n{scenario_block}\n\nSkills:\n{skill_block}"
        ),
    )
}

fn ai_suggestion_parse_response(text: &str) -> Vec<Value> {
    ai_parse_json_object(text)
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn ai_parse_json_object(text: &str) -> Value {
    serde_json::from_str::<Value>(text)
        .or_else(|_| {
            let Some(start) = text.find('{') else {
                return Err(serde_json::Error::io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "no json object",
                )));
            };
            let Some(end) = text.rfind('}') else {
                return Err(serde_json::Error::io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "no json object",
                )));
            };
            serde_json::from_str::<Value>(&text[start..=end])
        })
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn ai_bulk_categorize(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let raw_ids = payload
        .as_ref()
        .and_then(|p| p.get("skillIds"))
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::new("INVALID_INPUT", "skillIds (string[]) required"))?;
    let mut ids = Vec::new();
    for id in raw_ids.iter().filter_map(Value::as_str) {
        if !id.is_empty() && !ids.iter().any(|seen| seen == id) {
            ids.push(id.to_string());
        }
        if ids.len() >= 200 {
            break;
        }
    }
    if ids.is_empty() {
        return Ok(json!({
            "proposedScenarios": [],
            "assignments": [],
            "classifiedCount": 0,
            "skippedCount": 0
        }));
    }
    let db = conn(&state)?;
    require_network(&db)?;
    let config = llm_read_config(&db)?;
    if config.model.trim().is_empty() {
        return Err(AppError::new(
            "LLM_NO_MODEL",
            "No LLM model configured. Set one in Settings -> AI.",
        ));
    }
    let api_key = llm_read_api_key(&db, &state.paths)?;
    if api_key.is_none() && config.provider != "ollama" {
        return Err(AppError::new(
            "LLM_NO_KEY",
            "No LLM API key configured. Set one in Settings -> AI.",
        ));
    }
    let scenarios = ai_bulk_read_scenarios(&db)?;
    let skills = ai_bulk_read_skills(&db, &ids)?;
    if skills.is_empty() {
        return Ok(json!({
            "proposedScenarios": [],
            "assignments": [],
            "classifiedCount": 0,
            "skippedCount": 0
        }));
    }
    let mut all_assignments = Vec::new();
    let mut proposed = std::collections::HashMap::<String, Value>::new();
    let mut intent = String::new();
    for batch in skills.chunks(20) {
        let (system, user) =
            ai_bulk_prompt(&scenarios, proposed.values().cloned().collect(), batch);
        let response = llm_chat_with_config(
            &config,
            api_key.as_deref(),
            &json!({
                "messages": [
                    { "role": "system", "content": system },
                    { "role": "user", "content": user }
                ],
                "temperature": 0.2,
                "jsonMode": true,
                "maxTokens": 4096
            }),
        )?;
        let text = response.get("text").and_then(Value::as_str).unwrap_or("");
        let parsed = ai_bulk_parse_response(text);
        if intent.is_empty() {
            intent = parsed
                .get("intent")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
        }
        let batch_plan = ai_bulk_plan_from_response(&scenarios, batch, &parsed, &mut proposed);
        if let Some(assignments) = batch_plan.as_array() {
            all_assignments.extend(assignments.iter().cloned());
        }
    }
    let useful_proposed = proposed
        .into_values()
        .filter(|scenario| {
            scenario
                .get("usedByCount")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                > 0
        })
        .collect::<Vec<_>>();
    let classified_count = all_assignments
        .iter()
        .filter(|assignment| {
            assignment
                .get("target")
                .and_then(|t| t.get("kind"))
                .and_then(Value::as_str)
                != Some("skip")
        })
        .count();
    let skipped_count = all_assignments.len().saturating_sub(classified_count);
    Ok(json!({
        "intent": if intent.is_empty() { Value::Null } else { Value::String(intent) },
        "proposedScenarios": useful_proposed,
        "assignments": all_assignments,
        "classifiedCount": classified_count,
        "skippedCount": skipped_count
    }))
}
#[tauri::command]
pub fn ai_apply_bulk_categorization(
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> AppResult<Value> {
    let plan = payload
        .as_ref()
        .and_then(|p| p.get("plan"))
        .ok_or_else(|| AppError::new("INVALID_INPUT", "plan required"))?;
    let assignments = plan
        .get("assignments")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::new("INVALID_INPUT", "plan.assignments required"))?;
    let proposed_scenarios = plan
        .get("proposedScenarios")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::new("INVALID_INPUT", "plan.proposedScenarios required"))?;

    let mut used_new_keys = std::collections::HashSet::new();
    for assignment in assignments {
        if assignment.pointer("/target/kind").and_then(Value::as_str) == Some("new") {
            if let Some(key) = assignment
                .pointer("/target/scenarioKey")
                .and_then(Value::as_str)
            {
                used_new_keys.insert(key.to_string());
            }
        }
    }
    let proposed_by_key = proposed_scenarios
        .iter()
        .filter_map(|scenario| Some((scenario.get("key")?.as_str()?.to_string(), scenario)))
        .collect::<std::collections::HashMap<_, _>>();

    let mut db = conn(&state)?;
    let tx = db.transaction()?;
    let now = now_ms();
    let mut next_sort: i64 = tx.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM scenarios",
        [],
        |r| r.get(0),
    )?;
    let mut new_scenarios_created = 0;
    for key in used_new_keys {
        let Some(proposal) = proposed_by_key.get(&key) else {
            continue;
        };
        let name = proposal.get("name").and_then(Value::as_str).unwrap_or(&key);
        let reason = proposal.get("reason").and_then(Value::as_str);
        let color = proposal.get("color").and_then(Value::as_str);
        let changed = tx.execute(
            "INSERT INTO scenarios (key, name, description, color, icon, sort_order, is_builtin, created_at)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5, 0, ?6)
             ON CONFLICT(key) DO NOTHING",
            params![key, name, reason, color, next_sort, now],
        )?;
        if changed > 0 {
            new_scenarios_created += 1;
            next_sort += 1;
        }
    }
    let mut key_to_id = std::collections::HashMap::new();
    {
        let mut stmt = tx.prepare("SELECT id, key FROM scenarios")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (id, key) = row?;
            key_to_id.insert(key, id);
        }
    }
    let mut assignments_applied = 0;
    let mut errors = Vec::new();
    for assignment in assignments {
        let skill_id = assignment
            .get("skillId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if skill_id.is_empty() {
            continue;
        }
        let Some(target) = assignment.get("target") else {
            continue;
        };
        let scenario_id = match target.get("kind").and_then(Value::as_str) {
            Some("skip") | None => continue,
            Some("existing") => target.get("scenarioId").and_then(Value::as_i64),
            Some("new") => target
                .get("scenarioKey")
                .and_then(Value::as_str)
                .and_then(|key| key_to_id.get(key).copied()),
            _ => None,
        };
        let Some(scenario_id) = scenario_id else {
            errors.push(json!({ "skillId": skill_id, "message": "target scenario not found" }));
            continue;
        };
        match tx.execute(
            "INSERT OR IGNORE INTO skill_scenarios (skill_id, scenario_id, added_at)
             VALUES (?1, ?2, ?3)",
            params![skill_id, scenario_id, now],
        ) {
            Ok(changed) => assignments_applied += changed,
            Err(err) => {
                errors.push(json!({ "skillId": skill_id, "message": err.to_string() }));
            }
        }
    }
    tx.commit()?;
    Ok(json!({
        "newScenariosCreated": new_scenarios_created,
        "assignmentsApplied": assignments_applied,
        "errors": errors
    }))
}

#[derive(Clone)]
struct BulkScenarioRow {
    id: i64,
    key: String,
    name: String,
    description: Option<String>,
}

#[derive(Clone)]
struct BulkSkillRow {
    id: String,
    name: String,
    description: Option<String>,
    body_excerpt: Option<String>,
}

fn ai_bulk_read_scenarios(db: &Connection) -> AppResult<Vec<BulkScenarioRow>> {
    let mut stmt =
        db.prepare("SELECT id, key, name, description FROM scenarios ORDER BY sort_order, name")?;
    let rows = stmt.query_map([], |r| {
        Ok(BulkScenarioRow {
            id: r.get(0)?,
            key: r.get(1)?,
            name: r.get(2)?,
            description: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn ai_bulk_read_skills(db: &Connection, ids: &[String]) -> AppResult<Vec<BulkSkillRow>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = std::iter::repeat_n("?", ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT id, name, description, body_excerpt FROM skills WHERE id IN ({placeholders})"
    );
    let bind_values = ids
        .iter()
        .map(|id| SqlValue::Text(id.clone()))
        .collect::<Vec<_>>();
    let mut stmt = db.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(bind_values), |r| {
        Ok(BulkSkillRow {
            id: r.get(0)?,
            name: r.get(1)?,
            description: r.get(2)?,
            body_excerpt: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn ai_bulk_prompt(
    existing: &[BulkScenarioRow],
    proposed_so_far: Vec<Value>,
    batch: &[BulkSkillRow],
) -> (String, String) {
    let system =
        "You categorize a user's AI agent skills into scenarios.\n\
         Reuse existing scenarios when plausible. Propose new lower-kebab-case scenario keys when a real theme does not fit existing scenarios.\n\
         Assign every input skill exactly once; skip only if the skill is unreadable.\n\
         Output only JSON with this exact shape:\n\
         {\"intent\":string,\"proposedScenarios\":[{\"key\":string,\"name\":string,\"reason\":string,\"color\":string}],\"assignments\":[{\"skillId\":string,\"scenarioKey\":string,\"isNew\":boolean,\"why\":string}]}";
    let existing_block = existing
        .iter()
        .map(|s| {
            format!(
                "- key={} name={} description={}",
                s.key,
                s.name,
                compact_for_prompt(s.description.as_deref().unwrap_or(""), 100)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let proposed_block = if proposed_so_far.is_empty() {
        "(none yet)".to_string()
    } else {
        proposed_so_far
            .iter()
            .map(|p| {
                format!(
                    "- key={} name={} reason={}",
                    p.get("key").and_then(Value::as_str).unwrap_or(""),
                    p.get("name").and_then(Value::as_str).unwrap_or(""),
                    compact_for_prompt(p.get("reason").and_then(Value::as_str).unwrap_or(""), 100)
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let skills_block = batch
        .iter()
        .map(|s| {
            format!(
                "- skillId={}\n  name={}\n  description={}\n  body={}",
                s.id,
                s.name,
                compact_for_prompt(s.description.as_deref().unwrap_or(""), 400),
                compact_for_prompt(s.body_excerpt.as_deref().unwrap_or(""), 600)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    (
        system.to_string(),
        format!(
            "existingScenarios:\n{existing_block}\n\nproposedScenarios:\n{proposed_block}\n\nskills:\n{skills_block}"
        ),
    )
}

fn ai_bulk_parse_response(text: &str) -> Value {
    serde_json::from_str::<Value>(text)
        .or_else(|_| {
            let Some(start) = text.find('{') else {
                return Err(serde_json::Error::io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "no json object",
                )));
            };
            let Some(end) = text.rfind('}') else {
                return Err(serde_json::Error::io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "no json object",
                )));
            };
            serde_json::from_str::<Value>(&text[start..=end])
        })
        .unwrap_or_else(|_| json!({ "intent": "", "proposedScenarios": [], "assignments": [] }))
}

fn ai_bulk_plan_from_response(
    scenarios: &[BulkScenarioRow],
    batch: &[BulkSkillRow],
    parsed: &Value,
    proposed: &mut std::collections::HashMap<String, Value>,
) -> Value {
    let existing_by_key = scenarios
        .iter()
        .map(|scenario| (scenario.key.clone(), scenario.clone()))
        .collect::<std::collections::HashMap<_, _>>();
    for scenario in parsed
        .get("proposedScenarios")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let key = normalize_bulk_scenario_key(
            scenario.get("key").and_then(Value::as_str).unwrap_or(""),
            scenario.get("name").and_then(Value::as_str).unwrap_or(""),
        );
        if key.is_empty() || existing_by_key.contains_key(&key) || proposed.contains_key(&key) {
            continue;
        }
        proposed.insert(
            key.clone(),
            json!({
                "key": key,
                "name": scenario.get("name").and_then(Value::as_str).unwrap_or("").trim(),
                "reason": scenario.get("reason").and_then(Value::as_str).unwrap_or("").trim(),
                "color": scenario.get("color").and_then(Value::as_str),
                "usedByCount": 0
            }),
        );
    }
    let batch_by_id = batch
        .iter()
        .map(|skill| (skill.id.clone(), skill.clone()))
        .collect::<std::collections::HashMap<_, _>>();
    let mut assigned = std::collections::HashSet::new();
    let mut assignments = Vec::new();
    for assignment in parsed
        .get("assignments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let skill_id = assignment
            .get("skillId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let Some(skill) = batch_by_id.get(skill_id) else {
            continue;
        };
        if !assigned.insert(skill.id.clone()) {
            continue;
        }
        let scenario_key = assignment
            .get("scenarioKey")
            .and_then(Value::as_str)
            .unwrap_or("");
        let is_new = assignment
            .get("isNew")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let target = if scenario_key.is_empty() {
            json!({ "kind": "skip", "reason": assignment.get("why").and_then(Value::as_str) })
        } else if let Some(existing) = existing_by_key.get(scenario_key).filter(|_| !is_new) {
            json!({ "kind": "existing", "scenarioId": existing.id })
        } else {
            let key = normalize_bulk_scenario_key(scenario_key, scenario_key);
            if !proposed.contains_key(&key) {
                proposed.insert(
                    key.clone(),
                    json!({ "key": key, "name": scenario_key, "reason": "", "usedByCount": 0 }),
                );
            }
            if let Some(row) = proposed.get_mut(&key) {
                let used = row.get("usedByCount").and_then(Value::as_i64).unwrap_or(0) + 1;
                row["usedByCount"] = json!(used);
            }
            json!({ "kind": "new", "scenarioKey": key })
        };
        assignments.push(json!({
            "skillId": skill.id,
            "skillName": skill.name,
            "target": target,
            "why": assignment.get("why").and_then(Value::as_str)
        }));
    }
    for skill in batch {
        if assigned.contains(&skill.id) {
            continue;
        }
        assignments.push(json!({
            "skillId": skill.id,
            "skillName": skill.name,
            "target": { "kind": "skip", "reason": "AI returned no assignment" }
        }));
    }
    Value::Array(assignments)
}

fn normalize_bulk_scenario_key(key: &str, fallback: &str) -> String {
    let source = if key.trim().is_empty() { fallback } else { key };
    slugify(source)
}

#[tauri::command]
pub fn ai_library_overview_get(
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> AppResult<Value> {
    let language = normalize_ai_language(
        payload
            .as_ref()
            .and_then(|p| p.get("language"))
            .and_then(Value::as_str)
            .unwrap_or("en"),
    );
    let db = conn(&state)?;
    let set_hash = current_set_hash(&db)?;
    let row: Option<(String, String, Option<String>)> = db
        .query_row(
            "SELECT set_hash, overview_json, language FROM library_overview WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let overview = row
        .as_ref()
        .and_then(|(_, json, _)| serde_json::from_str::<Value>(json).ok());
    let stale = row
        .map(|(hash, _, row_language)| {
            hash != set_hash || row_language.as_deref() != Some(language)
        })
        .unwrap_or(false);
    Ok(json!({ "overview": overview, "stale": stale, "currentSetHash": set_hash }))
}
#[tauri::command]
pub async fn ai_library_overview_generate(
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> AppResult<Value> {
    let language = normalize_ai_language(
        payload
            .as_ref()
            .and_then(|p| p.get("language"))
            .and_then(Value::as_str)
            .unwrap_or("en"),
    );
    ai_library_overview_generate_inner(&state.db, &state.paths, language)
}

#[tauri::command]
pub fn ai_library_overview_generate_job(
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> AppResult<Value> {
    let language = normalize_ai_language(
        payload
            .as_ref()
            .and_then(|p| p.get("language"))
            .and_then(Value::as_str)
            .unwrap_or("en"),
    )
    .to_string();
    let pool = state.db.clone();
    let paths = state.paths.clone();
    let key = language.clone();
    ai_spawn_job(&state, "library_overview_generate", &key, move || {
        ai_library_overview_generate_inner(&pool, &paths, &language)
    })
}

fn ai_library_overview_generate_inner(
    pool: &r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
    paths: &AppPaths,
    language: &str,
) -> AppResult<Value> {
    let db = pool.get()?;
    require_network(&db)?;
    let config = llm_read_config(&db)?;
    if config.model.trim().is_empty() {
        return Err(AppError::new(
            "LLM_NO_MODEL",
            "No LLM model configured. Set one in Settings -> AI.",
        ));
    }
    let api_key = llm_read_api_key(&db, paths)?;
    if api_key.is_none() && config.provider != "ollama" {
        return Err(AppError::new(
            "LLM_NO_KEY",
            "No LLM API key configured. Set one in Settings -> AI.",
        ));
    }
    let skills = ai_overview_read_skills(&db)?;
    if skills.is_empty() {
        return Err(AppError::new(
            "LIBRARY_EMPTY",
            "No skills in the library to summarize.",
        ));
    }
    let truncated = skills.into_iter().take(100).collect::<Vec<_>>();
    let (system, user) = ai_overview_prompt(&truncated, language);
    let retry_directive = if language == "zh" {
        "Previous attempt returned no usable clusters. Return Chinese user-facing text and group all skills into 3-8 non-empty clusters."
    } else {
        "Previous attempt returned no usable clusters. Group all skills into 3-8 non-empty clusters."
    };
    let mut final_overview = None;
    for attempt in 1..=3 {
        let user_content = if attempt == 1 {
            user.clone()
        } else {
            format!("{retry_directive}\n\n{user}")
        };
        let response = llm_chat_with_config(
            &config,
            api_key.as_deref(),
            &json!({
                "messages": [
                    { "role": "system", "content": system },
                    { "role": "user", "content": user_content }
                ],
                "temperature": 0,
                "jsonMode": true,
                "maxTokens": 32768
            }),
        )?;
        let text = response.get("text").and_then(Value::as_str).unwrap_or("");
        let raw = ai_overview_parse_response(text);
        let overview = ai_overview_post_process(raw, &truncated, language, &config.model);
        if overview
            .get("clusters")
            .and_then(Value::as_array)
            .is_some_and(|clusters| !clusters.is_empty())
        {
            final_overview = Some(overview);
            break;
        }
    }
    let overview = final_overview.ok_or_else(|| {
        AppError::new(
            "LLM_NO_CLUSTERS",
            "The model produced no usable clusters across 3 attempts.",
        )
    })?;
    db.execute(
        "INSERT INTO library_overview (id, set_hash, overview_json, generated_at, model, language)
         VALUES (1, ?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
           set_hash = excluded.set_hash,
           overview_json = excluded.overview_json,
           generated_at = excluded.generated_at,
           model = excluded.model,
           language = excluded.language",
        params![
            ai_overview_set_hash(&truncated),
            serde_json::to_string(&overview)
                .map_err(|err| AppError::new("SERIALIZE_FAILED", err.to_string()))?,
            overview
                .get("generatedAt")
                .and_then(Value::as_i64)
                .unwrap_or_else(now_ms),
            config.model,
            language
        ],
    )?;
    Ok(overview)
}

#[derive(Clone)]
struct OverviewSkillRow {
    id: String,
    name: String,
    description: Option<String>,
    body_excerpt: Option<String>,
    content_hash: String,
}

#[derive(Default)]
struct RawOverviewResponse {
    intro: String,
    clusters: Vec<RawOverviewCluster>,
}

struct RawOverviewCluster {
    name: String,
    purpose: String,
    skills: Vec<RawOverviewSkill>,
}

struct RawOverviewSkill {
    skill_id: String,
    brief: String,
}

fn normalize_ai_language(language: &str) -> &'static str {
    if language == "zh" {
        "zh"
    } else {
        "en"
    }
}

fn ai_overview_read_skills(db: &Connection) -> AppResult<Vec<OverviewSkillRow>> {
    let mut stmt = db.prepare(
        "SELECT id, name, description, body_excerpt, content_hash
         FROM skills
         ORDER BY name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(OverviewSkillRow {
            id: r.get(0)?,
            name: r.get(1)?,
            description: r.get(2)?,
            body_excerpt: r.get(3)?,
            content_hash: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn ai_overview_prompt(skills: &[OverviewSkillRow], language: &str) -> (String, String) {
    let language_rule = if language == "zh" {
        "All user-facing text must be written in Chinese."
    } else {
        "All user-facing text must be written in English."
    };
    let system = format!(
        "You are a librarian creating a navigable library map for a user's AI agent skills.\n\
         Group the complete library into 3-8 use-case or domain clusters, not technology buckets.\n\
         Write a 1-2 sentence intro, a 1-2 sentence purpose for each cluster, and one brief label for each skill.\n\
         Every input skill must appear exactly once. Never invent skillId values.\n\
         {language_rule}\n\
         Output only JSON with this exact shape:\n\
         {{\"intro\":string,\"clusters\":[{{\"name\":string,\"purpose\":string,\"skills\":[{{\"skillId\":string,\"brief\":string}}]}}]}}"
    );
    let skills_block = skills
        .iter()
        .map(|s| {
            format!(
                "- skillId={}\n  name={}\n  description={}\n  body={}",
                s.id,
                compact_for_prompt(&s.name, 60),
                compact_for_prompt(s.description.as_deref().unwrap_or(""), 250),
                compact_for_prompt(s.body_excerpt.as_deref().unwrap_or(""), 300)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    (
        system,
        format!("Total skills: {}\n\nskills:\n{skills_block}", skills.len()),
    )
}

fn compact_for_prompt(input: &str, max_chars: usize) -> String {
    let compacted = input.split_whitespace().collect::<Vec<_>>().join(" ");
    compacted.chars().take(max_chars).collect()
}

fn ai_overview_parse_response(text: &str) -> RawOverviewResponse {
    let parsed = serde_json::from_str::<Value>(text)
        .or_else(|_| {
            let Some(start) = text.find('{') else {
                return Err(serde_json::Error::io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "no json object",
                )));
            };
            let Some(end) = text.rfind('}') else {
                return Err(serde_json::Error::io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "no json object",
                )));
            };
            serde_json::from_str::<Value>(&text[start..=end])
        })
        .unwrap_or(Value::Null);
    let Some(obj) = parsed.as_object() else {
        return RawOverviewResponse::default();
    };
    let intro = obj
        .get("intro")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let clusters = obj
        .get("clusters")
        .and_then(Value::as_array)
        .map(|clusters| {
            clusters
                .iter()
                .filter_map(|cluster| {
                    let c = cluster.as_object()?;
                    let name = c.get("name").and_then(Value::as_str).unwrap_or("").trim();
                    if name.is_empty() {
                        return None;
                    }
                    let skills = c
                        .get("skills")
                        .and_then(Value::as_array)
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(|item| {
                                    let item = item.as_object()?;
                                    let skill_id = item
                                        .get("skillId")
                                        .and_then(Value::as_str)
                                        .unwrap_or("")
                                        .trim();
                                    if skill_id.is_empty() {
                                        return None;
                                    }
                                    Some(RawOverviewSkill {
                                        skill_id: skill_id.to_string(),
                                        brief: item
                                            .get("brief")
                                            .and_then(Value::as_str)
                                            .unwrap_or("")
                                            .to_string(),
                                    })
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    Some(RawOverviewCluster {
                        name: name.to_string(),
                        purpose: c
                            .get("purpose")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .trim()
                            .to_string(),
                        skills,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    RawOverviewResponse { intro, clusters }
}

fn ai_overview_post_process(
    raw: RawOverviewResponse,
    input_skills: &[OverviewSkillRow],
    language: &str,
    model: &str,
) -> Value {
    let by_id = input_skills
        .iter()
        .map(|s| (s.id.clone(), s.clone()))
        .collect::<std::collections::HashMap<_, _>>();
    let by_name = input_skills
        .iter()
        .map(|s| (s.name.to_lowercase(), s.clone()))
        .collect::<std::collections::HashMap<_, _>>();
    let mut seen = std::collections::HashSet::new();
    let mut used_cluster_keys = std::collections::HashSet::new();
    let mut clusters = Vec::new();

    for raw_cluster in raw.clusters {
        let mut skills = Vec::new();
        for raw_skill in raw_cluster.skills {
            let input = by_id
                .get(&raw_skill.skill_id)
                .or_else(|| by_name.get(&raw_skill.skill_id.to_lowercase()));
            let Some(input) = input else {
                continue;
            };
            if !seen.insert(input.id.clone()) {
                continue;
            }
            skills.push(json!({
                "skillId": input.id,
                "name": input.name,
                "brief": trim_ai_brief(&raw_skill.brief, &input.name)
            }));
        }
        if skills.is_empty() {
            continue;
        }
        let base_key = {
            let key = slugify(&raw_cluster.name);
            if key.is_empty() {
                "cluster".to_string()
            } else {
                key
            }
        };
        let mut key = base_key.clone();
        let mut suffix = 2;
        while used_cluster_keys.contains(&key) {
            key = format!("{base_key}-{suffix}");
            suffix += 1;
        }
        used_cluster_keys.insert(key.clone());
        clusters.push(json!({
            "key": key,
            "name": raw_cluster.name,
            "purpose": raw_cluster.purpose,
            "skills": skills
        }));
    }

    let uncategorized = input_skills
        .iter()
        .filter(|skill| !seen.contains(&skill.id))
        .map(|skill| {
            json!({
                "skillId": skill.id,
                "name": skill.name,
                "brief": ""
            })
        })
        .collect::<Vec<_>>();
    json!({
        "intro": raw.intro.trim(),
        "clusters": clusters,
        "uncategorized": uncategorized,
        "totalSkills": input_skills.len(),
        "generatedAt": now_ms(),
        "model": model,
        "language": language
    })
}

fn trim_ai_brief(brief: &str, fallback: &str) -> String {
    let cleaned = brief.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() {
        return fallback.to_string();
    }
    if cleaned.chars().count() <= 30 {
        return cleaned;
    }
    let mut value = cleaned.chars().take(28).collect::<String>();
    value.push_str("...");
    value
}

fn ai_overview_set_hash(rows: &[OverviewSkillRow]) -> String {
    let mut sorted = rows.to_vec();
    sorted.sort_by(|a, b| a.id.cmp(&b.id));
    let mut joined = String::new();
    for row in sorted {
        joined.push_str(&row.id);
        joined.push('|');
        joined.push_str(&row.content_hash);
        joined.push('\n');
    }
    hex::encode(sha2::Sha256::digest(joined.as_bytes()))
}

fn platform_json(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "label": row.get::<_, String>(1)?,
        "skillsDir": row.get::<_, String>(2)?,
        "isBuiltin": row.get::<_, i64>(3)? != 0,
        "enabled": row.get::<_, i64>(4)? != 0,
        "sortOrder": row.get::<_, i64>(5)?,
    }))
}

fn expand_home(path: &str) -> String {
    if path == "~" {
        dirs::home_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
    } else if let Some(rest) = path.strip_prefix("~/") {
        dirs::home_dir()
            .unwrap_or_default()
            .join(rest)
            .to_string_lossy()
            .to_string()
    } else {
        path.to_string()
    }
}

fn valid_platform_id(id: &str) -> bool {
    let len = id.len();
    len > 0
        && len <= 64
        && id.chars().enumerate().all(|(i, c)| {
            if i == 0 {
                c.is_ascii_lowercase() || c.is_ascii_digit()
            } else {
                c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-'
            }
        })
}

fn valid_scenario_key(key: &str) -> bool {
    let mut chars = key.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_alphanumeric()
        && key.chars().count() <= 64
        && chars.all(|c| c.is_alphanumeric() || c == '-' || c == '_')
}

fn slugify(input: &str) -> String {
    let mut out = String::new();
    let mut previous_was_dash = false;
    for c in input.trim().to_lowercase().chars() {
        if c.is_whitespace() || c == '/' || c == '\\' {
            if !previous_was_dash {
                out.push('-');
                previous_was_dash = true;
            }
        } else {
            out.push(c);
            previous_was_dash = false;
        }
    }
    out.trim_matches(['-', '_']).chars().take(64).collect()
}

fn cell_state_for(
    loc: &LocRow,
    real_path_owner: &std::collections::HashMap<String, String>,
    canonical: &str,
    canonical_real_path: Option<&str>,
) -> &'static str {
    if loc.is_broken_link {
        "broken"
    } else if loc.is_disabled {
        "disabled"
    } else if !loc.is_symlink {
        "present"
    } else if loc.platform_id == canonical
        || canonical_real_path == Some(loc.real_path.as_str())
        || real_path_owner
            .get(&loc.real_path)
            .is_some_and(|owner| owner == canonical)
    {
        "symlink"
    } else {
        "symlink_other"
    }
}

fn drift_for(
    loc: &LocRow,
    state: &str,
    canonical: &str,
    canonical_hash: Option<&str>,
    canonical_real_path: Option<&str>,
    has_canonical_source: bool,
) -> &'static str {
    if loc.platform_id == canonical {
        "in_sync"
    } else if !has_canonical_source {
        "only_here"
    } else if state == "symlink"
        || (loc.is_symlink && canonical_real_path == Some(loc.real_path.as_str()))
    {
        "in_sync"
    } else if state == "present" {
        if canonical_hash.is_some()
            && loc.content_hash.as_deref().is_some()
            && canonical_hash != loc.content_hash.as_deref()
        {
            "stale"
        } else {
            "in_sync"
        }
    } else if state == "symlink_other" || state == "broken" {
        "stale"
    } else {
        "in_sync"
    }
}

fn load_skills(db: &Connection, ids: &[String]) -> AppResult<Value> {
    let mut out = Vec::new();
    for id in ids {
        let skill: Option<Value> = db
            .query_row(
                "SELECT id, name, source_key, description, version, author, license, body_excerpt, content_hash, size_bytes, file_count, created_at, updated_at, last_scanned_at FROM skills WHERE id = ?1",
                params![id],
                |r| Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "sourceKey": r.get::<_, String>(2)?,
                    "description": r.get::<_, Option<String>>(3)?,
                    "version": r.get::<_, Option<String>>(4)?,
                    "author": r.get::<_, Option<String>>(5)?,
                    "license": r.get::<_, Option<String>>(6)?,
                    "bodyExcerpt": r.get::<_, Option<String>>(7)?,
                    "contentHash": r.get::<_, String>(8)?,
                    "sizeBytes": r.get::<_, i64>(9)?,
                    "fileCount": r.get::<_, i64>(10)?,
                    "createdAt": r.get::<_, i64>(11)?,
                    "updatedAt": r.get::<_, i64>(12)?,
                    "lastScannedAt": r.get::<_, i64>(13)?,
                    "locations": [],
                    "scenarios": [],
                    "tags": []
                })),
            )
            .optional()?;
        let Some(mut skill) = skill else {
            continue;
        };
        skill["locations"] = locations_for_skill(db, id)?;
        skill["scenarios"] = scenarios_for_skill(db, id)?;
        out.push(skill);
    }
    Ok(Value::Array(out))
}

fn locations_for_skill(db: &Connection, id: &str) -> AppResult<Value> {
    let canonical = get_setting(db, "canonical_platform")?.unwrap_or_else(|| "shared".to_string());
    let mut stmt = db.prepare(
        "SELECT id, platform_id, install_path, real_path, is_symlink, is_broken_link, is_disabled, content_hash, mtime, last_seen_at
         FROM skill_locations WHERE skill_id = ?1
         ORDER BY CASE WHEN platform_id = ?2 THEN 0 ELSE 1 END, platform_id, install_path",
    )?;
    let rows = stmt.query_map(params![id, canonical], |r| {
        Ok(json!({
            "id": r.get::<_, i64>(0)?,
            "platformId": r.get::<_, String>(1)?,
            "installPath": r.get::<_, String>(2)?,
            "realPath": r.get::<_, String>(3)?,
            "isSymlink": r.get::<_, i64>(4)? != 0,
            "isBrokenSymlink": r.get::<_, i64>(5)? != 0,
            "isDisabled": r.get::<_, i64>(6)? != 0,
            "contentHash": r.get::<_, Option<String>>(7)?,
            "mtime": r.get::<_, Option<i64>>(8)?,
            "lastSeenAt": r.get::<_, i64>(9)?,
        }))
    })?;
    Ok(Value::Array(rows.collect::<Result<Vec<_>, _>>()?))
}

fn scenarios_for_skill(db: &Connection, id: &str) -> AppResult<Value> {
    let mut stmt = db.prepare(
        "SELECT sc.id, sc.key, sc.name FROM skill_scenarios ss JOIN scenarios sc ON sc.id = ss.scenario_id WHERE ss.skill_id = ?1 ORDER BY sc.sort_order, sc.name",
    )?;
    let rows = stmt.query_map(params![id], |r| Ok(json!({ "id": r.get::<_, i64>(0)?, "key": r.get::<_, String>(1)?, "name": r.get::<_, String>(2)? })))?;
    Ok(Value::Array(rows.collect::<Result<Vec<_>, _>>()?))
}

fn location_action_path(db: &Connection, payload: &Option<Value>) -> AppResult<String> {
    location_action(db, payload).map(|(path, _)| path)
}

fn location_action(db: &Connection, payload: &Option<Value>) -> AppResult<(String, String)> {
    let id = optional_i64(payload, "locationId")
        .ok_or_else(|| AppError::new("INVALID_INPUT", "locationId required"))?;
    let (install, real, is_symlink, broken): (String, String, i64, i64) = db.query_row(
        "SELECT install_path, real_path, is_symlink, is_broken_link FROM skill_locations WHERE id = ?1",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    let kind = payload
        .as_ref()
        .and_then(|p| p.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or("install");
    if kind == "target" {
        if is_symlink == 0 || broken != 0 {
            return Err(AppError::new(
                "INVALID_INPUT",
                "location has no available symlink target",
            ));
        }
        Ok((real, "target".to_string()))
    } else {
        Ok((install, "install".to_string()))
    }
}

fn db_update_scenario(db: &Connection, id: i64, p: &Value) -> AppResult<()> {
    let existing = scenario_by_id(db, id)?;
    db.execute(
        "UPDATE scenarios SET
          name = ?1,
          description = ?2,
          color = ?3,
          icon = ?4,
          sort_order = ?5
         WHERE id = ?6",
        params![
            p.get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .or_else(|| existing.get("name").and_then(Value::as_str)),
            p.get("description")
                .and_then(Value::as_str)
                .or_else(|| existing.get("description").and_then(Value::as_str)),
            p.get("color")
                .and_then(Value::as_str)
                .or_else(|| existing.get("color").and_then(Value::as_str)),
            p.get("icon")
                .and_then(Value::as_str)
                .or_else(|| existing.get("icon").and_then(Value::as_str)),
            p.get("sortOrder")
                .and_then(Value::as_i64)
                .or_else(|| existing.get("sortOrder").and_then(Value::as_i64)),
            id
        ],
    )?;
    Ok(())
}

fn scenario_by_id(db: &Connection, id: i64) -> AppResult<Value> {
    db.query_row(
        "SELECT id, key, name, description, color, icon, sort_order, is_builtin,
                (SELECT COUNT(*) FROM skill_scenarios WHERE scenario_id = scenarios.id)
         FROM scenarios WHERE id = ?1",
        params![id],
        |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "key": r.get::<_, String>(1)?,
                "name": r.get::<_, String>(2)?,
                "description": r.get::<_, Option<String>>(3)?,
                "color": r.get::<_, Option<String>>(4)?,
                "icon": r.get::<_, Option<String>>(5)?,
                "sortOrder": r.get::<_, i64>(6)?,
                "isBuiltin": r.get::<_, i64>(7)? != 0,
                "skillCount": r.get::<_, i64>(8)?,
            }))
        },
    )
    .map_err(Into::into)
}

fn get_setting(db: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(db
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |r| r.get(0),
        )
        .optional()?)
}

fn require_network(db: &Connection) -> AppResult<()> {
    if get_setting(db, "allow_external_network")?.as_deref() == Some("1") {
        Ok(())
    } else {
        Err(AppError::new(
            "EXTERNAL_NETWORK_DISABLED",
            "External network is disabled",
        ))
    }
}

fn current_set_hash(db: &Connection) -> AppResult<String> {
    let mut stmt = db.prepare("SELECT id, content_hash FROM skills ORDER BY id")?;
    let mut joined = String::new();
    for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (id, hash) = row?;
        joined.push_str(&id);
        joined.push('|');
        joined.push_str(&hash);
        joined.push('\n');
    }
    Ok(hex::encode(sha2::Sha256::digest(joined.as_bytes())))
}
