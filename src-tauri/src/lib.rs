mod commands;
mod db;
mod error;
#[allow(dead_code)]
mod migration;
mod paths;
mod scanner;
mod state;

use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, OptionalExtension};
use sha2::Digest;
use std::path::Path;
use tauri::Manager;

use crate::error::AppResult;
use crate::paths::AppPaths;
use crate::state::AppState;

const TAURI_PREVIEW_IDENTIFIER: &str = "com.kanbenzhi.myskills.tauri-preview";

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let state = init_state(app.handle())?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::platforms_list,
            commands::platforms_update,
            commands::platforms_create,
            commands::platforms_delete,
            commands::platforms_probe,
            commands::platforms_known_candidates,
            commands::platforms_open_dir,
            commands::skills_list,
            commands::skills_get,
            commands::skills_open_location,
            commands::skills_copy_location_path,
            commands::scenarios_list,
            commands::scenarios_create,
            commands::scenarios_update,
            commands::scenarios_delete,
            commands::scenarios_add_skill,
            commands::scenarios_remove_skill,
            commands::scenarios_export,
            commands::scenarios_import,
            commands::scenarios_create_from_cluster,
            commands::migration_discover,
            commands::migration_confirm,
            commands::scan_run,
            commands::scan_last_result,
            commands::coverage_matrix,
            commands::sync_plan,
            commands::sync_plan_toggle_disabled,
            commands::sync_execute,
            commands::sync_history,
            commands::sync_rollback,
            commands::catalog_search,
            commands::catalog_preview,
            commands::catalog_enrich_descriptions,
            commands::catalog_plan_install,
            commands::settings_get,
            commands::settings_set,
            commands::settings_stats,
            commands::settings_cleanup_backups,
            commands::llm_get_config,
            commands::llm_set_config,
            commands::llm_set_api_key,
            commands::llm_delete_api_key,
            commands::llm_chat,
            commands::llm_test_connection,
            commands::llm_get_features,
            commands::llm_set_features,
            commands::ai_get_suggestions_for_skill,
            commands::ai_accept_suggestion,
            commands::ai_dismiss_suggestion,
            commands::ai_queue_status,
            commands::ai_create_skill_start,
            commands::ai_create_skill_get,
            commands::ai_create_skill_refine,
            commands::ai_create_skill_answer,
            commands::ai_create_skill_generate,
            commands::ai_create_skill_review,
            commands::ai_create_skill_plan,
            commands::ai_create_skill_execute,
            commands::ai_create_skill_discard,
            commands::ai_bulk_categorize,
            commands::ai_apply_bulk_categorization,
            commands::ai_library_overview_get,
            commands::ai_library_overview_generate
        ])
        .run(tauri::generate_context!())
        .expect("error while running MySkills");
}

fn init_state(app: &tauri::AppHandle) -> AppResult<AppState> {
    let default_app_data = match std::env::var("MYSKILLS_INTERNAL_SMOKE_DATA_DIR") {
        Ok(path) if !path.trim().is_empty() => std::path::PathBuf::from(path),
        _ => app
            .path()
            .app_data_dir()
            .map_err(|err| crate::error::AppError::new("PATH_ERROR", err.to_string()))?,
    };
    let preview = is_preview_runtime(app);
    let paths = AppPaths::new(AppPaths::runtime_data_dir(default_app_data, preview))?;
    maybe_prepare_stable_migration(&paths, preview)?;
    let db = db::init_pool(&paths.db_path)?;
    let mut last_scan = None;
    if let Ok(mut conn) = db.get() {
        let _ = commands::recover_pending_backups(&conn);
        let _ = commands::recover_pending_history(&conn);
        if let Ok(days) = commands::backup_retention_days(&conn) {
            let _ = commands::cleanup_old_backups(&conn, &paths.backup_root, days);
        }
        if std::env::var("MYSKILLS_INTERNAL_SMOKE_FRONTEND").is_ok() {
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params!["smoke.frontend.expected", "1"],
            )?;
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params!["smoke.frontend.ready", "0"],
            )?;
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params!["smoke.frontend.view", ""],
            )?;
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params!["smoke.frontend.ui.ready", "0"],
            )?;
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params!["smoke.frontend.ui.sequence", ""],
            )?;
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params!["onboarding_completed_at", "internal-smoke"],
            )?;
        }
        if let Some(scan) = apply_internal_smoke_fixture(&conn)? {
            last_scan = Some(scan);
        }
        if std::env::var("MYSKILLS_INTERNAL_SMOKE_COVERAGE").is_ok() {
            run_internal_smoke_coverage(&conn)?;
        }
        if std::env::var("MYSKILLS_INTERNAL_SMOKE_WORKFLOWS").is_ok() {
            run_internal_smoke_workflows(&mut conn)?;
        }
        if std::env::var("MYSKILLS_INTERNAL_SMOKE_SYNC").is_ok() {
            run_internal_smoke_sync(&conn, &paths.backup_root)?;
            if std::env::var("MYSKILLS_INTERNAL_SMOKE_ROLLBACK").is_ok() {
                let rolled_back = commands::rollback_history_group(&conn, "internal-smoke-sync")?;
                if rolled_back != 1 {
                    return Err(crate::error::AppError::new(
                        "SMOKE_ROLLBACK_FAILED",
                        format!("expected one rollback row, got {rolled_back}"),
                    ));
                }
            }
            let scan = scanner::scan_all(&conn)?;
            last_scan = Some(scan);
        }
    }
    let _manager = SqliteConnectionManager::file(&paths.db_path);
    Ok(AppState {
        paths,
        db,
        last_scan: std::sync::Mutex::new(last_scan),
        plan_store: std::sync::Mutex::new(std::collections::HashMap::new()),
        sync_lock: std::sync::Mutex::new(()),
        ai_queue: std::sync::Arc::new(std::sync::Mutex::new(std::collections::VecDeque::new())),
        ai_worker_running: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
    })
}

