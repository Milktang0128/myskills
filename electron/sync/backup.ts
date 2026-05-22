/**
 * Backup helpers for replace-mode sync.
 *
 * Lives under <userDataDir>/backups/ so it never touches the user's skill
 * directories (preserves SPEC §5.3 D6). Permissions are locked to 0o700
 * because backups are full copies of user-curated content and other local
 * users on the same Mac shouldn't be able to read them.
 *
 * Key invariants:
 *   1. **Atomic same-volume rename** is the fast path — when src and the
 *      backup root are on the same APFS volume, `renameSync` is one
 *      kernel-level operation and preserves every byte and xattr.
 *   2. **EXDEV (cross-volume) path is durably recoverable** — we write a
 *      pending manifest BEFORE copying so a crash between cp and rm-src
 *      leaves a breadcrumb that `recoverPendingBackups()` can finish on
 *      next launch. macOS users with iCloud-resident skills cross volumes
 *      to ~/Library/Application Support routinely, so this path matters.
 *   3. **Full-fidelity cross-volume copy** uses `/usr/bin/ditto` instead
 *      of `fs.cpSync`. ditto preserves extended attributes (quarantine,
 *      Finder tags, com.apple.metadata:*), ACLs, and resource forks that
 *      fs.cpSync silently drops.
 *   4. **Post-copy hash verification** for SKILL.md catches half-written
 *      backups (truncation, EIO mid-copy) before we delete the source.
 *   5. **restoreBackup keeps user data on conflict** — if some other
 *      process created a file at targetPath during the restore window,
 *      we move it aside to `<target>.myskills-conflict-<uuid>` instead
 *      of failing with a confusing "target exists" error.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { getBackupRoot } from '../paths';

const BACKUP_DIR_MODE = 0o700;
const PENDING_PREFIX = '.pending-';
const DITTO_PATH = '/usr/bin/ditto';

interface PendingManifest {
  uuid: string;
  src: string;
  dest: string;
  /** SHA-256 of src/SKILL.md at copy time, if present. Used for integrity check on recovery. */
  srcSkillMdHash: string | null;
  createdAt: number;
}

export function backupRoot(): string {
  return getBackupRoot();
}

/** Initialize the backup root with the right perms. Idempotent. */
export function initBackupRoot(): void {
  const root = backupRoot();
  fs.mkdirSync(root, { recursive: true, mode: BACKUP_DIR_MODE });
  // mkdirSync's mode is masked by umask — chmod explicitly to be sure.
  try {
    fs.chmodSync(root, BACKUP_DIR_MODE);
  } catch {
    /* non-fatal: even if chmod fails (rare), the dir works. */
  }
}

/**
 * Move `src` aside into the backup root. Atomic via rename when on the
 * same volume; durably recoverable copy-then-delete when not.
 *
 * Throws if the backup cannot be made integrity-verified — caller should
 * NOT proceed with the destructive write that was supposed to follow.
 */
export function createBackup(src: string, skillName: string, platformId: string): string {
  initBackupRoot();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeName = sanitizeForBackup(skillName);
  const uuid = randomUUID();
  const dest = path.join(
    backupRoot(),
    `${stamp}_${platformId}_${safeName}_${uuid.slice(0, 8)}`,
  );

  // Same-volume fast path: rename is atomic and preserves everything for free.
  try {
    fs.renameSync(src, dest);
    try {
      fs.chmodSync(dest, BACKUP_DIR_MODE);
    } catch {
      /* ignore — symlinks reject chmod on macOS; backup is still safe. */
    }
    return dest;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV') throw err;
  }

  // Cross-volume path: durable copy-then-delete with a manifest breadcrumb.
  // Capture the SKILL.md hash NOW so post-copy verify has something to check
  // against. If src is a symlink (the broken-link backup case), there's
  // nothing to hash — we accept the rename of the symlink entry as-is.
  const srcSkillMd = path.join(src, 'SKILL.md');
  let srcSkillMdHash: string | null = null;
  try {
    if (fs.lstatSync(srcSkillMd).isFile()) {
      srcSkillMdHash = hashFile(srcSkillMd);
    }
  } catch {
    /* No SKILL.md (src is a symlink, or empty dir) — no integrity gate. */
  }

  const manifestPath = path.join(backupRoot(), `${PENDING_PREFIX}${uuid}.json`);
  const manifest: PendingManifest = {
    uuid,
    src,
    dest,
    srcSkillMdHash,
    createdAt: Date.now(),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });

  try {
    runDitto(src, dest);
    try {
      fs.chmodSync(dest, BACKUP_DIR_MODE);
    } catch {
      /* ignore — see same comment in fast path */
    }

    // Verify SKILL.md hash (if we had one). Catches truncated backups.
    if (srcSkillMdHash) {
      const destSkillMd = path.join(dest, 'SKILL.md');
      let destHash: string;
      try {
        destHash = hashFile(destSkillMd);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          throw new Error('backup is missing SKILL.md — backup may be corrupt');
        }
        throw err;
      }
      if (destHash !== srcSkillMdHash) {
        throw new Error(
          `backup SKILL.md hash mismatch — backup may be corrupt ` +
            `(src=${srcSkillMdHash.slice(0, 8)} dest=${destHash.slice(0, 8)})`,
        );
      }
    }

    // Backup is verified — delete the source.
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(manifestPath, { force: true });
    return dest;
  } catch (err) {
    // Roll back the partial backup. Source is still intact (we only delete
    // it after verification). Leave the manifest so recoverPendingBackups
    // can clean up at next launch if these cleanup rmSyncs also fail.
    try {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.rmSync(manifestPath, { force: true });
    } catch {
      /* ignore — manifest survives for boot-time recovery */
    }
    throw err;
  }
}

