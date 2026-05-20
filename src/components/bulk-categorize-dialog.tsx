'use client';

/**
 * Preview + edit dialog for the bulk AI categorization flow.
 *
 * Lifecycle
 * ---------
 *   1. Caller opens the dialog with a list of skill IDs.
 *   2. We call `api.ai.bulkCategorize(ids)`. While the LLM runs, the dialog
 *      shows a spinner + "AI is analyzing N skills…".
 *   3. The returned plan becomes editable local state. The user can:
 *        - Uncheck a proposed new scenario → its rows automatically fall back
 *          to "skip" (we don't try to re-route them; clearer than guessing).
 *        - Per row, pick a different target via the dropdown (existing
 *          scenario / new proposal / skip).
 *   4. Apply ships the (edited) plan back to main via
 *      `api.ai.applyBulkCategorization`. Main creates only the new scenarios
 *      that are still referenced and links them in one DB transaction.
 *
 * UX choices
 * ----------
 *   - We always show every input skill, even skips. Letting the user see
 *     "AI couldn't categorize 3 of these" + adjust is the whole point.
 *   - The "NEW" badge is amber to differentiate from existing scenario
 *     chips so users know they're committing to creating a new bucket.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import type {
  BulkCategorizeApplyResult,
  BulkCategorizeAssignment,
  BulkCategorizePlan,
  BulkCategorizeProposedScenario,
  Scenario,
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
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  /** All unscenarized skill IDs (or any subset). Empty array opens nothing. */
  skillIds: string[];
  /** Existing scenarios for the per-row target dropdown. */
  scenarios: Scenario[];
  onOpenChange: (open: boolean) => void;
  /** Called after a successful apply so the caller can refresh lists. */
  onApplied: (result: BulkCategorizeApplyResult) => void;
}

