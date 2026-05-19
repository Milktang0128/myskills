/**
 * Canonical-driven sync (MVP-B).
 *
 * Model
 * -----
 * One platform is "canonical" (settings.canonical_platform, default 'shared').
 * The canonical platform's location for each skill is the source of truth.
 * Sync produces symlinks on the other platforms pointing at the canonical
 * realpath. Promote takes an orphan (a skill present on a non-canonical
 * platform but absent on canonical) and copies it into canonical, then
 * replaces the original with a symlink.
 *
 * Safety contract
 * ---------------
 * 1. The target filesystem basename is derived from the canonical/source
 *    *directory's basename*, not from frontmatter (which may contain `/`,
 *    `:`, `..`). The basename is additionally validated.
 * 2. Plans are server-issued and carry an opaque token. `execute` requires
 *    a matching token; it does NOT trust any other field passed back from
 *    the renderer (it re-loads the canonical plan from the in-memory store).
 * 3. Source identity is pinned at plan time by dev+inode. At execute we
 *    re-stat the source and refuse if either changed. This closes the TOCTOU
 *    window where a malicious local process could swap the source for a
 *    symlink to /etc.
 * 4. Target containment (`isInside(targetPath, platform.skillsDir)`) is
 *    re-checked at execute, after re-realpath of the platform dir.
 * 5. Writes go via temp + rename, atomically. Failures never leave half-
 *    created files behind.
 * 6. `symlink_replace` and `copy_to_canonical` always back up the existing
 *    target into ~/Library/Application Support/MySkills/backups/ first. The
 *    backup path is written to sync_history so rollback can restore it.
 * 7. A module-level in-flight lock makes `executeSync` reject concurrent
 *    calls (double-Apply, etc.).
 *
 * Per the SPEC (§9.5) every successful write is rollback-able through
 * `sync:rollback`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { getDb } from '../db';
import { listPlatforms } from '../scanner/platforms';
import { scanAll } from '../scanner';
import { createBackup } from './backup';
import type {
  PlatformId,
  SyncExecuteResult,
  SyncPlan,
  SyncPlanItem,
} from '../../shared/types';

const PLAN_TTL_MS = 5 * 60 * 1000;

interface StoredPlan {
  plan: SyncPlan;
  expiresAt: number;
}
const PLAN_STORE = new Map<string, StoredPlan>();

let executeInFlight = false;

/* ============================================================================
 * Public API
 * ========================================================================== */

export interface SyncFromCanonicalRequest {
  skillId: string;
  targetPlatformIds?: PlatformId[];
}

/** Plan: canonical → requested target platforms. */
export function planSyncFromCanonical(requests: SyncFromCanonicalRequest[]): SyncPlan {
  const canonical = getCanonicalPlatform();
  const platforms = listPlatforms();
  const platformDirById = new Map(platforms.map((p) => [p.id, p.skillsDir]));
  const realDirById = realDirIndex(platforms);
  const items: SyncPlanItem[] = [];
  const opGroupId = randomUUID();

  for (const req of requests) {
    const skill = loadSkill(req.skillId);
    if (!skill) continue;
    const sourceLoc = loadLocation(req.skillId, canonical);

    const targetIds = (req.targetPlatformIds ?? platforms.map((p) => p.id))
      .filter((p) => p !== canonical)
      .filter((p) => platformDirById.has(p));

    for (const targetId of targetIds) {
      items.push(
        buildItem({
          skill,
          sourceLoc,
          sourcePlatformId: canonical,
          targetPlatformId: targetId,
          targetPlatformDir: platformDirById.get(targetId)!,
          targetRoot: realDirById.get(targetId)!,
          opGroupId,
          reasonOnNoSource: 'canonical_missing',
        }),
      );
    }
  }
  return finalizePlan(items, 'sync_from_canonical');
}

