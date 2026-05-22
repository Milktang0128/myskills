/**
 * Library Overview ("Skill Map") generator.
 *
 * One AI call that reads every skill in the library and produces a clustered
 * snapshot: per-skill one-line brief + theme clusters + library intro. The
 * result is a *read-only navigation aid* — it doesn't write to scenarios,
 * doesn't modify SKILL.md, doesn't shadow the original description. Just
 * gives the user a 1-minute map of their toolbox.
 *
 * Why single-call (no batching):
 *   The point of a cluster view is that the AI sees the whole library at
 *   once and finds groupings. Batching breaks that — clusters would drift
 *   from batch to batch. So we cap at MAX_TOTAL_SKILLS and reject above
 *   that with a clear error (rare for an MVP user).
 *
 * Why single-row table:
 *   The user only ever views one overview at a time. A history of past
 *   overviews would be noise, not value. Regenerate replaces the row.
 */
import { createHash } from 'node:crypto';
import { getDb } from '../db';
import { createProvider } from '../llm/provider';
import { readSecret, hasSecret } from '../secrets/safe-storage';
import { isExternalNetworkAllowed } from '../secrets/network-gate';
import { slugify } from '../../shared/slug';
import {
  VALID_LLM_PROVIDERS,
  type LibraryOverview,
  type LibraryOverviewCluster,
  type LibraryOverviewSkillEntry,
  type LibraryOverviewSnapshot,
  type LlmConfig,
  type LlmProvider,
} from '../../shared/types';

const API_KEY_NAME = 'llm.apiKey';

/**
 * Per-skill prompt budget. Smaller than bulk-categorize because we need to
 * fit ALL skills in one prompt — no batching here.
 *   60 skills × (50 name + 250 desc + 300 body) ≈ 36K chars ≈ 12K tokens
 *   + system + intro context ≈ 14K input
 *   + output ≈ 4K
 *   → well inside DeepSeek's 128K window.
 */
const MAX_NAME_CHARS = 60;
const MAX_DESCRIPTION_CHARS = 250;
const MAX_BODY_CHARS = 300;
/**
 * Hard cap. Above this we'd risk context overflow on the input AND blow up
 * the output (per-skill brief × N). User can reach out if they hit this —
 * for now we just truncate.
 */
const MAX_TOTAL_SKILLS = 100;

