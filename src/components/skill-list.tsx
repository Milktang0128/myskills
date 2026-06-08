'use client';

import { Search, ChevronDown, FolderOpen } from 'lucide-react';
import type { Skill, SkillSort } from '@shared/types';
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
  sort: SkillSort;
  onSortChange: (s: SkillSort) => void;
  title?: string;
  subtitle?: string;
  /** When true, omit the title bar + search input — assumes the parent owns them. */
  hideOwnHeader?: boolean;
  /** Optional: when the title represents an openable directory (e.g. a single
   * platform filter), render a reveal-in-file-manager button next to it. */
  onOpenDir?: () => void;
}

export function SkillList({
  skills,
  loading,
  selectedId,
  onSelect,
  search,
  onSearchChange,
  sort,
  onSortChange,
  title,
  subtitle,
  hideOwnHeader = false,
  onOpenDir,
}: Props) {
  const t = useT();
  const headerTitle = title ?? t('sidebar.allSkills');
  const headerSubtitle = subtitle ?? t('list.subtitle.count', { count: skills.length });
  const sortSelect = (
    <SortSelect value={sort} onChange={onSortChange} />
  );
  return (
    <div className="flex h-full flex-col">
      {!hideOwnHeader && (
        <>
          <div className="titlebar-drag flex h-9 items-center justify-end gap-3 px-3">
            <div className="titlebar-no-drag">{sortSelect}</div>
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
        <div className="flex items-center justify-between border-b px-4 py-2 text-xs">
          <div className="flex items-center gap-1.5">
            <h2 className="font-medium">{headerTitle}</h2>
            {onOpenDir && (
              <button
                type="button"
                onClick={onOpenDir}
                title={t('header.platform.openDir')}
                aria-label={t('header.platform.openDir')}
                className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <FolderOpen className="h-3 w-3" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            {sortSelect}
            <span className="text-muted-foreground">{headerSubtitle}</span>
          </div>
        </div>
      )}

      <ScrollArea className="flex-1 scrollbar-thin">
        <div className={cn('flex flex-col gap-1.5 p-3', loading && 'opacity-50')}>
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

/**
 * Native <select> styled to blend with the rest of the toolbar. Native is the
 * right choice here: it's keyboard-accessible, screen-reader-correct, and the
 * 4-option set isn't worth a Radix popover. `title` shows the explanation on
 * hover so users can distinguish "created" (first seen) from "updated"
 * (content hash changed).
 */
function SortSelect({
  value,
  onChange,
}: {
  value: SkillSort;
  onChange: (s: SkillSort) => void;
}) {
  const t = useT();
  return (
    <div className="relative inline-flex items-center">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as SkillSort)}
        aria-label={t('list.sort.label')}
        title={t('list.sort.tooltip')}
        className="h-8 appearance-none rounded border border-input bg-background py-0.5 pl-3 pr-8 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
      >
        <option value="name">{t('list.sort.name')}</option>
        <option value="updated">{t('list.sort.updated')}</option>
        <option value="created">{t('list.sort.created')}</option>
        <option value="mtime">{t('list.sort.mtime')}</option>
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 h-3.5 w-3.5 text-muted-foreground" />
    </div>
  );
}
