mod commands;
mod db;
mod error;
mod paths;
mod scanner;
mod state;

use r2d2_sqlite::SqliteConnectionManager;
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
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|err| crate::error::AppError::new("PATH_ERROR", err.to_string()))?;
    let paths = AppPaths::new(app_data)?;
    let db = db::init_pool(&paths.db_path)?;
    if let Ok(conn) = db.get() {
        let _ = commands::recover_pending_history(&conn);
        if let Ok(days) = commands::backup_retention_days(&conn) {
            let _ = commands::cleanup_old_backups(&conn, &paths.backup_root, days);
        }
    }
    let _manager = SqliteConnectionManager::file(&paths.db_path);
    Ok(AppState {
        paths,
        db,
        last_scan: std::sync::Mutex::new(None),
        plan_store: std::sync::Mutex::new(std::collections::HashMap::new()),
        sync_lock: std::sync::Mutex::new(()),
    })
}
