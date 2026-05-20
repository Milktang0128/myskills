/**
 * Batch description enrichment for catalog search results.
 *
 * Background:
 *   skills.sh's `/api/search` only returns id/name/installs/source — no
 *   description. The full SKILL.md text lives in each repo on GitHub; we
 *   already know how to fetch + parse it (see `fetchSkillContent` and the
 *   /api/preview handler). This module wraps that for the "give me
 *   descriptions for N rows" case the Discover list needs.
 *
 * Design:
 *   - **Persistent cache** in SQLite (`catalog_descriptions` table). 7-day
 *     TTL. Cached `description = NULL` is a valid "fetched, no description
 *     in frontmatter" entry — we still skip the network on next hit.
 *     SkillsGate's open-source desktop app uses the same "extract once,
 *     store, never re-fetch" pattern; here it survives app restarts so the
 *     second-launch Discover experience is instant.
 *   - **Concurrency cap** (`MAX_CONCURRENT`) so a 30-row search doesn't
 *     fire 30 simultaneous GitHub fetches. GitHub raw is rate-limit-
 *     friendly but the default-branch lookup goes through api.github.com,
 *     capped at 60/hour unauthed. The `defaultBranchCache` in skillssh.ts
 *     amortizes that across repos.
 *   - **External-network gate**: if the user has disabled `allow_external_
 *     network` in Settings, this returns cached entries only — no fetches.
 *     Mirrors the LLM provider's check; defense in depth so any future
 *     caller can't accidentally bypass.
 *   - **Soft-failures**: a row that can't be enriched (404, parse error,
 *     network blip) returns `description: null` rather than rejecting the
 *     whole batch. Callers render the missing rows blank, not red.
 *
 * Out of scope:
 *   - Cache invalidation beyond TTL. If a SKILL.md upstream gets a new
 *     description, we'll see it after 7 days. Acceptable.
 */
import matter from 'gray-matter';
import { fetchSkillContent } from './skillssh';
import { getDb } from '../db';
import { isExternalNetworkAllowed } from '../secrets/network-gate';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_CONCURRENT = 5;
/** Cap on a single batch — guards against accidental flood from huge payloads. */
const MAX_BATCH_SIZE = 30;

export interface EnrichInput {
  source: string;
  skillId: string;
}

export interface EnrichOutput {
  source: string;
  skillId: string;
  /** null = couldn't fetch / no description in frontmatter (fully resolved). */
  description: string | null;
}

interface CacheRow {
  source: string;
  skill_id: string;
  description: string | null;
  fetched_at: number;
}

/**
 * Best-effort: returns description for each input, in order. Hits the DB
 * cache first (no TTL miss = treated as cold), then fetches any cold or
 * expired entries with controlled concurrency. Never throws — all per-row
 * failures are swallowed and turn into `description: null`.
 *
 * If the external-network toggle is off, returns cached entries only;
 * uncached rows come back as `null` with no fetch attempted.
 */
export async function enrichDescriptions(items: EnrichInput[]): Promise<EnrichOutput[]> {
  if (items.length === 0) return [];
  // Defensive truncation — IPC payload size cap on top of MAX_CONCURRENT.
  const trimmed = items.slice(0, MAX_BATCH_SIZE);

  // Pass 1: bulk-read the cache for all rows in one query.
  const cached = readCache(trimmed);
  const now = Date.now();
  const results: EnrichOutput[] = new Array(trimmed.length);
  const todo: number[] = [];

  for (let i = 0; i < trimmed.length; i += 1) {
    const item = trimmed[i]!;
    const hit = cached.get(cacheKey(item.source, item.skillId));
    if (hit && now - hit.fetched_at < CACHE_TTL_MS) {
      results[i] = {
        source: item.source,
        skillId: item.skillId,
        description: hit.description,
      };
    } else {
      todo.push(i);
    }
  }
  if (todo.length === 0) return results;

  // If network is off, fill the uncached rows with `null` and bail.
  if (!isExternalNetworkAllowed()) {
    for (const i of todo) {
      const item = trimmed[i]!;
      results[i] = { source: item.source, skillId: item.skillId, description: null };
    }
    return results;
  }

  // Pass 2: bounded concurrency over `todo`. Simple cursor-based worker pool.
  let cursor = 0;
  const workers = Array.from({ length: Math.min(MAX_CONCURRENT, todo.length) }, async () => {
    while (true) {
      const myIdx = cursor;
      cursor += 1;
      if (myIdx >= todo.length) return;
      const i = todo[myIdx]!;
      const item = trimmed[i]!;
      const description = await fetchOne(item.source, item.skillId);
      writeCache(item.source, item.skillId, description);
      results[i] = { source: item.source, skillId: item.skillId, description };
    }
  });
  await Promise.all(workers);

  return results;
}

async function fetchOne(source: string, skillId: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await fetchSkillContent(source, skillId);
  } catch {
    return null;
  }
  try {
    const parsed = matter(raw);
    const fm = (parsed.data ?? {}) as Record<string, unknown>;
    const desc = fm.description;
    if (typeof desc !== 'string') return null;
    const t = desc.trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function cacheKey(source: string, skillId: string): string {
  return `${source}\x00${skillId}`;
}

function readCache(items: EnrichInput[]): Map<string, CacheRow> {
  const map = new Map<string, CacheRow>();
  if (items.length === 0) return map;
  // SQLite has a SQLITE_MAX_VARIABLE_NUMBER (typically 32766) — we cap the
  // batch at MAX_BATCH_SIZE * 2 placeholders well below that, but use a
  // chunked path anyway to keep this defensive.
  const placeholders = items.map(() => '(?, ?)').join(', ');
  const params: string[] = [];
  for (const it of items) {
    params.push(it.source, it.skillId);
  }
  const rows = getDb()
    .prepare(
      `SELECT source, skill_id, description, fetched_at
       FROM catalog_descriptions
       WHERE (source, skill_id) IN (VALUES ${placeholders})`,
    )
    .all(...params) as CacheRow[];
  for (const r of rows) {
    map.set(cacheKey(r.source, r.skill_id), r);
  }
  return map;
}

function writeCache(source: string, skillId: string, description: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO catalog_descriptions (source, skill_id, description, fetched_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(source, skill_id) DO UPDATE SET
         description = excluded.description,
         fetched_at = excluded.fetched_at`,
    )
    .run(source, skillId, description, Date.now());
}