interface SkillRow {
  id: string;
  name: string;
  description: string | null;
  body_excerpt: string | null;
  content_hash: string;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Read the cached overview (if any) and compute the current set-hash so the
 * UI can decide whether to show a "regenerate" prompt. Cheap — no LLM call.
 */
export function getCachedOverview(language: string): LibraryOverviewSnapshot {
  const currentSetHash = computeCurrentSetHash();
  const row = getDb()
    .prepare(
      'SELECT set_hash, overview_json, generated_at, model, language FROM library_overview WHERE id = 1',
    )
    .get() as
    | {
        set_hash: string;
        overview_json: string;
        generated_at: number;
        model: string | null;
        language: string | null;
      }
    | undefined;

  if (!row) {
    return { overview: null, stale: false, currentSetHash };
  }

  let overview: LibraryOverview | null = null;
  try {
    overview = JSON.parse(row.overview_json) as LibraryOverview;
  } catch {
    // Corrupted cache row — treat as missing rather than blowing up the UI.
    return { overview: null, stale: false, currentSetHash };
  }

  // Stale if either the skill set changed OR the user's UI language flipped
  // since last generation (intro/clusters would be in the wrong language).
  const stale =
    row.set_hash !== currentSetHash ||
    (row.language != null && row.language !== language);

  return { overview, stale, currentSetHash };
}

/**
 * Run the LLM, write the cache, return the fresh overview. Throws on
 * misconfigured network / LLM / model so the UI surfaces a clear error
 * instead of an empty map.
 */
export async function generateOverview(language: string): Promise<LibraryOverview> {
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

  const skills = readAllSkills();
  if (skills.length === 0) {
    throw makeErr('LIBRARY_EMPTY', 'No skills in the library to summarize.');
  }
  // Cap at MAX_TOTAL_SKILLS deterministically (sorted by name) so repeated
  // runs at the cap hit the same subset.
  const truncated = skills.slice(0, MAX_TOTAL_SKILLS);

  const apiKey = readSecret(API_KEY_NAME);
  const client = createProvider(config, apiKey);

  const prompt = buildPrompt(truncated, language);
  const inputChars = prompt.system.length + prompt.user.length;
  console.log(
    `[ai/overview] skills=${truncated.length} inputChars=${inputChars} (~${Math.round(inputChars / 3)} tokens) lang=${language}`,
  );
  const res = await client.chat({
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    temperature: 0.3,
    jsonMode: true,
    // Output is bounded: intro + N cluster descriptions + N briefs. For 100
    // skills that's ~3K tokens; reasoning models hide another ~10K. 8K
    // visible cap keeps headroom.
    maxTokens: 8192,
  });

  const overview = postProcess(parseResponse(res.text), truncated, language, config.model);

  // Persist single row. INSERT OR REPLACE keeps id=1 invariant.
  const setHash = computeSetHashFromRows(truncated);
  getDb()
    .prepare(
      `INSERT INTO library_overview (id, set_hash, overview_json, generated_at, model, language)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         set_hash = excluded.set_hash,
         overview_json = excluded.overview_json,
         generated_at = excluded.generated_at,
         model = excluded.model,
         language = excluded.language`,
    )
    .run(setHash, JSON.stringify(overview), overview.generatedAt, overview.model, overview.language);

  return overview;
}

// ---------------------------------------------------------------------------
// Set-hash — fingerprint the skill set so the UI can detect staleness
// ---------------------------------------------------------------------------

function computeCurrentSetHash(): string {
  const rows = getDb()
    .prepare('SELECT id, content_hash FROM skills ORDER BY id')
    .all() as Array<{ id: string; content_hash: string }>;
  return hashRows(rows);
}

function computeSetHashFromRows(rows: Pick<SkillRow, 'id' | 'content_hash'>[]): string {
  // Sort by id for determinism (caller passes whatever order they have).
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return hashRows(sorted);
}

function hashRows(rows: Array<{ id: string; content_hash: string }>): string {
  const h = createHash('sha256');
  for (const r of rows) {
    h.update(r.id);
    h.update('|');
    h.update(r.content_hash);
    h.update('\n');
  }
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildPrompt(skills: SkillRow[], language: string): { system: string; user: string } {
  const langDirective =
    language === 'zh'
      ? '所有面向用户的文本（intro、cluster.name、cluster.purpose、skill.brief）必须使用中文。'
      : 'All user-facing text (intro, cluster.name, cluster.purpose, skill.brief) must be in English.';

  const system =
    'You are a librarian creating a navigable "library map" for a user\'s AI agent skills.\n' +
    '\n' +
    'You are given the entire skill library. Your job:\n' +
    '  1. Group the skills into 3-8 thematic clusters. Each cluster should hold at least 2 skills, except a final "uncategorized" group for true outliers.\n' +
    '  2. Write a short purpose statement (1-2 sentences) for each cluster.\n' +
    '  3. Write a ≤15-character one-line brief for EACH skill — a personal-positioning label, not a feature list. Think Twitter bio for the skill: "what is this for, in one glance".\n' +
    '  4. Write a 1-2 sentence overall "intro" describing the library\'s character and emphasis.\n' +
    '\n' +
    langDirective +
    '\n\n' +
    'Output JSON of this exact shape:\n' +
    '{\n' +
    '  "intro": string,                 // 1-2 sentences\n' +
    '  "clusters": [\n' +
    '    { "name": string,              // 2-6 words, descriptive\n' +
    '      "purpose": string,           // 1-2 sentences in the user\'s language\n' +
    '      "skills": [\n' +
    '        { "skillId": string,       // echo input id verbatim\n' +
    '          "brief": string }        // ≤15 chars (or chars-equivalent in CJK); ONE crisp line\n' +
    '      ]\n' +
    '    }\n' +
    '  ]\n' +
    '}\n' +
    '\n' +
    'Rules:\n' +
    '  - Every input skill MUST appear in exactly one cluster (caller will dump any missing into an "其他/Other" cluster, which is a sign you missed coverage — avoid this).\n' +
    '  - Cluster on USE-CASE / DOMAIN, not on technology. e.g. group "PDF parser" with "DocX extractor" under "Document parsing", not separate it because one is PDF and one is DocX.\n' +
    '  - Per-skill briefs are POSITIONS, not summaries. Bad: "Parses PDF forms and fills in fields"; good: "PDF 表单填写" or "Form-fill PDFs".\n' +
    '  - When two skills look like duplicates, give them DIFFERENT briefs so the user can spot the overlap.\n' +
    '  - Never invent skillIds; only use ones from the input.\n' +
    '  - Output nothing outside the JSON.\n';

  const skillsBlock = skills
    .map((s) => {
      const name = (s.name ?? '').slice(0, MAX_NAME_CHARS);
      const desc = (s.description ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION_CHARS);
      const body = (s.body_excerpt ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_BODY_CHARS);
      return `- skillId=${s.id}\n  name=${name}\n  description=${desc}\n  body=${body}`;
    })
    .join('\n');

  const user = `Total skills: ${skills.length}\n\nskills:\n${skillsBlock}`;
  return { system, user };
}

// ---------------------------------------------------------------------------
// Response parsing + post-processing
// ---------------------------------------------------------------------------

interface RawCluster {
  name: string;
  purpose: string;
  skills: Array<{ skillId: string; brief: string }>;
}

interface RawResponse {
  intro: string;
  clusters: RawCluster[];
}

function parseResponse(text: string): RawResponse {
  const empty: RawResponse = { intro: '', clusters: [] };
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

  const intro = typeof obj.intro === 'string' ? obj.intro : '';
  const clusters: RawCluster[] = [];
  if (Array.isArray(obj.clusters)) {
    for (const c of obj.clusters) {
      if (!c || typeof c !== 'object') continue;
      const cc = c as Record<string, unknown>;
      const name = typeof cc.name === 'string' ? cc.name : '';
      const purpose = typeof cc.purpose === 'string' ? cc.purpose : '';
      const skills: RawCluster['skills'] = [];
      if (Array.isArray(cc.skills)) {
        for (const s of cc.skills) {
          if (!s || typeof s !== 'object') continue;
          const ss = s as Record<string, unknown>;
          const skillId = typeof ss.skillId === 'string' ? ss.skillId : '';
          const brief = typeof ss.brief === 'string' ? ss.brief : '';
          if (!skillId) continue;
          skills.push({ skillId, brief });
        }
      }
      if (!name) continue;
      clusters.push({ name, purpose, skills });
    }
  }
  return { intro, clusters };
}

function postProcess(
  raw: RawResponse,
  inputSkills: SkillRow[],
  language: string,
  model: string,
): LibraryOverview {
  const inputById = new Map(inputSkills.map((s) => [s.id, s]));
  const seenSkillIds = new Set<string>();

  // Build clusters, dropping hallucinated skill ids + dedup within a cluster.
  const clusters: LibraryOverviewCluster[] = [];
  const usedClusterKeys = new Set<string>();
  for (const rc of raw.clusters) {
    const skills: LibraryOverviewSkillEntry[] = [];
    for (const s of rc.skills) {
      const input = inputById.get(s.skillId);
      if (!input) continue; // hallucination
      if (seenSkillIds.has(s.skillId)) continue; // dup across clusters → first wins
      seenSkillIds.add(s.skillId);
      skills.push({
        skillId: s.skillId,
        name: input.name,
        brief: trimBrief(s.brief, input.name),
      });
    }
    if (skills.length === 0) continue;

    // Unique cluster key for React rendering. Slug the AI-given name; if two
    // clusters slug to the same key, suffix.
    let key = slugify(rc.name) || 'cluster';
    let n = 2;
    while (usedClusterKeys.has(key)) {
      key = `${slugify(rc.name) || 'cluster'}-${n++}`;
    }
    usedClusterKeys.add(key);

    clusters.push({
      key,
      name: rc.name.trim(),
      purpose: rc.purpose.trim(),
      skills,
    });
  }

  // Catch-all: anything the AI missed becomes an "uncategorized" group. Not
  // a regular cluster — the UI renders it differently (a "review these"
  // section) and an empty array means clean coverage.
  const uncategorized: LibraryOverviewSkillEntry[] = [];
  for (const s of inputSkills) {
    if (seenSkillIds.has(s.id)) continue;
    uncategorized.push({
      skillId: s.id,
      name: s.name,
      brief: '',
    });
  }

  return {
    intro: raw.intro.trim(),
    clusters,
    uncategorized,
    totalSkills: inputSkills.length,
    generatedAt: Date.now(),
    model,
    language,
  };
}

/**
 * Trim a brief to a sensible length. We can't strictly enforce 15 chars in
 * Chinese (each char is "wide"), so we use a soft cap and fall back to the
 * skill name if the AI returned nothing usable.
 */
function trimBrief(brief: string, fallback: string): string {
  const cleaned = brief.replace(/\s+/g, ' ').trim();
  if (!cleaned) return fallback;
  // 30 chars is roughly "15 CJK chars or 30 ASCII chars" — overshooting a
  // little is fine because the UI will truncate visually anyway.
  if (cleaned.length <= 30) return cleaned;
  return cleaned.slice(0, 28).trimEnd() + '…';
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function readAllSkills(): SkillRow[] {
  return getDb()
    .prepare(
      `SELECT id, name, description, body_excerpt, content_hash
       FROM skills
       ORDER BY name COLLATE NOCASE`,
    )
    .all() as SkillRow[];
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
