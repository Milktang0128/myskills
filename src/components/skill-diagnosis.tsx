'use client';

/**
 * 优化诊断（三问一刀）— phase 1 read-only panel inside SkillDetail.
 * Design: docs/design/skill-optimization.md. Runs the diagnosis as an ai job
 * (kind 'optimize_diagnose'), polls ai:job:get, and renders the cached report
 * with a stale flag when the skill content has changed since.
 */
import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Loader2,
  RefreshCw,
  Stethoscope,
} from 'lucide-react';
import type {
  AiJob,
  DiagnosisFinding,
  SkillDiagnosis,
  SkillDiagnosisSnapshot,
} from '@shared/types';
import { Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OptimizeFix, OptimizeHistory } from '@/components/skill-optimize';
import { api } from '@/lib/api';
import { useI18n, useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const ACTIVE = ['queued', 'running'];

const QUESTION_KEYS = {
  trigger: 'diagnosis.question.trigger',
  executability: 'diagnosis.question.executability',
  benchmark: 'diagnosis.question.benchmark',
} as const;

function messageOf(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

export function SkillDiagnosis({ skillId }: { skillId: string }) {
  const t = useT();
  const { locale } = useI18n();
  const lang: 'zh' | 'en' = locale;
  const [snapshot, setSnapshot] = useState<SkillDiagnosisSnapshot | null>(null);
  const [job, setJob] = useState<AiJob<SkillDiagnosis> | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The finding the user is actively fixing (mounts the rewrite flow), and a
  // counter that re-renders the applied-round history after a write/rollback.
  const [activeFindingId, setActiveFindingId] = useState<string | null>(null);
  const [historyRefresh, setHistoryRefresh] = useState(0);

  // Cached report + any still-active job from a previous panel visit.
  useEffect(() => {
    let cancelled = false;
    setSnapshot(null);
    setJob(null);
    setRunning(false);
    setError(null);
    setActiveFindingId(null);
    void api.optimize
      .getReport(skillId, lang)
      .then((snap) => {
        if (!cancelled) setSnapshot(snap);
      })
      .catch(() => {});
    void api.ai
      .jobLatest<SkillDiagnosis>('optimize_diagnose', `${skillId}:${lang}`)
      .then((existing) => {
        if (cancelled || !existing || !ACTIVE.includes(existing.status)) return;
        setJob(existing);
        setRunning(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [skillId, lang]);

  useEffect(() => {
    if (!job || !ACTIVE.includes(job.status)) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await api.ai.jobGet<SkillDiagnosis>(job.jobId);
        if (cancelled) return;
        setJob(next);
        if (next.status === 'succeeded') {
          const snap = await api.optimize.getReport(skillId, lang);
          if (cancelled) return;
          setSnapshot(snap);
          setRunning(false);
          setJob(null);
        } else if (next.status === 'failed') {
          setError(messageOf(next.error));
          setRunning(false);
          setJob(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(messageOf(err));
          setRunning(false);
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
  }, [job, skillId, lang]);

  async function run(force: boolean) {
    setRunning(true);
    setError(null);
    try {
      const started = await api.optimize.diagnoseJob(skillId, lang, force);
      setJob(started);
    } catch (err) {
      setError(messageOf(err));
      setRunning(false);
    }
  }

  const report = snapshot?.report ?? null;

  // After a successful write: re-diagnose against the new content and refresh
  // the round history. This closes the loop — the user sees the before/after.
  function onApplied() {
    setActiveFindingId(null);
    setHistoryRefresh((n) => n + 1);
    void run(true);
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Stethoscope className="h-3 w-3" aria-hidden="true" />
          {t('diagnosis.heading')}
        </h3>
        {report && !running && (
          <button
            onClick={() => void run(true)}
            title={t('diagnosis.rerunTitle')}
            aria-label={t('diagnosis.rerunTitle')}
            className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RefreshCw className="h-3 w-3" />
            {t('diagnosis.rerun')}
          </button>
        )}
      </div>

      {error && (
        <div className="mb-2 flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      )}

      {running ? (
        <div className="flex items-center gap-2 rounded-md border bg-background p-3 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('diagnosis.running')}
        </div>
      ) : !report ? (
        <div className="rounded-md border bg-background p-3 text-xs">
          <p className="mb-2 text-muted-foreground">{t('diagnosis.empty')}</p>
          <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => void run(false)}>
            <Stethoscope className="mr-1 h-3 w-3" />
            {t('diagnosis.runBtn')}
          </Button>
        </div>
      ) : (
        <DiagnosisReport
          report={report}
          stale={snapshot?.stale ?? false}
          onRerun={() => void run(true)}
          skillId={skillId}
          activeFindingId={activeFindingId}
          onFix={setActiveFindingId}
          onApplied={onApplied}
          historyRefresh={historyRefresh}
        />
      )}
    </section>
  );
}

function DiagnosisReport({
  report,
  stale,
  onRerun,
  skillId,
  activeFindingId,
  onFix,
  onApplied,
  historyRefresh,
}: {
  report: SkillDiagnosis;
  stale: boolean;
  onRerun: () => void;
  skillId: string;
  activeFindingId: string | null;
  onFix: (findingId: string | null) => void;
  onApplied: () => void;
  historyRefresh: number;
}) {
  const t = useT();
  const recommended = report.findings.find((f) => f.id === report.recommendedFindingId) ?? null;
  const rest = report.findings.filter((f) => f.id !== report.recommendedFindingId);
  const renderFix = (finding: DiagnosisFinding) =>
    activeFindingId === finding.id ? (
      <OptimizeFix
        skillId={skillId}
        finding={finding}
        onApplied={onApplied}
        onClose={() => onFix(null)}
      />
    ) : (
      <button
        onClick={() => onFix(finding.id)}
        className="inline-flex items-center gap-1 rounded border border-primary/40 px-2 py-1 text-[11px] text-primary hover:bg-primary/10"
      >
        <Wand2 className="h-3 w-3" />
        {t('optimize.fixBtn')}
      </button>
    );

  return (
    <div className="space-y-2">
      {stale && (
        <button
          onClick={onRerun}
          className="flex w-full items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-left text-xs text-amber-700 hover:bg-amber-500/20 dark:text-amber-400"
        >
          <AlertTriangle className="h-3 w-3 shrink-0" />
          {t('diagnosis.stale')}
        </button>
      )}

      <div className="rounded-md border bg-background p-3">
        <div className="space-y-1.5">
          {(['trigger', 'executability', 'benchmark'] as const).map((q) => (
            <VerdictRow key={q} label={t(QUESTION_KEYS[q])} verdict={report.verdicts[q]} />
          ))}
        </div>
      </div>

      {recommended && (
        <div className="rounded-md border border-primary/40 bg-primary/5 p-3">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-primary/80">
            {t('diagnosis.recommended')}
          </div>
          <FindingBody finding={recommended} />
          <div className="mt-2">{renderFix(recommended)}</div>
        </div>
      )}

      {rest.length > 0 && (
        <details className="rounded-md border bg-background p-3 text-xs">
          <summary className="cursor-pointer select-none text-muted-foreground">
            {t('diagnosis.moreFindings', { count: rest.length })}
          </summary>
          <div className="mt-2 space-y-3">
            {rest.map((f) => (
              <div key={f.id} className="space-y-2">
                <FindingBody finding={f} />
                {renderFix(f)}
              </div>
            ))}
          </div>
        </details>
      )}

      {report.findings.length === 0 && (
        <div className="flex items-center gap-1.5 rounded-md border bg-background p-3 text-xs text-muted-foreground">
          <Check className="h-3.5 w-3.5 text-emerald-600" />
          {t('diagnosis.clean')}
        </div>
      )}

      <BenchmarkSection report={report} />
      <OptimizeHistory skillId={skillId} refreshKey={historyRefresh} />
    </div>
  );
}

function VerdictRow({ label, verdict }: { label: string; verdict: 'good' | 'needs_work' | 'no_data' }) {
  const t = useT();
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="min-w-0">{label}</span>
      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
          verdict === 'good' && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
          verdict === 'needs_work' && 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
          verdict === 'no_data' && 'bg-muted text-muted-foreground',
        )}
      >
        {verdict === 'good' && <Check className="h-2.5 w-2.5" />}
        {verdict === 'needs_work' && <AlertTriangle className="h-2.5 w-2.5" />}
        {t(`diagnosis.verdict.${verdict}`)}
      </span>
    </div>
  );
}

function FindingBody({ finding }: { finding: DiagnosisFinding }) {
  const t = useT();
  return (
    <div className="space-y-1.5 text-xs">
      <div className="flex items-start gap-1.5">
        <span
          className={cn(
            'mt-1 inline-block h-2 w-2 shrink-0 rounded-full',
            finding.severity === 'high' && 'bg-destructive',
            finding.severity === 'medium' && 'bg-amber-500',
            finding.severity === 'low' && 'bg-muted-foreground/50',
          )}
          title={t(`diagnosis.severity.${finding.severity}`)}
        />
        <span className="min-w-0 font-medium">{finding.summary}</span>
      </div>
      <blockquote className="break-words border-l-2 border-muted-foreground/30 pl-2 font-mono text-[11px] text-muted-foreground">
        {finding.evidence}
      </blockquote>
      {finding.suggestion && <p className="text-muted-foreground">{finding.suggestion}</p>}
    </div>
  );
}

function BenchmarkSection({ report }: { report: SkillDiagnosis }) {
  const t = useT();
  if (report.benchmark.empty) {
    const reason = report.benchmark.emptyReason;
    return (
      <div className="rounded-md border bg-background p-3 text-xs text-muted-foreground">
        {reason === 'catalog_unavailable'
          ? t('diagnosis.benchmark.catalogUnavailable')
          : t('diagnosis.benchmark.noPeers')}
      </div>
    );
  }
  return (
    <div className="rounded-md border bg-background p-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {t('diagnosis.benchmark.heading')}
      </div>
      <div className="space-y-3">
        {report.benchmark.peers.map((peer) => (
          <div key={`${peer.source}/${peer.name}`} className="text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => void api.app.openUrl(peer.url)}
                className="inline-flex items-center gap-1 font-medium hover:underline"
                title={peer.url}
              >
                {peer.name}
                <ExternalLink className="h-2.5 w-2.5 text-muted-foreground" />
              </button>
              <span className="text-[10px] text-muted-foreground">
                {t('diagnosis.benchmark.installs', { count: peer.installs })}
              </span>
            </div>
            {peer.patterns.length > 0 && (
              <ul className="mt-1 space-y-1 pl-4">
                {peer.patterns.map((p, i) => (
                  <li key={i} className="list-disc text-muted-foreground">
                    {p.pattern}
                  </li>
                ))}
              </ul>
            )}
            {peer.notApplicable && (
              <p className="mt-1 pl-4 text-[11px] italic text-muted-foreground/80">
                {t('diagnosis.benchmark.notApplicable', { reason: peer.notApplicable })}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
