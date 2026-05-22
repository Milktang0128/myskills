/**
 * Bulk AI categorization service.
 *
 * Unlike the passive per-skill scheduler (`categorize.ts`), this is a
 * **user-initiated** batch job. The user clicks "AI 一键归类" in the 未分类
 * view; this module collects every unscenarized skill, sends them to the
 * LLM in one call (or several batches if there are too many), and returns
 * a plan the user can preview + edit before applying.
 *
 * Design notes
 * -----------
 * - Single LLM call up to MAX_PER_BATCH. Beyond that we batch — each batch
 *   sees the proposed scenarios from earlier batches so cross-batch
 *   clustering is consistent. (One round per batch; not iterative.)
 * - The prompt invites the LLM to PROPOSE new scenario buckets when the
 *   user's skill mix doesn't fit the existing taxonomy. Each proposed
 *   scenario carries a key + display name + reason; the UI can render and
 *   the apply step can create scenarios.
 * - Every input skill gets an assignment row — even if the LLM is unsure
 *   (target = `skip`). The user can change it in the dialog.
 * - Skills the LLM hallucinates (skillId not in input) are dropped silently.
 * - Network gate + LLM-feature gate are checked at the entry point, mirroring
 *   the LLM provider's own check (defense in depth).
 */
import { getDb } from '../db';
import { createProvider } from '../llm/provider';
import { readSecret, hasSecret } from '../secrets/safe-storage';
import { isExternalNetworkAllowed } from '../secrets/network-gate';
import { slugify } from '../../shared/slug';
import {
  VALID_LLM_PROVIDERS,
  type BulkCategorizeApplyResult,
  type BulkCategorizeAssignment,
  type BulkCategorizePlan,
  type BulkCategorizeProposedScenario,
  type LlmConfig,
  type LlmProvider,
} from '../../shared/types';

const API_KEY_NAME = 'llm.apiKey';

/**
 * Per-skill content limits sent to the LLM. These are deliberately generous
 * relative to the v0 values (200/200) because the first end-to-end test
 * showed the model skipping rows it couldn't read enough of (e.g.
 * "reader-audit" — abstract name, needed the body to disambiguate).
 *
 * Budget math for deepseek-v4-pro (128K context window):
 *   batch (20) × (~50 name + 400 desc + 600 body) ≈ 21K chars ≈ 7K tokens
 *   + system prompt (~2K) + existing scenarios (~500) = ~10K input tokens
 *   + 4K output + ~15K hidden reasoning = ~30K total per batch
 *   → ~25% of context, comfortably within budget.
 *
 * If we ever swap to a smaller-context model, lower MAX_PER_BATCH first.
 */
const MAX_DESCRIPTION_CHARS = 400;
const MAX_BODY_CHARS = 600;
/** How many skills to send to the LLM in one batch. Beyond this we chunk. */
const MAX_PER_BATCH = 20;
/** Hard upper bound on a single bulk call (UI should prompt before going huge). */
const MAX_TOTAL_SKILLS = 200;

interface ScenarioRow {
  id: number;
  key: string;
  name: string;
  description: string | null;
  color: string | null;
}

interface SkillRow {
  id: string;
  name: string;
  description: string | null;
  body_excerpt: string | null;
}

interface LlmAssignment {
  skillId: string;
  scenarioKey: string;
  why: string | null;
  isNew: boolean;
}

interface LlmBatchResponse {
  intent: string;
  proposedScenarios: Array<{
    key: string;
    name: string;
    reason: string;
    color?: string;
  }>;
  assignments: LlmAssignment[];
}

/**
 * Build a categorization plan. The renderer renders it as a preview the
 * user can edit, then ships it back via `applyBulkPlan`.
 *
 * Throws on missing config / disabled network so the renderer surfaces
 * a clear error instead of an empty plan.
 */
