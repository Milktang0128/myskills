import { getDb } from '../db';
import { registerHandler } from './dispatcher';
import { IPC } from '../../shared/ipc-channels';
import type {
  CoverageCell,
  CoverageCellState,
  CoverageMatrix,
  CoverageRow,
  PlatformId,
} from '../../shared/types';

interface PlatformRow {
  id: string;
  sort_order: number;
}

interface SkillRow {
  id: string;
  name: string;
  source_key: string;
  description: string | null;
}

interface LocRow {
  skill_id: string;
  platform_id: string;
  install_path: string;
  real_path: string;
  is_symlink: number;
  is_broken_link: number;
  is_disabled: number;
}

const SHARED: PlatformId = 'shared';

export function registerCoverageHandlers(): void {
  registerHandler(IPC.coverage.matrix, () => buildMatrix());
}

function buildMatrix(): CoverageMatrix {
  const db = getDb();
  const platformRows = db
    .prepare('SELECT id, sort_order FROM platforms WHERE enabled = 1 ORDER BY sort_order, id')
    .all() as PlatformRow[];
  const platforms: PlatformId[] = platformRows.map((p) => p.id);

  const skillRows = db
    .prepare('SELECT id, name, source_key, description FROM skills ORDER BY name COLLATE NOCASE')
    .all() as SkillRow[];

  const locRows = db
    .prepare(
      `SELECT skill_id, platform_id, install_path, real_path, is_symlink, is_broken_link, is_disabled
       FROM skill_locations`,
    )
    .all() as LocRow[];

  // Group locations by skill.
  const locsBySkill = new Map<string, LocRow[]>();
  for (const r of locRows) {
    const arr = locsBySkill.get(r.skill_id) ?? [];
    arr.push(r);
    locsBySkill.set(r.skill_id, arr);
  }

  // Pre-index realpath → platformId for symlink resolution.
  const realPathOwner = new Map<string, PlatformId>();
  for (const r of locRows) {
    if (!r.is_symlink) realPathOwner.set(r.real_path, r.platform_id);
  }

  const rows: CoverageRow[] = skillRows.map((skill) => {
    const locs = locsBySkill.get(skill.id) ?? [];
    const cells: Record<string, CoverageCell> = {};
    for (const p of platforms) {
      cells[p] = { state: 'missing' };
    }
    let hasSharedSource = false;
    for (const loc of locs) {
      let state: CoverageCellState;
      if (loc.is_broken_link) state = 'broken';
      else if (loc.is_disabled) state = 'disabled';
      else if (loc.is_symlink) {
        state = realPathOwner.has(loc.real_path) ? 'symlink' : 'symlink_other';
      } else {
        state = 'present';
      }
      const cell: CoverageCell = {
        state,
        installPath: loc.install_path,
        realPath: loc.real_path,
      };
      if (state === 'symlink') {
        cell.resolvesToPlatformId = realPathOwner.get(loc.real_path);
      }
      cells[loc.platform_id] = cell;
      if (loc.platform_id === SHARED && state === 'present') hasSharedSource = true;
    }
    const missingOn = platforms.filter((p) => cells[p]!.state === 'missing');
    return {
      skillId: skill.id,
      skillName: skill.name,
      sourceKey: skill.source_key,
      description: skill.description,
      cells,
      missingOn,
      hasSharedSource,
    };
  });

  return { platforms, rows };
}
