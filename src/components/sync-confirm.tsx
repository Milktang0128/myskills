'use client';

import { useState } from 'react';
import { Link2, AlertTriangle, Check, MinusCircle } from 'lucide-react';
import type { SyncExecuteResult, SyncPlan, SyncPlanItem } from '@shared/types';
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

interface Props {
  open: boolean;
  plan: SyncPlan | null;
  onOpenChange: (open: boolean) => void;
  onApplied: (result: SyncExecuteResult) => void;
}

export function SyncConfirm({ open, plan, onOpenChange, onApplied }: Props) {
  const [submitting, setSubmitting] = useState(false);

  if (!plan) return null;

  const createItems = plan.items.filter((i) => i.action === 'create');
  const skipItems = plan.items.filter((i) => i.action === 'skip');
  const conflictItems = plan.items.filter((i) => i.action === 'conflict');

  async function apply() {
    if (!plan) return;
    setSubmitting(true);
    try {
      const result = await api.sync.execute(plan);
      onApplied(result);
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Sync preview</DialogTitle>
          <DialogDescription>
            {createItems.length} symlink{createItems.length === 1 ? '' : 's'} will be created.
            {skipItems.length > 0 && ` ${skipItems.length} already in sync.`}
            {conflictItems.length > 0 && ` ${conflictItems.length} need manual resolution.`}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[420px] -mx-2 px-2">
          <ul className="space-y-2 py-1">
            {plan.items.map((item, i) => (
              <li key={i}>
                <PlanRow item={item} />
              </li>
            ))}
          </ul>
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={submitting || createItems.length === 0}>
            {submitting ? 'Applying…' : `Apply ${createItems.length} symlink${createItems.length === 1 ? '' : 's'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PlanRow({ item }: { item: SyncPlanItem }) {
  const Icon =
    item.action === 'create'
      ? Link2
      : item.action === 'skip'
      ? Check
      : item.action === 'conflict'
      ? AlertTriangle
      : MinusCircle;
  const tone =
    item.action === 'create'
      ? 'text-blue-600'
      : item.action === 'skip'
      ? 'text-emerald-600'
      : item.action === 'conflict'
      ? 'text-amber-600'
      : 'text-muted-foreground';
  return (
    <div className="rounded-md border bg-background px-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        <Icon className={cn('h-3.5 w-3.5 shrink-0', tone)} />
        <span className="font-medium">{item.skillName}</span>
        <PlatformBadge platformId={item.sourcePlatformId} />
        <span className="text-muted-foreground">→</span>
        <PlatformBadge platformId={item.targetPlatformId} />
        <span className={cn('ml-auto text-xs', tone)}>{labelFor(item)}</span>
      </div>
      {item.action === 'create' && (
        <div className="mt-1 font-mono text-[10px] text-muted-foreground break-all">
          {item.targetPath} → {item.sourceRealPath}
        </div>
      )}
      {item.reason && item.action === 'conflict' && (
        <div className="mt-1 text-[11px] text-amber-700">{reasonExplain(item.reason)}</div>
      )}
    </div>
  );
}

function labelFor(item: SyncPlanItem): string {
  if (item.action === 'create') return 'create symlink';
  if (item.action === 'skip')
    return item.reason === 'already_linked' ? 'already linked' : 'skip';
  if (item.action === 'conflict') return 'conflict';
  return item.action;
}

function reasonExplain(reason: string): string {
  switch (reason) {
    case 'target_exists_dir':
      return 'A real directory already exists at the target path. Resolve manually.';
    case 'target_exists_symlink_other':
      return 'A different symlink already exists at this path. Remove or relink manually.';
    case 'target_exists_file':
      return 'A file (not directory) already exists at this path.';
    case 'shared_pool_missing':
      return 'This skill is not in the Shared pool — nothing to sync from.';
    case 'target_outside_root':
      return 'Computed target path is outside the platform’s skills_dir — refusing for safety.';
    case 'source_outside_roots':
      return 'Source path is outside the configured skill roots.';
    default:
      return reason;
  }
}
