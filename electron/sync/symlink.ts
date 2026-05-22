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
import { spawnSync } from 'node:child_process';
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
// G2/P2-5: hard cap on in-memory plan store. Each plan carries its full item
// list, so a compromised (or buggy) renderer that hammers sync:plan could
// inflate memory unbounded. evictExpired only removes TTL-expired plans; the
// LRU eviction guards the steady-state size.
const MAX_PLAN_STORE = 50;

interface StoredPlan {
  plan: SyncPlan;
  expiresAt: number;
}
// Map iteration order is insertion order in JS — finalizePlan inserts at the
// end, so the FIRST entries via Map.keys() are the oldest by insertion time.
const PLAN_STORE = new Map<string, StoredPlan>();

let executeInFlight = false;

/* ============================================================================
 * Public API
 * ========================================================================== */

export interface SyncFromCanonicalRequest {
  skillId: string;
  targetPlatformIds?: PlatformId[];
}

/** Plan: canonical → requested target platforms.
 *  - Target missing → symlink_create
 *  - Target is already-correct symlink → skip
 *  - Target hash matches canonical hash → skip
 *  - Target is something else (present real-dir, wrong-target symlink, broken)
 *    → symlink_replace (backup + symlink) */
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
      const targetLoc = loadLocation(req.skillId, targetId);
      items.push(
        buildItem({
          skill,
          sourceLoc,
          targetLoc,
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

export interface PromoteRequest {
  skillId: string;
  /** The specific location to elevate. If omitted, picks the first non-canonical
   *  live location (legacy orphan-promote behavior). */
  sourceLocationId?: number;
}

/**
 * Plan: take the content from a chosen location and make it the canonical's
 * content; every other non-canonical live location becomes a symlink back to
 * canonical. The canonical platform itself doesn't change — only its content.
 *
 * For each skill in the input:
 *   Step 1 (copy_to_canonical): copy source dir into canonical, backing up
 *     any existing canonical dir first.
 *   Steps 2..N (symlink_replace): for every other non-canonical live
 *     location, back it up and symlink it to the new canonical.
 *
 * The whole op shares one opGroupId; if step 1 fails the executor aborts
 * the rest of the group so the user is never left with half a promote.
 */
export function planPromoteToCanonical(requests: PromoteRequest[]): SyncPlan {
  const canonical = getCanonicalPlatform();
  const platforms = listPlatforms();
  const platformDirById = new Map(platforms.map((p) => [p.id, p.skillsDir]));
  const realDirById = realDirIndex(platforms);
  const items: SyncPlanItem[] = [];

  for (const req of requests) {
    const skill = loadSkill(req.skillId);
    if (!skill) continue;
    const allLocs = loadAllLocations(req.skillId).filter((l) => !l.is_disabled);

    // Pick the source location:
    //  - If sourceLocationId given, use that exact one (and refuse if it's the canonical itself).
    //  - Else fall back to first non-canonical (legacy orphan-promote).
    let source: LocRow | undefined;
    if (req.sourceLocationId != null) {
      source = allLocs.find((l) => l.id === req.sourceLocationId);
      if (!source) continue;
      if (source.platform_id === canonical) continue; // promoting canonical onto itself is a no-op
    } else {
      source = allLocs.find((l) => l.platform_id !== canonical);
      if (!source) continue;
    }

    const opGroupId = randomUUID();
    const canonicalRoot = realDirById.get(canonical);
    const canonicalDir = platformDirById.get(canonical);
    if (!canonicalRoot || !canonicalDir) continue;

    const existingCanonical = allLocs.find((l) => l.platform_id === canonical);

    // Step 1: copy source → canonical. doCopyToCanonical will back up the
    // existing canonical content if any.
    const copyItem = buildItem({
      skill,
      sourceLoc: source,
      targetLoc: existingCanonical,
      sourcePlatformId: source.platform_id,
      targetPlatformId: canonical,
      targetPlatformDir: canonicalDir,
      targetRoot: canonicalRoot,
      opGroupId,
      overrideAction: 'copy_to_canonical',
    });
    items.push(copyItem);
    if (copyItem.action !== 'copy_to_canonical') continue; // skip the rest if step 1 can't run

    // Steps 2..N: every live, non-canonical location becomes a symlink to
    // the new canonical content. This INCLUDES the source location itself,
    // so after promote there's no leftover "real dir" that could drift on
    // its own next time the user edits it. (The original content is still
    // backed up via the symlink_replace path, so rollback works.)
    for (const other of allLocs) {
      if (other.platform_id === canonical) continue;
      const otherRoot = realDirById.get(other.platform_id);
      const otherDir = platformDirById.get(other.platform_id);
      if (!otherRoot || !otherDir) continue;
      const replaceItem = buildItem({
        skill,
        // After step 1, the canonical's targetPath IS our new source.
        sourceLoc: {
          id: -1,
          platform_id: canonical,
          install_path: copyItem.targetPath,
          real_path: copyItem.targetPath,
          is_symlink: 0,
          is_broken_link: 0,
          is_disabled: 0,
          content_hash: source.content_hash,
          mtime: source.mtime,
        },
        targetLoc: other,
        sourcePlatformId: canonical,
        targetPlatformId: other.platform_id,
        targetPlatformDir: otherDir,
        targetRoot: otherRoot,
        opGroupId,
        overrideAction: 'symlink_replace',
      });
      items.push(replaceItem);
    }

    // If `source` was on a non-canonical platform and is NOT already in allLocs
    // as the one we replace, we also want it to end up as a symlink. The above
    // loop already covers it (it's part of allLocs).
  }
  return finalizePlan(items, 'promote_to_canonical');
}

/**
 * Plan a catalog install: copy a staged SKILL.md tree into the canonical
 * platform, then symlink it onto every requested target platform.
 *
 * The staging directory MUST already contain a complete skill tree
 * (typically `{stagingDir}/SKILL.md`). It's the caller's job to materialize
 * it before calling this; we treat it like any other on-disk source dir.
 * Every emitted SyncPlanItem carries (installedFromSource, installedFromSkillId)
 * so executeSync writes provenance into sync_history.
 *
 * NOTE: `targetBasename` is derived from `path.basename(stagingDir)` to keep
 * filesystem identity stable. The caller is expected to name the staging dir
 * after the catalog `skillId` (or the desired install basename).
 */
export interface PlanInstallArgs {
  /** Absolute path to the staged skill tree. Must be a directory with SKILL.md. */
  stagingDir: string;
  skillName: string;
  /** Hash of the staged SKILL.md (used in plan and for after-execute verify). */
  sourceHash: string;
  /** Catalog provenance — written to sync_history.installed_from_*. */
  installedFromSource: string;
  installedFromSkillId: string;
  /** Optional list of additional platforms to symlink onto (besides canonical). */
  targetPlatformIds?: PlatformId[];
}

export function planInstallFromStaging(args: PlanInstallArgs): SyncPlan {
  const canonical = getCanonicalPlatform();
  const platforms = listPlatforms();
  const platformDirById = new Map(platforms.map((p) => [p.id, p.skillsDir]));
  const realDirById = realDirIndex(platforms);
  const opGroupId = randomUUID();
  const items: SyncPlanItem[] = [];

  const canonicalDir = platformDirById.get(canonical);
  const canonicalRoot = realDirById.get(canonical);
  if (!canonicalDir || !canonicalRoot) {
    throw new Error(`canonical platform "${canonical}" is not registered`);
  }

  // Synthetic skill row — install hasn't been scanned yet, so we don't have
  // a DB id. Generate a placeholder id; it's only used for the plan items'
  // skillId field and is irrelevant once scanAll() runs post-execute.
  const placeholderSkillId = `pending:${args.installedFromSource}:${args.installedFromSkillId}`;
  const skill: SkillRow = {
    id: placeholderSkillId,
    name: args.skillName,
    content_hash: args.sourceHash,
  };

  // Synthetic source LocRow — staging dir on disk, no DB id.
  const stagingLoc: LocRow = {
    id: -1,
    platform_id: 'staging',
    install_path: args.stagingDir,
    real_path: args.stagingDir,
    is_symlink: 0,
    is_broken_link: 0,
    is_disabled: 0,
    content_hash: args.sourceHash,
    mtime: null,
  };

  // Plan-time check: reject any staging tree that contains internal symlinks.
  // Today install.ts only writes a single SKILL.md so this is preventive — but
  // any future code path (tarball install, multi-file install, recursive
  // catalog) that hands us a synthetic source tree gets this defense for free.
  // The check is at the executor too (defense in depth), but surfacing here
  // means the user sees the conflict in the confirm dialog instead of at apply.
  try {
    const symlinkAt = findFirstSymlinkInTree(args.stagingDir);
    if (symlinkAt) {
      items.push(placeholderItem({
        skill,
        sourcePlatformId: 'staging',
        targetPlatformId: canonical,
        targetPath: '',
        action: 'conflict',
        reason: 'source_has_symlink',
        opGroupId,
        sourceLocationId: -1,
        sourceRealPath: symlinkAt,
      }));
      return finalizePlan(items, 'promote_to_canonical');
    }
  } catch (err) {
    // Tree was too big / too deep to walk safely — treat as a conflict.
    items.push(placeholderItem({
      skill,
      sourcePlatformId: 'staging',
      targetPlatformId: canonical,
      targetPath: '',
      action: 'conflict',
      reason: 'source_has_symlink',
      opGroupId,
      sourceLocationId: -1,
      sourceRealPath: args.stagingDir,
    }));
    void err;
    return finalizePlan(items, 'promote_to_canonical');
  }

  // Step 1: copy staging → canonical.
  const copyItem = buildItem({
    skill,
    sourceLoc: stagingLoc,
    targetLoc: null,
    sourcePlatformId: 'staging',
    targetPlatformId: canonical,
    targetPlatformDir: canonicalDir,
    targetRoot: canonicalRoot,
    opGroupId,
    overrideAction: 'copy_to_canonical',
  });
  copyItem.installedFromSource = args.installedFromSource;
  copyItem.installedFromSkillId = args.installedFromSkillId;
  items.push(copyItem);

  // Steps 2..N: symlink_replace on each requested target platform.
  // The source for these is the future canonical path (which step 1 will
  // create). It doesn't exist yet at plan time, so we can't go through
  // buildItem (which does plan-time stat of the source). We construct the
  // items directly. dev/ino are set to 0/0 as a sentinel meaning "synthetic
  // source — skip the inode-pinning TOCTOU check at execute" (executor
  // already requires step 1 to succeed before these run, and step 1 verified
  // the staging source by hash).
  const requestedTargets = (args.targetPlatformIds ?? [])
    .filter((p) => p !== canonical)
    .filter((p) => platformDirById.has(p));

  if (copyItem.action === 'copy_to_canonical') {
    for (const targetId of requestedTargets) {
      const targetDir = platformDirById.get(targetId)!;
      const targetRoot = realDirById.get(targetId)!;
      const targetPath = path.join(targetDir, copyItem.targetBasename);
      if (!isInside(targetPath, targetRoot)) continue;
      items.push({
        skillName: args.skillName,
        skillId: placeholderSkillId,
        opGroupId,
        targetBasename: copyItem.targetBasename,
        sourcePlatformId: canonical,
        sourceLocationId: -1,
        sourceRealPath: copyItem.targetPath,
        sourceDev: 0,
        sourceIno: 0,
        sourceHash: args.sourceHash,
        targetPlatformId: targetId,
        targetPath,
        targetHash: null,
        mode: 'symlink',
        action: 'symlink_replace',
        installedFromSource: args.installedFromSource,
        installedFromSkillId: args.installedFromSkillId,
      });
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
  mtime: number | null;
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
        `SELECT id, platform_id, install_path, real_path, is_symlink, is_broken_link, is_disabled, content_hash, mtime
         FROM skill_locations WHERE skill_id = ? AND platform_id = ? AND is_disabled = 0`,
      )
      .get(skillId, platformId) as LocRow | undefined) ?? null
  );
}

function loadAllLocations(skillId: string): LocRow[] {
  return getDb()
    .prepare(
      `SELECT id, platform_id, install_path, real_path, is_symlink, is_broken_link, is_disabled, content_hash, mtime
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
  /** The target's existing DB row, if any. Lets the planner decide between
   *  symlink_create (target missing) and symlink_replace (target present but
   *  with wrong content). */
  targetLoc?: LocRow | null;
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
    targetLoc,
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

  // Synthetic source sentinel — sourceLoc.id < 0 means "this source path
  // will be produced by an earlier step in the same opGroup" (promote step
  // 2+: canonical path that step 1's copy_to_canonical will create; install
  // step 2+: same pattern). The path can't be stat-ed at plan time, but
  // that's OK: the executor aborts the whole group if step 1 fails, and
  // the dev=0/ino=0 sentinel on the emitted item tells the executor to
  // skip the TOCTOU dev+ino check at execute time. Without this branch,
  // buildItem naively statSync'd the future path and surfaced a spurious
  // `unreadable` conflict in the confirm dialog.
  const isSyntheticSource = sourceLoc.id < 0;

  // 1) Pin source identity at plan time (real sources only).
  let srcStat: fs.Stats | null = null;
  if (!isSyntheticSource) {
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

  // 3.5) Case-insensitive collision check.
  //
  // macOS APFS (default config) is case-preserving but case-insensitive: if
  // `<dir>/MySkill` exists and we try to mkdir/rename `<dir>/myskill`, the
  // OS treats them as the same inode and either no-ops or silently
  // overwrites. The scanner sees the existing entry under its real
  // (case-preserved) name, so it never matches the new lowercased name in
  // `targetLoc` lookups → classifyTarget returns `symlink_create` → the
  // executor walks straight into the silent clobber. We readdir at plan
  // time and refuse if any entry would collide case-insensitively.
  try {
    const siblings = fs.readdirSync(targetPlatformDir);
    const targetLower = rawBasename.toLowerCase();
    for (const sib of siblings) {
      if (sib !== rawBasename && sib.toLowerCase() === targetLower) {
        return placeholderItem({
          skill,
          sourcePlatformId,
          targetPlatformId,
          targetPath,
          action: 'conflict',
          reason: 'case_collision',
          opGroupId,
          sourceLocationId: sourceLoc.id,
          sourceRealPath: sourceLoc.real_path,
          targetBasename: rawBasename,
        });
      }
    }
  } catch {
    /* targetPlatformDir might not exist yet — mkdirSync will create it. */
  }

  // 4) Classify current target state.
  const action: SyncPlanItem['action'] = overrideAction ?? classifyTarget(
    targetPath,
    sourceLoc.real_path,
    sourceLoc.content_hash,
    targetLoc ?? null,
  );
  let reason: SyncPlanItem['reason'] | undefined;
  if (action === 'skip') {
    reason = targetLoc?.content_hash === sourceLoc.content_hash ? 'same_hash' : 'already_linked';
  }

  return {
    skillName: skill.name,
    skillId: skill.id,
    opGroupId,
    targetBasename: rawBasename,
    sourcePlatformId,
    sourceLocationId: sourceLoc.id,
    sourceRealPath: sourceLoc.real_path,
    // dev/ino = 0/0 marks the synthetic-source case for the executor —
    // see doSymlinkCreate (it skips the inode pin check in that case).
    sourceDev: srcStat ? Number(srcStat.dev) : 0,
    sourceIno: srcStat ? Number(srcStat.ino) : 0,
    sourceHash: sourceLoc.content_hash,
    targetPlatformId,
    targetPath,
    targetHash: targetLoc?.content_hash ?? null,
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

function classifyTarget(
  targetPath: string,
  sourceReal: string,
  sourceHash: string | null,
  targetLoc: LocRow | null,
): SyncPlanItem['action'] {
  // 1) Fast paths via DB.
  if (targetLoc) {
    if (targetLoc.is_broken_link) return 'symlink_create'; // cleanup then create
    if (targetLoc.is_symlink) {
      // The scanner already resolved real_path. If it matches source, in sync.
      if (targetLoc.real_path === sourceReal) return 'skip';
      // Symlink to something else → backup + replace.
      return 'symlink_replace';
    }
    // Real directory. Compare hashes — same content means already in sync
    // even if not a symlink (e.g. a manual copy with identical content).
    if (sourceHash && targetLoc.content_hash && sourceHash === targetLoc.content_hash) {
      return 'skip';
    }
    // Real dir with different content → stale: backup + symlink-replace.
    return 'symlink_replace';
  }
  // 2) No DB row — fall back to live FS inspection (scanner may have missed it).
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
      return 'symlink_create'; // broken
    }
    if (resolved === sourceReal) return 'skip';
    return 'symlink_replace';
  }
  if (lstat.isDirectory()) return 'symlink_replace';
  return 'conflict'; // file or special — refuse for safety
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
  // After TTL eviction, also enforce the hard size cap: evict the oldest
  // entries (Map insertion order) until we're back under MAX_PLAN_STORE.
  while (PLAN_STORE.size > MAX_PLAN_STORE) {
    const oldestKey = PLAN_STORE.keys().next().value;
    if (oldestKey === undefined) break;
    PLAN_STORE.delete(oldestKey);
  }
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
  // Pending-row pattern for crash safety.
  // Before each FS op we INSERT a row marked '_pending_'. After the op completes
  // (success or failure) we UPDATE the row with the outcome. If the process is
  // killed between insert and update, the row stays pending; recoverPendingHistory
  // (called at startup) marks abandoned rows as '_interrupted_' so they don't
  // get confused with in-progress operations on the next launch. The previous
  // post-op-only INSERT pattern lost the breadcrumb entirely if killed between
  // FS rename and INSERT — backups would orphan forever.
  //
  // op_group_id persists the in-memory grouping (already used to abort a
  // multi-step op when step 1 fails) so the rollback handler can later
  // recover all FS steps that belong to one user-level action.
  const insertPending = db.prepare(
    `INSERT INTO sync_history
       (skill_id, action, from_path, to_path, platform_id,
        before_hash, after_hash, backup_path,
        dry_run_plan, conflict_resolution,
        success, message, created_at,
        installed_from_source, installed_from_skill_id, op_group_id)
     VALUES (?, ?, ?, ?, ?,
             NULL, NULL, NULL,
             ?, ?,
             0, '_pending_', ?,
             ?, ?, ?)`,
  );
  const updateHistorySuccess = db.prepare(
    `UPDATE sync_history
     SET success = 1, message = NULL,
         before_hash = ?, after_hash = ?, backup_path = ?
     WHERE id = ?`,
  );
  const updateHistoryFailure = db.prepare(
    `UPDATE sync_history
     SET success = 0, message = ?
     WHERE id = ?`,
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
      // Insert pending row BEFORE the FS op. If we crash mid-op, the row
      // survives (marked '_pending_' until recoverPendingHistory at next boot
      // bumps it to '_interrupted_'). We never UPDATE the constant columns
      // (skill_id, action, paths) — they're written once at insert and the
      // outcome-related columns get filled in by either update statement.
      const pendingInsert = insertPending.run(
        item.skillId,
        item.action,
        item.sourceRealPath,
        item.targetPath,
        item.targetPlatformId,
        planJson,
        item.action,
        now,
        item.installedFromSource ?? null,
        item.installedFromSkillId ?? null,
        item.opGroupId,
      );
      const historyId = Number(pendingInsert.lastInsertRowid);
      try {
        const outcome = doExecuteOne(item);
        updateHistorySuccess.run(
          outcome.beforeHash,
          outcome.afterHash,
          outcome.backupPath,
          historyId,
        );
        applied.push(item);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        updateHistoryFailure.run(msg, historyId);
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
  // Synthetic-source sentinel: dev=0 && ino=0 means "this item's source did not
  // exist at plan time" (e.g. an install symlink whose source is the canonical
  // copy produced by an earlier step in the same op group). We skip the
  // dev+ino check; the prior step in the group already verified hashes, and
  // the executor aborts the group if step 1 fails.
  const sourceReal = fs.realpathSync(item.sourceRealPath);
  const srcStat = fs.statSync(sourceReal);
  if (item.sourceDev !== 0 || item.sourceIno !== 0) {
    if (Number(srcStat.dev) !== item.sourceDev || Number(srcStat.ino) !== item.sourceIno) {
      throw new Error('source has changed since plan was generated — re-plan and try again');
    }
  }
  if (!srcStat.isDirectory()) {
    throw new Error(`source is no longer a directory: ${sourceReal}`);
  }

  // E3/P2-2: defend against in-place edits between plan and execute. The
  // dev/ino pin above catches inode replacement (mv, cp -i), but an editor
  // that opens-rewrites-saves keeps the same inode. Re-hash the source's
  // SKILL.md and compare to the hash the planner recorded. If they differ,
  // the plan was confirmed against content the user no longer has → throw
  // so they re-plan and re-confirm with the current state.
  if (item.sourceHash) {
    try {
      const currentHash = createHash('sha256')
        .update(fs.readFileSync(path.join(sourceReal, 'SKILL.md')))
        .digest('hex');
      if (currentHash !== item.sourceHash) {
        throw new Error(
          `source content changed since plan was generated — re-plan and try again ` +
            `(plan=${item.sourceHash.slice(0, 8)} current=${currentHash.slice(0, 8)})`,
        );
      }
    } catch (err) {
      // ENOENT (source SKILL.md gone) is itself a "source changed" condition.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new Error('source SKILL.md disappeared since plan was generated — re-plan and try again');
      }
      throw err;
    }
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
        // Even a broken symlink is user data — it could be their last
        // pointer to a temporarily-unavailable file (iCloud evicted,
        // unmounted volume, etc.). Renaming a symlink entry is one inode
        // op, so cost is nil. createBackup preserves the link verbatim
        // and rollback can put it back.
        backupPath = createBackup(item.targetPath, item.skillName, item.targetPlatformId);
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

  // E2/H5: if we just backed up a real directory, compute its SKILL.md hash
  // from the backup so the history row carries a verifiable record of what
  // was there pre-write. Rollback can later sanity-check the backup against
  // this hash to catch silent corruption. (Backed-up symlinks have no
  // SKILL.md to read — beforeHash stays null in that case.)
  let beforeHash: string | null = null;
  if (backupPath) {
    try {
      const backedUpSkillMd = path.join(backupPath, 'SKILL.md');
      const st = fs.lstatSync(backedUpSkillMd);
      if (st.isFile()) {
        beforeHash = createHash('sha256').update(fs.readFileSync(backedUpSkillMd)).digest('hex');
      }
    } catch {
      /* No SKILL.md in backup (symlink backup, missing file) — beforeHash stays null. */
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
  return { beforeHash, afterHash: item.sourceHash, backupPath };
}

function doCopyToCanonical(item: SyncPlanItem): ExecuteOutcome {
  // Re-pin source.
  const sourceReal = fs.realpathSync(item.sourceRealPath);
  const srcStat = fs.statSync(sourceReal);
  if (Number(srcStat.dev) !== item.sourceDev || Number(srcStat.ino) !== item.sourceIno) {
    throw new Error('source has changed since plan was generated — re-plan and try again');
  }
  if (!srcStat.isDirectory()) throw new Error(`source is not a directory`);

  // Defense in depth — even if the planner missed it (or a future caller
  // bypassed the planner), refuse to copy any tree containing internal
  // symlinks. `cpSync({dereference:false})` would preserve them and a later
  // sync step could be tricked into pointing canonical-derived symlinks at
  // attacker-controlled targets outside the skills dir.
  const symlinkAt = findFirstSymlinkInTree(sourceReal);
  if (symlinkAt) {
    throw new Error(
      `refusing to copy: source tree contains a symbolic link at ${symlinkAt} — ` +
        'materialize the tree without symlinks before retrying.',
    );
  }

  reAssertTargetInPlatformRoot(item);

  const targetDir = path.dirname(item.targetPath);
  fs.mkdirSync(targetDir, { recursive: true });

  // If the canonical platform already has this skill (e.g. promote-from-stale
  // case), back up the existing content first so we can roll back. We accept
  // both real dirs and symlinks at the target — the backup helper just renames.
  let backupPath: string | null = null;
  if (fs.existsSync(item.targetPath) || isBrokenSymlink(item.targetPath)) {
    backupPath = createBackup(item.targetPath, item.skillName, item.targetPlatformId);
  }

  // Copy via temp dir, verify hash, rename.
  const tmpPath = `${item.targetPath}.myskills-copy-${randomUUID()}`;
  try {
    fs.cpSync(sourceReal, tmpPath, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      // Preserve mtime so the new canonical inherits the source's modification
      // time — otherwise canonical looks "newer" than the source we copied from.
      preserveTimestamps: true,
    });
    // Verify the copy's SKILL.md hash matches what the scanner recorded.
    // lstat first — if SKILL.md is itself a symlink we refuse to follow it
    // and hash some attacker-chosen file outside the staging tree.
    const copiedSkillMd = path.join(tmpPath, 'SKILL.md');
    const skillMdStat = fs.lstatSync(copiedSkillMd);
    if (skillMdStat.isSymbolicLink()) {
      throw new Error('copied SKILL.md is a symlink — refusing to hash through it');
    }
    const hash = createHash('sha256').update(fs.readFileSync(copiedSkillMd)).digest('hex');
    if (item.sourceHash && hash !== item.sourceHash) {
      throw new Error(`copy hash mismatch — got ${hash.slice(0, 8)} expected ${item.sourceHash.slice(0, 8)}`);
    }
    fs.renameSync(tmpPath, item.targetPath);
  } catch (err) {
    try { fs.rmSync(tmpPath, { recursive: true, force: true }); } catch { /* ignore */ }
    // Best-effort restore of the backup if we made one and the copy failed.
    if (backupPath) {
      try {
        const { restoreBackup } = require('./backup') as typeof import('./backup');
        if (!fs.existsSync(item.targetPath)) restoreBackup(backupPath, item.targetPath);
      } catch { /* ignore */ }
    }
    throw err;
  }

  // G3/P2-6: strip com.apple.quarantine recursively from the new canonical
  // copy. Skills downloaded via catalog install carry quarantine from the
  // HTTP fetch; Gatekeeper then refuses to execute any helper scripts the
  // skill bundles. ditto preserves the xattr through copy (a feature, in
  // general), so we have to clear it explicitly. Best-effort — failure
  // here is non-fatal (the skill content still works for the AI-prompt
  // use case; only embedded scripts would be blocked).
  try {
    spawnSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', item.targetPath], {
      encoding: 'utf8',
    });
  } catch {
    /* best-effort — no-op on failure */
  }
  return { beforeHash: item.targetHash, afterHash: item.sourceHash, backupPath };
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
  // Resolve the target's PARENT dir via realpath, not just the platform root.
  // The previous lexical check let an attacker (or a misbehaving sync
  // elsewhere) win by symlinking, say, `<skillsDir>/sub` to a path outside
  // root: `item.targetPath` would still start with `root` as a string, but
  // the actual FS resolution would write outside. Realpath the parent and
  // re-form the target so the containment check sees the real destination.
  // (targetPath itself doesn't exist yet — we're about to create it — so we
  // can only realpath the parent.)
  const parentDir = path.dirname(item.targetPath);
  let realParent: string;
  try {
    realParent = fs.realpathSync(parentDir);
  } catch {
    // Parent doesn't exist yet (mkdirSync runs later) — fall back to lexical.
    realParent = path.resolve(parentDir);
  }
  const realTarget = path.join(realParent, path.basename(item.targetPath));
  if (!isInside(realTarget, root)) {
    throw new Error(
      `target ${item.targetPath} resolves to ${realTarget}, which is outside platform root ${root}`,
    );
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
  if (!name) return false;
  // E4/P2-10: normalize to NFC for the safety check (but the caller keeps
  // the raw name for FS ops — APFS doesn't auto-normalize and we don't
  // want to silently rename user files). Then reject:
  //   - Any Unicode control / format / surrogate / private-use / unassigned
  //     character (\p{C}). Catches null bytes, BiDi tricks, RTL overrides,
  //     unassigned codepoints that may render differently across systems.
  //   - Known-dangerous path-separator lookalikes:
  //       U+FF0F FULLWIDTH SOLIDUS  — looks like `/` in many fonts
  //       U+FE68 SMALL REVERSE SOLIDUS — looks like `\`
  //   - Trailing dot or whitespace — APFS keeps them but Finder operations
  //     strip them, producing hash-identity mismatches on re-scan.
  const normalized = name.normalize('NFC');
  if (/\p{C}/u.test(normalized)) return false;
  if (/[／﹨]/.test(normalized)) return false;
  if (normalized === '.' || normalized === '..') return false;
  if (normalized.includes('/') || normalized.includes('\\') || normalized.includes('\0')) return false;
  if (/[.\s]$/.test(normalized)) return false;
  if (normalized.length > 240) return false;
  // Reject hidden names ('.something') — skills should never start with a dot.
  if (normalized.startsWith('.')) return false;
  return true;
}

/**
 * Walk a directory tree (lstat-only) and return the path of the first symbolic
 * link encountered, or null if the tree is symlink-free. Used by callers that
 * are about to `cpSync` a tree with `dereference: false` — a hostile symlink
 * inside the source would be preserved as a link in the destination and later
 * code (hash verify, scanner, sync to other platforms) could be tricked into
 * dereferencing it.
 *
 * Capped at MAX_TREE_NODES nodes / MAX_TREE_DEPTH depth to defend against
 * pathological inputs (a malicious tar with thousands of directories).
 */
const MAX_TREE_NODES = 5000;
const MAX_TREE_DEPTH = 32;
function findFirstSymlinkInTree(root: string): string | null {
  const stack: Array<{ p: string; d: number }> = [{ p: root, d: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const { p, d } = stack.pop()!;
    if (++visited > MAX_TREE_NODES) {
      throw new Error(`tree exceeds ${MAX_TREE_NODES} nodes — refusing to walk`);
    }
    if (d > MAX_TREE_DEPTH) {
      throw new Error(`tree depth exceeds ${MAX_TREE_DEPTH} — refusing to walk`);
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(p, e.name);
      // `withFileTypes` already gives us symlink info without following.
      if (e.isSymbolicLink()) return full;
      if (e.isDirectory()) stack.push({ p: full, d: d + 1 });
    }
  }
  return null;
}

/**
 * Find any sync_history rows that were left in the pending state by a previous
 * launch that crashed mid-execute. Mark them '_interrupted_' so they're
 * documented, never confused with in-progress writes on this launch, and
 * surface clearly in the history view as failed-and-not-rollback-able.
 *
 * Pending rows older than GRACE_MS are considered abandoned. The grace
 * period guards against a race where this function runs while a legitimate
 * execute is still in flight (shouldn't happen — main.ts calls us before
 * registerAllHandlers — but cheap belt-and-suspenders).
 *
 * NOTE: this only handles the DB-side breadcrumb. Backup files that were
 * created but never linked to a successful row become orphans on disk; the
 * backup retention sweep (G1) will clean them up after retention days.
 */
export function recoverPendingHistory(): void {
  const GRACE_MS = 30_000;
  const cutoff = Date.now() - GRACE_MS;
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE sync_history
       SET success = 0, message = '_interrupted_'
       WHERE message = '_pending_' AND created_at <= ?`,
    )
    .run(cutoff);
  if (result.changes > 0) {
    console.error(
      `[sync] recoverPendingHistory: marked ${result.changes} interrupted row(s) from previous launch`,
    );
  }
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
