'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import {
  Layers,
  Copy as CopyIcon,
  HelpCircle,
  Folder,
  Settings as SettingsIcon,
  Plus,
  RefreshCw,
  History as HistoryIcon,
  Grid3x3,
  Globe,
} from 'lucide-react';
import type { AppStats, Platform, Scenario, SkillFilter, SkillScope } from '@shared/types';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * Sidebar selects the top-level section. The AI Lens (formerly "Skill map")
 * is NOT here — it's a sub-view of Library, picked via the sub-toolbar.
 *
 * 'history' and 'scenarios' are peers of 'matrix' / 'discover' — they were
 * once full routes, then drawers, and now they're plain workspace views
 * that take over the main content area while the sidebar stays put. The
 * footer rows highlight when their view is active.
 *
 * Splitting this from the library's own `'list' | 'kanban' | 'ai-lens'`
 * sub-toggle keeps the navigation concerns clean: this component only
 * decides which page-level surface is showing.
 */
export type SidebarView = 'library' | 'matrix' | 'discover' | 'history' | 'scenarios';

interface Props {
  view: SidebarView;
  onSelectAllSkills: () => void;
  onSelectCoverage: () => void;
  onSelectDiscover: () => void;
  filter: SkillFilter;
  onFilterChange: (f: SkillFilter) => void;
  platforms: Platform[];
  scenarios: Scenario[];
  stats: AppStats | null;
  onCreateScenario: () => void;
  /** Switch the workspace to the Scenarios management view. */
  onSelectScenarios: () => void;
  /** Switch the workspace to the Sync history view. */
  onSelectHistory: () => void;
  onRescan: () => void;
  scanning: boolean;
}

interface ScopeItem {
  scope: SkillScope;
  label: string;
  count?: number;
  icon: React.ReactNode;
  tone?: 'warn' | 'danger' | 'muted';
}

