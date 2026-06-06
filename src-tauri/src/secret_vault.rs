use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use argon2::Argon2;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};
use crate::paths::AppPaths;

const VAULT_VERSION: u8 = 1;
const VAULT_DIR: &str = "secrets";
const VAULT_FILE: &str = "vault.json";
const SALT_FILE: &str = "vault.salt";
const NONCE_LEN: usize = 24;
const SALT_LEN: usize = 32;
const KEY_LEN: usize = 32;

#[derive(Default, Serialize, Deserialize)]
struct VaultFile {
    version: u8,
    kdf: String,
    cipher: String,
    secrets: BTreeMap<String, VaultEntry>,
}

#[derive(Clone, Serialize, Deserialize)]
struct VaultEntry {
    nonce: String,
    ciphertext: String,
}

pub fn write(paths: &AppPaths, name: &str, value: &str) -> AppResult<()> {
    validate_name(name)?;
    let mut vault = load_vault(paths)?;
    let key = derive_key(paths)?;
    let cipher = XChaCha20Poly1305::new((&key).into());
    let nonce_bytes = random_bytes::<NONCE_LEN>();
    let nonce = XNonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(
            nonce,
            Payload {
                msg: value.as_bytes(),
                aad: name.as_bytes(),
            },
        )
        .map_err(|err| AppError::new("SECRET_VAULT_ERROR", format!("encrypt failed: {err}")))?;
    vault.secrets.insert(
        name.to_string(),
        VaultEntry {
            nonce: STANDARD.encode(nonce_bytes),
            ciphertext: STANDARD.encode(ciphertext),
        },
    );
    save_vault(paths, &vault)
}

pub fn read(paths: &AppPaths, name: &str) -> AppResult<Option<String>> {
    validate_name(name)?;
    let vault = load_vault(paths)?;
    let Some(entry) = vault.secrets.get(name) else {
        return Ok(None);
    };
    let key = derive_key(paths)?;
    let cipher = XChaCha20Poly1305::new((&key).into());
    let nonce = STANDARD
        .decode(entry.nonce.as_bytes())
        .map_err(|err| AppError::new("SECRET_VAULT_ERROR", format!("invalid nonce: {err}")))?;
    if nonce.len() != NONCE_LEN {
        return Err(AppError::new("SECRET_VAULT_ERROR", "invalid nonce length"));
    }
    let ciphertext = STANDARD
        .decode(entry.ciphertext.as_bytes())
        .map_err(|err| AppError::new("SECRET_VAULT_ERROR", format!("invalid ciphertext: {err}")))?;
    let plaintext = cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: name.as_bytes(),
            },
        )
        .map_err(|_| AppError::new("SECRET_VAULT_ERROR", "secret vault decrypt failed"))?;
    String::from_utf8(plaintext)
        .map(Some)
        .map_err(|err| AppError::new("SECRET_VAULT_ERROR", format!("secret is not UTF-8: {err}")))
}

pub fn delete(paths: &AppPaths, name: &str) -> AppResult<()> {
    validate_name(name)?;
    let mut vault = load_vault(paths)?;
    vault.secrets.remove(name);
    save_vault(paths, &vault)
}

pub fn contains(paths: &AppPaths, name: &str) -> AppResult<bool> {
    validate_name(name)?;
    Ok(load_vault(paths)?.secrets.contains_key(name))
}

fn load_vault(paths: &AppPaths) -> AppResult<VaultFile> {
    let path = vault_path(paths);
    if !path.exists() {
        return Ok(empty_vault());
    }
    let contents = fs::read_to_string(&path)?;
    let vault = serde_json::from_str::<VaultFile>(&contents)
        .map_err(|err| AppError::new("SECRET_VAULT_ERROR", format!("invalid vault file: {err}")))?;
    if vault.version != VAULT_VERSION {
        return Err(AppError::new(
            "SECRET_VAULT_ERROR",
            format!("unsupported secret vault version {}", vault.version),
        ));
    }
    Ok(vault)
}

