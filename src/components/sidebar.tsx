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
  Map as MapIcon,
} from 'lucide-react';
import type { AppStats, Platform, Scenario, SkillFilter, SkillScope } from '@shared/types';
import { LangToggle } from '@/components/lang-toggle';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export type WorkspaceView = 'list' | 'matrix' | 'discover' | 'map';

interface Props {
  view: WorkspaceView;
  onSelectCoverage: () => void;
  onSelectDiscover: () => void;
  onSelectMap: () => void;
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

/**
 * The Sidebar is the "ink band" of the three-band layout (sidebar = ink,
 * main = paper, drawer = paper-panel). It's the only large dark surface
 * in the app, and the visual anchor for the editorial aesthetic.
 *
 * Active rows wear a left red rail (border-left: 2px red) which is the
 * brand's signature accent — same rail that headers the matrix canonical
 * column. Hover is a near-transparent paper wash; never a solid bg.
 */
export function Sidebar({
  view,
  onSelectCoverage,
  onSelectDiscover,
  onSelectMap,
  filter,
  onFilterChange,
  platforms,
  scenarios,
  stats,
  onCreateScenario,
  onRescan,
  scanning,
}: Props) {
  const t = useT();
  const scopes = useMemo<ScopeItem[]>(
    () => [
      { scope: 'all', label: t('sidebar.allSkills'), count: stats?.totalSkills, icon: <Layers className="h-3.5 w-3.5" /> },
      { scope: 'duplicate', label: t('sidebar.duplicates'), count: stats?.duplicates, icon: <CopyIcon className="h-3.5 w-3.5" />, tone: 'warn' },
      { scope: 'unscenarized', label: t('sidebar.unscenarized'), count: stats?.unscenarized, icon: <HelpCircle className="h-3.5 w-3.5" />, tone: 'muted' },
    ],
    [stats, t],
  );

  const inList = view === 'list';
  const isScopeActive = (scope: SkillScope) =>
    inList && (filter.scope ?? 'all') === scope && (filter.platforms?.length ?? 0) === 0 && filter.scenarioId == null;
  const isPlatformActive = (id: string) =>
    inList && filter.platforms?.length === 1 && filter.platforms[0] === id && filter.scenarioId == null;
  const isScenarioActive = (id: number) => inList && filter.scenarioId === id;

  return (
    <aside className="flex h-full w-[232px] shrink-0 flex-col overflow-hidden border-r border-rule-dark bg-ink text-[#f2eee2]">
      {/* Top strip — reserves macOS traffic-light real estate, hosts brand mark */}
      <div className="titlebar-drag flex h-11 shrink-0 items-center border-b border-[rgba(212,203,184,0.08)]">
        <div className="w-[68px] shrink-0" /> {/* traffic-light reservation */}
        <div className="titlebar-no-drag flex h-full flex-1 items-center gap-2.5 px-3.5 min-w-0">
          <BrandMark />
          <span className="t-cn truncate text-[14px] leading-none">MySkills</span>
        </div>
      </div>

      {/* Rescan button — outlined in faint paper, mono uppercase */}
      <button
        onClick={onRescan}
        disabled={scanning}
        className="mx-2 mt-2 flex h-8 shrink-0 items-center gap-2 border border-[rgba(212,203,184,0.22)] bg-transparent px-2.5 font-mono text-[10px] uppercase leading-none tracking-[var(--wide)] text-[#f2eee2] transition-colors hover:border-[rgba(212,203,184,0.4)] hover:bg-[rgba(255,255,255,0.05)] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[rgba(212,203,184,0.5)]"
      >
        <RefreshCw className={cn('h-3 w-3', scanning && 'animate-spin')} />
        {scanning ? t('sidebar.scanning') : t('sidebar.rescan')}
      </button>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-2 pb-2">
        <Section title={t('sidebar.section.library')}>
          <SidebarRow active={view === 'matrix'} onClick={onSelectCoverage} icon={<Grid3x3 className="h-3.5 w-3.5" />}>
            {t('sidebar.coverage')}
          </SidebarRow>
          <SidebarRow active={view === 'map'} onClick={onSelectMap} icon={<MapIcon className="h-3.5 w-3.5" />}>
            {t('sidebar.map')}
          </SidebarRow>
          <SidebarRow active={view === 'discover'} onClick={onSelectDiscover} icon={<Globe className="h-3.5 w-3.5" />}>
            {t('sidebar.discover')}
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

        <Section title={t('sidebar.section.platforms')}>
          {platforms.map((p) => (
            <SidebarRow
              key={p.id}
              active={isPlatformActive(p.id)}
              onClick={() => onFilterChange({ scope: 'all', platforms: [p.id] })}
              icon={<Folder className="h-3.5 w-3.5" />}
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
              className="inline-flex h-[18px] w-[18px] items-center justify-center text-[rgba(212,203,184,0.6)] hover:bg-[rgba(255,255,255,0.04)] hover:text-[#f2eee2] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[rgba(212,203,184,0.5)]"
              aria-label={t('sidebar.newScenario')}
            >
              <Plus className="h-3 w-3" />
            </button>
          }
        >
          {scenarios.length === 0 ? (
            <button
              onClick={onCreateScenario}
              className="block w-full px-2.5 py-1.5 text-left font-mono text-[10px] uppercase leading-none tracking-[var(--wide)] text-[rgba(212,203,184,0.55)] hover:bg-[rgba(255,255,255,0.03)] hover:text-[#f2eee2] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[rgba(212,203,184,0.5)]"
            >
              {t('sidebar.scenarios.empty')}
            </button>
          ) : (
            scenarios.map((sc) => (
              <SidebarRow
                key={sc.id}
                active={isScenarioActive(sc.id)}
                onClick={() => onFilterChange({ scope: 'all', scenarioId: sc.id })}
                icon={<span className="inline-block h-[7px] w-[7px] rounded-full" style={{ backgroundColor: sc.color ?? '#888' }} />}
                count={sc.skillCount}
              >
                {sc.name}
              </SidebarRow>
            ))
          )}
        </Section>
      </div>

      {/* Footer — quieter nav (manage / history / settings) + lang toggle */}
      <div className="shrink-0 space-y-px border-t border-[rgba(212,203,184,0.1)] p-1.5">
        <FootLink href="/scenarios" icon={<Layers className="h-3.5 w-3.5" />}>{t('sidebar.manageScenarios')}</FootLink>
        <FootLink href="/history" icon={<HistoryIcon className="h-3.5 w-3.5" />}>{t('sidebar.syncHistory')}</FootLink>
        <FootLink href="/settings" icon={<SettingsIcon className="h-3.5 w-3.5" />}>{t('sidebar.settings')}</FootLink>
        <div className="flex items-center justify-end px-1 pt-1">
          <LangToggle size="sm" />
        </div>
      </div>
    </aside>
  );
}

/**
 * Brand mark — small square paper rectangle with a vermillion stripe down
 * the left edge and a tiny ink dot near the right side. A miniature flag
 * for the editorial voice. Pure CSS, no asset.
 */
function BrandMark() {
  return (
    <div
      className="relative h-[18px] w-[18px] shrink-0 bg-[#f2eee2]"
      aria-hidden="true"
    >
      <span className="absolute left-[3px] top-0 bottom-0 w-[3px] bg-[#e1462b]" />
      <span className="absolute right-[3px] top-[11px] h-1 w-1 rounded-full bg-[#14120d]" />
    </div>
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
      <div className="flex items-center justify-between px-2 pb-1.5 pt-4 font-mono text-[9.5px] uppercase tracking-[var(--widest)] text-[rgba(212,203,184,0.5)]">
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
  const warnCount = tone === 'warn' && count && count > 0;
  const dangerCount = tone === 'danger' && count && count > 0;
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      title={typeof children === 'string' ? children : undefined}
      className={cn(
        'group -ml-[2px] flex w-full items-center gap-2.5 border-l-2 border-transparent px-2.5 py-1.5 text-[13px] transition-colors',
        'text-[rgba(242,238,226,0.78)] hover:bg-[rgba(255,255,255,0.03)] hover:text-[#f2eee2]',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[rgba(212,203,184,0.5)]',
        active && 'border-l-[var(--red)] bg-[rgba(225,70,43,0.10)] text-[#f2eee2]',
      )}
    >
      <span className={cn('shrink-0 opacity-65 group-hover:opacity-100', active && 'text-[var(--red)] opacity-100')}>{icon}</span>
      <span className="flex-1 min-w-0 truncate text-left">{children}</span>
      {typeof count === 'number' && count > 0 ? (
        <span
          className={cn(
            'font-mono text-[10.5px] leading-none tabular-nums',
            active ? 'text-[rgba(242,238,226,0.7)]' : 'text-[rgba(212,203,184,0.45)]',
            warnCount && 'text-[#e6b56b]',
            dangerCount && 'text-[var(--red)]',
          )}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

function FootLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-2.5 px-2.5 py-1.5 text-[12px] text-[rgba(212,203,184,0.65)] hover:bg-[rgba(255,255,255,0.03)] hover:text-[#f2eee2] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[rgba(212,203,184,0.5)]"
    >
      <span className="opacity-65">{icon}</span>
      <span className="flex-1 min-w-0 truncate">{children}</span>
    </Link>
  );
}
