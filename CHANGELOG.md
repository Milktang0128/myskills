<!-- Developer-facing changelog. Public-facing release notes for users live on
     the World of Windows gateway (/updates). Newest version on top. -->

# Changelog

## 0.2.2 — 2026-06-08

### 新功能
- feat(updater): wire the stable auto-update channel — signed updater artifacts
  + latest.json per release, published to the fixed `stable` endpoint (#36)

### 其他
- chore(release): 0.2.2 — enable signed auto-update artifacts (#37)

## 0.2.1 — 2026-06-08

### 修复
- fix(onboarding): re-check AI availability after onboarding completes, so the
  AI Lens / Create Skill views unlock without an app relaunch (#31)
- fix(sort): order "recently added/modified" by real filesystem times
  (birthtime / mtime) instead of DB scan times (#33)
- fix: cache reqwest::blocking clients to stop the runtime-drop panic in async
  LLM/network commands (#34)

### 改进
- ux: violet emphasis for the AI Lens guidance banner (#32)

## 0.2.0 — 2026-06-08

The Tauri rewrite becomes the mainline, replacing the Electron app.

### 新功能
- feat: Tauri (Rust + Next.js) rewrite promoted to `main`, replacing Electron —
  ~107MB → ~19MB, faster startup, lower memory; macOS universal (arm + Intel,
  signed & notarized); adds Windows (NSIS) and Linux (AppImage / deb / rpm) (#26)
- feat(create-skill): adaptive clarify pipeline — the LLM clarifies until the
  input/output contract is precise, then crystallizes an outline, then generates
  a reviewable SKILL.md (#26)

### CI / 其他
- ci: tag-triggered stable release workflow — 3 platforms + macOS notarization (#28)
- ci: add npm "tauri" script for tauri-action (#29)
- ci: retry npm ci on transient HTTP 504s (#30)
- chore: clear two dead-code warnings (#27)
