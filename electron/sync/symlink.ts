/**
 * MVP-B safe symlink sync, Shared → target platforms.
 * Implements the plan → confirm → execute pattern from SPEC §9.
 *
 * First pass scope (per user decision on 2026-05-19):
 *   - Source MUST be the Shared pool. We do not yet support copy-from-platform
 *     or copy mode.
 *   - Action 'create' is the only one we execute. Any conflicting state
 *     (existing dir, existing different symlink, file) surfaces to the UI as
 *     'conflict' for the user to resolve manually.
 *   - Broken symlink on the target side is treated as 'create' after unlinking
 *     the dead link.
 *   - Atomic create: symlink to a temp path → realpath verify → rename onto
 *     the target. Never leaves a half-written state on failure.
 *   - Every successful write inserts a sync_history row with the dry-run plan
 *     and (for our case) backup_path=NULL since nothing was overwritten.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { listPlatforms } from '../scanner/platforms';
import { scanAll } from '../scanner';
import type {
  PlatformId,
  SyncExecuteResult,
  SyncPlan,
  SyncPlanItem,
} from '../../shared/types';

const SHARED: PlatformId = 'shared';

interface SkillSourceInfo {
  id: string;
  name: string;
  content_hash: string;
  shared_real_path: string;
}

interface LocRow {
  platform_id: string;
  install_path: string;
  real_path: string;
  is_symlink: number;
  is_broken_link: number;
}

export interface PlanRequest {
  skillId: string;
  targetPlatformIds?: PlatformId[]; // omit = all missing
}

/* ---------- Plan -------------------------------------------------------- */

export function planSync(requests: PlanRequest[]): SyncPlan {
  const db = getDb();
  const items: SyncPlanItem[] = [];
  const platforms = listPlatforms();
  const platformDirById = new Map(platforms.map((p) => [p.id, p.skillsDir]));
  // Pre-resolve each platform's skillsDir realpath for safe target containment checks.
  const realDirById = new Map<string, string>();
  for (const p of platforms) {
    try {
      realDirById.set(p.id, fs.realpathSync(p.skillsDir));
    } catch {
      // Directory may not exist yet; we'll still attempt and report failure if needed.
      realDirById.set(p.id, path.resolve(p.skillsDir));
    }
  }

  for (const req of requests) {
    const skillRow = db
      .prepare('SELECT id, name, content_hash FROM skills WHERE id = ?')
      .get(req.skillId) as { id: string; name: string; content_hash: string } | undefined;
    if (!skillRow) continue;

    // Source = Shared pool location for this skill
    const sharedLoc = db
      .prepare(
        `SELECT real_path FROM skill_locations
         WHERE skill_id = ? AND platform_id = ? AND is_disabled = 0`,
      )
      .get(skillRow.id, SHARED) as { real_path: string } | undefined;

    // Existing locations across all platforms (to know which targets are missing).
    const allLocs = db
      .prepare(
        `SELECT platform_id, install_path, real_path, is_symlink, is_broken_link
         FROM skill_locations WHERE skill_id = ? AND is_disabled = 0`,
      )
      .all(skillRow.id) as LocRow[];
    const locByPlatform = new Map(allLocs.map((l) => [l.platform_id, l]));

    const targetIds = (req.targetPlatformIds ?? platforms.map((p) => p.id))
      .filter((p) => p !== SHARED)
      .filter((p) => platformDirById.has(p));

    for (const targetId of targetIds) {
      const planItem: SyncPlanItem = {
        skillId: skillRow.id,
        skillName: skillRow.name,
        sourcePlatformId: SHARED,
        sourceRealPath: sharedLoc?.real_path ?? '',
        targetPlatformId: targetId,
        targetPath: path.join(platformDirById.get(targetId)!, skillRow.name),
        mode: 'symlink',
        action: 'create',
      };

      if (!sharedLoc) {
        planItem.action = 'conflict';
        planItem.reason = 'shared_pool_missing';
        items.push(planItem);
        continue;
      }

      // Safety: target must be inside the platform's real skillsDir.
      const targetReal = path.resolve(planItem.targetPath);
      const targetRoot = realDirById.get(targetId)!;
      if (!isInside(targetReal, targetRoot)) {
        planItem.action = 'conflict';
        planItem.reason = 'target_outside_root';
        items.push(planItem);
        continue;
      }

      const existing = locByPlatform.get(targetId);
      if (existing) {
        if (existing.is_symlink && !existing.is_broken_link) {
          if (existing.real_path === sharedLoc.real_path) {
            planItem.action = 'skip';
            planItem.reason = 'already_linked';
          } else {
            planItem.action = 'conflict';
            planItem.reason = 'target_exists_symlink_other';
          }
        } else if (existing.is_broken_link) {
          planItem.action = 'create'; // we cleanup broken link then create
        } else {
          planItem.action = 'conflict';
          planItem.reason = 'target_exists_dir';
        }
      } else {
        // Not in DB. Still need to check FS in case scanner missed it.
        const fsState = inspectFsTarget(planItem.targetPath);
        if (fsState === 'absent') planItem.action = 'create';
        else if (fsState === 'broken_symlink') planItem.action = 'create';
        else if (fsState === 'dir') {
          planItem.action = 'conflict';
          planItem.reason = 'target_exists_dir';
        } else if (fsState === 'file') {
          planItem.action = 'conflict';
          planItem.reason = 'target_exists_file';
        } else if (fsState === 'symlink') {
          // Symlink that isn't tracked — could be to anything.
          planItem.action = 'conflict';
          planItem.reason = 'target_exists_symlink_other';
        }
      }
      items.push(planItem);
    }
  }

  return { generatedAt: Date.now(), items };
}

