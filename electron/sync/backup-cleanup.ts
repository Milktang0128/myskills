/**
 * Backup retention sweep.
 *
 * `backup_retention_days` lives in settings (default 30). This module is the
 * code that actually consumes it — before, the setting was dead weight and
 * backups grew unbounded.
 *
 * Two consumers:
 *   1. Startup auto-run via `cleanupOldBackupsBestEffort()` in main.ts —
 *      catches the case where the user kept MySkills closed for a long
 *      stretch and then opened it.
 *   2. Explicit user action via the settings page → IPC handler. Returns a
 *      report so the UI can confirm "deleted N backups, freed M MB".
 *
 * Safety:
 *   - We only delete directories whose mtime is older than the cutoff. Pending
 *     `.pending-*.json` manifests are explicitly skipped (recovery may need
 *     them on a future launch).
 *   - For every deleted backup_path, the corresponding `sync_history.backup_path`
 *     is NULLed so the history-view query immediately sees the row as
 *     "backup_orphaned" (already handled by F2/P2-9) and disables Undo.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDb } from '../db';
import { backupRoot, backupDiskUsage } from './backup';

export interface BackupCleanupResult {
  /** Number of backup directories actually removed from disk. */
  deletedDirs: number;
  /** Total bytes freed (rough — based on a pre-delete walk). */
  deletedBytes: number;
  /** sync_history rows whose backup_path was just NULLed. */
  nulledRows: number;
  /** Total bytes still in use by backups after the sweep. */
  remainingBytes: number;
}

/**
 * Delete backup directories older than `retentionDays`. Updates sync_history
 * so any row referencing a deleted backup loses its `backup_path` and shows
 * as "expired" in the UI.
 *
 * `retentionDays <= 0` is treated as "no retention enforced" — returns
 * immediately with a zeroed result. (Lets the user disable cleanup by
 * setting it to 0 if they want, without us having to special-case "disabled".)
 */
export function cleanupOldBackups(retentionDays: number): BackupCleanupResult {
  const empty: BackupCleanupResult = {
    deletedDirs: 0,
    deletedBytes: 0,
    nulledRows: 0,
    remainingBytes: 0,
  };
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    empty.remainingBytes = backupDiskUsage();
    return empty;
  }

  const root = backupRoot();
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return empty;
  }

  const toDelete: string[] = [];
  for (const entry of entries) {
    // Skip pending recovery manifests — recoverPendingBackups owns these.
    if (entry.isFile() && entry.name.startsWith('.pending-')) continue;
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs <= cutoff) toDelete.push(full);
  }

  let deletedBytes = 0;
  let deletedDirs = 0;
  for (const dir of toDelete) {
    try {
      deletedBytes += dirSize(dir);
      fs.rmSync(dir, { recursive: true, force: true });
      deletedDirs += 1;
    } catch {
      /* leave behind, will retry next sweep */
    }
  }

  // Null out history rows that referenced any of the deleted paths. This is
  // important: the F2/P2-9 UI uses `backup_orphaned` (computed via existsSync)
  // to decide whether to show the Undo button. Nulling the column makes the
  // row visibly "no backup" and stops misleading the user.
  let nulledRows = 0;
  if (toDelete.length > 0) {
    const db = getDb();
    const placeholders = toDelete.map(() => '?').join(',');
    const result = db
      .prepare(
        `UPDATE sync_history SET backup_path = NULL
         WHERE backup_path IN (${placeholders})`,
      )
      .run(...toDelete);
    nulledRows = result.changes;
  }

  return {
    deletedDirs,
    deletedBytes,
    nulledRows,
    remainingBytes: backupDiskUsage(),
  };
}

/**
 * Convenience wrapper called from main.ts at startup. Reads retention from
 * settings (default 30), runs the sweep, swallows errors so a failed cleanup
 * doesn't keep the app from starting.
 */
export function cleanupOldBackupsBestEffort(): void {
  const db = getDb();
  const row = db
    .prepare(`SELECT value FROM settings WHERE key = 'backup_retention_days'`)
    .get() as { value: string } | undefined;
  const days = row ? Number(row.value) : 30;
  try {
    const r = cleanupOldBackups(days);
    if (r.deletedDirs > 0) {
      console.log(
        `[backup] retention sweep: removed ${r.deletedDirs} backup(s), freed ${formatBytes(r.deletedBytes)}`,
      );
    }
  } catch (err) {
    console.error('[backup] retention sweep failed:', err);
  }
}

// ───────────────────────── helpers ─────────────────────────────────────────

function dirSize(dir: string): number {
  let total = 0;
  function walk(p: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  walk(dir);
  return total;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
