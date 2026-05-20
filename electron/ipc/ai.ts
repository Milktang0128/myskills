/**
 * IPC handlers for AI scenario suggestions. The categorize module owns the
 * queue + scheduler; this layer just exposes read/accept/dismiss to the
 * renderer.
 */
import { getDb } from '../db';
import { registerHandler, makeError } from './dispatcher';
import { IPC } from '../../shared/ipc-channels';
import type { AiScenarioSuggestion, BulkCategorizePlan } from '../../shared/types';
import { getQueueLength, isSchedulerRunning } from '../ai/categorize';
import { applyBulkPlan, buildBulkPlan } from '../ai/bulk-categorize';

interface SuggestionRow {
  id: number;
  skill_id: string;
  scenario_key: string;
  scenario_name: string | null;
  scenario_color: string | null;
  reason: string | null;
  suggested_at: number;
}

export function registerAiHandlers(): void {
  registerHandler(IPC.ai.getSuggestionsForSkill, (_e, payload) => {
    const p = payload as { skillId?: string };
    if (!p?.skillId) throw makeError('INVALID_INPUT', 'skillId required');
    const rows = getDb()
      .prepare(
        `SELECT a.id, a.skill_id, a.scenario_key, a.reason, a.suggested_at,
                s.name AS scenario_name, s.color AS scenario_color
         FROM ai_scenario_suggestions a
         LEFT JOIN scenarios s ON s.key = a.scenario_key
         WHERE a.skill_id = ?
           AND a.accepted_at IS NULL
           AND a.dismissed_at IS NULL
         ORDER BY a.suggested_at DESC, a.id DESC`,
      )
      .all(p.skillId) as SuggestionRow[];
    return rows.map(rowToSuggestion);
  });

  registerHandler(IPC.ai.acceptSuggestion, (_e, payload) => {
    const p = payload as { suggestionId?: number };
    if (typeof p?.suggestionId !== 'number') throw makeError('INVALID_INPUT', 'suggestionId required');

    const db = getDb();
    const row = db
      .prepare(
        `SELECT id, skill_id, scenario_key, accepted_at, dismissed_at
         FROM ai_scenario_suggestions WHERE id = ?`,
      )
      .get(p.suggestionId) as
      | { id: number; skill_id: string; scenario_key: string; accepted_at: number | null; dismissed_at: number | null }
      | undefined;
    if (!row) throw makeError('NOT_FOUND', `suggestion ${p.suggestionId}`);
    if (row.accepted_at != null) return { ok: true as const };
    if (row.dismissed_at != null) {
      throw makeError('CONFLICT', 'suggestion already dismissed');
    }

    const scenario = db
      .prepare('SELECT id FROM scenarios WHERE key = ?')
      .get(row.scenario_key) as { id: number } | undefined;
    if (!scenario) {
      // Scenario was deleted between suggestion and accept — mark dismissed
      // so the chip disappears from the UI rather than throwing repeatedly.
      db.prepare(
        'UPDATE ai_scenario_suggestions SET dismissed_at = ? WHERE id = ?',
      ).run(Date.now(), row.id);
      throw makeError('NOT_FOUND', `scenario "${row.scenario_key}" no longer exists`);
    }

    const now = Date.now();
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT OR IGNORE INTO skill_scenarios (skill_id, scenario_id, added_at)
         VALUES (?, ?, ?)`,
      ).run(row.skill_id, scenario.id, now);
      db.prepare(
        'UPDATE ai_scenario_suggestions SET accepted_at = ? WHERE id = ?',
      ).run(now, row.id);
    });
    tx();

    return { ok: true as const };
  });

  registerHandler(IPC.ai.dismissSuggestion, (_e, payload) => {
    const p = payload as { suggestionId?: number };
    if (typeof p?.suggestionId !== 'number') throw makeError('INVALID_INPUT', 'suggestionId required');
    const r = getDb()
      .prepare(
        `UPDATE ai_scenario_suggestions
         SET dismissed_at = ?
         WHERE id = ? AND dismissed_at IS NULL AND accepted_at IS NULL`,
      )
      .run(Date.now(), p.suggestionId);
    if (r.changes === 0) {
      // Already accepted/dismissed, or doesn't exist — treat as idempotent.
      const exists = getDb()
        .prepare('SELECT 1 FROM ai_scenario_suggestions WHERE id = ?')
        .get(p.suggestionId);
      if (!exists) throw makeError('NOT_FOUND', `suggestion ${p.suggestionId}`);
    }
    return { ok: true as const };
  });

  registerHandler(IPC.ai.queueStatus, () => ({
    pending: getQueueLength(),
    schedulerRunning: isSchedulerRunning(),
  }));

  registerHandler(IPC.ai.bulkCategorize, async (_e, payload) => {
    const p = (payload ?? {}) as { skillIds?: unknown };
    if (!Array.isArray(p.skillIds)) {
      throw makeError('INVALID_INPUT', 'skillIds (string[]) required');
    }
    const ids: string[] = [];
    for (const id of p.skillIds) {
      if (typeof id !== 'string') continue;
      ids.push(id);
    }
    try {
      return await buildBulkPlan(ids);
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
        throw err;
      }
      throw makeError('AI_ERROR', err instanceof Error ? err.message : String(err));
    }
  });

  registerHandler(IPC.ai.applyBulkCategorization, (_e, payload) => {
    const p = (payload ?? {}) as { plan?: unknown };
    if (!p.plan || typeof p.plan !== 'object') {
      throw makeError('INVALID_INPUT', 'plan required');
    }
    // The renderer is trusted to ship a valid plan back (we built it for
    // them). Light validation just to catch totally-malformed payloads.
    const plan = p.plan as BulkCategorizePlan;
    if (!Array.isArray(plan.assignments) || !Array.isArray(plan.proposedScenarios)) {
      throw makeError('INVALID_INPUT', 'plan must have assignments + proposedScenarios arrays');
    }
    return applyBulkPlan(plan);
  });
}

function rowToSuggestion(r: SuggestionRow): AiScenarioSuggestion {
  return {
    id: r.id,
    skillId: r.skill_id,
    scenarioKey: r.scenario_key,
    scenarioName: r.scenario_name ?? undefined,
    scenarioColor: r.scenario_color ?? null,
    reason: r.reason,
    suggestedAt: r.suggested_at,
  };
}
