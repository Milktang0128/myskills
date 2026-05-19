# MySkills

A local-first macOS desktop app that aggregates AI agent skills across Claude Code, Codex, and a shared pool into one searchable, scenario-organized hub.

This is **MVP-A** — read-only inventory plus scenario management. No skill files are written, copied, symlinked, renamed, or moved. Sync and enable/disable land in MVP-B.

The full product spec is in [SPEC.md](./SPEC.md).

## Requirements

- macOS (Apple Silicon or Intel)
- Node.js 22+
- npm 10+

## Quick start

```bash
npm install
npm run rebuild     # rebuild better-sqlite3 against Electron's ABI
npm run dev         # starts Next.js on :4477 and Electron concurrently
```

The app window opens automatically. On first launch it scans `~/.claude/skills`, `~/.codex/skills`, and `~/.agents/skills`, and shows whatever it finds. Use the **Settings** page to change those paths.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Run Next.js dev server + Electron (concurrent). |
| `npm run dev:next` | Renderer only. |
| `npm run dev:electron` | Wait for Next, then build Electron and launch. |
| `npm run build` | Static export Next → `out/`, compile Electron → `dist-electron/`. |
| `npm run package` | Build, then `electron-builder --mac` → DMG in `release/`. |
| `npm run rebuild` | `electron-rebuild -f -w better-sqlite3`. Run after `npm install` or Electron upgrade. |

## What you can do

### Local management
- See every skill across Claude, Codex, Shared, and any custom platforms you add. Deduped by `(name, source_key)`.
- **Coverage matrix** view (default): rows = unique skills, columns = platforms. Canonical column on the far left with a crown icon; per-cell drift (in_sync / stale / only_here) and `mtime` indicators.
- **List view** with scope filters (All / Duplicates / Unscenarized), platform filters, scenario filters, and full-text search.
- **Detail drawer**: per-location view with platform badge, content hash, mtime, and a per-row "Adopt as canonical" button (sets that version as the source of truth, symlinks the others).
- **Scenarios**: tag skills into 6 default scenarios (写作 / 编码 / 运维 / 创意 / 数据 / 知识) or create your own. Export/import as JSON keyed by stable `scenario.key`.

### Safe sync
- **Plan → confirm → execute** for every write. Atomic via temp + rename, TOCTOU-defended via inode pinning, sender-validated IPC, server-issued plan tokens.
- Per-row **"Fill N gap" / "Replace N stale" / "Promote orphan"** actions on the matrix. Bulk versions at the top.
- All replace operations back the target up under `~/Library/Application Support/MySkills/backups/` first. Every write is recorded in **Sync history** with a one-click rollback that restores from backup.

### Discover (catalog)
- Built-in **Discover** view searches [skills.sh](https://skills.sh) — 395k+ community SKILL.md skills, no account needed.
- Preview the SKILL.md from GitHub raw before installing.
- Install to any combination of platforms via the same plan→confirm→execute pipeline (with backup + rollback).
- Master "Allow external network" toggle in Settings — turn off to keep MySkills fully local.

### AI (optional, your key)
- Bring your own OpenAI / Anthropic / OpenRouter / Ollama / custom-baseURL key (stored in macOS Keychain via Electron `safeStorage`).
- **AI search** in Discover: re-rank catalog results by your natural-language need.
- **Auto-categorize**: scanner queues newly-found skills; an LLM suggests which scenarios they fit; user accepts via chip in the detail drawer.
- **Recommend missing**: open any scenario page to see catalog suggestions that complement what you already have.
- Each AI feature has its own on/off toggle. All AI calls go from your machine directly to your chosen provider — never via our servers.

## What this app does NOT do

- No plugin or project-level skill scanning yet (see SPEC §12.2 Q1/Q2).
- No skill editor — use VS Code on the realpath.
- No remote SSH browsing of other machines' skills.
- No enable/disable action on skill locations yet (planned; scanner already recognizes `.disabled/`).

## Architecture, very briefly

- **Renderer**: Next.js 15 with `output: 'export'`, loaded by Electron via `file://` in production. No SSR, no API routes, no Server Actions.
- **Main process**: Electron 33 with `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderer, strict CSP, IPC sender validation. Owns all FS and SQLite access.
- **DB**: `better-sqlite3` at `app.getPath('userData')/myskills.db`. Schema is in [electron/db/schema.ts](./electron/db/schema.ts).
- **Identity**: Skills are deduplicated by `(name, source_key)`. `content_hash` tracks revisions, not identity — updating a SKILL.md keeps the same row. Enabled state lives on `skill_locations`, not on `skills`. See [CLAUDE.md](./CLAUDE.md) for design rules.

## Where data lives

- App database: `~/Library/Application Support/MySkills/myskills.db`
- Skill directories (configurable in Settings):
  - Claude Code: `~/.claude/skills`
  - Codex: `~/.codex/skills`
  - Shared pool: `~/.agents/skills`

MySkills **does not write metadata into the skill directories themselves**. Scenarios, tags, and any MySkills-only state live only in the SQLite DB.

## Notes

- If `npm install` fails to build `better-sqlite3` against Electron, run `npm run rebuild`.
- The default platform paths are seeded on first launch. If you've moved your shared pool out of iCloud (recommended, see SPEC §12.1 R3), update the path in **Settings → Platform directories**.
- iCloud and other "smart" filesystems can produce `.icloud` placeholder files. The scanner skips entries that lack a real `SKILL.md`.
