'use client';

import { Search } from 'lucide-react';
import type { Skill } from '@shared/types';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { EmptyState } from '@/components/ui/empty-state';
import { SkillCard } from './skill-card';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface Props {
  skills: Skill[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  search: string;
  onSearchChange: (s: string) => void;
  title?: string;
  subtitle?: string;
  /** When true, omit the title bar + search input — assumes the parent owns them. */
  hideOwnHeader?: boolean;
}

export function SkillList({
  skills,
  loading,
  selectedId,
  onSelect,
  search,
  onSearchChange,
  title,
  subtitle,
  hideOwnHeader = false,
}: Props) {
  const t = useT();
  const headerTitle = title ?? t('sidebar.allSkills');
  const headerSubtitle = subtitle ?? t('list.subtitle.count', { count: skills.length });
  return (
    <div className="flex h-full flex-col">
      {!hideOwnHeader && (
        <>
          <div className="titlebar-drag flex h-9 items-center justify-end px-3">
            <span className="text-xs text-muted-foreground">{headerSubtitle}</span>
          </div>
          <div className="titlebar-no-drag border-b px-4 py-3">
            <h1 className="text-lg font-semibold tracking-tight">{headerTitle}</h1>
            <div className="relative mt-2">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder={t('app.search.placeholder')}
                className="pl-8"
              />
            </div>
          </div>
        </>
      )}

      {hideOwnHeader && (
        // Page header band: kicker + CN H1 + meta count, matching the
        // editorial pattern used in matrix and history.
        <div className="border-b border-rule px-7 pt-7 pb-4">
          <div className="tk">{(headerSubtitle ?? '').toUpperCase()}</div>
          <h1 className="t-cn-h1 mt-2">{headerTitle}</h1>
        </div>
      )}

      <ScrollArea className="flex-1 scrollbar-thin">
        <div className={cn('flex flex-col', loading && 'opacity-50')}>
          {skills.length === 0 ? (
            <EmptyState
              title={loading ? t('list.empty.loading') : t('list.empty.title')}
              description={loading ? '' : t('list.empty.description')}
            />
          ) : (
            skills.map((s) => (
              <SkillCard
                key={s.id}
                skill={s}
                selected={selectedId === s.id}
                onSelect={() => onSelect(s.id === selectedId ? null : s.id)}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
