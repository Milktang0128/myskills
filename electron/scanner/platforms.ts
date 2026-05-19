import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getDb } from '../db';
import type { Platform } from '../../shared/types';

interface PlatformRow {
  id: string;
  label: string;
  skills_dir: string;
  is_builtin: number;
  enabled: number;
  sort_order: number;
}

export function listPlatforms(): Platform[] {
  const rows = getDb()
    .prepare('SELECT id, label, skills_dir, is_builtin, enabled, sort_order FROM platforms ORDER BY sort_order, id')
    .all() as PlatformRow[];
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    skillsDir: r.skills_dir,
    isBuiltin: !!r.is_builtin,
    enabled: !!r.enabled,
    sortOrder: r.sort_order,
  }));
}

export function updatePlatformDir(id: string, skillsDir: string): void {
  getDb().prepare('UPDATE platforms SET skills_dir = ? WHERE id = ?').run(expandHome(skillsDir), id);
}

export function createPlatform(input: { id: string; label: string; skillsDir: string }): Platform {
  const id = input.id.trim();
  const label = input.label.trim();
  const skillsDir = expandHome(input.skillsDir.trim());
  if (!id || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
    throw new Error('platform id must be lowercase alphanumeric/underscore/dash, 1–64 chars');
  }
  if (!label) throw new Error('platform label required');
  if (!skillsDir) throw new Error('platform skillsDir required');
  const exists = getDb().prepare('SELECT 1 FROM platforms WHERE id = ?').get(id);
  if (exists) throw new Error(`platform "${id}" already exists`);
  // Append to end of sort order.
  const maxRow = getDb().prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM platforms').get() as
    | { m: number }
    | undefined;
  const next = (maxRow?.m ?? -1) + 1;
  getDb()
    .prepare(
      `INSERT INTO platforms (id, label, skills_dir, is_builtin, enabled, sort_order)
       VALUES (?, ?, ?, 0, 1, ?)`,
    )
    .run(id, label, skillsDir, next);
  const created = listPlatforms().find((p) => p.id === id);
  if (!created) throw new Error('failed to read back created platform');
  return created;
}

export function deletePlatform(id: string): void {
  const row = getDb().prepare('SELECT is_builtin FROM platforms WHERE id = ?').get(id) as
    | { is_builtin: number }
    | undefined;
  if (!row) throw new Error(`platform "${id}" not found`);
  if (row.is_builtin) throw new Error(`cannot delete built-in platform "${id}"`);
  // Forbid deletion if there are still skill_locations referencing it — otherwise the FK fails.
  const usage = getDb().prepare('SELECT COUNT(*) AS c FROM skill_locations WHERE platform_id = ?').get(id) as
    | { c: number }
    | undefined;
  if ((usage?.c ?? 0) > 0) {
    throw new Error(
      `platform "${id}" still has ${usage?.c} skill location(s) — disable it or remove the skills first`,
    );
  }
  getDb().prepare('DELETE FROM platforms WHERE id = ?').run(id);
  // If the canonical was set to this platform, fall back to 'shared' (or whatever first builtin).
  const cano = getDb().prepare("SELECT value FROM settings WHERE key = 'canonical_platform'").get() as
    | { value: string }
    | undefined;
  if (cano?.value === id) {
    getDb().prepare("UPDATE settings SET value = 'shared' WHERE key = 'canonical_platform'").run();
  }
}

export interface ProbeResult {
  /** Absolute path that was probed (after ~ expansion). */
  resolvedPath: string;
  exists: boolean;
  readable: boolean;
  /** Number of subdirectories that contain a SKILL.md (counts disabled ones too). */
  skillCount: number;
  /** True if a platform with this absolute path is already registered. */
  alreadyRegistered: boolean;
  /** Whichever platform id (if any) is registered for this path. */
  registeredAs?: string;
}

/** Probe whether a candidate path looks like a SKILL.md-style skills directory. */
export function probePath(rawPath: string): ProbeResult {
  const resolvedPath = expandHome(rawPath);
  let exists = false;
  let readable = false;
  let skillCount = 0;
  try {
    const stat = fs.statSync(resolvedPath);
    exists = stat.isDirectory();
    if (exists) {
      try {
        fs.accessSync(resolvedPath, fs.constants.R_OK);
        readable = true;
        // Cheap count — peek up to 200 entries at top level.
        const entries = fs.readdirSync(resolvedPath, { withFileTypes: true }).slice(0, 200);
        for (const e of entries) {
          if (!e.isDirectory() && !e.isSymbolicLink()) continue;
          if (e.name.startsWith('.')) continue;
          const skillMd = path.join(resolvedPath, e.name, 'SKILL.md');
          try {
            if (fs.statSync(skillMd).isFile()) skillCount += 1;
          } catch {
            // not a skill — skip
          }
        }
      } catch {
        readable = false;
      }
    }
  } catch {
    exists = false;
  }
  // Detect if any registered platform's skills_dir already resolves here.
  const allPlatforms = getDb()
    .prepare('SELECT id, skills_dir FROM platforms')
    .all() as Array<{ id: string; skills_dir: string }>;
  const match = allPlatforms.find((p) => path.resolve(expandHome(p.skills_dir)) === path.resolve(resolvedPath));
  return {
    resolvedPath,
    exists,
    readable,
    skillCount,
    alreadyRegistered: !!match,
    registeredAs: match?.id,
  };
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export interface PlatformRootStatus {
  platform: Platform;
  exists: boolean;
  readable: boolean;
}

export function checkPlatformRoot(p: Platform): PlatformRootStatus {
  let exists = false;
  let readable = false;
  try {
    const stat = fs.statSync(p.skillsDir);
    exists = stat.isDirectory();
    if (exists) {
      fs.accessSync(p.skillsDir, fs.constants.R_OK);
      readable = true;
    }
  } catch {
    // not exists or not accessible
  }
  return { platform: p, exists, readable };
}

/**
 * Detect whether `entry` inside a platform's skills dir represents the
 * "disabled" container (`.disabled/`) rather than a skill folder.
 */
export function isDisabledContainer(name: string): boolean {
  return name === '.disabled';
}

export function joinSafe(root: string, ...rest: string[]): string {
  const joined = path.join(root, ...rest);
  const resolved = path.resolve(joined);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error(`path escape: ${joined}`);
  }
  return resolved;
}
