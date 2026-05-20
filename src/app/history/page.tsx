'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
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
import { Toast } from '@/components/ui/toast';
import { PlatformBadge } from '@/components/platform-badge';
import { useT } from '@/lib/i18n';
import { formatRelative } from '@/lib/utils';
import { cn } from '@/lib/utils';

export default function HistoryPage() {
  const t = useT();
  const [rows, setRows] = useState<SyncHistoryRow[]>([]);
  const [bridgeReady, setBridgeReady] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
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

  async function rollback(row: SyncHistoryRow) {
    const ok = await confirmAction({
      title: t('history.rollback.confirmAction', {
        action: row.action,
        path: row.to_path ?? '',
      }),
      tone: 'destructive',
      confirmLabel: t('history.rollback'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) return;
    setBusyId(row.id);
    try {
      await api.sync.rollback(row.id);
      setToast(t('history.rollback.success'));
      await refresh();
    } catch (err) {
      setToast(t('history.rollback.failure', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <main className="flex h-screen w-screen flex-col overflow-hidden bg-paper">
      <header className="titlebar-drag flex h-11 shrink-0 items-center border-b border-rule pl-[88px] pr-4">
        <div className="titlebar-no-drag flex items-center gap-3">
          <Link
            href="/"
            className="inline-flex h-6 w-6 items-center justify-center text-mute hover:text-ink"
            aria-label={t('history.back')}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </Link>
          <div className="flex items-baseline gap-1.5 font-mono text-[10px] uppercase tracking-[var(--widest)] font-semibold">
            <span className="text-red-brand">MYSKILLS</span>
            <span className="text-mute">·</span>
            <span className="text-ink">{t('history.title')}</span>
            <span className="ml-2 text-mute normal-case tracking-[var(--wide)]">
              {t('history.entries', { count: rows.length })}
            </span>
          </div>
        </div>
      </header>

      <ScrollArea className="flex-1 scrollbar-thin">
        <div>
          {rows.length === 0 ? (
            <div className="px-7 py-12 text-center font-mono text-[11px] uppercase tracking-[0.06em] text-mute">{t('history.empty.full')}</div>
          ) : (
            <table className="w-full">
              <thead className="sticky top-0 z-10 bg-paper">
                <tr className="border-b-2 border-ink">
                  <th className="px-3 py-2.5 text-left font-mono text-[10px] uppercase tracking-[var(--wide)] font-semibold text-soft">{t('history.col.when')}</th>
                  <th className="px-3 py-2.5 text-left font-mono text-[10px] uppercase tracking-[var(--wide)] font-semibold text-soft">{t('history.col.action')}</th>
                  <th className="px-3 py-2.5 text-left font-mono text-[10px] uppercase tracking-[var(--wide)] font-semibold text-soft">{t('history.col.platform')}</th>
                  <th className="px-3 py-2.5 text-left font-mono text-[10px] uppercase tracking-[var(--wide)] font-semibold text-soft">{t('history.col.paths')}</th>
                  <th className="px-3 py-2.5 text-center font-mono text-[10px] uppercase tracking-[var(--wide)] font-semibold text-soft">{t('history.col.result')}</th>
                  <th className="px-3 py-2.5 text-right font-mono text-[10px] uppercase tracking-[var(--wide)] font-semibold text-soft">{t('history.col.rollback')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <HistoryRow key={r.id} row={r} onRollback={() => rollback(r)} busy={busyId === r.id} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </ScrollArea>

      {toast && (
        <Toast message={toast} durationMs={4000} onDismiss={() => setToast(null)} />
      )}
    </main>
  );
}

function HistoryRow({
  row,
  onRollback,
  busy,
}: {
  row: SyncHistoryRow;
  onRollback: () => void;
  busy: boolean;
}) {
  const t = useT();
  const Icon = iconFor(row.action);
  const canRollback = row.success === 1 && !row.rolled_back_at;
  // Action labels: rollback wears the brand red, the rest stay neutral ink/soft.
  const actionTone =
    row.action === 'rollback'
      ? 'text-red-brand'
      : row.action === 'copy_to_canonical'
      ? 'text-ink'
      : 'text-soft';
  return (
    <tr className={cn('border-b border-rule align-top', row.rolled_back_at && 'opacity-60')}>
      <td className="whitespace-nowrap px-3 py-3 font-mono text-[10.5px] uppercase tracking-[0.04em] text-mute">
        {formatRelative(row.created_at)}
      </td>
      <td className="px-3 py-3">
        <span className={cn('inline-flex items-center gap-1 font-mono text-[10.5px] uppercase tracking-[var(--wide)]', actionTone)}>
          <Icon className="h-3 w-3" />
          {row.action}
        </span>
      </td>
      <td className="px-3 py-3">
        {row.platform_id ? <PlatformBadge platformId={row.platform_id as PlatformId} /> : null}
      </td>
      <td className="px-3 py-3 font-mono text-[10.5px] leading-[1.6] text-mute">
        <div className="break-all">↳ {row.to_path}</div>
        {row.from_path && <div className="break-all">← {row.from_path}</div>}
        {row.backup_path && (
          <div className="break-all text-red-brand/80">
            {t('history.backupPrefix')} {row.backup_path}
          </div>
        )}
      </td>
      <td className="px-3 py-3 text-center">
        {row.success === 1 ? (
          <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.08em] text-soft">
            <CheckCircle2 className="h-3 w-3" /> {t('history.result.ok')}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.08em] text-red-brand" title={row.message ?? ''}>
            <XCircle className="h-3 w-3" /> {t('history.result.fail')}
          </span>
        )}
        {row.rolled_back_at && (
          <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-mute">{t('history.rolledBack')}</div>
        )}
      </td>
      <td className="px-3 py-3 text-right">
        {canRollback ? (
          <Button size="sm" variant="ghost" onClick={onRollback} disabled={busy}>
            <Undo2 className="mr-1 h-3 w-3" />
            {t('history.rollback')}
          </Button>
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
