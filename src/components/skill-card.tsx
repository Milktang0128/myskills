'use client';

import { AlertTriangle, Link2, EyeOff } from 'lucide-react';
import type { Skill } from '@shared/types';
import { PlatformBadge } from './platform-badge';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface Props {
  skill: Skill;
  selected: boolean;
  onSelect: () => void;
}

export function SkillCard({ skill, selected, onSelect }: Props) {
  const t = useT();
  const platforms = Array.from(new Set(skill.locations.map((l) => l.platformId)));
  const hasBroken = skill.locations.some((l) => l.isBrokenSymlink);
  const allDisabled = skill.locations.length > 0 && skill.locations.every((l) => l.isDisabled);
  const anySymlink = skill.locations.some((l) => l.isSymlink);

  return (
    <button
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={skill.name}
      className={cn(
        'group flex w-full flex-col gap-1 rounded-md border bg-card px-3 py-2.5 text-left transition-colors',
        'hover:border-foreground/20 hover:bg-accent/40',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        selected && 'border-primary/50 bg-accent/60 ring-1 ring-primary/20',
        allDisabled && 'opacity-60',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium" title={skill.name}>{skill.name}</span>
        {hasBroken && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label={t('card.brokenSymlink')} />}
        {allDisabled && <EyeOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={t('card.disabledAria')} />}
        {anySymlink && !hasBroken && (
          <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={t('card.symlinkAria')} />
        )}
        <div className="ml-auto flex shrink-0 gap-1">
          {platforms.map((p) => (
            <PlatformBadge key={p} platformId={p} />
          ))}
        </div>
      </div>
      {skill.description && (
        <p className="line-clamp-2 text-xs text-muted-foreground">{skill.description}</p>
      )}
      {skill.scenarios.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {skill.scenarios.map((sc) => (
            <span key={sc.id} className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-secondary-foreground">
              {sc.name}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}
