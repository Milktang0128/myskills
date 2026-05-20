'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Check,
  Link2,
  Minus,
  AlertTriangle,
  EyeOff,
  Zap,
  Crown,
  Upload,
  HelpCircle,
  Globe,
  Settings as SettingsIcon,
  RefreshCw,
} from 'lucide-react';
import type {
  CoverageDrift,
  CoverageFilter,
  CoverageMatrix,
  CoverageRow,
  CoverageCellState,
  SkillFilter,
  SyncExecuteResult,
  SyncPlan,
} from '@shared/types';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { PlatformBadge } from '@/components/platform-badge';
import { SyncConfirm } from '@/components/sync-confirm';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface Props {
  /** Sidebar/search filter from the workspace; matrix narrows rows accordingly. */
  outerFilter: SkillFilter;
  /** Toast pipe — set from workspace, parent decides display. */
  onToast: (msg: string) => void;
  onSelectSkill: (id: string) => void;
  selectedSkillId: string | null;
  /** Notify workspace to refetch any shared state after a write. */
  onMutated?: () => void;
}

export function CoverageView({ outerFilter, onToast, onSelectSkill, selectedSkillId, onMutated }: Props) {
  const t = useT();
  const [matrix, setMatrix] = useState<CoverageMatrix | null>(null);
  const [filter, setFilter] = useState<CoverageFilter>('all');
  const [pendingPlan, setPendingPlan] = useState<SyncPlan | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bridgeReady, setBridgeReady] = useState(false);

  const MATRIX_FILTERS: { value: CoverageFilter; label: string; hint: string }[] = useMemo(
    () => [
      { value: 'all', label: t('matrix.filter.all'), hint: t('matrix.filter.all.hint') },
      { value: 'gaps', label: t('matrix.filter.gaps'), hint: t('matrix.filter.gaps.hint') },
      { value: 'orphans', label: t('matrix.filter.orphans'), hint: t('matrix.filter.orphans.hint') },
      { value: 'drift', label: t('matrix.filter.drift'), hint: t('matrix.filter.drift.hint') },
      { value: 'broken', label: t('matrix.filter.broken'), hint: t('matrix.filter.broken.hint') },
    ],
    [t],
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.myskills) {
      setBridgeReady(true);
      return;
    }
    const iv = setInterval(() => {
      if (window.myskills) {
        setBridgeReady(true);
        clearInterval(iv);
      }
    }, 50);
    return () => clearInterval(iv);
  }, []);

  const refresh = async () => {
    if (!bridgeReady) return;
    setMatrix(await api.coverage.matrix());
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridgeReady]);

  useEffect(() => {
    if (!bridgeReady) return;
    const off = api.on.scanFinished(() => refresh());
    return () => off();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridgeReady]);

  // Apply both the outer filter (sidebar/search) and the matrix-specific filter.
  const filteredRows = useMemo(() => {
    if (!matrix) return [];
    const q = outerFilter.search?.trim().toLowerCase() ?? '';
    return matrix.rows.filter((r) => {
      if (q) {
        if (!r.skillName.toLowerCase().includes(q) && !(r.description ?? '').toLowerCase().includes(q)) {
          return false;
        }
      }
      // Sidebar platform filter: skill must have a non-missing cell on at least one selected platform.
      if (outerFilter.platforms && outerFilter.platforms.length > 0) {
        const anyMatch = outerFilter.platforms.some((p) => r.cells[p]?.state && r.cells[p]!.state !== 'missing');
        if (!anyMatch) return false;
      }
      // Sidebar scenario filter is honored in matrix by reusing the skill list filter shape.
      // For now: matrix uses skillIds from the skills.list API to know membership. We can't easily
      // join in the matrix endpoint without a separate query, so we accept the cost of an extra
      // skill list when scenario is set.
      // (Implemented in useEffect below to keep this filter pure.)
      const anyBroken = matrix.platforms.some((p) => r.cells[p]?.state === 'broken');
      switch (filter) {
        case 'gaps':
          return r.hasCanonicalSource && r.missingOn.length > 0;
        case 'orphans':
          return !r.hasCanonicalSource;
        case 'drift':
          return r.hasDrift;
        case 'broken':
          return anyBroken;
        default:
          return true;
      }
    });
  }, [matrix, filter, outerFilter.search, outerFilter.platforms]);

  // Resolve scenario filter via skills.list (which already handles it).
  const [scenarioSkillIds, setScenarioSkillIds] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!bridgeReady) return;
    if (outerFilter.scenarioId == null) {
      setScenarioSkillIds(null);
      return;
    }
    let cancelled = false;
    api.skills.list({ scenarioId: outerFilter.scenarioId }).then((skills) => {
      if (!cancelled) setScenarioSkillIds(new Set(skills.map((s) => s.id)));
    });
    return () => { cancelled = true; };
  }, [bridgeReady, outerFilter.scenarioId]);

  const visibleRows = useMemo(
    () => (scenarioSkillIds ? filteredRows.filter((r) => scenarioSkillIds.has(r.skillId)) : filteredRows),
    [filteredRows, scenarioSkillIds],
  );

  // "Syncable" = missing + stale on a non-canonical platform, for any row that
  // has a canonical source.
  const syncableTotal = useMemo(() => {
    if (!matrix) return 0;
    let total = 0;
    for (const r of visibleRows) {
      if (!r.hasCanonicalSource) continue;
      for (const p of matrix.platforms) {
        if (p === matrix.canonicalPlatform) continue;
        const cell = r.cells[p];
        if (!cell) continue;
        if (cell.state === 'missing' || cell.drift === 'stale') total += 1;
      }
    }
    return total;
  }, [visibleRows, matrix]);

  const orphanTotal = useMemo(
    () => visibleRows.filter((r) => !r.hasCanonicalSource).length,
    [visibleRows],
  );

  async function handleSyncRow(row: CoverageRow) {
    if (!matrix) return;
    setBusy(true);
    try {
      // Include both missing AND stale platforms — planner will skip whatever's
      // already in sync and emit symlink_replace for stale.
      const targets = matrix.platforms.filter((p) => {
        if (p === matrix.canonicalPlatform) return false;
        const cell = row.cells[p];
        if (!cell) return false;
        return cell.state === 'missing' || cell.drift === 'stale';
      });
      const plan = await api.sync.planFromCanonical([
        { skillId: row.skillId, targetPlatformIds: targets },
      ]);
      setPendingPlan(plan);
      setPlanOpen(true);
    } finally {
      setBusy(false);
    }
  }
  async function handlePromoteRow(row: CoverageRow) {
    setBusy(true);
    try {
      const plan = await api.sync.planPromote([{ skillId: row.skillId }]);
      setPendingPlan(plan);
      setPlanOpen(true);
    } finally {
      setBusy(false);
    }
  }
  async function handleSyncAllGaps() {
    if (!matrix) return;
    setBusy(true);
    try {
      const requests = visibleRows
        .filter((r) => r.hasCanonicalSource)
        .map((r) => ({
          skillId: r.skillId,
          targetPlatformIds: matrix.platforms.filter((p) => {
            if (p === matrix.canonicalPlatform) return false;
            const cell = r.cells[p];
            if (!cell) return false;
            return cell.state === 'missing' || cell.drift === 'stale';
          }),
        }))
        .filter((r) => (r.targetPlatformIds?.length ?? 0) > 0);
      const plan = await api.sync.planFromCanonical(requests);
      setPendingPlan(plan);
      setPlanOpen(true);
    } finally {
      setBusy(false);
    }
  }
  async function handlePromoteAll() {
    setBusy(true);
    try {
      const requests = visibleRows
        .filter((r) => !r.hasCanonicalSource)
        .map((r) => ({ skillId: r.skillId }));
      const plan = await api.sync.planPromote(requests);
      setPendingPlan(plan);
      setPlanOpen(true);
    } finally {
      setBusy(false);
    }
  }

  function onApplied(result: SyncExecuteResult) {
    if (result.failed.length) {
      onToast(
        t('matrix.toast.appliedFailed', {
          applied: result.applied.length,
          skipped: result.skipped.length,
          failed: result.failed.length,
        }),
      );
    } else {
      onToast(
        t('matrix.toast.applied', {
          applied: result.applied.length,
          skipped: result.skipped.length,
        }),
      );
    }
    refresh();
    onMutated?.();
  }

  return (
    <div className="flex h-full flex-col">
      {/* Filter bar: chips form a connected segmented strip (margin-right
          negative so borders overlap into hairlines). Active chip flips to
          ink-on-paper. Canonical tag sits inline as a mono caption. */}
      <div className="flex items-center justify-between gap-3 border-b border-rule px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-0">
          {MATRIX_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              aria-pressed={filter === f.value}
              className={cn(
                '-mr-px inline-flex items-center gap-1.5 border border-rule px-2.5 py-1.5 font-mono text-[10.5px] uppercase leading-none tracking-[0.06em] transition-colors',
                'focus-visible:outline-none focus-visible:relative focus-visible:z-10 focus-visible:ring-1 focus-visible:ring-ink',
                filter === f.value
                  ? 'relative z-[1] border-ink bg-ink text-[#f2eee2]'
                  : 'text-soft hover:bg-paper-alt hover:text-ink',
              )}
              title={f.hint}
            >
              {f.label}
            </button>
          ))}
          {matrix && (
            <span className="ml-3 inline-flex items-center gap-1.5 font-mono text-[10px] uppercase leading-none tracking-[var(--wide)] text-mute">
              {t('matrix.canonicalLabel')}
              <PlatformBadge platformId={matrix.canonicalPlatform} canonical />
              <Crown className="h-2.5 w-2.5 -translate-y-px text-red-brand" />
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {orphanTotal > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={handlePromoteAll}
              disabled={busy}
              title={t('matrix.bulk.promote.title')}
            >
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              {orphanTotal === 1
                ? t('matrix.bulk.promote', { count: orphanTotal })
                : t('matrix.bulk.promotePlural', { count: orphanTotal })}
            </Button>
          )}
          <Button
            size="sm"
            onClick={handleSyncAllGaps}
            disabled={busy || syncableTotal === 0}
            title={
              syncableTotal === 0
                ? t('matrix.bulk.sync.titleNone')
                : t('matrix.bulk.sync.title')
            }
          >
            <Zap className="mr-1.5 h-3.5 w-3.5" />
            {syncableTotal === 1
              ? t('matrix.bulk.sync', { count: syncableTotal })
              : t('matrix.bulk.syncPlural', { count: syncableTotal })}
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1 scrollbar-thin">
        <div className="px-4 py-3">
          <Table
            matrix={matrix}
            rows={visibleRows}
            selectedSkillId={selectedSkillId}
            onSyncRow={handleSyncRow}
            onPromoteRow={handlePromoteRow}
            onSelectRow={onSelectSkill}
            busy={busy}
          />
          {matrix && visibleRows.length > 0 && <Legend />}
        </div>
      </ScrollArea>

      <SyncConfirm
        open={planOpen}
        plan={pendingPlan}
        canonicalPlatform={matrix?.canonicalPlatform ?? 'shared'}
        onOpenChange={setPlanOpen}
        onApplied={onApplied}
      />
    </div>
  );
}

