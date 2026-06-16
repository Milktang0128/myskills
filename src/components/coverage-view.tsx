'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Link2,
  Minus,
  Plus,
  AlertTriangle,
  EyeOff,
  ChevronDown,
  HelpCircle,
  Globe,
  Settings as SettingsIcon,
  RefreshCw,
  FolderOpen,
  Copy,
  ArrowUpToLine,
  Replace,
  Wrench,
  ListChecks,
  ArrowLeftRight,
  Crown,
  FilePlus2,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { STATUS_TONE } from '@/lib/status-tones';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import type {
  CoverageCell,
  CoverageDrift,
  CoverageFilter,
  CoverageMatrix,
  CoverageRow,
  CoverageCellState,
  SkillFilter,
  SyncExecuteResult,
  SyncPlan,
} from '@shared/types';
import { isPlanSafeToAutoApply } from '@shared/types';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { PlatformBadge } from '@/components/platform-badge';
import { SyncConfirm } from '@/components/sync-confirm';
import type { ToastAction } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface Props {
  /** Sidebar/search filter from the workspace; matrix narrows rows accordingly. */
  outerFilter: SkillFilter;
  /** Toast pipe — set from workspace, parent decides display. Optional action
   *  drives the "undo" affordance after a safe-instant write. */
  onToast: (msg: string, action?: ToastAction, durationMs?: number) => void;
  onSelectSkill: (id: string) => void;
  selectedSkillId: string | null;
  /** Notify workspace to refetch any shared state after a write. */
  onMutated?: () => void;
  /** Workspace navigation: empty-state guidance links into Settings. */
  onOpenSettings: () => void;
  /** Workspace navigation: empty-state guidance links into Discover. */
  onSelectDiscover?: () => void;
  /** Trigger a rescan from the empty-state guidance card. */
  onRescan?: () => void;
  /** Bumped by the workspace after an external mutation (e.g. a skill deleted
   *  or enabled/disabled from the detail panel, a fresh install) so the matrix
   *  re-fetches even though that write didn't flow through this component. */
  refreshKey?: number;
}

