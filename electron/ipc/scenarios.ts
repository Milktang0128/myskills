import { getDb } from '../db';
import { registerHandler, makeError } from './dispatcher';
import { IPC } from '../../shared/ipc-channels';
import type { Scenario, ScenarioExport, ScenarioImportResult } from '../../shared/types';
import { slugify, isValidKey } from '../../shared/slug';

interface ScenarioRow {
  id: number;
  key: string;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  sort_order: number;
  is_builtin: number;
  created_at: number;
  skill_count: number;
}

export function registerScenarioHandlers(): void {
  registerHandler(IPC.scenarios.list, () => listScenarios());

  registerHandler(IPC.scenarios.create, (_e, payload) => {
    const p = payload as Partial<Scenario>;
    const key = p.key?.trim() || slugify(p.name ?? '');
    if (!p.name?.trim() || !key) throw makeError('INVALID_INPUT', 'name required');
    if (!isValidKey(key)) throw makeError('INVALID_INPUT', 'key must be kebab-case');

    const now = Date.now();
    const r = getDb()
      .prepare(
        `INSERT INTO scenarios (key, name, description, color, icon, sort_order, is_builtin, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        key,
        p.name.trim(),
        p.description ?? null,
        p.color ?? null,
        p.icon ?? null,
        p.sortOrder ?? 999,
        now,
      );
    return getScenarioById(Number(r.lastInsertRowid));
  });

  registerHandler(IPC.scenarios.update, (_e, payload) => {
    const p = payload as Partial<Scenario> & { id?: number };
    if (!p?.id) throw makeError('INVALID_INPUT', 'id required');
    const existing = getScenarioById(p.id);
    if (!existing) throw makeError('NOT_FOUND', `scenario ${p.id}`);
    getDb()
      .prepare(
        `UPDATE scenarios SET name = ?, description = ?, color = ?, icon = ?, sort_order = ? WHERE id = ?`,
      )
      .run(
        p.name?.trim() ?? existing.name,
        p.description ?? existing.description,
        p.color ?? existing.color,
        p.icon ?? existing.icon,
        p.sortOrder ?? existing.sortOrder,
        p.id,
      );
    return getScenarioById(p.id);
  });

  registerHandler(IPC.scenarios.delete, (_e, payload) => {
    const p = payload as { id?: number };
    if (!p?.id) throw makeError('INVALID_INPUT', 'id required');
    const sc = getScenarioById(p.id);
    if (!sc) throw makeError('NOT_FOUND', `scenario ${p.id}`);
    if (sc.isBuiltin) throw makeError('FORBIDDEN', 'cannot delete builtin scenario');
    getDb().prepare('DELETE FROM scenarios WHERE id = ?').run(p.id);
    return { ok: true };
  });

  registerHandler(IPC.scenarios.addSkill, (_e, payload) => {
    const p = payload as { skillId?: string; scenarioId?: number };
    if (!p?.skillId || !p?.scenarioId) throw makeError('INVALID_INPUT', 'skillId and scenarioId required');
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO skill_scenarios (skill_id, scenario_id, added_at) VALUES (?, ?, ?)`,
      )
      .run(p.skillId, p.scenarioId, Date.now());
    return { ok: true };
  });

  registerHandler(IPC.scenarios.removeSkill, (_e, payload) => {
    const p = payload as { skillId?: string; scenarioId?: number };
    if (!p?.skillId || !p?.scenarioId) throw makeError('INVALID_INPUT', 'skillId and scenarioId required');
    getDb()
      .prepare('DELETE FROM skill_scenarios WHERE skill_id = ? AND scenario_id = ?')
      .run(p.skillId, p.scenarioId);
    return { ok: true };
  });

  registerHandler(IPC.scenarios.export, () => exportScenarios());
  registerHandler(IPC.scenarios.import, (_e, payload) => {
    if (!payload || typeof payload !== 'object') throw makeError('INVALID_INPUT', 'export payload required');
    return importScenarios(payload as ScenarioExport);
  });
}

// ---------------------------------------------------------------------------

function listScenarios(): Scenario[] {
  const rows = getDb()
    .prepare(
      `SELECT s.id, s.key, s.name, s.description, s.color, s.icon, s.sort_order, s.is_builtin, s.created_at,
              (SELECT COUNT(*) FROM skill_scenarios WHERE scenario_id = s.id) AS skill_count
       FROM scenarios s
       ORDER BY s.sort_order, s.name`,
    )
    .all() as ScenarioRow[];
  return rows.map(rowToScenario);
}

