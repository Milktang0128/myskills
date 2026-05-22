import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import type { ScanError, ScanResult } from '../../shared/types';
import { parseSkill, SkillParseError } from './parser';
import { checkPlatformRoot, isDisabledContainer, listPlatforms } from './platforms';
import { enqueueSkill } from '../ai/categorize';
import { hasSecret } from '../secrets/safe-storage';
import { isExternalNetworkAllowed } from '../secrets/network-gate';

/**
 * Progress events emitted during a scan. The IPC layer translates these into
 * `IPC.events.scan*` channel sends; CLI / test shells can subscribe directly.
 */
export type ScanProgressEvent =
  | { type: 'started'; startedAt: number }
  | {
      type: 'platformDone';
      platformId: string;
      index: number;
      total: number;
      found: number;
      skipped: boolean;
    }
  | { type: 'finished'; result: ScanResult };

export type ScanProgressListener = (event: ScanProgressEvent) => void;

interface DiscoveredSkill {
  parsed: NonNullable<ReturnType<typeof parseSkill>>;
  platformId: string;
  installPath: string;
  realPath: string;
  isSymlink: boolean;
  isBrokenSymlink: boolean;
  isDisabled: boolean;
}

// Single in-flight scan promise. Concurrent callers join the same promise
// rather than racing on the FS or on module-level state.
let inFlightScan: Promise<ScanResult> | null = null;

export async function scanAll(onProgress?: ScanProgressListener): Promise<ScanResult> {
  if (inFlightScan) return inFlightScan;
  inFlightScan = (async () => {
    try {
      return await doScan(onProgress);
    } finally {
      inFlightScan = null;
    }
  })();
  return inFlightScan;
}

