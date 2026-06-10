'use client';

/**
 * Sync history — workspace view (peer of CoverageView).
 *
 * Each FS step is a row, but rollback semantics operate at the USER-LEVEL —
 * the "user action" is the whole opGroup (e.g. one "Manage sync" click that
 * expanded into copy_to_canonical + N symlink_replace). So:
 *
 *   - Only the *leader* of each group (max-id non-rolled-back row) shows
 *     the checkbox and the per-row Undo button.
 *   - Follower rows are visible (the table is honest about what happened)
 *     but dimmed, and share a thin left accent with their leader to read
 *     as one block.
 *   - Multi-select: tick N leader checkboxes, the action bar above the
 *     table lets you undo them as a batch. Sequential, newest-first;
 *     stops on first failure so partial state is surfaced.
 *
 * Legacy rows (op_group_id NULL — written before the column existed) are
 * treated as groups of one. They render identically; everything just works.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Link2,
  Replace,
  Copy as CopyIcon,
  Undo2,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import type { PlatformId } from '@shared/types';
import { api, type SyncHistoryRow } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { confirmAction } from '@/components/ui/confirm-dialog';
import { ToastViewport } from '@/components/ui/toast';
import { PlatformBadge } from '@/components/platform-badge';
import { useT } from '@/lib/i18n';
import { formatRelative, cn } from '@/lib/utils';

interface GroupInfo {
  /** Stable key — opGroupId for grouped rows, or `single-<id>` for legacy. */
  key: string;
  /** All rows in this group (including rolled-back ones). */
  rows: SyncHistoryRow[];
  /** Currently-undoable leader row id (max id with canRollback). Null if
   *  every row in the group is already rolled back or never undoable. */
  leaderId: number | null;
}

