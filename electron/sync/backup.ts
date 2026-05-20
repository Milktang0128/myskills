/**
 * Backup helpers used by replace-mode sync.
 * Backups live under <userDataDir>/backups/ (resolved via paths.ts) so they
 * never touch the user's skill directories (preserves SPEC §5.3 D6).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getBackupRoot } from '../paths';

export function backupRoot(): string {
  return getBackupRoot();
}

/**
 * Move `src` aside into the backup root. Atomic via rename when on the same
 * volume, else falls back to recursive copy + delete.
 *
 * @param src         The path to back up. Must exist.
 * @param skillName   Human-friendly name (used in the backup folder for sanity).
 * @param platformId  The platform the location belonged to (also for sanity).
 * @returns           The absolute path of the newly created backup.
 */
export function createBackup(src: string, skillName: string, platformId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeName = sanitizeForBackup(skillName);
  const dir = path.join(backupRoot(), `${stamp}_${platformId}_${safeName}_${randomUUID().slice(0, 8)}`);
  // Try a same-volume rename first.
  try {
    fs.renameSync(src, dir);
    return dir;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV') throw err;
  }
  // Cross-device: copy then unlink.
  fs.cpSync(src, dir, { recursive: true, dereference: false, errorOnExist: true });
  fs.rmSync(src, { recursive: true, force: true });
  return dir;
}

/**
 * Restore `backupPath` back to `targetPath`. Fails loudly if target already
 * exists (caller must clear it first) or backup doesn't exist.
 */
export function restoreBackup(backupPath: string, targetPath: string): void {
  if (!fs.existsSync(backupPath)) {
    throw new Error(`backup not found: ${backupPath}`);
  }
  if (fs.existsSync(targetPath)) {
    throw new Error(`target already exists, refusing to restore: ${targetPath}`);
  }
  try {
    fs.renameSync(backupPath, targetPath);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV') throw err;
  }
  fs.cpSync(backupPath, targetPath, { recursive: true, dereference: false, errorOnExist: true });
  fs.rmSync(backupPath, { recursive: true, force: true });
}

/** Disk usage of all backups in the backup root, in bytes. */
export function backupDiskUsage(): number {
  const root = backupRoot();
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
  walk(root);
  return total;
}

function sanitizeForBackup(s: string): string {
  return s.replace(/[\\/\x00:?*"<>|]/g, '_').slice(0, 60) || 'skill';
}
