'use client';

import { useEffect, useMemo, useState } from 'react';
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
} from 'lucide-react';
import type {
  CoverageDrift,
  CoverageFilter,
  CoverageMatrix,
  CoverageRow,
  CoverageCellState,
  PlatformId,
  SkillFilter,
  SyncExecuteResult,
  SyncPlan,
} from '@shared/types';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { PlatformBadge } from '@/components/platform-badge';
import { SyncConfirm } from '@/components/sync-confirm';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

const MATRIX_FILTERS: { value: CoverageFilter; label: string; hint: string }[] = [
  { value: 'all', label: 'All', hint: 'every skill in the filter set' },
  { value: 'gaps', label: 'Has gaps', hint: 'a non-canonical platform is missing this skill' },
  { value: 'orphans', label: 'Orphans', hint: 'present somewhere but missing from canonical' },
  { value: 'drift', label: 'Drift', hint: 'content hash differs from canonical' },
  { value: 'broken', label: 'Broken', hint: 'a symlink target is missing' },
];

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
  const [matrix, setMatrix] = useState<CoverageMatrix | null>(null);
  const [filter, setFilter] = useState<CoverageFilter>('all');
  const [pendingPlan, setPendingPlan] = useState<SyncPlan | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bridgeReady, setBridgeReady] = useState(false);

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
    onToast(
      `Applied ${result.applied.length} • Skipped ${result.skipped.length}${
        result.failed.length ? ` • Failed ${result.failed.length}` : ''
      }`,
    );
    refresh();
    onMutated?.();
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {MATRIX_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={cn(
                'rounded-md border px-2.5 py-1 text-xs',
                filter === f.value
                  ? 'border-transparent bg-primary text-primary-foreground'
                  : 'hover:bg-accent',
              )}
              title={f.hint}
            >
              {f.label}
            </button>
          ))}
          {matrix && (
            <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
              Canonical:
              <PlatformBadge platformId={matrix.canonicalPlatform} />
              <Crown className="h-3 w-3 text-amber-500" />
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
              title="Copy each orphan into the canonical platform, then symlink the original to it"
            >
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              Promote {orphanTotal} orphan{orphanTotal === 1 ? '' : 's'}
            </Button>
          )}
          <Button
            size="sm"
            onClick={handleSyncAllGaps}
            disabled={busy || syncableTotal === 0}
            title={syncableTotal === 0 ? 'Nothing to sync — every visible row is in sync or has no canonical source' : 'Includes missing and stale platforms'}
          >
            <Zap className="mr-1.5 h-3.5 w-3.5" />
            Sync {syncableTotal} {syncableTotal === 1 ? 'gap/stale' : 'gaps/stale'}
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
  if (!matrix) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }
  if (rows.length === 0) {
    return <div className="p-6 text-sm text-muted-foreground">No skills match this filter.</div>;
  }
  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur">
        <tr className="border-b">
          <th className="px-3 py-2 text-left font-medium">Skill</th>
          {matrix.platforms.map((p) => (
            <th
              key={p}
              className={cn(
                'px-3 py-2 text-center font-medium',
                p === matrix.canonicalPlatform && 'bg-amber-50/60 dark:bg-amber-950/20',
              )}
            >
              <div className="inline-flex items-center gap-1">
                {p === matrix.canonicalPlatform && (
                  <Crown className="h-3 w-3 text-amber-500" aria-label="canonical platform" />
                )}
                <PlatformBadge platformId={p} />
              </div>
            </th>
          ))}
          <th className="px-3 py-2 text-right font-medium w-44">Action</th>
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
                Promote
              </Button>
            );
          } else if (canSync) {
            const label =
              gapCount > 0 && staleCount > 0
                ? `Sync ${gapCount + staleCount} total`
                : staleCount > 0
                ? `Replace ${staleCount} stale`
                : `Fill ${gapCount} gap${gapCount === 1 ? '' : 's'}`;
            actionNode = (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onSyncRow(row)}
                disabled={busy}
                title={
                  staleCount > 0
                    ? `${staleCount} platform${staleCount === 1 ? '' : 's'} have stale content — they will be backed up and replaced with a symlink to canonical`
                    : undefined
                }
              >
                {label}
              </Button>
            );
          } else {
            actionNode = <span className="text-[11px] text-emerald-600">in sync</span>;
          }

          return (
            <tr
              key={row.skillId}
              onClick={() => onSelectRow(row.skillId)}
              className={cn(
                'cursor-pointer border-b hover:bg-accent/30',
                isSelected && 'bg-accent/50',
              )}
            >
              <td className="px-3 py-2">
                <div className="font-medium truncate max-w-[280px]" title={row.skillName}>
                  {row.skillName}
                </div>
                {row.description && (
                  <div
                    className="truncate text-[11px] text-muted-foreground max-w-[280px]"
                    title={row.description}
                  >
                    {row.description}
                  </div>
                )}
              </td>
              {matrix.platforms.map((p) => {
                const cell = row.cells[p];
                return (
                  <td
                    key={p}
                    className={cn(
                      'px-3 py-2 text-center',
                      p === matrix.canonicalPlatform && 'bg-amber-50/40 dark:bg-amber-950/10',
                    )}
                  >
                    <CellGlyph
                      state={cell?.state ?? 'missing'}
                      drift={cell?.drift}
                      isCanonical={p === matrix.canonicalPlatform}
                    />
                  </td>
                );
              })}
              <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
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
  const stale = drift === 'stale';
  const label = describeCell(state, drift, isCanonical);
  const wrapper = (icon: React.ReactNode, tone: string) => (
    <span className={cn('inline-flex items-center gap-1', tone)} title={label} aria-label={label}>
      {icon}
      {stale && <span className="text-[9px] uppercase tracking-wider">stale</span>}
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
): string {
  switch (state) {
    case 'present':
      if (isCanonical) return 'Canonical: source of truth for this skill';
      if (drift === 'stale') return 'Stale — content differs from canonical. Open skill detail to Adopt this version, or use the row Sync to back this up and replace with canonical';
      if (drift === 'only_here') return 'Present here only — canonical is missing this skill (orphan)';
      return 'Present';
    case 'symlink':
      return 'Symlinked into canonical (in sync)';
    case 'symlink_other':
      return 'Symlinked, but to a non-canonical location';
    case 'broken':
      return 'Symlink target is missing';
    case 'disabled':
      return 'Disabled (moved to .disabled/)';
    case 'missing':
    default:
      return 'Missing on this platform';
  }
}

function Legend() {
  return (
    <div className="mt-4 rounded-md border bg-card/40 px-3 py-2 text-[11px] text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <span className="inline-flex items-center gap-1">
          <Crown className="h-3 w-3 text-amber-500" /> canonical column
        </span>
        <span className="inline-flex items-center gap-1">
          <Check className="h-3 w-3 text-emerald-600" /> present, in sync
        </span>
        <span className="inline-flex items-center gap-1">
          <Check className="h-3 w-3 text-amber-600" /> present, <em>stale</em>
        </span>
        <span className="inline-flex items-center gap-1">
          <Link2 className="h-3 w-3 text-blue-600" /> symlink → canonical
        </span>
        <span className="inline-flex items-center gap-1">
          <Link2 className="h-3 w-3 -rotate-45 text-amber-700" /> symlink → elsewhere
        </span>
        <span className="inline-flex items-center gap-1">
          <AlertTriangle className="h-3 w-3 text-destructive" /> broken
        </span>
        <span className="inline-flex items-center gap-1">
          <EyeOff className="h-3 w-3 text-muted-foreground" /> disabled
        </span>
        <span className="inline-flex items-center gap-1">
          <Minus className="h-3 w-3 text-muted-foreground/40" /> missing
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <HelpCircle className="h-3 w-3" />
        Hover any cell for details. Change canonical platform in Settings.
      </div>
    </div>
  );
}