function getScenarioById(id: number): Scenario | null {
  const row = getDb()
    .prepare(
      `SELECT s.id, s.key, s.name, s.description, s.color, s.icon, s.sort_order, s.is_builtin, s.created_at,
              (SELECT COUNT(*) FROM skill_scenarios WHERE scenario_id = s.id) AS skill_count
       FROM scenarios s WHERE s.id = ?`,
    )
    .get(id) as ScenarioRow | undefined;
  return row ? rowToScenario(row) : null;
}

function rowToScenario(r: ScenarioRow): Scenario {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    color: r.color,
    icon: r.icon,
    sortOrder: r.sort_order,
    isBuiltin: !!r.is_builtin,
    skillCount: r.skill_count,
  };
}

function exportScenarios(): ScenarioExport {
  const db = getDb();
  const scenarios = db
    .prepare(
      `SELECT id, key, name, description, color, icon FROM scenarios ORDER BY sort_order, name`,
    )
    .all() as Array<{ id: number; key: string; name: string; description: string | null; color: string | null; icon: string | null }>;

  const skills = db
    .prepare(
      `SELECT ss.scenario_id, s.name, s.source_key
       FROM skill_scenarios ss
       JOIN skills s ON s.id = ss.skill_id`,
    )
    .all() as Array<{ scenario_id: number; name: string; source_key: string }>;

  const skillMap = new Map<number, Array<{ name: string; sourceKey: string }>>();
  for (const s of skills) {
    const arr = skillMap.get(s.scenario_id) ?? [];
    arr.push({ name: s.name, sourceKey: s.source_key });
    skillMap.set(s.scenario_id, arr);
  }

  return {
    version: '1',
    exportedAt: Date.now(),
    scenarios: scenarios.map((sc) => ({
      key: sc.key,
      name: sc.name,
      description: sc.description,
      color: sc.color,
      icon: sc.icon,
      skills: skillMap.get(sc.id) ?? [],
    })),
  };
}

function importScenarios(payload: ScenarioExport): ScenarioImportResult {
  if (payload.version !== '1') throw makeError('UNSUPPORTED_VERSION', `version ${payload.version}`);
  const db = getDb();
  const now = Date.now();
  let created = 0;
  let merged = 0;
  let linked = 0;
  const notFound: ScenarioImportResult['skillsNotFound'] = [];

  const findScenario = db.prepare('SELECT id FROM scenarios WHERE key = ?');
  const insertScenario = db.prepare(
    `INSERT INTO scenarios (key, name, description, color, icon, sort_order, is_builtin, created_at)
     VALUES (?, ?, ?, ?, ?, 999, 0, ?)`,
  );
  const findSkill = db.prepare('SELECT id FROM skills WHERE name = ? AND source_key = ?');
  const linkSkill = db.prepare(
    'INSERT OR IGNORE INTO skill_scenarios (skill_id, scenario_id, added_at) VALUES (?, ?, ?)',
  );

  const tx = db.transaction(() => {
    for (const sc of payload.scenarios) {
      let scenarioId: number;
      const existing = findScenario.get(sc.key) as { id: number } | undefined;
      if (existing) {
        scenarioId = existing.id;
        merged += 1;
      } else {
        const r = insertScenario.run(sc.key, sc.name, sc.description, sc.color, sc.icon, now);
        scenarioId = Number(r.lastInsertRowid);
        created += 1;
      }
      for (const sk of sc.skills) {
        // NFC normalize matches scanner's identity rule.
        const nfcName = sk.name.normalize('NFC');
        const found = findSkill.get(nfcName, sk.sourceKey) as { id: string } | undefined;
        if (!found) {
          notFound.push({ scenarioKey: sc.key, skillName: sk.name, sourceKey: sk.sourceKey });
          continue;
        }
        const r = linkSkill.run(found.id, scenarioId, now);
        if (r.changes > 0) linked += 1;
      }
    }
  });
  tx();

  return { scenariosCreated: created, scenariosMerged: merged, skillsLinked: linked, skillsNotFound: notFound };
}

