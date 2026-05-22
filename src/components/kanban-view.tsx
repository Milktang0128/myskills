'use client';

/**
 * Kanban view — skills grouped by scenario.
 *
 * Columns: one per scenario, plus a trailing "未分类" column for skills with
 * scenarios.length === 0. A skill with N scenarios appears in N columns (the
 * Skill is a tool, scenarios are usage horizons — multi-membership is the
 * intended model).
 *
 * Empty-state behavior: when essentially nothing has been categorized
 * (unscenarized / total > UNSCENARIZED_GUIDANCE_THRESHOLD), the view shows a
 * one-time guidance card at the top pointing the user at the AI Lens — that
 * AI clustering is the bridge from Day-0 emptiness to a meaningful Kanban.
 * The card auto-hides once the user has tagged enough skills.
 */
import { useMemo } from 'react';
import { AlertTriangle, EyeOff, Link2, Sparkles } from 'lucide-react';
import type { Scenario, Skill } from '@shared/types';
import { PlatformBadge } from './platform-badge';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * "Essentially nothing categorized" threshold. Above this, the guidance card
 * is the most useful thing on screen; below this, Kanban itself has enough
 * signal that the card becomes nag and hides itself.
 */
const UNSCENARIZED_GUIDANCE_THRESHOLD = 0.8;

interface Props {
  skills: Skill[];
  scenarios: Scenario[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (skillId: string) => void;
  /** Switches the library sub-view to AI Lens — called from the guidance card. */
  onOpenAiLens: () => void;
}

export function KanbanView({
  skills,
  scenarios,
  loading,
  selectedId,
  onSelect,
  onOpenAiLens,
}: Props) {
  const t = useT();

  // Group skills into columns. Sorted scenarios first (stable order), then
  // the catch-all "未分类" column at the end so the eye lands on user-curated
  // groups before the inbox.
  const { columns, unscenarized, unscenarizedRatio } = useMemo(() => {
    const byScenario = new Map<number, Skill[]>();
    const orphans: Skill[] = [];
    for (const sk of skills) {
      if (sk.scenarios.length === 0) {
        orphans.push(sk);
        continue;
      }
      for (const ref of sk.scenarios) {
        const arr = byScenario.get(ref.id) ?? [];
        arr.push(sk);
        byScenario.set(ref.id, arr);
      }
    }
    const sorted = [...scenarios].sort((a, b) => a.sortOrder - b.sortOrder);
    const cols = sorted.map((sc) => ({
      key: `sc-${sc.id}`,
      name: sc.name,
      color: sc.color,
      items: byScenario.get(sc.id) ?? [],
    }));
    const ratio = skills.length === 0 ? 0 : orphans.length / skills.length;
    return { columns: cols, unscenarized: orphans, unscenarizedRatio: ratio };
  }, [skills, scenarios]);

  const showGuidance = unscenarizedRatio >= UNSCENARIZED_GUIDANCE_THRESHOLD && skills.length > 0;

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        {t('list.empty.loading')}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showGuidance && (
        <KanbanGuidance
          total={skills.length}
          unscenarized={unscenarized.length}
          onOpenAiLens={onOpenAiLens}
        />
      )}

