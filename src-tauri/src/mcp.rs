//! MySkills MCP server.
//!
//! A self-contained Model Context Protocol server that exposes the MySkills
//! engine (the same SQLite database + filesystem the desktop app drives) to an
//! agent over stdio. It speaks newline-delimited JSON-RPC 2.0 directly — no
//! Node runtime, no extra SDK — so it can ship as a plain Rust binary next to
//! the app (`[[bin]] myskills-mcp`).
//!
//! Design stance (see `docs/design/agent-mcp-surface.md`):
//! - The agent is the brain. We expose *inventory / read / organize / maintain*
//!   primitives, not the app's own LLM features (categorize, optimize,
//!   create-skill) — doing a second round of LLM inside the engine would just
//!   fight the agent driving it.
//! - Reads are cheap and safe. The one destructive tool (`skills_delete`) is
//!   gated behind an explicit `confirm: true` and reuses the app's
//!   root-checked, trash-based delete core, so it stays recoverable.
//! - The DB is the source of truth for MySkills-only state; SKILL.md files on
//!   disk are never mutated here.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use crate::commands;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::paths::AppPaths;
use crate::scanner;

/// Bundle identifier of the *stable* (released) app. Its data dir is where the
/// shipped MCP binary looks by default; dev/preview builds point elsewhere via
/// `MYSKILLS_DATA_DIR`.
const STABLE_APP_IDENTIFIER: &str = "com.kanbenzhi.myskills";

/// MCP protocol revision we implement. We echo the client's requested version
/// when it sends one, falling back to this.
const DEFAULT_PROTOCOL_VERSION: &str = "2024-11-05";

const MAX_SKILL_MD_BYTES: usize = 64 * 1024;
const DEFAULT_HISTORY_LIMIT: i64 = 20;
const MAX_HISTORY_LIMIT: i64 = 200;

type DbPool = Pool<SqliteConnectionManager>;
type DbConn = r2d2::PooledConnection<SqliteConnectionManager>;

/// One `skills` row, as projected for the inventory tool.
struct SkillRow {
    id: String,
    name: String,
    source: String,
    description: Option<String>,
}

/// Entry point used by the `myskills-mcp` binary. Runs until stdin closes.
pub fn run_mcp_server() {
    if let Err(err) = serve() {
        eprintln!("[myskills-mcp] fatal: {err}");
        std::process::exit(1);
    }
}

fn serve() -> AppResult<()> {
    let data_dir = resolve_data_dir()?;
    let paths = AppPaths::new(data_dir)?;
    let pool = db::init_pool(&paths.db_path)?;
    eprintln!(
        "[myskills-mcp] ready — db: {}",
        paths.db_path.to_string_lossy()
    );
    Server { pool }.run()
}

/// Resolve the MySkills data directory the same way the app does.
///
/// `MYSKILLS_DATA_DIR` wins when set (used for dev/preview and advanced setups);
/// otherwise we fall back to the stable app's platform data dir, i.e.
/// `<data_dir>/com.kanbenzhi.myskills`, matching Tauri's `app_data_dir()`.
fn resolve_data_dir() -> AppResult<PathBuf> {
    if let Ok(dir) = std::env::var("MYSKILLS_DATA_DIR") {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            return Ok(expand_home(trimmed));
        }
    }
    let base = dirs::data_dir().ok_or_else(|| {
        AppError::new(
            "NO_DATA_DIR",
            "could not resolve the platform data directory; set MYSKILLS_DATA_DIR",
        )
    })?;
    Ok(base.join(STABLE_APP_IDENTIFIER))
}

fn expand_home(input: &str) -> PathBuf {
    if let Some(rest) = input.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    if input == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    }
    PathBuf::from(input)
}

struct Server {
    pool: DbPool,
}

impl Server {
    fn conn(&self) -> AppResult<DbConn> {
        Ok(self.pool.get()?)
    }

