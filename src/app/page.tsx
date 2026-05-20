'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { AppStats, Platform, Scenario, Skill, SkillFilter } from '@shared/types';
import { api } from '@/lib/api';
import { Sidebar, type WorkspaceView } from '@/components/sidebar';
import { SkillList } from '@/components/skill-list';
import { SkillDetail } from '@/components/skill-detail';
import { ScenarioForm } from '@/components/scenario-form';
import { CoverageView } from '@/components/coverage-view';
import { DiscoverView, ModeSegmented, type SearchMode } from '@/components/discover-view';
import { OnboardingWizard } from '@/components/onboarding';
import { BulkCategorizeDialog } from '@/components/bulk-categorize-dialog';
import { useT } from '@/lib/i18n';

export default function Workspace() {
  const t = useT();
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [stats, setStats] = useState<AppStats | null>(null);
  const [view, setView] = useState<WorkspaceView>('matrix');
  const [filter, setFilter] = useState<SkillFilter>({ scope: 'all' });
  const [search, setSearch] = useState('');
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scenarioFormOpen, setScenarioFormOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [bridgeReady, setBridgeReady] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // Onboarding state:
  //   null  → unknown (still resolving — don't flash either UI)
  //   true  → completed previously, hide wizard
  //   false → first launch, show wizard
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null);
  // Bulk-categorize is only enabled when an LLM key is present. Read at
  // bridge-ready time and refreshed after the dialog applies (in case user
  // changes settings or the apply flow created scenarios).
  const [llmConfigured, setLlmConfigured] = useState(false);
  const [bulkCatOpen, setBulkCatOpen] = useState(false);
  // Discover mode lives at the workspace level so the Keyword/AI toggle
  // can render in the page header next to the search input (grouped with
  // the search affordance instead of buried in the status row).
  const [discoverMode, setDiscoverMode] = useState<SearchMode>('keyword');
  // Whether AI search is usable: API key stored AND search feature enabled.
  // Used to disable the AI tab in the header toggle.
  const [aiSearchAvailable, setAiSearchAvailable] = useState(false);

  const reqIdRef = useRef(0);

  const effectiveFilter = useMemo<SkillFilter>(
    () => ({ ...filter, search: search.trim() || undefined }),
    [filter, search],
  );

  const refreshSkills = useCallback(async () => {
    if (!bridgeReady) return;
    if (view !== 'list') return; // matrix view fetches its own data
    const myReq = ++reqIdRef.current;
    setSkillsLoading(true);
    try {
      const list = await api.skills.list(effectiveFilter);
      if (reqIdRef.current === myReq) setSkills(list);
    } catch (e) {
      if (reqIdRef.current === myReq) setSkills([]);
      console.error('skills.list failed', e);
    } finally {
      if (reqIdRef.current === myReq) setSkillsLoading(false);
    }
  }, [bridgeReady, effectiveFilter, view]);

  const refreshMeta = useCallback(async () => {
    if (!bridgeReady) return;
    try {
      const [pls, scs, st] = await Promise.all([
        api.platforms.list(),
        api.scenarios.list(),
        api.settings.stats(),
      ]);
      setPlatforms(pls);
      setScenarios(scs);
      setStats(st);
    } catch (e) {
      console.error('meta refresh failed', e);
    }
  }, [bridgeReady]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.myskills) {
      setBridgeReady(true);
      return;
    }
    const tt = setInterval(() => {
      if (window.myskills) {
        setBridgeReady(true);
        clearInterval(tt);
      }
    }, 50);
    return () => clearInterval(tt);
  }, []);

  useEffect(() => {
    if (!bridgeReady) return;
    refreshMeta();
  }, [bridgeReady, refreshMeta]);

  // Check LLM availability for two consumers:
  //   - bulk-categorize CTA (requires any LLM key configured)
  //   - Discover AI mode (requires key AND the AI-search feature toggle)
  // Single round trip on bridge-ready; both consumers read different
  // booleans off the same fetch.
  useEffect(() => {
    if (!bridgeReady) return;
    let cancelled = false;
    Promise.all([
      api.llm.getConfig().catch(() => null),
      api.llm.getFeatures().catch(() => null),
    ]).then(([cfg, features]) => {
      if (cancelled) return;
      const configured = Boolean(cfg?.hasApiKey && cfg?.model);
      setLlmConfigured(configured);
      setAiSearchAvailable(configured && Boolean(features?.search));
    });
    return () => {
      cancelled = true;
    };
  }, [bridgeReady]);

  // Resolve onboarding completion on first render. Re-resolves whenever the
  // bridge becomes ready (e.g. window restart after a settings reset).
  useEffect(() => {
    if (!bridgeReady) return;
    let cancelled = false;
    api.settings
      .get('onboarding_completed_at')
      .then((v) => {
        if (!cancelled) setOnboardingDone(v != null && v !== '');
      })
      .catch(() => {
        // If we can't tell, assume done — never block the workspace on a
        // setting read failure.
        if (!cancelled) setOnboardingDone(true);
      });
    return () => {
      cancelled = true;
    };
  }, [bridgeReady]);

  useEffect(() => {
    refreshSkills();
  }, [refreshSkills]);

  useEffect(() => {
    if (!bridgeReady) return;
    const offStart = api.on.scanStarted(() => setScanning(true));
    const offEnd = api.on.scanFinished(() => {
      setScanning(false);
      refreshSkills();
      refreshMeta();
    });
    return () => {
      offStart();
      offEnd();
    };
  }, [bridgeReady, refreshSkills, refreshMeta]);

  const runScan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    try {
      await api.scan.run();
    } finally {
      setScanning(false);
    }
  }, [scanning]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }

  const headerTitle =
    view === 'matrix'
      ? t('header.coverage')
      : view === 'discover'
      ? t('header.discover')
      : titleForListFilter(filter, platforms, scenarios, t);

  const searchPlaceholder =
    view === 'matrix'
      ? t('app.search.matrix.placeholder')
      : view === 'discover'
      ? t('app.search.discover.placeholder')
      : t('app.search.placeholder');

  return (
    <main className="flex h-screen w-screen overflow-hidden">
      <Sidebar
        view={view}
        onSelectCoverage={() => {
          setView('matrix');
          setSelectedId(null);
        }}
        onSelectDiscover={() => {
          setView('discover');
          setSelectedId(null);
        }}
        filter={filter}
        onFilterChange={(f) => {
          setView('list');
          setFilter(f);
          setSelectedId(null);
        }}
        platforms={platforms}
        scenarios={scenarios}
        stats={stats}
        onCreateScenario={() => setScenarioFormOpen(true)}
        onRescan={runScan}
        scanning={scanning}
      />

      <div className="flex flex-1 min-w-0 flex-col">
        <header className="titlebar-drag flex h-12 shrink-0 items-center gap-3 border-b pr-3">
          {/* Reserve room for macOS traffic lights */}
          <div className="w-[68px]" />
          <div className="titlebar-no-drag flex flex-1 items-center gap-3">
            <h1 className="text-sm font-semibold">{headerTitle}</h1>
            <div className="ml-auto flex items-center gap-2">
              {view === 'discover' && (
                <ModeSegmented
                  mode={discoverMode}
                  aiAvailable={aiSearchAvailable}
                  queryReady={search.trim().length >= 2}
                  onChange={setDiscoverMode}
                />
              )}
              <div className="relative w-[280px]">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={searchPlaceholder}
                  aria-label={searchPlaceholder}
                  className="h-7 w-full rounded-md border bg-background pl-8 pr-7 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    aria-label={t('common.clear')}
                    className="absolute right-1 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span aria-hidden="true" className="text-[14px] leading-none">×</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </header>

        {view === 'matrix' ? (
          <CoverageView
            outerFilter={effectiveFilter}
            onToast={showToast}
            onSelectSkill={setSelectedId}
            selectedSkillId={selectedId}
            onMutated={refreshMeta}
          />
        ) : view === 'discover' ? (
          <DiscoverView
            query={search}
            mode={discoverMode}
            onModeChange={setDiscoverMode}
            aiAvailable={aiSearchAvailable}
            onToast={showToast}
          />
        ) : (
          <>
            {/* Bulk-categorize CTA — only shows on the 未分类 view, when
                LLM is configured, and when there's at least one skill to
                categorize. Disabled states use a muted bar with a hint
                instead of a button to keep the affordance discoverable. */}
            {filter.scope === 'unscenarized' && (
              <BulkCatBanner
                count={skills.length}
                llmConfigured={llmConfigured}
                onClick={() => setBulkCatOpen(true)}
                t={t}
              />
            )}
            <SkillList
              skills={skills}
              loading={skillsLoading}
              selectedId={selectedId}
              onSelect={setSelectedId}
              search={search}
              onSearchChange={setSearch}
              title={titleForListFilter(filter, platforms, scenarios, t)}
              subtitle={t('list.subtitle.count', { count: skills.length })}
              hideOwnHeader
            />
          </>
        )}
      </div>

      {selectedId && (
        <SkillDetail
          skillId={selectedId}
          scenarios={scenarios}
          onClose={() => setSelectedId(null)}
          onMutated={() => {
            refreshSkills();
            refreshMeta();
          }}
        />
      )}

      <ScenarioForm
        open={scenarioFormOpen}
        onOpenChange={setScenarioFormOpen}
        onSaved={refreshMeta}
      />

      {toast && (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 flex justify-center">
          <div className="pointer-events-auto rounded-md border bg-card px-4 py-2 text-sm shadow-lg">
            {toast}
          </div>
        </div>
      )}

      {onboardingDone === false && (
        <OnboardingWizard
          onDone={() => {
            setOnboardingDone(true);
            // Re-pull platforms/scenarios/stats — wizard may have enabled
            // platforms or changed the canonical, so the workspace needs
            // to re-render with the new context.
            refreshMeta();
          }}
        />
      )}

      <BulkCategorizeDialog
        open={bulkCatOpen}
        skillIds={bulkCatOpen ? skills.map((s) => s.id) : []}
        scenarios={scenarios}
        onOpenChange={setBulkCatOpen}
        onApplied={(r) => {
          showToast(
            t('bulkCat.applied', {
              created: r.newScenariosCreated,
              linked: r.assignmentsApplied,
            }),
          );
          refreshSkills();
          refreshMeta();
        }}
      />
    </main>
  );
}