/** Plan: copy an orphan into canonical, then symlink the original to canonical. */
export function planPromoteToCanonical(skillIds: string[]): SyncPlan {
  const canonical = getCanonicalPlatform();
  const platforms = listPlatforms();
  const platformDirById = new Map(platforms.map((p) => [p.id, p.skillsDir]));
  const realDirById = realDirIndex(platforms);
  const items: SyncPlanItem[] = [];

  for (const skillId of skillIds) {
    const skill = loadSkill(skillId);
    if (!skill) continue;
    // Promote requires the skill to NOT be in canonical and to exist somewhere else.
    const existingCanonical = loadLocation(skillId, canonical);
    if (existingCanonical) continue; // already in canonical — wrong API
    const candidates = loadAllLocations(skillId).filter(
      (l) => l.platform_id !== canonical && !l.is_disabled,
    );
    const source = candidates[0];
    if (!source) continue;

    const opGroupId = randomUUID();
    const canonicalRoot = realDirById.get(canonical);
    const canonicalDir = platformDirById.get(canonical);
    if (!canonicalRoot || !canonicalDir) continue;

    // Step 1: copy source → canonical.
    const copyItem = buildItem({
      skill,
      sourceLoc: locFromRow(source),
      sourcePlatformId: source.platform_id,
      targetPlatformId: canonical,
      targetPlatformDir: canonicalDir,
      targetRoot: canonicalRoot,
      opGroupId,
      overrideAction: 'copy_to_canonical',
    });
    items.push(copyItem);

    // Step 2: replace the original with a symlink to the new canonical path.
    // We can only sensibly enqueue this if step 1 will succeed; the plan
    // captures it optimistically and execute aborts the whole opGroup if
    // step 1 fails.
    if (copyItem.action === 'copy_to_canonical') {
      const sourceRoot = realDirById.get(source.platform_id);
      if (sourceRoot) {
        const replaceItem = buildItem({
          skill,
          // After step 1, the canonical IS our new source for step 2.
          sourceLoc: {
            id: -1, // synthetic — execute uses copyItem.targetPath as source
            platform_id: canonical,
            install_path: copyItem.targetPath,
            real_path: copyItem.targetPath,
            is_symlink: 0,
            is_broken_link: 0,
            is_disabled: 0,
            content_hash: source.content_hash,
          },
          sourcePlatformId: canonical,
          targetPlatformId: source.platform_id,
          targetPlatformDir: listPlatforms().find((p) => p.id === source.platform_id)!.skillsDir,
          targetRoot: sourceRoot,
          opGroupId,
          overrideAction: 'symlink_replace',
        });
        items.push(replaceItem);
      }
    }
  }
  return finalizePlan(items, 'promote_to_canonical');
}

export async function executeSync(token: string): Promise<SyncExecuteResult> {
  if (executeInFlight) {
    throw new Error('Another sync is already running — wait for it to finish.');
  }
  executeInFlight = true;
  try {
    const stored = consumePlan(token);
    if (!stored) throw new Error('Sync plan not found or expired — re-open the dialog.');
    return await doExecute(stored.plan);
  } finally {
    executeInFlight = false;
  }
}

/* ============================================================================
 * Internal: plan construction
 * ========================================================================== */

interface SkillRow {
  id: string;
  name: string;
  content_hash: string;
}

interface LocRow {
  id: number;
  platform_id: string;
  install_path: string;
  real_path: string;
  is_symlink: number;
  is_broken_link: number;
  is_disabled: number;
  content_hash: string | null;
}

function getCanonicalPlatform(): string {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = 'canonical_platform'")
    .get() as { value: string } | undefined;
  return row?.value ?? 'shared';
}

function loadSkill(id: string): SkillRow | null {
  return (
    (getDb()
      .prepare('SELECT id, name, content_hash FROM skills WHERE id = ?')
      .get(id) as SkillRow | undefined) ?? null
  );
}

function loadLocation(skillId: string, platformId: string): LocRow | null {
  return (
    (getDb()
      .prepare(
        `SELECT id, platform_id, install_path, real_path, is_symlink, is_broken_link, is_disabled, content_hash
         FROM skill_locations WHERE skill_id = ? AND platform_id = ? AND is_disabled = 0`,
      )
      .get(skillId, platformId) as LocRow | undefined) ?? null
  );
}

function loadAllLocations(skillId: string): LocRow[] {
  return getDb()
    .prepare(
      `SELECT id, platform_id, install_path, real_path, is_symlink, is_broken_link, is_disabled, content_hash
       FROM skill_locations WHERE skill_id = ?`,
    )
    .all(skillId) as LocRow[];
}

function locFromRow(r: LocRow): LocRow {
  return r;
}

interface BuildArgs {
  skill: SkillRow;
  sourceLoc: LocRow | null;
  sourcePlatformId: PlatformId;
  targetPlatformId: PlatformId;
  targetPlatformDir: string;
  targetRoot: string;
  opGroupId: string;
  /** Force a particular non-create action (used by promote planner). */
  overrideAction?: 'copy_to_canonical' | 'symlink_replace';
  reasonOnNoSource?: 'canonical_missing';
}

