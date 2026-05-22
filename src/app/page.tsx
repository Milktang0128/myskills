'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutList, Columns3, Search, Sparkles } from 'lucide-react';
import type { AppStats, Platform, Scenario, Skill, SkillFilter } from '@shared/types';
import { api } from '@/lib/api';
import { Sidebar, type SidebarView } from '@/components/sidebar';
import { SkillList } from '@/components/skill-list';
import { SkillDetail } from '@/components/skill-detail';
import { ScenarioForm } from '@/components/scenario-form';
import { CoverageView } from '@/components/coverage-view';
import { DiscoverView, ModeSegmented, type SearchMode } from '@/components/discover-view';
import { LibraryMapView } from '@/components/library-map-view';
import { KanbanView } from '@/components/kanban-view';
import { OnboardingWizard } from '@/components/onboarding';
import { BulkCategorizeDialog } from '@/components/bulk-categorize-dialog';
import { HistoryView } from '@/components/history-view';
import { ScenariosView } from '@/components/scenarios-view';
import { Toast } from '@/components/ui/toast';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * The Library section has three sub-views, picked via the sub-toolbar above
 * the content area. They are PEERS, not a nav hierarchy:
 *   - list:    the daily-driver flat table
 *   - kanban:  user-curated grouping (scenarios as columns)
 *   - ai-lens: AI-generated clustering (read-only commentary on the library)
 *
 * The sub-toolbar is only meaningful when filter is at default. As soon as
 * the user picks a scope/scenario/platform, libraryView is forced back to
 * 'list' for that filtered slice — the alternative groupings don't help
 * when you've already narrowed to a subset.
 */
type LibraryView = 'list' | 'kanban' | 'ai-lens';