fn save_vault(paths: &AppPaths, vault: &VaultFile) -> AppResult<()> {
    let dir = vault_dir(paths);
    fs::create_dir_all(&dir)?;
    secure_dir_permissions(&dir)?;
    let path = vault_path(paths);
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(vault)
        .map_err(|err| AppError::new("SECRET_VAULT_ERROR", err.to_string()))?;
    {
        let mut file = create_secure_file(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, &path)?;
    secure_file_permissions(&path)?;
    Ok(())
}

fn empty_vault() -> VaultFile {
    VaultFile {
        version: VAULT_VERSION,
        kdf: "argon2id".to_string(),
        cipher: "xchacha20poly1305".to_string(),
        secrets: BTreeMap::new(),
    }
}

fn derive_key(paths: &AppPaths) -> AppResult<[u8; KEY_LEN]> {
    let salt = read_or_create_salt(paths)?;
    let material = vault_password_material(paths);
    let mut key = [0u8; KEY_LEN];
    Argon2::default()
        .hash_password_into(material.as_bytes(), &salt, &mut key)
        .map_err(|err| {
            AppError::new(
                "SECRET_VAULT_ERROR",
                format!("key derivation failed: {err}"),
            )
        })?;
    Ok(key)
}

fn vault_password_material(paths: &AppPaths) -> String {
    if let Ok(value) = std::env::var("MYSKILLS_SECRET_VAULT_PASSWORD") {
        if !value.trim().is_empty() {
            return value;
        }
    }
    let home = dirs::home_dir()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default();
    let data_dir = paths.user_data_dir.to_string_lossy();
    let digest = Sha256::digest(format!("myskills:vault:v1:{user}:{home}:{data_dir}").as_bytes());
    STANDARD.encode(digest)
}

fn read_or_create_salt(paths: &AppPaths) -> AppResult<Vec<u8>> {
    let dir = vault_dir(paths);
    fs::create_dir_all(&dir)?;
    secure_dir_permissions(&dir)?;
    let path = salt_path(paths);
    if path.exists() {
        let salt = fs::read(&path)?;
        if salt.len() == SALT_LEN {
            return Ok(salt);
        }
        return Err(AppError::new(
            "SECRET_VAULT_ERROR",
            "invalid vault salt length",
        ));
    }
    let salt = random_bytes::<SALT_LEN>();
    {
        let mut file = create_secure_file(&path)?;
        file.write_all(&salt)?;
        file.sync_all()?;
    }
    secure_file_permissions(&path)?;
    Ok(salt.to_vec())
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

fn validate_name(name: &str) -> AppResult<()> {
    if name.trim().is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.chars().any(char::is_whitespace)
    {
        return Err(AppError::new("INVALID_INPUT", "invalid secret name"));
    }
    Ok(())
}

fn vault_dir(paths: &AppPaths) -> PathBuf {
    paths.user_data_dir.join(VAULT_DIR)
}

fn vault_path(paths: &AppPaths) -> PathBuf {
    vault_dir(paths).join(VAULT_FILE)
}

fn salt_path(paths: &AppPaths) -> PathBuf {
    vault_dir(paths).join(SALT_FILE)
}

fn create_secure_file(path: &Path) -> AppResult<fs::File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        Ok(fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(path)?)
    }
    #[cfg(not(unix))]
    {
        Ok(fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(path)?)
    }
}

fn secure_file_permissions(path: &Path) -> AppResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn secure_dir_permissions(path: &Path) -> AppResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_paths() -> AppPaths {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        AppPaths::new(std::env::temp_dir().join(format!("myskills-vault-test-{unique}")))
            .expect("app paths")
    }

    #[test]
    fn vault_round_trips_secret_without_plaintext_file_content() {
        let paths = temp_paths();
        write(&paths, "llm.apiKey", "sk-test-secret").expect("write");

        let value = read(&paths, "llm.apiKey").expect("read");
        assert_eq!(value.as_deref(), Some("sk-test-secret"));
        assert!(contains(&paths, "llm.apiKey").expect("contains"));

        let raw = fs::read_to_string(vault_path(&paths)).expect("vault contents");
        assert!(!raw.contains("sk-test-secret"));
    }

    #[test]
    fn vault_delete_removes_secret_record() {
        let paths = temp_paths();
        write(&paths, "llm.apiKey", "sk-test-secret").expect("write");
        delete(&paths, "llm.apiKey").expect("delete");

        assert!(!contains(&paths, "llm.apiKey").expect("contains"));
        assert_eq!(read(&paths, "llm.apiKey").expect("read"), None);
    }
}
