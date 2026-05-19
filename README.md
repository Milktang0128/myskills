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

## What you can do in MVP-A

- See every skill across Claude, Codex, and the shared pool, deduped by `(name, source_key)`.
- Highlight broken symlinks, duplicates, and unscenarized skills via the left scope sidebar.
- Search by name, description, or body excerpt.
- Filter by platform or scenario.
- Open a skill to see its frontmatter, locations (with realpath + symlink flags), file count, size, and content hash.
- Tag skills into scenarios. Default scenarios (写作 / 编码 / 运维 / 创意 / 数据 / 知识) are seeded with stable keys.
- Export scenario assignments to JSON keyed by `scenario.key` and `(skill.name, sourceKey)` — import on another machine merges by key.
- Rescan on demand from sidebar or Settings; auto-rescan on launch (toggleable).

## What MVP-A does NOT do

- **No writes to skill directories.** No copy, no symlink, no enable/disable, no rename. That is MVP-B.
- No external network calls — everything is local.
- No AI features.
- No plugin or project-level skill scanning yet (see SPEC §12.2 Q1/Q2).

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
