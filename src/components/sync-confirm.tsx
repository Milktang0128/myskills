'use client';

import { useMemo, useState } from 'react';
import {
  Link2,
  AlertTriangle,
  Check,
  Copy as CopyIcon,
  Replace,
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
import { cn } from '@/lib/utils';

const EXECUTE_TIMEOUT_MS = 30_000;

interface Props {
  open: boolean;
  plan: SyncPlan | null;
  canonicalPlatform: PlatformId;
  onOpenChange: (open: boolean) => void;
  onApplied: (result: SyncExecuteResult) => void;
}

export function SyncConfirm({
  open,
  plan,
  canonicalPlatform,
  onOpenChange,
  onApplied,
}: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Group plan items by skill so multi-step ops (promote) are visually one unit.
  const grouped = useMemo(() => groupByOp(plan), [plan]);

  if (!plan) return null;

  const writeItems = plan.items.filter(
    (i) => i.action === 'symlink_create' || i.action === 'symlink_replace' || i.action === 'copy_to_canonical',
  );
  const skipItems = plan.items.filter((i) => i.action === 'skip');
  const conflictItems = plan.items.filter((i) => i.action === 'conflict');

  const title =
    plan.operation === 'promote_to_canonical'
      ? 'Promote to canonical'
      : 'Sync from canonical';
  const subtitle =
    plan.operation === 'promote_to_canonical'
      ? `Copy each skill into ${canonicalPlatform}, then replace the original with a symlink.`
      : `Source: ${canonicalPlatform}. Targets get a symlink to the canonical copy.`;

  async function apply() {
    if (!plan) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await Promise.race([
        api.sync.execute(plan.token),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Sync timed out — check Application Support logs.')), EXECUTE_TIMEOUT_MS),
        ),
      ]);
      onApplied(result);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {subtitle}
            <br />
            <span className="text-xs">
              {writeItems.length} write{writeItems.length === 1 ? '' : 's'}
              {skipItems.length > 0 ? ` · ${skipItems.length} already in sync` : ''}
              {conflictItems.length > 0 ? ` · ${conflictItems.length} need attention` : ''}
            </span>
          </DialogDescription>
        </DialogHeader>

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
          <p className="text-xs text-destructive">{error}</p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={submitting || writeItems.length === 0}>
            {submitting
              ? 'Applying…'
              : writeItems.length === 0
              ? 'Nothing to apply'
              : `Apply ${writeItems.length} write${writeItems.length === 1 ? '' : 's'}`}
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
  const Icon = iconFor(item);
  const tone = toneFor(item);
  return (
    <div>
      <div className="flex items-center gap-2 text-xs">
        <Icon className={cn('h-3.5 w-3.5 shrink-0', tone)} />
        <PlatformBadge platformId={item.sourcePlatformId} />
        <span className="text-muted-foreground">→</span>
        <PlatformBadge platformId={item.targetPlatformId} />
        <span className={cn('text-[11px]', tone)}>{labelFor(item)}</span>
      </div>
      {(item.action === 'symlink_create' ||
        item.action === 'symlink_replace' ||
        item.action === 'copy_to_canonical') && (
        <div className="mt-0.5 font-mono text-[10px] text-muted-foreground break-all pl-5">
          {item.targetPath} ← {item.sourceRealPath}
        </div>
      )}
      {item.action === 'conflict' && item.reason && (
        <div className="mt-0.5 text-[11px] text-amber-700 pl-5">{reasonExplain(item.reason)}</div>
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
      return 'text-blue-600';
    case 'symlink_replace':
      return 'text-amber-600';
    case 'copy_to_canonical':
      return 'text-purple-600';
    case 'skip':
      return 'text-emerald-600';
    case 'conflict':
    default:
      return 'text-amber-600';
  }
}

function labelFor(item: SyncPlanItem): string {
  switch (item.action) {
    case 'symlink_create':
      return 'create symlink';
    case 'symlink_replace':
      return 'backup target → create symlink';
    case 'copy_to_canonical':
      return 'copy into canonical';
    case 'skip':
      return item.reason === 'already_linked' ? 'already linked' : 'skip';
    case 'conflict':
      return 'needs attention';
    default:
      return item.action;
  }
}

function reasonExplain(reason: string): string {
  switch (reason) {
    case 'target_exists_dir':
      return 'A real directory already exists at the target path. Promote it to canonical first to resolve.';
    case 'target_exists_symlink_other':
      return 'A different symlink already exists here. Decide whether to replace it.';
    case 'target_exists_file':
      return 'A file (not directory) already exists at this path. Resolve manually.';
    case 'canonical_missing':
      return 'The canonical platform does not have this skill. Promote it first.';
    case 'unsafe_target_name':
      return 'The source directory has a name that is not safe to use as a filesystem path.';
    case 'target_outside_root':
      return 'Computed target is outside the platform’s skills_dir — refused for safety.';
    case 'source_outside_roots':
      return 'Source path is outside the configured skill roots.';
    case 'source_changed_since_plan':
      return 'The source changed between plan and execute. Re-run the plan.';
    default:
      return reason;
  }
}
