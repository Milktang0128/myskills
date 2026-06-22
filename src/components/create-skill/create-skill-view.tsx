'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  CheckCircle2,
  FilePlus2,
  Loader2,
  LogIn,
  Pencil,
  Sparkles,
  Wand2,
} from 'lucide-react';
import type {
  AiJob,
  CreateSkillDraft,
  CreateSkillExecuteResult,
  CreateSkillQuestion,
  CreateSkillReviewReport,
  CreateSkillSafety,
  CreateSkillSpec,
  CreateSkillStartResult,
  Platform,
  PlatformId,
  Scenario,
  SyncPlan,
} from '@shared/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SyncConfirm } from '@/components/sync-confirm';
import { confirmAction } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type Step = 'input' | 'outline' | 'questions' | 'draft' | 'install' | 'done';

/**
 * The renderer's pointer to the draft being worked on. The backend keeps the
 * draft row + staging dir alive across view switches and app restarts — this
 * key is how a remount finds it again (the copy already promises "你可以离开
 * 此页"; without restore that promise only held for the background start job).
 */
const LAST_DRAFT_KEY = 'createSkill.lastDraftId';

interface Props {
  seed?: string;
  platforms: Platform[];
  scenarios: Scenario[];
  canonicalPlatform: PlatformId;
  aiAvailable: boolean;
  onInstalled: (skillId: string | null, name: string) => void;
  onToast: (message: string) => void;
  onOpenAiSettings: () => void;
}