export function BulkCategorizeDialog({
  open,
  skillIds,
  scenarios,
  onOpenChange,
  onApplied,
}: Props) {
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<BulkCategorizePlan | null>(null);
  /** Set of proposed-scenario keys the user has unchecked. */
  const [droppedNew, setDroppedNew] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);

  // Fetch the plan whenever the dialog opens with a fresh skill set.
  useEffect(() => {
    if (!open) return;
    if (skillIds.length === 0) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPlan(null);
    setDroppedNew(new Set());
    (async () => {
      try {
        const p = await api.ai.bulkCategorize(skillIds);
        if (cancelled) return;
        setPlan(p);
      } catch (err) {
        if (cancelled) return;
        const msg = extractErrorMessage(err);
        setError(t('bulkCat.error', { message: msg }));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // skillIds changes when caller resets; deliberately not in deps to avoid
    // duplicate fetches on render-only re-renders. Caller re-opens to retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** Per-row target override (skillId → target descriptor). null = keep AI's pick. */
  const [overrides, setOverrides] = useState<Map<string, BulkCategorizeAssignment['target']>>(
    new Map(),
  );
  useEffect(() => {
    // Reset overrides whenever a fresh plan arrives.
    setOverrides(new Map());
  }, [plan]);

  /** Effective target for a row, applying overrides and dropped-new fallbacks. */
  const effectiveTarget = useCallback(
    (a: BulkCategorizeAssignment): BulkCategorizeAssignment['target'] => {
      const override = overrides.get(a.skillId);
      const raw = override ?? a.target;
      if (raw.kind === 'new' && droppedNew.has(raw.scenarioKey)) {
        return { kind: 'skip' };
      }
      return raw;
    },
    [overrides, droppedNew],
  );

  // Recompute summary counts on every edit.
  const summary = useMemo(() => {
    if (!plan) return { create: 0, assign: 0, skip: 0 };
    // Count actually-used proposed scenarios after edits.
    const usedNewKeys = new Set<string>();
    let assign = 0;
    let skip = 0;
    for (const a of plan.assignments) {
      const target = effectiveTarget(a);
      if (target.kind === 'skip') {
        skip += 1;
      } else {
        assign += 1;
        if (target.kind === 'new') usedNewKeys.add(target.scenarioKey);
      }
    }
    // Subtract proposed scenarios that user dropped.
    let create = 0;
    for (const p of plan.proposedScenarios) {
      if (droppedNew.has(p.key)) continue;
      if (!usedNewKeys.has(p.key)) continue;
      create += 1;
    }
    return { create, assign, skip };
  }, [plan, effectiveTarget, droppedNew]);

  const apply = useCallback(async () => {
    if (!plan) return;
    setApplying(true);
    setError(null);
    try {
      // Build the FINAL plan to ship — fold overrides + dropped-new into a
      // single canonical structure so main doesn't need to know about UI state.
      const finalPlan: BulkCategorizePlan = {
        intent: plan.intent,
        proposedScenarios: plan.proposedScenarios.filter((p) => !droppedNew.has(p.key)),
        assignments: plan.assignments.map((a) => ({
          ...a,
          target: effectiveTarget(a),
        })),
        classifiedCount: 0,
        skippedCount: 0,
      };
      finalPlan.classifiedCount = finalPlan.assignments.filter((a) => a.target.kind !== 'skip').length;
      finalPlan.skippedCount = finalPlan.assignments.length - finalPlan.classifiedCount;
      const result = await api.ai.applyBulkCategorization(finalPlan);
      onApplied(result);
      onOpenChange(false);
    } catch (err) {
      setError(t('bulkCat.error', { message: extractErrorMessage(err) }));
    } finally {
      setApplying(false);
    }
  }, [plan, droppedNew, effectiveTarget, onApplied, onOpenChange, t]);

  return (
    <Dialog open={open} onOpenChange={(o) => !applying && onOpenChange(o)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-violet-500" />
            {t('bulkCat.dialog.title')}
          </DialogTitle>
          <DialogDescription>{t('bulkCat.dialog.subtitle')}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('bulkCat.preparing', { count: skillIds.length })}
          </div>
        ) : error ? (
          <p className="py-8 text-sm text-destructive">{error}</p>
        ) : plan ? (
          <div className="space-y-4">
            {plan.intent && (
              <p className="rounded-md border bg-secondary/30 px-3 py-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  {t('bulkCat.intentLabel')}
                </span>{' '}
                {plan.intent}
              </p>
            )}

            {plan.proposedScenarios.length > 0 && (
              <section>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('bulkCat.newScenarios')}
                </h3>
                <p className="mb-2 text-[11px] text-muted-foreground">
                  {t('bulkCat.newScenarios.help')}
                </p>
                <ul className="space-y-1">
                  {plan.proposedScenarios.map((p) => (
                    <li key={p.key}>
                      <ProposedRow
                        proposal={p}
                        dropped={droppedNew.has(p.key)}
                        onToggle={() =>
                          setDroppedNew((prev) => {
                            const next = new Set(prev);
                            if (next.has(p.key)) next.delete(p.key);
                            else next.add(p.key);
                            return next;
                          })
                        }
                      />
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t('bulkCat.assignments', { count: plan.assignments.length })}
              </h3>
              {/* h-[300px] (not max-h) so the Radix ScrollArea Viewport
                  resolves to a definite height and actually scrolls when
                  there are >7-8 rows. max-h inside a nested flex column
                  leaves Viewport at auto → no overflow → no scroll. */}
              <ScrollArea className="h-[300px] rounded-md border">
                <ul className="divide-y">
                  {plan.assignments.map((a) => (
                    <li key={a.skillId}>
                      <AssignmentRow
                        assignment={a}
                        effectiveTarget={effectiveTarget(a)}
                        scenarios={scenarios}
                        proposed={plan.proposedScenarios}
                        droppedNew={droppedNew}
                        onChange={(target) =>
                          setOverrides((prev) => {
                            const next = new Map(prev);
                            next.set(a.skillId, target);
                            return next;
                          })
                        }
                      />
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            </section>
          </div>
        ) : null}

        <DialogFooter className="flex-row items-center justify-between">
          {plan && !loading && !error ? (
            <div className="text-[11px] text-muted-foreground">
              {summary.create > 0 &&
                (summary.create === 1
                  ? t('bulkCat.summary.willCreate', { count: summary.create })
                  : t('bulkCat.summary.willCreateMany', { count: summary.create }))}
              {summary.create > 0 && ' · '}
              {summary.assign === 1
                ? t('bulkCat.summary.willAssign', { count: summary.assign })
                : t('bulkCat.summary.willAssignMany', { count: summary.assign })}
              {summary.skip > 0 && ' · '}
              {summary.skip > 0 && t('bulkCat.summary.willSkip', { count: summary.skip })}
            </div>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={applying}
            >
              {t('bulkCat.cancel')}
            </Button>
            <Button
              onClick={apply}
              disabled={loading || !!error || !plan || applying || summary.assign === 0}
            >
              {applying ? t('bulkCat.applying') : t('bulkCat.apply')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ──────────────────────────────────────────────────────────────────────────

function ProposedRow({
  proposal,
  dropped,
  onToggle,
}: {
  proposal: BulkCategorizeProposedScenario;
  dropped: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs',
        dropped ? 'opacity-50 border-border' : 'border-amber-300/60 bg-amber-50/30 dark:bg-amber-950/10',
      )}
    >
      <input
        type="checkbox"
        checked={!dropped}
        onChange={onToggle}
        className="mt-0.5 h-3.5 w-3.5"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-medium">{proposal.name}</span>
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            {t('bulkCat.newBadge')}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {proposal.key}
          </span>
          <span className="ml-auto text-[10px] text-muted-foreground">
            {proposal.usedByCount === 1
              ? t('bulkCat.usedByCount', { count: proposal.usedByCount })
              : t('bulkCat.usedByCountMany', { count: proposal.usedByCount })}
          </span>
        </div>
        {proposal.reason && (
          <p className="mt-0.5 text-[11px] text-muted-foreground">{proposal.reason}</p>
        )}
      </div>
    </label>
  );
}

function AssignmentRow({
  assignment,
  effectiveTarget,
  scenarios,
  proposed,
  droppedNew,
  onChange,
}: {
  assignment: BulkCategorizeAssignment;
  effectiveTarget: BulkCategorizeAssignment['target'];
  scenarios: Scenario[];
  proposed: BulkCategorizeProposedScenario[];
  droppedNew: Set<string>;
  onChange: (target: BulkCategorizeAssignment['target']) => void;
}) {
  const t = useT();
  // The dropdown's value is encoded as a string token because <select> only
  // takes strings. Decoding inverts the encoding at change time.
  //   'skip'                  → kind=skip
  //   'existing:<id>'         → kind=existing
  //   'new:<key>'             → kind=new
  const currentValue = encodeTargetValue(effectiveTarget);
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-accent/30">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{assignment.skillName}</div>
        {assignment.why && effectiveTarget.kind !== 'skip' && (
          <div className="mt-0.5 truncate text-[10px] italic text-muted-foreground">
            {assignment.why}
          </div>
        )}
      </div>
      <select
        value={currentValue}
        onChange={(e) => onChange(decodeTargetValue(e.target.value))}
        className="h-7 max-w-[200px] truncate rounded-md border border-input bg-background px-2 text-[11px]"
      >
        <option value="skip">⊘ {t('bulkCat.row.skip')}</option>
        {proposed.length > 0 && (
          <optgroup label="🆕">
            {proposed.map((p) => (
              <option
                key={`new:${p.key}`}
                value={`new:${p.key}`}
                disabled={droppedNew.has(p.key)}
              >
                {p.name}
                {droppedNew.has(p.key) ? ' (off)' : ''}
              </option>
            ))}
          </optgroup>
        )}
        {scenarios.length > 0 && (
          <optgroup label="—">
            {scenarios.map((s) => (
              <option key={`existing:${s.id}`} value={`existing:${s.id}`}>
                {s.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </div>
  );
}

function encodeTargetValue(target: BulkCategorizeAssignment['target']): string {
  if (target.kind === 'skip') return 'skip';
  if (target.kind === 'existing') return `existing:${target.scenarioId}`;
  return `new:${target.scenarioKey}`;
}

function decodeTargetValue(value: string): BulkCategorizeAssignment['target'] {
  if (value === 'skip') return { kind: 'skip' };
  if (value.startsWith('existing:')) {
    const id = Number.parseInt(value.slice('existing:'.length), 10);
    return { kind: 'existing', scenarioId: id };
  }
  if (value.startsWith('new:')) {
    return { kind: 'new', scenarioKey: value.slice('new:'.length) };
  }
  return { kind: 'skip' };
}

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return err instanceof Error ? err.message : String(err);
}
