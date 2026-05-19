import { getDb } from '../db';
import { registerHandler, makeError } from './dispatcher';
import { IPC } from '../../shared/ipc-channels';
import type { Skill, SkillFilter, SkillLocation, ScenarioRef } from '../../shared/types';

interface SkillRow {
  id: string;
  name: string;
  source_key: string;
  description: string | null;
  version: string | null;
  author: string | null;
  license: string | null;
  body_excerpt: string | null;
  content_hash: string;
  size_bytes: number;
  file_count: number;
  created_at: number;
  updated_at: number;
  last_scanned_at: number;
}

interface LocationRow {
  id: number;
  skill_id: string;
  platform_id: string;
  install_path: string;
  real_path: string;
  is_symlink: number;
  is_broken_link: number;
  is_disabled: number;
  last_seen_at: number;
}

interface ScenarioRefRow {
  skill_id: string;
  id: number;
  key: string;
  name: string;
}

export function registerSkillHandlers(): void {
  registerHandler(IPC.skills.list, (_e, payload) => {
    const filter = (payload ?? {}) as SkillFilter;
    return listSkills(filter);
  });

  registerHandler(IPC.skills.get, (_e, payload) => {
    const p = payload as { id?: string };
    if (!p?.id) throw makeError('INVALID_INPUT', 'id required');
    const skills = loadSkillsByIds([p.id]);
    if (skills.length === 0) throw makeError('NOT_FOUND', `skill ${p.id}`);
    const skill = skills[0]!;
    const fullBody = loadBody(skill);
    return { ...skill, bodyExcerpt: fullBody ?? skill.bodyExcerpt };
  });
}

// ---------------------------------------------------------------------------

function listSkills(filter: SkillFilter): Skill[] {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.search) {
    where.push('(s.name LIKE ? OR s.description LIKE ? OR s.body_excerpt LIKE ?)');
    const like = `%${filter.search}%`;
    params.push(like, like, like);
  }

  if (filter.platforms && filter.platforms.length > 0) {
    const placeholders = filter.platforms.map(() => '?').join(',');
    where.push(`s.id IN (SELECT skill_id FROM skill_locations WHERE platform_id IN (${placeholders}))`);
    params.push(...filter.platforms);
  }

  if (filter.scenarioId != null) {
    where.push('s.id IN (SELECT skill_id FROM skill_scenarios WHERE scenario_id = ?)');
    params.push(filter.scenarioId);
  }

  if (filter.scope === 'broken') {
    where.push('s.id IN (SELECT skill_id FROM skill_locations WHERE is_broken_link = 1)');
  } else if (filter.scope === 'duplicate') {
    where.push('s.content_hash IN (SELECT content_hash FROM skills GROUP BY content_hash HAVING COUNT(*) > 1)');
  } else if (filter.scope === 'unscenarized') {
    where.push('s.id NOT IN (SELECT skill_id FROM skill_scenarios)');
  } else if (filter.scope === 'disabled') {
    where.push('NOT EXISTS (SELECT 1 FROM skill_locations WHERE skill_id = s.id AND is_disabled = 0)');
  }

  const whereSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
  const sql = `SELECT s.* FROM skills s ${whereSql} ORDER BY s.name COLLATE NOCASE`;
  const rows = db.prepare(sql).all(...params) as SkillRow[];
  return loadSkillsByIds(rows.map((r) => r.id), rows);
}

function loadSkillsByIds(ids: string[], preloaded?: SkillRow[]): Skill[] {
  if (ids.length === 0) return [];
  const db = getDb();
  const rows =
    preloaded ??
    (db
      .prepare(`SELECT * FROM skills WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as SkillRow[]);

  const placeholders = ids.map(() => '?').join(',');
  const locationRows = db
    .prepare(`SELECT * FROM skill_locations WHERE skill_id IN (${placeholders}) ORDER BY platform_id, install_path`)
    .all(...ids) as LocationRow[];
  const scenarioRows = db
    .prepare(
      `SELECT ss.skill_id, sc.id, sc.key, sc.name
       FROM skill_scenarios ss
       JOIN scenarios sc ON sc.id = ss.scenario_id
       WHERE ss.skill_id IN (${placeholders})
       ORDER BY sc.sort_order, sc.name`,
    )
    .all(...ids) as ScenarioRefRow[];

  const locByIdMap = new Map<string, SkillLocation[]>();
  for (const r of locationRows) {
    const arr = locByIdMap.get(r.skill_id) ?? [];
    arr.push({
      id: r.id,
      platformId: r.platform_id,
      installPath: r.install_path,
      realPath: r.real_path,
      isSymlink: !!r.is_symlink,
      isBrokenSymlink: !!r.is_broken_link,
      isDisabled: !!r.is_disabled,
      lastSeenAt: r.last_seen_at,
    });
    locByIdMap.set(r.skill_id, arr);
  }
  const scByIdMap = new Map<string, ScenarioRef[]>();
  for (const r of scenarioRows) {
    const arr = scByIdMap.get(r.skill_id) ?? [];
    arr.push({ id: r.id, key: r.key, name: r.name });
    scByIdMap.set(r.skill_id, arr);
  }

  return rows.map((r) => rowToSkill(r, locByIdMap.get(r.id) ?? [], scByIdMap.get(r.id) ?? []));
}

function rowToSkill(r: SkillRow, locations: SkillLocation[], scenarios: ScenarioRef[]): Skill {
  return {
    id: r.id,
    name: r.name,
    sourceKey: r.source_key,
    description: r.description,
    version: r.version,
    author: r.author,
    license: r.license,
    bodyExcerpt: r.body_excerpt,
    contentHash: r.content_hash,
    sizeBytes: r.size_bytes,
    fileCount: r.file_count,
    locations,
    scenarios,
    tags: [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastScannedAt: r.last_scanned_at,
  };
}

// 1 MB cap mirrors scanner's SKILL_MD_MAX_BYTES. Anything larger is rejected
// rather than blocking the main process.
const BODY_MAX_BYTES = 1 * 1024 * 1024;

function loadBody(skill: Skill): string | null {
  const loc = skill.locations.find((l) => !l.isBrokenSymlink) ?? skill.locations[0];
  if (!loc) return null;
  try {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const p = path.join(loc.realPath, 'SKILL.md');
    const stat = fs.statSync(p);
    if (!stat.isFile() || stat.size > BODY_MAX_BYTES) return null;
    const md = fs.readFileSync(p, 'utf-8');
    const m = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    return m ? (m[2] ?? '').trim() : md;
  } catch {
    return null;
  }
}
