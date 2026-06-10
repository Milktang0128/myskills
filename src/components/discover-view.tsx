'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Globe, Loader2, Sparkles } from 'lucide-react';
import type {
  CatalogPreview,
  CatalogSearchResult,
  Platform,
  PlatformId,
  SyncExecuteResult,
  SyncPlan,
} from '@shared/types';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { SyncConfirm } from '@/components/sync-confirm';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface Props {
  /** Live query from the workspace top-bar search input. */
  query: string;
  /** Mode is owned by the workspace so the toggle can live next to the
   *  search input in the page header. DiscoverView consumes + reports
   *  changes via onModeChange. */
  mode: SearchMode;
  onModeChange: (mode: SearchMode) => void;
  /** Whether AI mode is enabled (LLM key + feature toggle). Owned by the
   *  workspace so the header toggle can render correctly too. */
  aiAvailable: boolean;
  onToast: (msg: string) => void;
  /** Deep-link to Settings (network toggle lives there) for the
   *  network-disabled empty state. */
  onOpenSettings?: () => void;
}

const DEBOUNCE_MS = 300;
const MIN_QUERY_LEN = 2;

/** Search mode the user has picked in the top-bar segmented control. */
export type SearchMode = 'keyword' | 'ai';

/** AI rerank candidate pool — broader than the default keyword view (30). */
const AI_CANDIDATE_LIMIT = 50;
/** Max items we ask the LLM to return. The prompt mirrors this. */
const AI_RESULT_LIMIT = 10;
/**
 * Seed query used when the user opens Discover with no input yet. skills.sh
 * doesn't expose a "popular" or "browse all" endpoint without an API key,
 * but their fuzzy search for "skill" happens to return the most-installed
 * skills first (find-skills 1.6M, vercel-react-best-practices 411k, …) —
 * close enough to a popular landing for v0.3.
 */
const POPULAR_SEED_QUERY = 'skill';
/** Cap on how many rows we eagerly enrich with descriptions per response. */
const ENRICH_LIMIT = 10;
/**
 * Cap for the pre-rerank description enrichment in AI mode. Bigger than
 * ENRICH_LIMIT because rerank reads more rows than the user displays — we
 * want the LLM to have descriptions on ~3x the eventual visible rows so it
 * can compare and pick best, not just shuffle the visible 10.
 */
const AI_RERANK_ENRICH_LIMIT = 30;
/** Cap on rows sent to Phase 3 rerank. Keeps the prompt size predictable. */
const AI_RERANK_CANDIDATE_LIMIT = 100;
/** Pipeline result cache TTL (ms). Same query in this window skips all LLM calls. */
const PIPELINE_CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Cached AI pipeline output, keyed by normalized query. Module-level so it
 * survives DiscoverView unmount/remount (user clicking between Coverage and
 * Discover). Tab-scoped — the cache resets on page reload, which is fine
 * for an internal acceleration; description data already lives in the DB.
 */
interface CachedPipeline {
  skills: CatalogSearchResult[];
  why: Record<string, string>;
  ranked: boolean;
  intent: string | null;
  expiresAt: number;
}
const pipelineCache = new Map<string, CachedPipeline>();

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

function readPipelineCache(q: string): CachedPipeline | null {
  const key = normalizeQuery(q);
  const entry = pipelineCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    pipelineCache.delete(key);
    return null;
  }
  return entry;
}

function writePipelineCache(q: string, value: Omit<CachedPipeline, 'expiresAt'>): void {
  const key = normalizeQuery(q);
  pipelineCache.set(key, { ...value, expiresAt: Date.now() + PIPELINE_CACHE_TTL_MS });
}

/**
 * Heuristic: skip Phase 1 (intent decompose) when the user's query is
 * already a short English term. Three tests must all pass to skip:
 *   - no CJK / Korean characters present (those need translation)
 *   - ≤3 whitespace-separated tokens (long sentences benefit from
 *     keyword extraction)
 *   - each token is plain ASCII letters/digits/hyphens
 *
 * When true, the pipeline uses the raw query as a single keyword and
 * jumps straight to Phase 2, saving one LLM round-trip (~3-5s with
 * reasoning models) for the very common "git commit" / "vercel deploy"
 * style query.
 */
function shouldSkipDecompose(query: string): boolean {
  if (/[一-鿿㐀-䶿぀-ゟ゠-ヿ가-힯]/.test(query)) {
    return false;
  }
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 3) return false;
  return tokens.every((t) => /^[A-Za-z0-9._-]+$/.test(t));
}

/**
 * Lowercase + strip non-alphanumerics so we can match catalog skillIds
 * against locally-installed skill names that may differ in case or
 * separators (e.g. "PDF-Form" vs "pdf_form"). Mirrors the same
 * normalization used by the bulk-categorize matcher.
 */
function normalizeSkillKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function DiscoverView({ query, mode, onModeChange, aiAvailable, onToast, onOpenSettings }: Props) {
  const t = useT();
  const [bridgeReady, setBridgeReady] = useState(false);
  const [results, setResults] = useState<CatalogSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  /**
   * Which phase of an in-flight search is currently running. Drives the
   * status-line copy so users can tell whether the LLM is still thinking
   * vs the keyword catalog is still responding. AI mode advances through:
   *   keyword           (initial direct catalog hit, if any)
   *   ai-understanding  (Phase 1: decompose user intent into keywords)
   *   ai-multisearch    (Phase 2: parallel skills.sh fetches per keyword)
   *   ai-enriching      (Phase 2.5: fetch descriptions so Phase 3 has context)
   *   ai-sorting        (Phase 3 in progress, union already on screen — used
   *                      when `results` is non-empty during ai-ranking)
   *   ai-ranking        (Phase 3 starting before any results visible)
   */
  type LoadingPhase =
    | 'keyword'
    | 'ai-understanding'
    | 'ai-multisearch'
    | 'ai-enriching'
    | 'ai-sorting'
    | 'ai-ranking';
  const [loadingPhase, setLoadingPhase] = useState<LoadingPhase | null>(null);
  /**
   * Counters for the multi-search phase, so the status line can read
   * "Searching {{count}} angles…" instead of a generic spinner.
   */
  const [aiKeywordCount, setAiKeywordCount] = useState(0);
  const [aiCandidateCount, setAiCandidateCount] = useState(0);
  /** One-sentence LLM summary of how the user's query was understood. */
  const [aiIntent, setAiIntent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Map of skillId → one-sentence LLM rationale. Populated only in AI mode. */
  const [aiWhy, setAiWhy] = useState<Record<string, string>>({});
  /** True when the currently-rendered results were produced by an AI rerank. */
  const [aiRanked, setAiRanked] = useState(false);
  /**
   * True when the currently-rendered results are the "popular" seed (the
   * empty-query default), not a user search. Drives the status-line copy
   * and lets us suppress the "no matches" empty state.
   */
  const [isPopular, setIsPopular] = useState(false);

  const [selectedResult, setSelectedResult] = useState<CatalogSearchResult | null>(null);
  const [preview, setPreview] = useState<CatalogPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [canonicalPlatform, setCanonicalPlatform] = useState<PlatformId>('shared');
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<string>>(new Set());

  const [pendingPlan, setPendingPlan] = useState<SyncPlan | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Master kill-switch from settings — when off, skip every network call.
  const [networkAllowed, setNetworkAllowed] = useState<boolean | null>(null);

  // Set of normalized skill names installed locally — used to flag
  // already-installed catalog results so users don't accidentally
  // re-install the same skill.
  const [installedNames, setInstalledNames] = useState<Set<string>>(new Set());

  // Used to ignore stale search responses (the user typed faster than the API).
  const searchSeqRef = useRef(0);
  // Separate sequence for enrichment so a slow GitHub batch from a previous
  // query doesn't overwrite descriptions on a newer result set.
  const enrichSeqRef = useRef(0);

  // Bridge readiness — same pattern as coverage-view.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.myskills) {
      setBridgeReady(true);
      return;
    }
    const iv = setInterval(() => {
      if (window.myskills) {
        setBridgeReady(true);
        clearInterval(iv);
      }
    }, 50);
    return () => clearInterval(iv);
  }, []);

  // Load one-shot meta on mount: platforms, canonical, network gate.
  // (LLM availability is owned by the workspace — it drives the header
  // toggle too — and arrives via the `aiAvailable` prop.)
  useEffect(() => {
    if (!bridgeReady) return;
    let cancelled = false;
    (async () => {
      try {
        const [pls, canon, gate, installed] = await Promise.all([
          api.platforms.list(),
          api.settings.get('canonical_platform'),
          api.settings.get('allow_external_network'),
          api.skills.list({ scope: 'all' }),
        ]);
        if (cancelled) return;
        setPlatforms(pls);
        const canonId = (canon ?? 'shared') as PlatformId;
        setCanonicalPlatform(canonId);
        // Default: install to canonical only (matches the catalog-install contract:
        // the canonical platform owns the actual files, others become symlinks).
        setSelectedPlatforms(new Set([canonId]));
        // '0' means explicitly disabled; missing key / '1' means allowed.
        setNetworkAllowed(gate !== '0');
        setInstalledNames(new Set(installed.map((s) => normalizeSkillKey(s.name))));
      } catch (e) {
        if (!cancelled) console.error('discover meta load failed', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridgeReady]);

  // If AI becomes unavailable after the user picked it (settings changed
  // in another window), force back to keyword. The parent owns `mode`
  // but we know first when network/results bail.
  useEffect(() => {
    if (!aiAvailable && mode === 'ai') onModeChange('keyword');
  }, [aiAvailable, mode, onModeChange]);

  const trimmedQuery = query.trim();
  const queryReady = trimmedQuery.length >= MIN_QUERY_LEN;

  // Debounced search. Three modes share this effect:
  //   - User typed ≥2 chars → run their query in Keyword or AI mode.
  //   - User typed nothing  → run POPULAR_SEED_QUERY ("skill"), label the
  //     result as "popular" so the status line tells the user this isn't a
  //     match for their text. Always Keyword mode for popular — running AI
  //     rerank on the default landing is wasteful.
  //   - Network off          → bail (the no-network banner takes over).
  // Both real searches and popular share the same 300ms debounce, so a user
  // who opens Discover then immediately starts typing only hits skills.sh
  // once (the debounce coalesces).
  useEffect(() => {
    if (!bridgeReady) return;
    if (networkAllowed === false) return;

    const isPopularRun = !queryReady;
    const effectiveQuery = isPopularRun ? POPULAR_SEED_QUERY : trimmedQuery;
    const effectiveMode: SearchMode = isPopularRun ? 'keyword' : mode;

    const mySeq = ++searchSeqRef.current;
    setLoading(true);
    setLoadingPhase('keyword');
    setError(null);
    setAiIntent(null);
    setAiKeywordCount(0);
    setAiCandidateCount(0);
    const timer = setTimeout(async () => {
      try {
        let finalResults: CatalogSearchResult[] = [];

        if (effectiveMode === 'ai') {
          // ── AI pipeline ──────────────────────────────────────────────
          // Optimization stack:
          //   0. Cache: same query in last 30min → instant.
          //   1. Decompose (skipped for short English queries — heuristic).
          //   2. Parallel multi-search over keywords.
          //   3. Progressive: union shown immediately by installs while
          //      Phase 4/5 run, so user sees something at ~1s.
          //   4. Enrich top-30 descriptions BEFORE rerank (so the LLM has
          //      real context, not just names).
          //   5. Rerank top-100 against original intent → final order + why.

          // Step 0 — cache check
          const cached = readPipelineCache(effectiveQuery);
          if (cached) {
            finalResults = cached.skills;
            setResults(cached.skills);
            setAiWhy(cached.why);
            setAiRanked(cached.ranked);
            setAiIntent(cached.intent);
            setIsPopular(false);
            // Descriptions are already on cached.skills, no extra enrich needed.
          } else {
            // Step 1 — decompose (or skip)
            let intent = '';
            let keywords: string[];
            if (shouldSkipDecompose(effectiveQuery)) {
              keywords = [effectiveQuery];
            } else {
              setLoadingPhase('ai-understanding');
              try {
                const decomposed = await aiDecomposeIntent(effectiveQuery);
                if (searchSeqRef.current !== mySeq) return;
                intent = decomposed.intent;
                keywords =
                  decomposed.keywords.length > 0 ? decomposed.keywords : [effectiveQuery];
                setAiIntent(intent || null);
                setAiKeywordCount(keywords.length);
              } catch {
                keywords = [effectiveQuery];
              }
            }

            // Step 2 — multi-search
            setLoadingPhase('ai-multisearch');
            setAiKeywordCount(keywords.length);
            const perSearch = await Promise.all(
              keywords.map((kw) =>
                api.catalog.search(kw, AI_PER_KEYWORD_LIMIT).catch(() => null),
              ),
            );
            if (searchSeqRef.current !== mySeq) return;
            const seenCands = new Set<string>();
            const union: CatalogSearchResult[] = [];
            for (const resp of perSearch) {
              if (!resp) continue;
              for (const s of resp.skills) {
                const key = `${s.source}\x00${s.skillId}`;
                if (seenCands.has(key)) continue;
                seenCands.add(key);
                union.push(s);
              }
            }
            setAiCandidateCount(union.length);

            if (union.length === 0) {
              finalResults = [];
              setResults([]);
              setAiWhy({});
              setAiRanked(false);
              setIsPopular(false);
            } else {
              // Step 3 — progressive: show union sorted by installs
              // immediately so the user has something to look at while
              // Phase 4 + 5 run. The list will reorder when rerank lands.
              const provisional = [...union]
                .sort((a, b) => b.installs - a.installs)
                .slice(0, AI_RESULT_LIMIT);
              setResults(provisional);
              setAiWhy({});
              setAiRanked(false);
              setIsPopular(false);

              // Step 4 — enrich descriptions for the top N candidates
              // BEFORE rerank, so the LLM sees real text and not just
              // names. Updates the displayed provisional list in-place
              // so descriptions appear while waiting on rerank.
              setLoadingPhase('ai-enriching');
              const toEnrich = union.slice(0, AI_RERANK_ENRICH_LIMIT);
              try {
                const enriched = await api.catalog.enrichDescriptions(
                  toEnrich.map((s) => ({ source: s.source, skillId: s.skillId })),
                );
                if (searchSeqRef.current !== mySeq) return;
                const descMap = new Map<string, string | null>();
                for (const e of enriched) {
                  descMap.set(`${e.source}\x00${e.skillId}`, e.description);
                }
                // Mutate union descriptions for rerank input.
                for (const c of union) {
                  const d = descMap.get(`${c.source}\x00${c.skillId}`);
                  if (typeof d === 'string' && d.length > 0 && !c.description) {
                    c.description = d;
                  }
                }
                // Reflect into the visible list too.
                setResults((prev) =>
                  prev.map((r) => {
                    const d = descMap.get(`${r.source}\x00${r.skillId}`);
                    if (typeof d === 'string' && d.length > 0 && !r.description) {
                      return { ...r, description: d };
                    }
                    return r;
                  }),
                );
              } catch {
                // Enrich is best-effort; continue with names alone.
              }

              // Step 5 — rerank with the richer candidate descriptions
              setLoadingPhase('ai-sorting');
              try {
                const ranked = await aiRerank(
                  effectiveQuery,
                  union.slice(0, AI_RERANK_CANDIDATE_LIMIT),
                );
                if (searchSeqRef.current !== mySeq) return;
                if (ranked.length === 0) {
                  finalResults = provisional;
                  setResults(finalResults);
                  setAiWhy({});
                  setAiRanked(false);
                } else {
                  finalResults = ranked.map((r) => r.skill);
                  const whyMap = Object.fromEntries(
                    ranked.map((r) => [r.skill.skillId, r.why]),
                  );
                  setResults(finalResults);
                  setAiWhy(whyMap);
                  setAiRanked(true);
                  writePipelineCache(effectiveQuery, {
                    skills: finalResults,
                    why: whyMap,
                    ranked: true,
                    intent: intent || null,
                  });
                }
              } catch (err) {
                console.error('AI rerank failed', err);
                finalResults = provisional;
                setResults(finalResults);
                setAiWhy({});
                setAiRanked(false);
                onToast(t('discover.ai.fallback'));
              }
            }
          }
        } else {
          // ── Keyword mode: direct search, no LLM ──────────────────────
          const resp = await api.catalog.search(effectiveQuery, undefined);
          if (searchSeqRef.current !== mySeq) return;
          finalResults = resp.skills;
          setResults(finalResults);
          setAiWhy({});
          setAiRanked(false);
          setIsPopular(isPopularRun);
        }

        // Kick off background enrichment for the first N rows. We don't
        // await: the list renders immediately; descriptions stream in.
        // The seq guard lets a fast follow-up query supersede a slow
        // enrich batch from a previous query.
        void enrichResultDescriptions(finalResults.slice(0, ENRICH_LIMIT));
      } catch (err) {
        if (searchSeqRef.current !== mySeq) return;
        const friendly = friendlyCatalogError(err, 'search', t);
        setError(friendly);
        setResults([]);
        setAiWhy({});
        setAiRanked(false);
        setIsPopular(false);
        if (!isPopularRun) onToast(friendly);
      } finally {
        if (searchSeqRef.current === mySeq) {
          setLoading(false);
          setLoadingPhase(null);
        }
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [bridgeReady, networkAllowed, queryReady, trimmedQuery, mode, onToast, t]);

  /**
   * Merge enriched descriptions into result rows by matching (source, skillId).
   * Idempotent — late-arriving enrichments for a stale result set are guarded
   * by enrichSeqRef. Uses the renderer-level results state setter so React
   * re-renders just the rows that changed.
   */
  async function enrichResultDescriptions(rows: CatalogSearchResult[]): Promise<void> {
    if (rows.length === 0) return;
    const mySeq = ++enrichSeqRef.current;
    try {
      const enriched = await api.catalog.enrichDescriptions(
        rows.map((r) => ({ source: r.source, skillId: r.skillId })),
      );
      if (enrichSeqRef.current !== mySeq) return;
      // Build a lookup so the merge is O(N).
      const lookup = new Map<string, string | null>();
      for (const e of enriched) lookup.set(`${e.source}\x00${e.skillId}`, e.description);
      setResults((prev) =>
        prev.map((r) => {
          const desc = lookup.get(`${r.source}\x00${r.skillId}`);
          // Only replace if we got an actual description back; leave
          // existing description in place if enrich found nothing.
          if (typeof desc === 'string' && desc.length > 0 && !r.description) {
            return { ...r, description: desc };
          }
          return r;
        }),
      );
    } catch {
      // Enrichment is best-effort — failures don't degrade the visible list.
    }
  }

  const openPreview = useCallback(
    async (result: CatalogSearchResult) => {
      setSelectedResult(result);
      setPreview(null);
      // Re-seed install-target selection each time we open a preview so the
      // user can't carry stale picks across results. Default = canonical only.
      setSelectedPlatforms(new Set([canonicalPlatform]));
      if (networkAllowed === false) return;
      setPreviewLoading(true);
      try {
        const p = await api.catalog.preview(result.source, result.skillId);
        setPreview(p);
      } catch (err) {
        const friendly = friendlyCatalogError(err, 'preview', t);
        onToast(friendly);
        // Leave selectedResult set so the drawer still shows header + retry context.
        setPreview(null);
      } finally {
        setPreviewLoading(false);
      }
    },
    [canonicalPlatform, networkAllowed, onToast, t],
  );

  function closePreview() {
    setSelectedResult(null);
    setPreview(null);
  }

  function togglePlatform(id: string) {
    setSelectedPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const enabledPlatforms = useMemo(() => platforms.filter((p) => p.enabled), [platforms]);

  async function startInstall() {
    if (!selectedResult) return;
    if (selectedPlatforms.size === 0) return;
    setBusy(true);
    try {
      const plan = await api.catalog.planInstall(
        selectedResult.source,
        selectedResult.skillId,
        selectedResult.name,
        Array.from(selectedPlatforms) as PlatformId[],
      );
      setPendingPlan(plan);
      setPlanOpen(true);
    } catch (err) {
      onToast(friendlyCatalogError(err, 'install', t));
    } finally {
      setBusy(false);
    }
  }

  function onApplied(result: SyncExecuteResult) {
    let msg = t('discover.install.result', { applied: result.applied.length });
    if (result.skipped.length) msg += t('discover.install.result.skipped', { skipped: result.skipped.length });
    if (result.failed.length) msg += t('discover.install.result.failed', { failed: result.failed.length });
    onToast(msg);
    setPlanOpen(false);
    setPendingPlan(null);
    closePreview();
  }

  // --- render ---

  if (networkAllowed === false) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {t('discover.networkDisabled.banner')}
        </div>
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          <div className="flex flex-col items-center gap-3 p-6 text-center">
            <Globe className="h-6 w-6 opacity-50" />
            {t('discover.networkDisabled.cta')}
            {onOpenSettings && (
              <Button size="sm" variant="outline" onClick={onOpenSettings}>
                {t('discover.networkDisabled.openSettings')}
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Status-line copy. Five cases, in priority order:
  // Status-line copy. AI mode goes through 5 progressive phases; each one
  // has its own copy so the user knows what's happening and when.
  // Priority order:
  //   loading + popular           → "Loading popular skills…"
  //   loading + ai-understanding  → "AI is reading your intent…"
  //   loading + ai-multisearch    → "Searching N angles…"
  //   loading + ai-enriching      → "Loading descriptions for AI to read…"
  //   loading + ai-sorting        → "Showing N candidates — AI is reordering…"
  //                                 (provisional results already on screen)
  //   loading + ai-ranking        → "AI is picking the best of N matches…"
  //                                 (no provisional results yet)
  //   loading + keyword           → "Searching catalog…"
  //   error                       → friendly error
  //   isPopular + done            → "Popular on skills.sh"
  //   search + done               → "{n} result(s)"
  const statusLine = loading
    ? isPopular
      ? t('discover.status.popularLoading')
      : loadingPhase === 'ai-understanding'
      ? t('discover.status.aiUnderstanding')
      : loadingPhase === 'ai-multisearch'
      ? t('discover.status.aiMultiSearch', { count: aiKeywordCount })
      : loadingPhase === 'ai-enriching'
      ? t('discover.status.aiEnriching')
      : loadingPhase === 'ai-sorting'
      ? t('discover.status.aiSorting', { count: aiCandidateCount })
      : loadingPhase === 'ai-ranking'
      ? aiCandidateCount > 0
        ? t('discover.status.aiFiltering', { count: aiCandidateCount })
        : t('discover.status.aiRanking')
      : t('discover.status.searching')
    : error
    ? error
    : isPopular
    ? t('discover.status.popular')
    : results.length === 1
    ? t('discover.status.result', { count: results.length })
    : t('discover.status.results', { count: results.length });

  return (
    <div className="flex h-full min-w-0 flex-1">
      <div className="flex h-full flex-1 flex-col">
        {/* Status row — the Keyword/AI toggle used to live here but moved
            to the workspace header so it groups with the search input. */}
        <div className="flex items-center justify-between gap-3 border-b px-4 py-2 text-xs text-muted-foreground">
          <span className="truncate">{statusLine}</span>
          <span className="shrink-0">{t('discover.via')}</span>
        </div>

        <ScrollArea className="flex-1 scrollbar-thin">
          <div className="px-3 py-3">
            {/* Loading-only states first. We never show the "type to search"
                empty hint anymore — opening Discover always fires the popular
                seed, so the user either sees rows or sees a loading spinner. */}
            {loading && results.length === 0 ? (
              <>
                <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  <span>{statusLine}</span>
                </div>
                {/* Skeleton rows give the layout a stable shape while the
                    request is in flight — better than a single spinner in
                    an otherwise blank pane. */}
                <ul className="space-y-2 px-1 pt-2" aria-hidden="true">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <li
                      key={i}
                      className="rounded-md border bg-background px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <div className="h-3.5 w-40 animate-pulse rounded bg-muted/60" />
                        <div className="ml-auto h-3 w-14 animate-pulse rounded bg-muted/40" />
                      </div>
                      <div className="mt-2 h-3 w-24 animate-pulse rounded bg-muted/40" />
                      <div className="mt-2 h-3 w-2/3 animate-pulse rounded bg-muted/40" />
                    </li>
                  ))}
                </ul>
              </>
            ) : results.length === 0 && !error ? (
              // Empty after a real search — distinguish from popular failure
              // (which is rare; if popular returns 0, status line says so).
              queryReady ? (
                <div className="px-3 py-6 text-sm text-muted-foreground">
                  {t('discover.empty.noMatch', { query: trimmedQuery })}
                </div>
              ) : (
                <EmptyHint />
              )
            ) : (
              <>
                {aiRanked && (
                  <div className="mb-2 space-y-0.5 px-1">
                    <div className="flex items-center gap-1.5 text-[11px] font-medium text-violet-600 dark:text-violet-300">
                      <Sparkles className="h-3 w-3" />
                      {t('discover.aiRanked.label')}
                    </div>
                    {/* Intent echo lets the user see how the LLM read their
                        query — important for non-English queries where the
                        keyword decomposition would otherwise be invisible. */}
                    {aiIntent && (
                      <div className="text-[11px] italic text-muted-foreground/80">
                        {t('discover.ai.intentHint', { intent: aiIntent })}
                      </div>
                    )}
                  </div>
                )}
                <ul className="space-y-1.5">
                  {results.map((r) => (
                    <li key={`${r.source}/${r.skillId}/${r.id}`}>
                      <ResultRow
                        result={r}
                        why={aiWhy[r.skillId]}
                        installed={
                          installedNames.has(normalizeSkillKey(r.skillId)) ||
                          installedNames.has(normalizeSkillKey(r.name))
                        }
                        selected={
                          selectedResult?.source === r.source &&
                          selectedResult?.skillId === r.skillId
                        }
                        onClick={() => openPreview(r)}
                      />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </ScrollArea>
      </div>

      {selectedResult && (
        <PreviewDrawer
          result={selectedResult}
          preview={preview}
          loading={previewLoading}
          enabledPlatforms={enabledPlatforms}
          selectedPlatforms={selectedPlatforms}
          onTogglePlatform={togglePlatform}
          canonicalPlatform={canonicalPlatform}
          busy={busy}
          onClose={closePreview}
          onInstall={startInstall}
        />
      )}

      <SyncConfirm
        open={planOpen}
        plan={pendingPlan}
        canonicalPlatform={canonicalPlatform}
        onOpenChange={setPlanOpen}
        onApplied={onApplied}
      />
    </div>
  );
}

function EmptyHint() {
  const t = useT();
  return (
    <div className="flex flex-col items-center gap-3 px-3 py-12 text-center text-sm text-muted-foreground">
      <Globe className="h-7 w-7 opacity-40" />
      <div>{t('discover.empty.useSearch')}</div>
    </div>
  );
}

function ResultRow({
  result,
  why,
  installed,
  selected,
  onClick,
}: {
  result: CatalogSearchResult;
  /** LLM-generated rationale, only present in AI mode. */
  why?: string;
  /** True when a local skill with a matching name already exists. */
  installed?: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  const t = useT();
  return (
    <button
      onClick={onClick}
      className={cn(
        'block w-full rounded-md border bg-background px-3 py-2 text-left transition-colors',
        selected ? 'border-primary/60 bg-accent/40' : 'hover:bg-accent/30',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="truncate font-medium text-sm" title={result.name}>
          {result.name}
        </span>
        {installed && (
          <span
            className="shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
            title={t('discover.installedBadge.title')}
          >
            {t('discover.installedBadge')}
          </span>
        )}
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {formatInstalls(result.installs)} {t('discover.installs.label')}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-2">
        <span
          className="truncate rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-secondary-foreground"
          title={result.source}
        >
          {result.source}
        </span>
      </div>
      {/* Description: shown when present, hidden (or shown as a thin
          shimmer) when not. The enrichment IPC populates this in the
          background after the initial render, so initially-empty rows
          fill in within ~1 second on the first visit, instantly after.
          Rows that genuinely have no description in frontmatter remain
          empty — better than a sea of "(no description)" placeholders. */}
      {result.description?.trim() ? (
        <div
          className="mt-1 line-clamp-2 text-xs text-muted-foreground"
          title={result.description.trim()}
        >
          {result.description.trim()}
        </div>
      ) : (
        <div
          aria-hidden="true"
          className="mt-1 h-3 w-2/3 rounded bg-muted/40"
        />
      )}
      {why && (
        <div
          className="mt-1 line-clamp-2 text-xs italic text-muted-foreground/80"
          title={why}
        >
          {why}
        </div>
      )}
    </button>
  );
}

/**
 * Segmented "Keyword" | "AI" toggle. The AI half is disabled in only one
 * case: `aiAvailable` = false (no LLM configured or feature toggle off).
 *
 * `queryReady` is still passed in so the tooltip can hint "type something
 * to engage AI" — but the button stays clickable. Users intuitively want
 * to pick the mode BEFORE typing, not after, and the search loop already
 * falls back to keyword on the popular landing regardless of selection
 * (see isPopularRun + effectiveMode).
 */
export function ModeSegmented({
  mode,
  aiAvailable,
  queryReady,
  onChange,
  onRequestAiSetup,
}: {
  mode: SearchMode;
  aiAvailable: boolean;
  queryReady: boolean;
  onChange: (m: SearchMode) => void;
  /** When AI isn't configured, clicking the AI tab routes here (deep-link to
   * Settings → AI) instead of being a dead disabled control. */
  onRequestAiSetup?: () => void;
}) {
  const t = useT();
  const aiClickable = aiAvailable || Boolean(onRequestAiSetup);
  const aiTitle = !aiAvailable
    ? onRequestAiSetup
      ? t('discover.mode.ai.title.needsSetup')
      : t('discover.mode.ai.title.disabled')
    : !queryReady
    ? t('discover.mode.ai.title.willEngage')
    : t('discover.mode.ai.title.enabled');
  return (
    <div
      role="tablist"
      aria-label={t('discover.mode.label')}
      className="flex shrink-0 items-center rounded-md border bg-background p-0.5 text-[11px]"
    >
      <button
        role="tab"
        aria-selected={mode === 'keyword'}
        onClick={() => onChange('keyword')}
        className={cn(
          'rounded px-2 py-0.5 transition-colors',
          mode === 'keyword'
            ? 'bg-accent text-foreground'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        {t('discover.mode.keyword.label')}
      </button>
      <button
        role="tab"
        aria-selected={mode === 'ai'}
        disabled={!aiClickable}
        title={aiTitle}
        onClick={() => {
          if (!aiClickable) return;
          if (!aiAvailable) {
            onRequestAiSetup?.();
            return;
          }
          onChange('ai');
        }}
        className={cn(
          'flex items-center gap-1 rounded px-2 py-0.5 transition-colors',
          mode === 'ai' && aiAvailable
            ? 'bg-accent text-foreground'
            : 'text-muted-foreground hover:text-foreground',
          !aiAvailable && 'opacity-60',
          !aiClickable && 'cursor-not-allowed opacity-50 hover:text-muted-foreground',
        )}
      >
        <Sparkles className="h-3 w-3" />
        {t('discover.mode.ai')}
      </button>
    </div>
  );
}

function PreviewDrawer({
  result,
  preview,
  loading,
  enabledPlatforms,
  selectedPlatforms,
  onTogglePlatform,
  canonicalPlatform,
  busy,
  onClose,
  onInstall,
}: {
  result: CatalogSearchResult;
  preview: CatalogPreview | null;
  loading: boolean;
  enabledPlatforms: Platform[];
  selectedPlatforms: Set<string>;
  onTogglePlatform: (id: string) => void;
  canonicalPlatform: PlatformId;
  busy: boolean;
  onClose: () => void;
  onInstall: () => void;
}) {
  const t = useT();
  const installDisabled =
    busy || selectedPlatforms.size === 0 || enabledPlatforms.length === 0;
  return (
    <aside className="flex h-full w-[460px] flex-col border-l bg-card/40">
      <div className="titlebar-drag flex h-12 shrink-0 items-center justify-end border-b px-3">
        <button
          onClick={onClose}
          className="titlebar-no-drag text-xs text-muted-foreground hover:text-foreground"
        >
          {t('common.close')}
        </button>
      </div>

      <ScrollArea className="flex-1 scrollbar-thin">
        <div className="space-y-5 p-5">
          <header className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-2">
                <h2 className="text-base font-semibold tracking-tight">{result.name}</h2>
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-secondary-foreground">
                    {result.source}
                  </span>
                  <span>·</span>
                  <span>{t('discover.preview.installsCount', { n: formatInstalls(result.installs) })}</span>
                  <span>·</span>
                  <span>{t('discover.preview.viaSkills')}</span>
                </div>
              </div>
              {/* Header-level install CTA. Mirrors the footer button so users
                  reading SKILL.md don't have to scroll back down to act.
                  Disabled state matches the footer; both wire to the same
                  handler. */}
              <Button
                size="sm"
                onClick={onInstall}
                disabled={installDisabled}
                className="shrink-0"
              >
                <Download className="mr-1.5 h-3.5 w-3.5" />
                {selectedPlatforms.size === 0
                  ? t('discover.preview.installButton')
                  : t('discover.preview.installButton') +
                    ` · ${selectedPlatforms.size}`}
              </Button>
            </div>
          </header>

          <Separator />

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('discover.preview.installTo.heading')}
            </h3>
            {enabledPlatforms.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t('discover.preview.noEnabledPlatforms')}
              </p>
            ) : (
              <ul className="space-y-1">
                {enabledPlatforms.map((p) => {
                  const checked = selectedPlatforms.has(p.id);
                  const isCanon = p.id === canonicalPlatform;
                  return (
                    <li key={p.id}>
                      <label
                        className={cn(
                          'flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-xs',
                          checked ? 'border-primary/60 bg-accent/40' : 'hover:bg-accent/30',
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => onTogglePlatform(p.id)}
                          className="h-3.5 w-3.5"
                        />
                        <span className="font-medium">{p.label}</span>
                        {isCanon && (
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                            {t('discover.preview.canonicalBadge')}
                          </span>
                        )}
                        <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground">
                          {p.skillsDir}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="mt-2 text-[11px] text-muted-foreground">
              {t('discover.preview.symlinkNote')}
            </p>
          </section>

          <Separator />

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('discover.preview.skillmd')}
            </h3>
            {loading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t('discover.preview.fetching')}
              </div>
            ) : preview ? (
              <pre className="overflow-x-auto rounded-md bg-secondary/40 p-3 text-xs whitespace-pre-wrap font-mono leading-relaxed">
                {preview.rawMarkdown}
              </pre>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t('discover.preview.previewFailed')}
              </p>
            )}
          </section>
        </div>
      </ScrollArea>

      <div className="border-t p-3">
        <Button
          className="w-full"
          onClick={onInstall}
          disabled={busy || selectedPlatforms.size === 0 || enabledPlatforms.length === 0}
        >
          <Download className="mr-1.5 h-4 w-4" />
          {selectedPlatforms.size === 0
            ? t('discover.preview.installCount.zero')
            : selectedPlatforms.size === 1
            ? t('discover.preview.installCount.one', { count: selectedPlatforms.size })
            : t('discover.preview.installCount.many', { count: selectedPlatforms.size })}
        </Button>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Per-keyword search cap. Smaller than AI_CANDIDATE_LIMIT because we run
 *  several in parallel — total pool size is `keywords.length * this`. */
const AI_PER_KEYWORD_LIMIT = 30;

/**
 * Phase 1 of the AI search pipeline: decompose the user's natural-language
 * query into an English-keyword search plan for the (English-only)
 * skills.sh catalog. The model also returns a one-sentence intent summary
 * so the UI can echo back "Understood as: …".
 *
 * Examples (illustrative — actual output depends on the model):
 *   "PPT制作"          → { intent: "create slide decks",
 *                          keywords: ["slides", "presentation", "deck", "ppt"] }
 *   "make websites"   → { intent: "build a website",
 *                          keywords: ["website", "html", "deploy"] }
 *   "git workflow"    → { intent: "git development workflow",
 *                          keywords: ["git"] }
 *
 * Throws on transport failure or unparseable JSON — caller catches and
 * falls back to direct keyword search.
 */
async function aiDecomposeIntent(
  query: string,
): Promise<{ intent: string; keywords: string[] }> {
  const systemPrompt =
    'You translate a user\'s natural-language need (any language) into a ' +
    'search plan for an English-only developer "skill" catalog (think: ' +
    'standalone capabilities like "slide-builder" or "git-helper"). ' +
    'Return strict JSON: ' +
    '{ "intent": string, "keywords": string[] }. ' +
    '"intent" is a short one-sentence summary IN THE SAME LANGUAGE AS THE ' +
    'USER\'S QUERY of what they want. ' +
    '"keywords" is 1-5 short English search terms (1-3 words each, ' +
    'lowercase, no punctuation, no commas) likely to match catalog entries. ' +
    'Cover the user\'s intent from multiple angles when natural. ' +
    'Do not output anything outside the JSON.';
  const resp = await api.llm.chat({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: query },
    ],
    jsonMode: true,
    temperature: 0.2,
    // 4096 to stay safe with reasoning models — same rationale as the
    // other LLM calls in this file.
    maxTokens: 4096,
  });
  const parsed = parseDecomposeJson(resp.text);
  if (!parsed) throw new Error('Decompose: LLM returned malformed JSON');
  return parsed;
}

interface DecomposePayload {
  intent: string;
  keywords: string[];
}

function parseDecomposeJson(text: string): DecomposePayload | null {
  try {
    const obj = JSON.parse(text) as unknown;
    if (!obj || typeof obj !== 'object') return null;
    const o = obj as { intent?: unknown; keywords?: unknown };
    const intent = typeof o.intent === 'string' ? o.intent.trim() : '';
    if (!Array.isArray(o.keywords)) return null;
    const keywords: string[] = [];
    for (const k of o.keywords) {
      if (typeof k !== 'string') continue;
      const t = k.trim();
      if (!t) continue;
      // Defensive: dedupe + cap to 5.
      if (keywords.some((existing) => existing.toLowerCase() === t.toLowerCase())) continue;
      keywords.push(t);
      if (keywords.length >= 5) break;
    }
    return { intent, keywords };
  } catch {
    return null;
  }
}

/**
 * Ask the configured LLM to rerank a keyword-derived candidate pool by how
 * well each candidate matches the user's natural-language query, returning up
 * to AI_RESULT_LIMIT results paired with a one-sentence rationale.
 *
 * Throws on transport failure or unparseable JSON — the caller falls back to
 * keyword results in that case.
 */
async function aiRerank(
  query: string,
  candidates: CatalogSearchResult[],
): Promise<Array<{ skill: CatalogSearchResult; why: string }>> {
  // Candidate lines deliberately *omit* installs. The UI shows install
  // counts in its own column; passing them in the prompt led the model
  // to (a) repeat numbers redundantly in "why", and (b) hallucinate a
  // number when it didn't have the exact value cached. Without installs
  // in the prompt the model focuses on actual semantic relevance.
  // Descriptions are truncated to keep the prompt bounded.
  const candidateLines = candidates
    .map((c) => {
      const desc = (c.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
      return `- id=${c.skillId} name=${c.name} description=${desc}`;
    })
    .join('\n');

  const systemPrompt =
    "You are a skill catalog ranker. Given a user's natural-language need and a list of candidate skills " +
    "(each with id, name, description), return the top 10 MOST RELEVANT in JSON.\n" +
    "\n" +
    "Ranking criteria, in order of importance:\n" +
    "  1. Direct match on the user's intent (does this skill actually solve their problem?)\n" +
    "  2. Specificity (a skill that does exactly the thing > a generic skill that might).\n" +
    "  3. Quality signals in the description (clear purpose, well-scoped, documented).\n" +
    "Do NOT consider installs — the UI shows install counts separately; they are not passed to you.\n" +
    "Do NOT invent numbers or facts not present in the candidate's name/description.\n" +
    "\n" +
    "For each result include a one-sentence \"why\" that:\n" +
    "  - Explains HOW this skill matches the user's intent (not its features in general).\n" +
    "  - Is written IN THE SAME LANGUAGE AS THE USER'S QUERY (Chinese query → Chinese why,\n" +
    "    English query → English why, etc.).\n" +
    "  - Is concise (one sentence, no preamble like \"This skill ...\").\n" +
    "\n" +
    "Return ONLY valid JSON with this shape:\n" +
    '{ "results": [ { "id": string, "why": string } ] }\n' +
    "Skills that don't actually match the user's intent must be excluded. " +
    "If fewer than 10 are clearly relevant, return fewer. If none match, return an empty results array.";

  const userPrompt = `User query: ${query}\n\nCandidates:\n${candidateLines}`;

  const resp = await api.llm.chat({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    jsonMode: true,
    temperature: 0.2,
    // 4096 (not 1024) because reasoning models like deepseek-v4-pro burn
    // most of the budget on hidden reasoning_content before emitting the
    // visible JSON. 1024 caused LLM_BUDGET_EXHAUSTED → AI rerank failed →
    // user got the "AI rerank failed, showing keyword results" toast on
    // every search. Mirrors the same fix in electron/ai/categorize.ts.
    maxTokens: 4096,
  });

  const parsed = parseRerankJson(resp.text);
  if (!parsed) throw new Error('LLM returned malformed JSON');

  // Map ids → original candidate. Unknown ids (model hallucinated) are skipped silently.
  const byId = new Map(candidates.map((c) => [c.skillId, c]));
  const out: Array<{ skill: CatalogSearchResult; why: string }> = [];
  const seen = new Set<string>();
  for (const r of parsed.results) {
    if (seen.has(r.id)) continue;
    const skill = byId.get(r.id);
    if (!skill) continue;
    out.push({ skill, why: r.why });
    seen.add(r.id);
    if (out.length >= AI_RESULT_LIMIT) break;
  }
  return out;
}

interface RerankPayload {
  results: Array<{ id: string; why: string }>;
}

/** Tolerantly parse the rerank JSON — returns null on any structural problem. */
function parseRerankJson(text: string): RerankPayload | null {
  try {
    const obj = JSON.parse(text) as unknown;
    if (!obj || typeof obj !== 'object') return null;
    const results = (obj as { results?: unknown }).results;
    if (!Array.isArray(results)) return null;
    const clean: Array<{ id: string; why: string }> = [];
    for (const item of results) {
      if (!item || typeof item !== 'object') continue;
      const id = (item as { id?: unknown }).id;
      const why = (item as { why?: unknown }).why;
      if (typeof id !== 'string' || typeof why !== 'string') continue;
      clean.push({ id, why });
    }
    return { results: clean };
  } catch {
    return null;
  }
}

function formatInstalls(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Desktop command bridges can surface backend errors as stringified messages.
 * We extract the `code` field heuristically and map known catalog codes to
 * friendly text.
 *
 * @param phase Which user-facing operation failed — used only to disambiguate
 *              CONTENT_NOT_FOUND messaging (preview vs install).
 */
function friendlyCatalogError(err: unknown, phase: 'search' | 'preview' | 'install', t: ReturnType<typeof useT>): string {
  const raw = err instanceof Error ? err.message : String(err);
  const code = extractCode(raw);
  switch (code) {
    case 'CATALOG_UNAVAILABLE':
      return t('discover.error.unavailable');
    case 'CATALOG_RATE_LIMITED':
      return t('discover.error.rateLimited');
    case 'CATALOG_UNAUTHORIZED':
      return t('discover.error.unauthorized');
    case 'CONTENT_NOT_FOUND':
      return phase === 'preview'
        ? t('discover.error.notFound.preview')
        : t('discover.error.notFound.install');
    default:
      return raw || t('discover.error.generic');
  }
}

function extractCode(message: string): string | null {
  const m = message.match(/"code"\s*:\s*"([A-Z_]+)"/);
  if (m) return m[1] ?? null;
  // Some bridge versions surface the code as a bare token in the message.
  const known = [
    'CATALOG_UNAVAILABLE',
    'CATALOG_RATE_LIMITED',
    'CATALOG_UNAUTHORIZED',
    'CONTENT_NOT_FOUND',
    'CATALOG_ERROR',
  ];
  for (const k of known) if (message.includes(k)) return k;
  return null;
}
