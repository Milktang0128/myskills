'use client';

/**
 * Library Map — an AI-generated read-only navigation aid showing the user's
 * entire skill library clustered by theme with a one-line "positioning"
 * for each skill.
 *
 * This is NOT the scenarios page:
 *   - Clusters are AI-derived snapshots, not user-curated.
 *   - Clicking a cluster doesn't create a scenario.
 *   - Per-skill briefs don't shadow SKILL.md descriptions — original is
 *     visible on hover (title attribute) and via the detail drawer.
 *
 * Lifecycle:
 *   - First load: call `libraryOverviewGet`; either shows the cached map
 *     or an empty CTA prompting generation.
 *   - "Generate" button calls `libraryOverviewGenerate` (one LLM pass).
 *   - When the cached snapshot is stale (skill set changed since), a banner
 *     surfaces with a "Refresh" CTA.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Sparkles,
  RefreshCw,
  AlertCircle,
  Loader2,
  Map as MapIcon,
  Plus,
  Layers,
  Check,
} from 'lucide-react';
import type {
  AiJob,
  LibraryOverview,
  LibraryOverviewCluster,
  LibraryOverviewSnapshot,
  Scenario,
  Skill,
} from '@shared/types';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { api } from '@/lib/api';
import { useT, useI18n } from '@/lib/i18n';
import { cn, formatRelative } from '@/lib/utils';

interface Props {
  /**
   * Workspace-level callback so clicking a skill in the map opens the same
   * detail drawer used by the list / coverage views. Keeps navigation
   * consistent across the app.
   */
  onSelectSkill: (skillId: string) => void;
  /** True if LLM key + search/categorize feature is configured. Drives the
   *  "AI required" gate so we don't pretend the button works. */
  llmConfigured: boolean;
  /**
   * Called after a cluster has been successfully converted into a scenario
   * (or merged into an existing one). The workspace uses this to refresh
   * sidebar scenario counts / colors.
   */
  onScenariosChanged: () => void;
  /** Shared workspace toast — surfaces the "created N skills linked" message. */
  onToast: (message: string) => void;
  /** Deep-link to Settings → AI from the "AI required" gate. */
  onOpenAiSettings?: () => void;
  /** Current scenarios — lets cluster buttons show "已转成 · 同步" instead of
   * pretending a conversion would create something new. */
  scenarios?: Scenario[];
}

/**
 * Mirror of the backend's scenario-key derivation (Rust `slugify` in
 * commands/mod.rs): lowercase, runs of whitespace + slashes collapse to one
 * dash, leading/trailing dashes/underscores trimmed, 64 chars max. Keep the
 * two in sync — this is how the UI predicts whether 转成场景 will create or
 * merge.
 */
function scenarioKeyOf(name: string): string {
  let out = '';
  let prevDash = false;
  for (const c of name.trim().toLowerCase()) {
    if (/\s/.test(c) || c === '/' || c === '\\') {
      if (!prevDash) {
        out += '-';
        prevDash = true;
      }
    } else {
      out += c;
      prevDash = false;
    }
  }
  return out.replace(/^[-_]+/, '').replace(/[-_]+$/, '').slice(0, 64);
}

