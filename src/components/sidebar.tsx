'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import {
  Layers,
  AlertTriangle,
  Copy as CopyIcon,
  HelpCircle,
  EyeOff,
  Folder,
  Settings as SettingsIcon,
  Plus,
  RefreshCw,
  History as HistoryIcon,
  Grid3x3,
  Globe,
} from 'lucide-react';
import type { AppStats, Platform, Scenario, SkillFilter, SkillScope } from '@shared/types';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

export type WorkspaceView = 'list' | 'matrix' | 'discover';

interface Props {
  view: WorkspaceView;
  onSelectCoverage: () => void;
  onSelectDiscover: () => void;
  filter: SkillFilter;
  onFilterChange: (f: SkillFilter) => void;
  platforms: Platform[];
  scenarios: Scenario[];
  stats: AppStats | null;
  onCreateScenario: () => void;
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
  onSelectCoverage,
  onSelectDiscover,
  filter,
  onFilterChange,
  platforms,
  scenarios,
  stats,
  onCreateScenario,
  onRescan,
  scanning,
}: Props) {
  const scopes = useMemo<ScopeItem[]>(
    () => [
      { scope: 'all', label: 'All Skills', count: stats?.totalSkills, icon: <Layers className="h-4 w-4" /> },
      // Duplicates surfaces same-content-different-name skills — the matrix can't see this
      // because it keys rows by skill name. Keep until consolidation tooling exists.
      { scope: 'duplicate', label: 'Duplicates', count: stats?.duplicates, icon: <CopyIcon className="h-4 w-4" />, tone: 'warn' },
      { scope: 'unscenarized', label: 'Unscenarized', count: stats?.unscenarized, icon: <HelpCircle className="h-4 w-4" />, tone: 'muted' },
      // Removed:
      //   - 'broken': redundant with matrix's Broken chip + detail drawer's location list.
      //   - 'disabled': there is no enable/disable action yet, so the row is read-only dead UI.
      //     Re-add when the action is implemented.
    ],
    [stats],
  );

  // Sidebar highlights are only meaningful in list view. In matrix view, only
  // the "Coverage matrix" item is active; other rows return to grey.
  const inList = view === 'list';

  const isScopeActive = (scope: SkillScope) =>
    inList &&
    (filter.scope ?? 'all') === scope &&
    (filter.platforms?.length ?? 0) === 0 &&
    filter.scenarioId == null;

  const isPlatformActive = (id: string) =>
    inList && filter.platforms?.length === 1 && filter.platforms[0] === id && filter.scenarioId == null;

  const isScenarioActive = (id: number) => inList && filter.scenarioId === id;

  return (
    <aside className="flex h-full w-64 flex-col border-r bg-card/40">
      <div className="titlebar-drag h-9 shrink-0 border-b" />
      <div className="px-3 py-3 titlebar-no-drag">
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2"
          onClick={onRescan}
          disabled={scanning}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', scanning && 'animate-spin')} />
          {scanning ? 'Scanning…' : 'Rescan all platforms'}
        </Button>
      </div>

      <ScrollArea className="flex-1 px-2 scrollbar-thin">
        <Section title="Library">
          <SidebarRow
            active={view === 'matrix'}
            onClick={onSelectCoverage}
            icon={<Grid3x3 className="h-4 w-4" />}
          >
            Coverage matrix
          </SidebarRow>
          <SidebarRow
            active={view === 'discover'}
            onClick={onSelectDiscover}
            icon={<Globe className="h-4 w-4" />}
          >
            Discover
          </SidebarRow>
          {scopes.map((s) => (
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

        <Section title="Platforms">
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
          title="Scenarios"
          action={
            <button
              onClick={onCreateScenario}
              className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="New scenario"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          }
        >
          {scenarios.length === 0 ? (
            <button
              onClick={onCreateScenario}
              className="block w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              No scenarios yet — <span className="underline">create one</span>
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

      <div className="space-y-px border-t p-2">
        <Link
          href="/scenarios"
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Layers className="h-4 w-4" />
          Manage scenarios
        </Link>
        <Link
          href="/history"
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <HistoryIcon className="h-4 w-4" />
          Sync history
        </Link>
        <Link
          href="/settings"
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <SettingsIcon className="h-4 w-4" />
          Settings
        </Link>
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
      className={cn(
        'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm',
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
