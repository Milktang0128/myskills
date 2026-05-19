# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**MySkills** — an Electron desktop app (macOS-only for MVP) that aggregates AI agent skills across Claude Code, Codex, and a user-maintained shared pool into a single searchable, scenario-organized hub. The authoritative product spec is [SPEC.md](SPEC.md) (Chinese) — any implementation that diverges from it should update the spec first.

The repo is currently a scaffold: only `package.json`, configs, and `shared/types.ts` exist. The `electron/` and `src/` source trees described in SPEC §5.4 still need to be built out.

## Commands

```bash
npm run dev          # Runs Next dev (port 4477) + Electron concurrently, with wait-on
npm run dev:next     # Next.js renderer only
npm run dev:electron # Electron main process only (tsx, waits for tcp:4477)
npm run build        # next build → out/, then tsc electron → dist-electron/
npm run package      # build, then electron-builder --mac (DMG)
npm run rebuild      # electron-rebuild for better-sqlite3 (run after npm install fails native build)
```

No test runner or linter is wired up yet — don't claim "tests pass" without first wiring one in.

## Architecture

### Two TypeScript projects, one repo

The renderer and main process are compiled by **separate `tsconfig.json` files**, and the root `tsconfig.json` explicitly **excludes `electron/`**. Don't import renderer code from `electron/` or vice versa — only `shared/` is allowed across the boundary.

- `tsconfig.json` (root) — Next.js renderer. `module: esnext`, `jsx: preserve`, `noEmit`. Path aliases: `@/*` → `src/*`, `@shared/*` → `shared/*`.
- [electron/tsconfig.json](electron/tsconfig.json) — Main process. `module: CommonJS`, emits to `dist-electron/`. `rootDir: ..` so `shared/` compiles in too. Excludes `dev.ts` (run via tsx in dev).

### Static-export Next.js loaded over `file://`

[next.config.mjs](next.config.mjs) uses `output: 'export'` + `distDir: 'out'` + `trailingSlash: true`. In production Electron loads the static bundle via `file://`, so `assetPrefix: './'` is set for production only. **Consequences:**
- No Next.js server features (no API routes, no SSR, no middleware, no Server Actions).
- All dynamic data flows through Electron IPC.
- Any link/asset paths must be relative-safe.

### IPC and security model (SPEC §5.3)

- All filesystem and SQLite work lives in the **main process**. The renderer reads cached data via IPC only.
- IPC goes through `contextBridge` + `ipcMain.handle()`; the renderer runs with `nodeIntegration: false` and only sees a whitelisted API surface.
- `shared/types.ts` is the contract between processes — keep it **dependency-free** (it's imported by both sides).

### Data model

SQLite via `better-sqlite3` (native module — `npm run rebuild` if Electron can't load it). DB lives in `app.getPath('userData')/myskills.db`, never inside skill directories. Full schema is in SPEC §6.2. Three design rules to preserve:
- **Skill identity = `(name, source_key)`**, where `source_key` defaults to `'local'` (and will be a repo/marketplace slug for future imports). `content_hash` (SHA-256 of `SKILL.md`) is the *current revision*, not the identity — updating a skill keeps the same row.
- **Enabled state lives only on `skill_locations`** (`is_disabled`). "Is this skill enabled?" is derived: any non-disabled location → enabled. The `skills` table has no `enabled` column.
- **Never write metadata into skill directories.** Tags, scenarios, and any MySkills-only state belong in the DB; SKILL.md files stay untouched.

### Sync model (SPEC §9)

Two modes — `copy` (full recursive copy) and `symlink` (default; resolves symlink chains before comparing). Hard rule: **all skill-directory writes go through plan → confirm → execute.** Plan phase is pure read and produces a `SyncPlan` (source, target, state classification, hash diff, backup path). Execute phase backs up first, writes to a temp dir, then `rename`s atomically, then rescans. Every successful write records `before_hash` / `after_hash` / `backup_path` / `dry_run_plan` in `sync_history` and is rollback-able. This is MVP-B scope — MVP-A is read-only.

## Conventions to preserve

- **Skill format is Claude/Codex's, verbatim** — frontmatter via `gray-matter`, no proprietary extensions. Unknown frontmatter fields are passed through as free-form metadata.
- **Default platforms are `claude` / `codex` / `shared`** (see `PlatformId` in [shared/types.ts:6](shared/types.ts:6)). The `shared` pool (`~/.agents/skills/`) is the source of truth; the other two platforms typically symlink into it.
- **iCloud path hazard:** the repo itself lives under `~/Library/Mobile Documents/com~apple~CloudDocs/…`. Always quote paths containing `~apple~` or spaces in shell commands. SPEC §12.1 R3 also warns against putting the user's `~/.agents/` shared pool inside iCloud.

## Out of scope (do not build)

Per SPEC §3.4: no in-app skill editor, no skill runtime/executor, no cloud sync service, no permission/sandbox auditing. MVP is macOS only.