function Table({
  matrix,
  rows,
  selectedSkillId,
  onSyncRow,
  onPromoteRow,
  onSelectRow,
  busy,
}: {
  matrix: CoverageMatrix | null;
  rows: CoverageRow[];
  selectedSkillId: string | null;
  onSyncRow: (r: CoverageRow) => void;
  onPromoteRow: (r: CoverageRow) => void;
  onSelectRow: (id: string) => void;
  busy: boolean;
}) {
  const t = useT();
  if (!matrix) {
    return <div className="p-6 text-sm text-muted-foreground">{t('matrix.loading')}</div>;
  }
  if (rows.length === 0) {
    // Two distinct empty states: nothing in the workspace at all (offer
    // next steps), vs the active filter has no matches (just a hint).
    const noSkillsAnywhere = matrix.rows.length === 0;
    if (noSkillsAnywhere) {
      return <EmptyCoverageGuidance />;
    }
    return (
      <div className="p-6 text-sm text-muted-foreground">{t('matrix.empty')}</div>
    );
  }
  return (
    // Editorial-table look: mono uppercase column headers in muted color,
    // header bottom border is INK (not the lighter rule used between rows)
    // so the head/body separation is the dominant rule. Canonical column
    // header (and cells) wear the brand red — the matrix's only red.
    <table className="w-full">
      <thead className="sticky top-0 z-10 bg-paper">
        <tr className="border-b-2 border-ink">
          <th className="px-3 py-2.5 text-left font-mono text-[10px] uppercase tracking-[var(--wide)] font-semibold text-soft align-bottom">
            {t('matrix.col.skill')}
          </th>
          {matrix.platforms.map((p) => {
            const isCanon = p === matrix.canonicalPlatform;
            return (
              <th
                key={p}
                className={cn(
                  'px-3 py-2.5 text-center font-mono text-[10px] uppercase tracking-[var(--wide)] font-semibold align-bottom',
                  isCanon ? 'text-red-brand' : 'text-soft',
                )}
              >
                <div className="inline-flex items-center gap-1">
                  {isCanon && (
                    <Crown className="h-2.5 w-2.5 -translate-y-px text-red-brand" aria-label="canonical platform" />
                  )}
                  <PlatformBadge platformId={p} canonical={isCanon} />
                </div>
              </th>
            );
          })}
          <th className="w-44 px-3 py-2.5 text-right font-mono text-[10px] uppercase tracking-[var(--wide)] font-semibold text-soft align-bottom">
            {t('matrix.col.action')}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const targets = row.missingOn.filter((p) => p !== matrix.canonicalPlatform);
          const gapCount = targets.length;
          const staleCount = matrix.platforms.filter(
            (p) => p !== matrix.canonicalPlatform && row.cells[p]?.drift === 'stale',
          ).length;
          const isOrphan = !row.hasCanonicalSource;
          const canSync = row.hasCanonicalSource && (gapCount > 0 || staleCount > 0);
          const isSelected = selectedSkillId === row.skillId;

          let actionNode: React.ReactNode;
          if (isOrphan) {
            actionNode = (
              <Button size="sm" variant="outline" onClick={() => onPromoteRow(row)} disabled={busy}>
                {t('matrix.action.promote')}
              </Button>
            );
          } else if (canSync) {
            const label =
              gapCount > 0 && staleCount > 0
                ? t('matrix.action.syncTotal', { count: gapCount + staleCount })
                : staleCount > 0
                ? t('matrix.action.replaceStale', { count: staleCount })
                : gapCount === 1
                ? t('matrix.action.fillGap', { count: gapCount })
                : t('matrix.action.fillGaps', { count: gapCount });
            actionNode = (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onSyncRow(row)}
                disabled={busy}
                title={
                  staleCount > 0
                    ? t('matrix.action.syncTitle.stale', { count: staleCount })
                    : undefined
                }
              >
                {label}
              </Button>
            );
          } else {
            actionNode = (
              <span className="font-mono text-[10px] uppercase leading-none tracking-[0.08em] text-soft">
                {t('matrix.action.inSync')}
              </span>
            );
          }

          return (
            <tr
              key={row.skillId}
              onClick={() => onSelectRow(row.skillId)}
              className={cn(
                'cursor-pointer border-b border-rule transition-colors',
                'hover:bg-[rgba(20,18,13,0.025)]',
                isSelected && 'bg-[rgba(225,70,43,0.06)]',
                isOrphan && 'bg-[rgba(20,18,13,0.02)]',
              )}
            >
              <td className="px-3 py-3 align-middle">
                <div className="truncate max-w-[280px] text-[13px] font-medium text-ink" title={row.skillName}>
                  {row.skillName}
                </div>
                {row.description && (
                  <div
                    className="truncate text-[11.5px] leading-[1.4] text-mute max-w-[280px] mt-0.5"
                    title={row.description}
                  >
                    {row.description}
                  </div>
                )}
              </td>
              {matrix.platforms.map((p) => {
                const cell = row.cells[p];
                const isCanon = p === matrix.canonicalPlatform;
                return (
                  <td
                    key={p}
                    className={cn(
                      'px-3 py-3 text-center align-middle',
                      // Canonical column gets a soft vermillion wash —
                      // subtle enough not to compete with broken/stale,
                      // but enough to read "this column is special".
                      isCanon && 'bg-[rgba(225,70,43,0.04)]',
                    )}
                  >
                    <CellGlyph
                      state={cell?.state ?? 'missing'}
                      drift={cell?.drift}
                      isCanonical={isCanon}
                    />
                  </td>
                );
              })}
              <td className="px-3 py-3 text-right align-middle" onClick={(e) => e.stopPropagation()}>
                {actionNode}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function CellGlyph({
  state,
  drift,
  isCanonical,
}: {
  state: CoverageCellState;
  drift?: CoverageDrift;
  isCanonical: boolean;
}) {
  const t = useT();
  const stale = drift === 'stale';
  const label = describeCell(state, drift, isCanonical, t);
  const wrapper = (icon: React.ReactNode, tone: string) => (
    <span className={cn('inline-flex items-center gap-1', tone)} title={label} aria-label={label}>
      {icon}
      {stale && <span className="text-[9px] uppercase tracking-wider">{t('matrix.cellTag.stale')}</span>}
    </span>
  );
  switch (state) {
    case 'present':
      return wrapper(
        <Check className="h-4 w-4" />,
        isCanonical ? 'text-amber-600' : stale ? 'text-amber-600' : 'text-emerald-600',
      );
    case 'symlink':
      return wrapper(<Link2 className="h-4 w-4" />, 'text-blue-600');
    case 'symlink_other':
      return wrapper(<Link2 className="h-4 w-4 -rotate-45" />, 'text-amber-700');
    case 'broken':
      return wrapper(<AlertTriangle className="h-4 w-4" />, 'text-destructive');
    case 'disabled':
      return wrapper(<EyeOff className="h-4 w-4" />, 'text-muted-foreground');
    case 'missing':
    default:
      return wrapper(<Minus className="h-4 w-4 text-muted-foreground/40" />, '');
  }
}

function describeCell(
  state: CoverageCellState,
  drift: CoverageDrift | undefined,
  isCanonical: boolean,
  t: ReturnType<typeof useT>,
): string {
  switch (state) {
    case 'present':
      if (isCanonical) return t('matrix.cell.canonical');
      if (drift === 'stale') return t('matrix.cell.stale');
      if (drift === 'only_here') return t('matrix.cell.onlyHere');
      return t('matrix.cell.present');
    case 'symlink':
      return t('matrix.cell.symlink');
    case 'symlink_other':
      return t('matrix.cell.symlink_other');
    case 'broken':
      return t('matrix.cell.broken');
    case 'disabled':
      return t('matrix.cell.disabled');
    case 'missing':
    default:
      return t('matrix.cell.missing');
  }
}

function Legend() {
  const t = useT();
  return (
    // Mono-uppercase legend on a hairline top rule — same editorial
    // language as the prototype's footer compliance row. No card; the
    // rule does the separation work.
    <div className="mt-6 border-t border-rule pt-3 font-mono text-[10px] uppercase leading-none tracking-[0.06em] text-mute">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
        <span className="inline-flex items-center gap-1.5">
          <Crown className="h-2.5 w-2.5 -translate-y-px text-red-brand" /> {t('matrix.legend.canonical')}
        </span>
        <span className="inline-flex items-center gap-1.5 text-soft">
          <Check className="h-2.5 w-2.5 -translate-y-px" /> {t('matrix.legend.inSync')}
        </span>
        <span className="inline-flex items-center gap-1.5 text-amber-warn">
          <Check className="h-2.5 w-2.5 -translate-y-px" /> {t('matrix.legend.stale')}
        </span>
        <span className="inline-flex items-center gap-1.5 text-soft">
          <Link2 className="h-2.5 w-2.5 -translate-y-px" /> {t('matrix.legend.symlinkCanonical')}
        </span>
        <span className="inline-flex items-center gap-1.5 text-amber-warn">
          <Link2 className="h-2.5 w-2.5 -translate-y-px -rotate-45" /> {t('matrix.legend.symlinkOther')}
        </span>
        <span className="inline-flex items-center gap-1.5 text-red-brand">
          <AlertTriangle className="h-2.5 w-2.5 -translate-y-px" /> {t('matrix.legend.broken')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <EyeOff className="h-2.5 w-2.5 -translate-y-px" /> {t('matrix.legend.disabled')}
        </span>
        <span className="inline-flex items-center gap-1.5 opacity-50">
          <Minus className="h-2.5 w-2.5 -translate-y-px" /> {t('matrix.legend.missing')}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-2 normal-case tracking-normal">
        <HelpCircle className="h-3 w-3" />
        {t('matrix.legend.help')}
      </div>
    </div>
  );
}

/**
 * Shown when the matrix has zero rows total (no skills anywhere on disk),
 * not when the active filter happens to be empty. Gives the user three
 * concrete next steps instead of a flat "No skills" line.
 */
function EmptyCoverageGuidance() {
  const t = useT();
  return (
    <div className="mx-auto mt-8 max-w-md px-6">
      <div className="rounded-lg border bg-card p-5">
        <h2 className="text-base font-semibold">{t('matrix.empty.guidance.title')}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('matrix.empty.guidance.body')}
        </p>
        <ul className="mt-4 space-y-2">
          <li className="flex items-start gap-3 rounded-md border bg-background p-3">
            <Globe className="mt-0.5 h-4 w-4 shrink-0 text-violet-500" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">
                {t('matrix.empty.guidance.discover.title')}
              </div>
              <div className="text-xs text-muted-foreground">
                {t('matrix.empty.guidance.discover.body')}
              </div>
            </div>
          </li>
          <li className="flex items-start gap-3 rounded-md border bg-background p-3">
            <SettingsIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">
                <Link
                  href="/settings"
                  className="hover:underline focus-visible:outline-none focus-visible:underline"
                >
                  {t('matrix.empty.guidance.settings.title')}
                </Link>
              </div>
              <div className="text-xs text-muted-foreground">
                {t('matrix.empty.guidance.settings.body')}
              </div>
            </div>
          </li>
          <li className="flex items-start gap-3 rounded-md border bg-background p-3">
            <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">
                {t('matrix.empty.guidance.rescan.title')}
              </div>
              <div className="text-xs text-muted-foreground">
                {t('matrix.empty.guidance.rescan.body')}
              </div>
            </div>
          </li>
        </ul>
      </div>
    </div>
  );
}