export async function buildBulkPlan(skillIds: string[]): Promise<BulkCategorizePlan> {
  if (!isExternalNetworkAllowed()) {
    throw makeErr('EXTERNAL_NETWORK_DISABLED', 'External network is disabled in Settings.');
  }
  if (!hasSecret(API_KEY_NAME)) {
    throw makeErr('LLM_NO_KEY', 'No LLM API key configured. Set one in Settings → AI.');
  }
  const config = readConfig();
  if (!config.model) {
    throw makeErr('LLM_NO_MODEL', 'No LLM model configured. Set one in Settings → AI.');
  }

  const ids = Array.from(new Set(skillIds)).slice(0, MAX_TOTAL_SKILLS);
  if (ids.length === 0) {
    return {
      proposedScenarios: [],
      assignments: [],
      classifiedCount: 0,
      skippedCount: 0,
    };
  }

  const scenarios = readScenarios();
  const skills = readSkillsForBulk(ids);
  if (skills.length === 0) {
    return {
      proposedScenarios: [],
      assignments: [],
      classifiedCount: 0,
      skippedCount: 0,
    };
  }

  const apiKey = readSecret(API_KEY_NAME);
  const client = createProvider(config, apiKey);

  // Carry proposed scenarios across batches so the LLM sees the running
  // list and tends to reuse keys consistently (otherwise batch 1 might
  // create "version-control" and batch 2 "git-vcs" for the same concept).
  const accumulatedProposed = new Map<string, BulkCategorizeProposedScenario>();
  const allAssignments: BulkCategorizeAssignment[] = [];
  let combinedIntent = '';

  for (let offset = 0; offset < skills.length; offset += MAX_PER_BATCH) {
    const batch = skills.slice(offset, offset + MAX_PER_BATCH);
    const proposedSoFar = Array.from(accumulatedProposed.values());

    const prompt = buildPrompt(scenarios, proposedSoFar, batch);
    // Log the size so we can spot creeping prompt bloat over time.
    // Rough tokens estimate: chars / 3 for mixed CJK + English.
    const inputChars = prompt.system.length + prompt.user.length;
    console.log(
      `[ai/bulk] batch=${batch.length} inputChars=${inputChars} (~${Math.round(inputChars / 3)} tokens)`,
    );
    const res = await client.chat({
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      temperature: 0.2,
      jsonMode: true,
      maxTokens: 4096,
    });
    const parsed = parseBatchResponse(res.text);

    if (!combinedIntent && parsed.intent) combinedIntent = parsed.intent;

    // Validate scenario keys: existing keys must match real scenario rows;
    // new keys are merged into the accumulator. Anything else is dropped.
    const existingByKey = new Map(scenarios.map((s) => [s.key, s]));
    const knownNewKeys = new Set(accumulatedProposed.keys());

    for (const ps of parsed.proposedScenarios) {
      const key = normalizeScenarioKey(ps.key, ps.name);
      if (!key || existingByKey.has(key)) continue;
      const existing = accumulatedProposed.get(key);
      if (existing) {
        existing.usedByCount += 0; // increment happens per-assignment below
        continue;
      }
      accumulatedProposed.set(key, {
        key,
        name: ps.name.trim() || key,
        reason: ps.reason?.trim() || '',
        color: typeof ps.color === 'string' ? ps.color : undefined,
        usedByCount: 0,
      });
      knownNewKeys.add(key);
    }

    const batchSkillIds = new Set(batch.map((s) => s.id));
    for (const a of parsed.assignments) {
      if (!batchSkillIds.has(a.skillId)) continue; // LLM hallucination
      const skill = batch.find((s) => s.id === a.skillId)!;
      const target = resolveTarget(a, existingByKey, accumulatedProposed);
      allAssignments.push({
        skillId: a.skillId,
        skillName: skill.name,
        target,
        why: a.why?.trim() || undefined,
      });
      if (target.kind === 'new') {
        const proposed = accumulatedProposed.get(target.scenarioKey);
        if (proposed) proposed.usedByCount += 1;
      }
    }

    // Anything in the batch the LLM didn't return an assignment for → mark skip.
    const assignedIds = new Set(
      parsed.assignments.filter((a) => batchSkillIds.has(a.skillId)).map((a) => a.skillId),
    );
    for (const skill of batch) {
      if (assignedIds.has(skill.id)) continue;
      allAssignments.push({
        skillId: skill.id,
        skillName: skill.name,
        target: { kind: 'skip', reason: 'AI returned no assignment' },
      });
    }
  }

  // Drop proposed scenarios with zero usage (LLM proposed them but didn't
  // actually assign anything to them; they'd just be noise in the UI).
  const usefulProposed = Array.from(accumulatedProposed.values()).filter((p) => p.usedByCount > 0);

  const classifiedCount = allAssignments.filter((a) => a.target.kind !== 'skip').length;
  const skippedCount = allAssignments.length - classifiedCount;

  return {
    intent: combinedIntent || undefined,
    proposedScenarios: usefulProposed,
    assignments: allAssignments,
    classifiedCount,
    skippedCount,
  };
}

