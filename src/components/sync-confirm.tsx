'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Link2,
  AlertTriangle,
  Check,
  Copy as CopyIcon,
  Replace,
  Undo2,
  Eye,
  EyeOff,
} from 'lucide-react';
import type {
  PlatformId,
  SyncExecuteResult,
  SyncPlan,
  SyncPlanItem,
} from '@shared/types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { PlatformBadge } from './platform-badge';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { STATUS_TONE } from '@/lib/status-tones';

const EXECUTE_TIMEOUT_MS = 30_000;

interface Props {
  open: boolean;
  plan: SyncPlan | null;
  canonicalPlatform: PlatformId;
  onOpenChange: (open: boolean) => void;
  onApplied: (result: SyncExecuteResult) => void;
  onExecute?: (token: string) => Promise<SyncExecuteResult>;
}

export function SyncConfirm({
  open,
  plan,
  canonicalPlatform,
  onOpenChange,
  onApplied,
  onExecute,
}: Props) {
  const t = useT();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // After a timeout the write may STILL complete in the background — the
  // promise race only abandons the UI side. Retrying would re-consume the
  // plan token (or double-apply); we disable retry and point the user at
  // 同步历史 to see what actually happened.
  const [timedOut, setTimedOut] = useState(false);

  // Group plan items by skill so multi-step ops (promote) are visually one unit.
  const grouped = useMemo(() => groupByOp(plan), [plan]);

  // A fresh plan (or reopening) starts from a clean slate.
  useEffect(() => {
    setError(null);
    setTimedOut(false);
  }, [plan?.token, open]);

  if (!plan) return null;

  const writeItems = plan.items.filter(
    (i) =>
      i.action === 'symlink_create' ||
      i.action === 'symlink_replace' ||
      i.action === 'copy_to_canonical' ||
      i.action === 'disable' ||
      i.action === 'enable',
  );
  const skipItems = plan.items.filter((i) => i.action === 'skip');
  const conflictItems = plan.items.filter((i) => i.action === 'conflict');
  // The only action class that can lose user-edited content from the working
  // tree: it backs up the existing target dir, then writes a symlink pointing
  // to canonical. The edits survive in backup but they're no longer where the
  // user expects them. Worth a heads-up when this is in the plan.
  const replaceCount = plan.items.filter((i) => i.action === 'symlink_replace').length;

  const title =
    plan.operation === 'promote_to_canonical'
      ? t('syncConfirm.title.promote')
      : plan.operation === 'create_skill'
      ? t('syncConfirm.title.createSkill')
      : plan.operation === 'disable'
      ? t('syncConfirm.title.disable')
      : plan.operation === 'enable'
      ? t('syncConfirm.title.enable')
      : t('syncConfirm.title.fromCanonical');
  const subtitle =
    plan.operation === 'promote_to_canonical'
      ? t('syncConfirm.subtitle.promoteFull', { platform: canonicalPlatform })
      : plan.operation === 'create_skill'
      ? t('syncConfirm.subtitle.createSkill', { platform: canonicalPlatform })
      : plan.operation === 'disable'
      ? t('syncConfirm.subtitle.disable')
      : plan.operation === 'enable'
      ? t('syncConfirm.subtitle.enable')
      : t('syncConfirm.subtitle.fromCanonical', { platform: canonicalPlatform });

  async function apply() {
    if (!plan) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await Promise.race([
        onExecute ? onExecute(plan.token) : api.sync.execute(plan.token),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(Object.assign(new Error(t('syncConfirm.timedOut')), { timeout: true })),
            EXECUTE_TIMEOUT_MS,
          ),
        ),
      ]);
      onApplied(result);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if ((err as { timeout?: boolean }).timeout === true) {
        setTimedOut(true);
        // The backend write may finish after we stopped waiting (iCloud paths
        // routinely blow the 30s budget). Kick a rescan so when it lands, the
        // scanFinished listeners refresh the matrix/list to the real state.
        void api.scan.run().catch(() => {});
      }
    } finally {
      setSubmitting(false);
    }
  }

  const writeSummary = writeItems.length === 1
    ? t('syncConfirm.summary.write', { count: writeItems.length })
    : t('syncConfirm.summary.writes', { count: writeItems.length });
  const skipSummary = skipItems.length > 0
    ? t('syncConfirm.summary.alreadyInSync', { count: skipItems.length })
    : '';
  const conflictSummary = conflictItems.length > 0
    ? t('syncConfirm.summary.needAttention', { count: conflictItems.length })
    : '';

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {subtitle}
            <br />
            <span className="text-xs">
              {writeSummary}{skipSummary}{conflictSummary}
            </span>
          </DialogDescription>
        </DialogHeader>

        {replaceCount > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{t('syncConfirm.replaceWarning', { count: replaceCount })}</span>
          </div>
        )}

        <ScrollArea className="max-h-[420px] -mx-2 px-2">
          <ul className="space-y-3 py-1">
            {grouped.map((group, i) => (
              <li key={i}>
                <GroupCard items={group} />
              </li>
            ))}
          </ul>
        </ScrollArea>

        {error && (
          <div className="space-y-1">
            <p className="text-xs text-destructive">{error}</p>
            {timedOut && (
              <p className="text-xs text-muted-foreground">{t('syncConfirm.timeoutHint')}</p>
            )}
          </div>
        )}

        {/* Rollback assurance — telegraphs the safety net so users feel
            free to confirm without overthinking. Specifically points at the
            existing entry (sidebar bottom → 同步历史) to teach the
            recovery path in context. */}
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Undo2 className="h-3 w-3 shrink-0" />
          {t('syncConfirm.rollbackHint')}
        </p>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button onClick={apply} disabled={submitting || timedOut || writeItems.length === 0}>
            {submitting
              ? t('syncConfirm.applying')
              : writeItems.length === 0
              ? t('syncConfirm.nothingToApply')
              : writeItems.length === 1
              ? t('syncConfirm.applyN.one', { count: writeItems.length })
              : t('syncConfirm.applyN.many', { count: writeItems.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function groupByOp(plan: SyncPlan | null): SyncPlanItem[][] {
  if (!plan) return [];
  const map = new Map<string, SyncPlanItem[]>();
  for (const item of plan.items) {
    const arr = map.get(item.opGroupId) ?? [];
    arr.push(item);
    map.set(item.opGroupId, arr);
  }
  return Array.from(map.values());
}

function GroupCard({ items }: { items: SyncPlanItem[] }) {
  if (items.length === 0) return null;
  const head = items[0]!;
  return (
    <div className="rounded-md border bg-background px-3 py-2">
      <div className="text-sm font-medium">{head.skillName}</div>
      <ul className="mt-1 space-y-1">
        {items.map((it, i) => (
          <li key={i}>
            <ItemRow item={it} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ItemRow({ item }: { item: SyncPlanItem }) {
  const t = useT();
  const Icon = iconFor(item);
  const tone = toneFor(item);
  // A disable/enable move stays on one platform — show a single badge instead
  // of the "source → target" pair that would read as "claude → claude".
  const isMove = item.action === 'disable' || item.action === 'enable';
  return (
    <div>
      <div className="flex items-center gap-2 text-xs">
        <Icon className={cn('h-3.5 w-3.5 shrink-0', tone)} />
        <PlatformBadge platformId={item.sourcePlatformId} />
        {!isMove && (
          <>
            <span className="text-muted-foreground">→</span>
            <PlatformBadge platformId={item.targetPlatformId} />
          </>
        )}
        <span className={cn('text-[11px]', tone)}>{labelFor(item, t)}</span>
      </div>
      {(item.action === 'symlink_create' ||
        item.action === 'symlink_replace' ||
        item.action === 'copy_to_canonical') && (
        <div className="mt-0.5 font-mono text-[10px] text-muted-foreground break-all pl-5">
          {item.targetPath} ← {item.sourceRealPath}
        </div>
      )}
      {isMove && (
        <div className="mt-0.5 font-mono text-[10px] text-muted-foreground break-all pl-5">
          {item.sourceRealPath} → {item.targetPath}
        </div>
      )}
      {item.action === 'conflict' && item.reason && (
        <div className={cn('mt-0.5 text-[11px] pl-5', STATUS_TONE.warnStrong)}>
          {reasonExplain(item.reason, t)}
        </div>
      )}
    </div>
  );
}

function iconFor(item: SyncPlanItem) {
  switch (item.action) {
    case 'symlink_create':
      return Link2;
    case 'symlink_replace':
      return Replace;
    case 'copy_to_canonical':
      return CopyIcon;
    case 'disable':
      return EyeOff;
    case 'enable':
      return Eye;
    case 'skip':
      return Check;
    case 'conflict':
    default:
      return AlertTriangle;
  }
}

function toneFor(item: SyncPlanItem): string {
  switch (item.action) {
    case 'symlink_create':
      return STATUS_TONE.link;
    case 'symlink_replace':
      return STATUS_TONE.warn;
    case 'copy_to_canonical':
      // Sky, not purple — purple is the AI signal (and the codex platform
      // badge right next to this row is purple too).
      return 'text-sky-600 dark:text-sky-400';
    case 'disable':
      return STATUS_TONE.muted;
    case 'enable':
      return STATUS_TONE.ok;
    case 'skip':
      return STATUS_TONE.ok;
    case 'conflict':
    default:
      return STATUS_TONE.warn;
  }
}

function labelFor(item: SyncPlanItem, t: ReturnType<typeof useT>): string {
  switch (item.action) {
    case 'symlink_create':
      return t('syncConfirm.action.createSymlink');
    case 'symlink_replace':
      return t('syncConfirm.action.backupSymlink');
    case 'copy_to_canonical':
      return t('syncConfirm.action.copyToCanonical');
    case 'disable':
      return t('syncConfirm.action.disable');
    case 'enable':
      return t('syncConfirm.action.enable');
    case 'skip':
      return item.reason === 'already_linked'
        ? t('syncConfirm.action.alreadyLinked')
        : t('syncConfirm.action.skip');
    case 'conflict':
      return t('syncConfirm.action.conflict');
    default:
      return item.action;
  }
}

function reasonExplain(reason: string, t: ReturnType<typeof useT>): string {
  switch (reason) {
    case 'target_exists_dir':
      return t('syncConfirm.reason.target_exists_dir');
    case 'target_exists_symlink_other':
      return t('syncConfirm.reason.target_exists_symlink_other');
    case 'target_exists_file':
      return t('syncConfirm.reason.target_exists_file');
    case 'canonical_missing':
      return t('syncConfirm.reason.canonical_missing');
    case 'unsafe_target_name':
      return t('syncConfirm.reason.unsafe_target_name');
    case 'target_outside_root':
      return t('syncConfirm.reason.target_outside_root');
    case 'source_outside_roots':
      return t('syncConfirm.reason.source_outside_roots');
    case 'source_changed_since_plan':
      return t('syncConfirm.reason.source_changed_since_plan');
    case 'unreadable':
      return t('syncConfirm.reason.unreadable');
    case 'source_has_symlink':
      return t('syncConfirm.reason.source_has_symlink');
    case 'case_collision':
      return t('syncConfirm.reason.case_collision');
    case 'canonical_has_dependents':
      return t('syncConfirm.reason.canonical_has_dependents');
    case 'already_disabled':
      return t('syncConfirm.reason.already_disabled');
    case 'already_enabled':
      return t('syncConfirm.reason.already_enabled');
    default:
      return reason;
  }
}