    fn run(&self) -> AppResult<()> {
        let stdin = std::io::stdin();
        let mut reader = stdin.lock();
        let stdout = std::io::stdout();
        let mut out = stdout.lock();
        let mut line = String::new();
        loop {
            line.clear();
            let read = reader.read_line(&mut line)?;
            if read == 0 {
                break; // EOF — client closed the pipe.
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let response = match serde_json::from_str::<Value>(trimmed) {
                Ok(req) => self.handle(&req),
                Err(err) => Some(error_response(
                    Value::Null,
                    -32700,
                    format!("parse error: {err}"),
                )),
            };
            if let Some(message) = response {
                write_message(&mut out, &message)?;
            }
        }
        Ok(())
    }

    /// Returns `Some(response)` for requests, `None` for notifications.
    fn handle(&self, req: &Value) -> Option<Value> {
        let has_id = req.get("id").is_some();
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let method = req.get("method").and_then(Value::as_str).unwrap_or("");

        match method {
            "initialize" => Some(result_response(id, self.initialize(req))),
            "ping" => Some(result_response(id, json!({}))),
            "tools/list" => Some(result_response(id, tools_list())),
            "tools/call" => Some(result_response(id, self.tools_call(req))),
            _ if method.starts_with("notifications/") || !has_id => None,
            other => Some(error_response(
                id,
                -32601,
                format!("method not found: {other}"),
            )),
        }
    }

    fn initialize(&self, req: &Value) -> Value {
        let protocol = req
            .get("params")
            .and_then(|p| p.get("protocolVersion"))
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_PROTOCOL_VERSION)
            .to_string();
        json!({
            "protocolVersion": protocol,
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": {
                "name": "myskills",
                "version": env!("CARGO_PKG_VERSION"),
            },
            "instructions": INSTRUCTIONS,
        })
    }

    fn tools_call(&self, req: &Value) -> Value {
        let params = req.get("params");
        let name = params
            .and_then(|p| p.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let args = params
            .and_then(|p| p.get("arguments"))
            .cloned()
            .unwrap_or_else(|| json!({}));

        // Authorization gate. The user owns access via MySkills settings even
        // though the agent owns this process: we re-read the flags from the
        // shared database on every call, so toggling them in the app takes
        // effect immediately (no restart). Both default to off.
        if let Err(err) = self.check_access(name) {
            return tool_err(&err);
        }

        let outcome = match name {
            "skills_inventory" => self.tool_inventory(&args),
            "skills_read" => self.tool_read(&args),
            "scenarios_list" => self.tool_scenarios(&args),
            "skills_set_scenarios" => self.tool_set_scenarios(&args),
            "skills_history" => self.tool_history(&args),
            "skills_rescan" => self.tool_rescan(&args),
            "skills_delete" => self.tool_delete(&args),
            other => Err(AppError::new(
                "UNKNOWN_TOOL",
                format!("unknown tool: {other}"),
            )),
        };

        match outcome {
            Ok(value) => tool_ok(value),
            Err(err) => tool_err(&err),
        }
    }

    /// Enforce the user's MySkills settings before running any tool.
    fn check_access(&self, tool: &str) -> AppResult<()> {
        let db = self.conn()?;
        if !bool_setting(&db, "mcp_enabled") {
            return Err(AppError::new(
                "MCP_DISABLED",
                "MCP access is turned off. Enable it in MySkills → Settings → \
                 \"Connect your agent (MCP)\" to let an agent read and organize your skill library.",
            ));
        }
        if tool == "skills_delete" && !bool_setting(&db, "mcp_allow_destructive") {
            return Err(AppError::new(
                "MCP_DESTRUCTIVE_DISABLED",
                "Deleting skills over MCP is turned off. Turn on \"Allow destructive actions\" in \
                 MySkills → Settings → \"Connect your agent (MCP)\" first. (You can still delete \
                 from the app itself.)",
            ));
        }
        Ok(())
    }

    // --- read tools -----------------------------------------------------

    fn tool_inventory(&self, args: &Value) -> AppResult<Value> {
        let db = self.conn()?;
        let canonical = canonical_platform(&db)?;
        let enabled = enabled_platforms(&db)?;
        let scope = args
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or("all")
            .to_string();
        let name_contains = args
            .get("nameContains")
            .and_then(Value::as_str)
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty());
        let platform_filter = args
            .get("platform")
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|s| !s.is_empty());
        let limit = args
            .get("limit")
            .and_then(Value::as_i64)
            .filter(|n| *n > 0)
            .map(|n| n as usize);

        let mut stmt = db.prepare(
            "SELECT id, name, source_key, description FROM skills ORDER BY name COLLATE NOCASE",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(SkillRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    source: r.get(2)?,
                    description: r.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let total = rows.len();
        let mut skills = Vec::new();
        for row in rows {
            let entry = self.build_skill_entry(&db, &row, &canonical, &enabled)?;
            if let Some(ref contains) = name_contains {
                if !row.name.to_lowercase().contains(contains) {
                    continue;
                }
            }
            if let Some(ref plat) = platform_filter {
                let on = entry["platforms"].get(plat.as_str()).is_some();
                if !on {
                    continue;
                }
            }
            if !scope_matches(&scope, &entry) {
                continue;
            }
            skills.push(entry);
        }

        let returned = skills.len();
        let truncated = limit.map(|l| returned > l).unwrap_or(false);
        if let Some(l) = limit {
            skills.truncate(l);
        }

        Ok(json!({
            "canonicalPlatform": canonical,
            "enabledPlatforms": enabled,
            "scope": scope,
            "totalSkills": total,
            "matched": returned,
            "returned": skills.len(),
            "truncated": truncated,
            "skills": skills,
        }))
    }

    fn build_skill_entry(
        &self,
        db: &DbConn,
        row: &SkillRow,
        canonical: &str,
        enabled: &[String],
    ) -> AppResult<Value> {
        let skill_id = row.id.as_str();
        // Per-location rows.
        let mut stmt = db.prepare(
            "SELECT platform_id, is_symlink, is_broken_link, is_disabled, content_hash
               FROM skill_locations WHERE skill_id = ?1",
        )?;
        struct Loc {
            platform: String,
            symlink: bool,
            broken: bool,
            disabled: bool,
            hash: Option<String>,
        }
        let locs = stmt
            .query_map(params![skill_id], |r| {
                Ok(Loc {
                    platform: r.get::<_, String>(0)?,
                    symlink: r.get::<_, i64>(1)? != 0,
                    broken: r.get::<_, i64>(2)? != 0,
                    disabled: r.get::<_, i64>(3)? != 0,
                    hash: r.get::<_, Option<String>>(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // Canonical hash = a healthy real copy on the canonical platform.
        let canonical_hash = locs
            .iter()
            .find(|l| l.platform == canonical && !l.broken && !l.disabled)
            .and_then(|l| l.hash.clone());

        let mut platforms = serde_json::Map::new();
        let mut healthy = std::collections::BTreeSet::new();
        let mut any_broken = false;
        let mut any_drifted = false;
        for loc in &locs {
            let state = if loc.broken {
                any_broken = true;
                "broken"
            } else if loc.disabled {
                "disabled"
            } else if loc.symlink {
                healthy.insert(loc.platform.clone());
                "synced"
            } else {
                healthy.insert(loc.platform.clone());
                match (&canonical_hash, &loc.hash) {
                    (Some(c), Some(h)) if c != h => {
                        any_drifted = true;
                        "drifted"
                    }
                    _ => "source",
                }
            };
            // Keep the most severe state if a platform somehow has two locations.
            let keep = match platforms.get(&loc.platform).and_then(Value::as_str) {
                Some(existing) => severity(state) > severity(existing),
                None => true,
            };
            if keep {
                platforms.insert(loc.platform.clone(), json!(state));
            }
        }

        let missing_on: Vec<String> = enabled
            .iter()
            .filter(|p| !healthy.contains(*p))
            .cloned()
            .collect();

        let scenarios = self.scenario_names(db, skill_id)?;
        // "needs attention" = something is wrong on disk (a broken symlink or a
        // real copy that has drifted from the canonical). A coverage gap
        // (`missingOn`) is reported separately and is not, by itself, a problem.
        let needs_attention = any_broken || any_drifted;

        Ok(json!({
            "id": skill_id,
            "name": row.name,
            "source": row.source,
            "description": row.description,
            "scenarios": scenarios,
            "platforms": Value::Object(platforms),
            "missingOn": missing_on,
            "needsAttention": needs_attention,
        }))
    }

    fn scenario_names(&self, db: &DbConn, skill_id: &str) -> AppResult<Vec<String>> {
        let mut stmt = db.prepare(
            "SELECT sc.name FROM skill_scenarios ss
               JOIN scenarios sc ON sc.id = ss.scenario_id
              WHERE ss.skill_id = ?1
              ORDER BY sc.sort_order, sc.name",
        )?;
        let names = stmt
            .query_map(params![skill_id], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(names)
    }

    fn tool_read(&self, args: &Value) -> AppResult<Value> {
        let skill_id = required_str(args, "skillId")?;
        let db = self.conn()?;
        let name: String = db
            .query_row(
                "SELECT name FROM skills WHERE id = ?1",
                params![skill_id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::new("NOT_FOUND", format!("no skill with id {skill_id}")))?;

        // Prefer a healthy, enabled location; fall back to any non-broken one.
        let install: Option<String> = db
            .query_row(
                "SELECT install_path FROM skill_locations
                   WHERE skill_id = ?1 AND is_broken_link = 0
                   ORDER BY is_disabled ASC, id ASC LIMIT 1",
                params![skill_id],
                |r| r.get(0),
            )
            .optional()?;
        let install = install.ok_or_else(|| {
            AppError::new(
                "NO_READABLE_LOCATION",
                format!("skill {name} has no healthy location to read from"),
            )
        })?;

        let md_path = Path::new(&install).join("SKILL.md");
        let raw = std::fs::read_to_string(&md_path).map_err(|err| {
            AppError::detail(
                "READ_FAILED",
                format!("could not read SKILL.md: {err}"),
                json!({ "path": md_path.to_string_lossy() }),
            )
        })?;
        let (content, truncated) = if raw.len() > MAX_SKILL_MD_BYTES {
            let mut end = MAX_SKILL_MD_BYTES;
            while !raw.is_char_boundary(end) {
                end -= 1;
            }
            (raw[..end].to_string(), true)
        } else {
            (raw, false)
        };

        Ok(json!({
            "skillId": skill_id,
            "name": name,
            "path": md_path.to_string_lossy(),
            "content": content,
            "truncated": truncated,
        }))
    }

    fn tool_scenarios(&self, _args: &Value) -> AppResult<Value> {
        let db = self.conn()?;
        let mut stmt = db.prepare(
            "SELECT sc.key, sc.name, sc.description, sc.is_builtin,
                    (SELECT COUNT(*) FROM skill_scenarios ss WHERE ss.scenario_id = sc.id)
               FROM scenarios sc ORDER BY sc.sort_order, sc.name",
        )?;
        let scenarios = stmt
            .query_map([], |r| {
                Ok(json!({
                    "key": r.get::<_, String>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "description": r.get::<_, Option<String>>(2)?,
                    "builtin": r.get::<_, i64>(3)? != 0,
                    "skillCount": r.get::<_, i64>(4)?,
                }))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(json!({ "scenarios": scenarios }))
    }

    fn tool_history(&self, args: &Value) -> AppResult<Value> {
        let db = self.conn()?;
        let limit = args
            .get("limit")
            .and_then(Value::as_i64)
            .unwrap_or(DEFAULT_HISTORY_LIMIT)
            .clamp(1, MAX_HISTORY_LIMIT);
        let skill_id = args
            .get("skillId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());

        let map_row = |r: &rusqlite::Row<'_>| -> rusqlite::Result<Value> {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "skillId": r.get::<_, String>(1)?,
                "action": r.get::<_, String>(2)?,
                "platform": r.get::<_, Option<String>>(3)?,
                "beforeHash": r.get::<_, Option<String>>(4)?,
                "afterHash": r.get::<_, Option<String>>(5)?,
                "backupPath": r.get::<_, Option<String>>(6)?,
                "success": r.get::<_, i64>(7)? != 0,
                "message": r.get::<_, Option<String>>(8)?,
                "createdAt": r.get::<_, i64>(9)?,
                "rolledBack": r.get::<_, Option<i64>>(10)?.is_some(),
                "opGroupId": r.get::<_, Option<String>>(11)?,
            }))
        };
        const COLS: &str = "id, skill_id, action, platform_id, before_hash, after_hash, \
             backup_path, success, message, created_at, rolled_back_at, op_group_id";

        let events = if let Some(skill_id) = skill_id {
            let sql = format!(
                "SELECT {COLS} FROM sync_history WHERE skill_id = ?1 ORDER BY created_at DESC LIMIT ?2"
            );
            let mut stmt = db.prepare(&sql)?;
            let rows = stmt
                .query_map(params![skill_id, limit], map_row)?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        } else {
            let sql = format!("SELECT {COLS} FROM sync_history ORDER BY created_at DESC LIMIT ?1");
            let mut stmt = db.prepare(&sql)?;
            let rows = stmt
                .query_map(params![limit], map_row)?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };

        Ok(json!({ "events": events, "count": events.len() }))
    }

    // --- safe-write tool ------------------------------------------------

    fn tool_set_scenarios(&self, args: &Value) -> AppResult<Value> {
        let skill_id = required_str(args, "skillId")?;
        let add = string_array(args, "add");
        let remove = string_array(args, "remove");
        if add.is_empty() && remove.is_empty() {
            return Err(AppError::new(
                "INVALID_INPUT",
                "pass at least one of `add` or `remove` (scenario keys or names)",
            ));
        }
        let mut db = self.conn()?;

        let exists: bool = db
            .query_row(
                "SELECT 1 FROM skills WHERE id = ?1",
                params![skill_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !exists {
            return Err(AppError::new(
                "NOT_FOUND",
                format!("no skill with id {skill_id}"),
            ));
        }

        // Resolve every referenced scenario up front; bail with guidance if any
        // is unknown rather than partially applying.
        let mut to_add = Vec::new();
        let mut to_remove = Vec::new();
        let mut unresolved = Vec::new();
        for key in &add {
            match resolve_scenario_id(&db, key)? {
                Some(id) => to_add.push(id),
                None => unresolved.push(key.clone()),
            }
        }
        for key in &remove {
            match resolve_scenario_id(&db, key)? {
                Some(id) => to_remove.push(id),
                None => unresolved.push(key.clone()),
            }
        }
        if !unresolved.is_empty() {
            let available = available_scenario_keys(&db)?;
            return Err(AppError::detail(
                "SCENARIO_NOT_FOUND",
                format!(
                    "unknown scenario(s): {}. Create them in the app first, or use one of the available keys.",
                    unresolved.join(", ")
                ),
                json!({ "unresolved": unresolved, "available": available }),
            ));
        }

        let now = now_ms();
        let tx = db.transaction()?;
        for scenario_id in &to_add {
            tx.execute(
                "INSERT OR IGNORE INTO skill_scenarios (skill_id, scenario_id, added_at) VALUES (?1, ?2, ?3)",
                params![skill_id, scenario_id, now],
            )?;
        }
        for scenario_id in &to_remove {
            tx.execute(
                "DELETE FROM skill_scenarios WHERE skill_id = ?1 AND scenario_id = ?2",
                params![skill_id, scenario_id],
            )?;
        }
        tx.commit()?;

        let scenarios = self.scenario_names(&db, skill_id)?;
        Ok(json!({
            "ok": true,
            "skillId": skill_id,
            "added": to_add.len(),
            "removed": to_remove.len(),
            "scenarios": scenarios,
        }))
    }

    // --- maintenance tools ----------------------------------------------

    fn tool_rescan(&self, _args: &Value) -> AppResult<Value> {
        let db = self.conn()?;
        let result = scanner::scan_all(&db)?;
        Ok(json!({ "ok": true, "rescan": result }))
    }

    fn tool_delete(&self, args: &Value) -> AppResult<Value> {
        let skill_id = required_str(args, "skillId")?;
        let confirm = args
            .get("confirm")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !confirm {
            return Err(AppError::new(
                "CONFIRM_REQUIRED",
                "Refusing to delete without confirm:true. Set confirm:true to move this skill's \
                 directories to the OS trash and remove it from MySkills. This is recoverable from \
                 the trash, but skill files on disk will be moved.",
            ));
        }
        let mut db = self.conn()?;
        commands::delete_skill_core(&mut db, skill_id)
    }
}

// --- shared SQL helpers -------------------------------------------------

/// Read a boolean setting (stored as the string "1"). Absent or anything else
/// is treated as false, so MCP access is opt-in.
fn bool_setting(db: &DbConn, key: &str) -> bool {
    db.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .map(|v| v == "1")
    .unwrap_or(false)
}

fn canonical_platform(db: &DbConn) -> AppResult<String> {
    let value: Option<String> = db
        .query_row(
            "SELECT value FROM settings WHERE key = 'canonical_platform'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(value.unwrap_or_else(|| "shared".to_string()))
}

fn enabled_platforms(db: &DbConn) -> AppResult<Vec<String>> {
    let mut stmt =
        db.prepare("SELECT id FROM platforms WHERE enabled = 1 ORDER BY sort_order, id")?;
    let ids = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}

/// Resolve a scenario by numeric-string id, key, or (case-insensitive) name.
fn resolve_scenario_id(db: &DbConn, reference: &str) -> AppResult<Option<i64>> {
    let id: Option<i64> = db
        .query_row(
            "SELECT id FROM scenarios
               WHERE key = ?1 COLLATE NOCASE OR name = ?1 COLLATE NOCASE
               LIMIT 1",
            params![reference],
            |r| r.get(0),
        )
        .optional()?;
    Ok(id)
}

fn available_scenario_keys(db: &DbConn) -> AppResult<Vec<String>> {
    let mut stmt = db.prepare("SELECT key FROM scenarios ORDER BY sort_order, name")?;
    let keys = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(keys)
}

fn scope_matches(scope: &str, entry: &Value) -> bool {
    let platforms = entry["platforms"].as_object();
    let has_state = |state: &str| {
        platforms
            .map(|m| m.values().any(|v| v.as_str() == Some(state)))
            .unwrap_or(false)
    };
    match scope {
        "all" => true,
        "broken" => has_state("broken"),
        "drifted" => has_state("drifted"),
        "disabled" => has_state("disabled"),
        "missing" => entry["missingOn"]
            .as_array()
            .map(|a| !a.is_empty())
            .unwrap_or(false),
        "unscenarized" => entry["scenarios"]
            .as_array()
            .map(|a| a.is_empty())
            .unwrap_or(true),
        "needs-attention" => entry["needsAttention"].as_bool().unwrap_or(false),
        _ => true,
    }
}

fn severity(state: &str) -> u8 {
    match state {
        "broken" => 5,
        "drifted" => 4,
        "disabled" => 3,
        "synced" => 2,
        "source" => 1,
        _ => 0,
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn required_str<'a>(args: &'a Value, key: &str) -> AppResult<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::new("INVALID_INPUT", format!("`{key}` is required")))
}

fn string_array(args: &Value, key: &str) -> Vec<String> {
    args.get(key)
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

// --- JSON-RPC framing ---------------------------------------------------

fn write_message(out: &mut impl Write, message: &Value) -> AppResult<()> {
    let mut line = serde_json::to_string(message)
        .map_err(|err| AppError::new("SERIALIZE", err.to_string()))?;
    line.push('\n');
    out.write_all(line.as_bytes())?;
    out.flush()?;
    Ok(())
}

fn result_response(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error_response(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

fn tool_ok(value: Value) -> Value {
    let text = serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string());
    let mut result = json!({
        "content": [ { "type": "text", "text": text } ],
        "isError": false,
    });
    if value.is_object() {
        result["structuredContent"] = value;
    }
    result
}

fn tool_err(err: &AppError) -> Value {
    let mut text = format!("Error [{}]: {}", err.code, err.message);
    if let Some(detail) = &err.detail {
        if let Ok(pretty) = serde_json::to_string_pretty(detail) {
            text.push_str("\nDetail: ");
            text.push_str(&pretty);
        }
    }
    json!({
        "content": [ { "type": "text", "text": text } ],
        "isError": true,
    })
}

const INSTRUCTIONS: &str =
    "MySkills manages AI-agent skills across Claude Code, Codex, and a shared \
pool, backed by the same database the desktop app uses. Use `skills_inventory` to see every skill \
and its per-platform health (synced / source / drifted / broken / disabled / missing), \
`skills_read` to read a skill's SKILL.md, `scenarios_list` + `skills_set_scenarios` to organize \
skills into scenarios, `skills_history` to inspect the change ledger, `skills_rescan` to refresh \
from disk, and `skills_delete` (confirm:true) to move a skill to the OS trash. Skill authoring, \
AI categorization, and optimization are intentionally left to you — this server only exposes the \
inventory and the trustworthy write primitives.";

// --- tool catalog -------------------------------------------------------

fn tools_list() -> Value {
    json!({ "tools": [
        {
            "name": "skills_inventory",
            "description": "List skills with per-platform health. Each skill reports its platforms \
map (synced/source/drifted/broken/disabled), which enabled platforms it is missingOn, its \
scenarios, and a needsAttention flag. Use scope to filter: all | broken | drifted | disabled | \
missing | unscenarized | needs-attention. Optional nameContains (substring), platform (only \
skills present on it), and limit.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "scope": {
                        "type": "string",
                        "enum": ["all", "broken", "drifted", "disabled", "missing", "unscenarized", "needs-attention"],
                        "description": "Filter the result set. Default: all."
                    },
                    "nameContains": { "type": "string", "description": "Case-insensitive substring match on skill name." },
                    "platform": { "type": "string", "description": "Only skills present on this platform id (e.g. claude, codex, shared)." },
                    "limit": { "type": "integer", "minimum": 1, "description": "Cap the number of skills returned." }
                }
            },
            "annotations": { "title": "List skills", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "skills_read",
            "description": "Read a skill's SKILL.md (frontmatter + body) from its healthiest \
location. Content over 64KB is truncated with truncated:true.",
            "inputSchema": {
                "type": "object",
                "properties": { "skillId": { "type": "string", "description": "The skill id from skills_inventory." } },
                "required": ["skillId"]
            },
            "annotations": { "title": "Read SKILL.md", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "scenarios_list",
            "description": "List all scenarios (key, name, description, builtin, skillCount). Call \
this before skills_set_scenarios to learn the valid scenario keys.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "title": "List scenarios", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "skills_set_scenarios",
            "description": "Assign or unassign a skill to/from existing scenarios. `add` and \
`remove` take scenario keys or names (case-insensitive). Scenarios must already exist — unknown \
names are rejected with the list of available keys. This only writes MySkills' database; SKILL.md \
files are never touched.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "skillId": { "type": "string", "description": "The skill id from skills_inventory." },
                    "add": { "type": "array", "items": { "type": "string" }, "description": "Scenario keys/names to assign." },
                    "remove": { "type": "array", "items": { "type": "string" }, "description": "Scenario keys/names to unassign." }
                },
                "required": ["skillId"]
            },
            "annotations": { "title": "Set scenarios", "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "skills_history",
            "description": "Read the sync_history ledger newest-first: every file-level change \
MySkills made (action, platform, before/after hash, backup path, success, whether rolled back). \
Optionally filter by skillId. Default limit 20, max 200.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "skillId": { "type": "string", "description": "Only history for this skill id." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 200, "description": "Max events (default 20)." }
                }
            },
            "annotations": { "title": "Change history", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "skills_rescan",
            "description": "Rescan the platform skill directories on disk and refresh the database \
(new/changed/removed skills, broken links, hashes). Read-only with respect to skill files; it \
updates MySkills' own cached state. Run this after the user changes skills outside the app.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "title": "Rescan from disk", "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": true }
        },
        {
            "name": "skills_delete",
            "description": "Move a skill's directories to the OS trash and remove it from MySkills. \
Recoverable from the trash. Requires confirm:true; without it the call is rejected so you can \
surface the consequence to the user first. Each path is verified to live inside its platform root \
before anything is touched.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "skillId": { "type": "string", "description": "The skill id from skills_inventory." },
                    "confirm": { "type": "boolean", "description": "Must be true to proceed. Default false." }
                },
                "required": ["skillId", "confirm"]
            },
            "annotations": { "title": "Delete skill", "readOnlyHint": false, "destructiveHint": true, "idempotentHint": false, "openWorldHint": true }
        }
    ] })
}
