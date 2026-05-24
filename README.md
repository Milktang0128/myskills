<p align="center">
  <img src="build/icon.png" width="120" alt="MySkills" />
</p>

<h1 align="center">MySkills</h1>

<p align="center">
  <em>One window for every AI agent skill.</em><br/>
  <sub>Claude Code · Codex · Shared pool · anything that reads <code>SKILL.md</code></sub>
</p>

<p align="center">
  <a href="https://github.com/Milktang0128/myskills/releases/latest">
    <img src="https://img.shields.io/github/v/release/Milktang0128/myskills?label=download&color=111" alt="Latest release" />
  </a>
  <img src="https://img.shields.io/badge/platform-macOS-111" alt="macOS" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-111" alt="License: MIT" /></a>
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh.md">中文</a>
</p>

---

If you run multiple AI coding agents — Claude Code on one project, Codex on another, a custom shell agent on top — your skills sprawl. The same `pdf-toolkit` shows up in three places. A new install from [skills.sh](https://skills.sh) lands somewhere you forget. The shape of your toolbox blurs.

**MySkills is a local Mac app that scans those folders, deduplicates by `(name, source)`, and shows one coherent view of what you actually have.**

> Screenshots — drop them in `docs/screenshots/` and update these:
>
> ![Coverage matrix](docs/screenshots/coverage.png)
> ![AI Lens](docs/screenshots/ai-lens.png)

## Install

Download the signed, notarized DMG from the latest release:

**[→ Releases page](https://github.com/Milktang0128/myskills/releases/latest)**

Apple Silicon only for v0.1.0. macOS 13 (Ventura) or later.

The DMG is signed with a Developer ID certificate and stapled with Apple's notary ticket — no `xattr -d com.apple.quarantine` ritual needed.

## What it does

Three jobs that AI-skill power users do by hand today:

### See your library in one place

- **List**, **Kanban** (by scenario), or **Coverage matrix** (rows = unique skills, columns = platforms — cell colour signals drift).
- Per-skill detail drawer with `mtime`, content hash, and resolved location on disk.
- **Adopt as canonical** promotes one platform's copy as the source of truth and symlinks the rest.

### Sync safely — never the wrong way

- **Plan → Confirm → Execute** for every write. You see the diff and pick the action.
- All destructive operations back up to `~/Library/Application Support/MySkills/backups/` first.
- **One-click rollback** from Sync History.
- Atomic via temp-dir + `rename`; TOCTOU-defended via inode pinning.

### Discover and install from skills.sh

- Built-in search against [skills.sh](https://skills.sh) — 395k+ community SKILL.md skills, no account needed.
- Preview the SKILL.md from GitHub raw before installing.
- Install to any combination of platforms via the same plan-confirm-execute pipeline.

### AI assist (optional, BYOK)

- Bring your own OpenAI / Anthropic / OpenRouter / DeepSeek / Ollama / custom-baseURL key.
- **AI Lens** generates a clustered map of your library, lifts AI-named clusters into real scenarios.
- **Auto-categorize** new skills into scenarios you've defined.
- **AI search** in Discover re-ranks catalog results against a natural-language need.
- Each feature has its own toggle in Settings. Keys are stored in the macOS Keychain via Electron `safeStorage`.

## How it works

**Skill identity is the pair `(name, source_key)`.** `source_key` is `local` for now and will be a repo/marketplace slug for future imports. Content is fingerprinted by SHA-256 of `SKILL.md` — updating a skill bumps its `content_hash`, not its identity. Scenarios, tags, and any user state survive edits in place.

**MySkills never writes inside skill directories.** All MySkills-only state lives in `~/Library/Application Support/MySkills/myskills.db` (SQLite). `SKILL.md` files stay untouched.

**Writes go through plan → confirm → execute:**

1. **Plan** is pure read: it walks the sources, classifies each (`in_sync` / `stale` / `only_here` / `missing`), computes diff hashes, and pre-allocates backup paths. Output is a typed `SyncPlan`.
2. **Confirm** shows you the plan, line by line.
3. **Execute** backs up first, writes to a temp dir, then atomically `rename`s into place.

Every successful write records `before_hash`, `after_hash`, `backup_path`, and the original `dry_run_plan` in `sync_history` — and is rollback-able.

## Privacy

- **100% local.** No telemetry. No analytics. No background phone-home.
- **Scanner only walks the folders you configure** (default: `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills`).
- **AI features are opt-in.** Calls go from your machine directly to your chosen provider — never via us.
- **"Allow external network" master toggle** in Settings turns off all outbound calls, including the skills.sh catalog.

## Build from source

```bash
npm install
npm run rebuild     # rebuild better-sqlite3 against Electron's ABI
npm run dev         # Next.js dev (:4477) + Electron concurrently
```

`npm run package` produces a signed DMG. Requires an Apple Developer ID certificate and a `xcrun notarytool` keychain profile (`myskills-notary` by default — see `scripts/notarize.cjs`).

**Requirements:** Node 22+, npm 10+, macOS 13+.

## Architecture

Two TypeScript projects in one repo:

| Side | Path | Stack |
|---|---|---|
| Main process | `electron/` | Node 22, `better-sqlite3`, `electron-builder`, IPC via `contextBridge` |
| Renderer | `src/` | Next.js 15 (static export), React 19, Tailwind, shadcn/Radix |
| Contract | `shared/` | Plain TypeScript types and IPC channel constants — dependency-free |

The renderer runs sandboxed: `nodeIntegration: false`, `contextIsolation: true`, strict CSP, IPC sender validation. All filesystem and database work lives in the main process.

For deeper architecture see [**CLAUDE.md**](./CLAUDE.md). For the full product spec see [**SPEC.md**](./SPEC.md) (Chinese).

## Roadmap

| Version | Theme | Status |
|---|---|---|
| **v0.1** | MVP-A — read-only inventory, scenarios, Discover, BYOK AI | shipping |
| v0.2 | MVP-B — sync writes (symlink/copy), enable/disable per location | partial (engine landed, UI gating) |
| v0.3+ | Project/plugin-level skill scanning, multi-machine awareness, Intel DMG | planned |

**Not planned:**
- In-app skill editor — use VS Code on the realpath.
- Cloud sync service — local-first is a feature, not an absence.
- Windows / Linux ports — outside MVP scope.

## Contributing

Issues and PRs welcome. Two things to know first:

1. **For non-trivial PRs, file an issue first.** MVP scope is intentionally tight, and the architecture has invariants — skill identity, plan→confirm→execute, the IPC boundary — that are easy to violate accidentally. See [CLAUDE.md](./CLAUDE.md) for the short list.

2. **No tests are wired up yet.** Don't claim "tests pass" without first wiring a runner. Verify by running the app.

## Credits

- [skills.sh](https://skills.sh) — the catalog this app searches against, and the community of SKILL.md authors who made aggregation possible in the first place.
- Built with [Electron](https://electronjs.org/), [Next.js](https://nextjs.org/), [shadcn/ui](https://ui.shadcn.com/), and [Lucide](https://lucide.dev/).

## License

[MIT](LICENSE) © 2026 Milk Tang.