/**
 * CTA bar shown above the SkillList in the 未分类 view. Three states:
 *   - LLM configured + skills present → primary button
 *   - LLM configured + no skills      → muted "nothing to categorize"
 *   - LLM unconfigured                → muted hint pointing to Settings
 */
function BulkCatBanner({
  count,
  llmConfigured,
  onClick,
  t,
}: {
  count: number;
  llmConfigured: boolean;
  onClick: () => void;
  t: ReturnType<typeof useT>;
}) {
  if (count === 0) {
    return (
      <div className="border-b bg-secondary/30 px-4 py-2 text-xs text-muted-foreground">
        ⊘ {t('bulkCat.disabled.empty')}
      </div>
    );
  }
  if (!llmConfigured) {
    return (
      <div className="border-b bg-secondary/30 px-4 py-2 text-xs text-muted-foreground">
        ⚙︎ {t('bulkCat.disabled.noAi')}
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-3 border-b bg-violet-50/50 px-4 py-2.5 dark:bg-violet-950/20">
      <div className="min-w-0 flex-1">
        <p className="text-[11px] text-muted-foreground">
          {t('bulkCat.helper')}
        </p>
      </div>
      {/* Solid violet button so the CTA reads unambiguously as actionable.
          The earlier text-only link form blended with the helper copy. */}
      <button
        onClick={onClick}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-violet-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-1"
      >
        ✨ {t('bulkCat.cta', { count })}
      </button>
    </div>
  );
}

function titleForListFilter(
  filter: SkillFilter,
  platforms: Platform[],
  scenarios: Scenario[],
  t: ReturnType<typeof useT>,
): string {
  if (filter.scenarioId != null) {
    return scenarios.find((s) => s.id === filter.scenarioId)?.name ?? t('header.scenario');
  }
  if (filter.platforms?.length === 1) {
    return platforms.find((p) => p.id === filter.platforms![0])?.label ?? t('header.platform');
  }
  switch (filter.scope) {
    case 'broken':
      return t('header.scope.broken');
    case 'duplicate':
      return t('header.scope.duplicate');
    case 'unscenarized':
      return t('header.scope.unscenarized');
    case 'disabled':
      return t('header.scope.disabled');
    default:
      return t('header.scope.all');
  }
}
