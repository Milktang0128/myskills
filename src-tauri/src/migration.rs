use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::Digest;

use crate::db::{init_pool, now_ms};
use crate::error::{AppError, AppResult};

pub const STABLE_CONFIRMATION_FILE: &str = "stable-migration-confirmation.json";

const REQUIRED_ELECTRON_TABLES: &[&str] = &[
    "platforms",
    "skills",
    "skill_locations",
    "scenarios",
    "skill_scenarios",
    "settings",
    "sync_history",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElectronMigrationCandidate {
    pub db_path: PathBuf,
    pub backup_root: Option<PathBuf>,
    pub size_bytes: u64,
    pub modified_at: Option<i64>,
    pub source_sha256: Option<String>,
    pub valid: bool,
    pub reason: Option<String>,
}

#[derive(Debug)]
pub struct StableMigrationReport {
    pub source_db: PathBuf,
    pub target_db: PathBuf,
    pub backup_db: PathBuf,
    pub source_sha256: String,
    pub migrated_at: i64,
}

#[derive(Debug)]
pub struct StableRollbackReport {
    pub failed_db: Option<PathBuf>,
    pub restored_db: Option<PathBuf>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StableMigrationConfirmation {
    pub source_db: PathBuf,
    pub backup_root: Option<PathBuf>,
    pub source_sha256: String,
    pub confirmed_at: Option<i64>,
}

pub fn confirmation_file_path(target_data_dir: &Path) -> PathBuf {
    target_data_dir.join(STABLE_CONFIRMATION_FILE)
}

pub fn write_stable_confirmation(
    target_data_dir: &Path,
    source_db: &Path,
    backup_root: Option<&Path>,
    source_sha256: &str,
    confirmed_at: i64,
) -> AppResult<PathBuf> {
    let confirmation = StableMigrationConfirmation {
        source_db: source_db.to_path_buf(),
        backup_root: backup_root.map(Path::to_path_buf),
        source_sha256: source_sha256.to_string(),
        confirmed_at: Some(confirmed_at),
    };
    validate_stable_confirmation(&confirmation)?;
    let actual_sha256 = sha256_file(source_db)?;
    if !actual_sha256.eq_ignore_ascii_case(source_sha256) {
        return Err(AppError::new(
            "MIGRATION_SOURCE_CHANGED",
            format!(
                "Electron DB hash changed after discovery: expected {source_sha256}, got {actual_sha256}"
            ),
        ));
    }
    fs::create_dir_all(target_data_dir)?;
    let path = confirmation_file_path(target_data_dir);
    let raw = serde_json::to_string_pretty(&confirmation).map_err(|err| {
        AppError::new(
            "MIGRATION_CONFIRMATION_INVALID",
            format!("Could not serialize migration confirmation: {err}"),
        )
    })?;
    fs::write(&path, raw)?;
    Ok(path)
}

pub fn prepare_confirmed_stable_import(
    confirmation_file: &Path,
    target_data_dir: &Path,
    timestamp_ms: i64,
) -> AppResult<StableMigrationReport> {
    let confirmation = read_stable_confirmation(confirmation_file)?;
    let actual_sha256 = sha256_file(&confirmation.source_db)?;
    if !actual_sha256.eq_ignore_ascii_case(&confirmation.source_sha256) {
        return Err(AppError::new(
            "MIGRATION_SOURCE_CHANGED",
            format!(
                "Electron DB hash changed after confirmation: expected {}, got {}",
                confirmation.source_sha256, actual_sha256
            ),
        ));
    }
    prepare_stable_import(
        &confirmation.source_db,
        confirmation.backup_root.as_deref(),
        target_data_dir,
        timestamp_ms,
    )
}

pub fn preserve_replaceable_target_db(
    target_data_dir: &Path,
    timestamp_ms: i64,
) -> AppResult<Option<PathBuf>> {
    let current_db = target_data_dir.join("myskills.db");
    if !current_db.exists() {
        return Ok(None);
    }
    if !target_db_is_replaceable(&current_db)? {
        return Err(AppError::new(
            "MIGRATION_TARGET_NOT_EMPTY",
            format!(
                "Tauri stable DB already contains user data at {}",
                current_db.display()
            ),
        ));
    }
    let preserved = target_data_dir.join(format!("myskills.db.pre-migration-{timestamp_ms}"));
    if preserved.exists() {
        fs::remove_file(&preserved)?;
    }
    fs::rename(&current_db, &preserved)?;
    Ok(Some(preserved))
}

pub fn stable_target_already_migrated(target_data_dir: &Path) -> AppResult<bool> {
    let target_db = target_data_dir.join("myskills.db");
    if !target_db.exists() {
        return Ok(false);
    }
    let conn = Connection::open_with_flags(target_db, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    migration_marker_exists(&conn)
}

pub fn prepare_stable_import(
    source_db: &Path,
    electron_backup_root: Option<&Path>,
    target_data_dir: &Path,
    timestamp_ms: i64,
) -> AppResult<StableMigrationReport> {
    if !source_db.is_file() {
        return Err(AppError::new(
            "MIGRATION_SOURCE_MISSING",
            format!("Electron DB not found at {}", source_db.display()),
        ));
    }

    fs::create_dir_all(target_data_dir)?;
    let target_db = target_data_dir.join("myskills.db");
    if target_db.exists() {
        return Err(AppError::new(
            "MIGRATION_TARGET_EXISTS",
            format!("Tauri stable DB already exists at {}", target_db.display()),
        ));
    }

    let source_conn = Connection::open_with_flags(source_db, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    validate_electron_db(&source_conn)?;
    drop(source_conn);

    let backup_set = target_data_dir
        .join("migration-backups")
        .join(format!("electron-{timestamp_ms}"));
    fs::create_dir_all(&backup_set)?;
    let backup_db = backup_set.join("myskills.db");
    vacuum_into(source_db, &backup_db)?;

    if let Some(old_backup_root) = electron_backup_root {
        if old_backup_root.is_dir() {
            copy_dir_recursive(old_backup_root, &backup_set.join("backups"))?;
        }
    }

    let importing_db = target_data_dir.join("myskills.db.importing");
    if importing_db.exists() {
        fs::remove_file(&importing_db)?;
    }
    fs::copy(&backup_db, &importing_db)?;

    let source_sha256 = sha256_file(source_db)?;
    let migrated_at = now_ms();

    {
        let pool = init_pool(&importing_db)?;
        let conn = pool.get()?;
        if let Some(old_backup_root) = electron_backup_root {
            if old_backup_root.is_dir() {
                rewrite_backup_paths(&conn, old_backup_root, &backup_set.join("backups"))?;
            }
        }
        insert_migration_markers(&conn, source_db, &source_sha256, migrated_at)?;
        validate_integrity(&conn)?;
    }

    fs::rename(&importing_db, &target_db)?;

    Ok(StableMigrationReport {
        source_db: source_db.to_path_buf(),
        target_db,
        backup_db,
        source_sha256,
        migrated_at,
    })
}

pub fn rollback_stable_import(
    target_data_dir: &Path,
    timestamp_ms: i64,
) -> AppResult<StableRollbackReport> {
    let current_db = target_data_dir.join("myskills.db");
    let failed_db = if current_db.exists() {
        let failed = target_data_dir.join(format!("myskills.db.failed-{timestamp_ms}"));
        if failed.exists() {
            fs::remove_file(&failed)?;
        }
        fs::rename(&current_db, &failed)?;
        Some(failed)
    } else {
        None
    };

    let restored_db = if let Some(pre_migration) = latest_pre_migration_db(target_data_dir)? {
        fs::rename(&pre_migration, &current_db)?;
        Some(current_db)
    } else {
        None
    };

    if failed_db.is_none() && restored_db.is_none() {
        return Err(AppError::new(
            "MIGRATION_ROLLBACK_EMPTY",
            format!("No Tauri stable DB found in {}", target_data_dir.display()),
        ));
    }

    Ok(StableRollbackReport {
        failed_db,
        restored_db,
    })
}

pub fn discover_electron_candidates(
    home_dir: &Path,
    extra_dirs: &[PathBuf],
) -> AppResult<Vec<ElectronMigrationCandidate>> {
    let mut dirs = default_electron_user_data_dirs(home_dir);
    dirs.extend(extra_dirs.iter().cloned());
    dirs.sort();
    dirs.dedup();

    let mut candidates = Vec::new();
    for dir in dirs {
        let db_path = dir.join("myskills.db");
        if !db_path.exists() {
            continue;
        }
        let metadata = fs::metadata(&db_path)?;
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64);
        let backup_root = dir.join("backups");
        let backup_root = backup_root.is_dir().then_some(backup_root);
        let mut source_sha256 = None;
        let validation =
            match Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
                Ok(conn) => match validate_electron_db(&conn) {
                    Ok(()) => match sha256_file(&db_path) {
                        Ok(hash) => {
                            source_sha256 = Some(hash);
                            Ok(())
                        }
                        Err(err) => Err(err),
                    },
                    Err(err) => Err(err),
                },
                Err(err) => Err(AppError::new("MIGRATION_DB_OPEN_FAILED", err.to_string())),
            };
        candidates.push(ElectronMigrationCandidate {
            db_path,
            backup_root,
            size_bytes: metadata.len(),
            modified_at,
            source_sha256,
            valid: validation.is_ok(),
            reason: validation
                .err()
                .map(|err| format!("{}: {}", err.code, err.message)),
        });
    }
    Ok(candidates)
}

fn read_stable_confirmation(path: &Path) -> AppResult<StableMigrationConfirmation> {
    let raw = fs::read_to_string(path).map_err(|err| {
        AppError::new(
            "MIGRATION_CONFIRMATION_MISSING",
            format!(
                "Could not read migration confirmation {}: {err}",
                path.display()
            ),
        )
    })?;
    let confirmation: StableMigrationConfirmation = serde_json::from_str(&raw).map_err(|err| {
        AppError::new(
            "MIGRATION_CONFIRMATION_INVALID",
            format!("Invalid migration confirmation {}: {err}", path.display()),
        )
    })?;
    validate_stable_confirmation(&confirmation)?;
    Ok(confirmation)
}

fn validate_stable_confirmation(confirmation: &StableMigrationConfirmation) -> AppResult<()> {
    if confirmation.source_db.as_os_str().is_empty() {
        return Err(AppError::new(
            "MIGRATION_CONFIRMATION_INVALID",
            "Migration confirmation is missing sourceDb",
        ));
    }
    if !confirmation.source_db.is_absolute() {
        return Err(AppError::new(
            "MIGRATION_CONFIRMATION_INVALID",
            "Migration confirmation sourceDb must be absolute",
        ));
    }
    if !is_sha256_hex(&confirmation.source_sha256) {
        return Err(AppError::new(
            "MIGRATION_CONFIRMATION_INVALID",
            "Migration confirmation sourceSha256 must be a SHA-256 hex digest",
        ));
    }
    if confirmation.confirmed_at.unwrap_or_default() <= 0 {
        return Err(AppError::new(
            "MIGRATION_CONFIRMATION_INVALID",
            "Migration confirmation must include confirmedAt",
        ));
    }
    Ok(())
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn target_db_is_replaceable(target_db: &Path) -> AppResult<bool> {
    let conn = Connection::open_with_flags(target_db, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    if migration_marker_exists(&conn)? {
        return Ok(false);
    }
    for (table, sql) in [
        ("skills", "SELECT COUNT(*) FROM skills"),
        ("skill_locations", "SELECT COUNT(*) FROM skill_locations"),
        (
            "scenarios",
            "SELECT COUNT(*) FROM scenarios WHERE is_builtin = 0",
        ),
        ("skill_scenarios", "SELECT COUNT(*) FROM skill_scenarios"),
        ("sync_history", "SELECT COUNT(*) FROM sync_history"),
    ] {
        if table_exists(&conn, table)? {
            let count: i64 = conn.query_row(sql, [], |row| row.get(0))?;
            if count > 0 {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

fn migration_marker_exists(conn: &Connection) -> AppResult<bool> {
    if !table_exists(conn, "settings")? {
        return Ok(false);
    }
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM settings WHERE key LIKE 'migration.electron_v0_1.%'",
        [],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn table_exists(conn: &Connection, table: &str) -> AppResult<bool> {
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![table],
        |row| row.get(0),
    )?;
    Ok(exists > 0)
}

fn default_electron_user_data_dirs(home_dir: &Path) -> Vec<PathBuf> {
    if cfg!(target_os = "macos") {
        vec![
            home_dir.join("Library/Application Support/MySkills"),
            home_dir.join("Library/Application Support/myskills"),
        ]
    } else if cfg!(target_os = "windows") {
        let mut dirs = vec![
            home_dir.join("AppData/Roaming/MySkills"),
            home_dir.join("AppData/Roaming/myskills"),
        ];
        if let Some(app_data) = std::env::var_os("APPDATA") {
            let app_data = PathBuf::from(app_data);
            dirs.push(app_data.join("MySkills"));
            dirs.push(app_data.join("myskills"));
        }
        dirs
    } else {
        let mut dirs = vec![
            home_dir.join(".config/MySkills"),
            home_dir.join(".config/myskills"),
        ];
        if let Some(xdg_config_home) = std::env::var_os("XDG_CONFIG_HOME") {
            let xdg_config_home = PathBuf::from(xdg_config_home);
            dirs.push(xdg_config_home.join("MySkills"));
            dirs.push(xdg_config_home.join("myskills"));
        }
        dirs
    }
}

fn validate_electron_db(conn: &Connection) -> AppResult<()> {
    validate_integrity(conn)?;
    for table in REQUIRED_ELECTRON_TABLES {
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![table],
            |row| row.get(0),
        )?;
        if exists == 0 {
            return Err(AppError::new(
                "MIGRATION_SCHEMA_INVALID",
                format!("Electron DB is missing required table `{table}`"),
            ));
        }
    }
    Ok(())
}

fn validate_integrity(conn: &Connection) -> AppResult<()> {
    let result: String = conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    if result == "ok" {
        Ok(())
    } else {
        Err(AppError::new(
            "MIGRATION_DB_CORRUPT",
            format!("SQLite integrity_check failed: {result}"),
        ))
    }
}

fn vacuum_into(source_db: &Path, dest_db: &Path) -> AppResult<()> {
    if let Some(parent) = dest_db.parent() {
        fs::create_dir_all(parent)?;
    }
    if dest_db.exists() {
        fs::remove_file(dest_db)?;
    }
    let conn = Connection::open_with_flags(source_db, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    conn.execute("VACUUM INTO ?1", params![dest_db.to_string_lossy()])?;
    Ok(())
}

fn rewrite_backup_paths(conn: &Connection, old_root: &Path, new_root: &Path) -> AppResult<usize> {
    let mut stmt = conn.prepare(
        "SELECT id, backup_path FROM sync_history
         WHERE backup_path IS NOT NULL AND backup_path != ''",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut rewritten = 0;
    for row in rows {
        let (id, backup_path) = row?;
        let backup = PathBuf::from(&backup_path);
        let Ok(relative) = backup.strip_prefix(old_root) else {
            continue;
        };
        let next_path = new_root.join(relative);
        conn.execute(
            "UPDATE sync_history SET backup_path = ?1 WHERE id = ?2",
            params![next_path.to_string_lossy(), id],
        )?;
        rewritten += 1;
    }
    Ok(rewritten)
}

fn insert_migration_markers(
    conn: &Connection,
    source_db: &Path,
    source_sha256: &str,
    migrated_at: i64,
) -> AppResult<()> {
    for (key, value) in [
        (
            "migration.electron_v0_1.source_path",
            source_db.to_string_lossy().to_string(),
        ),
        (
            "migration.electron_v0_1.source_sha256",
            source_sha256.to_string(),
        ),
        (
            "migration.electron_v0_1.migrated_at",
            migrated_at.to_string(),
        ),
    ] {
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
    }
    Ok(())
}

fn sha256_file(path: &Path) -> AppResult<String> {
    let bytes = fs::read(path)?;
    Ok(hex::encode(sha2::Sha256::digest(bytes)))
}

fn copy_dir_recursive(source: &Path, dest: &Path) -> AppResult<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_dir_recursive(&source_path, &dest_path)?;
        } else if file_type.is_file() {
            if let Some(parent) = dest_path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&source_path, &dest_path)?;
        } else if file_type.is_symlink() {
            let target = fs::read_link(&source_path)?;
            create_symlink(&target, &dest_path)?;
        }
    }
    Ok(())
}

fn latest_pre_migration_db(target_data_dir: &Path) -> AppResult<Option<PathBuf>> {
    if !target_data_dir.is_dir() {
        return Ok(None);
    }
    let mut candidates = Vec::new();
    for entry in fs::read_dir(target_data_dir)? {
        let entry = entry?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.starts_with("myskills.db.pre-migration-") && path.is_file() {
            candidates.push(path);
        }
    }
    candidates.sort();
    Ok(candidates.pop())
}

#[cfg(unix)]
fn create_symlink(target: &Path, link: &Path) -> AppResult<()> {
    std::os::unix::fs::symlink(target, link)?;
    Ok(())
}

#[cfg(windows)]
fn create_symlink(target: &Path, link: &Path) -> AppResult<()> {
    if target.is_dir() {
        std::os::windows::fs::symlink_dir(target, link)?;
    } else {
        std::os::windows::fs::symlink_file(target, link)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("myskills-migration-test-{name}-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn create_source_db(db_path: &Path) {
        let pool = init_pool(db_path).expect("init source db");
        let conn = pool.get().expect("source conn");
        conn.execute(
            "INSERT INTO sync_history
             (skill_id, action, backup_path, success, message, created_at)
             VALUES ('skill-1', 'symlink_replace', ?1, 1, 'ok', ?2)",
            params!["/placeholder/backups/skill-1", now_ms()],
        )
        .expect("insert history");
    }

    fn write_confirmation(
        confirmation_file: &Path,
        source_db: &Path,
        backup_root: Option<&Path>,
        source_sha256: &str,
    ) {
        let backup_root_json = backup_root.map(|path| path.to_string_lossy().to_string());
        fs::write(
            confirmation_file,
            serde_json::json!({
                "sourceDb": source_db.to_string_lossy(),
                "backupRoot": backup_root_json,
                "sourceSha256": source_sha256,
                "confirmedAt": 123
            })
            .to_string(),
        )
        .expect("write confirmation");
    }

    #[test]
    fn stable_import_copies_db_marks_source_and_rewrites_backup_paths() {
        let root = temp_dir("happy");
        let electron_dir = root.join("electron");
        let target_dir = root.join("tauri-stable");
        let old_backup_root = electron_dir.join("backups");
        let old_backup_item = old_backup_root.join("skill-1");
        fs::create_dir_all(&old_backup_item).unwrap();
        fs::write(old_backup_item.join("SKILL.md"), "backup").unwrap();

        let source_db = electron_dir.join("myskills.db");
        fs::create_dir_all(&electron_dir).unwrap();
        create_source_db(&source_db);
        {
            let conn = Connection::open(&source_db).unwrap();
            conn.execute(
                "UPDATE sync_history SET backup_path = ?1 WHERE skill_id = 'skill-1'",
                params![old_backup_item.to_string_lossy()],
            )
            .unwrap();
        }

        let report =
            prepare_stable_import(&source_db, Some(&old_backup_root), &target_dir, 123).unwrap();

        assert_eq!(report.source_db, source_db);
        assert_eq!(report.target_db, target_dir.join("myskills.db"));
        assert!(report.target_db.exists());
        assert!(report.backup_db.exists());
        assert!(!target_dir.join("myskills.db.importing").exists());
        assert!(!report.source_sha256.is_empty());
        assert!(report.migrated_at > 0);

        let conn = Connection::open(&report.target_db).unwrap();
        let marker: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'migration.electron_v0_1.source_path'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(marker, source_db.to_string_lossy());
        let backup_path: String = conn
            .query_row(
                "SELECT backup_path FROM sync_history WHERE skill_id = 'skill-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(backup_path.starts_with(
            target_dir
                .join("migration-backups/electron-123/backups")
                .to_string_lossy()
                .as_ref()
        ));
        assert!(Path::new(&backup_path).join("SKILL.md").exists());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn confirmed_stable_import_requires_matching_source_hash() {
        let root = temp_dir("confirmed-hash");
        let electron_dir = root.join("electron");
        let target_dir = root.join("tauri-stable");
        fs::create_dir_all(&electron_dir).unwrap();
        let source_db = electron_dir.join("myskills.db");
        create_source_db(&source_db);
        let confirmation = root.join("confirmation.json");
        write_confirmation(
            &confirmation,
            &source_db,
            None,
            "0000000000000000000000000000000000000000000000000000000000000000",
        );

        let err = prepare_confirmed_stable_import(&confirmation, &target_dir, 123).unwrap_err();

        assert_eq!(err.code, "MIGRATION_SOURCE_CHANGED");
        assert!(!target_dir.join("myskills.db").exists());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn confirmed_stable_import_uses_confirmation_manifest() {
        let root = temp_dir("confirmed-import");
        let electron_dir = root.join("electron");
        let target_dir = root.join("tauri-stable");
        let backup_root = electron_dir.join("backups");
        fs::create_dir_all(&backup_root).unwrap();
        fs::create_dir_all(&electron_dir).unwrap();
        let source_db = electron_dir.join("myskills.db");
        create_source_db(&source_db);
        let source_hash = sha256_file(&source_db).unwrap();
        let confirmation = root.join("confirmation.json");
        write_confirmation(&confirmation, &source_db, Some(&backup_root), &source_hash);

        let report = prepare_confirmed_stable_import(&confirmation, &target_dir, 123).unwrap();

        assert_eq!(report.source_db, source_db);
        assert_eq!(report.source_sha256, source_hash);
        assert!(target_dir.join("myskills.db").exists());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn write_stable_confirmation_rejects_changed_source_hash() {
        let root = temp_dir("write-confirm-changed");
        let electron_dir = root.join("electron");
        fs::create_dir_all(&electron_dir).unwrap();
        let source_db = electron_dir.join("myskills.db");
        create_source_db(&source_db);

        let err = write_stable_confirmation(
            &root.join("target"),
            &source_db,
            None,
            "0000000000000000000000000000000000000000000000000000000000000000",
            123,
        )
        .unwrap_err();

        assert_eq!(err.code, "MIGRATION_SOURCE_CHANGED");
        assert!(!confirmation_file_path(&root.join("target")).exists());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn preserve_replaceable_target_db_only_allows_empty_tauri_db() {
        let root = temp_dir("preserve-empty");
        let target_dir = root.join("target");
        fs::create_dir_all(&target_dir).unwrap();
        let target_db = target_dir.join("myskills.db");
        init_pool(&target_db).unwrap();

        let preserved = preserve_replaceable_target_db(&target_dir, 123).unwrap();

        assert_eq!(
            preserved.as_deref(),
            Some(target_dir.join("myskills.db.pre-migration-123").as_path())
        );
        assert!(!target_db.exists());
        assert!(target_dir.join("myskills.db.pre-migration-123").exists());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn preserve_replaceable_target_db_rejects_user_data() {
        let root = temp_dir("preserve-user-data");
        let target_dir = root.join("target");
        fs::create_dir_all(&target_dir).unwrap();
        let target_db = target_dir.join("myskills.db");
        let pool = init_pool(&target_db).unwrap();
        let conn = pool.get().unwrap();
        conn.execute(
            "INSERT INTO skills
             (id, name, source_key, content_hash, created_at, updated_at, last_scanned_at)
             VALUES ('skill-1', 'Skill 1', 'local', 'hash', 1, 1, 1)",
            [],
        )
        .unwrap();
        drop(conn);
        drop(pool);

        let err = preserve_replaceable_target_db(&target_dir, 123).unwrap_err();

        assert_eq!(err.code, "MIGRATION_TARGET_NOT_EMPTY");
        assert!(target_db.exists());
        assert!(!target_dir.join("myskills.db.pre-migration-123").exists());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn stable_import_refuses_to_replace_existing_tauri_db() {
        let root = temp_dir("target-exists");
        let electron_dir = root.join("electron");
        let target_dir = root.join("tauri-stable");
        fs::create_dir_all(&electron_dir).unwrap();
        fs::create_dir_all(&target_dir).unwrap();
        let source_db = electron_dir.join("myskills.db");
        create_source_db(&source_db);
        fs::write(target_dir.join("myskills.db"), "existing").unwrap();

        let err = prepare_stable_import(&source_db, None, &target_dir, 123).unwrap_err();

        assert_eq!(err.code, "MIGRATION_TARGET_EXISTS");
        assert_eq!(
            fs::read_to_string(target_dir.join("myskills.db")).unwrap(),
            "existing"
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn stable_import_rejects_invalid_source_schema() {
        let root = temp_dir("invalid-schema");
        let source_db = root.join("electron").join("myskills.db");
        fs::create_dir_all(source_db.parent().unwrap()).unwrap();
        let conn = Connection::open(&source_db).unwrap();
        conn.execute("CREATE TABLE platforms (id TEXT PRIMARY KEY)", [])
            .unwrap();
        drop(conn);

        let err = prepare_stable_import(&source_db, None, &root.join("target"), 123).unwrap_err();

        assert_eq!(err.code, "MIGRATION_SCHEMA_INVALID");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn discover_electron_candidates_reports_valid_and_invalid_without_mutation() {
        let root = temp_dir("discover");
        let home = root.join("home");
        let valid_dir = home.join("Library/Application Support/MySkills");
        let invalid_dir = root.join("custom-invalid");
        fs::create_dir_all(&valid_dir).unwrap();
        fs::create_dir_all(&invalid_dir).unwrap();

        let valid_db = valid_dir.join("myskills.db");
        create_source_db(&valid_db);
        fs::create_dir_all(valid_dir.join("backups")).unwrap();
        let valid_hash = sha256_file(&valid_db).unwrap();

        let invalid_db = invalid_dir.join("myskills.db");
        Connection::open(&invalid_db)
            .unwrap()
            .execute("CREATE TABLE platforms (id TEXT PRIMARY KEY)", [])
            .unwrap();

        let candidates =
            discover_electron_candidates(&home, &[invalid_dir.clone(), invalid_dir.clone()])
                .unwrap();
        assert_eq!(
            candidates
                .iter()
                .filter(|candidate| candidate.db_path == invalid_db)
                .count(),
            1
        );

        let valid = candidates
            .iter()
            .find(|candidate| candidate.db_path == valid_db)
            .expect("valid candidate");
        assert!(valid.valid);
        assert_eq!(valid.source_sha256.as_deref(), Some(valid_hash.as_str()));
        assert_eq!(valid.backup_root, Some(valid_dir.join("backups")));
        assert_eq!(sha256_file(&valid_db).unwrap(), valid_hash);

        let invalid = candidates
            .iter()
            .find(|candidate| candidate.db_path == invalid_db)
            .expect("invalid candidate");
        assert!(!invalid.valid);
        assert!(invalid
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("MIGRATION_SCHEMA_INVALID")));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn rewrite_backup_paths_leaves_unknown_external_paths_unchanged() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE sync_history (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              backup_path TEXT
            );
            INSERT INTO sync_history (backup_path) VALUES ('/external/backup/skill');
            "#,
        )
        .unwrap();

        assert_eq!(
            rewrite_backup_paths(&conn, Path::new("/old/backups"), Path::new("/new/backups"))
                .unwrap(),
            0
        );
        let backup_path: String = conn
            .query_row(
                "SELECT backup_path FROM sync_history WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(backup_path, "/external/backup/skill");
    }

    #[test]
    fn rollback_stable_import_moves_current_db_to_failed_backup() {
        let root = temp_dir("rollback-current");
        let target_dir = root.join("tauri-stable");
        fs::create_dir_all(&target_dir).unwrap();
        fs::write(target_dir.join("myskills.db"), "current").unwrap();

        let report = rollback_stable_import(&target_dir, 456).unwrap();

        let failed = target_dir.join("myskills.db.failed-456");
        assert_eq!(report.failed_db.as_deref(), Some(failed.as_path()));
        assert!(report.restored_db.is_none());
        assert_eq!(fs::read_to_string(failed).unwrap(), "current");
        assert!(!target_dir.join("myskills.db").exists());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn rollback_stable_import_restores_latest_pre_migration_db() {
        let root = temp_dir("rollback-restore");
        let target_dir = root.join("tauri-stable");
        fs::create_dir_all(&target_dir).unwrap();
        fs::write(target_dir.join("myskills.db"), "current").unwrap();
        fs::write(target_dir.join("myskills.db.pre-migration-001"), "old").unwrap();
        fs::write(target_dir.join("myskills.db.pre-migration-999"), "newest").unwrap();

        let report = rollback_stable_import(&target_dir, 456).unwrap();

        assert!(report.failed_db.is_some());
        assert_eq!(
            report.restored_db.as_deref(),
            Some(target_dir.join("myskills.db").as_path())
        );
        assert_eq!(
            fs::read_to_string(target_dir.join("myskills.db")).unwrap(),
            "newest"
        );
        assert_eq!(
            fs::read_to_string(target_dir.join("myskills.db.failed-456")).unwrap(),
            "current"
        );
        assert!(target_dir.join("myskills.db.pre-migration-001").exists());
        assert!(!target_dir.join("myskills.db.pre-migration-999").exists());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn rollback_stable_import_reports_empty_target() {
        let root = temp_dir("rollback-empty");
        let err = rollback_stable_import(&root.join("missing"), 456).unwrap_err();

        assert_eq!(err.code, "MIGRATION_ROLLBACK_EMPTY");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn stable_migration_drill_imports_copy_and_rolls_back_without_source_mutation() {
        let root = temp_dir("drill");
        let electron_dir = root.join("electron");
        let target_dir = root.join("tauri-stable");
        let old_backup_root = electron_dir.join("backups");
        let old_backup_item = old_backup_root.join("skill-1");
        fs::create_dir_all(&old_backup_item).unwrap();
        fs::write(old_backup_item.join("SKILL.md"), "original backup").unwrap();

        let source_db = electron_dir.join("myskills.db");
        fs::create_dir_all(&electron_dir).unwrap();
        create_source_db(&source_db);
        {
            let conn = Connection::open(&source_db).unwrap();
            conn.execute(
                "UPDATE sync_history SET backup_path = ?1 WHERE skill_id = 'skill-1'",
                params![old_backup_item.to_string_lossy()],
            )
            .unwrap();
        }
        let source_hash_before = sha256_file(&source_db).unwrap();

        let import = prepare_stable_import(&source_db, Some(&old_backup_root), &target_dir, 111)
            .expect("stable import should succeed");

        assert_eq!(sha256_file(&source_db).unwrap(), source_hash_before);
        assert!(source_db.exists());
        assert!(old_backup_item.join("SKILL.md").exists());
        assert!(import.target_db.exists());
        assert!(import.backup_db.exists());
        assert!(target_dir
            .join("migration-backups/electron-111/backups/skill-1/SKILL.md")
            .exists());

        let imported_backup_path: String = Connection::open(&import.target_db)
            .unwrap()
            .query_row(
                "SELECT backup_path FROM sync_history WHERE skill_id = 'skill-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(imported_backup_path.starts_with(
            target_dir
                .join("migration-backups/electron-111/backups")
                .to_string_lossy()
                .as_ref()
        ));

        let rollback = rollback_stable_import(&target_dir, 222).expect("rollback should succeed");

        assert!(rollback.restored_db.is_none());
        assert_eq!(
            rollback.failed_db.as_deref(),
            Some(target_dir.join("myskills.db.failed-222").as_path())
        );
        assert!(!target_dir.join("myskills.db").exists());
        assert!(target_dir.join("myskills.db.failed-222").exists());
        assert!(import.backup_db.exists());
        assert!(target_dir
            .join("migration-backups/electron-111/backups/skill-1/SKILL.md")
            .exists());
        assert_eq!(sha256_file(&source_db).unwrap(), source_hash_before);
        assert!(old_backup_item.join("SKILL.md").exists());
        fs::remove_dir_all(root).ok();
    }
}