export function CreateSkillView({
  seed = '',
  platforms,
  scenarios,
  canonicalPlatform,
  aiAvailable,
  onInstalled,
  onToast,
  onOpenAiSettings,
}: Props) {
  const { locale } = useI18n();
  const copy = locale === 'zh' ? zhCopy : enCopy;
  const [step, setStep] = useState<Step>('input');
  const [prompt, setPrompt] = useState(seed);
  const [draft, setDraft] = useState<CreateSkillDraft | null>(null);
  const [spec, setSpec] = useState<CreateSkillSpec | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<CreateSkillReviewReport | null>(null);
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [executeResult, setExecuteResult] = useState<CreateSkillExecuteResult | null>(null);
  const [targetPlatformIds, setTargetPlatformIds] = useState<PlatformId[]>([canonicalPlatform]);
  const [targetScenarioIds, setTargetScenarioIds] = useState<number[]>([]);
  const [startJob, setStartJob] = useState<AiJob<CreateSkillStartResult> | null>(null);
  // True once the user edits SKILL.md AFTER a review ran — the green "通过"
  // verdict no longer describes the current text, so installing is gated on
  // re-checking.
  const [reviewStale, setReviewStale] = useState(false);

  useEffect(() => {
    if (!seed) return;
    setPrompt(seed);
    setStep('input');
  }, [seed]);

  // Remember which draft is in progress; clear in resetAll / on install.
  useEffect(() => {
    if (draft?.id) window.localStorage.setItem(LAST_DRAFT_KEY, draft.id);
  }, [draft?.id]);

  // Restore the in-progress draft on remount (view switch / app restart).
  useEffect(() => {
    if (draft || seed) return;
    const lastId = window.localStorage.getItem(LAST_DRAFT_KEY);
    if (!lastId) return;
    let cancelled = false;
    void api.ai.createSkill
      .get(lastId)
      .then((existing) => {
        if (cancelled || !existing) return;
        const nextDraft = normalizeCreateSkillDraft(existing);
        if (nextDraft.discardedAt || nextDraft.installedAt) {
          window.localStorage.removeItem(LAST_DRAFT_KEY);
          return;
        }
        setDraft(nextDraft);
        setSpec(nextDraft.skillSpec);
        setMarkdown(nextDraft.draftMarkdown ?? '');
        setReview(nextDraft.validation);
        if (nextDraft.rawPrompt) setPrompt(nextDraft.rawPrompt);
        // Step inference mirrors applyStartResult, plus the draft stage.
        const answers = nextDraft.answers ?? {};
        const open = (nextDraft.followupQuestions ?? []).some((q) => !answers[q.id]);
        if (nextDraft.draftMarkdown) setStep('draft');
        else if (nextDraft.skillSpec) setStep(open ? 'questions' : 'outline');
      })
      .catch(() => {
        // Draft row is gone — drop the stale pointer.
        window.localStorage.removeItem(LAST_DRAFT_KEY);
      });
    return () => {
      cancelled = true;
    };
    // Mount-only: restoring mid-session would stomp live state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!targetPlatformIds.length && canonicalPlatform) {
      setTargetPlatformIds([canonicalPlatform]);
    }
  }, [canonicalPlatform, targetPlatformIds.length]);

  const currentQuestion = useMemo(
    () =>
      draft?.followupQuestions.find((q) => {
        const answers = draft.answers ?? {};
        return !answers[q.id];
      }) ?? null,
    [draft],
  );

  const targetBasename = spec?.name?.trim() || draft?.targetBasename || 'new-skill';
  const canonical = platforms.find((p) => p.id === canonicalPlatform) ?? platforms[0];

  useEffect(() => {
    if (!aiAvailable || step !== 'input') return;
    let cancelled = false;
    void api.ai
      .jobLatest<CreateSkillStartResult>('create_skill_start')
      .then((job) => {
        if (cancelled || !job || !['queued', 'running'].includes(job.status)) return;
        setStartJob(job);
        setBusy(true);
        setError(null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [aiAvailable, step]);

  useEffect(() => {
    if (!startJob || !['queued', 'running'].includes(startJob.status)) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const job = await api.ai.jobGet<CreateSkillStartResult>(startJob.jobId);
        if (cancelled) return;
        setStartJob(job);
        if (job.status === 'succeeded' && job.result) {
          applyStartResult(job.result);
          setStartJob(null);
          setBusy(false);
        } else if (job.status === 'failed') {
          setError(formatCreateSkillError(job.error ?? copy.badOutline, locale));
          setStep('input');
          setStartJob(null);
          setBusy(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(formatCreateSkillError(err, locale));
          setStartJob(null);
          setBusy(false);
        }
      }
    };
    void poll();
    const id = window.setInterval(poll, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [copy.badOutline, locale, startJob]);

  function applyStartResult(result: CreateSkillStartResult) {
    const nextDraft = normalizeCreateSkillDraft(result.draft);
    if (!nextDraft.skillSpec) {
      throw new Error(copy.badOutline);
    }
    setDraft(nextDraft);
    setSpec(nextDraft.skillSpec);
    setMarkdown(nextDraft.draftMarkdown ?? '');
    setReview(nextDraft.validation);
    // 澄清在先，纯按 Rust 自评的 status 路由：还有未答追问 → 澄清步；问清楚（ready，
    // 无未答题）→ 结晶轮廓。不再用旧的 isUsableOutline 硬门——它要求“必须有带选项的
    // 追问”，与新模型 ready 时无追问的契约直接冲突，会把清晰需求误判为不完整。ready
    // spec 的完整性已由 Rust 质量门（start_quality_issues）保证。
    const answers = nextDraft.answers ?? {};
    const hasOpenQuestions = (nextDraft.followupQuestions ?? []).some((q) => !answers[q.id]);
    setStep(hasOpenQuestions ? 'questions' : 'outline');
  }

  async function start() {
    if (!aiAvailable) {
      onToast(copy.aiRequired);
      onOpenAiSettings();
      return;
    }
    if (prompt.trim().length < 4) return;
    setBusy(true);
    setError(null);
    try {
      const job = await api.ai.createSkill.startJob({ prompt: prompt.trim(), language: locale });
      setStartJob(job);
    } catch (err) {
      setError(formatCreateSkillError(err, locale));
      setStep('input');
      setBusy(false);
    }
  }

  async function saveOutline(nextStep: Step) {
    if (!draft || !spec) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.ai.createSkill.refine({
        draftId: draft.id,
        skillSpec: normalizeSpec(spec),
        targetBasename,
      });
      const nextDraft = normalizeCreateSkillDraft(updated);
      setDraft(nextDraft);
      setSpec(nextDraft.skillSpec);
      setStep(nextStep);
    } catch (err) {
      setError(formatCreateSkillError(err, locale));
    } finally {
      setBusy(false);
    }
  }

  async function answerQuestion(question: CreateSkillQuestion, answer: string) {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.ai.createSkill.answer({
        draftId: draft.id,
        questionId: question.id,
        answer,
      });
      const nextDraft = normalizeCreateSkillDraft(result.draft);
      setDraft(nextDraft);
      setSpec(nextDraft.skillSpec);
      // 还有未答题 → 继续澄清；问清楚了 → 结晶出轮廓供确认。
      const answers = nextDraft.answers ?? {};
      const hasOpenQuestions = (nextDraft.followupQuestions ?? []).some((q) => !answers[q.id]);
      setStep(hasOpenQuestions ? 'questions' : 'outline');
    } catch (err) {
      setError(formatCreateSkillError(err, locale));
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    if (!draft || !spec) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.ai.createSkill.generate({ draftId: draft.id, skillSpec: normalizeSpec(spec) });
      const nextDraft = normalizeCreateSkillDraft(result.draft);
      setDraft(nextDraft);
      setSpec(nextDraft.skillSpec);
      setMarkdown(nextDraft.draftMarkdown ?? '');
      setReview(nextDraft.validation);
      setReviewStale(false);
      setStep('draft');
    } catch (err) {
      setError(formatCreateSkillError(err, locale));
    } finally {
      setBusy(false);
    }
  }

  async function runReview() {
    if (!draft || !markdown.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.ai.createSkill.review({
        draftId: draft.id,
        markdown,
        targetBasename,
      });
      const nextDraft = normalizeCreateSkillDraft(result.draft);
      const nextReview = normalizeCreateSkillReview(result.review);
      setDraft(nextDraft);
      setReview(nextReview);
      setReviewStale(false);
      // 可安装性只看 blocking；warning 为非阻塞提示，不阻止进入安装步骤。
      if (nextReview.blocking.length === 0) {
        setStep('install');
        onToast(copy.reviewPassedToast);
      } else {
        setStep('draft');
        onToast(copy.reviewBlockedToast);
      }
    } catch (err) {
      setError(formatCreateSkillError(err, locale));
    } finally {
      setBusy(false);
    }
  }

  async function makePlan() {
    if (!draft || !markdown.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.ai.createSkill.plan({
        draftId: draft.id,
        markdown,
        targetBasename,
        targetPlatformIds,
        targetScenarioIds,
      });
      setDraft(normalizeCreateSkillDraft(result.draft));
      setPlan(result.plan);
      setConfirmOpen(true);
    } catch (err) {
      setError(formatCreateSkillError(err, locale));
    } finally {
      setBusy(false);
    }
  }

  function setSpecField<K extends keyof CreateSkillSpec>(key: K, value: CreateSkillSpec[K]) {
    if (!spec) return;
    setSpec({ ...spec, [key]: value });
  }

  // 直写 intentFrame 上的某个字符串/数组字段（新 5 支柱）。
  function setIntentField<K extends keyof CreateSkillSpec['intentFrame']>(
    key: K,
    value: CreateSkillSpec['intentFrame'][K],
  ) {
    if (!spec) return;
    setSpec({
      ...spec,
      intentFrame: {
        ...spec.intentFrame,
        [key]: value,
      },
    });
  }

  // 直写 intentFrame.safety 上的某个枚举（折叠高级区）。
  function setSafetyField<K extends keyof CreateSkillSafety>(key: K, value: CreateSkillSafety[K]) {
    if (!spec) return;
    setSpec({
      ...spec,
      intentFrame: {
        ...spec.intentFrame,
        safety: {
          ...spec.intentFrame.safety,
          [key]: value,
        },
      },
    });
  }

  function resetAll() {
    window.localStorage.removeItem(LAST_DRAFT_KEY);
    setStep('input');
    setPrompt('');
    setDraft(null);
    setSpec(null);
    setMarkdown('');
    setReview(null);
    setReviewStale(false);
    setPlan(null);
    setExecuteResult(null);
    setStartJob(null);
    setBusy(false);
    setTargetScenarioIds([]);
    setTargetPlatformIds([canonicalPlatform]);
  }

  // Explicit "discard draft": confirm (it erases the outline + any answered
  // questions + the staging dir, with no undo), then tell the backend to mark
  // the draft discarded and clean staging, THEN reset the UI. Without the
  // backend call the DB row + staging temp dir leak forever.
  async function discardDraft() {
    const ok = await confirmAction({
      title: copy.discardConfirmTitle,
      description: copy.discardConfirmBody,
      tone: 'destructive',
      confirmLabel: copy.discardDraft,
    });
    if (!ok) return;
    const id = draft?.id;
    resetAll();
    if (id) {
      try {
        await api.ai.createSkill.discard(id);
      } catch {
        /* best-effort cleanup; UI already reset */
      }
    }
  }

  // Regenerating from the original prompt throws away the current outline +
  // answers — same blast radius as discard, so it gets the same gate.
  async function confirmRegenerate() {
    const ok = await confirmAction({
      title: copy.regenerateConfirmTitle,
      description: copy.regenerateConfirmBody,
      tone: 'destructive',
      confirmLabel: copy.regenerateOutline,
    });
    if (!ok) return;
    await start();
  }

  return (
    <div data-smoke-view="create-skill" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b px-6 py-4">
        <div>
          <div className="flex items-center gap-2">
            <FilePlus2 className="h-4 w-4" />
            <h1 className="text-base font-semibold">{copy.title}</h1>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{copy.subtitle}</p>
        </div>
        <StepRail step={step} copy={copy} />
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_320px]">
        <ScrollArea className="min-h-0 border-r">
          <div className="space-y-4 p-6">
            {error && (
              <Notice tone="danger" icon={<AlertTriangle className="h-4 w-4" />}>
                {error}
              </Notice>
            )}

            {step === 'input' && (
              <section className="space-y-4">
                {!aiAvailable && (
                  <Notice tone="info" icon={<Sparkles className="h-4 w-4" />}>
                    {copy.aiRequiredNotice}
                  </Notice>
                )}
                {startJob && ['queued', 'running'].includes(startJob.status) && (
                  <Notice tone="info" icon={<Loader2 className="h-4 w-4 animate-spin" />}>
                    {copy.backgroundRunning}
                  </Notice>
                )}
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={copy.promptPlaceholder}
                  className="min-h-[220px] w-full resize-none border bg-background p-4 text-sm leading-6 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-smoke-action="create-skill-input"
                />
                <div className="flex flex-wrap gap-2">
                  {copy.examples.map((example) => (
                    <button
                      key={example}
                      type="button"
                      onClick={() => setPrompt(example)}
                      className="border bg-background px-3 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {example}
                    </button>
                  ))}
                </div>
                <Button variant="ai" onClick={start} disabled={busy || (aiAvailable && prompt.trim().length < 4)} data-smoke-action="create-skill-start">
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                  {busy && startJob ? copy.backgroundRunningShort : aiAvailable ? copy.start : copy.configureAi}
                </Button>
              </section>
            )}

            {step === 'outline' && spec && (
              <section className="space-y-4">
                {/* 技能的本质 = 输入 → [这个技能] → 输出。把输入/输出做成视觉主体，
                    技能名作为中间的“变换”；其余（何时触发/工作流/边界/安全/验收）
                    全部收进下方「更多细节」折叠区，由 LLM 推断、用户可不管。 */}
                {/* 技能 = 输入 → [这台机器] → 输出。把输入/输出做成视觉主体，技能名
                    是中间的“变换”节点；三者连成一条竖向流水线，其余信息（何时触发 /
                    工作流 / 边界 / 安全 / 验收）折叠进下方「更多细节」。 */}
                <div className="mx-auto max-w-xl">
                  {/* ── 输入 ── */}
                  <div className="rounded-xl border bg-card p-4 shadow-sm">
                    <div className="mb-2.5 flex items-center gap-2.5">
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        <LogIn className="h-4 w-4" />
                      </span>
                      <div className="leading-tight">
                        <div className="text-sm font-semibold">{copy.flowInput}</div>
                        <div className="text-[11px] text-muted-foreground">{copy.flowInputSub}</div>
                      </div>
                    </div>
                    <textarea
                      value={spec.intentFrame.userInput}
                      onChange={(e) => setIntentField('userInput', e.target.value)}
                      placeholder={copy.flowInputHint}
                      className="min-h-[120px] w-full resize-none rounded-lg border bg-muted/30 px-3.5 py-3 text-sm leading-7 transition-colors placeholder:text-muted-foreground/50 focus:bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>

                  {/* 连接线 + 节点 */}
                  <div className="flex flex-col items-center">
                    <span className="h-4 w-px bg-border" />
                    <ChevronDown className="-my-1 h-4 w-4 text-muted-foreground/40" />
                  </div>

                  {/* ── 技能名：中间的“变换”节点（焦点）── */}
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                      {copy.skillNodeLabel}
                    </span>
                    <div className="inline-flex items-center gap-2 rounded-full border bg-background px-3.5 py-1.5 shadow-sm focus-within:ring-2 focus-within:ring-ring">
                      <Wand2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <input
                        value={spec.name}
                        onChange={(e) => setSpecField('name', slugInput(e.target.value))}
                        placeholder="skill-name"
                        aria-label={copy.name}
                        className="w-48 max-w-full border-0 bg-transparent p-0 text-center text-sm font-medium focus:outline-none"
                      />
                    </div>
                  </div>

                  <div className="flex flex-col items-center">
                    <ChevronDown className="-mb-1 h-4 w-4 text-muted-foreground/40" />
                    <span className="h-4 w-px bg-border" />
                  </div>

                  {/* ── 输出 ── */}
                  <div className="rounded-xl border bg-card p-4 shadow-sm">
                    <div className="mb-2.5 flex items-center gap-2.5">
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        <Sparkles className="h-4 w-4" />
                      </span>
                      <div className="leading-tight">
                        <div className="text-sm font-semibold">{copy.flowOutput}</div>
                        <div className="text-[11px] text-muted-foreground">{copy.flowOutputSub}</div>
                      </div>
                    </div>
                    <textarea
                      value={spec.intentFrame.output}
                      onChange={(e) => setIntentField('output', e.target.value)}
                      placeholder={copy.flowOutputHint}
                      className="min-h-[120px] w-full resize-none rounded-lg border bg-muted/30 px-3.5 py-3 text-sm leading-7 transition-colors placeholder:text-muted-foreground/50 focus:bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    {/* outputParts：“输出包含” —— 把输出定清楚的防空洞要点，从属于输出框 */}
                    <div className="mt-3 border-t pt-3">
                      <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">{copy.outputPartsLabel}</div>
                      <textarea
                        value={safeStringList(spec.intentFrame.outputParts).join('\n')}
                        onChange={(e) => setIntentField('outputParts', lines(e.target.value))}
                        placeholder={copy.outputPartsHint}
                        className="min-h-[60px] w-full resize-none rounded-lg border bg-muted/20 px-3.5 py-2.5 text-xs leading-6 transition-colors placeholder:text-muted-foreground/50 focus:bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                    </div>
                  </div>
                </div>

                <details className="border bg-background/50 p-3 text-sm [&[open]>summary]:mb-3">
                  <summary className="cursor-pointer select-none font-medium text-muted-foreground">
                    {copy.moreDetailsTitle}
                  </summary>
                  <div className="space-y-3">
                    <Field label={copy.whenToUse}>
                      <textarea
                        value={spec.intentFrame.whenToUse}
                        onChange={(e) => setIntentField('whenToUse', e.target.value)}
                        className="min-h-[72px] w-full resize-none border bg-background p-3 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                    </Field>
                    <Field label={copy.workflow}>
                      <textarea
                        value={safeStringList(spec.intentFrame.workflow).join('\n')}
                        onChange={(e) => setIntentField('workflow', lines(e.target.value))}
                        className="min-h-[120px] w-full resize-none border bg-background p-3 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                    </Field>
                    <Field label={copy.boundaries}>
                      <textarea
                        value={boundaryLines(spec).join('\n')}
                        onChange={(e) => setIntentField('boundaries', lines(e.target.value))}
                        className="min-h-[96px] w-full resize-none border bg-background p-3 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                    </Field>
                    <Field label={copy.description}>
                      <input
                        value={spec.description}
                        onChange={(e) => setSpecField('description', e.target.value)}
                        className="h-9 w-full border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                    </Field>
                    <div className="grid gap-3 md:grid-cols-2">
                      <Field label={copy.safetyArtifactType}>
                        <select
                          value={spec.intentFrame.safety.artifactType}
                          onChange={(e) =>
                            setSafetyField('artifactType', e.target.value as CreateSkillSafety['artifactType'])
                          }
                          className="h-9 w-full border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <option value="markdown">Markdown</option>
                          <option value="checklist">Checklist</option>
                          <option value="report">Report</option>
                          <option value="code_patch">Code patch</option>
                          <option value="file">File</option>
                          <option value="other">Other</option>
                        </select>
                      </Field>
                      <Field label={copy.safetyNetwork}>
                        <select
                          value={spec.intentFrame.safety.network}
                          onChange={(e) =>
                            setSafetyField('network', e.target.value as CreateSkillSafety['network'])
                          }
                          className="h-9 w-full border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <option value="no">{copy.networkNo}</option>
                          <option value="reads_only">{copy.networkReadsOnly}</option>
                          <option value="reads_writes">{copy.networkReadsWrites}</option>
                        </select>
                      </Field>
                      <Field label={copy.safetyFileWrites}>
                        <select
                          value={spec.intentFrame.safety.fileWrites}
                          onChange={(e) =>
                            setSafetyField('fileWrites', e.target.value as CreateSkillSafety['fileWrites'])
                          }
                          className="h-9 w-full border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <option value="none">{copy.fileWritesNone}</option>
                          <option value="same_folder">{copy.fileWritesSameFolder}</option>
                          <option value="user_selected">{copy.fileWritesUserSelected}</option>
                        </select>
                      </Field>
                      <Field label={copy.safetyOverwrite}>
                        <select
                          value={spec.intentFrame.safety.overwrite}
                          onChange={(e) =>
                            setSafetyField('overwrite', e.target.value as CreateSkillSafety['overwrite'])
                          }
                          className="h-9 w-full border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <option value="never">{copy.overwriteNever}</option>
                          <option value="confirm_each_time">{copy.overwriteConfirm}</option>
                        </select>
                      </Field>
                      <Field label={copy.safetyPrivacy}>
                        <select
                          value={spec.intentFrame.safety.privacy}
                          onChange={(e) =>
                            setSafetyField('privacy', e.target.value as CreateSkillSafety['privacy'])
                          }
                          className="h-9 w-full border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <option value="local_only">{copy.privacyLocalOnly}</option>
                          <option value="may_send_summary">{copy.privacyMaySendSummary}</option>
                          <option value="may_send_content">{copy.privacyMaySendContent}</option>
                        </select>
                      </Field>
                    </div>
                    <Field label={copy.criteria}>
                      <textarea
                        value={safeStringList(spec.intentFrame.successCriteria).join('\n')}
                        onChange={(e) => setIntentField('successCriteria', lines(e.target.value))}
                        className="min-h-[88px] w-full resize-none border bg-background p-3 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                    </Field>
                  </div>
                </details>

                <div className="flex gap-2">
                  {/* 轮廓 = 澄清后的结晶确认面：主操作直接生成 SKILL.md。
                      这是最长的 LLM 调用——必须有清晰的进行中反馈。 */}
                  <Button variant="ai" onClick={generate} disabled={busy || !spec}>
                    {busy ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        {copy.generating}
                      </>
                    ) : (
                      <>
                        <Sparkles className="mr-2 h-4 w-4" />
                        {copy.generateDraft}
                      </>
                    )}
                  </Button>
                  {/* saveOutline 先把手改的轮廓字段写回后端再切步——直接 setStep
                      会让后端 spec 在下一轮覆盖掉用户的编辑（静默丢失）。 */}
                  <Button variant="outline" onClick={() => saveOutline('questions')} disabled={busy}>
                    {copy.refineMore}
                  </Button>
                  <Button variant="outline" onClick={confirmRegenerate} disabled={busy || prompt.trim().length < 4}>
                    {copy.regenerateOutline}
                  </Button>
                  <Button variant="outline" onClick={discardDraft} disabled={busy}>
                    {copy.discardDraft}
                  </Button>
                </div>
              </section>
            )}

            {step === 'questions' && (
              <section className="space-y-4">
                {/* 澄清在先：先把卡住输入/输出契约的关键点问清楚，再结晶出轮廓。
                    顶部一行 AI 理解复述，让用户在答细节前就能纠正根本误读。 */}
                {draft?.understanding && (
                  <Notice tone="info" icon={<Sparkles className="h-4 w-4" />}>
                    {copy.understandingPrefix}
                    {draft.understanding}
                  </Notice>
                )}
                {busy && (
                  <Notice tone="info" icon={<Loader2 className="h-4 w-4 animate-spin" />}>
                    {copy.crystallizing}
                  </Notice>
                )}
                {currentQuestion ? (
                  <QuestionBlock
                    question={currentQuestion}
                    busy={busy}
                    onAnswer={(answer) => answerQuestion(currentQuestion, answer)}
                  />
                ) : (
                  <Notice tone="success" icon={<CheckCircle2 className="h-4 w-4" />}>
                    {copy.questionsDone}
                  </Notice>
                )}
                <div className="flex gap-2">
                  {currentQuestion ? (
                    <Button variant="outline" onClick={() => setStep('outline')} disabled={busy || !spec}>
                      {copy.enoughGenerate}
                    </Button>
                  ) : (
                    <Button onClick={() => setStep('outline')} disabled={busy || !spec}>
                      {copy.viewOutline}
                    </Button>
                  )}
                  <Button variant="outline" onClick={() => setStep('input')} disabled={busy}>
                    {copy.backInput}
                  </Button>
                </div>
              </section>
            )}

            {(step === 'draft' || step === 'install') && (
              <section className="space-y-4">
                {spec && <SkillBehaviorSummary spec={spec} copy={copy} />}
                <Field label="SKILL.md">
                  <textarea
                    value={markdown}
                    onChange={(e) => {
                      setMarkdown(e.target.value);
                      // Editing voids a previous review verdict — the green
                      // "通过" would otherwise keep describing text that no
                      // longer exists (and install would hit REVIEW_BLOCKED
                      // with a raw English error).
                      if (review) {
                        setReviewStale(true);
                        if (step === 'install') setStep('draft');
                      }
                    }}
                    className="min-h-[360px] w-full resize-y border bg-background p-3 font-mono text-xs leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    spellCheck={false}
                  />
                </Field>
                {review && <ReviewPanel review={review} stale={reviewStale} copy={copy} />}
                {executeResult && (executeResult.sync.failed?.length ?? 0) > 0 && (
                  <Notice tone="danger" icon={<AlertTriangle className="h-4 w-4" />}>
                    <span className="block">{copy.installFailed}</span>
                    <ul className="mt-1 space-y-0.5">
                      {executeResult.sync.failed.map((f, i) => (
                        <li key={i} className="break-all font-mono text-[11px]">
                          {f.item.targetPath}: {f.message}
                        </li>
                      ))}
                    </ul>
                  </Notice>
                )}
                <div className="flex gap-2">
                  <Button onClick={runReview} disabled={busy || !markdown.trim()}>
                    {busy ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        {copy.reviewing}
                      </>
                    ) : review ? (
                      copy.reviewAgain
                    ) : (
                      copy.review
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setStep('outline')}
                    disabled={busy}
                  >
                    {copy.editOutline}
                  </Button>
                </div>
              </section>
            )}

            {step === 'done' && (
              <section className="space-y-4">
                <Notice tone="success" icon={<CheckCircle2 className="h-4 w-4" />}>
                  {copy.done}
                </Notice>
                <div className="flex gap-2">
                  <Button onClick={() => onInstalled(executeResult?.skillId ?? null, targetBasename)}>
                    {copy.openLibrary}
                  </Button>
                  <Button variant="outline" onClick={resetAll}>
                    {copy.createAnother}
                  </Button>
                </div>
              </section>
            )}
          </div>
        </ScrollArea>

        <aside className="min-h-0 bg-neutral-50/70 dark:bg-background">
          <ScrollArea className="h-full">
            <div className="space-y-5 p-4">
              <section className="space-y-2">
                <h2 className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">{copy.installTarget}</h2>
                <div className="space-y-1">
                  {platforms.map((platform) => {
                    // The source platform is always written (the engine copies
                    // there unconditionally), so its checkbox is locked on —
                    // unchecking it would desync the UI from what actually happens.
                    const isSource = platform.id === canonicalPlatform;
                    return (
                      <label key={platform.id} className="flex items-center gap-2 border bg-background px-2 py-2 text-xs">
                        <input
                          type="checkbox"
                          checked={isSource || targetPlatformIds.includes(platform.id)}
                          disabled={isSource}
                          onChange={(e) => {
                            if (isSource) return;
                            setTargetPlatformIds((ids) =>
                              e.target.checked ? [...new Set([...ids, platform.id])] : ids.filter((id) => id !== platform.id),
                            );
                          }}
                        />
                        <span className="min-w-0 flex-1 truncate">{platform.label}</span>
                        {isSource && <Badge>{copy.mainSource}</Badge>}
                      </label>
                    );
                  })}
                </div>
              </section>

              <section className="space-y-2">
                <h2 className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">{copy.scenarioTarget}</h2>
                <div className="space-y-1">
                  {scenarios.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{copy.noScenarios}</p>
                  ) : (
                    scenarios.map((scenario) => (
                      <label key={scenario.id} className="flex items-center gap-2 border bg-background px-2 py-2 text-xs">
                        <input
                          type="checkbox"
                          checked={targetScenarioIds.includes(scenario.id)}
                          onChange={(e) => {
                            setTargetScenarioIds((ids) =>
                              e.target.checked ? [...ids, scenario.id] : ids.filter((id) => id !== scenario.id),
                            );
                          }}
                        />
                        <span className="min-w-0 flex-1 truncate">{scenario.name}</span>
                      </label>
                    ))
                  )}
                </div>
              </section>

              <section className="space-y-2">
                <h2 className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">{copy.installSummary}</h2>
                <div className="space-y-1 border bg-background p-3 text-xs">
                  <p className="pb-2 text-muted-foreground">{copy.noWriteUntilConfirm}</p>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">{copy.basename}</span>
                    <span className="truncate font-mono">{targetBasename}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">{copy.mainSource}</span>
                    <span className="truncate">{canonical?.label ?? canonicalPlatform}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">{copy.selectedPlatforms}</span>
                    <span>{targetPlatformIds.length}</span>
                  </div>
                </div>
                <Button
                  className="w-full"
                  onClick={makePlan}
                  disabled={
                    busy ||
                    !draft ||
                    !markdown.trim() ||
                    review == null ||
                    // 编辑过 markdown → 上次审查不再算数，先重新检查。
                    reviewStale ||
                    // 只看 blocking：warning 为非阻塞质量提示，仍允许安装。
                    review.blocking.length !== 0 ||
                    targetPlatformIds.length === 0
                  }
                  data-smoke-action="create-skill-plan"
                >
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {copy.planInstall}
                </Button>
              </section>

              {spec && (
                <section className="space-y-2">
                  <h2 className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">{copy.qualityTitle}</h2>
                  <QualityChecklist spec={spec} review={review} copy={copy} />
                </section>
              )}
            </div>
          </ScrollArea>
        </aside>
      </div>

      <SyncConfirm
        open={confirmOpen}
        plan={plan}
        canonicalPlatform={canonicalPlatform}
        onOpenChange={setConfirmOpen}
        onExecute={async (token) => {
          if (!draft) throw new Error('draft missing');
          const result = await api.ai.createSkill.execute({
            draftId: draft.id,
            token,
            targetScenarioIds,
          });
          if ((result.sync.failed?.length ?? 0) > 0 || !result.skillId) {
            setExecuteResult(result);
            setDraft(normalizeCreateSkillDraft(result.draft));
            throw new Error(copy.installFailed);
          }
          setExecuteResult(result);
          setDraft(normalizeCreateSkillDraft(result.draft));
          window.localStorage.removeItem(LAST_DRAFT_KEY);
          setStep('done');
          return result.sync;
        }}
        onApplied={() => {
          onToast(copy.created);
        }}
      />
    </div>
  );
}

