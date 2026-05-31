# MySkills Tauri Parity Smoke Matrix

Date: 2026-05-31
Branch: `tauri/refactor-v0.2`
Scope: Tauri `v0.2.0-tauri.0` preview candidate

This file is the release-facing parity checklist for proving that the Tauri
line can replace the frozen Electron `v0.1.x` line. A preview build can be
shared only after the relevant rows are marked `pass`; a stable `v0.2.0`
release requires every stable-gate row below to pass.

## Current Evidence

Automated checks already available:

- `npm run check:commands` passed: 52 frontend command mappings and 3 backend
  events are present in the Rust command surface.
- `npm run validate:tauri` previously passed on this branch: command audit,
  Rust fmt, Rust clippy, Rust tests, Next static build, and Tauri build.
- `npm run smoke:tauri:launch` previously passed: the bundled app launched and
  initialized a `myskills-tauri-preview` DB in an isolated preview directory.
- `npm run smoke:tauri:dmg` mounts the latest local macOS DMG, verifies the
  preview bundle id, launches the mounted app binary, and checks isolated DB
  initialization.

Manual desktop smoke performed on 2026-05-31:

- Launched bundled app:
  `/Users/apple/Code/Myskills/src-tauri/target/release/bundle/macos/MySkills.app`
- Bundle id observed by Computer Use:
  `com.kanbenzhi.myskills.tauri-preview`
- Window observed: `MySkills`
- First rendered view: Chinese workbench UI, sidebar, Coverage Matrix, and
  onboarding modal.
- Read-only navigation smoke: Discover and Settings views rendered.
- Settings confirmed the preview data path is
  `/Users/apple/Library/Application Support/myskills-tauri-preview/myskills.db`,
  which is isolated from the Electron production app data directory.

Important caveat:

- A GUI-level launch can still use the real macOS user app data root even when
  the process is started with a temporary `HOME`. The isolation guarantee for
  release is therefore "separate preview app data directory", not "throwaway
  HOME" unless the platform-specific runner proves otherwise.

## Stable Gate

| Area | Required evidence | Status | Notes |
|---|---|---:|---|
| Electron freeze line | `release/electron-v0.1.x` remains separate from `tauri/refactor-v0.2` | pass | No Electron files need to change for this smoke. |
| Preview identity | Packaged app uses `com.kanbenzhi.myskills.tauri-preview` | pass | Verified from app state and `Info.plist`. |
| Preview data isolation | DB, `backups/`, and `staging/` are under `myskills-tauri-preview` | partial | DB path observed in Settings; destructive sync backup paths still need workflow proof. |
| App boot | Packaged app opens to MySkills workbench, not a blank shell | pass | Verified with Computer Use app state. |
| Library | List/Kanban/Coverage render with real scanned skills | pending | Need real scan fixture or seeded skill dirs. |
| Coverage Matrix | Drift/gap/orphan/broken/disabled states match Electron behavior | partial | Rust fixture test covers in-sync, stale, orphan, broken, disabled, canonical ordering, and missing cells; packaged UI fixture smoke still pending. |
| Settings | Platform paths, stats, language, network gate, AI config render correctly | partial | Settings page rendered; write paths and toggles not exercised. |
| Scenarios | Create/edit/delete/import/export round trip | partial | Rust round-trip tests cover export/import, idempotent re-import, missing-skill reporting, and fixed import link counts; packaged UI file workflow still pending. |
| Sync plan | Plan dialog shows writes/skips/conflicts and token gate | pending | Must run against temporary platform dirs. |
| Sync execute | Copy/symlink writes are backed up, recorded, rescanned, and rollback-able | partial | Rust workflow test covers copy-to-canonical execute, success history, and rollback file removal; symlink packaged UI workflow still pending. |
| History | Sync history and rollback flow work from packaged app | partial | Rust workflow test verifies success history rows and rollback marker update; packaged History UI still pending. |
| Discover | Keyword search, preview, staged install plan render | partial | Discover page rendered; network/catalog actions not exercised. |
| AI / LLM | Provider config, key write-only behavior, network gate, AI features | partial | Rust tests prove network fail-closed and config does not return legacy API key secrets; packaged UI smoke still pending. |
| macOS unsigned preview | DMG mounts, app launches, preview id is correct, basic workflows pass | partial | Automated DMG mount/launch smoke exists; full UI workflow smoke from DMG still pending. |
| macOS signed/notarized preview | Developer ID signing, notarization, stapling, Gatekeeper launch | pending | Required before public release. |
| Windows preview | Build and launch smoke on Windows runner | pending | Required before claiming Windows support. |
| Linux preview | Build and launch smoke on Linux runner | pending | Required before claiming Linux support. |
| Migration strategy | Electron production DB migration and rollback plan documented | partial | Strategy documented; Rust foundation tests cover DB copy, markers, backup path rewrite, existing target refusal, invalid schema rejection, and rollback file moves. Stable enablement drill pending. |

## Manual Smoke Script

Use a throwaway skill fixture root; do not use production skill directories for
write-path testing.

1. Install or launch the unsigned macOS preview package.
2. Confirm the app id is `com.kanbenzhi.myskills.tauri-preview`.
3. Open Settings and confirm the DB path contains `myskills-tauri-preview`.
4. Create a repeatable fixture set with `npm run smoke:tauri:fixtures`; it
   prints temporary `shared`, `claude`, and `codex` platform directories plus a
   `manifest.json`.
5. Point the Settings platform paths at the generated fixture directories:
   `shared` -> User Agents Folder, `claude` -> Claude Code, `codex` -> Codex.
6. The fixture set contains one in-sync copy, one stale copy, one orphan copy,
   one broken symlink, one disabled folder, and one parser-error skill.
7. Run Scan and confirm Library, Kanban, and Coverage render the expected
   skill count and state labels.
8. Create a scenario, add/remove a skill, export JSON, delete the scenario, and
   import the JSON back.
9. Create a sync plan from the fixture set and confirm the dialog lists writes,
   skips, and conflicts without executing automatically.
10. Execute one safe copy/symlink plan, confirm history is written, then roll it
   back and rescan.
11. Disable external network and confirm Discover, LLM, and AI actions fail
   closed with visible errors instead of silent success.
12. Re-enable network only for catalog smoke, run a keyword search, preview one
    result, and create an install plan into a temporary platform directory.
13. Configure a fake LLM key, confirm the key is never displayed back in the
    renderer, then delete it.
14. Repeat the launch smoke from the DMG-installed app, not only the build
    output bundle.

Useful commands:

```bash
npm run smoke:tauri:fixtures
npm run smoke:tauri:launch
npm run smoke:tauri:dmg
```

## Release Decision

Current state: `preview parity candidate`.

Do not label the Tauri package as a stable replacement for Electron until all
stable-gate rows are `pass`, including signed/notarized macOS validation and
Windows/Linux runner validation if cross-platform support is advertised.