async function doScan(onProgress?: ScanProgressListener): Promise<ScanResult> {
  const emit = (event: ScanProgressEvent): void => {
    if (!onProgress) return;
    try {
      onProgress(event);
    } catch {
      /* listener errors must never abort a scan */
    }
  };

  const startedAt = Date.now();
  console.log('[scan] starting');
  emit({ type: 'started', startedAt });

  const db = getDb();
  const errors: ScanError[] = [];
  const discovered: DiscoveredSkill[] = [];

  const enabledPlatforms = listPlatforms().filter((p) => p.enabled);
  for (let i = 0; i < enabledPlatforms.length; i++) {
    const platform = enabledPlatforms[i]!;
    const status = checkPlatformRoot(platform);
    if (!status.exists || !status.readable) {
      emit({
        type: 'platformDone',
        platformId: platform.id,
        index: i,
        total: enabledPlatforms.length,
        found: 0,
        skipped: true,
      });
      continue;
    }

    const beforeCount = discovered.length;
    const topErrors = scanDir(platform.skillsDir, platform.id, false, discovered);
    errors.push(...topErrors);

    const disabledPath = path.join(platform.skillsDir, '.disabled');
    if (safeIsDir(disabledPath)) {
      const dErrors = scanDir(disabledPath, platform.id, true, discovered);
      errors.push(...dErrors);
    }
    emit({
      type: 'platformDone',
      platformId: platform.id,
      index: i,
      total: enabledPlatforms.length,
      found: discovered.length - beforeCount,
      skipped: false,
    });
  }

  const reconcileResult = reconcile(discovered);
  const finishedAt = Date.now();
  const durationMs = finishedAt - startedAt;

  db.prepare(
    `INSERT INTO scan_runs (started_at, finished_at, total_found, new_count, updated_count, removed_count, duration_ms, errors_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    startedAt,
    finishedAt,
    discovered.length,
    reconcileResult.added,
    reconcileResult.updated,
    reconcileResult.removed,
    durationMs,
    JSON.stringify(errors),
  );

  // Auto-categorize: queue newly added skills for LLM-suggested scenarios.
  // Cheap gate first so we don't even import the module path unnecessarily
  // when the feature is off or there's no key. The categorize module's own
  // scheduler re-checks these flags at tick time.
  if (
    reconcileResult.addedSkillIds.length > 0 &&
    isExternalNetworkAllowed() &&
    hasSecret('llm.apiKey')
  ) {
    for (const id of reconcileResult.addedSkillIds) enqueueSkill(id);
  }

  const result: ScanResult = {
    totalFound: discovered.length,
    newSkills: reconcileResult.added,
    updatedSkills: reconcileResult.updated,
    removedSkills: reconcileResult.removed,
    errors,
    durationMs,
    scannedAt: finishedAt,
  };

  console.log(
    `[scan] finished: total=${result.totalFound} new=${result.newSkills} updated=${result.updatedSkills} removed=${result.removedSkills} errors=${result.errors.length} duration=${result.durationMs}ms`,
  );
  emit({ type: 'finished', result });
  return result;
}

export async function maybeAutoScan(onProgress?: ScanProgressListener): Promise<void> {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = 'auto_scan_on_launch'")
    .get() as { value: string } | undefined;
  if (row?.value !== '1') return;
  await scanAll(onProgress);
}

export function getLastScanResult(): ScanResult | null {
  const row = getDb()
    .prepare(
      'SELECT started_at, finished_at, total_found, new_count, updated_count, removed_count, duration_ms, errors_json FROM scan_runs ORDER BY id DESC LIMIT 1',
    )
    .get() as
    | {
        started_at: number;
        finished_at: number | null;
        total_found: number;
        new_count: number;
        updated_count: number;
        removed_count: number;
        duration_ms: number | null;
        errors_json: string;
      }
    | undefined;
  if (!row || row.finished_at == null) return null;
  let errors: ScanError[] = [];
  try {
    errors = JSON.parse(row.errors_json) as ScanError[];
  } catch {
    errors = [];
  }
  return {
    totalFound: row.total_found,
    newSkills: row.new_count,
    updatedSkills: row.updated_count,
    removedSkills: row.removed_count,
    errors,
    durationMs: row.duration_ms ?? 0,
    scannedAt: row.finished_at,
  };
}

// ---------------------------------------------------------------------------

function scanDir(
  dir: string,
  platformId: string,
  isDisabledContainerScope: boolean,
  out: DiscoveredSkill[],
): ScanError[] {
  const errors: ScanError[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    errors.push({ path: dir, kind: 'unreadable', message: (err as Error).message });
    return errors;
  }

  for (const entry of entries) {
    // iCloud eviction: when iCloud Drive offloads a file/dir to free disk,
    // it leaves a `.{original-name}.icloud` placeholder. The original name
    // is no longer in the listing — only the placeholder. Without explicit
    // handling, scanDir silently skipped these (dot-prefixed), and users
    // saw their skill "disappear" from the matrix with no error. Worse, a
    // later promote from another platform could clobber the evicted
    // original when iCloud re-downloads.
    //
    // Detect the placeholder by name pattern and surface as a scan error
    // so the user sees something actionable ("download this in Finder").
    const evictedMatch = /^\.(.+)\.icloud$/.exec(entry.name);
    if (evictedMatch) {
      const originalName = evictedMatch[1];
      errors.push({
        path: path.join(dir, originalName ?? entry.name),
        kind: 'icloud_evicted',
        message: 'iCloud has evicted this skill — download it in Finder, then rescan',
      });
      continue;
    }
    if (entry.name.startsWith('.') && !isDisabledContainerScope) {
      if (entry.name === '.disabled') continue;
      continue;
    }
    if (isDisabledContainer(entry.name)) continue;

    const installPath = path.join(dir, entry.name);
    let realPath = installPath;
    let isSymlink = false;
    let isBroken = false;

    try {
      const lstat = fs.lstatSync(installPath);
      isSymlink = lstat.isSymbolicLink();
      if (isSymlink) {
        try {
          realPath = fs.realpathSync(installPath);
        } catch {
          isBroken = true;
        }
      }
    } catch (err) {
      errors.push({ path: installPath, kind: 'unreadable', message: (err as Error).message });
      continue;
    }

    if (isBroken) {
      errors.push({ path: installPath, kind: 'broken_symlink', message: 'symlink target not found' });
      continue;
    }

    let targetStat: fs.Stats;
    try {
      targetStat = fs.statSync(realPath);
    } catch (err) {
      errors.push({ path: installPath, kind: 'broken_symlink', message: (err as Error).message });
      continue;
    }
    if (!targetStat.isDirectory()) continue;

    try {
      const parsed = parseSkill(realPath);
      if (!parsed) continue;
      out.push({
        parsed,
        platformId,
        installPath,
        realPath,
        isSymlink,
        isBrokenSymlink: false,
        isDisabled: isDisabledContainerScope,
      });
    } catch (err) {
      if (err instanceof SkillParseError) {
        errors.push({ path: installPath, kind: err.kind, message: err.message });
      } else {
        errors.push({ path: installPath, kind: 'parse_error', message: (err as Error).message });
      }
    }
  }
  return errors;
}

interface ReconcileResult {
  added: number;
  updated: number;
  removed: number;
  /** IDs of skills inserted on this scan (not updates). Used by the AI
   *  auto-categorize service to know which skills are candidates for
   *  scenario suggestions. */
  addedSkillIds: string[];
}

function reconcile(discovered: DiscoveredSkill[]): ReconcileResult {
  const db = getDb();
  const now = Date.now();
  let added = 0;
  let updated = 0;
  const addedSkillIds: string[] = [];

  const findSkill = db.prepare(
    'SELECT id, content_hash FROM skills WHERE name = ? AND source_key = ?',
  );
  const insertSkill = db.prepare(
    `INSERT INTO skills (id, name, source_key, description, version, author, license, body_excerpt, content_hash, size_bytes, file_count, created_at, updated_at, last_scanned_at)
     VALUES (?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateSkill = db.prepare(
    `UPDATE skills SET description = ?, version = ?, author = ?, license = ?, body_excerpt = ?, content_hash = ?, size_bytes = ?, file_count = ?, updated_at = ?, last_scanned_at = ?
     WHERE id = ?`,
  );
  const touchSkill = db.prepare('UPDATE skills SET last_scanned_at = ? WHERE id = ?');

  const findLocation = db.prepare(
    'SELECT id FROM skill_locations WHERE platform_id = ? AND install_path = ?',
  );
  const insertLocation = db.prepare(
    `INSERT INTO skill_locations (skill_id, platform_id, install_path, real_path, is_symlink, is_broken_link, is_disabled, content_hash, mtime, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateLocation = db.prepare(
    `UPDATE skill_locations SET skill_id = ?, real_path = ?, is_symlink = ?, is_broken_link = ?, is_disabled = ?, content_hash = ?, mtime = ?, last_seen_at = ? WHERE id = ?`,
  );

  const seenLocationIds = new Set<number>();
  const seenSkillIds = new Set<string>();

  // Snapshot the pre-scan skill IDs so we can compute removed count from DB
  // state, not module-level memory.
  const preScanSkillIds = new Set(
    (db.prepare('SELECT id FROM skills').all() as { id: string }[]).map((r) => r.id),
  );

  const tx = db.transaction(() => {
    for (const d of discovered) {
      const existing = findSkill.get(d.parsed.name, 'local') as
        | { id: string; content_hash: string }
        | undefined;

      let skillId: string;
      if (!existing) {
        skillId = randomUUID();
        insertSkill.run(
          skillId,
          d.parsed.name,
          d.parsed.description,
          d.parsed.version,
          d.parsed.author,
          d.parsed.license,
          d.parsed.bodyExcerpt,
          d.parsed.contentHash,
          d.parsed.sizeBytes,
          d.parsed.fileCount,
          now,
          now,
          now,
        );
        added += 1;
        addedSkillIds.push(skillId);
      } else {
        skillId = existing.id;
        if (existing.content_hash !== d.parsed.contentHash) {
          updateSkill.run(
            d.parsed.description,
            d.parsed.version,
            d.parsed.author,
            d.parsed.license,
            d.parsed.bodyExcerpt,
            d.parsed.contentHash,
            d.parsed.sizeBytes,
            d.parsed.fileCount,
            now,
            now,
            skillId,
          );
          updated += 1;
        } else {
          touchSkill.run(now, skillId);
        }
      }
      seenSkillIds.add(skillId);

      const loc = findLocation.get(d.platformId, d.installPath) as { id: number } | undefined;
      if (loc) {
        updateLocation.run(
          skillId,
          d.realPath,
          d.isSymlink ? 1 : 0,
          d.isBrokenSymlink ? 1 : 0,
          d.isDisabled ? 1 : 0,
          d.parsed.contentHash,
          Math.round(d.parsed.mtime),
          now,
          loc.id,
        );
        seenLocationIds.add(loc.id);
      } else {
        const r = insertLocation.run(
          skillId,
          d.platformId,
          d.installPath,
          d.realPath,
          d.isSymlink ? 1 : 0,
          d.isBrokenSymlink ? 1 : 0,
          d.isDisabled ? 1 : 0,
          d.parsed.contentHash,
          Math.round(d.parsed.mtime),
          now,
        );
        seenLocationIds.add(Number(r.lastInsertRowid));
      }
    }

    // Remove locations not seen this scan.
    const allLocationRows = db.prepare('SELECT id FROM skill_locations').all() as { id: number }[];
    const toRemove = allLocationRows.filter((r) => !seenLocationIds.has(r.id)).map((r) => r.id);
    if (toRemove.length > 0) {
      const placeholders = toRemove.map(() => '?').join(',');
      db.prepare(`DELETE FROM skill_locations WHERE id IN (${placeholders})`).run(...toRemove);
    }

    // Remove orphan skills, but PRESERVE any with surviving scenario assignments
    // (per SPEC §6 — scenarios are user data, not derivable from the FS).
    db.exec(
      `DELETE FROM skills
       WHERE id NOT IN (SELECT DISTINCT skill_id FROM skill_locations)
         AND id NOT IN (SELECT DISTINCT skill_id FROM skill_scenarios)`,
    );
  });
  tx();

  // Removed count: pre-scan skill IDs that didn't survive AND we didn't touch this scan.
  let removed = 0;
  for (const id of preScanSkillIds) {
    if (!seenSkillIds.has(id)) {
      const stillThere = db.prepare('SELECT 1 FROM skills WHERE id = ?').get(id);
      if (!stillThere) removed += 1;
    }
  }

  return { added, updated, removed, addedSkillIds };
}

function safeIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
