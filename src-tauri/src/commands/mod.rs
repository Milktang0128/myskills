use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

use arboard::Clipboard;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::{params, Connection, OptionalExtension};
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
    let count: i64 = db.query_row(
        "SELECT COUNT(*) FROM skill_locations WHERE platform_id = ?1",
        params![id],
        |r| r.get(0),
    )?;
    if count > 0 {
        return Err(AppError::new(
            "DELETE_FAILED",
            format!("platform {id} still has {count} skill location(s)"),
        ));
    }
    db.execute("DELETE FROM platforms WHERE id = ?1", params![id])?;
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
pub fn settings_cleanup_backups(payload: Option<Value>) -> AppResult<Value> {
    let _ = payload;
    Ok(json!({ "deletedDirs": 0, "deletedBytes": 0, "nulledRows": 0, "remainingBytes": 0 }))
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
    let result = scanner::scan_all(&db)?;
    if let Ok(mut last) = state.last_scan.lock() {
        *last = Some(result.clone());
    }
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
    let mut bind_values: Vec<String> = Vec::new();
    if let Some(search) = payload
        .as_ref()
        .and_then(|p| p.get("search"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        where_sql
            .push("(s.name LIKE ? OR s.description LIKE ? OR s.body_excerpt LIKE ?)".to_string());
        let like = format!("%{search}%");
        bind_values.push(like.clone());
        bind_values.push(like.clone());
        bind_values.push(like);
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
        .ok_or_else(|| AppError::new("INVALID_INPUT", "name required"))?;
    let key = p
        .get("key")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| slugify(name));
    let db = conn(&state)?;
    let next: i64 = db.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM scenarios",
        [],
        |r| r.get(0),
    )?;
    db.execute(
        "INSERT INTO scenarios (key, name, description, color, icon, sort_order, is_builtin, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)",
        params![
            key,
            name,
            p.get("description").and_then(Value::as_str),
            p.get("color").and_then(Value::as_str),
            p.get("icon").and_then(Value::as_str),
            next,
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
    let scenarios = scenarios_list(None, state)?;
    Ok(json!({ "version": "1", "exportedAt": now_ms(), "scenarios": scenarios }))
}

#[tauri::command]
pub fn scenarios_import(payload: Option<Value>) -> AppResult<Value> {
    let _ = payload;
    Err(AppError::new(
        "NOT_IMPLEMENTED",
        "scenario import is not yet ported to Tauri",
    ))
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
    let db = conn(&state)?;
    let key = slugify(name);
    let existing: Option<i64> = db
        .query_row(
            "SELECT id FROM scenarios WHERE key = ?1",
            params![key],
            |r| r.get(0),
        )
        .optional()?;
    let (scenario_id, created) = if let Some(id) = existing {
        (id, false)
    } else {
        db.execute(
            "INSERT INTO scenarios (key, name, color, sort_order, is_builtin, created_at) VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM scenarios), 0, ?4)",
            params![key, name, p.get("color").and_then(Value::as_str), now_ms()],
        )?;
        (db.last_insert_rowid(), true)
    };
    let mut linked = 0;
    let mut skipped = 0;
    for id in skill_ids.iter().filter_map(Value::as_str) {
        let before = db.changes();
        db.execute(
            "INSERT OR IGNORE INTO skill_scenarios (skill_id, scenario_id, added_at) VALUES (?1, ?2, ?3)",
            params![id, scenario_id, now_ms()],
        )?;
        if db.changes() > before {
            linked += 1;
        } else {
            skipped += 1;
        }
    }
    Ok(
        json!({ "scenarioId": scenario_id, "created": created, "skillsLinked": linked, "skillsSkipped": skipped }),
    )
}

#[tauri::command]
pub fn coverage_matrix(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let _ = payload;
    let db = conn(&state)?;
    let platform_ids = db
        .prepare("SELECT id FROM platforms WHERE enabled = 1 ORDER BY sort_order, id")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let canonical = get_setting(&db, "canonical_platform")?.unwrap_or_else(|| "shared".to_string());
    let skill_ids = db
        .prepare("SELECT id FROM skills ORDER BY name COLLATE NOCASE")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let skills = load_skills(&db, &skill_ids)?;
    let empty = Vec::new();
    let skill_array = skills.as_array().unwrap_or(&empty);
    let rows = skill_array.iter().map(|s| {
        let mut cells = serde_json::Map::new();
        for p in &platform_ids {
            cells.insert(p.clone(), json!({ "state": "missing", "drift": "in_sync" }));
        }
        if let Some(locs) = s.get("locations").and_then(Value::as_array) {
            for loc in locs {
                if let Some(pid) = loc.get("platformId").and_then(Value::as_str) {
                    let state = if loc.get("isDisabled").and_then(Value::as_bool).unwrap_or(false) {
                        "disabled"
                    } else if loc.get("isBrokenSymlink").and_then(Value::as_bool).unwrap_or(false) {
                        "broken"
                    } else if loc.get("isSymlink").and_then(Value::as_bool).unwrap_or(false) {
                        "symlink"
                    } else {
                        "present"
                    };
                    cells.insert(pid.to_string(), json!({
                        "state": state,
                        "locationId": loc.get("id").cloned().unwrap_or(Value::Null),
                        "installPath": loc.get("installPath").cloned().unwrap_or(Value::Null),
                        "realPath": loc.get("realPath").cloned().unwrap_or(Value::Null),
                        "contentHash": loc.get("contentHash").cloned().unwrap_or(Value::Null),
                        "mtime": loc.get("mtime").cloned().unwrap_or(Value::Null),
                        "drift": "in_sync"
                    }));
                }
            }
        }
        let missing: Vec<String> = cells.iter().filter(|(_, c)| c.get("state").and_then(Value::as_str) == Some("missing")).map(|(k, _)| k.clone()).collect();
        json!({
            "skillId": s["id"],
            "skillName": s["name"],
            "sourceKey": s["sourceKey"],
            "description": s["description"],
            "cells": cells,
            "missingOn": missing,
            "hasCanonicalSource": s.get("locations").and_then(Value::as_array).is_some_and(|locs| locs.iter().any(|l| l.get("platformId").and_then(Value::as_str) == Some(canonical.as_str()))),
            "hasDrift": false
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
    let token = Uuid::new_v4().to_string();
    let now = now_ms();
    let plan = json!({
        "token": token,
        "generatedAt": now,
        "expiresAt": now + 5 * 60 * 1000,
        "operation": if operation == "promote_to_canonical" { "promote_to_canonical" } else { "sync_from_canonical" },
        "items": []
    });
    state.evict_expired_plans();
    if let Ok(mut store) = state.plan_store.lock() {
        store.insert(
            token,
            StoredPlan {
                plan: plan.clone(),
                expires_at: SystemTime::now() + AppState::plan_ttl(),
            },
        );
    }
    Ok(plan)
}

#[tauri::command]
pub fn sync_plan_toggle_disabled(
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> AppResult<Value> {
    let p = payload.unwrap_or_else(|| json!({}));
    let disable = p
        .pointer("/requests/0/disable")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let token = Uuid::new_v4().to_string();
    let now = now_ms();
    let plan = json!({
        "token": token,
        "generatedAt": now,
        "expiresAt": now + 5 * 60 * 1000,
        "operation": if disable { "disable" } else { "enable" },
        "items": []
    });
    if let Ok(mut store) = state.plan_store.lock() {
        store.insert(
            token,
            StoredPlan {
                plan: plan.clone(),
                expires_at: SystemTime::now() + AppState::plan_ttl(),
            },
        );
    }
    Ok(plan)
}

#[tauri::command]
pub fn sync_execute(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let token = required_str(&payload, "token")?;
    let _lock = state
        .sync_lock
        .lock()
        .map_err(|_| AppError::new("SYNC_LOCK_POISONED", "sync lock poisoned"))?;
    let plan = state
        .plan_store
        .lock()
        .map_err(|_| AppError::new("PLAN_STORE_POISONED", "plan store poisoned"))?
        .remove(token)
        .ok_or_else(|| AppError::new("PLAN_EXPIRED", "sync plan token is missing or expired"))?
        .plan;
    let items = plan.get("items").cloned().unwrap_or_else(|| json!([]));
    Ok(json!({ "applied": [], "skipped": items, "failed": [] }))
}

#[tauri::command]
pub fn sync_history(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let limit = payload
        .as_ref()
        .and_then(|p| p.get("limit"))
        .and_then(Value::as_i64)
        .unwrap_or(50)
        .clamp(1, 200);
    let db = conn(&state)?;
    let mut stmt = db.prepare(
        "SELECT id, skill_id, action, from_path, to_path, platform_id, before_hash, after_hash, backup_path, conflict_resolution, rolled_back_at, success, message, created_at, op_group_id
         FROM sync_history ORDER BY id DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |r| {
        Ok(json!({
            "id": r.get::<_, i64>(0)?,
            "skill_id": r.get::<_, String>(1)?,
            "action": r.get::<_, String>(2)?,
            "from_path": r.get::<_, Option<String>>(3)?,
            "to_path": r.get::<_, Option<String>>(4)?,
            "platform_id": r.get::<_, Option<String>>(5)?,
            "before_hash": r.get::<_, Option<String>>(6)?,
            "after_hash": r.get::<_, Option<String>>(7)?,
            "backup_path": r.get::<_, Option<String>>(8)?,
            "conflict_resolution": r.get::<_, Option<String>>(9)?,
            "rolled_back_at": r.get::<_, Option<i64>>(10)?,
            "success": r.get::<_, i64>(11)?,
            "message": r.get::<_, Option<String>>(12)?,
            "created_at": r.get::<_, i64>(13)?,
            "op_group_id": r.get::<_, Option<String>>(14)?,
            "backup_orphaned": false
        }))
    })?;
    Ok(Value::Array(rows.collect::<Result<Vec<_>, _>>()?))
}

#[tauri::command]
pub fn sync_rollback(payload: Option<Value>) -> AppResult<Value> {
    let _ = payload;
    Err(AppError::new(
        "NOT_IMPLEMENTED",
        "sync rollback is not yet ported to Tauri",
    ))
}

#[tauri::command]
pub fn catalog_search(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let db = conn(&state)?;
    require_network(&db)?;
    let q = payload
        .as_ref()
        .and_then(|p| p.get("q"))
        .and_then(Value::as_str)
        .unwrap_or("");
    Ok(
        json!({ "query": q, "searchType": "tauri-placeholder", "skills": [], "count": 0, "duration_ms": 0 }),
    )
}

#[tauri::command]
pub fn catalog_preview(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let db = conn(&state)?;
    require_network(&db)?;
    let source = required_str(&payload, "source")?;
    let skill_id = required_str(&payload, "skillId")?;
    Ok(
        json!({ "source": source, "skillId": skill_id, "rawMarkdown": "", "frontmatter": {}, "bodyExcerpt": null }),
    )
}

#[tauri::command]
pub fn catalog_enrich_descriptions(
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> AppResult<Value> {
    let db = conn(&state)?;
    require_network(&db)?;
    let items = payload
        .as_ref()
        .and_then(|p| p.get("items"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(Value::Array(
        items
            .into_iter()
            .map(|item| {
                json!({
                    "source": item.get("source").cloned().unwrap_or(Value::Null),
                    "skillId": item.get("skillId").cloned().unwrap_or(Value::Null),
                    "description": null
                })
            })
            .collect(),
    ))
}

#[tauri::command]
pub fn catalog_plan_install(
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> AppResult<Value> {
    let db = conn(&state)?;
    require_network(&db)?;
    sync_plan(
        Some(json!({ "kind": "sync_from_canonical", "catalog": payload })),
        state,
    )
}

#[tauri::command]
pub fn llm_get_config(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let _ = payload;
    let db = conn(&state)?;
    let provider = get_setting(&db, "llm.provider")?.unwrap_or_else(|| "deepseek".to_string());
    let model = get_setting(&db, "llm.model")?.unwrap_or_else(|| "deepseek-v4-flash".to_string());
    let base_url = get_setting(&db, "llm.baseUrl")?.unwrap_or_default();
    let has_api_key = get_setting(&db, "secret:llm.apiKey")?.is_some();
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
            db.execute("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![setting_key, v])?;
        }
    }
    llm_get_config(None, state)
}

#[tauri::command]
pub fn llm_set_api_key(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let key = required_str(&payload, "key")?;
    // Preview implementation: stores an encoded placeholder in the Tauri preview DB.
    // Platform secret-store backends are a later parity task.
    let encoded = STANDARD.encode(key);
    conn(&state)?.execute(
        "INSERT INTO settings (key, value) VALUES ('secret:llm.apiKey', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![encoded],
    )?;
    Ok(json!({ "ok": true, "hasApiKey": true }))
}

#[tauri::command]
pub fn llm_delete_api_key(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let _ = payload;
    conn(&state)?.execute("DELETE FROM settings WHERE key = 'secret:llm.apiKey'", [])?;
    Ok(json!({ "ok": true, "hasApiKey": false }))
}

#[tauri::command]
pub fn llm_chat(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let _ = payload;
    let db = conn(&state)?;
    require_network(&db)?;
    Err(AppError::new(
        "NOT_IMPLEMENTED",
        "LLM transport is not yet ported to Tauri",
    ))
}

#[tauri::command]
pub fn llm_test_connection(payload: Option<Value>, state: State<'_, AppState>) -> AppResult<Value> {
    let _ = payload;
    let db = conn(&state)?;
    require_network(&db)?;
    Ok(json!({ "ok": false, "message": "LLM transport is not yet ported to Tauri" }))
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
    llm_get_features(None, state)
}

#[tauri::command]
pub fn ai_get_suggestions_for_skill(payload: Option<Value>) -> AppResult<Value> {
    let _ = payload;
    Ok(json!([]))
}
#[tauri::command]
pub fn ai_accept_suggestion(payload: Option<Value>) -> AppResult<Value> {
    let _ = payload;
    Ok(ok())
}
#[tauri::command]
pub fn ai_dismiss_suggestion(payload: Option<Value>) -> AppResult<Value> {
    let _ = payload;
    Ok(ok())
}
#[tauri::command]
pub fn ai_queue_status(payload: Option<Value>) -> AppResult<Value> {
    let _ = payload;
    Ok(json!({ "pending": 0, "schedulerRunning": false }))
}
#[tauri::command]
pub fn ai_bulk_categorize(payload: Option<Value>) -> AppResult<Value> {
    let _ = payload;
    Err(AppError::new(
        "NOT_IMPLEMENTED",
        "bulk categorization is not yet ported to Tauri",
    ))
}
#[tauri::command]
pub fn ai_apply_bulk_categorization(payload: Option<Value>) -> AppResult<Value> {
    let _ = payload;
    Ok(json!({ "newScenariosCreated": 0, "assignmentsApplied": 0, "errors": [] }))
}
#[tauri::command]
pub fn ai_library_overview_get(
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> AppResult<Value> {
    let language = payload
        .as_ref()
        .and_then(|p| p.get("language"))
        .and_then(Value::as_str)
        .unwrap_or("en");
    let db = conn(&state)?;
    let set_hash = current_set_hash(&db)?;
    let row: Option<(String, String)> = db
        .query_row(
            "SELECT set_hash, overview_json FROM library_overview WHERE id = 1 AND language = ?1",
            params![language],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let overview = row
        .as_ref()
        .and_then(|(_, json)| serde_json::from_str::<Value>(json).ok());
    let stale = row.map(|(hash, _)| hash != set_hash).unwrap_or(false);
    Ok(json!({ "overview": overview, "stale": stale, "currentSetHash": set_hash }))
}
#[tauri::command]
pub fn ai_library_overview_generate(payload: Option<Value>) -> AppResult<Value> {
    let language = payload
        .as_ref()
        .and_then(|p| p.get("language"))
        .and_then(Value::as_str)
        .unwrap_or("en");
    Ok(
        json!({ "intro": "", "clusters": [], "uncategorized": [], "totalSkills": 0, "generatedAt": now_ms(), "model": "tauri-placeholder", "language": language }),
    )
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
    let mut stmt = db.prepare(
        "SELECT id, platform_id, install_path, real_path, is_symlink, is_broken_link, is_disabled, content_hash, mtime, last_seen_at
         FROM skill_locations WHERE skill_id = ?1 ORDER BY platform_id, install_path",
    )?;
    let rows = stmt.query_map(params![id], |r| {
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
    db.execute(
        "UPDATE scenarios SET
          name = COALESCE(?1, name),
          description = ?2,
          color = ?3,
          icon = ?4,
          sort_order = COALESCE(?5, sort_order)
         WHERE id = ?6",
        params![
            p.get("name").and_then(Value::as_str),
            p.get("description").and_then(Value::as_str),
            p.get("color").and_then(Value::as_str),
            p.get("icon").and_then(Value::as_str),
            p.get("sortOrder").and_then(Value::as_i64),
            id
        ],
    )?;
    Ok(())
}

fn scenario_by_id(db: &Connection, id: i64) -> AppResult<Value> {
    db.query_row(
        "SELECT id, key, name, description, color, icon, sort_order, is_builtin FROM scenarios WHERE id = ?1",
        params![id],
        |r| Ok(json!({
            "id": r.get::<_, i64>(0)?,
            "key": r.get::<_, String>(1)?,
            "name": r.get::<_, String>(2)?,
            "description": r.get::<_, Option<String>>(3)?,
            "color": r.get::<_, Option<String>>(4)?,
            "icon": r.get::<_, Option<String>>(5)?,
            "sortOrder": r.get::<_, i64>(6)?,
            "isBuiltin": r.get::<_, i64>(7)? != 0,
        })),
    ).map_err(Into::into)
}

fn slugify(name: &str) -> String {
    let mut out = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
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
        joined.push(':');
        joined.push_str(&hash);
        joined.push('\n');
    }
    Ok(hex::encode(sha2::Sha256::digest(joined.as_bytes())))
}
