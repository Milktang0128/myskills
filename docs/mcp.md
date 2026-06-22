# MySkills MCP server

`myskills-mcp` is a standalone [Model Context Protocol](https://modelcontextprotocol.io)
server that exposes the MySkills engine — the same SQLite database and skill
directories the desktop app drives — to an agent (Claude Code, Codex, or any
MCP client) over stdio.

It ships as a plain Rust binary with **no Node runtime and no extra SDK**: it
speaks newline-delimited JSON-RPC 2.0 directly. The implementation lives inside
the app's library (`src-tauri/src/mcp.rs`) so it reuses the app's database,
scanner, and the exact same root-checked, trash-based delete primitive — with a
3-line binary shim at `src-tauri/src/bin/mcp.rs`.

## Design stance: the agent is the brain

The server exposes **inventory, read, organize, and maintain** primitives — not
the app's own LLM features. Categorization, optimization, and skill authoring
are deliberately *not* exposed: an agent driving the server is already an LLM,
so running a second LLM round-trip inside the engine would just fight it. The
engine's job here is to be a set of trustworthy hands — fast reads, safe writes,
and an auditable change ledger.

## Tools

| Tool | Kind | What it does |
|------|------|--------------|
| `skills_inventory` | read | Every skill with per-platform health (`synced` / `source` / `drifted` / `broken` / `disabled`), `missingOn` coverage gaps, scenarios, and a `needsAttention` flag. Filter with `scope` (`all`/`broken`/`drifted`/`disabled`/`missing`/`unscenarized`/`needs-attention`), `nameContains`, `platform`, `limit`. |
| `skills_read` | read | A skill's `SKILL.md` (frontmatter + body) from its healthiest location. Content over 64 KB is truncated (`truncated: true`). |
| `scenarios_list` | read | All scenarios (key, name, description, builtin, skillCount). Call before `skills_set_scenarios` to learn valid keys. |
| `skills_history` | read | The `sync_history` ledger, newest-first: every file-level change MySkills made (action, platform, before/after hash, backup path, success, rolled-back). Optional `skillId`, `limit` (default 20, max 200). |
| `scenarios_create` | write | Create a new scenario (taxonomy bucket). Idempotent; name may be any language. DB only. |
| `skills_set_scenarios` | write | Assign/unassign a skill to/from **existing** scenarios by key or name. Unknown names are rejected with the list of available keys. Writes only MySkills' database — `SKILL.md` files are never touched. |
| `discover_search` | read | Search the skills.sh community catalog (public, no auth) for installable skills. Returns candidates (name, source `owner/repo`, skillId, description, installs). |
| `discover_install` | destructive | Install a catalog skill: fetch its `SKILL.md`, copy to the canonical source, symlink onto the other platforms. Backed up + recorded; undoable. **Requires `confirm: true`** + "Allow destructive actions". |
| `skills_rescan` | write* | Rescan the platform skill directories on disk and refresh the database. Read-only with respect to skill files; updates MySkills' cached state. |
| `skills_set_enabled` | destructive | Enable/disable a skill on one platform (moves it to/from a `.disabled/` folder). Recorded; undoable. **Requires `confirm: true`** + "Allow destructive actions". |
| `align_plan` | read | Dry-run preview of aligning a skill: which drifted/broken copies would be re-linked to the canonical source (`symlink_create`/`symlink_replace`), plus any conflicts. `includeMissing:true` also covers platforms where it's absent. No writes. |
| `align_apply` | destructive | Execute the alignment (re-derives the plan fresh, then runs it). Each replaced copy is backed up and recorded in history. **Requires `confirm: true`** + "Allow destructive actions". Undoable via `skills_rollback`. |
| `skills_rollback` | destructive | Undo a previous change by its `sync_history` id (restores the backed-up files for the whole op-group). **Requires `confirm: true`**. |
| `skills_delete` | destructive | Move a skill's directories to the OS trash and remove it from MySkills. **Requires `confirm: true`** (without it the call is rejected so you can surface the consequence first). Each path is verified to live inside its platform root before anything is touched. Recoverable from the trash. |
| `authoring_draft` | destructive | Author a **new** skill — the agent supplies the full `SKILL.md`. Runs the hardened review gate, then installs it into the source pool **disabled (inert)** and stamps it agent-authored. It does **not** go live: a human reviews it in MySkills and enables it before any agent runs it. **Requires `confirm: true`** + "Allow destructive actions". If the gate blocks the content, nothing is installed. |
| `authoring_revise` | write | Propose a rewrite of an **existing** skill — the agent supplies the full new `SKILL.md`. Runs the gate and records it as a pending revision (with a diff) on the skill. It **never writes to disk**: a human reviews the diff in MySkills and applies it (backed up + rollback-able). The agent cannot apply it. DB-only, so it needs MCP enabled but not "Allow destructive actions". |

> **The review gate is a content-hygiene check, not an execution sandbox.** It
> flags injection-shaped text, secret-shaped fields, credential paths, and
> exfiltration shapes, and blocks the clearly dangerous ones — but it cannot
> catch a cleverly disguised malicious skill. The real safety boundary is the
> human: newly authored skills land **disabled** until a person reviews and
> enables them, and revisions to live skills require a person to apply the diff.
> Everything is backed up and reversible.

Every result includes both a human-readable `content[0].text` (pretty JSON) and
`structuredContent` (the raw object) for clients that consume structured output.
Tool-level failures come back as `isError: true` with an actionable message and a
machine-readable error code (e.g. `SCENARIO_NOT_FOUND`, `CONFIRM_REQUIRED`,
`NOT_FOUND`), not as a protocol error.

## Where the binary comes from

Released apps **ship `myskills-mcp` inside the bundle**, code-signed and
notarized (a Tauri `externalBin` sidecar next to the main executable —
`MySkills.app/Contents/MacOS/myskills-mcp`). The Settings panel shows its exact
path; you don't build anything.

To build it yourself (dev, or to run it standalone):

```bash
cd src-tauri
cargo build --release --bin myskills-mcp
# → target/release/myskills-mcp
```

The binary is self-contained (SQLite is bundled via `rusqlite`'s `bundled`
feature). No further runtime dependencies.

## Turn it on first

MCP access is **off by default** — the agent owns the process, but you own
access. Open **MySkills → Settings → "Connect your agent (MCP)"** and:

1. Toggle **Enable MCP access** on. (Until you do, every tool call returns
   `MCP_DISABLED`.)
2. Optionally toggle **Allow destructive actions** on to let the agent change
   skill files — `align_apply`, `skills_rollback`, `skills_delete`. Off by
   default — with it off those are rejected with `MCP_DESTRUCTIVE_DISABLED` and
   the agent can only read, organize (scenarios), rescan, and *preview* aligns.

The server re-reads both flags from the database on **every call**, so toggling
them takes effect immediately — no restart. That panel also shows the binary
path and generates paste-ready client config (path + `MYSKILLS_DATA_DIR`
pre-filled) and a starter prompt, so you usually don't need to assemble the
config below by hand.

## Configure your agent

### Claude Code

```bash
claude mcp add myskills -- /absolute/path/to/myskills-mcp
```

…or in `.mcp.json` / your MCP config:

```json
{
  "mcpServers": {
    "myskills": {
      "command": "/absolute/path/to/myskills-mcp"
    }
  }
}
```

### Codex / other stdio MCP clients

Point the client at the binary as a stdio server with no arguments. The server
emits a single readiness line to **stderr** (`[myskills-mcp] ready — db: …`) and
speaks JSON-RPC on stdout — standard stdio MCP framing.

## Which database does it use?

The server resolves the MySkills data directory the same way the app does:

1. **`MYSKILLS_DATA_DIR`** — if set and non-empty, this wins (supports `~`
   expansion). Use it to point at the dev/preview database or a custom location.
2. Otherwise the **stable app's platform data dir**: `<data_dir>/com.kanbenzhi.myskills`,
   matching Tauri's `app_data_dir()` — e.g. on macOS
   `~/Library/Application Support/com.kanbenzhi.myskills/myskills.db`.

So with a normally-installed app, **no configuration is needed** — the binary
finds the same database the app uses.

To drive a dev build instead:

```bash
MYSKILLS_DATA_DIR="$HOME/Library/Application Support/myskills-tauri-preview" \
  ./target/release/myskills-mcp
```

## Concurrency & safety

- The database is opened in **WAL mode** with a 5 s busy timeout, so the MCP
  server and the running app can access it concurrently. SQLite serializes
  writers; there is no corruption risk. Changes an agent makes (scenario
  assignments, deletes) show up in the app after its next refresh/rescan.
- `skills_delete` reuses the app's shipped delete core: it validates every path
  is inside its platform root, moves directories to the **OS trash** (recoverable),
  and only then removes the database rows — in a transaction. It refuses to run
  without `confirm: true`.
- The server never mutates `SKILL.md` files. Tags, scenarios, and all
  MySkills-only state live in the database.

## Smoke test

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"skills_inventory","arguments":{"scope":"all","limit":3}}}' \
  | ./target/release/myskills-mcp
```

You should see three JSON-RPC responses: the `initialize` handshake, the tool
catalog, and the inventory call. If MCP access is off (the default), that third
response is `isError: true` with `MCP_DISABLED` — which still proves the
protocol works; enable access in Settings to get real data back.

## Roadmap

The current surface is the read/organize/maintain core. Future additions
(tracked in `docs/design/agent-mcp-surface.md`): a dry-run `align.plan` /
`align.apply` pair for moving skills into sync, `discover.search` / `install`
for the skills.sh catalog, and `history.rollback`.
