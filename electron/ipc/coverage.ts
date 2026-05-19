import { getDb } from '../db';
import { registerHandler } from './dispatcher';
import { IPC } from '../../shared/ipc-channels';
import type {
  CoverageCell,
  CoverageCellState,
  CoverageDrift,
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
  id: number;
  skill_id: string;
  platform_id: string;
  install_path: string;
  real_path: string;
  is_symlink: number;
  is_broken_link: number;
  is_disabled: number;
  content_hash: string | null;
  mtime: number | null;
}

export function registerCoverageHandlers(): void {
  registerHandler(IPC.coverage.matrix, () => buildMatrix());
}

function buildMatrix(): CoverageMatrix {
  const db = getDb();
  const platformRows = db
    .prepare('SELECT id, sort_order FROM platforms WHERE enabled = 1 ORDER BY sort_order, id')
    .all() as PlatformRow[];
  const allIds = platformRows.map((p) => p.id);
  const canonicalSetting = (db
    .prepare("SELECT value FROM settings WHERE key = 'canonical_platform'")
    .get() as { value: string } | undefined)?.value ?? 'shared';
  // Fall back to the first platform if the configured canonical isn't enabled.
  const canonicalPlatform: PlatformId = allIds.includes(canonicalSetting)
    ? canonicalSetting
    : (allIds[0] ?? canonicalSetting);
  // Canonical column comes first; the rest keep their original sort order.
  const platforms: PlatformId[] = [
    canonicalPlatform,
    ...allIds.filter((id) => id !== canonicalPlatform),
  ];

  const skillRows = db
    .prepare('SELECT id, name, source_key, description FROM skills ORDER BY name COLLATE NOCASE')
    .all() as SkillRow[];

  const locRows = db
    .prepare(
      `SELECT id, skill_id, platform_id, install_path, real_path, is_symlink, is_broken_link, is_disabled, content_hash, mtime
       FROM skill_locations`,
    )
    .all() as LocRow[];

  const locsBySkill = new Map<string, LocRow[]>();
  for (const r of locRows) {
    const arr = locsBySkill.get(r.skill_id) ?? [];
    arr.push(r);
    locsBySkill.set(r.skill_id, arr);
  }

  // Index every location's real_path so we can identify symlinks that resolve
  // to a tracked location. Priority: canonical > present > symlink — so when
  // the same real_path is owned by multiple, we prefer the canonical answer.
  const realPathOwner = new Map<string, PlatformId>();
  const candidates = locRows.slice().sort((a, b) => priorityForOwner(a, canonicalPlatform) -
    priorityForOwner(b, canonicalPlatform));
  for (const r of candidates) {
    if (!realPathOwner.has(r.real_path)) realPathOwner.set(r.real_path, r.platform_id);
  }

  const rows: CoverageRow[] = skillRows.map((skill) => {
    const locs = locsBySkill.get(skill.id) ?? [];
    const cells: Record<string, CoverageCell> = {};
    for (const p of platforms) {
      cells[p] = { state: 'missing' };
    }
    const canonicalLoc = locs.find(
      (l) => l.platform_id === canonicalPlatform && !l.is_disabled,
    );
    const canonicalHash = canonicalLoc?.content_hash ?? null;
    const hasCanonicalSource = !!canonicalLoc;

    for (const loc of locs) {
      const cell: CoverageCell = {
        state: cellStateFor(loc, realPathOwner, canonicalPlatform),
        locationId: loc.id,
        installPath: loc.install_path,
        realPath: loc.real_path,
        contentHash: loc.content_hash,
        mtime: loc.mtime,
      };
      if (cell.state === 'symlink' || cell.state === 'symlink_other') {
        cell.resolvesToPlatformId = realPathOwner.get(loc.real_path);
      }
      cell.drift = computeDrift(cell, loc, canonicalPlatform, canonicalHash, hasCanonicalSource);
      cells[loc.platform_id] = cell;
    }

    const missingOn = platforms.filter((p) => cells[p]!.state === 'missing');
    const hasDrift = platforms.some((p) => cells[p]?.drift === 'stale');
    return {
      skillId: skill.id,
      skillName: skill.name,
      sourceKey: skill.source_key,
      description: skill.description,
      cells,
      missingOn,
      hasCanonicalSource,
      hasDrift,
    };
  });

  return { platforms, canonicalPlatform, rows };
}

function priorityForOwner(r: LocRow, canonical: PlatformId): number {
  // Lower number = preferred owner of a given real_path.
  if (r.is_symlink) return 30;
  if (r.platform_id === canonical) return 0;
  return 10;
}

function cellStateFor(
  loc: LocRow,
  realPathOwner: Map<string, PlatformId>,
  canonical: PlatformId,
): CoverageCellState {
  if (loc.is_broken_link) return 'broken';
  if (loc.is_disabled) return 'disabled';
  if (!loc.is_symlink) return 'present';
  // Symlink — does it resolve to the canonical's real_path?
  const owner = realPathOwner.get(loc.real_path);
  return owner === canonical ? 'symlink' : 'symlink_other';
}

function computeDrift(
  cell: CoverageCell,
  loc: LocRow,
  canonical: PlatformId,
  canonicalHash: string | null,
  hasCanonicalSource: boolean,
): CoverageDrift {
  if (loc.platform_id === canonical) return 'in_sync';
  if (!hasCanonicalSource) return 'only_here';
  if (cell.state === 'symlink') return 'in_sync';
  if (cell.state === 'present') {
    if (canonicalHash && loc.content_hash && canonicalHash !== loc.content_hash) return 'stale';
    if (canonicalHash && loc.content_hash && canonicalHash === loc.content_hash) return 'in_sync';
  }
  if (cell.state === 'symlink_other' || cell.state === 'broken') return 'stale';
  return 'in_sync';
}
