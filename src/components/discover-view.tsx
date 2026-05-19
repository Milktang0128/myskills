'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Globe, Loader2 } from 'lucide-react';
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
import { cn } from '@/lib/utils';

interface Props {
  /** Live query from the workspace top-bar search input. */
  query: string;
  onToast: (msg: string) => void;
}

const DEBOUNCE_MS = 300;
const MIN_QUERY_LEN = 2;

export function DiscoverView({ query, onToast }: Props) {
  const [bridgeReady, setBridgeReady] = useState(false);
  const [results, setResults] = useState<CatalogSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // Used to ignore stale search responses (the user typed faster than the API).
  const searchSeqRef = useRef(0);

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
  useEffect(() => {
    if (!bridgeReady) return;
    let cancelled = false;
    (async () => {
      try {
        const [pls, canon, gate] = await Promise.all([
          api.platforms.list(),
          api.settings.get('canonical_platform'),
          api.settings.get('allow_external_network'),
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
      } catch (e) {
        if (!cancelled) console.error('discover meta load failed', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridgeReady]);

  const trimmedQuery = query.trim();
  const queryReady = trimmedQuery.length >= MIN_QUERY_LEN;

  // Debounced search.
  useEffect(() => {
    if (!bridgeReady) return;
    if (networkAllowed === false) return;
    if (!queryReady) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    const mySeq = ++searchSeqRef.current;
    setLoading(true);
    setError(null);
    const t = setTimeout(async () => {
      try {
        const resp = await api.catalog.search(trimmedQuery);
        if (searchSeqRef.current !== mySeq) return;
        setResults(resp.skills);
      } catch (err) {
        if (searchSeqRef.current !== mySeq) return;
        const friendly = friendlyCatalogError(err, 'search');
        setError(friendly);
        setResults([]);
        onToast(friendly);
      } finally {
        if (searchSeqRef.current === mySeq) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [bridgeReady, networkAllowed, queryReady, trimmedQuery, onToast]);

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
        const friendly = friendlyCatalogError(err, 'preview');
        onToast(friendly);
        // Leave selectedResult set so the drawer still shows header + retry context.
        setPreview(null);
      } finally {
        setPreviewLoading(false);
      }
    },
    [canonicalPlatform, networkAllowed, onToast],
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
      onToast(friendlyCatalogError(err, 'install'));
    } finally {
      setBusy(false);
    }
  }

  function onApplied(result: SyncExecuteResult) {
    onToast(
      `Installed ${result.applied.length} file${result.applied.length === 1 ? '' : 's'}` +
        (result.skipped.length ? ` · ${result.skipped.length} skipped` : '') +
        (result.failed.length ? ` · ${result.failed.length} failed` : ''),
    );
    setPlanOpen(false);
    setPendingPlan(null);
    closePreview();
  }

  // --- render ---

  if (networkAllowed === false) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          External network is disabled in Settings — Discover requires it.
        </div>
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          <div className="flex flex-col items-center gap-2 p-6 text-center">
            <Globe className="h-6 w-6 opacity-50" />
            Enable external network access in Settings to browse the catalog.
          </div>
        </div>
      </div>
    );
  }

  const statusLine = !queryReady
    ? 'Type a query to search the catalog'
    : loading
    ? `Searching ${trimmedQuery}…`
    : error
    ? error
    : `${results.length} result${results.length === 1 ? '' : 's'}`;

  return (
    <div className="flex h-full min-w-0 flex-1">
      <div className="flex h-full flex-1 flex-col">
        <div className="flex items-center justify-between gap-3 border-b px-4 py-2 text-xs text-muted-foreground">
          <span className="truncate">{statusLine}</span>
          <span className="shrink-0">via skills.sh</span>
        </div>

        <ScrollArea className="flex-1 scrollbar-thin">
          <div className="px-3 py-3">
            {!queryReady ? (
              <EmptyHint />
            ) : loading && results.length === 0 ? (
              <div className="flex items-center gap-2 px-3 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Searching…
              </div>
            ) : results.length === 0 && !error ? (
              <div className="px-3 py-6 text-sm text-muted-foreground">
                No skills matched “{trimmedQuery}”.
              </div>
            ) : (
              <ul className="space-y-1.5">
                {results.map((r) => (
                  <li key={`${r.source}/${r.skillId}/${r.id}`}>
                    <ResultRow
                      result={r}
                      selected={
                        selectedResult?.source === r.source &&
                        selectedResult?.skillId === r.skillId
                      }
                      onClick={() => openPreview(r)}
                    />
                  </li>
                ))}
              </ul>
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
  return (
    <div className="flex flex-col items-center gap-3 px-3 py-12 text-center text-sm text-muted-foreground">
      <Globe className="h-7 w-7 opacity-40" />
      <div>
        Use the search bar at the top to find skills published on{' '}
        <span className="font-mono">skills.sh</span>.
      </div>
    </div>
  );
}

function ResultRow({
  result,
  selected,
  onClick,
}: {
  result: CatalogSearchResult;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'block w-full rounded-md border bg-background px-3 py-2 text-left transition-colors',
        selected ? 'border-primary/60 bg-accent/40' : 'hover:bg-accent/30',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="truncate font-medium text-sm">{result.name}</span>
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {formatInstalls(result.installs)} installs
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-2">
        <span className="truncate rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-secondary-foreground">
          {result.source}
        </span>
      </div>
      <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
        {result.description?.trim() ||
          '(no description in catalog — open to fetch SKILL.md)'}
      </div>
    </button>
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
  return (
    <aside className="flex h-full w-[460px] flex-col border-l bg-card/40">
      <div className="titlebar-drag flex h-9 shrink-0 items-center justify-end border-b px-3">
        <button
          onClick={onClose}
          className="titlebar-no-drag text-xs text-muted-foreground hover:text-foreground"
        >
          Close
        </button>
      </div>

      <ScrollArea className="flex-1 scrollbar-thin">
        <div className="space-y-5 p-5">
          <header className="space-y-2">
            <h2 className="text-base font-semibold tracking-tight">{result.name}</h2>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-secondary-foreground">
                {result.source}
              </span>
              <span>·</span>
              <span>{formatInstalls(result.installs)} installs</span>
              <span>·</span>
              <span>Preview from skills.sh</span>
            </div>
          </header>

          <Separator />

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Install to
            </h3>
            {enabledPlatforms.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No enabled platforms — configure one in Settings before installing.
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
                            canonical
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
              Non-canonical platforms receive a symlink to the canonical copy.
            </p>
          </section>

          <Separator />

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              SKILL.md
            </h3>
            {loading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Fetching from GitHub…
              </div>
            ) : preview ? (
              <pre className="overflow-x-auto rounded-md bg-secondary/40 p-3 text-xs whitespace-pre-wrap font-mono leading-relaxed">
                {preview.rawMarkdown}
              </pre>
            ) : (
              <p className="text-xs text-muted-foreground">
                Couldn’t load preview — install will still attempt to fetch the
                latest copy from the source.
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
            ? 'Pick at least one platform'
            : `Install to ${selectedPlatforms.size} platform${selectedPlatforms.size === 1 ? '' : 's'}`}
        </Button>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function formatInstalls(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Electron's ipcMain.handle serializes thrown plain-object errors into the
 * renderer's Error.message via a JSON-ish stringification. We extract the
 * `code` field heuristically and map known catalog codes to friendly text.
 *
 * @param phase Which user-facing operation failed — used only to disambiguate
 *              CONTENT_NOT_FOUND messaging (preview vs install).
 */
function friendlyCatalogError(err: unknown, phase: 'search' | 'preview' | 'install'): string {
  const raw = err instanceof Error ? err.message : String(err);
  const code = extractCode(raw);
  switch (code) {
    case 'CATALOG_UNAVAILABLE':
      return "skills.sh isn’t reachable right now — try again later.";
    case 'CATALOG_RATE_LIMITED':
      return 'skills.sh is rate-limiting us — wait a moment and try again.';
    case 'CATALOG_UNAUTHORIZED':
      return 'skills.sh rejected the request as unauthorized.';
    case 'CONTENT_NOT_FOUND':
      return phase === 'preview'
        ? "Couldn’t fetch SKILL.md from GitHub — the skill may have moved or be private."
        : "Couldn’t find this skill at the source — it may have moved or been removed.";
    default:
      return raw || 'Catalog request failed.';
  }
}

function extractCode(message: string): string | null {
  const m = message.match(/"code"\s*:\s*"([A-Z_]+)"/);
  if (m) return m[1] ?? null;
  // Some Electron versions surface the code as a bare token in the message.
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
