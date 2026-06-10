'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutList, Columns3, Search, Sparkles } from 'lucide-react';
import type { AppStats, Platform, Scenario, Skill, SkillFilter, SkillSort } from '@shared/types';
import { api } from '@/lib/api';
import { Sidebar, type SidebarView } from '@/components/sidebar';
import { SkillList } from '@/components/skill-list';
import { SkillDetail } from '@/components/skill-detail';
import { ScenarioForm } from '@/components/scenario-form';
import { CoverageView } from '@/components/coverage-view';
import { DiscoverView, ModeSegmented, type SearchMode } from '@/components/discover-view';
import { LibraryMapView } from '@/components/library-map-view';
import { KanbanView } from '@/components/kanban-view';
import {
  LibraryOverviewGuidance,
  UNSCENARIZED_GUIDANCE_THRESHOLD,
} from '@/components/library-overview-guidance';
import { OnboardingWizard } from '@/components/onboarding';
import { HistoryView } from '@/components/history-view';
import { ScenariosView } from '@/components/scenarios-view';
import { SettingsView } from '@/components/settings-view';
import { CreateSkillView } from '@/components/create-skill/create-skill-view';
import { ToastViewport, type ToastAction, type ToastData } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { useI18n, useT } from '@/lib/i18n';
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
  const { locale } = useI18n();
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [stats, setStats] = useState<AppStats | null>(null);
  // The platform that hosts the main source. Drives sidebar ordering +
  // the crown icon. Sourced from the canonical_platform setting on each
  // refreshMeta; defaults to 'shared'.
  const [canonicalPlatform, setCanonicalPlatform] = useState<string>('shared');
  const [sidebarView, setSidebarView] = useState<SidebarView>('matrix');
  const [libraryView, setLibraryView] = useState<LibraryView>('list');
  const [filter, setFilter] = useState<SkillFilter>({ scope: 'all' });
  const [search, setSearch] = useState('');
  // Discover's query is deliberately SEPARATE from the library/matrix search.
  // Sharing one state meant a leftover library search term auto-fired a
  // remote skills.sh query — or worse, a full LLM rerank pipeline — the
  // moment the user switched to Discover, spending API quota with zero
  // intent. Each view keeps its own input; switching views never re-runs
  // the other view's search.
  const [discoverQuery, setDiscoverQuery] = useState('');
  // Sort lives at the page level (not inside SkillList) so it survives view
  // switches and filter changes — switching from kanban back to list keeps
  // your sort choice.
  //
  // Default is `created` (most-recently-added first): the answer to "what
  // did I just add?" is the question users care about on open. Alphabetical
  // is useful for hunting a known name; that's what search is for.
  const [sort, setSort] = useState<SkillSort>('created');
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scenarioFormOpen, setScenarioFormOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [bridgeReady, setBridgeReady] = useState(false);
  // Small toast stack (max 3) — a single slot let any new toast instantly
  // bury the previous one, which killed the 6s undo window in practice.
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const toastIdRef = useRef(0);
  // Onboarding state:
  //   null  → unknown (still resolving — don't flash either UI)
  //   true  → completed previously, hide wizard
  //   false → first launch, show wizard
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null);
  const [llmConfigured, setLlmConfigured] = useState(false);
  const [discoverMode, setDiscoverMode] = useState<SearchMode>('keyword');
  const [createSeed, setCreateSeed] = useState('');
  const [aiSearchAvailable, setAiSearchAvailable] = useState(false);
  const [createSkillAvailable, setCreateSkillAvailable] = useState(false);
  const [settingsFocusSection, setSettingsFocusSection] = useState<'ai' | 'updates' | null>(null);
  const [frontendSmokeActive, setFrontendSmokeActive] = useState(false);
  // True once a cached library overview exists. Drives the one-shot Day-0
  // guidance card: visible until first AI Lens generation, then silenced.
  const [hasOverviewRun, setHasOverviewRun] = useState(false);

  const reqIdRef = useRef(0);
  const frontendSmokeRanRef = useRef(false);
  const updateCheckRanRef = useRef(false);
  const autoScanRanRef = useRef(false);

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

  // Day-0 nudge above kanban + list. Hides once the user has run AI Lens
  // once (cached overview present), or once enough skills have been tagged.
  const unscenarizedCount = useMemo(
    () => skills.reduce((n, s) => n + (s.scenarios.length === 0 ? 1 : 0), 0),
    [skills],
  );
  const showOverviewGuidance =
    isFilterDefault &&
    !hasOverviewRun &&
    skills.length > 0 &&
    unscenarizedCount / skills.length >= UNSCENARIZED_GUIDANCE_THRESHOLD;

  const effectiveFilter = useMemo<SkillFilter>(
    () => ({ ...filter, search: search.trim() || undefined, sort }),
    [filter, search, sort],
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
      const [pls, scs, st, canonical] = await Promise.all([
        api.platforms.list(),
        api.scenarios.list(),
        api.settings.stats(),
        api.settings.get('canonical_platform'),
      ]);
      setPlatforms(pls);
      setScenarios(scs);
      setStats(st);
      setCanonicalPlatform(canonical ?? 'shared');
    } catch (e) {
      console.error('meta refresh failed', e);
    }
  }, [bridgeReady]);

  const refreshAiAvailability = useCallback(async () => {
    const [cfg, features] = await Promise.all([
      api.llm.getConfig().catch(() => null),
      api.llm.getFeatures().catch(() => null),
    ]);
    const configured = Boolean(cfg?.hasApiKey && cfg?.model && cfg?.connectionOk);
    setLlmConfigured(configured);
    setAiSearchAvailable(configured && Boolean(features?.search));
    setCreateSkillAvailable(configured);
  }, []);

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
    if (!bridgeReady || frontendSmokeActive || updateCheckRanRef.current) return;
    updateCheckRanRef.current = true;
    const id = window.setTimeout(() => {
      api.updates
        .check()
        .then((update) => {
          if (update.available && update.version) {
            showToast(
              t('updates.toast.available', { version: update.version }),
              {
                label: t('updates.toast.action'),
                onClick: () => {
                  setSettingsFocusSection('updates');
                  setSidebarView('settings');
                },
              },
              12000,
            );
          }
        })
        .catch(() => {
          // Background update checks are opportunistic. Settings exposes the
          // explicit check path with visible errors.
        });
    }, 30000);
    return () => window.clearTimeout(id);
  }, [bridgeReady, frontendSmokeActive, t]);

  useEffect(() => {
    if (!bridgeReady) return;
    let cancelled = false;
    api.settings
      .get('smoke.frontend.expected')
      .then(async (expected) => {
        if (cancelled || expected !== '1') return;
        setFrontendSmokeActive(true);
        setOnboardingDone(true);
        await Promise.all([
          api.settings.set('smoke.frontend.ready', '1'),
          api.settings.set('smoke.frontend.view', 'workspace'),
        ]);
      })
      .catch(() => {
        // Internal smoke marker only; normal app startup should ignore failures.
      });
    return () => {
      cancelled = true;
    };
  }, [bridgeReady]);

  useEffect(() => {
    if (!frontendSmokeActive) return;
    if (frontendSmokeRanRef.current) return;
    frontendSmokeRanRef.current = true;
    let cancelled = false;
    const nextCommit = () => new Promise<void>((resolve) => window.setTimeout(resolve, 100));
    const clickSmokeAction = (action: string) => {
      const el = document.querySelector<HTMLButtonElement>(`[data-smoke-action="${action}"]`);
      if (!el) throw new Error(`missing [data-smoke-action="${action}"]`);
      el.click();
    };
    const steps: Array<{
      name: string;
      click: () => void;
      selector: string;
    }> = [
      {
        name: 'matrix',
        click: () => clickSmokeAction('nav-matrix'),
        selector: '[data-smoke-view="matrix"]',
      },
      {
        name: 'library-list',
        click: () => clickSmokeAction('nav-library'),
        selector: '[data-smoke-view="library-list"]',
      },
      {
        name: 'library-kanban',
        click: () => clickSmokeAction('library-kanban'),
        selector: '[data-smoke-view="library-kanban"]',
      },
      {
        name: 'library-ai-lens',
        click: () => clickSmokeAction('library-ai-lens'),
        selector: '[data-smoke-view="library-ai-lens"]',
      },
      {
        name: 'discover',
        click: () => {
          setDiscoverQuery('catalog');
          setDiscoverMode('keyword');
          clickSmokeAction('nav-discover');
        },
        selector: '[data-smoke-view="discover"]',
      },
      {
        name: 'create-skill',
        click: () => clickSmokeAction('nav-create'),
        selector: '[data-smoke-view="create-skill"]',
      },
      {
        name: 'scenarios',
        click: () => clickSmokeAction('nav-scenarios'),
        selector: '[data-smoke-view="scenarios"]',
      },
      {
        name: 'history',
        click: () => clickSmokeAction('nav-history'),
        selector: '[data-smoke-view="history"]',
      },
      {
        name: 'settings',
        click: () => clickSmokeAction('nav-settings'),
        selector: '[data-smoke-view="settings"]',
      },
    ];
    async function runSmoke() {
      const seen: string[] = [];
      try {
        for (const step of steps) {
          if (cancelled) return;
          step.click();
          await nextCommit();
          if (cancelled) return;
          if (!document.querySelector(step.selector)) {
            throw new Error(`missing ${step.selector}`);
          }
          seen.push(step.name);
        }
        await Promise.all([
          api.settings.set('smoke.frontend.ui.ready', '1'),
          api.settings.set('smoke.frontend.ui.sequence', seen.join(',')),
        ]);
      } catch (err) {
        await api.settings.set(
          'smoke.frontend.ui.error',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    void runSmoke();
    return () => {
      cancelled = true;
    };
  }, [frontendSmokeActive]);

  // Refresh hasOverviewRun whenever the user lands on the library shell in a
  // non-ai-lens sub-view. Covers initial mount AND navigating back from
  // ai-lens (user may have just generated a fresh overview there).
  useEffect(() => {
    if (!bridgeReady) return;
    if (sidebarView !== 'library') return;
    if (effectiveLibraryView === 'ai-lens') return;
    let cancelled = false;
    api.ai
      .libraryOverviewGet(locale)
      .then((snap) => {
        if (!cancelled) setHasOverviewRun(snap.overview !== null);
      })
      .catch(() => {
        // Non-fatal: leaves the guidance card showing.
      });
    return () => {
      cancelled = true;
    };
  }, [bridgeReady, sidebarView, effectiveLibraryView, locale]);

  useEffect(() => {
    if (!bridgeReady) return;
    refreshAiAvailability().catch(() => {
      // Non-fatal: AI-gated surfaces stay disabled.
    });
  }, [bridgeReady, refreshAiAvailability]);

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
    } catch (err) {
      // Without this the sidebar dot just flips back to the green "已扫描"
      // state and a failed scan looks like a successful one.
      showToast(
        t('scan.toast.failed', { message: err instanceof Error ? err.message : String(err) }),
      );
    } finally {
      setScanning(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning, t]);

  useEffect(() => {
    if (!bridgeReady || frontendSmokeActive || onboardingDone !== true || autoScanRanRef.current) return;
    autoScanRanRef.current = true;
    let cancelled = false;
    api.settings
      .get('auto_scan_on_launch')
      .then(async (value) => {
        if (cancelled || value !== '1') return;
        setScanning(true);
        try {
          await api.scan.run();
          if (!cancelled) {
            refreshSkills();
            refreshMeta();
          }
        } catch (error) {
          console.error('auto scan on launch failed', error);
        } finally {
          if (!cancelled) setScanning(false);
        }
      })
      .catch((error) => {
        console.error('auto scan setting lookup failed', error);
      });
    return () => {
      cancelled = true;
    };
  }, [bridgeReady, frontendSmokeActive, onboardingDone, refreshSkills, refreshMeta]);

  function showToast(msg: string, action?: ToastAction, durationMs?: number) {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev.slice(-2), { id, message: msg, action, durationMs }]);
  }

  function dismissToast(id: number) {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }

  const searchPlaceholder =
    sidebarView === 'matrix'
      ? t('app.search.matrix.placeholder')
      : sidebarView === 'discover'
      ? t('app.search.discover.placeholder')
      : t('app.search.placeholder');

  // The header input edits whichever search the current view owns.
  const isDiscoverSearch = sidebarView === 'discover';
  const searchValue = isDiscoverSearch ? discoverQuery : search;
  const setSearchValue = isDiscoverSearch ? setDiscoverQuery : setSearch;

  // Search input is hidden on views that have nothing to filter from it:
  //   - AI Lens has its own regenerate affordance, no list
  //   - History entries / Scenarios aren't skills, so the global search
  //     (wired to api.skills.list) doesn't apply
  const showSearchInput =
    sidebarView !== 'history' &&
    sidebarView !== 'scenarios' &&
    sidebarView !== 'create' &&
    !(sidebarView === 'library' && effectiveLibraryView === 'ai-lens');

  // Sub-toolbar — Library only. When the filter is narrowed the kanban/AI-lens
  // segments are DISABLED (with a hint) rather than the whole bar vanishing —
  // a control that silently disappears reads as a bug, not a rule.
  const showSubToolbar = sidebarView === 'library';

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
        onSelectCreateSkill={() => {
          setSidebarView('create');
          setSelectedId(null);
        }}
        filter={filter}
        onFilterChange={(f) => {
          setSidebarView('library');
          setFilter(f);
          setSelectedId(null);
        }}
        platforms={platforms}
        canonicalPlatform={canonicalPlatform}
        scenarios={scenarios}
        stats={stats}
        scanning={scanning}
        onRunScan={runScan}
        onCreateScenario={() => setScenarioFormOpen(true)}
        onSelectScenarios={() => {
          setSidebarView('scenarios');
          setSelectedId(null);
        }}
        onSelectHistory={() => {
          setSidebarView('history');
          setSelectedId(null);
        }}
        onSelectSettings={() => {
          setSettingsFocusSection(null);
          setSidebarView('settings');
          setSelectedId(null);
        }}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Drag-region rule: the whole header is `-webkit-app-region: drag` so
            the user can grab any empty space — title text, padding, gaps — to
            move the window. Only the interactive cluster on the right opts
            OUT via `titlebar-no-drag`. The earlier version wrapped the entire
            inner row in no-drag, leaving only the 68px traffic-light spacer
            draggable, which produced the "sometimes works" feeling. */}
        <header className="titlebar-drag flex h-12 shrink-0 items-center gap-3 border-b px-3">
          {/* Global status lives in the sidebar titlebar. Keep this side mostly
              empty so it stays a reliable drag surface, with controls grouped
              on the right. */}
          <div className="titlebar-no-drag ml-auto flex items-center gap-2">
            {sidebarView === 'discover' && (
              <ModeSegmented
                mode={discoverMode}
                aiAvailable={aiSearchAvailable}
                queryReady={discoverQuery.trim().length >= 2}
                onChange={setDiscoverMode}
                onRequestAiSetup={() => {
                  setSettingsFocusSection('ai');
                  setSidebarView('settings');
                  setSelectedId(null);
                }}
              />
            )}
            {showSearchInput && (
              <div className="relative w-[280px]">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 shrink-0 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={searchValue}
                  onChange={(e) => setSearchValue(e.target.value)}
                  placeholder={searchPlaceholder}
                  aria-label={searchPlaceholder}
                  className="h-7 w-full border bg-background pl-9 pr-7 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                />
                {searchValue && (
                  <button
                    type="button"
                    onClick={() => setSearchValue('')}
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
            value={effectiveLibraryView}
            restricted={!isFilterDefault}
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
          <div data-smoke-view="matrix" className="contents">
            <CoverageView
              outerFilter={effectiveFilter}
              onToast={showToast}
              onSelectSkill={setSelectedId}
              selectedSkillId={selectedId}
              onMutated={refreshMeta}
              onOpenSettings={() => {
                // Reset any stale deep-link (e.g. a leftover 'ai' focus from
                // Create Skill) so this entry lands at the top of Settings.
                setSettingsFocusSection(null);
                setSidebarView('settings');
                setSelectedId(null);
              }}
              onSelectDiscover={() => {
                setSidebarView('discover');
                setSelectedId(null);
              }}
              onRescan={runScan}
            />
          </div>
        ) : sidebarView === 'discover' ? (
          <div data-smoke-view="discover" className="contents">
            <DiscoverView
              query={discoverQuery}
              mode={discoverMode}
              onModeChange={setDiscoverMode}
              aiAvailable={aiSearchAvailable}
              onToast={showToast}
              onOpenSettings={() => {
                setSettingsFocusSection(null);
                setSidebarView('settings');
                setSelectedId(null);
              }}
            />
          </div>
        ) : sidebarView === 'create' ? (
          <CreateSkillView
            seed={createSeed}
            platforms={platforms}
            scenarios={scenarios}
            canonicalPlatform={canonicalPlatform}
            aiAvailable={createSkillAvailable}
            onToast={showToast}
            onOpenAiSettings={() => {
              setSettingsFocusSection('ai');
              setSidebarView('settings');
              setSelectedId(null);
            }}
            onInstalled={(skillId, name) => {
              setSidebarView('library');
              setFilter({ scope: 'all' });
              setLibraryView('list');
              setSearch(name);
              setSelectedId(skillId);
              refreshMeta();
              refreshSkills();
            }}
          />
        ) : sidebarView === 'history' ? (
          <div data-smoke-view="history" className="contents">
            <HistoryView />
          </div>
        ) : sidebarView === 'scenarios' ? (
          <div data-smoke-view="scenarios" className="contents">
            <ScenariosView onChanged={refreshMeta} />
          </div>
        ) : sidebarView === 'settings' ? (
          <div data-smoke-view="settings" className="contents">
            <SettingsView
              focusSection={settingsFocusSection}
              onChanged={refreshMeta}
              onAiChanged={refreshAiAvailability}
            />
          </div>
        ) : effectiveLibraryView === 'ai-lens' ? (
          <div data-smoke-view="library-ai-lens" className="contents">
            <LibraryMapView
              onSelectSkill={setSelectedId}
              llmConfigured={llmConfigured}
              onScenariosChanged={refreshMeta}
              onToast={showToast}
              onOpenAiSettings={() => {
                setSettingsFocusSection('ai');
                setSidebarView('settings');
                setSelectedId(null);
              }}
            />
          </div>
        ) : (
          <div
            data-smoke-view={effectiveLibraryView === 'kanban' ? 'library-kanban' : 'library-list'}
            className="contents"
          >
            {showOverviewGuidance && (
              <LibraryOverviewGuidance
                total={skills.length}
                unscenarized={unscenarizedCount}
                onOpenAiLens={() => setLibraryView('ai-lens')}
              />
            )}
            {effectiveLibraryView === 'kanban' ? (
              <KanbanView
                skills={skills}
                scenarios={scenarios}
                loading={skillsLoading}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            ) : (
              <>
                {filter.scope === 'unscenarized' && (
                  <AiLensBanner
                    count={skills.length}
                    onClick={() => {
                      setFilter({ scope: 'all' });
                      setLibraryView('ai-lens');
                    }}
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
                  sort={sort}
                  onSortChange={setSort}
                  title={titleForListFilter(filter, platforms, scenarios, t)}
                  subtitle={t('list.subtitle.count', { count: skills.length })}
                  hideOwnHeader
                  onOpenDir={
                    filter.platforms?.length === 1
                      ? async () => {
                          try {
                            await api.platforms.openDir(filter.platforms![0]!);
                          } catch (err) {
                            showToast(err instanceof Error ? err.message : String(err));
                          }
                        }
                      : undefined
                  }
                />
              </>
            )}
          </div>
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
          onToast={showToast}
        />
      )}

      <ScenarioForm
        open={scenarioFormOpen}
        onOpenChange={setScenarioFormOpen}
        onSaved={refreshMeta}
        onOpenAiLens={
          scenarios.length === 0
            ? () => {
                setSidebarView('library');
                setFilter({ scope: 'all' });
                setLibraryView('ai-lens');
              }
            : undefined
        }
      />

      <ToastViewport toasts={toasts} onDismiss={dismissToast} />

      {onboardingDone === false && (
        <OnboardingWizard
          onDone={() => {
            setOnboardingDone(true);
            refreshSkills();
            refreshMeta();
            // Onboarding may have saved the LLM config + key; re-check AI
            // availability now so the AI Lens / Create Skill views unlock
            // immediately instead of staying gated until the next app launch.
            refreshAiAvailability();
          }}
        />
      )}
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
  restricted,
  onChange,
  totalCount,
  scenarioCount,
  platformCount,
}: {
  value: LibraryView;
  /** Filter is narrowed: kanban/AI-lens don't apply to a slice — disable them
   * with a hint instead of hiding the whole switcher. */
  restricted: boolean;
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
        {items.map((it) => {
          const disabled = restricted && it.id !== 'list';
          return (
            <button
              key={it.id}
              type="button"
              disabled={disabled}
              onClick={() => onChange(it.id)}
              data-smoke-action={`library-${it.id}`}
              title={disabled ? t('libraryView.restricted.hint') : undefined}
              className={cn(
                'inline-flex h-6 items-center gap-1 whitespace-nowrap px-2.5 text-[11.5px] transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                value === it.id
                  ? 'bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                  : 'text-muted-foreground hover:text-foreground',
                disabled && 'cursor-not-allowed opacity-50 hover:text-muted-foreground',
              )}
            >
              {it.icon}
              {it.label}
            </button>
          );
        })}
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
 * CTA bar shown above the 未分类 view. This used to launch one-off AI
 * categorization; route users to AI Lens instead, where clustering and
 * scenario creation are easier to inspect before writing anything.
 */
function AiLensBanner({
  count,
  onClick,
  t,
}: {
  count: number;
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
  return (
    <div className="flex items-center justify-between gap-3 border-b bg-violet-50/50 px-4 py-2.5 dark:bg-violet-950/20">
      <div className="min-w-0 flex-1">
        <p className="text-[11px] text-muted-foreground">
          {t('uncategorized.aiLens.helper', { count })}
        </p>
      </div>
      <Button variant="ai" size="sm" onClick={onClick} className="shrink-0 gap-1.5">
        <Sparkles className="h-3.5 w-3.5" />
        {t('uncategorized.aiLens.cta')}
      </Button>
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