      {/* Horizontal scroll across columns. Each column is a fixed width so the
          card grid is consistent across scenarios with varying skill counts. */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden">
        <div className="flex h-full gap-3 px-6 py-5">
          {columns.map((col) => (
            <KanbanColumn
              key={col.key}
              title={col.name}
              dotColor={col.color}
              items={col.items}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
          {unscenarized.length > 0 && (
            <KanbanColumn
              key="unscenarized"
              title={t('kanban.column.unscenarized')}
              // Muted grey dot — unscenarized is not a scenario, it's a state.
              // Use foreground-on-canvas neutral so it reads "absence of label".
              dotColor="#a3a3a3"
              items={unscenarized}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Guidance card (zero-categorization Day-0 nudge) ──────────────────────

function KanbanGuidance({
  total,
  unscenarized,
  onOpenAiLens,
}: {
  total: number;
  unscenarized: number;
  onOpenAiLens: () => void;
}) {
  const t = useT();
  return (
    <div className="border-b bg-secondary/30 px-6 py-3">
      <div className="flex items-start gap-3">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-violet-500" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-foreground">
            {t('kanban.empty.guidance.title')}
          </p>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {t('kanban.empty.guidance.body', { unscenarized, total })}
          </p>
        </div>
        <button
          type="button"
          onClick={onOpenAiLens}
          className={cn(
            'inline-flex h-7 shrink-0 items-center gap-1.5 px-3 text-[12px] font-medium',
            'bg-primary text-primary-foreground transition-colors hover:bg-primary/85',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
          )}
        >
          <Sparkles className="h-3.5 w-3.5" />
          {t('kanban.empty.guidance.cta')}
        </button>
      </div>
    </div>
  );
}

// ─── Column ───────────────────────────────────────────────────────────────

function KanbanColumn({
  title,
  dotColor,
  items,
  selectedId,
  onSelect,
}: {
  title: string;
  dotColor: string | null;
  items: Skill[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex w-[280px] shrink-0 flex-col">
      <div className="mb-2.5 flex items-center gap-2 px-1">
        <span className="inline-flex h-6 items-center gap-1.5 bg-secondary px-2 text-[12px] font-medium tracking-tight text-secondary-foreground">
          {dotColor && (
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: dotColor }} />
          )}
          {title}
        </span>
        <span className="text-[11.5px] tabular-nums text-muted-foreground">{items.length}</span>
      </div>
      <div className="flex flex-col gap-2 overflow-y-auto pb-8 scrollbar-thin">
        {items.length === 0 ? (
          <div className="px-2 py-6 text-center text-[11.5px] text-muted-foreground">
            —
          </div>
        ) : (
          items.map((sk) => (
            <KanbanCard
              key={sk.id}
              skill={sk}
              selected={selectedId === sk.id}
              onSelect={() => onSelect(sk.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ─── Card ─────────────────────────────────────────────────────────────────

function KanbanCard({
  skill,
  selected,
  onSelect,
}: {
  skill: Skill;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const platforms = Array.from(new Set(skill.locations.map((l) => l.platformId)));
  const hasBroken = skill.locations.some((l) => l.isBrokenSymlink);
  const allDisabled = skill.locations.length > 0 && skill.locations.every((l) => l.isDisabled);
  const anySymlink = skill.locations.some((l) => l.isSymlink);
  // Mono initial badge — first two chars of the name's first segment.
  // Matches the redesign's `name.split(/[-:]/)[0].slice(0,2)` convention so
  // composite names like `vercel:deploy` use "ve" instead of "ve".
  const initial = skill.name.split(/[-:]/)[0].slice(0, 2);

  return (
    <button
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={skill.name}
      className={cn(
        'group flex w-full flex-col gap-1.5 border bg-card px-3 py-2.5 text-left transition-all',
        'hover:border-foreground/30',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        selected && 'border-foreground/40 shadow-[0_0_0_3px_rgba(0,0,0,0.04)] dark:shadow-[0_0_0_3px_rgba(255,255,255,0.06)]',
        allDisabled && 'opacity-60',
      )}
    >
      <div className="flex items-start gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center bg-secondary font-mono text-[11px] font-medium text-secondary-foreground">
          {initial}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium tracking-tight" title={skill.name}>
              {skill.name}
            </span>
            {hasBroken && (
              <AlertTriangle
                className="h-3 w-3 shrink-0 text-destructive"
                aria-label={t('card.brokenSymlink')}
              />
            )}
            {allDisabled && (
              <EyeOff
                className="h-3 w-3 shrink-0 text-muted-foreground"
                aria-label={t('card.disabledAria')}
              />
            )}
            {anySymlink && !hasBroken && (
              <Link2
                className="h-3 w-3 shrink-0 text-muted-foreground"
                aria-label={t('card.symlinkAria')}
              />
            )}
          </div>
          {skill.description && (
            <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-[1.45] text-muted-foreground">
              {skill.description}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 pl-9">
        {platforms.map((p) => (
          <PlatformBadge key={p} platformId={p} />
        ))}
        <span className="ml-auto whitespace-nowrap text-[10.5px] tabular-nums text-muted-foreground">
          {formatBytes(skill.sizeBytes)}
        </span>
      </div>
    </button>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
