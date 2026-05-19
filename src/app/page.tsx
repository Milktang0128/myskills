'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
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
  List,
  Layers,
  Settings as SettingsIcon,
  History as HistoryIcon,
} from 'lucide-react';
import type {
  CoverageDrift,
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
  { value: 'gaps', label: 'Has gaps', hint: 'a non-canonical platform is missing this skill' },
  { value: 'orphans', label: 'Orphans', hint: 'present somewhere but missing from the canonical platform' },
  { value: 'drift', label: 'Drift', hint: 'content hash differs from canonical' },
  { value: 'broken', label: 'Broken', hint: 'a symlink target is missing' },
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

  useEffect(() => {
    if (!bridgeReady) return;
    const off = api.on.scanFinished(() => refresh());
    return () => off();
  }, [bridgeReady, refresh]);

  const filteredRows = useMemo(() => {
    if (!matrix) return [];
    const q = search.trim().toLowerCase();
    return matrix.rows.filter((r) => {
      if (q) {
        if (!r.skillName.toLowerCase().includes(q) && !(r.description ?? '').toLowerCase().includes(q)) {
          return false;
        }
      }
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
  }, [matrix, filter, search]);

  const fillableGapTotal = useMemo(
    () =>
      matrix
        ? matrix.rows.reduce(
            (acc, r) =>
              acc +
              (r.hasCanonicalSource
                ? r.missingOn.filter((p) => p !== matrix.canonicalPlatform).length
                : 0),
            0,
          )
        : 0,
    [matrix],
  );

  const orphanTotal = useMemo(
    () => (matrix ? matrix.rows.filter((r) => !r.hasCanonicalSource).length : 0),
    [matrix],
  );

  async function handleSyncRow(row: CoverageRow) {
    if (!matrix) return;
    setBusy(true);
    try {
      const targets = row.missingOn.filter((p) => p !== matrix.canonicalPlatform);
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
      const plan = await api.sync.planPromote([row.skillId]);
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
      const requests = matrix.rows
        .filter((r) => r.hasCanonicalSource)
        .map((r) => ({
          skillId: r.skillId,
          targetPlatformIds: r.missingOn.filter((p) => p !== matrix.canonicalPlatform),
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
    if (!matrix) return;
    setBusy(true);
    try {
      const skillIds = matrix.rows.filter((r) => !r.hasCanonicalSource).map((r) => r.skillId);
      const plan = await api.sync.planPromote(skillIds);
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
        <div className="titlebar-no-drag flex items-center gap-3">
          <h1 className="text-sm font-semibold">Coverage</h1>
          <NavLink href="/library" icon={<List className="h-3.5 w-3.5" />}>Library</NavLink>
          <NavLink href="/scenarios" icon={<Layers className="h-3.5 w-3.5" />}>Scenarios</NavLink>
          <NavLink href="/history" icon={<HistoryIcon className="h-3.5 w-3.5" />}>History</NavLink>
          <NavLink href="/settings" icon={<SettingsIcon className="h-3.5 w-3.5" />}>Settings</NavLink>
          {matrix && (
            <div className="ml-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>
                {filteredRows.length} / {matrix.rows.length} skills
              </span>
              <span>·</span>
              <span className="inline-flex items-center gap-1">
                Canonical:
                <PlatformBadge platformId={matrix.canonicalPlatform} />
                <Crown className="h-3 w-3 text-amber-500" aria-label="canonical" />
              </span>
            </div>
          )}
        </div>
        <div className="titlebar-no-drag flex items-center gap-2">
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
            disabled={busy || fillableGapTotal === 0}
            title={fillableGapTotal === 0 ? 'No gaps fillable from canonical' : ''}
          >
            <Zap className="mr-1.5 h-3.5 w-3.5" />
            Fill {fillableGapTotal} gap{fillableGapTotal === 1 ? '' : 's'}
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
          <CoverageTable
            matrix={matrix}
            rows={filteredRows}
            onSyncRow={handleSyncRow}
            onPromoteRow={handlePromoteRow}
            busy={busy}
          />
          {matrix && filteredRows.length > 0 && <Legend />}
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
        canonicalPlatform={matrix?.canonicalPlatform ?? 'shared'}
        onOpenChange={setPlanOpen}
        onApplied={onApplied}
      />
    </main>
  );
}

function CoverageTable({
  matrix,
  rows,
  onSyncRow,
  onPromoteRow,
  busy,
}: {
  matrix: CoverageMatrix | null;
  rows: CoverageRow[];
  onSyncRow: (r: CoverageRow) => void;
  onPromoteRow: (r: CoverageRow) => void;
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
              <div className="inline-flex items-center gap-1">
                <PlatformBadge platformId={p} />
                {p === matrix.canonicalPlatform && (
                  <Crown className="h-3 w-3 text-amber-500" aria-label="canonical platform" />
                )}
              </div>
            </th>
          ))}
          <th className="px-3 py-2 text-right font-medium w-44">Action</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const targets = row.missingOn.filter((p) => p !== matrix.canonicalPlatform);
          const canFillGaps = row.hasCanonicalSource && targets.length > 0;
          const isOrphan = !row.hasCanonicalSource;
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
              {matrix.platforms.map((p) => {
                const cell = row.cells[p];
                return (
                  <td key={p} className="px-3 py-2 text-center">
                    <CellGlyph
                      state={cell?.state ?? 'missing'}
                      drift={cell?.drift}
                      isCanonical={p === matrix.canonicalPlatform}
                    />
                  </td>
                );
              })}
              <td className="px-3 py-2 text-right">
                {isOrphan ? (
                  <Button size="sm" variant="outline" onClick={() => onPromoteRow(row)} disabled={busy}>
                    Promote
                  </Button>
                ) : canFillGaps ? (
                  <Button size="sm" variant="outline" onClick={() => onSyncRow(row)} disabled={busy}>
                    Fill {targets.length} gap{targets.length === 1 ? '' : 's'}
                  </Button>
                ) : (
                  <span className="text-[11px] text-emerald-600">in sync</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

interface CellGlyphProps {
  state: CoverageCellState;
  drift?: CoverageDrift;
  isCanonical: boolean;
}

function CellGlyph({ state, drift, isCanonical }: CellGlyphProps) {
  // Stale = present on this platform but content differs from canonical.
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
      return wrapper(<Check className="h-4 w-4" />, isCanonical ? 'text-amber-600' : (stale ? 'text-amber-600' : 'text-emerald-600'));
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

function describeCell(state: CoverageCellState, drift: CoverageDrift | undefined, isCanonical: boolean): string {
  switch (state) {
    case 'present':
      if (isCanonical) return 'Canonical: source of truth for this skill';
      if (drift === 'stale') return 'Present, but content differs from canonical (stale)';
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

function NavLink({ href, icon, children }: { href: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {icon}
      {children}
    </Link>
  );
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