/**
 * Apply a (possibly user-edited) plan in a single DB transaction.
 *
 * Creates each proposed scenario that has at least one assignment pointing
 * at it. Then for every non-skip assignment, inserts the skill_scenarios
 * link (idempotent — ON CONFLICT DO NOTHING).
 */
export function applyBulkPlan(plan: BulkCategorizePlan): BulkCategorizeApplyResult {
  const db = getDb();
  const errors: BulkCategorizeApplyResult['errors'] = [];
  let newScenariosCreated = 0;
  let assignmentsApplied = 0;

  // Determine which proposed scenarios are actually referenced by at least
  // one assignment in the FINAL plan (post user edits). The UI may have
  // unticked some proposed scenarios + reassigned their skills elsewhere;
  // we only materialize scenarios that still have skills pointing at them.
  const usedNewKeys = new Set<string>();
  for (const a of plan.assignments) {
    if (a.target.kind === 'new') usedNewKeys.add(a.target.scenarioKey);
  }

  const proposedByKey = new Map(plan.proposedScenarios.map((p) => [p.key, p]));

  const now = Date.now();
  const insertScenario = db.prepare(
    `INSERT INTO scenarios (key, name, description, color, icon, sort_order, is_builtin, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, 0, ?)
     ON CONFLICT(key) DO NOTHING`,
  );
  const insertLink = db.prepare(
    `INSERT INTO skill_scenarios (skill_id, scenario_id, added_at) VALUES (?, ?, ?)
     ON CONFLICT(skill_id, scenario_id) DO NOTHING`,
  );
  const findScenarioByKey = db.prepare('SELECT id FROM scenarios WHERE key = ?');
  const maxSortRow = db.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) AS m FROM scenarios',
  );

  const tx = db.transaction(() => {
    // Create new scenarios first.
    let nextSort = ((maxSortRow.get() as { m: number } | undefined)?.m ?? -1) + 1;
    for (const key of usedNewKeys) {
      const proposal = proposedByKey.get(key);
      if (!proposal) continue;
      const res = insertScenario.run(
        proposal.key,
        proposal.name,
        proposal.reason || null,
        proposal.color || null,
        nextSort,
        now,
      );
      if (res.changes > 0) {
        newScenariosCreated += 1;
        nextSort += 1;
      }
      // Even if ON CONFLICT skipped (race), we proceed — the scenario exists.
    }

    // Build a key → id lookup covering both existing and newly-created.
    const keyToId = new Map<string, number>();
    for (const row of db.prepare('SELECT id, key FROM scenarios').all() as Array<{
      id: number;
      key: string;
    }>) {
      keyToId.set(row.key, row.id);
    }

    for (const a of plan.assignments) {
      if (a.target.kind === 'skip') continue;
      const scenarioId =
        a.target.kind === 'existing'
          ? a.target.scenarioId
          : keyToId.get(a.target.scenarioKey);
      if (!scenarioId) {
        errors.push({
          skillId: a.skillId,
          message:
            a.target.kind === 'new'
              ? `New scenario "${a.target.scenarioKey}" was not created (likely deselected).`
              : `Scenario id ${a.target.kind === 'existing' ? a.target.scenarioId : ''} not found.`,
        });
        continue;
      }
      try {
        const res = insertLink.run(a.skillId, scenarioId, now);
        if (res.changes > 0) assignmentsApplied += 1;
      } catch (err) {
        errors.push({
          skillId: a.skillId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });
  tx();

  return { newScenariosCreated, assignmentsApplied, errors };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildPrompt(
  existing: ScenarioRow[],
  proposedSoFar: BulkCategorizeProposedScenario[],
  batch: SkillRow[],
): { system: string; user: string } {
  const system =
    'You are an active librarian categorizing a user\'s AI agent skills into "scenarios" (topical buckets).\n' +
    'Your job is to CONFIDENTLY assign as many skills as possible to good scenarios — the user can override individual rows in a preview UI. Being too cautious hurts the user more than a slightly imperfect assignment.\n' +
    '\n' +
    'You are given:\n' +
    '  - existingScenarios: scenarios the user has already defined. Reuse these when a skill plausibly fits.\n' +
    '  - proposedScenarios: scenarios already proposed in earlier batches of this same session. Reuse keys exactly when applicable.\n' +
    '  - skills: skills to categorize this batch.\n' +
    '\n' +
    'Output JSON of this exact shape:\n' +
    '{\n' +
    '  "intent": string,         // one-sentence summary IN THE USER\'S LANGUAGE describing the overall skill mix\n' +
    '  "proposedScenarios": [    // NEW scenarios you propose. Be GENEROUS — propose any bucket that captures a real theme.\n' +
    '    { "key": string,        // lower-kebab-case slug, English, 1-3 words (e.g. "version-control")\n' +
    '      "name": string,       // display name IN THE USER\'S LANGUAGE (e.g. "版本管理" or "Version Control")\n' +
    '      "reason": string,     // one sentence in the user\'s language explaining what this bucket holds\n' +
    '      "color": string }     // optional hex (e.g. "#10B981")\n' +
    '  ],\n' +
    '  "assignments": [          // EXACTLY one entry per input skill\n' +
    '    { "skillId": string,    // echo the input id verbatim\n' +
    '      "scenarioKey": string,// existing key, or proposed-new key, or empty string ("") only as last resort\n' +
    '      "isNew": boolean,     // true if scenarioKey refers to one you just added to proposedScenarios\n' +
    '      "why": string }       // one sentence in the user\'s language; brief\n' +
    '  ]\n' +
    '}\n' +
    '\n' +
    'Rules (in priority order):\n' +
    '  1. ASSIGN, do not skip. Every skill has a theme — find the best fit and commit. Skip ("") only when the skill name + description are too ambiguous to read at all (rare).\n' +
    '  2. Reuse an existing scenario when the skill plausibly fits. Imperfect-but-related > skip.\n' +
    '  3. If 1-2 existing scenarios fit poorly and the skill (or a small cluster of skills) represents a real theme, PROPOSE A NEW SCENARIO. Even one skill is enough to justify a new bucket if it\'s a distinct theme (e.g. "version control", "deployment", "knowledge management").\n' +
    '  4. Propose distinctive scenario names in the user\'s language. Don\'t duplicate existing scenarios by another name.\n' +
    '  5. Never reuse a "proposedScenarios" entry that the user has not asked you to propose — those are read-only context.\n' +
    '  6. Output nothing outside the JSON.\n' +
    '\n' +
    'Examples of good behavior:\n' +
    '  - 5 skills about Git/Github → propose "version-control" / "版本管理" if no existing scenario fits.\n' +
    '  - 3 skills about Vercel/Cloudflare/deploy → propose "deployment" / "部署".\n' +
    '  - A single skill about RAG search → either fit into existing "知识" or propose "rag" / "检索增强".\n' +
    '  - A skill that\'s clearly about UI design when "创意" exists → use existing "创意".\n';

  const existingBlock = existing
    .map((s) => `- key=${s.key} name=${s.name} description=${(s.description ?? '').slice(0, 100)}`)
    .join('\n');

  const proposedBlock =
    proposedSoFar.length > 0
      ? proposedSoFar
          .map((p) => `- key=${p.key} name=${p.name} reason=${p.reason.slice(0, 100)}`)
          .join('\n')
      : '(none yet)';

  const skillsBlock = batch
    .map((s) => {
      const desc = (s.description ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION_CHARS);
      const body = (s.body_excerpt ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_BODY_CHARS);
      return `- skillId=${s.id}\n  name=${s.name}\n  description=${desc}\n  body=${body}`;
    })
    .join('\n');

  const user = `existingScenarios:\n${existingBlock}\n\nproposedScenarios:\n${proposedBlock}\n\nskills:\n${skillsBlock}`;
  return { system, user };
}

function parseBatchResponse(text: string): LlmBatchResponse {
  const empty: LlmBatchResponse = { intent: '', proposedScenarios: [], assignments: [] };
  if (!text) return empty;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return empty;
    try {
      raw = JSON.parse(m[0]);
    } catch {
      return empty;
    }
  }
  if (!raw || typeof raw !== 'object') return empty;
  const obj = raw as Record<string, unknown>;
  const intent = typeof obj.intent === 'string' ? obj.intent : '';
  const proposedScenarios: LlmBatchResponse['proposedScenarios'] = [];
  if (Array.isArray(obj.proposedScenarios)) {
    for (const p of obj.proposedScenarios) {
      if (!p || typeof p !== 'object') continue;
      const pp = p as Record<string, unknown>;
      const key = typeof pp.key === 'string' ? pp.key : '';
      const name = typeof pp.name === 'string' ? pp.name : '';
      const reason = typeof pp.reason === 'string' ? pp.reason : '';
      const color = typeof pp.color === 'string' ? pp.color : undefined;
      if (!key || !name) continue;
      proposedScenarios.push({ key, name, reason, color });
    }
  }
  const assignments: LlmAssignment[] = [];
  if (Array.isArray(obj.assignments)) {
    for (const a of obj.assignments) {
      if (!a || typeof a !== 'object') continue;
      const aa = a as Record<string, unknown>;
      const skillId = typeof aa.skillId === 'string' ? aa.skillId : '';
      const scenarioKey = typeof aa.scenarioKey === 'string' ? aa.scenarioKey : '';
      const why = typeof aa.why === 'string' ? aa.why : null;
      const isNew = aa.isNew === true;
      if (!skillId) continue;
      assignments.push({ skillId, scenarioKey, why, isNew });
    }
  }
  return { intent, proposedScenarios, assignments };
}

function resolveTarget(
  a: LlmAssignment,
  existingByKey: Map<string, ScenarioRow>,
  proposed: Map<string, BulkCategorizeProposedScenario>,
): BulkCategorizeAssignment['target'] {
  if (!a.scenarioKey) return { kind: 'skip', reason: a.why ?? undefined };
  const existing = existingByKey.get(a.scenarioKey);
  if (existing && !a.isNew) {
    return { kind: 'existing', scenarioId: existing.id };
  }
  const isProposed = proposed.has(a.scenarioKey);
  if (isProposed) {
    return { kind: 'new', scenarioKey: a.scenarioKey };
  }
  // LLM said `isNew=true` but didn't include the key in proposedScenarios,
  // or named an existing key but marked it isNew. Trust isNew=true → treat
  // as new, materialize a minimal proposed entry.
  if (a.isNew) {
    const key = normalizeScenarioKey(a.scenarioKey, a.scenarioKey);
    if (!key) return { kind: 'skip' };
    if (!proposed.has(key)) {
      proposed.set(key, {
        key,
        name: a.scenarioKey,
        reason: '',
        usedByCount: 0,
      });
    }
    return { kind: 'new', scenarioKey: key };
  }
  return { kind: 'skip' };
}

function normalizeScenarioKey(key: string, fallbackLabel: string): string {
  const trimmed = key.trim();
  if (!trimmed) return slugify(fallbackLabel);
  // Lowercase, replace non-alnum with dashes, collapse, trim. Mirrors the
  // server-side slugify so the resulting key matches what the scenarios
  // table expects.
  return slugify(trimmed);
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function readScenarios(): ScenarioRow[] {
  return getDb()
    .prepare('SELECT id, key, name, description, color FROM scenarios ORDER BY sort_order, name')
    .all() as ScenarioRow[];
}

function readSkillsForBulk(ids: string[]): SkillRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return getDb()
    .prepare(
      `SELECT id, name, description, body_excerpt
       FROM skills WHERE id IN (${placeholders})`,
    )
    .all(...ids) as SkillRow[];
}

function readConfig(): LlmConfig {
  const provider = (readSetting('llm.provider') ?? 'deepseek') as LlmProvider;
  const model = readSetting('llm.model') ?? '';
  const baseUrl = readSetting('llm.baseUrl') ?? '';
  return {
    provider: VALID_LLM_PROVIDERS.has(provider) ? provider : 'openai',
    model,
    baseUrl: baseUrl || undefined,
    hasApiKey: hasSecret(API_KEY_NAME),
  };
}

function readSetting(key: string): string | null {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function makeErr(code: string, message: string): { code: string; message: string } {
  return { code, message };
}
