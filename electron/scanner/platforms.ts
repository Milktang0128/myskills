import * as fs from 'node:fs';
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
  getDb().prepare('UPDATE platforms SET skills_dir = ? WHERE id = ?').run(skillsDir, id);
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