/**
 * Restore `backupPath` back to `targetPath`. Idempotent across the conflict
 * case: if target was concurrently created (race window between rollback's
 * unlink and this call), the conflicting content is preserved at a sibling
 * `.myskills-conflict-<uuid>` path so the user can decide what to do later.
 */
export function restoreBackup(backupPath: string, targetPath: string): void {
  if (!fs.existsSync(backupPath) && !isBrokenSymlinkPath(backupPath)) {
    throw new Error(`backup not found: ${backupPath}`);
  }

  // If target exists (created externally during restore window), set it
  // aside instead of refusing. Preserves the user's interim work AND lets
  // the restore complete.
  if (fs.existsSync(targetPath) || isBrokenSymlinkPath(targetPath)) {
    const conflictPath = `${targetPath}.myskills-conflict-${randomUUID().slice(0, 8)}`;
    fs.renameSync(targetPath, conflictPath);
  }

  // Same-volume fast path.
  try {
    fs.renameSync(backupPath, targetPath);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV') throw err;
  }

  // Cross-volume: ditto-copy then remove backup. We're already in a recovery
  // path so any failure here is reported back up and the user can investigate.
  runDitto(backupPath, targetPath);
  fs.rmSync(backupPath, { recursive: true, force: true });
}

/**
 * Scan the backup root at startup for any `.pending-*.json` manifests and
 * finish or abort the interrupted EXDEV copy they describe. Safe to call
 * before any sync/scan runs.
 *
 * Recovery semantics:
 *   - src only        → copy never completed. Drop manifest, leave src.
 *   - dest only       → copy + rm both completed. Drop manifest.
 *   - src AND dest    → copy completed, rm-src interrupted. Verify backup
 *                       hash; if good, finish by deleting src; if bad,
 *                       discard backup, leave src.
 *   - neither         → data is lost. Drop manifest (nothing recoverable).
 */
export function recoverPendingBackups(): void {
  initBackupRoot();
  const root = backupRoot();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith(PENDING_PREFIX) || !entry.name.endsWith('.json')) continue;
    const manifestPath = path.join(root, entry.name);
    let manifest: PendingManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PendingManifest;
      if (!manifest.uuid || !manifest.src || !manifest.dest) throw new Error('shape');
    } catch {
      // Corrupt manifest — drop it, nothing else we can do.
      try {
        fs.rmSync(manifestPath, { force: true });
      } catch {
        /* ignore */
      }
      continue;
    }
    try {
      finishOrAbort(manifest);
      fs.rmSync(manifestPath, { force: true });
    } catch (err) {
      // Recovery itself failed — keep manifest for next attempt.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[backup] recovery failed for ${manifest.uuid}: ${msg}`);
    }
  }
}

function finishOrAbort(m: PendingManifest): void {
  const srcExists = fs.existsSync(m.src) || isBrokenSymlinkPath(m.src);
  const destExists = fs.existsSync(m.dest) || isBrokenSymlinkPath(m.dest);

  if (srcExists && !destExists) return; // copy never started
  if (!srcExists && destExists) return; // copy+rm both succeeded
  if (!srcExists && !destExists) return; // data lost — nothing to recover

  // Both exist. Decide based on backup integrity.
  if (m.srcSkillMdHash) {
    const destSkillMd = path.join(m.dest, 'SKILL.md');
    let destHash: string | null = null;
    try {
      destHash = hashFile(destSkillMd);
    } catch {
      /* ENOENT or read error — treat as corrupt */
    }
    if (destHash !== m.srcSkillMdHash) {
      // Backup corrupt — discard it; src is still good.
      fs.rmSync(m.dest, { recursive: true, force: true });
      return;
    }
  }
  // Backup is good (or no hash gate). Finish by deleting src.
  fs.rmSync(m.src, { recursive: true, force: true });
}

/** Disk usage of all backups (excludes pending manifests), in bytes. */
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

// ───────────────────────── helpers ─────────────────────────────────────────

function runDitto(src: string, dest: string): void {
  const res = spawnSync(DITTO_PATH, [src, dest], { encoding: 'utf8' });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`ditto failed (exit ${res.status}): ${res.stderr ?? '(no stderr)'}`);
  }
}

function hashFile(p: string): string {
  const buf = fs.readFileSync(p);
  return createHash('sha256').update(buf).digest('hex');
}

function isBrokenSymlinkPath(p: string): boolean {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return false;
  }
  if (!st.isSymbolicLink()) return false;
  try {
    fs.statSync(p);
    return false;
  } catch {
    return true;
  }
}

function sanitizeForBackup(s: string): string {
  return s.replace(/[\\/\x00:?*"<>|]/g, '_').slice(0, 60) || 'skill';
}