function StepRail({ step, copy }: { step: Step; copy: Copy }) {
  // Rail order mirrors the actual flow (clarify-first): questions come
  // BEFORE the crystallized outline. 'done' isn't a segment — it lights the
  // whole rail.
  const steps: Step[] = ['input', 'questions', 'outline', 'draft', 'install'];
  const active = step === 'done' ? steps.length - 1 : Math.max(0, steps.indexOf(step));
  return (
    <div className="hidden items-center gap-1 lg:flex">
      {steps.map((item, index) => (
        <div
          key={item}
          className={cn(
            'h-1.5 w-10',
            index <= active ? 'bg-primary' : 'bg-muted',
          )}
          title={copy.steps[item]}
        />
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function QuestionBlock({
  question,
  busy,
  onAnswer,
}: {
  question: CreateSkillQuestion;
  busy: boolean;
  onAnswer: (answer: string) => void;
}) {
  const [freeform, setFreeform] = useState('');
  return (
    <div className="space-y-3 border bg-background p-4">
      <h2 className="text-sm font-semibold">{question.question}</h2>
      <div className="grid gap-2 sm:grid-cols-3">
        {question.options.map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={busy}
            onClick={() => onAnswer(`${option.id}: ${option.label}`)}
            className="border px-3 py-3 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <span className="block font-medium">{option.label}</span>
          </button>
        ))}
      </div>
      {question.allowFreeform && (
        <div className="flex gap-2">
          <input
            value={freeform}
            onChange={(e) => setFreeform(e.target.value)}
            className="h-9 min-w-0 flex-1 border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button variant="outline" disabled={!freeform.trim() || busy} onClick={() => onAnswer(freeform)}>
            OK
          </Button>
        </div>
      )}
    </div>
  );
}

function ReviewPanel({ review, stale, copy }: { review: CreateSkillReviewReport; stale?: boolean; copy: Copy }) {
  const safeReview = normalizeCreateSkillReview(review);
  const blocking = safeReview.blocking;
  const warnings = safeReview.warnings;
  return (
    <div className="space-y-2">
      {stale ? (
        <Notice tone="info" icon={<AlertTriangle className="h-4 w-4" />}>
          {copy.reviewStale}
        </Notice>
      ) : blocking.length === 0 ? (
        <Notice tone="success" icon={<CheckCircle2 className="h-4 w-4" />}>
          {copy.reviewPassed}
        </Notice>
      ) : (
        <Notice tone="danger" icon={<AlertTriangle className="h-4 w-4" />}>
          {copy.reviewBlocked}
        </Notice>
      )}
      {[...blocking, ...warnings].map((issue) => (
        <div key={`${issue.code}-${issue.message}`} className="border bg-background px-3 py-2 text-xs">
          <span className="font-mono text-muted-foreground">{issue.code}</span>
          <span className="ml-2">{issue.message}</span>
        </div>
      ))}
    </div>
  );
}

function SkillBehaviorSummary({ spec, copy }: { spec: CreateSkillSpec; copy: Copy }) {
  const safeSpec = normalizeSpec(spec);
  return (
    <div className="grid gap-3 border bg-background p-4 text-xs md:grid-cols-2">
      <SummaryItem label={copy.whenToUse} value={safeSpec.intentFrame.whenToUse} />
      <SummaryItem label={copy.userInput} value={safeSpec.intentFrame.userInput} />
      <SummaryItem label={copy.output} value={safeSpec.intentFrame.output} />
      <SummaryItem label={copy.outputParts} value={safeSpec.intentFrame.outputParts.join('\n')} />
      <SummaryItem
        label={copy.safetyArtifactType}
        value={`${safeSpec.intentFrame.safety.artifactType} / ${safeSpec.intentFrame.safety.fileWrites}`}
      />
      <SummaryItem label={copy.boundaries} value={boundaryLines(safeSpec).join('\n')} />
      <SummaryItem label={copy.criteria} value={safeSpec.intentFrame.successCriteria.join('\n')} />
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <div className="font-medium text-muted-foreground">{label}</div>
      <div className="whitespace-pre-wrap leading-5">{value || '-'}</div>
    </div>
  );
}

function QualityChecklist({
  spec,
  review,
  copy,
}: {
  spec: CreateSkillSpec;
  review: CreateSkillReviewReport | null;
  copy: Copy;
}) {
  const safeSpec = normalizeSpec(spec);
  const safeReview = review ? normalizeCreateSkillReview(review) : null;
  const checks = safeReview?.checks;
  const safetyItems = [
    {
      label: copy.safetyParseable,
      ok: checks == null ? true : checks.parseableFrontmatter && checks.safeName && checks.nameMatchesBasename,
    },
    {
      label: copy.safetySecrets,
      ok: checks == null ? true : checks.noPrivateFields && checks.noSecretExfiltration,
    },
    {
      label: copy.safetyActions,
      ok:
        checks == null
          ? true
          : checks.noSilentNetwork &&
            checks.noSilentOverwrite &&
            checks.noDangerousShellDefault &&
            // New blocking-level exfil check (normalizer defaults absent → safe).
            checks.noCommandSubstitutionExfil,
    },
  ];
  const qualityItems = [
    {
      label: copy.qualityTrigger,
      ok: checks?.triggerDescription ?? safeSpec.intentFrame.whenToUse.trim().length > 20,
    },
    {
      label: copy.qualityInputs,
      ok: checks?.hasInputs ?? safeSpec.intentFrame.userInput.trim().length > 0,
    },
    {
      label: copy.qualityWorkflow,
      ok: checks?.hasWorkflow ?? safeSpec.intentFrame.workflow.length >= 3,
    },
    {
      label: copy.qualityOutput,
      ok: checks?.hasOutput ?? (safeSpec.intentFrame.output.trim().length > 0 && safeSpec.intentFrame.outputParts.length >= 2),
    },
    {
      label: copy.qualityBoundaries,
      ok: checks?.hasBoundaries ?? safeSpec.intentFrame.boundaries.length > 0,
    },
    {
      label: copy.qualityCriteria,
      ok: checks?.hasQualityBar ?? safeSpec.intentFrame.successCriteria.length > 0,
    },
  ];
  return (
    <div className="space-y-3 border bg-background p-3 text-xs">
      <ChecklistGroup title={copy.safetyGateTitle} items={safetyItems} failTone="danger" />
      <ChecklistGroup title={copy.creativeQualityTitle} items={qualityItems} failTone="warning" />
    </div>
  );
}

function ChecklistGroup({
  title,
  items,
  failTone,
}: {
  title: string;
  items: Array<{ label: string; ok: boolean }>;
  failTone: 'danger' | 'warning';
}) {
  return (
    <div className="space-y-1">
      <div className="font-medium text-muted-foreground">{title}</div>
      {items.map((item) => (
        <div key={item.label} className="flex items-center gap-2">
          {item.ok ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
          ) : (
            <AlertTriangle
              className={cn(
                'h-3.5 w-3.5',
                failTone === 'danger' ? 'text-destructive' : 'text-amber-600',
              )}
            />
          )}
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  );
}

function Notice({
  tone,
  icon,
  children,
}: {
  tone: 'success' | 'danger' | 'info';
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 border px-3 py-2 text-xs',
        tone === 'success'
          ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200'
          : tone === 'info'
            ? 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/30 dark:text-sky-200'
            : 'border-destructive/30 bg-destructive/10 text-destructive',
      )}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span>{children}</span>
    </div>
  );
}

function normalizeCreateSkillDraft(draft: CreateSkillDraft): CreateSkillDraft {
  const source: Record<string, unknown> = isRecord(draft) ? draft : {};
  const skillSpec = isRecord(source.skillSpec) ? normalizeSpec(source.skillSpec as unknown as CreateSkillSpec) : null;
  return {
    ...(draft ?? ({} as CreateSkillDraft)),
    rawPrompt: stringValue(source.rawPrompt),
    intentFrame: isRecord(source.intentFrame) ? normalizeIntentFrame(source.intentFrame) : skillSpec?.intentFrame ?? null,
    skillSpec,
    followupQuestions: normalizeQuestions(source.followupQuestions),
    answers: isRecord(source.answers) ? (source.answers as Record<string, string>) : {},
    understanding: stringOrNull(source.understanding),
    draftMarkdown: stringOrNull(source.draftMarkdown),
    targetPlatformIds: safeStringList(source.targetPlatformIds),
    targetScenarioIds: safeNumberList(source.targetScenarioIds),
    targetBasename: stringOrNull(source.targetBasename),
    validation: isRecord(source.validation) ? normalizeCreateSkillReview(source.validation as unknown as CreateSkillReviewReport) : null,
    planToken: stringOrNull(source.planToken),
    installedSkillId: stringOrNull(source.installedSkillId),
    createdAt: numberValue(source.createdAt),
    updatedAt: numberValue(source.updatedAt),
    installedAt: numberOrNull(source.installedAt),
    discardedAt: numberOrNull(source.discardedAt),
  };
}

function normalizeSpec(spec: CreateSkillSpec): CreateSkillSpec {
  const source: Record<string, unknown> = isRecord(spec) ? spec : {};
  const intentFrame = normalizeIntentFrame(source.intentFrame);
  return {
    ...(spec ?? ({} as CreateSkillSpec)),
    name: slugInput(stringValue(source.name)),
    description: stringValue(source.description),
    language: source.language === 'en' ? 'en' : 'zh',
    intentFrame,
    ready: Boolean(source.ready),
    missing: safeStringList(source.missing),
  };
}

// 镜像 Rust create_skill_normalize_spec 的旧→新惰性迁移：旧字段缺失时填默认/迁移。
function normalizeIntentFrame(value: unknown): CreateSkillSpec['intentFrame'] {
  const source: Record<string, unknown> = isRecord(value) ? value : {};
  const legacyInputContract: Record<string, unknown> = isRecord(source.inputContract) ? source.inputContract : {};
  const legacyOutputContract: Record<string, unknown> = isRecord(source.outputContract) ? source.outputContract : {};
  const legacyWorkflowObj: Record<string, unknown> = isRecord(source.workflow) ? source.workflow : {};

  // whenToUse：空 → 旧 triggerContext。userInput：空 → 旧 userJob + 旧 acceptedInputs。
  const whenToUse = stringValue(source.whenToUse) || stringValue(source.triggerContext);
  const legacyInputs = safeStringList(legacyInputContract.acceptedInputs);
  let userInput = stringValue(source.userInput) || stringValue(source.userJob);
  if (legacyInputs.length > 0) {
    const joined = legacyInputs.join('\n');
    userInput = userInput && !userInput.includes(joined) ? `${userInput}\n${joined}` : userInput || joined;
  }

  // workflow：去掉 .steps 嵌套（数组优先，否则取旧 workflow.steps）。
  const workflow = Array.isArray(source.workflow)
    ? safeStringList(source.workflow)
    : safeStringList(legacyWorkflowObj.steps);

  // boundaries：合并旧 failClosedRules + nonGoals。
  const boundaries = Array.isArray(source.boundaries)
    ? safeStringList(source.boundaries)
    : [
        ...safeStringList(legacyWorkflowObj.failClosedRules),
        ...safeStringList(source.failClosedRules),
        ...safeStringList(source.nonGoals),
      ];

  const safetySource: Record<string, unknown> = isRecord(source.safety) ? source.safety : {};
  const legacyDestination = stringValue(legacyOutputContract.destination);
  const safety: CreateSkillSafety = {
    network: oneOf(
      safetySource.network,
      ['no', 'reads_only', 'reads_writes'] as const,
      source.needsNetwork ? 'reads_only' : 'no',
    ),
    fileWrites: oneOf(
      safetySource.fileWrites,
      ['none', 'same_folder', 'user_selected'] as const,
      legacyDestination === 'same_folder'
        ? 'same_folder'
        : legacyDestination === 'user_selected'
          ? 'user_selected'
          : source.writesFiles
            ? 'user_selected'
            : 'none',
    ),
    overwrite: oneOf(safetySource.overwrite, ['never', 'confirm_each_time'] as const, source.overwritePolicy === 'confirm_each_time' ? 'confirm_each_time' : 'never'),
    privacy: oneOf(
      safetySource.privacy,
      ['local_only', 'may_send_summary', 'may_send_content'] as const,
      oneOf(legacyInputContract.privacyClass, ['local_only', 'may_send_summary', 'may_send_content'] as const, 'local_only'),
    ),
    artifactType: oneOf(
      safetySource.artifactType,
      ['markdown', 'report', 'checklist', 'code_patch', 'file', 'other'] as const,
      oneOf(legacyOutputContract.artifactType, ['markdown', 'report', 'checklist', 'code_patch', 'file', 'other'] as const, 'markdown'),
    ),
  };

  return {
    whenToUse,
    userInput,
    output: stringValue(source.output),
    outputParts: safeStringList(source.outputParts),
    workflow,
    boundaries,
    successCriteria: safeStringList(source.successCriteria),
    safety,
  };
}

function normalizeCreateSkillReview(review: CreateSkillReviewReport): CreateSkillReviewReport {
  const source: Record<string, unknown> = isRecord(review) ? review : {};
  const checks: Record<string, unknown> = isRecord(source.checks) ? source.checks : {};
  return {
    blocking: normalizeReviewIssues(source.blocking, true),
    warnings: normalizeReviewIssues(source.warnings, false),
    checks: {
      safeName: Boolean(checks.safeName),
      parseableFrontmatter: Boolean(checks.parseableFrontmatter),
      sizeUnderLimit: Boolean(checks.sizeUnderLimit),
      triggerDescription: Boolean(checks.triggerDescription),
      hasInputs: Boolean(checks.hasInputs),
      hasWorkflow: Boolean(checks.hasWorkflow),
      hasOutput: Boolean(checks.hasOutput),
      hasBoundaries: Boolean(checks.hasBoundaries),
      hasQualityBar: Boolean(checks.hasQualityBar),
      conciseBody: Boolean(checks.conciseBody),
      frontmatterOnlyNameDescription: Boolean(checks.frontmatterOnlyNameDescription),
      nameMatchesBasename: Boolean(checks.nameMatchesBasename),
      nameIsKebabCase: Boolean(checks.nameIsKebabCase),
      noPrivateFields: Boolean(checks.noPrivateFields),
      noSilentNetwork: Boolean(checks.noSilentNetwork),
      noSilentOverwrite: Boolean(checks.noSilentOverwrite),
      noSecretExfiltration: Boolean(checks.noSecretExfiltration),
      noDangerousShellDefault: Boolean(checks.noDangerousShellDefault),
      // New v0.5 hygiene keys: default an absent key (stale persisted drafts) to
      // the safe value so the summary doesn't show a spurious red row on upgrade.
      noPromptInjection: checks.noPromptInjection !== false,
      noSensitivePath: checks.noSensitivePath !== false,
      noCommandSubstitutionExfil: checks.noCommandSubstitutionExfil !== false,
    },
  };
}

function normalizeReviewIssues(value: unknown, allowPath: boolean): Array<{ code: string; message: string; path?: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return null;
      const issue: { code: string; message: string; path?: string } = {
        code: stringValue(item.code) || 'ISSUE',
        message: stringValue(item.message),
      };
      const path = allowPath ? stringOrNull(item.path) : null;
      if (path) issue.path = path;
      return issue.message ? issue : null;
    })
    .filter((item): item is { code: string; message: string; path?: string } => item != null);
}

function normalizeQuestions(value: unknown): CreateSkillQuestion[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return null;
      const options = Array.isArray(item.options)
        ? item.options
            .map((option) => {
              if (!isRecord(option)) return null;
              const id = stringValue(option.id);
              const label = stringValue(option.label);
              if (!id || !label) return null;
              return {
                id,
                label,
                effect: stringValue(option.effect),
              };
            })
            .filter((option): option is { id: string; label: string; effect: string } => option != null)
        : [];
      const id = stringValue(item.id);
      const question = stringValue(item.question);
      if (!id || !question) return null;
      return {
        id,
        question,
        options,
        allowFreeform: Boolean(item.allowFreeform),
      };
    })
    .filter((item): item is CreateSkillQuestion => item != null);
}

