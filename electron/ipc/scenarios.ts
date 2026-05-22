import { getDb } from '../db';
import { registerHandler, makeError } from './dispatcher';
import { IPC } from '../../shared/ipc-channels';
import type {
  CreateFromClusterRequest,
  CreateFromClusterResult,
  Scenario,
  ScenarioExport,
  ScenarioImportResult,
} from '../../shared/types';
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

  // Sole AI-Lens write entry. Atomic: scenario insert + skill links all
  // happen in one transaction so a partial-success state is impossible.
  // If a scenario with the same slug-key already exists, MERGES into it
  // (links the cluster's skills to the existing scenario). Re-running on
  // the same cluster is idempotent — already-linked skills are counted as
  // skipped, not error.
  registerHandler(IPC.scenarios.createFromCluster, (_e, payload) => {
    const p = payload as Partial<CreateFromClusterRequest>;
    if (!p?.name?.trim()) throw makeError('INVALID_INPUT', 'name required');
    if (!Array.isArray(p.skillIds)) throw makeError('INVALID_INPUT', 'skillIds required');
    return createFromCluster({
      name: p.name.trim(),
      skillIds: p.skillIds.filter((s): s is string => typeof s === 'string'),
      color: p.color ?? null,
    });
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

function createFromCluster(req: {
  name: string;
  skillIds: string[];
  color: string | null;
}): CreateFromClusterResult {
  const db = getDb();
  const now = Date.now();
  const key = slugify(req.name);
  if (!key) throw makeError('INVALID_INPUT', `cannot derive a key from "${req.name}"`);

  // Pre-prepared statements so the transaction stays tight.
  const findByKey = db.prepare('SELECT id FROM scenarios WHERE key = ?');
  const insertScenario = db.prepare(
    `INSERT INTO scenarios (key, name, description, color, icon, sort_order, is_builtin, created_at)
     VALUES (?, ?, NULL, ?, NULL, 999, 0, ?)`,
  );
  const findSkill = db.prepare('SELECT 1 FROM skills WHERE id = ?');
  const linkSkill = db.prepare(
    'INSERT OR IGNORE INTO skill_scenarios (skill_id, scenario_id, added_at) VALUES (?, ?, ?)',
  );

  let scenarioId = 0;
  let created = false;
  let skillsLinked = 0;
  let skillsSkipped = 0;

  const tx = db.transaction(() => {
    const existing = findByKey.get(key) as { id: number } | undefined;
    if (existing) {
      scenarioId = existing.id;
      created = false;
    } else {
      const r = insertScenario.run(key, req.name, req.color, now);
      scenarioId = Number(r.lastInsertRowid);
      created = true;
    }
    // De-dup the inbound id list before iterating — the AI shouldn't send
    // duplicates, but guarding here makes the counts honest.
    const seen = new Set<string>();
    for (const skillId of req.skillIds) {
      if (seen.has(skillId)) continue;
      seen.add(skillId);
      const exists = findSkill.get(skillId) as { 1: number } | undefined;
      if (!exists) {
        // Stale skill ids (e.g., the skill was rescanned-out between Map
        // generation and the user clicking Convert). Count as skipped
        // rather than failing the whole transaction.
        skillsSkipped += 1;
        continue;
      }
      const r = linkSkill.run(skillId, scenarioId, now);
      if (r.changes > 0) skillsLinked += 1;
      else skillsSkipped += 1; // already in this scenario
    }
  });
  tx();

  return { scenarioId, created, skillsLinked, skillsSkipped };
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

