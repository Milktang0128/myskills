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
- `npm run smoke:tauri:launch -- --fixture-smoke` and
  `npm run smoke:tauri:dmg -- --fixture-smoke` launch the packaged app with
  disposable platform fixtures, force an internal temporary app data directory,
  run a real startup scan, and verify the resulting SQLite rows.
- `npm run smoke:tauri:launch -- --sync-smoke` and
  `npm run smoke:tauri:dmg -- --sync-smoke` additionally execute a safe
  copy-to-canonical replacement from the disposable fixtures and verify
  `sync_history.backup_path` points inside the temporary
  `myskills-tauri-preview/backups` directory.
- `npm run smoke:tauri:launch -- --history-smoke` and
  `npm run smoke:tauri:dmg -- --history-smoke` extend that packaged sync smoke
  by rolling the copy operation back, verifying `rolled_back_at`, and checking
  the original canonical fixture content is restored.
- `npm run smoke:tauri:launch -- --workflow-smoke` and
  `npm run smoke:tauri:dmg -- --workflow-smoke` exercise packaged Settings and
  Scenarios backend workflows by writing theme/language/network settings,
  importing a scenario, linking a fixture skill, updating it, deleting a
  transient scenario, exporting scenarios, and verifying the resulting DB rows.
- `npm run smoke:tauri:launch -- --coverage-smoke` and
  `npm run smoke:tauri:dmg -- --coverage-smoke` launch packaged app artifacts
  with disposable platform fixtures, run the real Rust Coverage Matrix helper,
  and verify in-sync, stale drift, only-here orphan, disabled, canonical
  platform ordering, and broken symlink scan diagnostics.
- `npm run smoke:ui:workbench` renders the real React workbench in a DOM smoke
  harness with a mocked Tauri command bridge and verifies Coverage Matrix,
  broken/orphan filtering, Sync confirm, Library list, Kanban scenario
  grouping, Discover keyword search/preview/install-plan/offline gate,
  Scenarios detail, History table, and Settings network/scan/stats surfaces.
- `docs/ci/tauri-preview.github-actions.yml` is the ready-to-activate GitHub
  Actions workflow for command audit, Rust fmt, clippy, Rust tests, Tauri
  build, and packaged fixture smoke across macOS, Linux, and Windows preview
  runners; macOS additionally runs mounted DMG fixture smoke. Activating it
  requires pushing `.github/workflows/tauri-preview.yml` with a GitHub token
  that has the `workflow` scope.
- `npm run smoke:tauri:migration` runs a disposable stable migration drill:
  copied Electron DB import, backup path rewrite, rollback to
  `myskills.db.failed-*`, source DB immutability, and migration backup
  preservation.
- Rust fixture tests cover real scanner ingestion into the Library backend,
  including platform filtering, disabled-scope listing, parser errors, scan
  runs, and Settings stats.

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
  HOME" unless the platform-specific runner proves otherwise. The automated
  fixture smoke uses the internal `MYSKILLS_INTERNAL_SMOKE_DATA_DIR` override to
  make the throwaway data root explicit.

## Stable Gate