function boundaryLines(spec: CreateSkillSpec): string[] {
  return safeStringList(spec.intentFrame?.boundaries);
}

function safeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
}

function safeNumberList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => Number.isFinite(item));
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
}

function formatCreateSkillError(err: unknown, locale: 'zh' | 'en'): string {
  if (typeof err === 'string') return err;
  if (!err || typeof err !== 'object') return String(err);
  const value = err as { message?: unknown; detail?: unknown };
  const message = typeof value.message === 'string' ? value.message : String(err);
  const issues = (value.detail as { issues?: unknown } | undefined)?.issues;
  if (!Array.isArray(issues) || issues.length === 0) return message;
  const fields = issues
    .map((issue) => {
      if (!issue || typeof issue !== 'object') return null;
      const item = issue as { field?: unknown };
      return typeof item.field === 'string' ? createSkillIssueLabel(item.field, locale) : null;
    })
    .filter(Boolean)
    .slice(0, 4)
    .join(', ');
  return fields ? `${message} (${fields})` : message;
}

function createSkillIssueLabel(field: string, locale: 'zh' | 'en'): string {
  const zh: Record<string, string> = {
    name: '技能名',
    description: '触发描述',
    'intentFrame.whenToUse': '何时使用',
    'intentFrame.userInput': '用户输入',
    'intentFrame.output': '技能输出',
    'intentFrame.outputParts': '输出组成',
    'intentFrame.workflow': '工作流步骤',
    'intentFrame.successCriteria': '验收标准',
    schema: '返回格式',
  };
  const en: Record<string, string> = {
    name: 'skill name',
    description: 'trigger description',
    'intentFrame.whenToUse': 'when to use',
    'intentFrame.userInput': 'user input',
    'intentFrame.output': 'skill output',
    'intentFrame.outputParts': 'output parts',
    'intentFrame.workflow': 'workflow steps',
    'intentFrame.successCriteria': 'success criteria',
    schema: 'response schema',
  };
  return (locale === 'zh' ? zh : en)[field] ?? field;
}

