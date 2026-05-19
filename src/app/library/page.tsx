'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppStats, Platform, Scenario, Skill, SkillFilter } from '@shared/types';
import { api } from '@/lib/api';
import { Sidebar } from '@/components/sidebar';
import { SkillList } from '@/components/skill-list';
import { SkillDetail } from '@/components/skill-detail';
import { ScenarioForm } from '@/components/scenario-form';

export default function LibraryPage() {
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [stats, setStats] = useState<AppStats | null>(null);
  const [filter, setFilter] = useState<SkillFilter>({ scope: 'all' });
  const [search, setSearch] = useState('');
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scenarioFormOpen, setScenarioFormOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [bridgeReady, setBridgeReady] = useState(false);

  const reqIdRef = useRef(0);

  // Resolve filter with current search input
  const effectiveFilter = useMemo<SkillFilter>(
    () => ({ ...filter, search: search.trim() || undefined }),
    [filter, search],
  );

  const refreshSkills = useCallback(async () => {
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
  }, [effectiveFilter]);

  const refreshMeta = useCallback(async () => {
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
  }, []);

  // Wait for the IPC bridge to be injected by preload. In dev mode the renderer
  // may render once before window.myskills exists.
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
    if (!bridgeReady) return;
    refreshSkills();
  }, [bridgeReady, refreshSkills]);

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

  const sidebarTitle = useMemo(() => {
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
  }, [filter, platforms, scenarios]);

  return (
    <main className="flex h-screen w-screen overflow-hidden">
      <Sidebar
        filter={filter}
        onFilterChange={(f) => {
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

      <div className="flex-1 min-w-0 border-l-0">
        <SkillList
          skills={skills}
          loading={skillsLoading}
          selectedId={selectedId}
          onSelect={setSelectedId}
          search={search}
          onSearchChange={setSearch}
          title={sidebarTitle}
          subtitle={`${skills.length} skills`}
        />
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
        onSaved={() => {
          refreshMeta();
        }}
      />
    </main>
  );
}
