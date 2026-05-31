use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{Duration, SystemTime};

use arboard::Clipboard;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::{params, types::Value as SqlValue, Connection, OptionalExtension};
use serde_json::Map;
use serde_json::{json, Value};
use sha2::Digest;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::scanner;
use crate::scanner::parser::load_skill_body;
use crate::state::{AppState, StoredPlan};

fn conn(
    state: &State<'_, AppState>,
) -> AppResult<r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>> {
    Ok(state.db.get()?)
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
        "dbPath": state.paths.db_path.to_string_lossy(),
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
    let mut where_sql = Vec::new();
    let mut bind_values: Vec<SqlValue> = Vec::new();
    if let Some(search) = payload
        .as_ref()
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
        .as_ref()
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
        .as_ref()
        .and_then(|p| p.get("scenarioId"))
        .and_then(Value::as_i64)
    {
        where_sql.push(
            "s.id IN (SELECT skill_id FROM skill_scenarios WHERE scenario_id = ?)".to_string(),
        );
        bind_values.push(SqlValue::Integer(scenario_id));
    }
    if let Some(scope) = payload
        .as_ref()
        .and_then(|p| p.get("scope"))
        .and_then(Value::as_str)
    {
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
    let order = match payload.as_ref().and_then(|p| p.get("sort")).and_then(Value::as_str) {
        Some("updated") => "ORDER BY s.updated_at DESC, s.name COLLATE NOCASE",
        Some("created") => "ORDER BY s.created_at DESC, s.name COLLATE NOCASE",
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
    load_skills(&db, &ids)
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
    let path = location_action_path(&db, &payload)?;
    tauri_plugin_opener::open_path(path.clone(), None::<&str>).map_err(|err| {
        AppError::detail("OPEN_PATH_FAILED", err.to_string(), json!({ "path": path }))
    })?;
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

fn scenarios_export_response(db: &Connection) -> AppResult<Value> {
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

fn scenarios_import_payload(db: &mut Connection, payload: &Value) -> AppResult<Value> {
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

fn coverage_matrix_response(db: &Connection) -> AppResult<Value> {
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
        let has_canonical_source = canonical_loc.is_some();
        for loc in locs {
            let state = cell_state_for(&loc, &real_path_owner, &canonical);
            let mut cell = json!({
                "state": state,
                "locationId": loc.id,
                "installPath": loc.install_path,
                "realPath": loc.real_path,
                "contentHash": loc.content_hash,
                "mtime": loc.mtime,
                "drift": drift_for(&loc, state, &canonical, canonical_hash.as_deref(), has_canonical_source),
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
        "sync_from_canonical" => plan_sync_from_canonical(&db, requests, &state)?,
        "promote_to_canonical" => plan_promote_to_canonical(&db, requests, &state)?,
        _ => return Err(AppError::new("INVALID_INPUT", "unknown plan kind")),
    };
    store_plan(&state, &plan)?;
    Ok(plan)
}

fn plan_sync_from_canonical(
    db: &Connection,
    requests: &[Value],
    _state: &State<'_, AppState>,
) -> AppResult<Value> {
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
        let source = sync_location(db, skill_id, &canonical, false)?;
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
        for target_id in target_ids
            .into_iter()
            .filter(|id| id != &canonical)
            .filter(|id| platforms.iter().any(|p| p.id == *id))
        {
            let target_platform = platforms.iter().find(|p| p.id == target_id).unwrap();
            let target = sync_location(db, skill_id, &target_id, false)?;
            items.push(build_sync_item(SyncBuildItemArgs {
                skill: &skill,
                source: source.as_ref(),
                target: target.as_ref(),
                source_platform_id: &canonical,
                target_platform_id: &target_id,
                target_platform_dir: &target_platform.skills_dir,
                op_group_id: &op_group_id,
                override_action: None,
            }));
        }
    }
    Ok(finalize_sync_plan("sync_from_canonical", items))
}

fn plan_promote_to_canonical(
    db: &Connection,
    requests: &[Value],
    _state: &State<'_, AppState>,
) -> AppResult<Value> {
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

fn execute_sync_items(
    db: &Connection,
    backup_root: &Path,
    items: Vec<Value>,
    plan_json: &str,
) -> AppResult<Value> {
    let mut applied = Vec::new();
    let mut skipped = Vec::new();
    let mut failed = Vec::new();
    let mut aborted_groups = std::collections::HashSet::new();

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
    Ok(json!({ "applied": applied, "skipped": skipped, "failed": failed }))
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
    let mark_time = now_ms();
    let mut rolled_back = 0;
    for row in &rows {
        if let Err(err) = rollback_one_row(row) {
            let _ = scanner::scan_all(&db).map(|scan| {
                if let Ok(mut last) = state.last_scan.lock() {
                    *last = Some(scan.clone());
                }
                enqueue_ai_suggestions(&state, scan_added_skill_ids(&scan));
            });
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
    let scan = scanner::scan_all(&db)?;
    if let Ok(mut last) = state.last_scan.lock() {
        *last = Some(scan.clone());
    }
    enqueue_ai_suggestions(&state, scan_added_skill_ids(&scan));
    Ok(json!({ "ok": true, "rolledBack": rolled_back }))
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
        "copy_to_canonical" => rollback_copy_row(row),
        action => Err(AppError::new(
            "UNSUPPORTED",
            format!("rollback unsupported for action={action}"),
        )),
    }
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
        "copy_to_canonical" => do_copy_item(db, history_id, backup_root, item),
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

        let response = llm_config_response(&conn).unwrap();

        assert_eq!(
            response.get("hasApiKey").and_then(Value::as_bool),
            Some(true)
        );
        assert!(response.get("apiKey").is_none());
        assert!(response.get("key").is_none());
        assert!(!response.to_string().contains("plaintext-legacy-secret"));
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

        match ai_queue_can_process(&conn).unwrap() {
            AiQueueDecision::Wait => {}
            _ => panic!("AI queue should wait when external network is disabled"),
        }
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
const SECRET_SERVICE: &str = "com.kanbenzhi.myskills.tauri-preview";
const LLM_API_KEY_NAME: &str = "llm.apiKey";

#[tauri::command]
pub fn catalog_search(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
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
pub fn catalog_preview(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
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
pub fn catalog_enrich_descriptions(
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
pub fn catalog_plan_install(
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

fn catalog_client() -> AppResult<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|err| AppError::new("CATALOG_HTTP_CLIENT_FAILED", err.to_string()))
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
    let client = catalog_client()?;
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
    llm_config_response(&db)
}

fn llm_config_response(db: &Connection) -> AppResult<Value> {
    let provider = get_setting(db, "llm.provider")?.unwrap_or_else(|| "deepseek".to_string());
    let model = get_setting(db, "llm.model")?.unwrap_or_else(|| "deepseek-v4-flash".to_string());
    let base_url = get_setting(db, "llm.baseUrl")?.unwrap_or_default();
    let has_api_key = llm_has_api_key(db)?;
    Ok(
        json!({ "provider": provider, "model": model, "baseUrl": base_url, "hasApiKey": has_api_key }),
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
    llm_get_config(None, state)
}

#[tauri::command]
pub fn llm_set_api_key(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let key = required_str(&payload, "key")?;
    let db = conn(&state)?;
    secret_store_write(LLM_API_KEY_NAME, key)?;
    db.execute("DELETE FROM settings WHERE key = 'secret:llm.apiKey'", [])?;
    maybe_start_ai_worker(&state);
    Ok(json!({ "ok": true, "hasApiKey": true }))
}

#[tauri::command]
pub fn llm_delete_api_key(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let _ = payload;
    let db = conn(&state)?;
    secret_store_delete(LLM_API_KEY_NAME)?;
    db.execute("DELETE FROM settings WHERE key = 'secret:llm.apiKey'", [])?;
    Ok(json!({ "ok": true, "hasApiKey": false }))
}

#[tauri::command]
pub fn llm_chat(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
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
    let api_key = llm_read_api_key(&db)?;
    llm_chat_with_config(&config, api_key.as_deref(), req)
}

#[tauri::command]
pub fn llm_test_connection(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
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
    let api_key = llm_read_api_key(&db)?;
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
            Ok(
                json!({ "ok": true, "message": if text.is_empty() { "OK".to_string() } else { format!("OK ({})", truncate(text, 60)) } }),
            )
        }
        Err(err) => Ok(json!({ "ok": false, "message": err.message })),
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

fn llm_read_api_key(db: &Connection) -> AppResult<Option<String>> {
    if let Some(value) = secret_store_read(LLM_API_KEY_NAME)? {
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
    secret_store_write(LLM_API_KEY_NAME, &migrated)?;
    db.execute("DELETE FROM settings WHERE key = 'secret:llm.apiKey'", [])?;
    Ok(Some(migrated))
}

fn llm_has_api_key(db: &Connection) -> AppResult<bool> {
    Ok(secret_store_exists(LLM_API_KEY_NAME).unwrap_or(false)
        || get_setting(db, "secret:llm.apiKey")?.is_some())
}

fn secret_store_entry(name: &str) -> AppResult<keyring_core::Entry> {
    #[cfg(target_os = "linux")]
    keyring::use_named_store("secret-service").map_err(secret_store_error)?;
    #[cfg(not(target_os = "linux"))]
    keyring::use_native_store(false).map_err(secret_store_error)?;
    keyring_core::Entry::new(SECRET_SERVICE, name).map_err(secret_store_error)
}

fn secret_store_write(name: &str, value: &str) -> AppResult<()> {
    secret_store_entry(name)?
        .set_password(value)
        .map_err(secret_store_error)
}

fn secret_store_read(name: &str) -> AppResult<Option<String>> {
    match secret_store_entry(name)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring_core::Error::NoEntry) => Ok(None),
        Err(err) => Err(secret_store_error(err)),
    }
}

fn secret_store_exists(name: &str) -> AppResult<bool> {
    match secret_store_entry(name)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring_core::Error::NoEntry) => Ok(false),
        Err(err) => Err(secret_store_error(err)),
    }
}

fn secret_store_delete(name: &str) -> AppResult<()> {
    match secret_store_entry(name)?.delete_credential() {
        Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
        Err(err) => Err(secret_store_error(err)),
    }
}

fn secret_store_error(err: keyring_core::Error) -> AppError {
    AppError::new(
        "SECRET_STORE_UNAVAILABLE",
        format!("System credential store is unavailable: {err}"),
    )
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
    let client = catalog_client()?;
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
    let res = request.json(&Value::Object(body)).send().map_err(|err| {
        AppError::new(
            "LLM_UNAVAILABLE",
            format!("Could not reach LLM provider: {err}"),
        )
    })?;
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
    let client = catalog_client()?;
    let res = client
        .post(format!("{base_url}/messages"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&Value::Object(body))
        .send()
        .map_err(|err| {
            AppError::new(
                "LLM_UNAVAILABLE",
                format!("Could not reach Anthropic: {err}"),
            )
        })?;
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
        "recommend": get_setting(&db, "llm.feature.recommend")?.as_deref() == Some("1")
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
    ] {
        if let Some(v) = p.get(json_key).and_then(Value::as_bool) {
            db.execute("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![setting_key, if v { "1" } else { "0" }])?;
        }
    }
    maybe_start_ai_worker(&state);
    llm_get_features(None, state)
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
    let queue = state.ai_queue.clone();
    let running = state.ai_worker_running.clone();
    std::thread::spawn(move || {
        ai_queue_worker(db, queue, running);
    });
}

fn ai_queue_worker(
    db: r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
    queue: std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<String>>>,
    running: std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    loop {
        let Ok(conn) = db.get() else {
            break;
        };
        match ai_queue_can_process(&conn) {
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
        if ai_process_suggestion_batch(&conn, &batch).is_err() {
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

fn ai_queue_can_process(db: &Connection) -> AppResult<AiQueueDecision> {
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
    let api_key = llm_read_api_key(db)?;
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

fn ai_process_suggestion_batch(db: &Connection, skill_ids: &[String]) -> AppResult<()> {
    let config = llm_read_config(db)?;
    let api_key = llm_read_api_key(db)?;
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
pub fn ai_bulk_categorize(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
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
    let api_key = llm_read_api_key(&db)?;
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
pub fn ai_library_overview_generate(
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
    require_network(&db)?;
    let config = llm_read_config(&db)?;
    if config.model.trim().is_empty() {
        return Err(AppError::new(
            "LLM_NO_MODEL",
            "No LLM model configured. Set one in Settings -> AI.",
        ));
    }
    let api_key = llm_read_api_key(&db)?;
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
) -> &'static str {
    if loc.is_broken_link {
        "broken"
    } else if loc.is_disabled {
        "disabled"
    } else if !loc.is_symlink {
        "present"
    } else if real_path_owner
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
    has_canonical_source: bool,
) -> &'static str {
    if loc.platform_id == canonical {
        "in_sync"
    } else if !has_canonical_source {
        "only_here"
    } else if state == "symlink" {
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
        Ok(real)
    } else {
        Ok(install)
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