export default function Workspace() {
  const t = useT();
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [stats, setStats] = useState<AppStats | null>(null);
  const [sidebarView, setSidebarView] = useState<SidebarView>('matrix');
  const [libraryView, setLibraryView] = useState<LibraryView>('list');
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
  // Bulk-categorize is only enabled when an LLM key is present.
  const [llmConfigured, setLlmConfigured] = useState(false);
  const [bulkCatOpen, setBulkCatOpen] = useState(false);
  const [discoverMode, setDiscoverMode] = useState<SearchMode>('keyword');
  const [aiSearchAvailable, setAiSearchAvailable] = useState(false);

  const reqIdRef = useRef(0);

  // Filter is "at default" when nothing's been narrowed — all scope + no
  // scenario + no platform. The sub-toolbar only renders in this state; any
  // narrowing forces the user into the list (kanban/lens don't help slices).
  const isFilterDefault = useMemo(
    () =>
      (filter.scope ?? 'all') === 'all' &&
      filter.scenarioId == null &&
      (filter.platforms?.length ?? 0) === 0,
    [filter],
  );

  // What the library currently renders. Falls back to list when filter is
  // narrowed, regardless of what the user previously picked in the toolbar.
  const effectiveLibraryView: LibraryView = isFilterDefault ? libraryView : 'list';

  const effectiveFilter = useMemo<SkillFilter>(
    () => ({ ...filter, search: search.trim() || undefined }),
    [filter, search],
  );

  // Skills fetch covers both list and kanban (both consume the flat list and
  // present it differently). Matrix fetches its own data via CoverageView;
  // ai-lens fetches the overview snapshot via LibraryMapView.
  const needsSkillsFetch =
    sidebarView === 'library' && effectiveLibraryView !== 'ai-lens';

  const refreshSkills = useCallback(async () => {
    if (!bridgeReady) return;
    if (!needsSkillsFetch) return;
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
  }, [bridgeReady, effectiveFilter, needsSkillsFetch]);

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

  useEffect(() => {
    if (!bridgeReady) return;
    let cancelled = false;
    api.settings
      .get('onboarding_completed_at')
      .then((v) => {
        if (!cancelled) setOnboardingDone(v != null && v !== '');
      })
      .catch(() => {
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
  }

  // Header title resolves through (sidebarView, libraryView) rather than the
  // old flat WorkspaceView. AI Lens replaces the old 'map' title; the i18n
  // key was already renamed.
  const headerTitle = (() => {
    if (sidebarView === 'matrix') return t('header.coverage');
    if (sidebarView === 'discover') return t('header.discover');
    if (sidebarView === 'history') return t('header.history');
    if (sidebarView === 'scenarios') return t('header.scenarios');
    if (effectiveLibraryView === 'ai-lens') return t('header.aiLens');
    if (effectiveLibraryView === 'kanban') return t('header.kanban');
    return titleForListFilter(filter, platforms, scenarios, t);
  })();

  const searchPlaceholder =
    sidebarView === 'matrix'
      ? t('app.search.matrix.placeholder')
      : sidebarView === 'discover'
      ? t('app.search.discover.placeholder')
      : t('app.search.placeholder');

  // Search input is hidden on views that have nothing to filter from it:
  //   - AI Lens has its own regenerate affordance, no list
  //   - History entries / Scenarios aren't skills, so the global search
  //     (wired to api.skills.list) doesn't apply
  const showSearchInput =
    sidebarView !== 'history' &&
    sidebarView !== 'scenarios' &&
    !(sidebarView === 'library' && effectiveLibraryView === 'ai-lens');

  // Sub-toolbar — Library only, and only when filter is at default.
  const showSubToolbar = sidebarView === 'library' && isFilterDefault;

  return (
    <main className="flex h-screen w-screen overflow-hidden">
      <Sidebar
        view={sidebarView}
        onSelectAllSkills={() => {
          setSidebarView('library');
          setFilter({ scope: 'all' });
          setSelectedId(null);
        }}
        onSelectCoverage={() => {
          setSidebarView('matrix');
          setSelectedId(null);
        }}
        onSelectDiscover={() => {
          setSidebarView('discover');
          setSelectedId(null);
        }}
        filter={filter}
        onFilterChange={(f) => {
          setSidebarView('library');
          setFilter(f);
          setSelectedId(null);
        }}
        platforms={platforms}
        scenarios={scenarios}
        stats={stats}
        onCreateScenario={() => setScenarioFormOpen(true)}
        onSelectScenarios={() => {
          setSidebarView('scenarios');
          setSelectedId(null);
        }}
        onSelectHistory={() => {
          setSidebarView('history');
          setSelectedId(null);
        }}
        onRescan={runScan}
        scanning={scanning}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Drag-region rule: the whole header is `-webkit-app-region: drag` so
            the user can grab any empty space — title text, padding, gaps — to
            move the window. Only the interactive cluster on the right opts
            OUT via `titlebar-no-drag`. The earlier version wrapped the entire
            inner row in no-drag, leaving only the 68px traffic-light spacer
            draggable, which produced the "sometimes works" feeling. */}
        <header className="titlebar-drag flex h-12 shrink-0 items-center gap-3 border-b pr-3">
          {/* Reserve room for macOS traffic lights */}
          <div className="w-[68px]" />
          <h1 className="text-sm font-semibold">{headerTitle}</h1>
          <div className="titlebar-no-drag ml-auto flex items-center gap-2">
            {sidebarView === 'discover' && (
              <ModeSegmented
                mode={discoverMode}
                aiAvailable={aiSearchAvailable}
                queryReady={search.trim().length >= 2}
                onChange={setDiscoverMode}
              />
            )}
            {showSearchInput && (
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
                  className="h-7 w-full border bg-background pl-8 pr-7 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    aria-label={t('common.clear')}
                    className="absolute right-1 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span aria-hidden="true" className="text-[14px] leading-none">×</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </header>

        {showSubToolbar && (
          <LibrarySubToolbar
            value={libraryView}
            onChange={(v) => {
              setLibraryView(v);
              setSelectedId(null);
            }}
            totalCount={stats?.totalSkills ?? 0}
            scenarioCount={scenarios.length}
            platformCount={platforms.length}
          />
        )}

        {sidebarView === 'matrix' ? (
          <CoverageView
            outerFilter={effectiveFilter}
            onToast={showToast}
            onSelectSkill={setSelectedId}
            selectedSkillId={selectedId}
            onMutated={refreshMeta}
          />
        ) : sidebarView === 'discover' ? (
          <DiscoverView
            query={search}
            mode={discoverMode}
            onModeChange={setDiscoverMode}
            aiAvailable={aiSearchAvailable}
            onToast={showToast}
          />
        ) : sidebarView === 'history' ? (
          <HistoryView />
        ) : sidebarView === 'scenarios' ? (
          <ScenariosView onChanged={refreshMeta} />
        ) : effectiveLibraryView === 'ai-lens' ? (
          <LibraryMapView
            onSelectSkill={setSelectedId}
            llmConfigured={llmConfigured}
            onScenariosChanged={refreshMeta}
            onToast={showToast}
          />
        ) : effectiveLibraryView === 'kanban' ? (
          <KanbanView
            skills={skills}
            scenarios={scenarios}
            loading={skillsLoading}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onOpenAiLens={() => setLibraryView('ai-lens')}
          />
        ) : (
          <>
            {/* Bulk-categorize CTA — only shows on the 未分类 view, when
                LLM is configured, and when there's at least one skill to
                categorize. */}
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
        <Toast message={toast} onDismiss={() => setToast(null)} />
      )}

      {onboardingDone === false && (
        <OnboardingWizard
          onDone={() => {
            setOnboardingDone(true);
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
 * Three-way library sub-view switcher. Only renders when the user is in the
 * Library section and the filter is at default. Mirrors the redesign's
 * 看板/列表 segmented control, extended with AI Lens as a third peer.
 */
function LibrarySubToolbar({
  value,
  onChange,
  totalCount,
  scenarioCount,
  platformCount,
}: {
  value: LibraryView;
  onChange: (v: LibraryView) => void;
  totalCount: number;
  scenarioCount: number;
  platformCount: number;
}) {
  const t = useT();
  const items: { id: LibraryView; label: string; icon: React.ReactNode }[] = [
    { id: 'list', label: t('libraryView.list'), icon: <LayoutList className="h-3.5 w-3.5" /> },
    { id: 'kanban', label: t('libraryView.kanban'), icon: <Columns3 className="h-3.5 w-3.5" /> },
    { id: 'ai-lens', label: t('libraryView.aiLens'), icon: <Sparkles className="h-3.5 w-3.5" /> },
  ];
  return (
    <div className="flex shrink-0 items-center gap-1.5 px-6 pt-3">
      <div className="flex items-center gap-0.5 bg-secondary p-0.5">
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            onClick={() => onChange(it.id)}
            className={cn(
              'inline-flex h-6 items-center gap-1 whitespace-nowrap px-2.5 text-[11.5px] transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              value === it.id
                ? 'bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {it.icon}
            {it.label}
          </button>
        ))}
      </div>
      <div className="ml-2 whitespace-nowrap text-[11.5px] text-muted-foreground">
        {t('libraryView.summary', {
          skills: totalCount,
          platforms: platformCount,
          scenarios: scenarioCount,
        })}
      </div>
    </div>
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
      <button
        onClick={onClick}
        className="inline-flex shrink-0 items-center gap-1.5 bg-violet-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-violet-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-1"
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