fn is_preview_runtime(app: &tauri::AppHandle) -> bool {
    if std::env::var("MYSKILLS_INTERNAL_STABLE_APP").is_ok() {
        return false;
    }
    app.config().identifier == TAURI_PREVIEW_IDENTIFIER
}

fn maybe_prepare_stable_migration(paths: &AppPaths, preview: bool) -> AppResult<()> {
    let env_confirmation_file = std::env::var("MYSKILLS_STABLE_MIGRATE_CONFIRMATION_FILE")
        .ok()
        .filter(|path| !path.trim().is_empty())
        .map(std::path::PathBuf::from);
    let confirmation_from_env = env_confirmation_file.is_some();
    let default_confirmation_file = migration::confirmation_file_path(&paths.user_data_dir);
    let confirmation_file = env_confirmation_file.or_else(|| {
        default_confirmation_file
            .exists()
            .then_some(default_confirmation_file)
    });
    let legacy_source_db = std::env::var("MYSKILLS_STABLE_MIGRATE_FROM_ELECTRON_DB")
        .ok()
        .filter(|path| !path.trim().is_empty());
    let Some(confirmation_file) = confirmation_file else {
        if legacy_source_db.is_some() {
            return Err(crate::error::AppError::new(
                "MIGRATION_CONFIRMATION_REQUIRED",
                "Stable migration requires MYSKILLS_STABLE_MIGRATE_CONFIRMATION_FILE with a confirmed source hash",
            ));
        }
        return Ok(());
    };
    if preview {
        return Err(crate::error::AppError::new(
            "MIGRATION_PREVIEW_DISABLED",
            "Electron DB migration is disabled for Tauri preview builds",
        ));
    }
    let timestamp = db::now_ms();
    if paths.db_path.exists() {
        if migration::stable_target_already_migrated(&paths.user_data_dir)? {
            if !confirmation_from_env {
                let _ = std::fs::remove_file(&confirmation_file);
            }
            return Ok(());
        }
        migration::preserve_replaceable_target_db(&paths.user_data_dir, timestamp)?;
    }
    migration::prepare_confirmed_stable_import(
        &confirmation_file,
        &paths.user_data_dir,
        timestamp,
    )?;
    if !confirmation_from_env {
        let _ = std::fs::remove_file(&confirmation_file);
    }
    Ok(())
}

fn apply_internal_smoke_fixture(
    conn: &rusqlite::Connection,
) -> AppResult<Option<serde_json::Value>> {
    let Ok(manifest_path) = std::env::var("MYSKILLS_INTERNAL_SMOKE_FIXTURE_MANIFEST") else {
        return Ok(None);
    };
    let raw = std::fs::read_to_string(&manifest_path).map_err(|err| {
        crate::error::AppError::new(
            "SMOKE_FIXTURE_FAILED",
            format!("could not read smoke fixture manifest {manifest_path}: {err}"),
        )
    })?;
    let manifest: serde_json::Value = serde_json::from_str(&raw).map_err(|err| {
        crate::error::AppError::new(
            "SMOKE_FIXTURE_FAILED",
            format!("invalid smoke fixture manifest {manifest_path}: {err}"),
        )
    })?;
    let platforms = manifest
        .get("platforms")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| {
            crate::error::AppError::new(
                "SMOKE_FIXTURE_FAILED",
                "smoke fixture manifest missing platforms",
            )
        })?;
    for platform_id in ["shared", "claude", "codex"] {
        let dir = platforms
            .get(platform_id)
            .and_then(serde_json::Value::as_str)
            .filter(|dir| Path::new(dir).is_dir())
            .ok_or_else(|| {
                crate::error::AppError::new(
                    "SMOKE_FIXTURE_FAILED",
                    format!("smoke fixture directory for {platform_id} is missing"),
                )
            })?;
        conn.execute(
            "UPDATE platforms SET skills_dir = ?1, enabled = 1 WHERE id = ?2",
            params![dir, platform_id],
        )?;
    }
    scanner::scan_all(conn).map(Some)
}