function buildItem(args: BuildArgs): SyncPlanItem {
  const {
    skill,
    sourceLoc,
    sourcePlatformId,
    targetPlatformId,
    targetPlatformDir,
    targetRoot,
    opGroupId,
    overrideAction,
    reasonOnNoSource,
  } = args;

  if (!sourceLoc || !sourceLoc.real_path) {
    return placeholderItem({
      skill,
      sourcePlatformId,
      targetPlatformId,
      targetPath: '',
      action: 'conflict',
      reason: reasonOnNoSource ?? 'canonical_missing',
      opGroupId,
    });
  }

  // 1) Pin source identity at plan time.
  let srcStat: fs.Stats;
  try {
    srcStat = fs.statSync(sourceLoc.real_path);
  } catch (err) {
    return placeholderItem({
      skill,
      sourcePlatformId,
      targetPlatformId,
      targetPath: '',
      action: 'conflict',
      reason: 'unreadable',
      opGroupId,
      sourceLocationId: sourceLoc.id,
      sourceRealPath: sourceLoc.real_path,
    });
  }
  if (!srcStat.isDirectory()) {
    return placeholderItem({
      skill,
      sourcePlatformId,
      targetPlatformId,
      targetPath: '',
      action: 'conflict',
      reason: 'source_outside_roots',
      opGroupId,
      sourceLocationId: sourceLoc.id,
      sourceRealPath: sourceLoc.real_path,
    });
  }

  // 2) Derive a safe target basename from the actual source directory.
  const rawBasename = path.basename(sourceLoc.real_path);
  if (!isSafeBasename(rawBasename)) {
    return placeholderItem({
      skill,
      sourcePlatformId,
      targetPlatformId,
      targetPath: '',
      action: 'conflict',
      reason: 'unsafe_target_name',
      opGroupId,
      sourceLocationId: sourceLoc.id,
      sourceRealPath: sourceLoc.real_path,
    });
  }

  const targetPath = path.join(targetPlatformDir, rawBasename);

  // 3) Target containment check (against the platform's realpath).
  if (!isInside(targetPath, targetRoot)) {
    return placeholderItem({
      skill,
      sourcePlatformId,
      targetPlatformId,
      targetPath,
      action: 'conflict',
      reason: 'target_outside_root',
      opGroupId,
      sourceLocationId: sourceLoc.id,
      sourceRealPath: sourceLoc.real_path,
      targetBasename: rawBasename,
    });
  }

  // 4) Classify current target state.
  const action: SyncPlanItem['action'] = overrideAction ?? classifyTarget(
    targetPath,
    sourceLoc.real_path,
  );
  let reason: SyncPlanItem['reason'] | undefined;
  if (action === 'skip') reason = 'already_linked';

  return {
    skillName: skill.name,
    skillId: skill.id,
    opGroupId,
    targetBasename: rawBasename,
    sourcePlatformId,
    sourceLocationId: sourceLoc.id,
    sourceRealPath: sourceLoc.real_path,
    sourceDev: Number(srcStat.dev),
    sourceIno: Number(srcStat.ino),
    sourceHash: sourceLoc.content_hash,
    targetPlatformId,
    targetPath,
    targetHash: null,
    mode: 'symlink',
    action,
    reason,
  };
}

interface PlaceholderArgs {
  skill: SkillRow;
  sourcePlatformId: PlatformId;
  targetPlatformId: PlatformId;
  targetPath: string;
  action: SyncPlanItem['action'];
  reason: SyncPlanItem['reason'];
  opGroupId: string;
  sourceLocationId?: number;
  sourceRealPath?: string;
  targetBasename?: string;
}

function placeholderItem(a: PlaceholderArgs): SyncPlanItem {
  return {
    skillName: a.skill.name,
    skillId: a.skill.id,
    opGroupId: a.opGroupId,
    targetBasename: a.targetBasename ?? '',
    sourcePlatformId: a.sourcePlatformId,
    sourceLocationId: a.sourceLocationId ?? -1,
    sourceRealPath: a.sourceRealPath ?? '',
    sourceDev: 0,
    sourceIno: 0,
    sourceHash: null,
    targetPlatformId: a.targetPlatformId,
    targetPath: a.targetPath,
    targetHash: null,
    mode: 'symlink',
    action: a.action,
    reason: a.reason,
  };
}

