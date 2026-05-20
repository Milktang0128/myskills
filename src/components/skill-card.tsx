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

/**
 * List-item version of a skill. Matches the prototype's `.list-item`:
 * full-width button, hairline bottom rule between items (no card chrome),
 * 2px red left rail when selected, paper-alt wash on hover. Scenario
 * chips are mono uppercase pills with a colored dot.
 */
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
        'group flex w-full flex-col gap-1 border-b border-rule border-l-2 border-l-transparent bg-transparent px-3 py-3 text-left transition-colors',
        'hover:bg-paper-alt/60',
        'focus-visible:outline-none focus-visible:relative focus-visible:z-10 focus-visible:ring-1 focus-visible:ring-ink',
        selected && 'border-l-[var(--red)] bg-[rgba(225,70,43,0.06)]',
        allDisabled && 'opacity-60',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="t-cn truncate text-[14px] font-bold leading-tight" title={skill.name}>{skill.name}</span>
        {hasBroken && <AlertTriangle className="h-3 w-3 shrink-0 text-red-brand" aria-label={t('card.brokenSymlink')} />}
        {allDisabled && <EyeOff className="h-3 w-3 shrink-0 text-mute" aria-label={t('card.disabledAria')} />}
        {anySymlink && !hasBroken && (
          <Link2 className="h-3 w-3 shrink-0 text-mute" aria-label={t('card.symlinkAria')} />
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {platforms.map((p) => (
            <PlatformBadge key={p} platformId={p} />
          ))}
        </div>
      </div>
      {skill.description && (
        <p className="line-clamp-2 text-[12.5px] leading-[1.55] text-soft max-w-[70ch]">{skill.description}</p>
      )}
      {skill.scenarios.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {skill.scenarios.map((sc) => (
            <span
              key={sc.id}
              className="inline-flex items-center border border-rule px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em] text-soft"
            >
              {sc.name}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}