| Area | Required evidence | Status | Notes |
|---|---|---:|---|
| Electron freeze line | `release/electron-v0.1.x` remains separate from `tauri/refactor-v0.2` | pass | No Electron files need to change for this smoke. |
| Preview identity | Packaged app uses `com.kanbenzhi.myskills.tauri-preview` | pass | Verified from app state and `Info.plist`. |
| Preview data isolation | DB, `backups/`, and `staging/` are under `myskills-tauri-preview` | pass | Settings observed the preview DB path; packaged app/DMG sync smoke proves destructive backup writes land under temporary `myskills-tauri-preview/backups`; `AppPaths` creates `staging/` under the same preview data root. |
| App boot | Packaged app opens to MySkills workbench, not a blank shell | pass | Verified with Computer Use app state. |
| Library | List/Kanban/Coverage render with real scanned skills | partial | Rust fixture test and packaged app/DMG fixture smoke cover real scanner to Library DB, platform filter, disabled scope, parser-error reporting, scan run, and stats; workbench UI smoke verifies List and Kanban render/interaction against the same frontend component tree via mocked Tauri bridge. Real packaged UI fixture click-through still pending. |
| Coverage Matrix | Drift/gap/orphan/broken/disabled states match Electron behavior | partial | Rust fixture test covers in-sync, stale, orphan, broken, disabled, canonical ordering, and missing cells; packaged app/DMG coverage smoke runs the real Rust matrix helper against disposable fixtures; workbench UI smoke verifies Matrix rendering plus broken/orphan filters. Real packaged UI fixture click-through still pending. |
| Settings | Platform paths, stats, language, network gate, AI config render correctly | partial | Settings page rendered; packaged workflow smoke verifies language/theme/network setting writes; workbench UI smoke verifies Settings sections, network toggle, scan errors, and stats. Packaged Settings UI click-through still pending. |
| Scenarios | Create/edit/delete/import/export round trip | partial | Rust round-trip tests and packaged app/DMG workflow smoke cover import, export, link, update, and delete semantics; workbench UI smoke verifies Scenarios management view, detail expansion, linked skills, and AI recommendation gate. Packaged UI file picker workflow still pending. |
| Sync plan | Plan dialog shows writes/skips/conflicts and token gate | partial | Rust fixture test covers symlink_create, skip/same_hash, symlink_replace, conflict/target_exists_file, token generation, and operation naming; workbench UI smoke verifies Sync confirm dialog summaries, write actions, rollback hint, and apply affordance. Packaged confirm dialog click-through still pending. |
| Sync execute | Copy/symlink writes are backed up, recorded, rescanned, and rollback-able | partial | Rust workflow test covers copy-to-canonical execute, success history, and rollback file removal; packaged app/DMG history smoke proves copy replacement backup path isolation and rollback restore; symlink packaged UI workflow still pending. |
| History | Sync history and rollback flow work from packaged app | partial | Rust workflow test and packaged app/DMG history smoke verify success history rows, `rolled_back_at`, backup consumption, and restored target content; workbench UI smoke verifies History table rows, grouped action text, backup path, and rollback affordance. Packaged History UI click-through still pending. |
| Discover | Keyword search, preview, staged install plan render | partial | Workbench UI smoke verifies keyword results, installed badge, preview drawer, install target selection, staged install plan dialog, and offline fail-closed banner. Live network/catalog and packaged UI click-through still pending. |
| AI / LLM | Provider config, key write-only behavior, network gate, AI features | partial | Rust tests prove network fail-closed and config does not return legacy API key secrets; workbench UI smoke verifies AI settings surface and Discover offline gate. Provider config/key UI write flow and packaged UI smoke still pending. |
| macOS unsigned preview | DMG mounts, app launches, preview id is correct, basic workflows pass | pass | Automated DMG fixture/history smoke mounts the package, verifies `com.kanbenzhi.myskills.tauri-preview`, launches the mounted binary, scans disposable fixtures, executes and rolls back a safe copy sync, and verifies SQLite/backup results. |
| macOS signed/notarized preview | Developer ID signing, notarization, stapling, Gatekeeper launch | pending | Required before public release. |
| Windows preview | Build and launch smoke on Windows runner | partial | Ready-to-activate GitHub Actions workflow covers Tauri build and packaged fixture smoke on `windows-latest`; activation needs a token with `workflow` scope, then first green runner result. |
| Linux preview | Build and launch smoke on Linux runner | partial | Ready-to-activate GitHub Actions workflow covers Tauri build and packaged fixture smoke under `xvfb-run` on `ubuntu-24.04`; activation needs a token with `workflow` scope, then first green runner result. |
| Migration strategy | Electron production DB migration and rollback plan documented | partial | Strategy documented; Rust foundation tests and `smoke:tauri:migration` cover DB copy, markers, backup path rewrite, existing target refusal, invalid source schema rejection, rollback file moves, source immutability, and backup preservation. Stable first-launch enablement remains disabled for preview builds. |

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
npm run smoke:tauri:launch -- --fixture-smoke
npm run smoke:tauri:launch -- --sync-smoke
npm run smoke:tauri:launch -- --history-smoke
npm run smoke:tauri:launch -- --workflow-smoke
npm run smoke:tauri:launch -- --coverage-smoke
npm run smoke:tauri:launch -- --history-smoke --workflow-smoke --coverage-smoke
npm run smoke:tauri:dmg
npm run smoke:tauri:dmg -- --fixture-smoke
npm run smoke:tauri:dmg -- --sync-smoke
npm run smoke:tauri:dmg -- --history-smoke
npm run smoke:tauri:dmg -- --workflow-smoke
npm run smoke:tauri:dmg -- --coverage-smoke
npm run smoke:tauri:dmg -- --history-smoke --workflow-smoke --coverage-smoke
npm run smoke:tauri:migration
npm run smoke:ui:workbench
```

## Release Decision

Current state: `preview parity candidate`.

Do not label the Tauri package as a stable replacement for Electron until all
stable-gate rows are `pass`, including signed/notarized macOS validation and
Windows/Linux runner validation if cross-platform support is advertised.