export function CoverageView({ outerFilter, onToast, onSelectSkill, selectedSkillId, onMutated, onOpenSettings, onSelectDiscover, onRescan, refreshKey }: Props) {
  const t = useT();
  const [matrix, setMatrix] = useState<CoverageMatrix | null>(null);
  const [filter, setFilter] = useState<CoverageFilter>('all');
  // Default "recently updated" — most user sessions start with "what did I
  // just touch?". Out-of-sync first looks tidy on paper but on a healthy
  // library many rows are already in sync, so users hit the matrix to look
  // for recent activity more often than to triage drift. Triage is still
  // one click away in the sort dropdown.
  const [sort, setSort] = useState<CoverageSort>('updated');
  const [pendingPlan, setPendingPlan] = useState<SyncPlan | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  // The row whose "需要确认" drawer is open (drift / broken / misdirected).
  const [resolveRow, setResolveRow] = useState<CoverageRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [bridgeReady, setBridgeReady] = useState(false);
  // Snapshot of rows captured the moment they were acted on. While a row's
  // skillId is in this Map, sortRows uses the snapshot's state to compute
  // sort keys — so the row visually stays where the user clicked, even
  // though the underlying data now says "in sync". Clears on sort/filter
  // change (deliberate user reset) and on view re-mount (next visit).
  const [pinnedRows, setPinnedRows] = useState<Map<string, CoverageRow>>(
    () => new Map(),
  );

  const MATRIX_FILTERS: { value: CoverageFilter; label: string; hint: string }[] = useMemo(
    () => [
      { value: 'all', label: t('matrix.filter.all'), hint: t('matrix.filter.all.hint') },
      { value: 'attention', label: t('matrix.filter.attention'), hint: t('matrix.filter.attention.hint') },
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

  // First-load failure renders an inline error + retry (a permanent "加载中…"
  // is indistinguishable from a hang); refresh failures after data exists
  // surface as a toast and keep the stale-but-usable matrix on screen.
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = async () => {
    if (!bridgeReady) return;
    try {
      setMatrix(await api.coverage.matrix());
      setLoadError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLoadError(message);
      if (matrix) onToast(t('matrix.error.load', { message }));
    }
  };

  /** Single funnel for write-path failures — every handler reports here. */
  function reportError(err: unknown) {
    onToast(err instanceof Error ? err.message : String(err));
  }

  async function presentPlan(plan: SyncPlan) {
    if (plan.items.length > 0 && plan.items.every((item) => item.action === 'skip')) {
      await api.scan.run();
      await refresh();
      onMutated?.();
      onToast(t('matrix.toast.alreadyCurrent'));
      return;
    }
    setPendingPlan(plan);
    setPlanOpen(true);
  }

  /**
   * The heart of the "safe instant / dangerous confirm" model (SPEC §9).
   * A plan whose every change is in the safe set (symlink_create / disable /
   * enable) is applied immediately with an undo toast — no dialog. Anything
   * that overwrites or moves real bytes falls through to the confirm dialog.
   */
  async function applyPlan(plan: SyncPlan, undoMessage: string) {
    if (plan.items.length > 0 && plan.items.every((i) => i.action === 'skip')) {
      await api.scan.run();
      await refresh();
      onMutated?.();
      onToast(t('matrix.toast.alreadyCurrent'));
      return;
    }
    if (!isPlanSafeToAutoApply(plan.items)) {
      // Destructive (or unresolvable conflict) → confirm path.
      setPendingPlan(plan);
      setPlanOpen(true);
      return;
    }
    const result = await api.sync.execute(plan.token);
    // Suppress the generic summary toast on this path — the undo toast below
    // is the message. Failures are folded INTO the undo toast so they aren't
    // hidden behind it.
    onApplied(result, { silent: result.undoableHistoryIds.length > 0 });
    if (result.undoableHistoryIds.length > 0) {
      const failedSuffix =
        result.failed.length > 0
          ? ` · ${t('matrix.toast.failedSuffix', { count: result.failed.length })}`
          : '';
      onToast(
        undoMessage + failedSuffix,
        { label: t('common.undo'), onClick: () => undoWrites(result.undoableHistoryIds) },
        6000,
      );
    }
  }

  async function undoWrites(historyIds: number[]) {
    setBusy(true);
    try {
      // Rollback by any one id sweeps the whole op-group; iterate distinct groups.
      for (const id of historyIds) {
        await api.sync.rollback(id);
      }
      await refresh();
      onMutated?.();
      onToast(t('matrix.toast.undone'));
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Re-fetch on first ready, and again whenever the workspace bumps refreshKey
  // after a mutation that bypassed this component (delete / enable-disable from
  // the detail panel, a fresh install). On initial mount refreshKey is 0 and
  // bridgeReady is false, so refresh() no-ops until the bridge is up.
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridgeReady, refreshKey]);

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
        case 'attention':
          // Anything not 已就绪: a gap/orphan/disabled to tidy, or a
          // divergence/broken/misdirected link to confirm.
          return !classifyRow(r, matrix).ready;
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

  const visibleRows = useMemo(() => {
    const filtered = scenarioSkillIds
      ? filteredRows.filter((r) => scenarioSkillIds.has(r.skillId))
      : filteredRows;
    if (!matrix) return filtered;
    return sortRows(filtered, sort, matrix, pinnedRows);
  }, [filteredRows, scenarioSkillIds, sort, matrix, pinnedRows]);

  // Clear pinned positions when the user takes a deliberate "re-orient"
  // action — switching sort or changing the upstream filter. Anything else
  // (refresh from scan completion, mutations on other rows) leaves pins
  // intact so the row the user just acted on stays put.
  useEffect(() => {
    setPinnedRows(new Map());
  }, [sort, outerFilter.search, outerFilter.scenarioId, outerFilter.scope, outerFilter.platforms, filter]);

  // Rows with safe housekeeping pending (gaps to fill / an orphan to spread).
  // Drives the one bulk button. 'enable' rows are excluded — re-enabling in bulk
  // is rarely what the user wants, so it stays a per-row action.
  const tidyTotal = useMemo(() => {
    if (!matrix) return 0;
    return visibleRows.filter((r) => {
      const c = classifyRow(r, matrix);
      return c.tidyKind === 'gaps' || c.tidyKind === 'orphan';
    }).length;
  }, [visibleRows, matrix]);

  // Rows that need a human decision (content diverges / link broken / link
  // misdirected). Shown as a passive count; resolved per-row, never in bulk.
  const confirmTotal = useMemo(() => {
    if (!matrix) return 0;
    return visibleRows.filter((r) => classifyRow(r, matrix).confirmCount > 0).length;
  }, [visibleRows, matrix]);

  // 整理 — the safe bucket. Fill gaps / spread an orphan / re-enable, all as a
  // single reversible action that applies instantly with an undo toast. Never
  // promotes and never overwrites a diverging copy (that's the confirm bucket).
  async function handleTidyRow(row: CoverageRow) {
    if (!matrix) return;
    const cls = classifyRow(row, matrix);
    setBusy(true);
    try {
      if (cls.tidyKind === 'enable') {
        const cell = row.cells[matrix.canonicalPlatform];
        if (!cell?.locationId) return;
        const plan = await api.sync.planToggleDisabled([
          { skillId: row.skillId, locationId: cell.locationId, disable: false },
        ]);
        await applyPlan(plan, t('matrix.toast.enabled', { skill: row.skillName }));
        return;
      }
      if (cls.tidyTargets.length === 0) return;
      const source = pickInstallSource(row, matrix, cls.tidyTargets[0]);
      if (!source) return;
      const plan = await api.sync.planFromCanonical([
        { skillId: row.skillId, targetPlatformIds: cls.tidyTargets, sourcePlatformId: source },
      ]);
      await applyPlan(plan, t('matrix.toast.tidied', { skill: row.skillName }));
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  }

  // 修复链接 — re-link broken cells from a healthy copy. Safe (creates symlinks),
  // so it applies instantly. Called from inside the 需要确认 drawer.
  async function handleRepairBroken(row: CoverageRow) {
    if (!matrix) return;
    const cls = classifyRow(row, matrix);
    if (cls.brokenPlats.length === 0) return;
    const source = pickInstallSource(row, matrix, cls.brokenPlats[0]);
    if (!source) return;
    setBusy(true);
    try {
      const plan = await api.sync.planFromCanonical([
        { skillId: row.skillId, targetPlatformIds: cls.brokenPlats, sourcePlatformId: source },
      ]);
      await applyPlan(plan, t('matrix.toast.repaired', { skill: row.skillName }));
      setResolveRow(null);
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  }

  async function handleOpenCellLocation(cell: CoverageCell) {
    if (!cell.locationId) return;
    try {
      await api.skills.openLocation(cell.locationId, 'install');
    } catch (err) {
      reportError(err);
    }
  }

  async function handleCopyCellPath(cell: CoverageCell) {
    if (!cell.locationId) return;
    try {
      await api.skills.copyLocationPath(cell.locationId, 'install');
      onToast(t('matrix.cellMenu.copied'));
    } catch (err) {
      reportError(err);
    }
  }

  async function handleMoveCellToCanonical(row: CoverageRow, platformId: string) {
    if (!matrix) return;
    const sourceLocationId = promoteSourceLocationId(row, platformId, matrix);
    setBusy(true);
    try {
      const plan = await api.sync.planPromote([
        sourceLocationId
          ? { skillId: row.skillId, sourceLocationId }
          : { skillId: row.skillId },
      ]);
      await presentPlan(plan);
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  }

  async function handleSetCellAsCopy(row: CoverageRow, platformId: string, forceReplace = false) {
    setBusy(true);
    try {
      const plan = await api.sync.planFromCanonical([
        { skillId: row.skillId, targetPlatformIds: [platformId], forceReplace },
      ]);
      await presentPlan(plan);
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  }

  // "存放技能副本" — write an independent real copy of the skill onto this
  // platform (not a symlink). Destructive (may replace an existing symlink), so
  // it goes through the confirm dialog; backed up + rollback-able.
  async function handleCopyRealToCell(row: CoverageRow, platformId: string) {
    setBusy(true);
    try {
      const plan = await api.sync.planCopyToPlatform([
        { skillId: row.skillId, targetPlatformId: platformId },
      ]);
      await presentPlan(plan);
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  }

  async function handleDisableCell(row: CoverageRow, cell: CoverageCell) {
    if (!cell.locationId) return;
    setBusy(true);
    try {
      const plan = await api.sync.planToggleDisabled([
        { skillId: row.skillId, locationId: cell.locationId, disable: true },
      ]);
      await applyPlan(plan, t('matrix.toast.disabled', { skill: row.skillName }));
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Cell-as-toggle — the cc-switch-style primary interaction. One left-click
   * flips a platform on/off; safe flips apply instantly with an undo toast,
   * dangerous ones (drift overwrite, promote, present-with-dependents) fall
   * through to the confirm dialog via applyPlan.
   */
  async function handleToggleCell(row: CoverageRow, platformId: string) {
    if (!matrix) return;
    const cell = row.cells[platformId];
    const state: CoverageCellState = cell?.state ?? 'missing';
    const skill = row.skillName;
    const enabledMsg = t('matrix.toast.enabled', { skill });
    setBusy(true);
    try {
      // OFF → ON: enable a disabled location (move back out of .disabled/).
      if (state === 'disabled') {
        if (!cell?.locationId) return;
        const plan = await api.sync.planToggleDisabled([
          { skillId: row.skillId, locationId: cell.locationId, disable: false },
        ]);
        await applyPlan(plan, enabledMsg);
        return;
      }
      // empty → ON: link this platform to wherever the skill already lives —
      // canonical if it has it, else any existing copy (the shared pool, a real
      // dir, etc.). This is a single safe symlink; it never promotes or replaces,
      // so "install here" matches the user's expectation regardless of which
      // platform happens to be the configured source.
      if (state === 'missing') {
        const sourcePlatformId = pickInstallSource(row, matrix, platformId);
        if (!sourcePlatformId) return; // nothing to link from (shouldn't happen for a visible row)
        const plan = await api.sync.planFromCanonical([
          { skillId: row.skillId, targetPlatformIds: [platformId], sourcePlatformId },
        ]);
        await applyPlan(plan, enabledMsg);
        return;
      }
      // broken symlink → repair by re-linking from an existing copy.
      if (state === 'broken') {
        const sourcePlatformId = pickInstallSource(row, matrix, platformId);
        if (!sourcePlatformId) return;
        const plan = await api.sync.planFromCanonical([
          { skillId: row.skillId, targetPlatformIds: [platformId], sourcePlatformId },
        ]);
        await applyPlan(plan, t('matrix.toast.repaired', { skill }));
        return;
      }
      // present/symlink that differs from the shared source → resolve (confirm).
      if (cell?.drift === 'stale') {
        const plan = await api.sync.planFromCanonical([
          { skillId: row.skillId, targetPlatformIds: [platformId] },
        ]);
        await applyPlan(plan, ''); // not safe → confirm dialog
        return;
      }
      // ON → OFF: disable this location (reversible move into .disabled/).
      // A real dir with live dependents comes back as a conflict → confirm.
      if (!cell?.locationId) return;
      const plan = await api.sync.planToggleDisabled([
        { skillId: row.skillId, locationId: cell.locationId, disable: true },
      ]);
      await applyPlan(plan, t('matrix.toast.disabled', { skill }));
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  }

  // 整理全部 — batch the safe housekeeping (gaps + orphans) across all visible
  // rows into one plan, then show the confirm dialog so the user sees the full
  // scope before a multi-row write. Each row links from its own existing copy.
  async function handleTidyAll() {
    if (!matrix) return;
    setBusy(true);
    try {
      const requests = visibleRows
        .map((r) => {
          const c = classifyRow(r, matrix);
          if ((c.tidyKind !== 'gaps' && c.tidyKind !== 'orphan') || c.tidyTargets.length === 0) {
            return null;
          }
          const source = pickInstallSource(r, matrix, c.tidyTargets[0]);
          if (!source) return null;
          return { skillId: r.skillId, targetPlatformIds: c.tidyTargets, sourcePlatformId: source };
        })
        .filter((r): r is NonNullable<typeof r> => r != null);
      if (requests.length === 0) return;
      const plan = await api.sync.planFromCanonical(requests);
      await presentPlan(plan);
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  }

  function onApplied(result: SyncExecuteResult, opts?: { silent?: boolean }) {
    // `silent` = the caller shows its own toast (the undo toast, which now
    // carries the failure count) — avoid stacking a redundant summary.
    if (!opts?.silent) {
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
    }
    // Pin the just-acted-on rows to their CURRENT state before refresh() pulls
    // in the new (in-sync) data. sortRows will keep using these snapshots as
    // the sort key, so the rows stay where the user clicked. Don't overwrite
    // a row that's already pinned — preserve the original anchor.
    const affected = new Set(result.applied.map((i) => i.skillId));
    if (matrix && affected.size > 0) {
      setPinnedRows((prev) => {
        const next = new Map(prev);
        for (const id of affected) {
          if (next.has(id)) continue;
          const row = matrix.rows.find((r) => r.skillId === id);
          if (row) next.set(id, row);
        }
        return next;
      });
    }
    refresh();
    onMutated?.();
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <h1 className="mr-2 text-sm font-semibold">{t('header.coverage')}</h1>
          {MATRIX_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              aria-pressed={filter === f.value}
              className={cn(
                'rounded-md border px-2.5 py-1 text-xs',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
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
        <div className="flex items-center gap-2">
          <div className="relative inline-flex items-center">
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as CoverageSort)}
              aria-label={t('matrix.sort.label')}
              title={t('matrix.sort.tooltip')}
              className="h-8 appearance-none rounded border border-input bg-background py-0.5 pl-3 pr-8 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            >
              <option value="unsynced">{t('matrix.sort.unsynced')}</option>
              <option value="updated">{t('matrix.sort.updated')}</option>
              <option value="name">{t('matrix.sort.name')}</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 h-3.5 w-3.5 text-muted-foreground" />
          </div>
          {confirmTotal > 0 && (
            <span
              className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-700 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-400"
              title={t('matrix.bulk.confirm.title')}
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {t('matrix.bulk.confirm', { count: confirmTotal })}
            </span>
          )}
          {tidyTotal > 0 && (
            <Button
              size="sm"
              onClick={handleTidyAll}
              disabled={busy}
              className="gap-1.5"
              title={t('matrix.bulk.tidy.title')}
            >
              {/* ListChecks, not Sparkles — 整理 is deterministic housekeeping;
                  sparkles are reserved for actions that call the user's AI. */}
              <ListChecks className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0">{t('matrix.bulk.tidy', { count: tidyTotal })}</span>
            </Button>
          )}
        </div>
      </div>

      <ScrollArea className="flex-1 scrollbar-thin">
        <div className="px-4 py-3">
          <Table
            matrix={matrix}
            loadError={loadError}
            onRetryLoad={refresh}
            rows={visibleRows}
            selectedSkillId={selectedSkillId}
            onTidyRow={handleTidyRow}
            onResolveRow={setResolveRow}
            onOpenCellLocation={handleOpenCellLocation}
            onCopyCellPath={handleCopyCellPath}
            onMoveCellToCanonical={handleMoveCellToCanonical}
            onSetCellAsCopy={handleSetCellAsCopy}
            onCopyReal={handleCopyRealToCell}
            onDisableCell={handleDisableCell}
            onToggleCell={handleToggleCell}
            onSelectRow={onSelectSkill}
            busy={busy}
            onOpenSettings={onOpenSettings}
            onSelectDiscover={onSelectDiscover}
            onRescan={onRescan}
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

      {matrix && (
        <RowResolveDialog
          row={resolveRow}
          matrix={matrix}
          busy={busy}
          onClose={() => setResolveRow(null)}
          onRepair={handleRepairBroken}
          onCopyPath={handleCopyCellPath}
        />
      )}
    </div>
  );
}

function Table({
  matrix,
  loadError,
  onRetryLoad,
  rows,
  selectedSkillId,
  onTidyRow,
  onResolveRow,
  onOpenCellLocation,
  onCopyCellPath,
  onMoveCellToCanonical,
  onSetCellAsCopy,
  onCopyReal,
  onDisableCell,
  onToggleCell,
  onSelectRow,
  busy,
  onOpenSettings,
  onSelectDiscover,
  onRescan,
}: {
  matrix: CoverageMatrix | null;
  loadError: string | null;
  onRetryLoad: () => void;
  rows: CoverageRow[];
  selectedSkillId: string | null;
  onTidyRow: (r: CoverageRow) => void;
  onResolveRow: (r: CoverageRow) => void;
  onOpenCellLocation: (cell: CoverageCell) => void;
  onCopyCellPath: (cell: CoverageCell) => void;
  onMoveCellToCanonical: (row: CoverageRow, platformId: string) => void;
  onSetCellAsCopy: (row: CoverageRow, platformId: string, forceReplace?: boolean) => void;
  onCopyReal: (row: CoverageRow, platformId: string) => void;
  onDisableCell: (row: CoverageRow, cell: CoverageCell) => void;
  onToggleCell: (row: CoverageRow, platformId: string) => void;
  onSelectRow: (id: string) => void;
  busy: boolean;
  onOpenSettings: () => void;
  onSelectDiscover?: () => void;
  onRescan?: () => void;
}) {
  const t = useT();
  const [openCellKey, setOpenCellKey] = useState<string | null>(null);
  if (!matrix) {
    if (loadError) {
      return (
        <div className="flex flex-col items-start gap-3 p-6 text-sm">
          <p className="text-destructive">{t('matrix.error.load', { message: loadError })}</p>
          <Button size="sm" variant="outline" onClick={onRetryLoad}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            {t('common.retry')}
          </Button>
        </div>
      );
    }
    return <div className="p-6 text-sm text-muted-foreground">{t('matrix.loading')}</div>;
  }
  if (rows.length === 0) {
    // Two distinct empty states: nothing in the workspace at all (offer
    // next steps), vs the active filter has no matches (just a hint).
    const noSkillsAnywhere = matrix.rows.length === 0;
    if (noSkillsAnywhere) {
      return (
        <EmptyCoverageGuidance
          onOpenSettings={onOpenSettings}
          onSelectDiscover={onSelectDiscover}
          onRescan={onRescan}
        />
      );
    }
    return (
      <div className="p-6 text-sm text-muted-foreground">{t('matrix.empty')}</div>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur">
        <tr className="border-b">
          <th className="px-3 py-2 text-left font-medium">{t('matrix.col.skill')}</th>
          {matrix.platforms.map((p) => (
            <th key={p} className="px-3 py-2 text-center font-medium">
              <div className="inline-flex items-center gap-1">
                {/* Small crown marks the source platform. Once a skill can hold
                    more than one real copy, the user needs to see which platform
                    is the source others link to. */}
                {p === matrix.canonicalPlatform && (
                  <Crown className="h-3 w-3 text-amber-500" aria-label={t('matrix.col.sourceMarker')} />
                )}
                <PlatformBadge platformId={p} />
              </div>
            </th>
          ))}
          <th className="px-3 py-2 text-right font-medium w-44">{t('matrix.col.action')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const cls = classifyRow(row, matrix);
          const isSelected = selectedSkillId === row.skillId;

          // Three visible states, two of which can appear side by side on one
          // row (e.g. a gap to fill AND a diverging copy to confirm). 已就绪 is
          // the quiet green default — "不在主源" folds in here with no nag.
          const tidyLabel =
            cls.tidyKind === 'enable'
              ? t('matrix.action.enable')
              : cls.tidyKind === 'orphan'
              ? t('matrix.action.spread', { count: cls.tidyCount })
              : t('matrix.action.tidy', { count: cls.tidyCount });
          const actionNode = (
            <div className="flex items-center justify-end gap-1.5">
              {cls.confirmCount > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onResolveRow(row)}
                  disabled={busy}
                  title={t('matrix.action.confirm.title')}
                  className="border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-800/60 dark:text-amber-400 dark:hover:bg-amber-900/20"
                >
                  <AlertTriangle className="mr-1 h-3.5 w-3.5 shrink-0" />
                  {t('matrix.action.confirm', { count: cls.confirmCount })}
                </Button>
              )}
              {cls.tidyKind != null && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onTidyRow(row)}
                  disabled={busy}
                  title={t('matrix.action.tidy.title')}
                >
                  {tidyLabel}
                </Button>
              )}
              {cls.ready && (
                <span className={cn('inline-flex items-center gap-1 text-[11px]', STATUS_TONE.ok)}>
                  <Check className="h-3.5 w-3.5" />
                  {t('matrix.action.ready')}
                </span>
              )}
            </div>
          );

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
                {/* Real <button> so keyboard users can Tab into the row and
                    open the detail panel — the tr's onClick only serves as a
                    larger mouse hit area. */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectRow(row.skillId);
                  }}
                  className="block w-full rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                >
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
                </button>
              </td>
              {matrix.platforms.map((p) => {
                const cell = row.cells[p];
                const cellKey = `${row.skillId}:${p}`;
                return (
                  <td
                    key={p}
                    onClick={(e) => e.stopPropagation()}
                    className="cursor-default px-3 py-2 text-center"
                  >
                    <CellActionMenu
                      row={row}
                      platformId={p}
                      matrix={matrix}
                      cell={cell}
                      open={openCellKey === cellKey}
                      busy={busy}
                      onOpenChange={(open) => setOpenCellKey(open ? cellKey : null)}
                      onToggle={onToggleCell}
                      onOpenLocation={onOpenCellLocation}
                      onCopyPath={onCopyCellPath}
                      onMoveToCanonical={onMoveCellToCanonical}
                      onSetAsCopy={onSetCellAsCopy}
                      onCopyReal={onCopyReal}
                      onDisable={onDisableCell}
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

/**
 * 需要确认 drawer — the only place that surfaces content divergence, broken
 * links, and misdirected links. Broken links get a one-click safe repair.
 * Divergence/misdirection are READ-ONLY in Phase 1 (decision: no blind
 * overwrite until a real diff+winner picker exists) — the user gets open/copy
 * affordances to compare the copies manually.
 */
type DiffState =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; left: string | null; right: string; leftLabel: string; rightLabel: string };

function RowResolveDialog({
  row,
  matrix,
  busy,
  onClose,
  onRepair,
  onCopyPath,
}: {
  row: CoverageRow | null;
  matrix: CoverageMatrix;
  busy: boolean;
  onClose: () => void;
  onRepair: (row: CoverageRow) => void;
  onCopyPath: (cell: CoverageCell) => void;
}) {
  const t = useT();
  const [diffPlat, setDiffPlat] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffState | null>(null);

  // Reset the diff view whenever the dialog is reused for a different row.
  useEffect(() => {
    setDiffPlat(null);
    setDiff(null);
  }, [row?.skillId]);

  if (!row) return null;
  const cls = classifyRow(row, matrix);
  const divergent = [...cls.driftPlats, ...cls.misdirectedPlats];
  const canonical = matrix.canonicalPlatform;

  async function openDiff(platformId: string) {
    if (!row) return;
    setDiffPlat(platformId);
    setDiff({ state: 'loading' });
    try {
      const cell = row.cells[platformId];
      const canonCell = row.cells[canonical];
      if (cell?.locationId == null) {
        setDiff({ state: 'error', message: t('matrix.resolve.diff.unreadable') });
        return;
      }
      const right = await api.skills.readLocation(cell.locationId);
      const left =
        canonCell?.locationId != null ? await api.skills.readLocation(canonCell.locationId) : null;
      setDiff({
        state: 'ready',
        left: left?.content ?? null,
        right: right.content,
        leftLabel: t('matrix.resolve.diff.reference'),
        rightLabel: platformId,
      });
    } catch (err) {
      setDiff({ state: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  const showingDiff = diffPlat != null;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className={cn(showingDiff ? 'max-w-4xl' : 'max-w-xl')}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            {t('matrix.resolve.title', { skill: row.skillName })}
          </DialogTitle>
          <DialogDescription>{t('matrix.resolve.subtitle')}</DialogDescription>
        </DialogHeader>

        {showingDiff ? (
          <div className="space-y-3">
            <button
              onClick={() => { setDiffPlat(null); setDiff(null); }}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              ← {t('matrix.resolve.diff.back')}
            </button>
            {diff?.state === 'loading' && (
              <div className="p-6 text-center text-sm text-muted-foreground">
                {t('matrix.resolve.diff.loading')}
              </div>
            )}
            {diff?.state === 'error' && (
              <div className="p-6 text-center text-sm text-destructive">{diff.message}</div>
            )}
            {diff?.state === 'ready' && (
              <DiffView
                left={diff.left}
                right={diff.right}
                leftLabel={diff.leftLabel}
                rightLabel={diff.rightLabel}
              />
            )}
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            {cls.brokenPlats.length > 0 && (
              <section className="rounded-md border p-3">
                <div className="mb-2 font-medium">
                  {t('matrix.resolve.broken.heading', { count: cls.brokenPlats.length })}
                </div>
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {cls.brokenPlats.map((p) => (
                    <PlatformBadge key={p} platformId={p} />
                  ))}
                </div>
                <p className="mb-3 text-xs text-muted-foreground">{t('matrix.resolve.broken.body')}</p>
                <Button size="sm" onClick={() => onRepair(row)} disabled={busy} className="gap-1.5">
                  <Wrench className="h-3.5 w-3.5" />
                  {t('matrix.resolve.broken.action')}
                </Button>
              </section>
            )}

            {divergent.length > 0 && (
              <section className="rounded-md border p-3">
                <div className="mb-2 font-medium">
                  {t('matrix.resolve.diverge.heading', { count: divergent.length })}
                </div>
                <p className="mb-3 text-xs text-muted-foreground">{t('matrix.resolve.diverge.body')}</p>
                <ul className="space-y-2">
                  {divergent.map((p) => {
                    const cell = row.cells[p];
                    if (!cell) return null;
                    return (
                      <li
                        key={p}
                        className="flex items-center justify-between gap-2 rounded border bg-muted/30 px-2 py-1.5"
                      >
                        <span className="flex items-center gap-2">
                          <PlatformBadge platformId={p} />
                          {cls.misdirectedPlats.includes(p) && (
                            <span className="text-[10px] text-amber-700">
                              {t('matrix.resolve.diverge.misdirected')}
                            </span>
                          )}
                        </span>
                        <span className="flex items-center gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 gap-1 px-2 text-xs"
                            onClick={() => openDiff(p)}
                          >
                            <ArrowLeftRight className="h-3.5 w-3.5" />
                            {t('matrix.resolve.diff.view')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 gap-1 px-2 text-xs"
                            onClick={() => onCopyPath(cell)}
                          >
                            <Copy className="h-3.5 w-3.5" />
                            {t('matrix.resolve.diverge.copy')}
                          </Button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-3 text-[11px] text-muted-foreground">{t('matrix.resolve.diverge.note')}</p>
              </section>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Read-only side-by-side comparison of two SKILL.md versions. Computes a common
 * head/tail and highlights only the differing middle block on each side — no
 * external diff lib, good enough for the small SKILL.md files. Read-only by
 * design (Phase 1): there is intentionally no "overwrite" button here.
 */
function DiffView({
  left,
  right,
  leftLabel,
  rightLabel,
}: {
  left: string | null;
  right: string;
  leftLabel: string;
  rightLabel: string;
}) {
  const t = useT();
  if (left == null) {
    return (
      <div className="rounded border">
        <div className="border-b bg-muted/40 px-2 py-1 text-xs font-medium">{rightLabel}</div>
        <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap p-2 text-[11px] leading-relaxed">
          {right}
        </pre>
      </div>
    );
  }
  const a = left.split('\n');
  const b = right.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let ta = a.length;
  let tb = b.length;
  while (ta > head && tb > head && a[ta - 1] === b[tb - 1]) {
    ta--;
    tb--;
  }
  const identical = ta === head && tb === head;
  const pane = (lines: string[], midStart: number, midEnd: number, tone: string, label: string) => (
    <div className="min-w-0 flex-1 rounded border">
      <div className="border-b bg-muted/40 px-2 py-1 text-xs font-medium">{label}</div>
      <div className="max-h-[55vh] overflow-auto font-mono text-[11px] leading-relaxed">
        {lines.map((ln, i) => (
          <div
            key={i}
            className={cn('whitespace-pre-wrap break-words px-2', i >= midStart && i < midEnd && tone)}
          >
            {ln || ' '}
          </div>
        ))}
      </div>
    </div>
  );
  return (
    <div className="space-y-2">
      {identical && (
        <div className={cn('text-xs', STATUS_TONE.ok)}>{t('matrix.resolve.diff.identical')}</div>
      )}
      <div className="flex gap-2">
        {pane(a, head, ta, 'bg-rose-50 dark:bg-rose-950/30', leftLabel)}
        {pane(b, head, tb, 'bg-emerald-50 dark:bg-emerald-950/30', rightLabel)}
      </div>
    </div>
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
      // Canonical is no longer surfaced as a distinct identity — a real copy
      // reads as "present" (green) everywhere; only drift recolors it amber.
      return wrapper(<Check className="h-4 w-4" />, stale ? STATUS_TONE.warn : STATUS_TONE.ok);
    case 'symlink':
      return wrapper(<Link2 className="h-4 w-4" />, STATUS_TONE.link);
    case 'symlink_other':
      return wrapper(<Link2 className="h-4 w-4 -rotate-45" />, STATUS_TONE.warnStrong);
    case 'broken':
      return wrapper(<AlertTriangle className="h-4 w-4" />, STATUS_TONE.danger);
    case 'disabled':
      return wrapper(<EyeOff className="h-4 w-4" />, STATUS_TONE.muted);
    case 'missing':
    default:
      // Faint dash by default; a "+" fades in on hover to signal "click to add"
      // (the group-hover comes from the enclosing toggle button).
      return (
        <span className="inline-flex items-center" title={label} aria-label={label}>
          <Minus className="h-4 w-4 text-muted-foreground/30 group-hover:hidden" />
          <Plus className="hidden h-4 w-4 text-primary group-hover:inline" />
        </span>
      );
  }
}

function CellActionMenu({
  row,
  platformId,
  matrix,
  cell,
  open,
  busy,
  onOpenChange,
  onToggle,
  onOpenLocation,
  onCopyPath,
  onMoveToCanonical,
  onSetAsCopy,
  onCopyReal,
  onDisable,
}: {
  row: CoverageRow;
  platformId: string;
  matrix: CoverageMatrix;
  cell: CoverageCell | undefined;
  open: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onToggle: (row: CoverageRow, platformId: string) => void;
  onOpenLocation: (cell: CoverageCell) => void;
  onCopyPath: (cell: CoverageCell) => void;
  onMoveToCanonical: (row: CoverageRow, platformId: string) => void;
  onSetAsCopy: (row: CoverageRow, platformId: string, forceReplace?: boolean) => void;
  onCopyReal: (row: CoverageRow, platformId: string) => void;
  onDisable: (row: CoverageRow, cell: CoverageCell) => void;
}) {
  const t = useT();
  const state = cell?.state ?? 'missing';
  const isCanonical = platformId === matrix.canonicalPlatform;
  const canonicalCell = row.cells[matrix.canonicalPlatform];
  const canonicalHasRealSource = canonicalCell?.state === 'present';
  const hasLocation = Boolean(cell?.locationId);
  // "存放技能副本": place an independent real copy here. Offered whenever a real
  // copy exists on some OTHER platform and this cell isn't already a real dir —
  // lets the user deliberately keep a second editable copy (source unchanged).
  const hasRealSourceElsewhere = matrix.platforms.some(
    (p) => p !== platformId && row.cells[p]?.state === 'present',
  );
  const canCopyReal = hasRealSourceElsewhere && state !== 'present';
  const label = describeCell(state, cell?.drift, isCanonical, t);
  const canMoveToCanonical = Boolean(promoteSourceLocationId(row, platformId, matrix));
  const canReplace =
    !isCanonical &&
    row.hasCanonicalSource &&
    hasLocation &&
    (cell?.drift === 'stale' || state === 'broken' || state === 'symlink_other');
  const canSetAsCopy =
    !isCanonical &&
    row.hasCanonicalSource &&
    canonicalHasRealSource &&
    hasLocation &&
    state === 'present' &&
    cell?.drift !== 'stale';
  const canDisable = hasLocation && state !== 'missing' && state !== 'disabled';
  const hasWriteAction = canMoveToCanonical || canReplace || canSetAsCopy || canCopyReal || canDisable;

  const menuAvailable = Boolean(cell) && state !== 'missing';

  return (
    // Radix DropdownMenu supplies what the hand-rolled menu lacked: focus
    // moves into the menu, arrow keys + typeahead + Esc work, focus restores
    // to the cell button on close, and outside-click dismissal doesn't care
    // that the matrix rows stopPropagation their clicks.
    //
    // Interaction split on the trigger (the cell button itself):
    //   left-click / Enter / Space → toggle the cell (cc-switch primary action)
    //   right-click / Shift+F10 / ContextMenu key / ArrowDown → open the menu
    <DropdownMenu open={open && menuAvailable} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={busy}
          onPointerDown={(e) => {
            // Block Radix's pointerdown-open for plain left-click — that's the
            // toggle. preventDefault also suppresses native focus, so restore it.
            if (e.button === 0 && !e.ctrlKey) {
              e.preventDefault();
              e.currentTarget.focus();
            }
          }}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(row, platformId);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onToggle(row, platformId);
            } else if (menuAvailable && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
              e.preventDefault();
              onOpenChange(true);
            }
            // ArrowDown falls through to Radix → opens the menu.
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (menuAvailable) onOpenChange(!open);
          }}
          title={t('matrix.cell.toggleHint', { state: label })}
          aria-label={label}
          className={cn(
            'group inline-flex min-h-8 min-w-8 items-center justify-center rounded border border-transparent px-1',
            'hover:border-border hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
            'disabled:cursor-default disabled:opacity-50',
          )}
        >
          <CellGlyph state={state} drift={cell?.drift} isCanonical={isCanonical} />
        </button>
      </DropdownMenuTrigger>
      {cell && (
        <DropdownMenuContent
          align="center"
          className="w-44"
          onClick={(e) => e.stopPropagation()}
        >
          <DropdownMenuItem onSelect={() => onOpenLocation(cell)}>
            <FolderOpen className="h-3.5 w-3.5" />
            <span>{t('matrix.cellMenu.open')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onCopyPath(cell)}>
            <Copy className="h-3.5 w-3.5" />
            <span>{t('matrix.cellMenu.copy')}</span>
          </DropdownMenuItem>
          {hasWriteAction && <DropdownMenuSeparator />}
          {canMoveToCanonical && (
            <DropdownMenuItem onSelect={() => onMoveToCanonical(row, platformId)}>
              <ArrowUpToLine className="h-3.5 w-3.5" />
              <span>{t('matrix.cellMenu.moveToMain')}</span>
            </DropdownMenuItem>
          )}
          {canSetAsCopy && (
            <DropdownMenuItem onSelect={() => onSetAsCopy(row, platformId, true)}>
              <Link2 className="h-3.5 w-3.5" />
              <span>{t('matrix.cellMenu.setAsCopy')}</span>
            </DropdownMenuItem>
          )}
          {canCopyReal && (
            <DropdownMenuItem onSelect={() => onCopyReal(row, platformId)}>
              <FilePlus2 className="h-3.5 w-3.5" />
              <span>{t('matrix.cellMenu.copyReal')}</span>
            </DropdownMenuItem>
          )}
          {canReplace && (
            <DropdownMenuItem onSelect={() => onSetAsCopy(row, platformId)}>
              <Replace className="h-3.5 w-3.5" />
              <span>{t('matrix.cellMenu.replaceOld')}</span>
            </DropdownMenuItem>
          )}
          {canDisable && (
            <DropdownMenuItem danger onSelect={() => onDisable(row, cell)}>
              <EyeOff className="h-3.5 w-3.5" />
              <span>{t('matrix.cellMenu.disable')}</span>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );
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

/**
 * Pick which platform's existing copy to symlink FROM when enabling a skill on
 * `targetPlatformId`. Prefers the canonical platform (the normal source of
 * truth), then any real directory, then any live symlink. Returns null only if
 * the skill exists nowhere usable. This is what lets "install here" stay a
 * single safe symlink instead of falling back to a promote when the canonical
 * platform doesn't happen to hold the skill.
 */
function pickInstallSource(
  row: CoverageRow,
  matrix: CoverageMatrix,
  targetPlatformId: string,
): string | null {
  const has = (p: string, states: CoverageCellState[]) =>
    p !== targetPlatformId && states.includes(row.cells[p]?.state ?? 'missing');
  const canon = matrix.canonicalPlatform;
  if (has(canon, ['present', 'symlink'])) return canon;
  for (const p of matrix.platforms) if (has(p, ['present'])) return p;
  for (const p of matrix.platforms) if (has(p, ['symlink', 'symlink_other'])) return p;
  return null;
}

/**
 * The single source of truth for the action column, the bulk counts, and the
 * "needs attention" filter. Collapses every row situation into at most two
 * buckets:
 *
 *   tidy    — safe, reversible housekeeping (fill gaps / spread an orphan /
 *             re-enable). One click, applies instantly with undo.
 *   confirm — content actually diverges (drift), a link is broken, or a link
 *             points somewhere unexpected. The ONLY amber state. Never folded
 *             into green, because folding hidden divergence into "已就绪" would
 *             let one copy silently overwrite another later.
 *
 * Drift is computed by comparing content hashes DIRECTLY here, not via the
 * engine's `cell.drift`: `drift_for` returns `in_sync` whenever either hash is
 * null (scan interrupted / permission error), which would wrongly paint a real
 * divergence green. A non-canonical real copy is "safely green" only when its
 * hash is confirmed byte-identical to canonical.
 */
export interface RowClass {
  tidyKind: 'gaps' | 'orphan' | 'enable' | null;
  tidyTargets: string[];
  tidyCount: number;
  driftPlats: string[];
  brokenPlats: string[];
  misdirectedPlats: string[];
  confirmCount: number;
  ready: boolean;
}

function classifyRow(row: CoverageRow, matrix: CoverageMatrix): RowClass {
  const canonical = matrix.canonicalPlatform;
  const nonCanon = matrix.platforms.filter((p) => p !== canonical);
  const cellOf = (p: string) => row.cells[p];
  const stateOf = (p: string): CoverageCellState => cellOf(p)?.state ?? 'missing';
  const canonHash = cellOf(canonical)?.contentHash ?? null;

  // --- amber: 需要确认 (content-honest) ---
  const brokenPlats = nonCanon.filter((p) => stateOf(p) === 'broken');
  // "Misdirected" (symlink pointing somewhere other than canonical) is only a
  // real concern when there IS a canonical copy to diverge from AND the link's
  // resolved content actually differs from it:
  //   • No canonical copy (skill not on the canonical platform) → there is no
  //     anchor to be "misdirected" from. The skill is just an orphan relative to
  //     canonical; its symlinks correctly point at whatever real copy DOES exist.
  //     Flagging it 需要确认 is a false alarm — the dominant cause of the
  //     confusing "链接指到别处" reports on a heterogeneous setup where some
  //     skills simply aren't on the canonical platform yet. The orphan tidy path
  //     below offers the real action: also place it on canonical.
  //   • Canonical copy exists but the link is byte-identical to it → harmless
  //     (it re-flags the instant content truly diverges).
  const misdirectedPlats = !row.hasCanonicalSource
    ? []
    : nonCanon.filter((p) => {
        if (stateOf(p) !== 'symlink_other') return false;
        const c = cellOf(p);
        const confirmedIdentical =
          c?.contentHash != null && canonHash != null && c.contentHash === canonHash;
        return !confirmedIdentical;
      });
  // A real (non-symlink) copy on a non-canonical platform diverges unless we can
  // confirm it is byte-identical to canonical. Only meaningful when a canonical
  // source exists to compare against (orphans have no canonical to diff).
  const driftPlats = row.hasCanonicalSource
    ? nonCanon.filter((p) => {
        const c = cellOf(p);
        if (c?.state !== 'present') return false;
        return !(c.contentHash != null && canonHash != null && c.contentHash === canonHash);
      })
    : [];
  const confirmCount = brokenPlats.length + misdirectedPlats.length + driftPlats.length;

  // --- blue: 整理 (all safe, reversible) ---
  const canonState = stateOf(canonical);
  let tidyKind: RowClass['tidyKind'] = null;
  let tidyTargets: string[] = [];
  if (!row.hasCanonicalSource && canonState === 'disabled') {
    // The skill exists only as a disabled copy on the canonical platform.
    tidyKind = 'enable';
  } else if (!row.hasCanonicalSource) {
    // Orphan: the real file lives only on a non-canonical platform → spread it
    // to every platform that is missing it (linking from the existing copy).
    tidyTargets = matrix.platforms.filter((p) => stateOf(p) === 'missing');
    if (tidyTargets.length > 0) tidyKind = 'orphan';
  } else {
    // Has a canonical source: fill plain gaps (platforms with no copy at all).
    tidyTargets = nonCanon.filter((p) => stateOf(p) === 'missing');
    if (tidyTargets.length > 0) tidyKind = 'gaps';
  }
  const tidyCount = tidyKind === 'enable' ? 1 : tidyTargets.length;

  return {
    tidyKind: tidyCount > 0 ? tidyKind : null,
    tidyTargets,
    tidyCount,
    driftPlats,
    brokenPlats,
    misdirectedPlats,
    confirmCount,
    ready: tidyCount === 0 && confirmCount === 0,
  };
}

function promoteSourceLocationId(
  row: CoverageRow,
  platformId: string,
  matrix: CoverageMatrix,
): number | undefined {
  const canonicalCell = row.cells[matrix.canonicalPlatform];
  if (canonicalCell?.state === 'present') return undefined;

  const cell = row.cells[platformId];
  if (!cell || cell.state === 'missing' || cell.state === 'disabled') return undefined;

  if (platformId !== matrix.canonicalPlatform && cell.locationId) {
    return cell.locationId;
  }

  if (platformId === matrix.canonicalPlatform && cell.realPath) {
    const owner = matrix.platforms
      .filter((p) => p !== matrix.canonicalPlatform)
      .map((p) => row.cells[p])
      .find(
        (candidate) =>
          candidate?.locationId &&
          candidate.state !== 'missing' &&
          candidate.state !== 'disabled' &&
          candidate.realPath === cell.realPath,
      );
    return owner?.locationId;
  }

  return undefined;
}

function Legend() {
  const t = useT();
  return (
    <div className="mt-4 rounded-md border bg-card/40 px-3 py-2 text-[11px] text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <span className="inline-flex items-center gap-1">
          <Check className={cn('h-3 w-3', STATUS_TONE.ok)} /> {t('matrix.legend.inSync')}
        </span>
        <span className="inline-flex items-center gap-1">
          <Check className={cn('h-3 w-3', STATUS_TONE.warn)} /> {t('matrix.legend.stale')}
        </span>
        <span className="inline-flex items-center gap-1">
          <Link2 className={cn('h-3 w-3', STATUS_TONE.link)} /> {t('matrix.legend.symlinkCanonical')}
        </span>
        <span className="inline-flex items-center gap-1">
          <Link2 className={cn('h-3 w-3 -rotate-45', STATUS_TONE.warnStrong)} /> {t('matrix.legend.symlinkOther')}
        </span>
        <span className="inline-flex items-center gap-1">
          <AlertTriangle className={cn('h-3 w-3', STATUS_TONE.danger)} /> {t('matrix.legend.broken')}
        </span>
        <span className="inline-flex items-center gap-1">
          <EyeOff className={cn('h-3 w-3', STATUS_TONE.muted)} /> {t('matrix.legend.disabled')}
        </span>
        <span className="inline-flex items-center gap-1">
          <Minus className="h-3 w-3 text-muted-foreground/40" /> {t('matrix.legend.missing')}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2">
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
function EmptyCoverageGuidance({
  onOpenSettings,
  onSelectDiscover,
  onRescan,
}: {
  onOpenSettings: () => void;
  onSelectDiscover?: () => void;
  onRescan?: () => void;
}) {
  const t = useT();
  // Each guidance card IS the action — the whole card is one button, not a
  // description with a single clickable word buried in it.
  const card = (
    icon: React.ReactNode,
    title: string,
    body: string,
    onClick: (() => void) | undefined,
  ) => (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={!onClick}
        className={cn(
          'flex w-full items-start gap-3 rounded-md border bg-background p-3 text-left',
          onClick && 'hover:border-foreground/30 hover:bg-accent/40',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        {icon}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{title}</div>
          <div className="text-xs text-muted-foreground">{body}</div>
        </div>
      </button>
    </li>
  );
  return (
    <div className="mx-auto mt-8 max-w-md px-6">
      <div className="rounded-lg border bg-card p-5">
        <h2 className="text-base font-semibold">{t('matrix.empty.guidance.title')}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('matrix.empty.guidance.body')}
        </p>
        <ul className="mt-4 space-y-2">
          {card(
            <Globe className="mt-0.5 h-4 w-4 shrink-0 text-violet-500" aria-hidden="true" />,
            t('matrix.empty.guidance.discover.title'),
            t('matrix.empty.guidance.discover.body'),
            onSelectDiscover,
          )}
          {card(
            <SettingsIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />,
            t('matrix.empty.guidance.settings.title'),
            t('matrix.empty.guidance.settings.body'),
            onOpenSettings,
          )}
          {card(
            <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />,
            t('matrix.empty.guidance.rescan.title'),
            t('matrix.empty.guidance.rescan.body'),
            onRescan,
          )}
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row sorting
// ---------------------------------------------------------------------------

type CoverageSort = 'unsynced' | 'updated' | 'name';

/**
 * "Concern score" for a row — higher means more attention needed. Used by
 * the "out of sync first" sort to bubble actionable rows to the top.
 *
 * Weights are deliberately loose — they only need to give a stable ordering
 * within the actionable set, not be a precise risk metric. Anything with
 * score > 0 ranks above clean rows.
 */
function concernScore(row: CoverageRow, matrix: CoverageMatrix): number {
  let score = 0;
  score += row.missingOn.length * 2;
  if (!row.hasCanonicalSource) score += 5;
  for (const p of matrix.platforms) {
    const cell = row.cells[p];
    if (!cell) continue;
    if (cell.drift === 'stale') score += 2;
    if (cell.state === 'broken') score += 3;
  }
  return score;
}

function maxRowMtime(row: CoverageRow, matrix: CoverageMatrix): number {
  let max = 0;
  for (const p of matrix.platforms) {
    const mtime = row.cells[p]?.mtime;
    if (mtime != null && mtime > max) max = mtime;
  }
  return max;
}

function sortRows(
  rows: CoverageRow[],
  sort: CoverageSort,
  matrix: CoverageMatrix,
  pinnedRows?: Map<string, CoverageRow>,
): CoverageRow[] {
  const sorted = [...rows];
  // For pinned rows, compute the sort key from their snapshot at the moment
  // they were acted on — not the current state. This keeps a row visually in
  // place after sync completes; the user's mental "I clicked there" anchor
  // doesn't get yanked. Snapshots clear when the user changes sort/filter or
  // re-enters the view, at which point natural sort takes over.
  const keyRow = (r: CoverageRow): CoverageRow => pinnedRows?.get(r.skillId) ?? r;
  const byName = (a: CoverageRow, b: CoverageRow) =>
    a.skillName.localeCompare(b.skillName, undefined, { sensitivity: 'base' });
  switch (sort) {
    case 'unsynced':
      sorted.sort((a, b) => {
        const sa = concernScore(keyRow(a), matrix);
        const sb = concernScore(keyRow(b), matrix);
        return sa !== sb ? sb - sa : byName(a, b);
      });
      break;
    case 'updated':
      sorted.sort((a, b) => {
        const ma = maxRowMtime(keyRow(a), matrix);
        const mb = maxRowMtime(keyRow(b), matrix);
        return ma !== mb ? mb - ma : byName(a, b);
      });
      break;
    case 'name':
    default:
      sorted.sort(byName);
  }
  return sorted;
}
