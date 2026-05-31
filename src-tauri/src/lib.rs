mod commands;
mod db;
mod error;
#[allow(dead_code)]
mod migration;
mod paths;
mod scanner;
mod state;

use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::params;
use std::path::Path;
use tauri::Manager;

use crate::error::AppResult;
use crate::paths::AppPaths;
use crate::state::AppState;

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
    let paths = AppPaths::new(AppPaths::isolated_preview_dir(default_app_data))?;
    let db = db::init_pool(&paths.db_path)?;
    let mut last_scan = None;
    if let Ok(conn) = db.get() {
        let _ = commands::recover_pending_backups(&conn);
        let _ = commands::recover_pending_history(&conn);
        if let Ok(days) = commands::backup_retention_days(&conn) {
            let _ = commands::cleanup_old_backups(&conn, &paths.backup_root, days);
        }
        if let Some(scan) = apply_internal_smoke_fixture(&conn)? {
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