function classifyTarget(targetPath: string, sourceReal: string): SyncPlanItem['action'] {
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(targetPath);
  } catch {
    return 'symlink_create';
  }
  if (lstat.isSymbolicLink()) {
    let resolved: string | null;
    try {
      resolved = fs.realpathSync(targetPath);
    } catch {
      // broken symlink — safe to replace
      return 'symlink_create';
    }
    if (resolved === sourceReal) return 'skip';
    return 'conflict'; // existing symlink points elsewhere
  }
  if (lstat.isDirectory()) return 'conflict'; // real directory
  return 'conflict'; // file or special
}

function finalizePlan(items: SyncPlanItem[], op: SyncPlan['operation']): SyncPlan {
  const now = Date.now();
  const token = randomUUID();
  const plan: SyncPlan = {
    token,
    generatedAt: now,
    expiresAt: now + PLAN_TTL_MS,
    operation: op,
    items,
  };
  PLAN_STORE.set(token, { plan, expiresAt: plan.expiresAt });
  evictExpired();
  return plan;
}

function consumePlan(token: string): StoredPlan | null {
  const s = PLAN_STORE.get(token);
  if (!s) return null;
  PLAN_STORE.delete(token);
  if (s.expiresAt < Date.now()) return null;
  return s;
}

function evictExpired(): void {
  const now = Date.now();
  for (const [k, v] of PLAN_STORE) {
    if (v.expiresAt < now) PLAN_STORE.delete(k);
  }
}

/* ============================================================================
 * Internal: execute
 * ========================================================================== */

async function doExecute(plan: SyncPlan): Promise<SyncExecuteResult> {
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

  const planJson = JSON.stringify(plan);
  const now = Date.now();

  // Group by opGroupId so a multi-step promote can be aborted if step 1 fails.
  const groups = new Map<string, SyncPlanItem[]>();
  for (const item of plan.items) {
    const arr = groups.get(item.opGroupId) ?? [];
    arr.push(item);
    groups.set(item.opGroupId, arr);
  }

  for (const [, items] of groups) {
    let groupAborted = false;
    for (const item of items) {
      if (groupAborted) {
        skipped.push(item);
        continue;
      }
      if (item.action === 'skip' || item.action === 'conflict') {
        skipped.push(item);
        continue;
      }
      try {
        const outcome = doExecuteOne(item);
        insertHistory.run(
          item.skillId,
          item.action,
          item.sourceRealPath,
          item.targetPath,
          item.targetPlatformId,
          outcome.beforeHash,
          outcome.afterHash,
          outcome.backupPath,
          planJson,
          item.action,
          1,
          null,
          now,
        );
        applied.push(item);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        insertHistory.run(
          item.skillId,
          item.action,
          item.sourceRealPath,
          item.targetPath,
          item.targetPlatformId,
          null,
          null,
          null,
          planJson,
          item.action,
          0,
          msg,
          now,
        );
        failed.push({ item, message: msg });
        groupAborted = true; // don't run later steps in the same op group
      }
    }
  }

  await scanAll();
  return { applied, skipped, failed };
}

interface ExecuteOutcome {
  beforeHash: string | null;
  afterHash: string | null;
  backupPath: string | null;
}

function doExecuteOne(item: SyncPlanItem): ExecuteOutcome {
  switch (item.action) {
    case 'symlink_create':
      return doSymlinkCreate(item, /* allowReplaceWithBackup */ false);
    case 'symlink_replace':
      return doSymlinkCreate(item, /* allowReplaceWithBackup */ true);
    case 'copy_to_canonical':
      return doCopyToCanonical(item);
    default:
      throw new Error(`refusing to execute unknown action: ${item.action}`);
  }
}

