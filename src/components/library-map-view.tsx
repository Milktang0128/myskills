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
import { useCallback, useEffect, useState } from 'react';
import {
  Sparkles,
  RefreshCw,
  AlertCircle,
  Loader2,
  Map as MapIcon,
} from 'lucide-react';
import type { LibraryOverview, LibraryOverviewSnapshot, Skill } from '@shared/types';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { api } from '@/lib/api';
import { useT, useI18n } from '@/lib/i18n';
import { formatRelative } from '@/lib/utils';

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
}

export function LibraryMapView({ onSelectSkill, llmConfigured }: Props) {
  const t = useT();
  const { locale } = useI18n();
  const lang: 'zh' | 'en' = locale;
  const [snapshot, setSnapshot] = useState<LibraryOverviewSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bridgeReady, setBridgeReady] = useState(false);

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

  async function generate(): Promise<void> {
    setGenerating(true);
    setError(null);
    try {
      const fresh = await api.ai.libraryOverviewGenerate(lang);
      // Re-pull the snapshot so the stale flag + currentSetHash refresh.
      const snap = await api.ai.libraryOverviewGet(lang);
      setSnapshot({ ...snap, overview: fresh });
    } catch (err) {
      setError(messageOf(err));
    } finally {
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
    return <LlmGate />;
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
    <div className="flex min-h-0 flex-1 flex-col">
      {stale && <StaleBanner generating={generating} onRefresh={generate} />}
      {error && (
        <div className="flex items-center gap-2 border-b border-red-brand/40 bg-[rgba(225,70,43,0.05)] px-4 py-2 font-mono text-[11px] uppercase tracking-[0.06em] text-red-brand">
          <AlertCircle className="h-3 w-3 shrink-0" />
          <span className="flex-1">{error}</span>
        </div>
      )}

      <ScrollArea className="flex-1 scrollbar-thin">
        <div className="mx-auto max-w-3xl space-y-7 px-7 py-7">
          {/* Page header — kicker + CN H1 + intro + metadata caps */}
          <header>
            <div className="tk flex items-center gap-2">
              <MapIcon className="h-3 w-3 text-red-brand" aria-hidden="true" />
              MAP · {t('header.map').toUpperCase()}
            </div>
            <div className="mt-2 flex items-start justify-between gap-3">
              <h1 className="t-cn-h1">{t('map.heading', { count: overview.totalSkills })}</h1>
              <Button
                size="sm"
                variant="outline"
                onClick={generate}
                disabled={generating}
                title={t('map.regenerate.title', {
                  when: formatRelative(overview.generatedAt),
                  model: overview.model,
                })}
              >
                {generating ? (
                  <>
                    <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                    {t('map.regenerating')}
                  </>
                ) : (
                  <>
                    <RefreshCw className="mr-1.5 h-3 w-3" />
                    {t('map.regenerate')}
                  </>
                )}
              </Button>
            </div>
            {overview.intro && (
              <p className="mt-3 text-[13.5px] leading-[1.6] text-soft max-w-[56ch]">{overview.intro}</p>
            )}
            <p className="mt-3 font-mono text-[10px] uppercase tracking-[var(--wide)] text-mute">
              {t('map.metadata', {
                when: formatRelative(overview.generatedAt),
                model: overview.model,
              })}
            </p>
          </header>

          <div className="space-y-6">
            {overview.clusters.map((c) => (
              <section key={c.key} className="border-t border-rule pt-4">
                <header className="mb-2 flex items-baseline justify-between gap-3">
                  <h2 className="t-cn text-[18px] leading-tight">{c.name}</h2>
                  <span className="font-mono text-[10px] uppercase tracking-[var(--wide)] text-mute shrink-0">
                    {t('map.cluster.count', { count: c.skills.length })}
                  </span>
                </header>
                {c.purpose && (
                  <p className="mb-3 text-[12.5px] leading-[1.55] text-soft max-w-[56ch]">{c.purpose}</p>
                )}
                <ul className="space-y-0">
                  {c.skills.map((s) => (
                    <SkillRow key={s.skillId} entry={s} onClick={() => onSelectSkill(s.skillId)} />
                  ))}
                </ul>
              </section>
            ))}

            {overview.uncategorized.length > 0 && (
              <section className="border-t border-dashed border-rule pt-4">
                <header className="mb-2 flex items-baseline justify-between gap-3">
                  <h2 className="t-cn text-[18px] leading-tight text-mute">
                    {t('map.uncategorized.heading')}
                  </h2>
                  <span className="font-mono text-[10px] uppercase tracking-[var(--wide)] text-mute shrink-0">
                    {t('map.cluster.count', { count: overview.uncategorized.length })}
                  </span>
                </header>
                <p className="mb-3 text-[12.5px] leading-[1.55] text-soft max-w-[56ch]">
                  {t('map.uncategorized.body')}
                </p>
                <ul className="space-y-0">
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
        className="flex w-full items-baseline gap-3 border-l-2 border-l-transparent px-2 py-1.5 text-left text-[13px] hover:bg-paper-alt/60 hover:border-l-rule focus-visible:outline-none focus-visible:relative focus-visible:z-10 focus-visible:ring-1 focus-visible:ring-ink"
        title={entry.name}
      >
        <span className="min-w-0 flex-1 truncate font-medium text-ink">{entry.name}</span>
        <span className="shrink-0 max-w-[40%] truncate font-mono text-[10.5px] uppercase tracking-[0.04em] text-mute">
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
    <div className="flex items-center gap-3 border-b border-red-brand/40 bg-[rgba(225,70,43,0.04)] px-4 py-2.5">
      <Sparkles className="h-3.5 w-3.5 shrink-0 text-red-brand" aria-hidden="true" />
      <span className="flex-1 font-mono text-[11px] uppercase tracking-[0.06em] text-ink">
        {t('map.stale.message')}
      </span>
      <Button size="sm" variant="outline" onClick={onRefresh} disabled={generating}>
        {generating ? (
          <>
            <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
            {t('map.regenerating')}
          </>
        ) : (
          <>
            <RefreshCw className="mr-1.5 h-3 w-3" />
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
        <MapIcon className="mx-auto h-9 w-9 text-red-brand" aria-hidden="true" />
        <div className="tk mt-3">MAP</div>
        <h2 className="t-cn-h2 mt-1">{t('map.empty.title')}</h2>
        <p className="mt-3 text-[13.5px] leading-[1.6] text-soft">{t('map.empty.body')}</p>
        <Button onClick={onGenerate} disabled={generating} className="mt-5">
          {generating ? (
            <>
              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
              {t('map.empty.generating')}
            </>
          ) : (
            <>
              <Sparkles className="mr-1.5 h-3 w-3" />
              {t('map.empty.generate')}
            </>
          )}
        </Button>
        {error && (
          <p className="mt-3 inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-[0.06em] text-red-brand">
            <AlertCircle className="h-3 w-3" /> {error}
          </p>
        )}
      </div>
    </div>
  );
}

function LlmGate() {
  const t = useT();
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="max-w-md text-center">
        <Sparkles className="mx-auto h-9 w-9 text-mute" aria-hidden="true" />
        <div className="tk-muted mt-3">SETUP</div>
        <h2 className="t-cn-h2 mt-1">{t('map.llmRequired.title')}</h2>
        <p className="mt-3 text-[13.5px] leading-[1.6] text-soft">{t('map.llmRequired.body')}</p>
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
