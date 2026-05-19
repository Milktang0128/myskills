'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Check,
  Link2,
  Minus,
  AlertTriangle,
  EyeOff,
  Zap,
  HelpCircle,
} from 'lucide-react';
import type {
  CoverageFilter,
  CoverageMatrix,
  CoverageRow,
  CoverageCellState,
  PlatformId,
  SyncExecuteResult,
  SyncPlan,
} from '@shared/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { PlatformBadge } from '@/components/platform-badge';
import { SyncConfirm } from '@/components/sync-confirm';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

const FILTERS: { value: CoverageFilter; label: string; hint: string }[] = [
  { value: 'all', label: 'All', hint: 'every skill' },
  { value: 'gaps', label: 'Has gaps', hint: 'missing on ≥1 platform' },
  { value: 'shared_not_propagated', label: 'Shared not propagated', hint: 'in Shared but missing on Claude or Codex' },
  { value: 'orphan', label: 'Orphan', hint: 'present on exactly one platform' },
  { value: 'broken', label: 'Broken', hint: 'has at least one broken-link cell' },
];

export default function CoveragePage() {
  const [matrix, setMatrix] = useState<CoverageMatrix | null>(null);
  const [filter, setFilter] = useState<CoverageFilter>('gaps');
  const [search, setSearch] = useState('');
  const [bridgeReady, setBridgeReady] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<SyncPlan | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const refresh = useCallback(async () => {
    if (!bridgeReady) return;
    setMatrix(await api.coverage.matrix());
  }, [bridgeReady]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const filteredRows = useMemo(() => {
    if (!matrix) return [];
    const q = search.trim().toLowerCase();
    return matrix.rows.filter((r) => {
      if (q) {
        if (!r.skillName.toLowerCase().includes(q) && !(r.description ?? '').toLowerCase().includes(q)) {
          return false;
        }
      }
      const presentCount = matrix.platforms.filter(
        (p) => r.cells[p]?.state !== 'missing',
      ).length;
      const anyBroken = matrix.platforms.some((p) => r.cells[p]?.state === 'broken');

      switch (filter) {
        case 'gaps':
          return r.missingOn.length > 0;
        case 'shared_not_propagated':
          return r.hasSharedSource && r.missingOn.some((p) => p !== 'shared');
        case 'orphan':
          return presentCount === 1;
        case 'broken':
          return anyBroken;
        default:
          return true;
      }
    });
  }, [matrix, filter, search]);

  const totalCanSync = useMemo(
    () =>
      filteredRows.reduce(
        (acc, r) => acc + (r.hasSharedSource ? r.missingOn.filter((p) => p !== 'shared').length : 0),
        0,
      ),
    [filteredRows],
  );

  async function planForRow(row: CoverageRow): Promise<SyncPlan> {
    const targets = row.missingOn.filter((p) => p !== 'shared');
    return api.sync.plan([{ skillId: row.skillId, targetPlatformIds: targets }]);
  }

  async function planAllVisible(): Promise<SyncPlan> {
    const requests = filteredRows
      .filter((r) => r.hasSharedSource)
      .map((r) => ({
        skillId: r.skillId,
        targetPlatformIds: r.missingOn.filter((p) => p !== 'shared'),
      }))
      .filter((r) => r.targetPlatformIds.length > 0);
    return api.sync.plan(requests);
  }

  async function handleSyncRow(row: CoverageRow) {
    setBusy(true);
    try {
      const plan = await planForRow(row);
      setPendingPlan(plan);
      setPlanOpen(true);
    } finally {
      setBusy(false);
    }
  }

  async function handleSyncAll() {
    setBusy(true);
    try {
      const plan = await planAllVisible();
      setPendingPlan(plan);
      setPlanOpen(true);
    } finally {
      setBusy(false);
    }
  }

  function onApplied(result: SyncExecuteResult) {
    setToast(
      `Applied ${result.applied.length} • Skipped ${result.skipped.length}${
        result.failed.length ? ` • Failed ${result.failed.length}` : ''
      }`,
    );
    refresh();
    setTimeout(() => setToast(null), 4000);
  }

  return (
    <main className="flex h-screen w-screen flex-col overflow-hidden">
      <header className="titlebar-drag flex h-12 shrink-0 items-center justify-between border-b pl-[88px] pr-4">
        <div className="titlebar-no-drag flex items-center gap-2">
          <Link
            href="/"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-accent"
            aria-label="Back"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <h1 className="text-sm font-semibold">Coverage</h1>
          {matrix && (
            <span className="text-xs text-muted-foreground">
              {filteredRows.length} / {matrix.rows.length} skills
            </span>
          )}
        </div>
        <div className="titlebar-no-drag flex items-center gap-2">
          <Button
            size="sm"
            onClick={handleSyncAll}
            disabled={busy || totalCanSync === 0}
            title={totalCanSync === 0 ? 'No gaps fillable from Shared' : ''}
          >
            <Zap className="mr-1.5 h-3.5 w-3.5" />
            Sync all gaps ({totalCanSync})
          </Button>
        </div>
      </header>

      <div className="border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            className="max-w-xs"
          />
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((f) => (
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
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1 scrollbar-thin">
        <div className="px-4 py-3">
          <Table matrix={matrix} rows={filteredRows} onSyncRow={handleSyncRow} busy={busy} />
        </div>
      </ScrollArea>

      {toast && (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 flex justify-center">
          <div className="pointer-events-auto rounded-md border bg-card px-4 py-2 text-sm shadow-lg">
            {toast}
          </div>
        </div>
      )}

      <SyncConfirm
        open={planOpen}
        plan={pendingPlan}
        onOpenChange={setPlanOpen}
        onApplied={onApplied}
      />
    </main>
  );
}

function Table({
  matrix,
  rows,
  onSyncRow,
  busy,
}: {
  matrix: CoverageMatrix | null;
  rows: CoverageRow[];
  onSyncRow: (r: CoverageRow) => void;
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
            <th key={p} className="px-3 py-2 text-center font-medium">
              <PlatformBadge platformId={p} />
            </th>
          ))}
          <th className="px-3 py-2 text-right font-medium w-32">Action</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const targets = row.missingOn.filter((p) => p !== 'shared');
          const canSync = row.hasSharedSource && targets.length > 0;
          return (
            <tr key={row.skillId} className="border-b hover:bg-accent/30">
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
              {matrix.platforms.map((p) => (
                <td key={p} className="px-3 py-2 text-center">
                  <CellGlyph state={row.cells[p]?.state ?? 'missing'} />
                </td>
              ))}
              <td className="px-3 py-2 text-right">
                {canSync ? (
                  <Button size="sm" variant="outline" onClick={() => onSyncRow(row)} disabled={busy}>
                    Sync {targets.length}
                  </Button>
                ) : !row.hasSharedSource ? (
                  <span
                    className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
                    title="Skill is not in the Shared pool — nothing to sync from"
                  >
                    <HelpCircle className="h-3 w-3" /> no source
                  </span>
                ) : (
                  <span className="text-[11px] text-emerald-600">complete</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function CellGlyph({ state }: { state: CoverageCellState }) {
  switch (state) {
    case 'present':
      return <Check className="mx-auto h-4 w-4 text-emerald-600" aria-label="present" />;
    case 'symlink':
      return <Link2 className="mx-auto h-4 w-4 text-blue-600" aria-label="symlink" />;
    case 'symlink_other':
      return <Link2 className="mx-auto h-4 w-4 text-amber-600" aria-label="symlink to external" />;
    case 'broken':
      return <AlertTriangle className="mx-auto h-4 w-4 text-destructive" aria-label="broken" />;
    case 'disabled':
      return <EyeOff className="mx-auto h-4 w-4 text-muted-foreground" aria-label="disabled" />;
    case 'missing':
    default:
      return <Minus className="mx-auto h-4 w-4 text-muted-foreground/40" aria-label="missing" />;
  }
}
