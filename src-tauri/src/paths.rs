use std::fs;
use std::path::PathBuf;

use crate::error::AppResult;

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub struct AppPaths {
    pub user_data_dir: PathBuf,
    pub db_path: PathBuf,
    pub staging_root: PathBuf,
    pub backup_root: PathBuf,
}

impl AppPaths {
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