fn run_internal_smoke_sync(conn: &rusqlite::Connection, backup_root: &Path) -> AppResult<()> {
    let Some((skill_id, source_path, target_path, source_hash)) = conn
        .query_row(
            "SELECT s.id, source.real_path, target.install_path, source.content_hash
             FROM skills s
             JOIN skill_locations source ON source.skill_id = s.id AND source.platform_id = 'claude' AND source.is_disabled = 0
             JOIN skill_locations target ON target.skill_id = s.id AND target.platform_id = 'shared' AND target.is_disabled = 0
             WHERE s.name = 'fixture-stale'
             LIMIT 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()?
    else {
        return Err(crate::error::AppError::new(
            "SMOKE_SYNC_FAILED",
            "fixture-stale shared/claude locations were not found",
        ));
    };
    let source_hash = source_hash.unwrap_or_else(|| hash_skill_md(Path::new(&source_path)));
    let item = serde_json::json!({
        "skillName": "fixture-stale",
        "skillId": skill_id,
        "opGroupId": "internal-smoke-sync",
        "targetBasename": "fixture-stale",
        "sourcePlatformId": "claude",
        "sourceLocationId": -1,
        "sourceRealPath": source_path,
        "sourceDev": 0,
        "sourceIno": 0,
        "sourceHash": source_hash,
        "targetPlatformId": "shared",
        "targetPath": target_path,
        "targetHash": serde_json::Value::Null,
        "mode": "copy",
        "action": "copy_to_canonical"
    });
    let result = commands::execute_sync_items(
        conn,
        backup_root,
        vec![item],
        "{\"operation\":\"internal_smoke_sync\"}",
    )?;
    let applied = result
        .get("applied")
        .and_then(serde_json::Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let failed = result
        .get("failed")
        .and_then(serde_json::Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    if applied != 1 || failed != 0 {
        return Err(crate::error::AppError::detail(
            "SMOKE_SYNC_FAILED",
            "internal smoke sync did not apply exactly one copy operation",
            result,
        ));
    }
    Ok(())
}

fn run_internal_smoke_coverage(conn: &rusqlite::Connection) -> AppResult<()> {
    let matrix = commands::coverage_matrix_response(conn)?;
    if matrix
        .get("canonicalPlatform")
        .and_then(serde_json::Value::as_str)
        != Some("shared")
    {
        return Err(crate::error::AppError::detail(
            "SMOKE_COVERAGE_FAILED",
            "coverage matrix did not use shared as canonical platform",
            matrix,
        ));
    }
    let platforms = matrix
        .get("platforms")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if platforms != ["shared", "claude", "codex"] {
        return Err(crate::error::AppError::detail(
            "SMOKE_COVERAGE_FAILED",
            "coverage matrix platform ordering did not match packaged fixture",
            matrix,
        ));
    }
    let rows = matrix
        .get("rows")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            crate::error::AppError::detail(
                "SMOKE_COVERAGE_FAILED",
                "coverage matrix missing rows",
                matrix.clone(),
            )
        })?;
    let row_by_name = |name: &str| {
        rows.iter()
            .find(|row| row.get("skillName").and_then(serde_json::Value::as_str) == Some(name))
    };
    let Some(in_sync) = row_by_name("fixture-in-sync") else {
        return Err(crate::error::AppError::detail(
            "SMOKE_COVERAGE_FAILED",
            "coverage matrix missing fixture-in-sync row",
            matrix.clone(),
        ));
    };
    for platform_id in ["shared", "claude", "codex"] {
        if in_sync["cells"][platform_id]["state"].as_str() != Some("present")
            || in_sync["cells"][platform_id]["drift"].as_str() != Some("in_sync")
        {
            return Err(crate::error::AppError::detail(
                "SMOKE_COVERAGE_FAILED",
                "coverage matrix did not mark fixture-in-sync as present and in-sync everywhere",
                matrix.clone(),
            ));
        }
    }
    let Some(stale) = row_by_name("fixture-stale") else {
        return Err(crate::error::AppError::detail(
            "SMOKE_COVERAGE_FAILED",
            "coverage matrix missing fixture-stale row",
            matrix.clone(),
        ));
    };
    if stale["hasDrift"].as_bool() != Some(true)
        || stale["cells"]["claude"]["state"].as_str() != Some("present")
        || stale["cells"]["claude"]["drift"].as_str() != Some("stale")
    {
        return Err(crate::error::AppError::detail(
            "SMOKE_COVERAGE_FAILED",
            "coverage matrix did not mark fixture-stale as stale drift",
            matrix.clone(),
        ));
    }
    let Some(orphan) = row_by_name("fixture-claude-only") else {
        return Err(crate::error::AppError::detail(
            "SMOKE_COVERAGE_FAILED",
            "coverage matrix missing fixture-claude-only row",
            matrix.clone(),
        ));
    };
    if orphan["hasCanonicalSource"].as_bool() != Some(false)
        || orphan["cells"]["shared"]["state"].as_str() != Some("missing")
        || orphan["cells"]["claude"]["drift"].as_str() != Some("only_here")
    {
        return Err(crate::error::AppError::detail(
            "SMOKE_COVERAGE_FAILED",
            "coverage matrix did not mark fixture-claude-only as only-here orphan",
            matrix.clone(),
        ));
    }
    let Some(disabled) = row_by_name("fixture-disabled") else {
        return Err(crate::error::AppError::detail(
            "SMOKE_COVERAGE_FAILED",
            "coverage matrix missing fixture-disabled row",
            matrix.clone(),
        ));
    };
    if disabled["hasCanonicalSource"].as_bool() != Some(false)
        || disabled["cells"]["shared"]["state"].as_str() != Some("disabled")
    {
        return Err(crate::error::AppError::detail(
            "SMOKE_COVERAGE_FAILED",
            "coverage matrix did not mark fixture-disabled as disabled",
            matrix.clone(),
        ));
    }
    let rows_len = rows.len().to_string();
    for (key, value) in [
        ("smoke.coverage.matrix", "1"),
        ("smoke.coverage.rows", rows_len.as_str()),
    ] {
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
    }
    Ok(())
}

fn run_internal_smoke_workflows(conn: &mut rusqlite::Connection) -> AppResult<()> {
    for (key, value) in [
        ("allow_external_network", "0"),
        ("theme", "dark"),
        ("language", "zh"),
    ] {
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
    }

    let import_payload = serde_json::json!({
        "version": "1",
        "scenarios": [{
            "key": "packaged-smoke-import",
            "name": "Packaged Smoke Import",
            "description": "Imported by packaged workflow smoke.",
            "color": "#2563eb",
            "icon": "sparkles",
            "skills": [{ "name": "fixture-claude-only", "sourceKey": "local" }]
        }]
    });
    let imported = commands::scenarios_import_payload(conn, &import_payload)?;
    if imported
        .get("skillsLinked")
        .and_then(serde_json::Value::as_i64)
        != Some(1)
    {
        return Err(crate::error::AppError::detail(
            "SMOKE_WORKFLOW_FAILED",
            "scenario import did not link the expected fixture skill",
            imported,
        ));
    }

    let scenario_id: i64 = conn.query_row(
        "SELECT id FROM scenarios WHERE key = 'packaged-smoke-import'",
        [],
        |row| row.get(0),
    )?;
    conn.execute(
        "UPDATE scenarios
         SET name = 'Packaged Smoke Updated',
             description = 'Updated by packaged workflow smoke.'
         WHERE id = ?1",
        params![scenario_id],
    )?;
    conn.execute(
        "INSERT INTO scenarios (key, name, description, color, icon, sort_order, is_builtin, created_at)
         VALUES ('packaged-smoke-delete', 'Packaged Smoke Delete', 'delete me', '#111111', 'trash', 999, 0, ?1)",
        params![crate::db::now_ms()],
    )?;
    conn.execute(
        "DELETE FROM scenarios WHERE key = 'packaged-smoke-delete' AND is_builtin = 0",
        [],
    )?;

    let exported = commands::scenarios_export_response(conn)?;
    let exported_smoke = exported
        .get("scenarios")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|scenarios| {
            scenarios.iter().any(|scenario| {
                scenario.get("key").and_then(serde_json::Value::as_str)
                    == Some("packaged-smoke-import")
                    && scenario
                        .get("skills")
                        .and_then(serde_json::Value::as_array)
                        .is_some_and(|skills| {
                            skills.iter().any(|skill| {
                                skill.get("name").and_then(serde_json::Value::as_str)
                                    == Some("fixture-claude-only")
                            })
                        })
            })
        });
    if !exported_smoke {
        return Err(crate::error::AppError::detail(
            "SMOKE_WORKFLOW_FAILED",
            "scenario export did not include the imported fixture scenario",
            exported,
        ));
    }
    for (key, value) in [
        ("smoke.workflows.completed", "1"),
        ("smoke.scenarios.exported", "1"),
    ] {
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
    }
    Ok(())
}

fn hash_skill_md(skill_dir: &Path) -> String {
    let raw = std::fs::read(skill_dir.join("SKILL.md")).unwrap_or_default();
    hex::encode(sha2::Sha256::digest(raw))
}
