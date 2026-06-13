'use client';

/**
 * 优化改写（三问一刀的"一刀"）— phase 2 write flow inside SkillDetail.
 * Design: docs/design/skill-optimization.md. Propose a surgical rewrite for
 * ONE finding, show the diff + expected improvement + verification prompts +
 * gate status, and land it through the sync backup/atomic-write/rollback path
 * on a single confirm. The only mandatory human decision is this confirm.
 */
import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy as CopyIcon,
  Loader2,
  RotateCcw,
  Wand2,
  X,
} from 'lucide-react';
import type {
  AiJob,
  DiagnosisFinding,
  OptimizationProposal,
  OptimizationRound,
} from '@shared/types';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useI18n, useT } from '@/lib/i18n';
import { collapseContext, lineDiff } from '@/lib/line-diff';
import { cn } from '@/lib/utils';

const ACTIVE = ['queued', 'running'];

function messageOf(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/**
 * Drives proposal generation + confirm for one finding. Mounted when the user
 * clicks "Fix this" on a finding; calls onApplied after a successful write so
 * the parent can re-diagnose.
 */
export function OptimizeFix({
  skillId,
  finding,
  onApplied,
  onClose,
}: {
  skillId: string;
  finding: DiagnosisFinding;
  onApplied: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const lang: 'zh' | 'en' = locale;
  const [proposal, setProposal] = useState<OptimizationProposal | null>(null);
  const [job, setJob] = useState<AiJob<OptimizationProposal> | null>(null);
  const [busy, setBusy] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resume an existing pending proposal for this finding, else generate one.
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);
    setProposal(null);
    (async () => {
      try {
        const existing = await api.optimize.getProposal(skillId);
        if (cancelled) return;
        if (existing && existing.finding.id === finding.id) {
          setProposal(existing);
          setBusy(false);
          return;
        }
        const started = await api.optimize.proposeFixJob(skillId, finding.id, lang);
        if (cancelled) return;
        setJob(started);
      } catch (err) {
        if (!cancelled) {
          setError(messageOf(err));
          setBusy(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [skillId, finding.id, lang]);

  useEffect(() => {
    if (!job || !ACTIVE.includes(job.status)) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await api.ai.jobGet<OptimizationProposal>(job.jobId);
        if (cancelled) return;
        if (next.status === 'succeeded') {
          setProposal(next.result);
          setBusy(false);
          setJob(null);
        } else if (next.status === 'failed') {
          setError(messageOf(next.error));
          setBusy(false);
          setJob(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(messageOf(err));
          setBusy(false);
          setJob(null);
        }
      }
    };
    void poll();
    const id = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [job, skillId, finding.id, lang]);

  async function apply() {
    if (!proposal) return;
    setApplying(true);
    setError(null);
    try {
      await api.optimize.apply(proposal.id);
      onApplied();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setApplying(false);
    }
  }

  async function discard() {
    if (proposal) {
      try {
        await api.optimize.discard(proposal.id);
      } catch {
        // best-effort — closing is what matters
      }
    }
    onClose();
  }

  return (
    <div className="rounded-md border border-primary/40 bg-primary/5 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-primary/80">
          <Wand2 className="h-3 w-3" />
          {t('optimize.proposeHeading')}
        </span>
        <button
          onClick={() => void discard()}
          aria-label={t('common.close')}
          className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {error && (
        <div className="mb-2 flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      )}

      {busy ? (
        <div className="flex items-center gap-2 p-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('optimize.proposing')}
        </div>
      ) : proposal ? (
        <ProposalBody proposal={proposal} applying={applying} onApply={apply} onDiscard={discard} />
      ) : null}
    </div>
  );
}

function ProposalBody({
  proposal,
  applying,
  onApply,
  onDiscard,
}: {
  proposal: OptimizationProposal;
  applying: boolean;
  onApply: () => void;
  onDiscard: () => void;
}) {
  const t = useT();
  const diff = collapseContext(lineDiff(proposal.baselineMarkdown, proposal.proposedMarkdown));
  const blocked = !proposal.applicable;

  return (
    <div className="space-y-2 text-xs">
      <div className="rounded border border-emerald-500/30 bg-emerald-500/5 p-2">
        <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
          {t('optimize.expectedImprovement')}
        </div>
        <p className="text-foreground">{proposal.expectedImprovement}</p>
      </div>

      <details open className="rounded border bg-background">
        <summary className="cursor-pointer select-none px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t('optimize.diff')}
        </summary>
        <pre className="max-h-72 overflow-auto border-t font-mono text-[11px] leading-relaxed">
          {diff.map((line, i) =>
            line.kind === 'gap' ? (
              <div key={i} className="bg-muted/40 px-2 py-0.5 text-center text-muted-foreground/60">
                ⋯ {t('optimize.diffGap', { count: line.count })}
              </div>
            ) : (
              <div
                key={i}
                className={cn(
                  'whitespace-pre-wrap break-words px-2',
                  line.kind === 'add' && 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300',
                  line.kind === 'del' && 'bg-destructive/15 text-destructive line-through/0',
                )}
              >
                <span className="select-none text-muted-foreground/50">
                  {line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  '}
                </span>
                {line.text || ' '}
              </div>
            ),
          )}
        </pre>
      </details>

      {proposal.verificationPrompts.length > 0 && (
        <div className="rounded border bg-background p-2">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t('optimize.verifyHeading')}
          </div>
          <div className="space-y-1">
            {proposal.verificationPrompts.map((p, i) => (
              <VerificationPrompt key={i} text={p} />
            ))}
          </div>
        </div>
      )}

      {blocked && proposal.gate.blocking.length > 0 && (
        <div className="rounded border border-destructive/30 bg-destructive/5 p-2">
          <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-destructive">
            <AlertTriangle className="h-3 w-3" />
            {t('optimize.gateBlocked')}
          </div>
          <ul className="space-y-0.5 pl-3">
            {proposal.gate.blocking.map((b, i) => (
              <li key={i} className="list-disc text-destructive">
                {b.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* gate.warnings intentionally NOT shown here. The rewrite is surgical
          (it fixes ONE diagnosis finding), but the gate runs the whole-skill
          quality linter over the result — so its warnings ("add an Inputs
          section", "add boundaries"…) report the skill's PRE-EXISTING
          structural gaps, not defects of this rewrite. They're not actionable
          on an apply/discard screen (the user didn't author the text, the AI
          did) and read as a wall of errors. Only `blocking` is surfaced — it's
          the real "this rewrite is unsafe/invalid to write" gate, and the user
          CAN act on it (discard / regenerate). */}

      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          className="h-7 px-3 text-[11px]"
          onClick={onApply}
          disabled={applying || blocked}
          title={blocked ? t('optimize.gateBlocked') : t('optimize.applyTitle')}
        >
          {applying ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Check className="mr-1 h-3 w-3" />}
          {t('optimize.applyBtn')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-3 text-[11px]"
          onClick={onDiscard}
          disabled={applying}
        >
          {t('optimize.discardBtn')}
        </Button>
      </div>
    </div>
  );
}

function VerificationPrompt({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-1.5">
      <button
        onClick={() => {
          void navigator.clipboard
            .writeText(text)
            .then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            })
            .catch(() => {});
        }}
        title={t('optimize.copyPrompt')}
        className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
      >
        {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <CopyIcon className="h-3 w-3" />}
      </button>
      <code className="min-w-0 break-words rounded bg-secondary/40 px-1.5 py-0.5 font-mono text-[11px]">
        {text}
      </code>
    </div>
  );
}

/** Applied-round timeline with per-round rollback. */
export function OptimizeHistory({ skillId, refreshKey }: { skillId: string; refreshKey: number }) {
  const t = useT();
  const [rounds, setRounds] = useState<OptimizationRound[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setRounds(await api.optimize.history(skillId));
    } catch {
      setRounds([]);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillId, refreshKey]);

  async function rollback(round: OptimizationRound) {
    if (round.syncHistoryId == null) return;
    setBusyId(round.id);
    setError(null);
    try {
      await api.sync.rollback(round.syncHistoryId);
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusyId(null);
    }
  }

  if (rounds.length === 0) return null;

  return (
    <div className="rounded-md border bg-background p-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {t('optimize.historyHeading')}
      </div>
      {error && <div className="mb-2 text-xs text-destructive">{error}</div>}
      <div className="space-y-2">
        {rounds.map((round) => (
          <div key={round.id} className="flex items-start justify-between gap-2 text-xs">
            <div className="min-w-0">
              <p className={cn('break-words', round.rolledBack && 'text-muted-foreground line-through')}>
                {round.expectedImprovement}
              </p>
              {round.rolledBack && (
                <span className="text-[10px] text-muted-foreground">{t('optimize.rolledBack')}</span>
              )}
            </div>
            {!round.rolledBack && round.syncHistoryId != null && (
              <button
                onClick={() => void rollback(round)}
                disabled={busyId === round.id}
                title={t('optimize.rollbackTitle')}
                className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                {busyId === round.id ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RotateCcw className="h-3 w-3" />
                )}
                {t('optimize.rollback')}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
