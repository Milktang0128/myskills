/**
 * skills.sh catalog client.
 *
 * Two responsibilities:
 *   1. Live search via https://skills.sh/api/search?q=... — no DB caching;
 *      every keystroke that the renderer fires hits the network.
 *   2. Fetching the raw SKILL.md of a search result from its GitHub source,
 *      since the search endpoint typically doesn't include full content.
 *
 * Errors are normalized to throw `{ code, message }` shaped errors so the
 * IPC dispatcher can ship them to the renderer untransformed.
 */
import type {
  CatalogSearchResponse,
  CatalogSearchResult,
} from '../../shared/types';

const USER_AGENT = 'MySkills/0.1 (+https://github.com/Milktang0128/myskills)';
const SEARCH_BASE = 'https://skills.sh/api/search';
const GH_REPO_API = 'https://api.github.com/repos';
const GH_RAW = 'https://raw.githubusercontent.com';

/** Module-level cache of "owner/repo" → default branch. Resets on app restart. */
const defaultBranchCache = new Map<string, string>();

class CatalogError extends Error {
  code: string;
  detail?: unknown;
  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Hit skills.sh's search endpoint. No retries, no DB caching — every call is
 * a fresh HTTP request.
 */
export async function searchCatalog(
  query: string,
  limit = 30,
  offset = 0,
): Promise<CatalogSearchResponse> {
  const q = (query ?? '').trim();
  if (!q) {
    return { query: '', searchType: 'fuzzy', skills: [], count: 0, duration_ms: 0 };
  }
  const url = new URL(SEARCH_BASE);
  url.searchParams.set('q', q);
  url.searchParams.set('limit', String(clamp(limit, 1, 100)));
  url.searchParams.set('offset', String(Math.max(0, offset | 0)));

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CatalogError(
      'CATALOG_UNAVAILABLE',
      `Could not reach skills.sh — check your network connection. (${msg})`,
    );
  }

  if (res.status === 429) {
    throw new CatalogError(
      'CATALOG_RATE_LIMITED',
      'skills.sh rate-limited this request. Wait a moment and try again.',
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new CatalogError(
      'CATALOG_UNAUTHORIZED',
      'Public search is no longer available on skills.sh. ' +
        'TODO: add a Settings field for an API key.',
    );
  }
  if (!res.ok) {
    throw new CatalogError(
      'CATALOG_UNAVAILABLE',
      `skills.sh returned HTTP ${res.status} ${res.statusText}`,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CatalogError('CATALOG_BAD_RESPONSE', `skills.sh returned malformed JSON: ${msg}`);
  }

  return normalizeSearchResponse(body, q);
}

/**
 * Fetch the raw SKILL.md for a (source, skillId). Tries a list of paths
 * because skills.sh repos don't all follow the same layout. Resolves the
 * default branch via the GitHub repos API and caches it per-source.
 *
 * Throws `{ code: 'CONTENT_NOT_FOUND' }` if every candidate path 404s.
 */
export async function fetchSkillContent(source: string, skillId: string): Promise<string> {
  if (!isValidSource(source)) {
    throw new CatalogError('INVALID_INPUT', `bad source "${source}" — expected owner/repo`);
  }
  if (!isValidSkillId(skillId)) {
    throw new CatalogError('INVALID_INPUT', `bad skillId "${skillId}"`);
  }

  const branch = await getDefaultBranch(source);
  const candidates = [
    `skills/${skillId}/SKILL.md`,
    `skills/.curated/${skillId}/SKILL.md`,
    `skills/.experimental/${skillId}/SKILL.md`,
    `${skillId}/SKILL.md`,
    'SKILL.md',
  ];

  let lastErr: string | null = null;
  for (const subPath of candidates) {
    const url = `${GH_RAW}/${source}/${encodeURIComponent(branch)}/${subPath.split('/').map(encodeURIComponent).join('/')}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain' } });
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      continue;
    }
    if (res.status === 404) continue;
    if (res.status === 429) {
      throw new CatalogError(
        'CATALOG_RATE_LIMITED',
        'GitHub rate-limited the SKILL.md fetch. Wait a moment and try again.',
      );
    }
    if (!res.ok) {
      lastErr = `HTTP ${res.status} ${res.statusText}`;
      continue;
    }
    const text = await res.text();
    if (text && text.length > 0) return text;
  }

  throw new CatalogError(
    'CONTENT_NOT_FOUND',
    `Could not find SKILL.md for ${source}/${skillId} on any known path${
      lastErr ? ` (last error: ${lastErr})` : ''
    }.`,
  );
}

/* ============================================================================
 * Internals
 * ========================================================================== */

async function getDefaultBranch(source: string): Promise<string> {
  const cached = defaultBranchCache.get(source);
  if (cached) return cached;

  const url = `${GH_REPO_API}/${source}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
    });
  } catch (err) {
    // Network problems — fall back to "main" rather than failing the whole
    // install. The caller will throw CONTENT_NOT_FOUND if every path 404s.
    const msg = err instanceof Error ? err.message : String(err);
    void msg;
    defaultBranchCache.set(source, 'main');
    return 'main';
  }

