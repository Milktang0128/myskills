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
import { DiscoverView } from '@/components/discover-view';

export default function Workspace() {
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
    const t = setInterval(() => {
      if (window.myskills) {
        setBridgeReady(true);
        clearInterval(t);
      }
    }, 50);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!bridgeReady) return;
    refreshMeta();
  }, [bridgeReady, refreshMeta]);

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
            <h1 className="text-sm font-semibold">
              {view === 'matrix'
                ? 'Coverage matrix'
                : view === 'discover'
                ? 'Discover'
                : titleForListFilter(filter, platforms, scenarios)}
            </h1>
            <div className="relative ml-auto max-w-md flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={
                  view === 'matrix'
                    ? 'Search the matrix…'
                    : view === 'discover'
                    ? 'Search skills.sh…'
                    : 'Search skills…'
                }
                className="h-7 w-full rounded-md border bg-background pl-8 pr-2 text-xs"
              />
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
          <DiscoverView query={search} onToast={showToast} />
        ) : (
          <SkillList
            skills={skills}
            loading={skillsLoading}
            selectedId={selectedId}
            onSelect={setSelectedId}
            search={search}
            onSearchChange={setSearch}
            title={titleForListFilter(filter, platforms, scenarios)}
            subtitle={`${skills.length} skills`}
            hideOwnHeader
          />
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
    </main>
  );
}

function titleForListFilter(filter: SkillFilter, platforms: Platform[], scenarios: Scenario[]): string {
  if (filter.scenarioId != null) {
    return scenarios.find((s) => s.id === filter.scenarioId)?.name ?? 'Scenario';
  }
  if (filter.platforms?.length === 1) {
    return platforms.find((p) => p.id === filter.platforms![0])?.label ?? 'Platform';
  }
  switch (filter.scope) {
    case 'broken':
      return 'Broken Symlinks';
    case 'duplicate':
      return 'Duplicates';
    case 'unscenarized':
      return 'Unscenarized Skills';
    case 'disabled':
      return 'Disabled Skills';
    default:
      return 'All Skills';
  }
}
