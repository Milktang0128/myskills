use std::fs;
use std::path::Path;

use sha2::{Digest, Sha256};
use walkdir::WalkDir;
use yaml_rust2::YamlLoader;

use crate::error::{AppError, AppResult};

const SKILL_MD_MAX_BYTES: u64 = 1024 * 1024;
const EXCERPT_CHARS: usize = 500;

#[derive(Debug)]
pub struct ParsedSkill {
    pub name: String,
    pub description: Option<String>,
    pub version: Option<String>,
    pub author: Option<String>,
    pub license: Option<String>,
    pub body_excerpt: Option<String>,
    pub content_hash: String,
    pub size_bytes: i64,
    pub file_count: i64,
    pub mtime: i64,
    /// Filesystem creation time (birthtime) of SKILL.md, ms. Falls back to
    /// mtime when the platform/FS doesn't expose a birthtime. Drives the
    /// "recently added" sort so it reflects real file age, not scan time.
    pub birthtime: i64,
}

pub fn parse_skill_dir(dir: &Path) -> AppResult<Option<ParsedSkill>> {
    let skill_md = dir.join("SKILL.md");
    if !skill_md.exists() {
        if dir.join(".SKILL.md.icloud").exists() {
            return Err(AppError::new(
                "ICLOUD_EVICTED",
                format!("SKILL.md at {} is offloaded to iCloud", dir.display()),
            ));
        }
        return Ok(None);
    }

    let meta = fs::metadata(&skill_md)?;
    if !meta.is_file() {
        return Ok(None);
    }
    if meta.len() > SKILL_MD_MAX_BYTES {
        return Err(AppError::new(
            "TOO_LARGE",
            format!("SKILL.md at {} exceeds 1MB", dir.display()),
        ));
    }

    let raw = fs::read_to_string(&skill_md)?;
    let mut parsed = parse_skill_markdown(&raw)?;
    let (size_bytes, file_count) = measure_dir(dir);
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default();
    let birthtime = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .filter(|&ms| ms > 0)
        .unwrap_or(mtime);
    parsed.size_bytes = size_bytes;
    parsed.file_count = file_count;
    parsed.mtime = mtime;
    parsed.birthtime = birthtime;

    Ok(Some(parsed))
}

pub fn parse_skill_markdown(raw: &str) -> AppResult<ParsedSkill> {
    if raw.len() as u64 > SKILL_MD_MAX_BYTES {
        return Err(AppError::new("TOO_LARGE", "SKILL.md exceeds 1MB"));
    }
    let normalized = raw.replace("\r\n", "\n");
    let hash = hex::encode(Sha256::digest(normalized.as_bytes()));
    let (frontmatter, body) = split_frontmatter(&normalized)
        .ok_or_else(|| AppError::new("MISSING_FRONTMATTER", "SKILL.md is missing frontmatter"))?;
    let yaml = YamlLoader::load_from_str(frontmatter)
        .map_err(|err| AppError::new("PARSE_ERROR", format!("invalid frontmatter: {err}")))?;
    let doc = yaml
        .first()
        .ok_or_else(|| AppError::new("PARSE_ERROR", "empty frontmatter"))?;
    let name = doc["name"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::new("MISSING_FRONTMATTER", "frontmatter.name is required"))?
        .to_string();
    let metadata = &doc["metadata"];
    Ok(ParsedSkill {
        name,
        description: str_or_null(&doc["description"]),
        version: str_or_null(&doc["version"]).or_else(|| str_or_null(&metadata["version"])),
        author: str_or_null(&doc["author"]).or_else(|| str_or_null(&metadata["author"])),
        license: str_or_null(&doc["license"]),
        body_excerpt: excerpt(body),
        content_hash: hash,
        size_bytes: normalized.len() as i64,
        file_count: 1,
        mtime: 0,
        birthtime: 0,
    })
}

fn split_frontmatter(raw: &str) -> Option<(&str, &str)> {
    let rest = raw.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    let fm = &rest[..end];
    let body_start = end + "\n---".len();
    let body = rest[body_start..]
        .strip_prefix('\n')
        .unwrap_or(&rest[body_start..]);
    Some((fm, body))
}

fn str_or_null(v: &yaml_rust2::Yaml) -> Option<String> {
    match v {
        yaml_rust2::Yaml::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        yaml_rust2::Yaml::Integer(i) => Some(i.to_string()),
        yaml_rust2::Yaml::Boolean(b) => Some(b.to_string()),
        _ => None,
    }
}

fn excerpt(body: &str) -> Option<String> {
    let s: String = body.chars().take(EXCERPT_CHARS).collect();
    let trimmed = s.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn measure_dir(dir: &Path) -> (i64, i64) {
    let mut size = 0i64;
    let mut count = 0i64;
    for entry in WalkDir::new(dir)
        .follow_links(false)
        .max_depth(7)
        .into_iter()
        .filter_map(Result::ok)
    {
        if count >= 10_000 {
            break;
        }
        let name = entry.file_name().to_string_lossy();
        if name == ".DS_Store" || name.starts_with(".git") {
            continue;
        }
        if entry.file_type().is_file() {
            if let Ok(meta) = entry.metadata() {
                size += meta.len() as i64;
                count += 1;
            }
        } else if entry.file_type().is_symlink() {
            count += 1;
        }
    }
    (size, count)
}

pub fn load_skill_body(real_path: &str) -> Option<String> {
    let raw = fs::read_to_string(Path::new(real_path).join("SKILL.md")).ok()?;
    if let Some((_, body)) = split_frontmatter(&raw) {
        Some(body.trim().to_string())
    } else {
        Some(raw)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_skill_markdown_accepts_crlf_frontmatter() {
        let parsed = parse_skill_markdown(
            "---\r\nname: crlf-skill\r\ndescription: Handles CRLF.\r\nmetadata:\r\n  author: tester\r\n---\r\nBody text",
        )
        .expect("parse");

        assert_eq!(parsed.name, "crlf-skill");
        assert_eq!(parsed.description.as_deref(), Some("Handles CRLF."));
        assert_eq!(parsed.author.as_deref(), Some("tester"));
        assert_eq!(parsed.file_count, 1);
    }

    #[test]
    fn parse_skill_markdown_rejects_missing_name() {
        let err = parse_skill_markdown("---\ndescription: Missing name\n---\nBody").unwrap_err();
        assert_eq!(err.code, "MISSING_FRONTMATTER");
    }

    #[test]
    fn parse_skill_markdown_rejects_large_markdown() {
        let raw = format!("---\nname: huge\n---\n{}", "x".repeat(1024 * 1024 + 1));
        let err = parse_skill_markdown(&raw).unwrap_err();
        assert_eq!(err.code, "TOO_LARGE");
    }
}