/* ---------- Execute ----------------------------------------------------- */

export async function executeSync(plan: SyncPlan): Promise<SyncExecuteResult> {
  const db = getDb();
  const insertHistory = db.prepare(
    `INSERT INTO sync_history
       (skill_id, action, from_path, to_path, platform_id, before_hash, after_hash,
        backup_path, dry_run_plan, conflict_resolution, success, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const applied: SyncPlanItem[] = [];
  const skipped: SyncPlanItem[] = [];
  const failed: Array<{ item: SyncPlanItem; message: string }> = [];

  const now = Date.now();
  const planJson = JSON.stringify(plan);

  // Each item is its own transaction-equivalent: we want partial success to remain visible.
  for (const item of plan.items) {
    if (item.action === 'skip' || item.action === 'conflict') {
      skipped.push(item);
      continue;
    }
    if (item.action !== 'create' && item.action !== 'replace') {
      skipped.push(item);
      continue;
    }
    try {
      doCreateSymlink(item);
      insertHistory.run(
        item.skillId,
        'symlink',
        item.sourceRealPath,
        item.targetPath,
        item.targetPlatformId,
        null, // before_hash: nothing existed
        null, // after_hash: hashing the symlink target is the source hash; cheaper to skip here
        null, // backup_path: nothing backed up (we only run when target absent/broken)
        planJson,
        'create',
        1,
        null,
        now,
      );
      applied.push(item);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      insertHistory.run(
        item.skillId,
        'symlink',
        item.sourceRealPath,
        item.targetPath,
        item.targetPlatformId,
        null,
        null,
        null,
        planJson,
        'create',
        0,
        msg,
        now,
      );
      failed.push({ item, message: msg });
    }
  }

  // Rescan so the in-memory matrix reflects what we just did.
  await scanAll();

  return { applied, skipped, failed };
}

/* ---------- Helpers ----------------------------------------------------- */

function doCreateSymlink(item: SyncPlanItem): void {
  // Re-verify source is still a real directory.
  const sourceReal = fs.realpathSync(item.sourceRealPath);
  const sourceStat = fs.statSync(sourceReal);
  if (!sourceStat.isDirectory()) throw new Error(`source is not a directory: ${sourceReal}`);

  const targetDir = path.dirname(item.targetPath);
  fs.mkdirSync(targetDir, { recursive: true });

  // If target is a broken symlink, remove it first (per SPEC §9.3).
  if (isBrokenSymlink(item.targetPath)) {
    fs.unlinkSync(item.targetPath);
  }

  // Atomic create: symlink → temp → verify → rename.
  const tmpPath = `${item.targetPath}.myskills-tmp-${randomUUID()}`;
  fs.symlinkSync(sourceReal, tmpPath);
  try {
    const verified = fs.realpathSync(tmpPath);
    if (verified !== sourceReal) {
      throw new Error(`symlink verify failed: ${verified} ≠ ${sourceReal}`);
    }
    fs.renameSync(tmpPath, item.targetPath);
  } catch (err) {
    // Clean up the temp link if anything went wrong before the rename.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function inspectFsTarget(p: string): 'absent' | 'broken_symlink' | 'symlink' | 'dir' | 'file' {
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(p);
  } catch {
    return 'absent';
  }
  if (lstat.isSymbolicLink()) {
    try {
      fs.statSync(p); // follows symlink
      return 'symlink';
    } catch {
      return 'broken_symlink';
    }
  }
  if (lstat.isDirectory()) return 'dir';
  return 'file';
}

function isBrokenSymlink(p: string): boolean {
  return inspectFsTarget(p) === 'broken_symlink';
}

function isInside(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  if (c === p) return false;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}