export function Sidebar({
  view,
  onSelectAllSkills,
  onSelectCoverage,
  onSelectDiscover,
  filter,
  onFilterChange,
  platforms,
  scenarios,
  stats,
  onCreateScenario,
  onSelectScenarios,
  onSelectHistory,
  onRescan,
  scanning,
}: Props) {
  const t = useT();
  const scopes = useMemo<ScopeItem[]>(
    () => [
      { scope: 'all', label: t('sidebar.allSkills'), count: stats?.totalSkills, icon: <Layers className="h-4 w-4" /> },
      // Duplicates surfaces same-content-different-name skills — the matrix can't see this
      // because it keys rows by skill name. Keep until consolidation tooling exists.
      { scope: 'duplicate', label: t('sidebar.duplicates'), count: stats?.duplicates, icon: <CopyIcon className="h-4 w-4" />, tone: 'warn' },
      { scope: 'unscenarized', label: t('sidebar.unscenarized'), count: stats?.unscenarized, icon: <HelpCircle className="h-4 w-4" />, tone: 'muted' },
      // Removed:
      //   - 'broken': redundant with matrix's Broken chip + detail drawer's location list.
      //   - 'disabled': there is no enable/disable action yet, so the row is read-only dead UI.
      //     Re-add when the action is implemented.
    ],
    [stats, t],
  );

  // Active states: a scope/scenario/platform row only highlights when we are
  // in the Library section AND that specific filter is set. Coverage and
  // Discover are pure sidebarView checks — no filter coupling.
  const inLibrary = view === 'library';

  const isScopeActive = (scope: SkillScope) =>
    inLibrary &&
    (filter.scope ?? 'all') === scope &&
    (filter.platforms?.length ?? 0) === 0 &&
    filter.scenarioId == null;

  const isPlatformActive = (id: string) =>
    inLibrary && filter.platforms?.length === 1 && filter.platforms[0] === id && filter.scenarioId == null;

  const isScenarioActive = (id: number) => inLibrary && filter.scenarioId === id;

  return (
    // Canvas tier — sidebar sits on a slightly off-white tone in light mode so
    // it reads distinct from the white main content area. In dark mode the
    // sidebar and main area share the same canvas (#131316); contrast there
    // comes from card elevation, not from the sidebar tone.
    <aside className="flex h-full w-64 flex-col border-r bg-neutral-50/80 dark:bg-background">
      {/* Top region — pure drag bar, same height as main header (h-12, 48px)
          so the border-b lines up across the entire window. macOS traffic
          lights live here; we deliberately keep this region empty so they
          have visual breathing room. Status info lives below. */}
      <div className="titlebar-drag h-12 shrink-0 border-b" />

      {/* Scan status row — lives below the top bar, in the sidebar's regular
          content flow. Ambient info (dot + count) on its own line; the small
          refresh icon is the only interactive element. */}
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            scanning ? 'animate-pulse bg-amber-500' : 'bg-emerald-500',
          )}
        />
        <span className="whitespace-nowrap text-[11.5px] text-muted-foreground">
          {scanning ? t('sidebar.scanBanner.scanning') : t('sidebar.scanBanner.scanned')}
        </span>
        <span className="ml-auto whitespace-nowrap text-[11.5px] tabular-nums text-muted-foreground">
          {t('sidebar.scanBanner.count', { count: stats?.totalSkills ?? 0 })}
        </span>
        <button
          type="button"
          onClick={onRescan}
          disabled={scanning}
          title={t('sidebar.scanBanner.action')}
          aria-label={t('sidebar.scanBanner.action')}
          className={cn(
            'inline-flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground transition-colors',
            'hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          <RefreshCw className={cn('h-3 w-3', scanning && 'animate-spin')} />
        </button>
      </div>

      <ScrollArea className="flex-1 px-2 scrollbar-thin">
        <Section title={t('sidebar.section.library')}>
          {/* "All Skills" row enters the Library section with the default filter.
              The actual list/kanban/ai-lens choice is made in the sub-toolbar. */}
          <SidebarRow
            active={isScopeActive('all')}
            onClick={onSelectAllSkills}
            icon={<Layers className="h-4 w-4" />}
            count={stats?.totalSkills}
          >
            {t('sidebar.allSkills')}
          </SidebarRow>
          <SidebarRow
            active={view === 'matrix'}
            onClick={onSelectCoverage}
            icon={<Grid3x3 className="h-4 w-4" />}
          >
            {t('sidebar.coverage')}
          </SidebarRow>
          <SidebarRow
            active={view === 'discover'}
            onClick={onSelectDiscover}
            icon={<Globe className="h-4 w-4" />}
          >
            {t('sidebar.discover')}
          </SidebarRow>
          {/* Scope filters that don't fit kanban/lens — they always route
              into list view (the sub-toolbar collapses when filter ≠ default). */}
          {scopes
            .filter((s) => s.scope !== 'all')
            .map((s) => (
              <SidebarRow
                key={s.scope}
                active={isScopeActive(s.scope)}
                onClick={() => onFilterChange({ scope: s.scope })}
                icon={s.icon}
                tone={s.tone}
                count={s.count}
              >
                {s.label}
              </SidebarRow>
            ))}
        </Section>

        <Section title={t('sidebar.section.platforms')}>
          {platforms.map((p) => (
            <SidebarRow
              key={p.id}
              active={isPlatformActive(p.id)}
              onClick={() => onFilterChange({ scope: 'all', platforms: [p.id] })}
              icon={<Folder className="h-4 w-4" />}
              count={stats?.byPlatform?.[p.id]}
            >
              {p.label}
            </SidebarRow>
          ))}
        </Section>

        <Section
          title={t('sidebar.section.scenarios')}
          action={
            <button
              onClick={onCreateScenario}
              className="p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
              aria-label={t('sidebar.newScenario')}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          }
        >
          {scenarios.length === 0 ? (
            <button
              onClick={onCreateScenario}
              className="block w-full px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            >
              {t('sidebar.scenarios.empty')}
            </button>
          ) : (
            scenarios.map((sc) => (
              <SidebarRow
                key={sc.id}
                active={isScenarioActive(sc.id)}
                onClick={() => onFilterChange({ scope: 'all', scenarioId: sc.id })}
                icon={<span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: sc.color ?? '#888' }} />}
                count={sc.skillCount}
              >
                {sc.name}
              </SidebarRow>
            ))
          )}
        </Section>
      </ScrollArea>

      {/* Bottom utility row.
          - Manage Scenarios + Sync History are peer workspace views: they
            highlight active state like the top-level Library/Matrix/Discover
            rows do.
          - Settings keeps its own route — Settings is big enough that
            inlining it into the workspace shell would crowd everything else;
            full-page is the right home for it. */}
      <div className="space-y-px border-t p-2">
        <button
          type="button"
          onClick={onSelectScenarios}
          aria-pressed={view === 'scenarios'}
          className={cn(
            'flex w-full items-center gap-2 px-2 py-1.5 text-sm',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
            view === 'scenarios'
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          <Layers className="h-4 w-4" />
          {t('sidebar.manageScenarios')}
        </button>
        <button
          type="button"
          onClick={onSelectHistory}
          aria-pressed={view === 'history'}
          className={cn(
            'flex w-full items-center gap-2 px-2 py-1.5 text-sm',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
            view === 'history'
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          <HistoryIcon className="h-4 w-4" />
          {t('sidebar.syncHistory')}
        </button>
        <Link
          href="/settings"
          className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        >
          <SettingsIcon className="h-4 w-4" />
          {t('sidebar.settings')}
        </Link>
        {/* Language toggle lives only in Settings now — keeping it here too
            doubled the affordance for a setting most users flip once. */}
      </div>
    </aside>
  );
}

function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span>{title}</span>
        {action}
      </div>
      <div className="space-y-px">{children}</div>
    </div>
  );
}

function SidebarRow({
  active,
  onClick,
  icon,
  count,
  children,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  count?: number | null;
  children: React.ReactNode;
  tone?: 'warn' | 'danger' | 'muted';
}) {
  const countCls =
    tone === 'danger' && count && count > 0
      ? 'text-destructive'
      : tone === 'warn' && count && count > 0
      ? 'text-amber-600'
      : 'text-muted-foreground';
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      title={typeof children === 'string' ? children : undefined}
      className={cn(
        'group flex w-full items-center gap-2 px-2 py-1.5 text-sm',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
      )}
    >
      <span className="text-muted-foreground group-hover:text-foreground">{icon}</span>
      <span className="flex-1 truncate text-left">{children}</span>
      {typeof count === 'number' && count > 0 ? (
        <span className={cn('text-xs tabular-nums', countCls)}>{count}</span>
      ) : null}
    </button>
  );
}
