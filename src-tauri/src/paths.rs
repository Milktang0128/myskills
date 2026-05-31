use std::fs;
use std::path::PathBuf;

use crate::error::AppResult;

pub const TAURI_PREVIEW_DATA_DIR_NAME: &str = "myskills-tauri-preview";

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub struct AppPaths {
    pub user_data_dir: PathBuf,
    pub db_path: PathBuf,
    pub staging_root: PathBuf,
    pub backup_root: PathBuf,
}

impl AppPaths {
    pub fn isolated_preview_dir(default_app_data_dir: PathBuf) -> PathBuf {
        if default_app_data_dir
            .file_name()
            .is_some_and(|name| name == TAURI_PREVIEW_DATA_DIR_NAME)
        {
            return default_app_data_dir;
        }
        default_app_data_dir
            .parent()
            .map(|parent| parent.join(TAURI_PREVIEW_DATA_DIR_NAME))
            .unwrap_or_else(|| default_app_data_dir.join(TAURI_PREVIEW_DATA_DIR_NAME))
    }

    pub fn new(user_data_dir: PathBuf) -> AppResult<Self> {
        fs::create_dir_all(&user_data_dir)?;
        let staging_root = user_data_dir.join("staging");
        let backup_root = user_data_dir.join("backups");
        fs::create_dir_all(&staging_root)?;
        fs::create_dir_all(&backup_root)?;
        Ok(Self {
            db_path: user_data_dir.join("myskills.db"),
            user_data_dir,
            staging_root,
            backup_root,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn preview_dir_is_sibling_of_tauri_default_app_data_dir() {
        let base = PathBuf::from("/Users/example/Library/Application Support/myskills");
        assert_eq!(
            AppPaths::isolated_preview_dir(base),
            Path::new("/Users/example/Library/Application Support")
                .join(TAURI_PREVIEW_DATA_DIR_NAME)
        );
    }

    #[test]
    fn preview_dir_is_idempotent() {
        let base = PathBuf::from("/tmp").join(TAURI_PREVIEW_DATA_DIR_NAME);
        assert_eq!(AppPaths::isolated_preview_dir(base.clone()), base);
    }
}