export function HistoryView() {
  const t = useT();
  const [rows, setRows] = useState<SyncHistoryRow[]>([]);
  const [bridgeReady, setBridgeReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [toast, setToast] = useState<string | null>(null);

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
    setRows(await api.sync.history(undefined, 200));
  }, [bridgeReady]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Derive per-row group membership + leader status. One pass, O(N).
  const { groupByRow, leaderIds, groupSizes } = useMemo(() => {
    const groups = new Map<string, GroupInfo>();
    for (const r of rows) {
      const key = r.op_group_id ?? `single-${r.id}`;
      const g = groups.get(key);
      if (g) {
        g.rows.push(r);
      } else {
        groups.set(key, { key, rows: [r], leaderId: null });
      }
    }
    // Resolve each group's current leader (max-id where canRollback).
    for (const g of groups.values()) {
      let max = -1;
      for (const r of g.rows) {
        // Skip rows whose backup is gone — clicking Undo would just error.
        if (r.backup_orphaned) continue;
        if (r.success === 1 && !r.rolled_back_at && r.id > max) {
          max = r.id;
          g.leaderId = r.id;
        }
      }
    }
    const byRow = new Map<number, GroupInfo>();
    const ldrs = new Set<number>();
    const sizes = new Map<string, number>();
    for (const g of groups.values()) {
      sizes.set(g.key, g.rows.length);
      if (g.leaderId != null) ldrs.add(g.leaderId);
      for (const r of g.rows) byRow.set(r.id, g);
    }
    return { groupByRow: byRow, leaderIds: ldrs, groupSizes: sizes };
  }, [rows]);

  // Drop any stale selections after a refresh — e.g., a row was just
  // rolled back and is no longer a valid leader.
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set<number>();
      for (const id of prev) if (leaderIds.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
  }, [leaderIds]);

  const toggleSelected = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

  async function rollbackOne(historyId: number) {
    const group = groupByRow.get(historyId);
    const stepCount = group ? group.rows.filter((r) => r.success === 1 && !r.rolled_back_at).length : 1;
    const ok = await confirmAction({
      title:
        stepCount > 1
          ? t('history.rollback.batchConfirm', { count: stepCount })
          : t('history.rollback.confirm'),
      tone: 'destructive',
      confirmLabel: t('history.rollback'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.sync.rollback(historyId);
      setToast(t('history.rollback.success'));
    } catch (err) {
      setToast(
        t('history.rollback.failure', {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  async function rollbackSelected() {
    // Newest-first: if user undoes batches A then B where B touched a skill
    // also touched by A, undoing B first means A's pre-state is what gets
    // restored. Same invariant as inside a single group.
    const ids = [...selected].sort((a, b) => b - a);
    if (ids.length === 0) return;
    const ok = await confirmAction({
      title: t('history.rollback.batchSelectedConfirm', { count: ids.length }),
      tone: 'destructive',
      confirmLabel: t('history.bulk.rollback'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) return;
    setBusy(true);
    let successful = 0;
    let failedAt: number | null = null;
    for (const id of ids) {
      try {
        await api.sync.rollback(id);
        successful += 1;
      } catch {
        // Stop on first failure — the partial state is preserved server-
        // side. User sees which batch failed and can investigate.
        failedAt = id;
        break;
      }
    }
    await refresh();
    setSelected(new Set());
    setBusy(false);
    if (failedAt != null) {
      setToast(
        t('history.rollback.batchPartialFail', {
          done: successful,
          total: ids.length,
        }),
      );
    } else {
      setToast(t('history.rollback.batchSuccess', { count: successful }));
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Top toolbar — entry count on the left, bulk action affordance on
          the right (only visible when something is selected). The bar is
          inline rather than sticky so it doesn't fight the table headers
          inside the ScrollArea. */}
      <div className="flex items-center gap-3 px-6 pb-3 pt-3 text-xs text-muted-foreground">
        <h1 className="text-sm font-semibold text-foreground">{t('header.history')}</h1>
        <span>{t('history.entries', { count: rows.length })}</span>
        {selected.size > 0 && (
          <div className="ml-auto flex items-center gap-2 text-foreground">
            <span>{t('history.bulk.selectedN', { count: selected.size })}</span>
            <Button size="sm" onClick={rollbackSelected} disabled={busy}>
              <Undo2 className="mr-1 h-3 w-3" />
              {t('history.bulk.rollback')}
            </Button>
            <Button size="sm" variant="outline" onClick={clearSelection} disabled={busy}>
              {t('history.bulk.clear')}
            </Button>
          </div>
        )}
      </div>

      <ScrollArea className="flex-1 scrollbar-thin">
        <div className="px-4 pb-6">
          {rows.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">{t('history.empty.full')}</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur">
                <tr className="border-b text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="w-8 px-2 py-2 text-center font-medium">
                    {/* Header checkbox left blank — selecting "all" makes
                        less sense here than in a mail client because
                        rollback order matters. */}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">{t('history.col.when')}</th>
                  <th className="px-3 py-2 text-left font-medium">{t('history.col.action')}</th>
                  <th className="px-3 py-2 text-left font-medium">{t('history.col.platform')}</th>
                  <th className="px-3 py-2 text-left font-medium">{t('history.col.paths')}</th>
                  <th className="px-3 py-2 text-center font-medium">{t('history.col.result')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('history.col.rollback')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const group = groupByRow.get(r.id);
                  const groupSize = group ? (groupSizes.get(group.key) ?? 1) : 1;
                  const isLeader = leaderIds.has(r.id);
                  const isFollower = !isLeader && groupSize > 1;
                  return (
                    <HistoryRow
                      key={r.id}
                      row={r}
                      isLeader={isLeader}
                      isFollower={isFollower}
                      groupSize={groupSize}
                      checked={selected.has(r.id)}
                      onToggleCheck={() => toggleSelected(r.id)}
                      onRollback={() => rollbackOne(r.id)}
                      busy={busy}
                    />
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </ScrollArea>

      {toast && (
        <ToastViewport
          toasts={[{ id: 1, message: toast, durationMs: 4000 }]}
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  );
}

function HistoryRow({
  row,
  isLeader,
  isFollower,
  groupSize,
  checked,
  onToggleCheck,
  onRollback,
  busy,
}: {
  row: SyncHistoryRow;
  isLeader: boolean;
  isFollower: boolean;
  groupSize: number;
  checked: boolean;
  onToggleCheck: () => void;
  onRollback: () => void;
  busy: boolean;
}) {
  const t = useT();
  const Icon = iconFor(row.action);
  // Subtle left accent only when the row is part of a multi-row group —
  // a single-step row doesn't need the visual binding.
  const grouped = groupSize > 1;
  return (
    <tr
      className={cn(
        'border-b align-top',
        row.rolled_back_at && 'opacity-60',
        grouped && 'border-l-2 border-l-muted-foreground/20',
        isFollower && 'text-muted-foreground',
      )}
    >
      <td className="w-8 px-2 py-2 text-center">
        {isLeader && (
          <input
            type="checkbox"
            checked={checked}
            onChange={onToggleCheck}
            aria-label={t('history.bulk.selectRow')}
            className="h-3.5 w-3.5 cursor-pointer accent-primary"
          />
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
        {formatRelative(row.created_at)}
      </td>
      <td className="px-3 py-2">
        <span className="inline-flex items-center gap-1 text-xs">
          <Icon className="h-3.5 w-3.5" />
          {row.action}
          {/* Leader rows label the batch size so users know one undo
              covers multiple FS steps. Followers stay plain. */}
          {isLeader && groupSize > 1 && (
            <span className="ml-1 text-[10px] text-muted-foreground">
              {t('history.batchStepCount', { count: groupSize })}
            </span>
          )}
        </span>
      </td>
      <td className="px-3 py-2">
        {row.platform_id ? <PlatformBadge platformId={row.platform_id as PlatformId} /> : null}
      </td>
      <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground">
        <div className="break-all">↳ {row.to_path}</div>
        {row.from_path && <div className="break-all">← {row.from_path}</div>}
        {row.backup_path && (
          <div className="break-all text-blue-700 dark:text-blue-400">
            {t('history.backupPrefix')} {row.backup_path}
          </div>
        )}
      </td>
      <td className="px-3 py-2 text-center">
        {row.success === 1 ? (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
            <CheckCircle2 className="h-3.5 w-3.5" /> {t('history.result.ok')}
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1 text-xs text-destructive"
            title={row.message ?? ''}
          >
            <XCircle className="h-3.5 w-3.5" /> {t('history.result.fail')}
          </span>
        )}
        {row.rolled_back_at && (
          <div className="text-[10px] text-muted-foreground">{t('history.rolledBack')}</div>
        )}
      </td>
      <td className="px-3 py-2 text-right">
        {isLeader ? (
          <Button size="sm" variant="outline" onClick={onRollback} disabled={busy}>
            <Undo2 className="mr-1 h-3 w-3" />
            {t('history.rollback')}
          </Button>
        ) : row.backup_orphaned && row.success === 1 && !row.rolled_back_at ? (
          // Was undoable, but the backup file is gone (retention cleanup or
          // manual delete). Tell the user instead of leaving the cell blank
          // looking like a randomly-non-undoable row.
          <span className="text-[10px] text-muted-foreground">{t('history.backupExpired')}</span>
        ) : null}
      </td>
    </tr>
  );
}

function iconFor(action: string) {
  if (action === 'symlink_create') return Link2;
  if (action === 'symlink_replace') return Replace;
  if (action === 'copy_to_canonical') return CopyIcon;
  return Link2;
}
