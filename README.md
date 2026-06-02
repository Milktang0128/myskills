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
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-111" alt="macOS, Windows, Linux" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-111" alt="License: MIT" /></a>
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh.md">中文</a>
</p>

---

**MySkills is a local desktop app that scans the skill directories you've registered, deduplicates by name + source, and gives you one coherent view of every AI agent skill you have. The default registry is `~/.claude/skills`, `~/.codex/skills`, and `~/.agents/skills`; you can add, remove, or repath platforms in Settings.**

A `SKILL.md` is a Markdown file with YAML frontmatter that tools like Claude Code and Codex load as reusable capabilities — prompts, tooling profiles, agent instructions. Once you use more than one of those tools, copies start to drift across folders. MySkills makes that mess legible, and any write is explicit, reviewable, backed up, and recorded.

<p align="center">
  <img src="docs/screenshots/coverage-matrix.en.png" width="900" alt="Coverage matrix view — one row per unique skill, one column per platform; cell colour shows which copies are in sync vs. out of sync" />
</p>

## Install

The released `v0.1.x` line remains the frozen Electron/macOS line. The active
`tauri/refactor-v0.2` branch is a Tauri 2 rewrite that uses a separate preview
app id (`com.kanbenzhi.myskills.tauri-preview`) and a separate app data
directory until DB migration and rollback parity are verified.

For the frozen Electron release, download the signed, notarized macOS DMG:

**[→ Releases page](https://github.com/Milktang0128/myskills/releases/latest)**

- **Apple Silicon Macs only** (M1, M2, M3, M4) — Intel build is on the roadmap for the Electron maintenance line
- **macOS 13 (Ventura) or later**
- DMG is ~116 MB; the installed app is ~280 MB
- Signed with a Developer ID certificate and stapled with Apple's notary ticket — open with a normal double-click, no Terminal workaround

For the Tauri preview branch, build locally with `npm run build:tauri`. Public
macOS/Windows/Linux preview artifacts are only release candidates after feature
parity smoke testing is complete.

Preview builds can check the `tauri-preview` GitHub Release for signed updates
from Settings. The client only shows an update when the published `latest.json`
version is greater than the installed app version.

## On your desktop

What MySkills puts where:

- The Tauri preview app data directory is isolated as `myskills-tauri-preview`; it contains `myskills.db`, `backups/`, and `staging/`.
- Automatic backups are written before every sync write; retention is configurable in Settings.
- AI provider API keys live in the system credential store when AI features are enabled.

**Your `SKILL.md` files are never modified by MySkills.** Tags and scenarios live only in the database above.

> **iCloud caveat:** Don't put `~/.agents/` (your main source directory) inside iCloud Drive. iCloud can "evict" files and leave `.icloud` placeholders that show up as broken copies — keep the main source on a local path.

## What it does

### See your library in one place

- **List**, **Kanban** (by scenario), and **Coverage matrix** views. The matrix has one row per unique skill and one column per platform; cell colour shows which copies are in sync vs. out of sync
- Per-skill detail drawer with last-modified time, content hash, and resolved path on disk
- **Move to main source** to promote one platform's copy as the master; other platforms get a linked copy that stays in sync

### Sync writes are reviewable

- Every disk write goes through **Plan → Confirm → Execute**. A dialog shows you exactly what will change before anything happens
- Destructive operations write to the app data `backups/` directory first
- **One-click rollback** from Sync History
- Writes are staged through a temporary path before replacement, with rollback records for successful writes

<p align="center">
  <img src="docs/screenshots/sync-confirm.en.png" width="800" alt="Sync confirm dialog showing the exact plan + an amber overwrite warning for any item that would replace an existing copy" />
</p>

### Discover and install from skills.sh

- Built-in search against [skills.sh](https://skills.sh) — a community catalog of `SKILL.md` skills; no account needed
- Preview the `SKILL.md` from GitHub raw before installing
- Install to any combination of platforms via the same plan-confirm-execute pipeline

### AI assist (optional, bring your own API key)

- Supports OpenAI / Anthropic / OpenRouter / DeepSeek / Ollama / any OpenAI-compatible endpoint
- **AI Lens** clusters your library into themes; you can promote any cluster into a real scenario in one click
- **Auto-categorize** new skills into scenarios you've defined
- **AI search** in Discover re-ranks catalog results against a natural-language need
- **Create Skill** turns a rough need into an editable outline, narrows key choices, generates a locally reviewed `SKILL.md`, and installs only after confirmation
- Each feature has its own toggle. Keys live in the system credential store.

<p align="center">
  <img src="docs/screenshots/ai-lens.en.png" width="900" alt="AI Lens — clusters the whole library into named themes; each cluster can be promoted into a real scenario" />
</p>

## Privacy

- **All processing happens on your machine.** No telemetry, no analytics, no background phone-home
- The scanner only walks the folders you configure (default: `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills`)
- Network calls are limited to: skills.sh catalog search, and your chosen AI provider. Both are opt-in; both ship from your machine directly to the service — never via us
- Settings has a master **"Allow external network"** switch — turn it off and MySkills runs fully offline

## Build from source

```bash
npm install
npm run dev         # Tauri dev shell + Next.js dev (:4477)
npm run check:tauri # command bridge audit + Rust fmt/clippy/tests + frontend build
npm run validate:tauri # check:tauri + Tauri desktop bundle
npm run smoke:tauri:launch # launch bundled app and verify isolated preview DB init
npm run smoke:tauri:dmg # mount the macOS DMG and verify preview DB init
npm run smoke:tauri:fixtures # create temporary skill fixtures for desktop parity smoke
npm run build       # Next.js static export
npm run build:tauri # Tauri desktop bundle
npm run build:tauri:stable # Tauri bundle with the future stable app id
npm run smoke:tauri:launch -- --stable-migration-smoke --frontend-smoke # stable startup migration drill
npm run build:tauri:mac:signed # local Developer ID signed macOS Tauri preview
npm run notarize:tauri:mac # notarize, staple, and Gatekeeper-check the signed Tauri DMG
npm run build:tauri:updater -- --bundles app # macOS updater archive + signature
npm run updater:manifest -- --artifacts-dir dist/tauri-updater-artifacts # write latest.json for GitHub Release assets
```

Legacy Electron commands are kept under `*:electron:legacy` for the frozen `v0.1.x` line.

**Requirements:** Node 22+, npm 10+, Rust/Cargo via rustup, and platform-specific Tauri prerequisites.

### Preview auto-update channel

The Tauri preview updater is intentionally release-gated:

1. Bump `package.json` and `src-tauri/tauri.conf.json` to a newer semver version, for example `0.2.0-tauri.1`.
2. Configure GitHub Actions secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
3. Push `tauri/refactor-v0.2` or run the `Tauri Preview` workflow manually.
4. After macOS, Windows, and Linux parity checks pass, CI uploads signed updater bundles plus `latest.json` to the `tauri-preview` GitHub Release.
5. Installed preview clients show the update from Settings, and a background check can raise a non-blocking toast.

The private updater signing key must never be committed. The public key is embedded in `src-tauri/tauri.conf.json`; CI signs artifacts with the private key from secrets.

## Architecture

The v0.2 line uses a Web control surface with a Rust backend:

| Side | Path | Stack |
|---|---|---|
| Backend | `src-tauri/` | Tauri 2, Rust, `rusqlite`, custom commands |
| Renderer | `src/` | Next.js 15 (static export), React 19, Tailwind, shadcn/Radix |
| Contract | `shared/` | Plain TypeScript types and command/channel constants — dependency-free |

The renderer does not receive direct filesystem, SQL, shell, or HTTP permissions. All filesystem, database, secret, and network-gated work lives behind MySkills-specific Tauri commands.

For deeper architecture see [**CLAUDE.md**](./CLAUDE.md) — the file is framed as an LLM coding-assistant brief, but the content is plain architecture notes worth reading. The full product spec is in [**SPEC.md**](./SPEC.md) (Chinese).

<details>
<summary><strong>How it works (internals)</strong></summary>

**Skill identity is the pair `(name, source_key)`.** `source_key` is `local` for now and will be a repo/marketplace slug for future imports. Content is fingerprinted by SHA-256 of `SKILL.md` — updating a skill bumps its `content_hash`, not its identity. Scenarios, tags, and any user state survive edits in place.

**Writes go through plan → confirm → execute:**

1. **Plan** is pure read: it walks the sources, classifies each cell (`in_sync` / `stale` / `only_here` / `missing`), computes diff hashes, and pre-allocates backup paths. Output is a typed `SyncPlan`.
2. **Confirm** shows you the plan, line by line.
3. **Execute** backs up first, writes to a temp dir, then atomically `rename`s into place.

Every successful write records `before_hash`, `after_hash`, `backup_path`, and the original `dry_run_plan` in `sync_history` — and is rollback-able.

</details>

## Roadmap

| Version | Theme | Status |
|---|---|---|
| **v0.1** | MVP-A — read-only inventory, scenarios, Discover, optional AI | shipping |
| v0.2 | Tauri rewrite — cross-platform shell, Rust backend, feature parity with Electron `v0.1.x`, plus Create Skill preview | active preview branch |
| v0.3+ | Project/plugin-level skill scanning, multi-machine awareness, signed multi-platform release automation | planned |

**Not planned:**
- General-purpose in-app skill editor — Create Skill may generate and install a reviewed `SKILL.md`, but long-form editing stays in your usual editor
- Cloud sync — MySkills stays local-only by design
- Running skills inside MySkills — execution stays with the agent tools

## Status

Solo personal project. `v0.1.x` is the frozen Electron/macOS line; `v0.2` is
the Tauri rewrite branch. The Rust backend has unit coverage for migration and
scanner invariants, the packaged preview app has passed first-window boot
smoke, and Settings exposes read-only Electron DB candidate discovery for the
future stable migration confirmation flow. Stable startup migration is gated by
a confirmed source-hash manifest, written only after user confirmation, rather
than a bare DB path. Release readiness is tracked in
[docs/qa/tauri-parity-smoke.md](docs/qa/tauri-parity-smoke.md); Library,
Coverage, Discover, Sync, History, Settings, and AI flows still require full
desktop parity smoke before `v0.2.0` is treated as stable.

## Contributing

Issues and PRs welcome. Before you open one:

1. **For non-trivial PRs, file an issue first.** MVP scope is intentionally tight, and the architecture has invariants — skill identity, plan→confirm→execute, the IPC boundary — that are easy to violate accidentally. The short list lives in [CLAUDE.md](./CLAUDE.md).
2. **Conventional commit style** (`feat:`, `fix:`, `ux:`, `docs:`, `chore:`). Match the existing log.
3. **No automated tests yet.** Don't claim "tests pass" — describe what you exercised manually in the PR description.

## Credits

- [skills.sh](https://skills.sh) — the catalog this app searches against, and the community of `SKILL.md` authors who made aggregation possible in the first place.
- Built with [Tauri](https://tauri.app/), [Next.js](https://nextjs.org/), [shadcn/ui](https://ui.shadcn.com/), and [Lucide](https://lucide.dev/). The frozen `v0.1.x` maintenance line was built with Electron.

## License

[MIT](LICENSE) © 2026 Milk Tang.