  if (res.status === 404) {
    throw new CatalogError(
      'CATALOG_REPO_NOT_FOUND',
      `GitHub repository "${source}" does not exist.`,
    );
  }
  if (res.status === 429 || res.status === 403) {
    // GitHub unauth rate limit is 60/hour. Fall back to "main".
    defaultBranchCache.set(source, 'main');
    return 'main';
  }
  if (!res.ok) {
    defaultBranchCache.set(source, 'main');
    return 'main';
  }

  let body: { default_branch?: unknown } | undefined;
  try {
    body = (await res.json()) as { default_branch?: unknown };
  } catch {
    defaultBranchCache.set(source, 'main');
    return 'main';
  }
  const branch =
    typeof body?.default_branch === 'string' && body.default_branch.length > 0
      ? body.default_branch
      : 'main';
  defaultBranchCache.set(source, branch);
  return branch;
}

function normalizeSearchResponse(body: unknown, q: string): CatalogSearchResponse {
  if (!body || typeof body !== 'object') {
    return { query: q, searchType: 'fuzzy', skills: [], count: 0, duration_ms: 0 };
  }
  const obj = body as Record<string, unknown>;
  const rawSkills = Array.isArray(obj.skills) ? (obj.skills as unknown[]) : [];
  const skills: CatalogSearchResult[] = [];
  for (const raw of rawSkills) {
    const norm = normalizeSearchResult(raw);
    if (norm) skills.push(norm);
  }
  return {
    query: typeof obj.query === 'string' ? obj.query : q,
    searchType: typeof obj.searchType === 'string' ? obj.searchType : 'fuzzy',
    skills,
    count: typeof obj.count === 'number' ? obj.count : skills.length,
    duration_ms: typeof obj.duration_ms === 'number' ? obj.duration_ms : 0,
  };
}

function normalizeSearchResult(raw: unknown): CatalogSearchResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : null;
  const name = typeof r.name === 'string' ? r.name : null;
  const source = typeof r.source === 'string' ? r.source : null;
  if (!name || !source) return null;
  // Derive skillId. skills.sh may not include it as a discrete field — fall
  // back to the last path segment of the id or the name slug.
  let skillId: string | null = null;
  if (typeof r.skillId === 'string') skillId = r.skillId;
  else if (typeof r.skill_id === 'string') skillId = r.skill_id;
  else if (typeof r.slug === 'string') skillId = r.slug;
  else if (id) skillId = lastPathSegment(id);
  if (!skillId) skillId = lastPathSegment(name);
  if (!skillId) return null;
  return {
    id: id ?? `${source}/${skillId}`,
    skillId,
    name,
    installs:
      typeof r.installs === 'number'
        ? r.installs
        : typeof r.install_count === 'number'
        ? r.install_count
        : 0,
    source,
    description: typeof r.description === 'string' ? r.description : undefined,
  };
}

function lastPathSegment(s: string): string {
  const t = s.replace(/\/+$/, '');
  const i = t.lastIndexOf('/');
  return i >= 0 ? t.slice(i + 1) : t;
}

function isValidSource(s: string): boolean {
  // GitHub owner/repo — owner is 1..39 chars of alnum/dash, no leading dash;
  // repo is 1..100 chars of alnum/_-.
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(s);
}

function isValidSkillId(s: string): boolean {
  // Conservative: alnum, dash, underscore, dot — no path separators.
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(s);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n | 0));
}
