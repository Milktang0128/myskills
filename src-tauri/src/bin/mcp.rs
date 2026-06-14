//! Standalone MySkills MCP server binary (`myskills-mcp`).
//!
//! A console app that speaks MCP over stdio. The real implementation lives in
//! the library (`myskills_lib::run_mcp_server`) so it shares the app's db,
//! scanner, and command primitives. Intentionally *not* a Tauri app and *not*
//! a windows GUI subsystem binary — it must keep stdin/stdout attached.

fn main() {
    myskills_lib::run_mcp_server();
}
