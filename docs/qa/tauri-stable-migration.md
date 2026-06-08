# Electron to Tauri Stable Migration Strategy

Date: 2026-05-31
Applies to: future stable `v0.2.0` release, not `v0.2.0-tauri.*` preview builds

Preview builds must not run this migration. They continue to use
`com.kanbenzhi.myskills.tauri-preview` and `myskills-tauri-preview`.

## Goals

- Preserve the frozen Electron `v0.1.x` app as the rollback line.
- Migrate user scenarios, settings, scan state, catalog cache, AI metadata, and
  sync history into the stable Tauri app data directory.
- Never mutate the Electron production DB or skill directories during migration.
- Keep rollback possible if Tauri stable fails after first launch.

## Non-Goals

- Do not migrate Electron-encrypted API keys automatically. Electron
  `safeStorage` and the Tauri system credential store are different runtime
  boundaries; users must re-enter provider keys.
- Do not migrate preview `myskills-tauri-preview` data into the stable app by
  default. Preview DBs may contain test fixtures and should require explicit
  user consent.
- Do not reuse Electron `staging/`; pending staged writes are not portable.

## Source And Target

Electron source:

- Source path is discovered from the Electron app's `app.getPath('userData')`
  convention, then validated by finding `myskills.db` and the expected schema
  tables.
- The current Electron code writes all DB, backup, and staging paths through
  `electron/paths.ts`.

Tauri stable target:

- Stable Tauri must switch away from
  `com.kanbenzhi.myskills.tauri-preview` before migration.
- The stable candidate config is `src-tauri/tauri.stable.conf.json`, which sets
  the app id to `com.kanbenzhi.myskills`.
- Target app data is the stable Tauri app data directory for
  `com.kanbenzhi.myskills`.
- The preview directory `myskills-tauri-preview` remains untouched unless the
  user explicitly imports it.

## Migration Algorithm

Run only on first stable Tauri launch, before any scanner or sync write.
Preview builds hard-fail if this migration is requested. Stable candidates only
run it when `MYSKILLS_STABLE_MIGRATE_CONFIRMATION_FILE` points at a user-
confirmed JSON manifest containing the Electron DB path and expected SHA-256.
Automatic source selection remains disabled until the final stable release
gate. The backend now exposes a read-only `migration_discover` command that
finds and validates Electron DB candidates without importing or mutating source
data; the stable UI shows those candidates in Settings and must still require
explicit user confirmation before any import. Settings writes the confirmation
manifest to the stable app data directory; the actual import runs on the next
stable launch before the DB pool opens.

1. Resolve the stable Tauri app data directory and create it if needed.
2. If a stable Tauri `myskills.db` already exists, skip automatic migration and
   show the existing DB status.
3. Detect candidate Electron `myskills.db` files. If zero or multiple valid
   candidates are found, ask the user to choose instead of guessing.
4. Write `stable-migration-confirmation.json` only after explicit user approval:
   - `sourceDb`: absolute path to the chosen Electron `myskills.db`.
   - `backupRoot`: optional Electron `backups/` path.
   - `sourceSha256`: SHA-256 observed during discovery.
   - `confirmedAt`: confirmation timestamp.
5. On stable startup, re-hash the source DB and abort with
   `MIGRATION_SOURCE_CHANGED` if it no longer matches `sourceSha256`.
6. If a fresh Tauri DB already exists but contains no user skills, skill
   locations, non-built-in scenarios, scenario links, sync history, or migration
   marker, preserve it as `myskills.db.pre-migration-*` before importing. If it
   contains user data, abort with `MIGRATION_TARGET_NOT_EMPTY`.
7. Validate the source DB:
   - `PRAGMA integrity_check` returns `ok`.
   - Required tables exist: `platforms`, `skills`, `skill_locations`,
     `scenarios`, `skill_scenarios`, `settings`, `sync_history`.
   - `schema_migrations` exists or the schema can be repaired by the current
     idempotent migrations.
8. Copy the Electron DB to
   `migration-backups/electron-<timestamp>/myskills.db` under the Tauri target
   directory. Record source path, source size, and SHA-256.
9. Copy the Electron `backups/` directory into the same migration backup set.
   Do not copy `staging/`.
