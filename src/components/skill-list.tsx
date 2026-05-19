'use client';

import { Search } from 'lucide-react';
import type { Skill } from '@shared/types';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { EmptyState } from '@/components/ui/empty-state';
import { SkillCard } from './skill-card';
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
}

export function SkillList({
  skills,
  loading,
  selectedId,
  onSelect,
  search,
  onSearchChange,
  title = 'All Skills',
  subtitle,
}: Props) {
  return (
    <div className="flex h-full flex-col">
      <div className="titlebar-drag flex h-9 items-center justify-end px-3">
        <span className="text-xs text-muted-foreground">{subtitle ?? `${skills.length} skills`}</span>
      </div>

      <div className="titlebar-no-drag border-b px-4 py-3">
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        <div className="relative mt-2">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search skills…"
            className="pl-8"
          />
        </div>
      </div>

      <ScrollArea className="flex-1 scrollbar-thin">
        <div className={cn('flex flex-col gap-1.5 p-3', loading && 'opacity-50')}>
          {skills.length === 0 ? (
            <EmptyState
              title={loading ? 'Loading…' : 'No skills match this view'}
              description={loading ? '' : 'Try clearing search or filters, or run a rescan.'}
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