function doSymlinkCreate(item: SyncPlanItem, allowReplace: boolean): ExecuteOutcome {
  // Re-pin source by inode+dev. This is the TOCTOU defense from SPEC.
  const sourceReal = fs.realpathSync(item.sourceRealPath);
  const srcStat = fs.statSync(sourceReal);
  if (Number(srcStat.dev) !== item.sourceDev || Number(srcStat.ino) !== item.sourceIno) {
    throw new Error('source has changed since plan was generated — re-plan and try again');
  }
  if (!srcStat.isDirectory()) {
    throw new Error(`source is no longer a directory: ${sourceReal}`);
  }

  // Re-check target containment against the platform root's current realpath.
  reAssertTargetInPlatformRoot(item);

  const targetDir = path.dirname(item.targetPath);
  fs.mkdirSync(targetDir, { recursive: true });

  let backupPath: string | null = null;
  if (fs.existsSync(item.targetPath) || isBrokenSymlink(item.targetPath)) {
    const lstat = fs.lstatSync(item.targetPath);
    if (lstat.isSymbolicLink()) {
      if (isBrokenSymlink(item.targetPath)) {
        // Dead symlink — safe to unlink without backup.
        fs.unlinkSync(item.targetPath);
      } else {
        const resolved = fs.realpathSync(item.targetPath);
        if (resolved === sourceReal) return { beforeHash: null, afterHash: null, backupPath: null };
        if (!allowReplace) throw new Error('target is a symlink to a different path');
        backupPath = createBackup(item.targetPath, item.skillName, item.targetPlatformId);
      }
    } else {
      if (!allowReplace) throw new Error('target already exists and replace was not authorized');
      backupPath = createBackup(item.targetPath, item.skillName, item.targetPlatformId);
    }
  }

  // Atomic create: temp link → rename.
  const tmpPath = `${item.targetPath}.myskills-tmp-${randomUUID()}`;
  fs.symlinkSync(sourceReal, tmpPath);
  try {
    fs.renameSync(tmpPath, item.targetPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
  return { beforeHash: null, afterHash: item.sourceHash, backupPath };
}

function doCopyToCanonical(item: SyncPlanItem): ExecuteOutcome {
  // Re-pin source.
  const sourceReal = fs.realpathSync(item.sourceRealPath);
  const srcStat = fs.statSync(sourceReal);
  if (Number(srcStat.dev) !== item.sourceDev || Number(srcStat.ino) !== item.sourceIno) {
    throw new Error('source has changed since plan was generated — re-plan and try again');
  }
  if (!srcStat.isDirectory()) throw new Error(`source is not a directory`);

  reAssertTargetInPlatformRoot(item);

  const targetDir = path.dirname(item.targetPath);
  fs.mkdirSync(targetDir, { recursive: true });

  if (fs.existsSync(item.targetPath)) {
    throw new Error(`target already exists, refusing to copy into it: ${item.targetPath}`);
  }

  // Copy via temp dir, verify hash, rename.
  const tmpPath = `${item.targetPath}.myskills-copy-${randomUUID()}`;
  try {
    fs.cpSync(sourceReal, tmpPath, { recursive: true, dereference: false, errorOnExist: true });
    // Verify the copy's SKILL.md hash matches what the scanner recorded.
    const copiedSkillMd = path.join(tmpPath, 'SKILL.md');
    const hash = createHash('sha256').update(fs.readFileSync(copiedSkillMd)).digest('hex');
    if (item.sourceHash && hash !== item.sourceHash) {
      throw new Error(`copy hash mismatch — got ${hash.slice(0, 8)} expected ${item.sourceHash.slice(0, 8)}`);
    }
    fs.renameSync(tmpPath, item.targetPath);
  } catch (err) {
    try { fs.rmSync(tmpPath, { recursive: true, force: true }); } catch { /* ignore */ }
    throw err;
  }
  return { beforeHash: null, afterHash: item.sourceHash, backupPath: null };
}

function reAssertTargetInPlatformRoot(item: SyncPlanItem): void {
  const platform = listPlatforms().find((p) => p.id === item.targetPlatformId);
  if (!platform) throw new Error(`unknown target platform ${item.targetPlatformId}`);
  let root: string;
  try {
    root = fs.realpathSync(platform.skillsDir);
  } catch {
    root = path.resolve(platform.skillsDir);
  }
  if (!isInside(item.targetPath, root)) {
    throw new Error(`target ${item.targetPath} is no longer inside platform root ${root}`);
  }
}

/* ============================================================================
 * Helpers
 * ========================================================================== */

function realDirIndex(platforms: ReturnType<typeof listPlatforms>): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of platforms) {
    try {
      m.set(p.id, fs.realpathSync(p.skillsDir));
    } catch {
      m.set(p.id, path.resolve(p.skillsDir));
    }
  }
  return m;
}

function isSafeBasename(name: string): boolean {
  if (!name || name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  if (name.length > 240) return false;
  // Reject hidden names ('.something') — skills should never start with a dot.
  if (name.startsWith('.')) return false;
  return true;
}

function isInside(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  if (c === p) return false;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

function isBrokenSymlink(p: string): boolean {
  try {
    fs.lstatSync(p);
  } catch {
    return false;
  }
  try {
    fs.statSync(p);
    return false;
  } catch {
    // lstat ok, stat failed → likely broken symlink
    try {
      return fs.lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  }
}