export function LibraryMapView({
  onSelectSkill,
  llmConfigured,
  onScenariosChanged,
  onToast,
  onOpenAiSettings,
  scenarios = [],
}: Props) {
  const t = useT();
  const { locale } = useI18n();
  const lang: 'zh' | 'en' = locale;
  const [snapshot, setSnapshot] = useState<LibraryOverviewSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateJob, setGenerateJob] = useState<AiJob<LibraryOverview> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bridgeReady, setBridgeReady] = useState(false);
  // Per-cluster in-flight state. Keyed by cluster.key (slug). Don't track
  // "already converted" — regenerating the Map invalidates that boolean,
  // and merging into an existing scenario is idempotent anyway.
  const [converting, setConverting] = useState<Set<string>>(() => new Set());
  // Live lookup: which scenario keys already exist. After a conversion,
  // onScenariosChanged → page refreshes scenarios → buttons flip to
  // "已转成 · 同步" without any local bookkeeping (which regeneration of the
  // map would invalidate anyway).
  const scenarioKeys = useMemo(() => new Set(scenarios.map((s) => s.key)), [scenarios]);
  // Batch "turn every cluster into a scenario" in-flight flag.
  const [convertingAll, setConvertingAll] = useState(false);

  const convertCluster = useCallback(
    async (cluster: LibraryOverviewCluster) => {
      // Optimistic: mark in-flight immediately so the button locks. We do
      // NOT remove the cluster from the UI on success — the user might want
      // to read the cluster's brief positions after converting.
      setConverting((prev) => {
        const next = new Set(prev);
        next.add(cluster.key);
        return next;
      });
      try {
        const result = await api.scenarios.createFromCluster({
          name: cluster.name,
          skillIds: cluster.skills.map((s) => s.skillId),
        });
        const toastKey = result.created
          ? 'map.cluster.created'
          : 'map.cluster.merged';
        onToast(
          t(toastKey, {
            name: cluster.name,
            linked: result.skillsLinked,
            skipped: result.skillsSkipped,
          }),
        );
        onScenariosChanged();
      } catch (err) {
        onToast(t('map.cluster.failed', { message: messageOf(err) }));
      } finally {
        setConverting((prev) => {
          const next = new Set(prev);
          next.delete(cluster.key);
          return next;
        });
      }
    },
    [onScenariosChanged, onToast, t],
  );

  // One-click: turn EVERY non-empty cluster into a scenario. Sequential (not
  // parallel) — createFromCluster merges by name, and scenario rows are cheap
  // DB writes, so a serial loop avoids write races and keeps a clean aggregate
  // count. Failures per cluster are tolerated and summarised, not fatal.
  const convertAllClusters = useCallback(
    async (clusters: LibraryOverviewCluster[]) => {
      const targets = clusters.filter((c) => c.skills.length > 0);
      if (targets.length === 0) {
        onToast(t('map.convertAll.empty'));
        return;
      }
      setConvertingAll(true);
      let created = 0;
      let merged = 0;
      let linked = 0;
      let failed = 0;
      for (const cluster of targets) {
        try {
          const result = await api.scenarios.createFromCluster({
            name: cluster.name,
            skillIds: cluster.skills.map((s) => s.skillId),
          });
          if (result.created) created += 1;
          else merged += 1;
          linked += result.skillsLinked;
        } catch {
          failed += 1;
        }
      }
      setConvertingAll(false);
      onScenariosChanged();
      onToast(
        t(failed > 0 ? 'map.convertAll.donePartial' : 'map.convertAll.done', {
          created,
          merged,
          linked,
          failed,
        }),
      );
    },
    [onScenariosChanged, onToast, t],
  );

  // Bridge readiness — same pattern as other views.
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

  const refresh = useCallback(async () => {
    if (!bridgeReady) return;
    setLoading(true);
    setError(null);
    try {
      const snap = await api.ai.libraryOverviewGet(lang);
      setSnapshot(snap);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoading(false);
    }
  }, [bridgeReady, lang]);

  // Initial load + reload when language changes (the cached overview is in
  // one language; switching UI language flips the snapshot to stale).
  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!bridgeReady || !llmConfigured) return;
    let cancelled = false;
    void api.ai
      .jobLatest<LibraryOverview>('library_overview_generate', lang)
      .then((job) => {
        if (cancelled || !job || !['queued', 'running'].includes(job.status)) return;
        setGenerateJob(job);
        setGenerating(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [bridgeReady, lang, llmConfigured]);

  useEffect(() => {
    if (!generateJob || !['queued', 'running'].includes(generateJob.status)) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const job = await api.ai.jobGet<LibraryOverview>(generateJob.jobId);
        if (cancelled) return;
        setGenerateJob(job);
        if (job.status === 'succeeded') {
          const snap = await api.ai.libraryOverviewGet(lang);
          if (cancelled) return;
          setSnapshot({ ...snap, overview: job.result ?? snap.overview });
          setGenerating(false);
          setGenerateJob(null);
        } else if (job.status === 'failed') {
          setError(messageOf(job.error));
          setGenerating(false);
          setGenerateJob(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(messageOf(err));
          setGenerating(false);
          setGenerateJob(null);
        }
      }
    };
    void poll();
    const id = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [generateJob, lang]);

  async function generate(): Promise<void> {
    setGenerating(true);
    setError(null);
    try {
      const job = await api.ai.libraryOverviewGenerateJob(lang);
      setGenerateJob(job);
    } catch (err) {
      setError(messageOf(err));
      setGenerating(false);
    }
  }

  // ── render ────────────────────────────────────────────────────────────

  if (!bridgeReady || loading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {t('map.loading')}
      </div>
    );
  }

  if (!llmConfigured) {
    return <LlmGate onOpenAiSettings={onOpenAiSettings} />;
  }

  const overview = snapshot?.overview ?? null;
  const stale = snapshot?.stale ?? false;

  if (!overview) {
    return (
      <EmptyState
        generating={generating}
        error={error}
        onGenerate={generate}
      />
    );
  }

  return (
    // flex-1 + min-h-0 instead of h-full: inside the workspace's flex-col
    // shell, h-full would resolve to 100vh and overflow past the 48px header
    // by exactly that amount, clipping the bottom of the scroll region.
    <div className="flex min-h-0 flex-1 flex-col">
      {stale && (
        <StaleBanner generating={generating} onRefresh={generate} />
      )}
      {error && (
        <div className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="flex-1">{error}</span>
        </div>
      )}

      <ScrollArea className="flex-1 scrollbar-thin">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
          {/* Header: intro + metadata. The "regenerate" button lives here so
              it's visible without scrolling but doesn't compete with the
              stale banner. */}
          <header className="space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <MapIcon className="h-5 w-5 text-violet-500" aria-hidden="true" />
                <h1 className="text-lg font-semibold">
                  {t('map.heading', { count: overview.totalSkills })}
                </h1>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {(() => {
                  // All non-empty clusters already have a matching scenario →
                  // demote to a quiet "sync" affordance. Still clickable:
                  // re-running merges newly clustered skills into the existing
                  // scenarios (idempotent — never duplicates).
                  const allConverted =
                    overview.clusters.filter((c) => c.skills.length > 0).length > 0 &&
                    overview.clusters
                      .filter((c) => c.skills.length > 0)
                      .every((c) => scenarioKeys.has(scenarioKeyOf(c.name)));
                  return (
                    <Button
                      size="sm"
                      variant={allConverted ? 'outline' : 'ai'}
                      onClick={() => convertAllClusters(overview.clusters)}
                      disabled={generating || convertingAll || overview.clusters.length === 0}
                      title={allConverted ? t('map.convertAll.synced.title') : t('map.convertAll.title')}
                    >
                      {convertingAll ? (
                        <>
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          {t('map.convertAll.converting')}
                        </>
                      ) : allConverted ? (
                        <>
                          <Check className="mr-1.5 h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                          {t('map.convertAll.synced')}
                        </>
                      ) : (
                        <>
                          <Layers className="mr-1.5 h-3.5 w-3.5" />
                          {t('map.convertAll')}
                        </>
                      )}
                    </Button>
                  );
                })()}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={generate}
                  disabled={generating || convertingAll}
                  title={t('map.regenerate.title', {
                    when: formatRelative(overview.generatedAt),
                    model: overview.model,
                  })}
                >
                  {generating ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      {t('map.regenerating')}
                    </>
                  ) : (
                    <>
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      {t('map.regenerate')}
                    </>
                  )}
                </Button>
              </div>
            </div>
            {overview.intro && (
              <p className="text-sm text-muted-foreground">{overview.intro}</p>
            )}
            <p className="text-[11px] text-muted-foreground">
              {t('map.metadata', {
                when: formatRelative(overview.generatedAt),
                model: overview.model,
              })}
            </p>
          </header>

          {/* Clusters */}
          <div className="space-y-5">
            {overview.clusters.map((c) => {
              const isConverting = converting.has(c.key);
              const alreadyScenario = scenarioKeys.has(scenarioKeyOf(c.name));
              return (
                <section key={c.key} className="rounded-lg border bg-card p-4">
                  <header className="mb-2 flex items-center gap-2">
                    <h2 className="text-sm font-semibold">{c.name}</h2>
                    <span className="text-[11px] text-muted-foreground">
                      {t('map.cluster.count', { count: c.skills.length })}
                    </span>
                    {/* AI Lens's sole write entry. Outline button keeps it
                        visually quieter than a primary action (this is still
                        a "lens" view, after all), but visible enough that
                        users find it on their second look. Once a matching
                        scenario exists the button says so — clicking again
                        merges newly clustered skills in (never duplicates),
                        so it stays enabled as a "sync". */}
                    <button
                      type="button"
                      onClick={() => convertCluster(c)}
                      disabled={isConverting || c.skills.length === 0}
                      title={alreadyScenario ? t('map.cluster.sync.title') : t('map.cluster.convert.title')}
                      className={cn(
                        'ml-auto inline-flex h-6 items-center gap-1 border border-input bg-background px-2 text-[11px] transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                        alreadyScenario ? 'text-muted-foreground' : 'text-foreground',
                      )}
                    >
                      {isConverting ? (
                        <>
                          <Loader2 className="h-3 w-3 animate-spin" />
                          {t('map.cluster.converting')}
                        </>
                      ) : alreadyScenario ? (
                        <>
                          <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                          {t('map.cluster.sync')}
                        </>
                      ) : (
                        <>
                          <Plus className="h-3 w-3" />
                          {t('map.cluster.convert')}
                        </>
                      )}
                    </button>
                  </header>
                  {c.purpose && (
                    <p className="mb-3 text-xs text-muted-foreground">{c.purpose}</p>
                  )}
                  <ul className="space-y-1">
                    {c.skills.map((s) => (
                      <SkillRow key={s.skillId} entry={s} onClick={() => onSelectSkill(s.skillId)} />
                    ))}
                  </ul>
                </section>
              );
            })}

            {/* Uncategorized: shown as its own section ONLY if non-empty.
                It's not a normal cluster — it's a "the AI didn't fit these"
                signal. Often empty after a fresh generation. */}
            {overview.uncategorized.length > 0 && (
              <section className="rounded-lg border border-dashed bg-muted/20 p-4">
                <header className="mb-2 flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-muted-foreground">
                    {t('map.uncategorized.heading')}
                  </h2>
                  <span className="text-[11px] text-muted-foreground">
                    {t('map.cluster.count', { count: overview.uncategorized.length })}
                  </span>
                </header>
                <p className="mb-3 text-xs text-muted-foreground">
                  {t('map.uncategorized.body')}
                </p>
                <ul className="space-y-1">
                  {overview.uncategorized.map((s) => (
                    <SkillRow key={s.skillId} entry={s} onClick={() => onSelectSkill(s.skillId)} />
                  ))}
                </ul>
              </section>
            )}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SkillRow({
  entry,
  onClick,
}: {
  entry: { skillId: string; name: string; brief: string };
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-baseline gap-3 rounded px-2 py-1 text-left text-sm hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title={entry.name}
      >
        <span className="min-w-0 flex-1 truncate font-medium">{entry.name}</span>
        <span className="shrink-0 max-w-[40%] truncate text-xs text-muted-foreground">
          {entry.brief}
        </span>
      </button>
    </li>
  );
}

function StaleBanner({
  generating,
  onRefresh,
}: {
  generating: boolean;
  onRefresh: () => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-3 border-b border-amber-200/60 bg-amber-50/60 px-4 py-2 text-sm dark:border-amber-900/40 dark:bg-amber-950/20">
      {/* RefreshCw, not Sparkles — this is a staleness warning; sparkles are
          reserved for AI-invoking actions, and amber sparkles double-booked
          the warning color onto the AI icon. */}
      <RefreshCw className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
      <span className="flex-1 text-amber-900 dark:text-amber-200">
        {t('map.stale.message')}
      </span>
      <Button size="sm" variant="outline" onClick={onRefresh} disabled={generating}>
        {generating ? (
          <>
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            {t('map.regenerating')}
          </>
        ) : (
          <>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            {t('map.stale.refresh')}
          </>
        )}
      </Button>
    </div>
  );
}

function EmptyState({
  generating,
  error,
  onGenerate,
}: {
  generating: boolean;
  error: string | null;
  onGenerate: () => void;
}) {
  const t = useT();
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="max-w-md text-center">
        <MapIcon className="mx-auto h-10 w-10 text-violet-500" aria-hidden="true" />
        <h2 className="mt-3 text-base font-semibold">{t('map.empty.title')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('map.empty.body')}</p>
        <Button
          size="sm"
          variant="ai"
          onClick={onGenerate}
          disabled={generating}
          className="mt-4"
        >
          {generating ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              {t('map.empty.generating')}
            </>
          ) : (
            <>
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              {t('map.empty.generate')}
            </>
          )}
        </Button>
        {error && (
          <p className="mt-3 inline-flex items-center gap-1 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5" /> {error}
          </p>
        )}
      </div>
    </div>
  );
}

function LlmGate({ onOpenAiSettings }: { onOpenAiSettings?: () => void }) {
  const t = useT();
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="max-w-md text-center">
        <Sparkles className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden="true" />
        <h2 className="mt-3 text-base font-semibold">{t('map.llmRequired.title')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('map.llmRequired.body')}</p>
        {onOpenAiSettings && (
          <Button size="sm" variant="outline" onClick={onOpenAiSettings} className="mt-4">
            {t('map.llmRequired.openSettings')}
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function messageOf(err: unknown): string {
  if (!err) return 'Unknown error';
  if (typeof err === 'object' && err !== null) {
    const e = err as { message?: string; code?: string };
    if (e.message) return e.message;
    if (e.code) return e.code;
  }
  return err instanceof Error ? err.message : String(err);
}

// Re-export the prop typing helper so workspace can know the Skill shape if
// needed for future plumbing.
export type { Skill };