function lines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim().replace(/^[-*]\s*/, ''))
    .filter(Boolean);
}

function slugInput(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

interface Copy {
  title: string;
  subtitle: string;
  promptPlaceholder: string;
  examples: string[];
  start: string;
  configureAi: string;
  aiRequired: string;
  aiRequiredNotice: string;
  badOutline: string;
  backgroundRunning: string;
  backgroundRunningShort: string;
  name: string;
  description: string;
  whenToUse: string;
  userInput: string;
  output: string;
  outputParts: string;
  workflow: string;
  boundaries: string;
  criteria: string;
  advancedTitle: string;
  flowInput: string;
  flowInputSub: string;
  flowInputHint: string;
  flowOutput: string;
  flowOutputSub: string;
  flowOutputHint: string;
  skillNodeLabel: string;
  outputPartsLabel: string;
  outputPartsHint: string;
  moreDetailsTitle: string;
  safetyNetwork: string;
  safetyFileWrites: string;
  safetyOverwrite: string;
  safetyPrivacy: string;
  safetyArtifactType: string;
  networkNo: string;
  networkReadsOnly: string;
  networkReadsWrites: string;
  fileWritesNone: string;
  fileWritesSameFolder: string;
  fileWritesUserSelected: string;
  overwriteNever: string;
  overwriteConfirm: string;
  privacyLocalOnly: string;
  privacyMaySendSummary: string;
  privacyMaySendContent: string;
  continueQuestions: string;
  backInput: string;
  regenerateOutline: string;
  discardDraft: string;
  generateNow: string;
  questionsDone: string;
  generateDraft: string;
  generating: string;
  discardConfirmTitle: string;
  discardConfirmBody: string;
  regenerateConfirmTitle: string;
  regenerateConfirmBody: string;
  reviewStale: string;
  enoughGenerate: string;
  viewOutline: string;
  refineMore: string;
  understandingPrefix: string;
  crystallizing: string;
  backOutline: string;
  review: string;
  reviewAgain: string;
  reviewing: string;
  reviewPassedToast: string;
  reviewBlockedToast: string;
  editOutline: string;
  reviewPassed: string;
  reviewBlocked: string;
  installTarget: string;
  scenarioTarget: string;
  noScenarios: string;
  installSummary: string;
  basename: string;
  mainSource: string;
  selectedPlatforms: string;
  noWriteUntilConfirm: string;
  qualityTitle: string;
  safetyGateTitle: string;
  creativeQualityTitle: string;
  safetyParseable: string;
  safetySecrets: string;
  safetyActions: string;
  qualityTrigger: string;
  qualityInputs: string;
  qualityWorkflow: string;
  qualityOutput: string;
  qualityBoundaries: string;
  qualityCriteria: string;
  planInstall: string;
  done: string;
  installFailed: string;
  openLibrary: string;
  createAnother: string;
  created: string;
  steps: Record<Step, string>;
}

const zhCopy: Copy = {
  title: '创造技能',
  subtitle: '把一个真实需求收窄成技能轮廓，追问关键选择，生成可确认安装的 SKILL.md。',
  promptPlaceholder: '描述你的需求、困境或反复出现的问题。不知道怎么说也可以很粗糙，例如：我每次做 PR review 都容易漏掉数据迁移和回滚风险。',
  examples: [
    '我想把长视频自动转成同目录 SRT 字幕，并且不要合成视频。',
    '帮我固定一套 Obsidian 中文稿件润色流程，保留口语感但更犀利。',
    '为 GitHub PR review 做一个检查技能，重点看回归风险和测试缺口。',
    '给设计稿生成前端实现 checklist，避免 UI 文本溢出和布局重叠。',
  ],
  start: '生成技能轮廓',
  configureAi: '前往设置 AI',
  aiRequired: '创造技能需要先保存 AI 设置并测试连接。',
  aiRequiredNotice: '创造技能依赖大模型追问和生成；请先在设置中保存 AI 设置并通过连接测试。',
  badOutline: 'AI 返回的技能轮廓不完整，未进入下一步。请补充需求后重新生成。',
  backgroundRunning: '技能轮廓正在后台生成。你可以离开此页，回来后会继续显示进度和结果。',
  backgroundRunningShort: '后台生成中',
  name: '目录名 / 技能名',
  description: '触发描述',
  whenToUse: '何时使用',
  userInput: '用户输入 / 困境 / 问题',
  output: '技能输出 / 方案 / 结果',
  outputParts: '输出包含哪些部分',
  workflow: '工作流步骤',
  boundaries: '边界 / 不做什么',
  criteria: '验收标准',
  advancedTitle: '高级（安全 / 分类，可选）',
  flowInput: '输入',
  flowInputSub: '需求 · 困境 · 问题',
  flowInputHint: '描述你反复遇到、想交给这个技能处理的需求或困境 —— 你会带来什么材料、要解决什么问题。',
  flowOutput: '输出',
  flowOutputSub: '方案 · 结果',
  flowOutputHint: '这个技能给出什么方案、产出什么结果 —— 写清产物的形态、结构与关键内容。',
  skillNodeLabel: '技能',
  outputPartsLabel: '输出包含哪些部分',
  outputPartsHint: '每行一条，例如：润色后的全文 / 改动清单 / 风险标记（可选）',
  moreDetailsTitle: '更多细节（何时触发 / 工作流 / 边界 / 安全 / 验收 —— 可不管，AI 会推断）',
  safetyNetwork: '联网',
  safetyFileWrites: '文件写入',
  safetyOverwrite: '覆盖策略',
  safetyPrivacy: '隐私',
  safetyArtifactType: '产物类型',
  networkNo: '不联网',
  networkReadsOnly: '仅读取',
  networkReadsWrites: '读写',
  fileWritesNone: '不写文件',
  fileWritesSameFolder: '同目录',
  fileWritesUserSelected: '用户选择位置',
  overwriteNever: '从不覆盖',
  overwriteConfirm: '每次先确认',
  privacyLocalOnly: '仅本地',
  privacyMaySendSummary: '可发送摘要',
  privacyMaySendContent: '可发送内容',
  continueQuestions: '继续追问',
  backInput: '返回输入',
  regenerateOutline: '重新生成',
  discardDraft: '放弃草稿',
  generateNow: '直接生成草案',
  questionsDone: '关键问题已回答，下面是结晶出的技能轮廓。',
  generateDraft: '生成 SKILL.md',
  generating: '正在生成 SKILL.md…',
  discardConfirmTitle: '放弃这份草稿？',
  discardConfirmBody: '当前轮廓、已回答的追问和暂存内容都会删除，无法撤销。',
  regenerateConfirmTitle: '重新生成轮廓？',
  regenerateConfirmBody: '会从最初的需求重新开始，当前轮廓和已回答的追问会被覆盖。',
  reviewStale: '草案已修改 —— 上次检查结果不再算数，请重新检查后再安装。',
  enoughGenerate: '够了，直接看轮廓',
  viewOutline: '查看技能轮廓',
  refineMore: '继续补充澄清',
  understandingPrefix: '我的理解：',
  crystallizing: 'AI 正在据你的回答结晶技能轮廓…',
  backOutline: '返回轮廓',
  review: '检查草案',
  reviewAgain: '重新检查草案',
  reviewing: '检查中',
  reviewPassedToast: '草案检查通过。现在可以安装技能。',
  reviewBlockedToast: '草案检查未通过，请先修正阻塞问题。',
  editOutline: '编辑轮廓',
  reviewPassed: '本地安全检查通过，可以安装技能。',
  reviewBlocked: '还有阻塞问题，修正后再继续。',
  installTarget: '安装平台',
  scenarioTarget: '加入场景',
  noScenarios: '暂无场景，可安装后再归类。',
  installSummary: '安装摘要',
  basename: '目录名',
  mainSource: '来源',
  selectedPlatforms: '平台数',
  noWriteUntilConfirm: '这里只是安装前摘要；确认之前不会写入任何 skill 目录。',
  qualityTitle: '专业性检查',
  safetyGateTitle: '安全门槛',
  creativeQualityTitle: '质量建议',
  safetyParseable: '格式与目录安全',
  safetySecrets: '不包含密钥',
  safetyActions: '联网 / 写入 / 危险命令受控',
  qualityTrigger: '触发描述清晰',
  qualityInputs: '输入范围明确',
  qualityWorkflow: '执行指导清楚',
  qualityOutput: '产物定义明确',
  qualityBoundaries: '边界清楚',
  qualityCriteria: '质量 / 验收标准明确',
  planInstall: '安装技能',
  done: '技能已写入并重新扫描纳管。',
  installFailed: '技能安装未完成，请查看失败项。',
  openLibrary: '在资源库查看',
  createAnother: '继续创造',
  created: '创造技能已完成',
  steps: {
    input: '输入',
    outline: '轮廓',
    questions: '追问',
    draft: '草案',
    install: '安装',
    done: '完成',
  },
};

const enCopy: Copy = {
  title: 'Create Skill',
  subtitle: 'Turn a real need into an editable outline, narrow key choices, then install a reviewed SKILL.md.',
  promptPlaceholder: 'Describe the need, recurring problem, or workflow. Rough input is fine, for example: I keep missing migration and rollback risk during PR review.',
  examples: [
    'Turn long videos into same-folder SRT subtitles without synthesizing video.',
    'Create an Obsidian Chinese writing polish workflow that keeps spoken rhythm.',
    'Build a GitHub PR review skill focused on regressions and missing tests.',
    'Generate frontend implementation checklists from design files.',
  ],
  start: 'Generate outline',
  configureAi: 'Set up AI',
  aiRequired: 'Create Skill needs saved AI settings and a successful connection test.',
  aiRequiredNotice: 'Create Skill relies on an LLM for follow-up questions and generation. Save AI settings and pass a connection test first.',
  badOutline: 'The AI returned an incomplete skill outline, so the draft was not advanced. Add more detail and regenerate.',
  backgroundRunning: 'The outline is generating in the background. You can leave this page and come back without interrupting it.',
  backgroundRunningShort: 'Running in background',
  name: 'Directory / skill name',
  description: 'Trigger description',
  whenToUse: 'When to use',
  userInput: 'User input / problem / pain point',
  output: 'Skill output / result',
  outputParts: 'What the output is made of',
  workflow: 'Workflow steps',
  boundaries: 'Boundaries / non-goals',
  criteria: 'Acceptance criteria',
  advancedTitle: 'Advanced (safety / classification, optional)',
  flowInput: 'Input',
  flowInputSub: 'need · problem · pain point',
  flowInputHint: 'Describe the recurring need or problem you want this skill to handle — what you bring in, and what you need solved.',
  flowOutput: 'Output',
  flowOutputSub: 'solution · result',
  flowOutputHint: 'What this skill delivers — spell out the shape, structure, and key contents of the result.',
  skillNodeLabel: 'Skill',
  outputPartsLabel: 'What the output contains',
  outputPartsHint: 'One per line, e.g. polished full text / change list / risk flags (optional)',
  moreDetailsTitle: 'More detail (when to use / workflow / boundaries / safety / criteria — optional, AI infers it)',
  safetyNetwork: 'Network',
  safetyFileWrites: 'File writes',
  safetyOverwrite: 'Overwrite policy',
  safetyPrivacy: 'Privacy',
  safetyArtifactType: 'Artifact type',
  networkNo: 'No network',
  networkReadsOnly: 'Reads only',
  networkReadsWrites: 'Reads & writes',
  fileWritesNone: 'No file writes',
  fileWritesSameFolder: 'Same folder',
  fileWritesUserSelected: 'User-selected path',
  overwriteNever: 'Never overwrite',
  overwriteConfirm: 'Confirm each time',
  privacyLocalOnly: 'Local only',
  privacyMaySendSummary: 'May send summary',
  privacyMaySendContent: 'May send content',
  continueQuestions: 'Continue questions',
  backInput: 'Back to input',
  regenerateOutline: 'Regenerate',
  discardDraft: 'Discard draft',
  generateNow: 'Generate draft now',
  questionsDone: 'Key questions are answered — here is the crystallized outline.',
  generateDraft: 'Generate SKILL.md',
  generating: 'Generating SKILL.md…',
  discardConfirmTitle: 'Discard this draft?',
  discardConfirmBody: 'The outline, answered questions, and staged content are deleted. This cannot be undone.',
  regenerateConfirmTitle: 'Regenerate the outline?',
  regenerateConfirmBody: 'Starts over from the original prompt — the current outline and answered questions are replaced.',
  reviewStale: 'The draft changed — the last review verdict no longer applies. Re-run the review before installing.',
  enoughGenerate: 'Enough — show the outline',
  viewOutline: 'Review the outline',
  refineMore: 'Add more clarification',
  understandingPrefix: 'What I understand: ',
  crystallizing: 'AI is crystallizing the skill outline from your answers…',
  backOutline: 'Back to outline',
  review: 'Review draft',
  reviewAgain: 'Review draft again',
  reviewing: 'Reviewing',
  reviewPassedToast: 'Draft review passed. You can install the skill now.',
  reviewBlockedToast: 'Draft review failed. Fix the blocking issues first.',
  editOutline: 'Edit outline',
  reviewPassed: 'Local safety checks passed. You can install the skill.',
  reviewBlocked: 'Blocking issues remain. Fix them before continuing.',
  installTarget: 'Install targets',
  scenarioTarget: 'Add to scenarios',
  noScenarios: 'No scenarios yet. You can categorize after install.',
  installSummary: 'Install summary',
  basename: 'Basename',
  mainSource: 'Source',
  selectedPlatforms: 'Platforms',
  noWriteUntilConfirm: 'This is only a pre-install summary; no skill directory is written before confirmation.',
  qualityTitle: 'Quality checks',
  safetyGateTitle: 'Safety gate',
  creativeQualityTitle: 'Quality suggestions',
  safetyParseable: 'Format and directory are safe',
  safetySecrets: 'No secrets included',
  safetyActions: 'Network / writes / dangerous commands are gated',
  qualityTrigger: 'Clear trigger description',
  qualityInputs: 'Input scope is explicit',
  qualityWorkflow: 'Executable guidance is clear',
  qualityOutput: 'Output is defined',
  qualityBoundaries: 'Boundaries are clear',
  qualityCriteria: 'Quality / acceptance criteria are explicit',
  planInstall: 'Install skill',
  done: 'Skill was written, scanned, and added to the library.',
  installFailed: 'Skill install did not finish. Check the failed items.',
  openLibrary: 'Open in Library',
  createAnother: 'Create another',
  created: 'Create Skill completed',
  steps: {
    input: 'Input',
    outline: 'Outline',
    questions: 'Questions',
    draft: 'Draft',
    install: 'Install',
    done: 'Done',
  },
};
