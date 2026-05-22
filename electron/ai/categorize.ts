/**
 * AI auto-categorize service.
 *
 * On scan, newly-discovered skills are pushed onto an in-memory FIFO queue.
 * A background scheduler wakes up every `ai.categorize.minIntervalMs` (default
 * 10s) and — if the feature is enabled and an LLM key is configured — drains
 * up to N skills per tick, sends them to the LLM as a single batch, and
 * writes the suggested (skill, scenario) pairs to `ai_scenario_suggestions`.
 *
 * Design notes
 * - The scheduler is *lazy-started* on the first `enqueueSkill()` call so we
 *   don't need to touch electron/main.ts. The first import of this module is
 *   side-effect-free; only the first enqueue arms the interval.
 * - The queue is in-memory only. If the app crashes before processQueue runs,
 *   the suggestions for those skills are lost — that's acceptable for an
 *   advisory feature. Users can always re-trigger a scan.
 * - All preconditions (feature toggle, API key, network gate) are re-checked
 *   inside the scheduler tick so toggling features in Settings takes effect
 *   without restarting the app.
 * - LLM errors are caught at the scheduler tick (logged + swallowed). The
 *   exported processQueue() rethrows so direct callers can react.
 */
import { getDb } from '../db';
import { createProvider } from '../llm/provider';
import { readSecret, hasSecret } from '../secrets/safe-storage';
import { isExternalNetworkAllowed } from '../secrets/network-gate';
import type {
  LlmChatRequest,
  LlmConfig,
  LlmProvider,
} from '../../shared/types';
import { VALID_LLM_PROVIDERS } from '../../shared/types';

const API_KEY_NAME = 'llm.apiKey';
const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_INTERVAL_MS = 10_000;
const MIN_INTERVAL_MS = 1_000; // floor — don't hammer the LLM if user misconfigures

// In-memory FIFO. Dedup'd: we don't re-queue a skillId already pending.
const queue: string[] = [];
const inQueue = new Set<string>();

let schedulerHandle: NodeJS.Timeout | null = null;
let schedulerRunning = false;
// Reentrancy guard — processQueue() is async; the interval mustn't double-fire.
let tickInFlight = false;

export function enqueueSkill(skillId: string): void {
  if (!skillId || inQueue.has(skillId)) return;
  queue.push(skillId);
  inQueue.add(skillId);
  ensureScheduler();
}

export function getQueueLength(): number {
  return queue.length;
}

export function isSchedulerRunning(): boolean {
  return schedulerRunning;
}

/**
 * Drain up to `batchSize` skills from the queue and run one LLM call to
 * suggest scenarios for them. Writes suggestions to the DB. Returns the
 * number of skills processed (0 if queue empty). Throws on LLM error so
 * the caller can decide whether to retry — the scheduler catches & logs.
 */
