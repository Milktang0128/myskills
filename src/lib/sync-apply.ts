import type { SyncExecuteResult, SyncPlan } from '@shared/types';
import { api } from '@/lib/api';
import type { ToastAction } from '@/components/ui/toast';
import type { useT } from '@/lib/i18n';

type ToastFn = (msg: string, action?: ToastAction, durationMs?: number) => void;
type TFn = ReturnType<typeof useT>;

/**
 * Execute an already-validated SAFE plan and surface the undo toast — the
 * shared core of the "safe instant / dangerous confirm" model (SPEC §9).
 * Callers are responsible for the safety check (`isPlanSafeToAutoApply`) and
 * for routing unsafe plans into the confirm dialog; this helper only owns the
 * execute → refresh → undo-toast tail so the matrix and the detail panel
 * behave identically (including folding failure counts into the undo toast).
 */
export async function executePlanWithUndo(opts: {
  plan: SyncPlan;
  /** e.g. 已启用「skill」— what the undo toast leads with. */
  undoMessage: string;
  t: TFn;
  onToast: ToastFn;
  /** Refresh hooks after a successful execute (and after an undo). */
  afterApplied: (result: SyncExecuteResult) => void;
  afterUndone: () => void;
}): Promise<SyncExecuteResult> {
  const { plan, undoMessage, t, onToast, afterApplied, afterUndone } = opts;
  const result = await api.sync.execute(plan.token);
  afterApplied(result);
  const failedSuffix =
    result.failed.length > 0
      ? ` · ${t('matrix.toast.failedSuffix', { count: result.failed.length })}`
      : '';
  if (result.undoableHistoryIds.length > 0) {
    onToast(
      undoMessage + failedSuffix,
      {
        label: t('common.undo'),
        onClick: () => {
          void (async () => {
            try {
              // Rollback by any one id sweeps the whole op-group; iterate distinct groups.
              for (const id of result.undoableHistoryIds) {
                await api.sync.rollback(id);
              }
              afterUndone();
              onToast(t('matrix.toast.undone'));
            } catch (err) {
              onToast(err instanceof Error ? err.message : String(err));
            }
          })();
        },
      },
      6000,
    );
  } else if (result.failed.length > 0) {
    onToast(
      t('matrix.toast.appliedFailed', {
        applied: result.applied.length,
        skipped: result.skipped.length,
        failed: result.failed.length,
      }),
    );
  }
  return result;
}