10. Create `myskills.db.importing` in the Tauri target directory from the DB
   backup copy.
11. Run the current Tauri migrations on `myskills.db.importing`.
12. Rewrite migrated `sync_history.backup_path` values whose prefix points at
   the Electron `backups/` directory so they point at the copied Tauri
   migration backup directory. Leave unknown external backup paths unchanged
   and mark them non-rollbackable in UI.
13. Insert a migration marker into `settings`:
    `migration.electron_v0_1.source_path`,
    `migration.electron_v0_1.source_sha256`,
    `migration.electron_v0_1.migrated_at`.
14. Run `PRAGMA integrity_check` again on the importing DB.
15. Atomically rename `myskills.db.importing` to `myskills.db`. Automatic
    migration refuses to run when a stable Tauri DB already exists; any future
    manual replace mode must first preserve the existing target as
    `myskills.db.pre-migration-*`.
16. Remove the default confirmation manifest after successful import.
17. Start normal Tauri recovery steps: pending backup recovery, pending history
    recovery, staging GC, and backup retention sweep.

## Rollback

Rollback must be available without opening Electron:

1. Tauri stable never edits the Electron DB, so the Electron app remains a
   fallback as long as the user launches the frozen Electron release.
2. Automatic migration refuses to replace an existing Tauri stable DB. If a
   future manual replace mode is added, it must first keep
   `myskills.db.pre-migration-*`.
3. Provide a recovery command or UI action that:
   - closes active DB connections,
   - renames current `myskills.db` to `myskills.db.failed-*`,
   - restores `myskills.db.pre-migration-*` when present, or deletes the Tauri
     DB if migration created it from scratch,
   - preserves `migration-backups/` for forensic recovery.
4. Rollback must not delete the copied Electron backup set.

## Validation Gate

Before enabling this migration in a stable build:

- `migration_discover` must return only metadata for Electron DB candidates:
  path, optional backup root, file size, mtime, SHA-256 for valid candidates,
  and validation status/reason. It must not write source DBs, Electron backup
  trees, skill directories, or the Tauri target directory.
- Stable startup migration must require a confirmation manifest and reject
  source DBs whose SHA-256 changed after confirmation. A bare source path is
  not enough to run migration.
- Settings must show the candidate list as read-only status, including invalid
  reasons. Its confirm action may only write the restart-time manifest; it must
  not import while the runtime DB pool is open.
- Rust migration foundation tests must cover copied Electron DB, marker writes,
  backup path rewrite, existing target refusal, invalid source schema rejection,
  unknown external backup path preservation, current DB failure preservation,
  pre-migration DB restore, and empty rollback target rejection.
- `npm run smoke:tauri:migration` must pass. This drill imports a copied
  Electron DB into a disposable stable Tauri data directory, rewrites copied
  backup paths, rolls back the imported DB to `myskills.db.failed-*`, preserves
  `migration-backups/`, and verifies the source Electron DB and original backup
  tree are unchanged.
- Run migration against a copied Electron production DB, not the live source.
- Verify old Electron sync history rows are either rollbackable through copied
  backups or clearly marked non-rollbackable.
- Verify API keys are not returned or silently migrated to the renderer.
- Verify preview DBs are not imported unless explicitly selected.
- Add stable enablement tests for first-launch gating and an end-to-end rollback
  drill before switching away from the preview app id.
- `npm run build:tauri:stable` plus
  `npm run smoke:tauri:launch -- --stable-smoke --frontend-smoke` must prove the
  stable app id uses the stable app data directory instead of
  `myskills-tauri-preview`.
- `npm run smoke:tauri:launch -- --stable-migration-smoke --frontend-smoke`
  must prove a packaged stable app startup can import a disposable Electron DB,
  write migration markers, rewrite copied backup paths, and leave the source DB
  and original Electron backup tree unchanged. On macOS, repeat the same check
  from the mounted DMG with `npm run smoke:tauri:dmg -- --stable-migration-smoke
  --frontend-smoke`.

## Release Rule

`v0.2.0-tauri.*` preview builds keep migration disabled. The first build that
enables this flow must be a signed/notarized stable candidate with a documented
rollback drill and a verified Electron fallback.