export async function processQueue(opts?: { batchSize?: number }): Promise<number> {
  const batchSize = Math.max(1, opts?.batchSize ?? DEFAULT_BATCH_SIZE);
  if (queue.length === 0) return 0;

  // Hard preconditions — same set the scheduler checks, but processQueue may
  // be called directly so we re-check here.
  if (!isExternalNetworkAllowed()) {
    // Leave the queue intact so we retry once the user re-enables the network.
    return 0;
  }
  if (!hasSecret(API_KEY_NAME)) return 0;

  const config = readLlmConfig();
  if (!config.model) return 0;

  const scenarios = readScenarios();
  if (scenarios.length === 0) {
    // No scenarios to suggest into — drain the queue so we don't loop forever.
    while (queue.length > 0) {
      const id = queue.shift()!;
      inQueue.delete(id);
    }
    return 0;
  }

  // Pull a batch off the queue. The skills referenced may have been deleted
  // since enqueue — we filter those out before calling the LLM.
  const batchIds: string[] = [];
  while (batchIds.length < batchSize && queue.length > 0) {
    const id = queue.shift()!;
    inQueue.delete(id);
    batchIds.push(id);
  }

  const skills = loadSkillsForPrompt(batchIds);
  if (skills.length === 0) return 0;

  const apiKey = readSecret(API_KEY_NAME);
  const client = createProvider(config, apiKey);
  const req = buildChatRequest(scenarios, skills);
  const res = await client.chat(req);

  const parsed = parseLlmResponse(res.text);
  const validKeys = new Set(scenarios.map((s) => s.key));

  let suggestionRows = 0;
  let skillIdMisses = 0;
  let scenarioKeyMisses = 0;
  const db = getDb();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO ai_scenario_suggestions
       (skill_id, scenario_key, reason, suggested_at, accepted_at, dismissed_at)
     VALUES (?, ?, ?, ?, NULL, NULL)`,
  );
  const knownSkillIds = new Set(skills.map((s) => s.id));
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const result of parsed.results) {
      if (!knownSkillIds.has(result.skillId)) {
        skillIdMisses += 1;
        continue;
      }
      for (const key of result.scenarios) {
        if (!validKeys.has(key)) {
          scenarioKeyMisses += 1;
          continue;
        }
        const r = insert.run(result.skillId, key, result.reason ?? null, now);
        if (r.changes > 0) suggestionRows += 1;
      }
    }
  });
  tx();

  // Diagnostic: when the model gives us nothing usable, log enough to debug —
  // typical failure modes are hallucinated skill IDs (model echoes the name
  // instead of the UUID) or made-up scenario keys.
  if (suggestionRows === 0) {
    const usagePart = res.usage
      ? ` usage=${res.usage.completionTokens}/${res.usage.totalTokens}`
      : '';
    console.log(
      `[ai] categorize empty: parsed=${parsed.results.length} idMisses=${skillIdMisses} keyMisses=${scenarioKeyMisses}${usagePart} responseLen=${res.text.length}`,
    );
    if (res.text.length > 0) {
      console.log(`[ai] sample response: ${res.text.slice(0, 400)}`);
    }
  }

  console.log(
    `[ai] categorized ${skills.length} skills, ${suggestionRows} suggestions`,
  );
  return skills.length;
}

// ---------------------------------------------------------------------------
// Scheduler — lazy-started on first enqueue.

function ensureScheduler(): void {
  if (schedulerHandle) return;
  const interval = readIntervalMs();
  schedulerHandle = setInterval(() => {
    void tick();
  }, interval);
  // Don't block app exit on this timer.
  if (typeof schedulerHandle.unref === 'function') schedulerHandle.unref();
  schedulerRunning = true;
}

async function tick(): Promise<void> {
  if (tickInFlight) return;
  if (queue.length === 0) return;
  if (!isAutoCategorizeEnabled()) return;
  if (!hasSecret(API_KEY_NAME)) return;
  if (!isExternalNetworkAllowed()) return;

  tickInFlight = true;
  try {
    await processQueue();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ai] processQueue failed: ${msg}`);
  } finally {
    tickInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// LLM prompt construction.

interface ScenarioForPrompt {
  key: string;
  name: string;
  description: string | null;
}

interface SkillForPrompt {
  id: string;
  name: string;
  description: string | null;
  bodyExcerpt: string | null;
}

interface LlmResult {
  skillId: string;
  scenarios: string[];
  reason: string | null;
}

interface LlmResponse {
  results: LlmResult[];
}

function buildChatRequest(
  scenarios: ScenarioForPrompt[],
  skills: SkillForPrompt[],
): LlmChatRequest {
  const scenarioBlock = scenarios
    .map((s) => `- ${s.key}: ${s.name} (${s.description ?? ''})`)
    .join('\n');

  const skillBlock = skills
    .map((s) => {
      const excerpt = (s.bodyExcerpt ?? '').slice(0, 500);
      return `- skillId=${s.id}, name="${s.name}", description="${s.description ?? ''}"\nbody excerpt:\n${excerpt}\n---`;
    })
    .join('\n');

  return {
    messages: [
      {
        role: 'system',
        content:
          'You are a skill classifier. For each skill, suggest 0-3 scenarios from the provided list that best match. ' +
          'Echo each skill\'s `skillId` EXACTLY as given — they are opaque UUIDs, not the skill name. ' +
          'Use scenario keys (the part before the colon) from the provided list verbatim. ' +
          'Return strict JSON: { results: [{ skillId: string, scenarios: [scenarioKey, ...], reason: string }] }',
      },
      {
        role: 'user',
        content: `Scenarios (use the key, before the colon):\n${scenarioBlock}\n\nSkills:\n${skillBlock}`,
      },
    ],
    temperature: 0.2,
    // Reasoning models (DeepSeek v4, OpenAI o*) burn a large slice of the
    // budget on hidden reasoning before emitting visible content. 1024 was
    // empirically too small with deepseek-v4-pro for a 5-skill batch — the
    // model returned an empty completion. 4096 leaves room.
    maxTokens: 4096,
    jsonMode: true,
  };
}

function parseLlmResponse(text: string): LlmResponse {
  if (!text || typeof text !== 'string') return { results: [] };
  // Some providers wrap JSON in ```json fences even when jsonMode is on.
  const stripped = stripJsonFences(text.trim());
  let raw: unknown;
  try {
    raw = JSON.parse(stripped);
  } catch {
    // Try to extract the first {...} block as a last resort.
    const m = stripped.match(/\{[\s\S]*\}/);
    if (!m) return { results: [] };
    try {
      raw = JSON.parse(m[0]);
    } catch {
      return { results: [] };
    }
  }
  if (!raw || typeof raw !== 'object') return { results: [] };
  const resultsRaw = (raw as { results?: unknown }).results;
  if (!Array.isArray(resultsRaw)) return { results: [] };
  const results: LlmResult[] = [];
  for (const r of resultsRaw) {
    if (!r || typeof r !== 'object') continue;
    const skillId = (r as { skillId?: unknown }).skillId;
    const scenarios = (r as { scenarios?: unknown }).scenarios;
    const reason = (r as { reason?: unknown }).reason;
    if (typeof skillId !== 'string') continue;
    if (!Array.isArray(scenarios)) continue;
    const keys = scenarios.filter((k): k is string => typeof k === 'string').slice(0, 3);
    results.push({
      skillId,
      scenarios: keys,
      reason: typeof reason === 'string' ? reason : null,
    });
  }
  return { results };
}

function stripJsonFences(s: string): string {
  if (s.startsWith('```')) {
    const m = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
    if (m) return m[1] ?? '';
  }
  return s;
}

// ---------------------------------------------------------------------------
// DB helpers.

function readScenarios(): ScenarioForPrompt[] {
  return getDb()
    .prepare('SELECT key, name, description FROM scenarios ORDER BY sort_order, name')
    .all() as ScenarioForPrompt[];
}

function loadSkillsForPrompt(ids: string[]): SkillForPrompt[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return getDb()
    .prepare(
      `SELECT id, name, description, body_excerpt AS bodyExcerpt
       FROM skills WHERE id IN (${placeholders})`,
    )
    .all(...ids) as SkillForPrompt[];
}

function readLlmConfig(): LlmConfig {
  const provider = (readSetting('llm.provider') ?? 'deepseek') as LlmProvider;
  const model = readSetting('llm.model') ?? '';
  const baseUrl = readSetting('llm.baseUrl') ?? '';
  return {
    // VALID_LLM_PROVIDERS is the canonical list (shared/types.ts). Before
    // centralizing this it was a private Set here that omitted 'deepseek',
    // silently downgrading user selections to OpenAI.
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

function isAutoCategorizeEnabled(): boolean {
  return readSetting('llm.feature.autoCategorize') === '1';
}

function readIntervalMs(): number {
  const raw = readSetting('ai.categorize.minIntervalMs');
  const n = raw != null ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < MIN_INTERVAL_MS) return DEFAULT_INTERVAL_MS;
  return n;
}
