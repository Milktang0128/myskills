'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, FilePlus2, Loader2, Pencil, Sparkles } from 'lucide-react';
import type {
  AiJob,
  CreateSkillDraft,
  CreateSkillExecuteResult,
  CreateSkillQuestion,
  CreateSkillReviewReport,
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
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type Step = 'input' | 'outline' | 'questions' | 'draft' | 'install' | 'done';

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
  const [manualMode, setManualMode] = useState(false);
  const [startJob, setStartJob] = useState<AiJob<CreateSkillStartResult> | null>(null);

  useEffect(() => {
    if (!seed) return;
    setPrompt(seed);
    setStep('input');
  }, [seed]);

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
    if (!nextDraft.skillSpec || !isUsableOutline(nextDraft.skillSpec, nextDraft.followupQuestions)) {
      throw new Error(copy.badOutline);
    }
    setDraft(nextDraft);
    setSpec(nextDraft.skillSpec);
    setMarkdown(nextDraft.draftMarkdown ?? '');
    setReview(nextDraft.validation);
    setStep('outline');
    setManualMode(!result.aiUsed);
    if (!result.aiUsed) onToast(copy.localMode);
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
      setError(err instanceof Error ? err.message : String(err));
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
      setStep('questions');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
      setStep('draft');
      setManualMode(!result.aiUsed);
      if (!result.aiUsed) onToast(copy.localDraft);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
      if (nextReview.blocking.length === 0 && nextReview.warnings.length === 0) {
        setStep('install');
        onToast(copy.reviewPassedToast);
      } else {
        setStep('draft');
        onToast(copy.reviewBlockedToast);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function setSpecField<K extends keyof CreateSkillSpec>(key: K, value: CreateSkillSpec[K]) {
    if (!spec) return;
    setSpec({ ...spec, [key]: value });
  }

  function setIntentUserJob(value: string) {
    if (!spec) return;
    setSpec({
      ...spec,
      intentFrame: {
        ...spec.intentFrame,
        userJob: value,
      },
    });
  }

  function setTriggerContext(value: string) {
    if (!spec) return;
    setSpec({
      ...spec,
      intentFrame: {
        ...spec.intentFrame,
        triggerContext: value,
      },
    });
  }

  function setAcceptedInputs(value: string) {
    if (!spec) return;
    setSpec({
      ...spec,
      intentFrame: {
        ...spec.intentFrame,
        inputContract: {
          ...spec.intentFrame.inputContract,
          acceptedInputs: lines(value),
        },
      },
    });
  }

  function setOutputArtifact(value: CreateSkillSpec['intentFrame']['outputContract']['artifactType']) {
    if (!spec) return;
    setSpec({
      ...spec,
      intentFrame: {
        ...spec.intentFrame,
        outputContract: {
          ...spec.intentFrame.outputContract,
          artifactType: value,
        },
      },
    });
  }

  function setOutputDestination(value: CreateSkillSpec['intentFrame']['outputContract']['destination']) {
    if (!spec) return;
    setSpec({
      ...spec,
      writesFiles: value !== 'reply_only',
      intentFrame: {
        ...spec.intentFrame,
        outputContract: {
          ...spec.intentFrame.outputContract,
          destination: value,
        },
      },
    });
  }

  function setWorkflow(value: string) {
    if (!spec) return;
    setSpec({
      ...spec,
      intentFrame: {
        ...spec.intentFrame,
        workflow: {
          ...spec.intentFrame.workflow,
          steps: lines(value),
        },
      },
    });
  }

  function setBoundaryAndNonGoals(value: string) {
    if (!spec) return;
    setSpec({
      ...spec,
      intentFrame: {
        ...spec.intentFrame,
        workflow: {
          ...spec.intentFrame.workflow,
          failClosedRules: lines(value),
        },
        nonGoals: [],
      },
    });
  }

  function setCriteria(value: string) {
    if (!spec) return;
    setSpec({
      ...spec,
      intentFrame: {
        ...spec.intentFrame,
        successCriteria: lines(value),
      },
    });
  }

  function resetAll() {
    setStep('input');
    setPrompt('');
    setDraft(null);
    setSpec(null);
    setMarkdown('');
    setReview(null);
    setPlan(null);
    setExecuteResult(null);
    setManualMode(false);
    setStartJob(null);
    setBusy(false);
    setTargetScenarioIds([]);
    setTargetPlatformIds([canonicalPlatform]);
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
                <Button onClick={start} disabled={busy || (aiAvailable && prompt.trim().length < 4)} data-smoke-action="create-skill-start">
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                  {busy && startJob ? copy.backgroundRunningShort : aiAvailable ? copy.start : copy.configureAi}
                </Button>
              </section>
            )}

            {step === 'outline' && spec && (
              <section className="space-y-4">
                {manualMode && (
                  <Notice tone="info" icon={<Sparkles className="h-4 w-4" />}>
                    {copy.manualModeNotice}
                  </Notice>
                )}
                <Field label={copy.name}>
                  <input
                    value={spec.name}
                    onChange={(e) => setSpecField('name', slugInput(e.target.value))}
                    className="h-9 w-full border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </Field>
                <Field label={copy.description}>
                  <input
                    value={spec.description}
                    onChange={(e) => setSpecField('description', e.target.value)}
                    className="h-9 w-full border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </Field>
                <Field label={copy.trigger}>
                  <textarea
                    value={spec.intentFrame.triggerContext}
                    onChange={(e) => setTriggerContext(e.target.value)}
                    className="min-h-[80px] w-full resize-none border bg-background p-3 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </Field>
                <Field label={copy.intent}>
                  <textarea
                    value={spec.intentFrame.userJob}
                    onChange={(e) => setIntentUserJob(e.target.value)}
                    className="min-h-[96px] w-full resize-none border bg-background p-3 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </Field>
                <Field label={copy.inputs}>
                  <textarea
                    value={safeStringList(spec.intentFrame.inputContract.acceptedInputs).join('\n')}
                    onChange={(e) => setAcceptedInputs(e.target.value)}
                    className="min-h-[88px] w-full resize-none border bg-background p-3 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </Field>
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label={copy.outputArtifact}>
                    <select
                      value={spec.intentFrame.outputContract.artifactType}
                      onChange={(e) =>
                        setOutputArtifact(e.target.value as CreateSkillSpec['intentFrame']['outputContract']['artifactType'])
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
                  <Field label={copy.outputDestination}>
                    <select
                      value={spec.intentFrame.outputContract.destination}
                      onChange={(e) =>
                        setOutputDestination(e.target.value as CreateSkillSpec['intentFrame']['outputContract']['destination'])
                      }
                      className="h-9 w-full border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <option value="reply_only">{copy.destinationReply}</option>
                      <option value="same_folder">{copy.destinationSameFolder}</option>
                      <option value="user_selected">{copy.destinationUserSelected}</option>
                    </select>
                  </Field>
                </div>
                <Field label={copy.workflow}>
                  <textarea
                    value={safeStringList(spec.intentFrame.workflow.steps).join('\n')}
                    onChange={(e) => setWorkflow(e.target.value)}
                    className="min-h-[132px] w-full resize-none border bg-background p-3 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </Field>
                <Field label={copy.boundaries}>
                  <textarea
                    value={boundaryLines(spec).join('\n')}
                    onChange={(e) => setBoundaryAndNonGoals(e.target.value)}
                    className="min-h-[104px] w-full resize-none border bg-background p-3 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </Field>
                <Field label={copy.criteria}>
                  <textarea
                    value={safeStringList(spec.intentFrame.successCriteria).join('\n')}
                    onChange={(e) => setCriteria(e.target.value)}
                    className="min-h-[88px] w-full resize-none border bg-background p-3 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </Field>
                <div className="flex gap-2">
                  <Button onClick={() => saveOutline('questions')} disabled={busy}>
                    <Pencil className="mr-2 h-4 w-4" />
                    {copy.continueQuestions}
                  </Button>
                  <Button variant="outline" onClick={() => setStep('input')} disabled={busy}>
                    {copy.backInput}
                  </Button>
                  <Button variant="outline" onClick={start} disabled={busy || prompt.trim().length < 4}>
                    {copy.regenerateOutline}
                  </Button>
                  <Button variant="outline" onClick={resetAll} disabled={busy}>
                    {copy.discardDraft}
                  </Button>
                </div>
              </section>
            )}

            {step === 'questions' && (
              <section className="space-y-4">
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
                  <Button onClick={generate} disabled={busy || !spec || Boolean(currentQuestion)}>
                    {copy.generateDraft}
                  </Button>
                  <Button variant="outline" onClick={() => setStep('outline')}>
                    {copy.backOutline}
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
                    onChange={(e) => setMarkdown(e.target.value)}
                    className="min-h-[360px] w-full resize-y border bg-background p-3 font-mono text-xs leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    spellCheck={false}
                  />
                </Field>
                {review && <ReviewPanel review={review} copy={copy} />}
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
                  {platforms.map((platform) => (
                    <label key={platform.id} className="flex items-center gap-2 border bg-background px-2 py-2 text-xs">
                      <input
                        type="checkbox"
                        checked={targetPlatformIds.includes(platform.id)}
                        onChange={(e) => {
                          setTargetPlatformIds((ids) =>
                            e.target.checked ? [...new Set([...ids, platform.id])] : ids.filter((id) => id !== platform.id),
                          );
                        }}
                      />
                      <span className="min-w-0 flex-1 truncate">{platform.label}</span>
                      {platform.id === canonicalPlatform && <Badge>{copy.mainSource}</Badge>}
                    </label>
                  ))}
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
                    review.blocking.length !== 0 ||
                    review.warnings.length !== 0 ||
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
  const steps: Step[] = ['input', 'outline', 'questions', 'draft', 'install'];
  const active = Math.max(0, steps.indexOf(step));
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

function ReviewPanel({ review, copy }: { review: CreateSkillReviewReport; copy: Copy }) {
  const safeReview = normalizeCreateSkillReview(review);
  const blocking = safeReview.blocking;
  const warnings = safeReview.warnings;
  return (
    <div className="space-y-2">
      {blocking.length === 0 ? (
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
      <SummaryItem label={copy.description} value={safeSpec.description} />
      <SummaryItem label={copy.trigger} value={safeSpec.intentFrame.triggerContext} />
      <SummaryItem label={copy.inputs} value={safeSpec.intentFrame.inputContract.acceptedInputs.join('\n')} />
      <SummaryItem
        label={copy.outputArtifact}
        value={`${safeSpec.intentFrame.outputContract.artifactType} / ${safeSpec.intentFrame.outputContract.destination}`}
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
          : checks.noSilentNetwork && checks.noSilentOverwrite && checks.noDangerousShellDefault,
    },
  ];
  const qualityItems = [
    {
      label: copy.qualityTrigger,
      ok: checks?.triggerDescription ?? safeSpec.description.trim().length > 20,
    },
    {
      label: copy.qualityInputs,
      ok: checks?.hasInputs ?? safeSpec.intentFrame.inputContract.acceptedInputs.length > 0,
    },
    {
      label: copy.qualityWorkflow,
      ok: checks?.hasWorkflow ?? safeSpec.intentFrame.workflow.steps.length >= 3,
    },
    {
      label: copy.qualityOutput,
      ok: checks?.hasOutput ?? Boolean(safeSpec.intentFrame.outputContract.artifactType),
    },
    {
      label: copy.qualityBoundaries,
      ok:
        checks?.hasBoundaries ??
        safeSpec.intentFrame.workflow.failClosedRules.length + safeSpec.intentFrame.nonGoals.length > 0,
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
    needsNetwork: Boolean(source.needsNetwork),
    writesFiles: Boolean(source.writesFiles),
    overwritePolicy: source.overwritePolicy === 'confirm_each_time' ? 'confirm_each_time' : 'never',
    ready: Boolean(source.ready),
    missing: safeStringList(source.missing),
  };
}

function isUsableOutline(spec: CreateSkillSpec, questions: CreateSkillQuestion[]): boolean {
  const safeSpec = normalizeSpec(spec);
  const intent = safeSpec.intentFrame;
  const safeQuestions = normalizeQuestions(questions);
  return Boolean(
    slugInput(safeSpec.name) &&
      safeSpec.description.trim().length >= 20 &&
      !safeSpec.description.toLowerCase().includes('structured agent workflow') &&
      intent.userJob.trim().length >= 12 &&
      intent.triggerContext.trim().length >= 12 &&
      intent.inputContract.acceptedInputs.some((item) => item.trim()) &&
      intent.workflow.steps.filter((item) => item.trim()).length >= 3 &&
      intent.successCriteria.some((item) => item.trim()) &&
      safeQuestions.some((question) => question.options.length > 0),
  );
}

function normalizeIntentFrame(value: unknown): CreateSkillSpec['intentFrame'] {
  const source: Record<string, unknown> = isRecord(value) ? value : {};
  const inputContract: Record<string, unknown> = isRecord(source.inputContract) ? source.inputContract : {};
  const outputContract: Record<string, unknown> = isRecord(source.outputContract) ? source.outputContract : {};
  const workflow: Record<string, unknown> = isRecord(source.workflow) ? source.workflow : {};
  return {
    userJob: stringValue(source.userJob),
    triggerContext: stringValue(source.triggerContext),
    inputContract: {
      acceptedInputs: safeStringList(inputContract.acceptedInputs),
      privacyClass: oneOf(inputContract.privacyClass, ['local_only', 'may_send_summary', 'may_send_content'] as const, 'may_send_summary'),
    },
    outputContract: {
      artifactType: oneOf(outputContract.artifactType, ['markdown', 'report', 'checklist', 'code_patch', 'file', 'other'] as const, 'markdown'),
      destination: oneOf(outputContract.destination, ['reply_only', 'same_folder', 'user_selected'] as const, 'reply_only'),
    },
    workflow: {
      steps: safeStringList(workflow.steps),
      failClosedRules: safeStringList(workflow.failClosedRules),
    },
    stylePreferences: safeStringList(source.stylePreferences),
    nonGoals: safeStringList(source.nonGoals),
    successCriteria: safeStringList(source.successCriteria),
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
  return [...safeStringList(spec.intentFrame?.workflow?.failClosedRules), ...safeStringList(spec.intentFrame?.nonGoals)];
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
    'intentFrame.userJob': '用户需求',
    'intentFrame.triggerContext': '触发时机',
    'intentFrame.inputContract.acceptedInputs': '适合输入',
    'intentFrame.workflow.steps': '工作流步骤',
    'intentFrame.successCriteria': '验收标准',
    schema: '返回格式',
  };
  const en: Record<string, string> = {
    name: 'skill name',
    description: 'trigger description',
    'intentFrame.userJob': 'user need',
    'intentFrame.triggerContext': 'trigger context',
    'intentFrame.inputContract.acceptedInputs': 'accepted inputs',
    'intentFrame.workflow.steps': 'workflow steps',
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
  localMode: string;
  localDraft: string;
  backgroundRunning: string;
  backgroundRunningShort: string;
  manualModeNotice: string;
  name: string;
  description: string;
  trigger: string;
  intent: string;
  inputs: string;
  outputArtifact: string;
  outputDestination: string;
  destinationReply: string;
  destinationSameFolder: string;
  destinationUserSelected: string;
  workflow: string;
  boundaries: string;
  criteria: string;
  continueQuestions: string;
  backInput: string;
  regenerateOutline: string;
  discardDraft: string;
  generateNow: string;
  questionsDone: string;
  generateDraft: string;
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
  localMode: 'AI 未启用，已进入可编辑的本地轮廓模式。',
  localDraft: 'AI 未启用，已生成本地模板草案；请检查后再安装。',
  backgroundRunning: '技能轮廓正在后台生成。你可以离开此页，回来后会继续显示进度和结果。',
  backgroundRunningShort: '后台生成中',
  manualModeNotice: '当前是本地模板模式：不会调用外部模型，所有轮廓字段都可以手动调整。',
  name: '目录名 / 技能名',
  description: '触发描述',
  trigger: '触发时机',
  intent: '用户输入 / 困境',
  inputs: '适合输入',
  outputArtifact: '期待产物',
  outputDestination: '交付位置',
  destinationReply: '仅回复',
  destinationSameFolder: '同目录文件',
  destinationUserSelected: '用户选择位置',
  workflow: '工作流步骤',
  boundaries: '边界 / 不做什么',
  criteria: '验收标准',
  continueQuestions: '继续追问',
  backInput: '返回输入',
  regenerateOutline: '重新生成',
  discardDraft: '放弃草稿',
  generateNow: '直接生成草案',
  questionsDone: '关键问题已回答，可以生成草案。',
  generateDraft: '生成 SKILL.md',
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
  mainSource: '主源',
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
  localMode: 'AI is not enabled; using an editable local outline.',
  localDraft: 'AI is not enabled; generated a local template draft for review.',
  backgroundRunning: 'The outline is generating in the background. You can leave this page and come back without interrupting it.',
  backgroundRunningShort: 'Running in background',
  manualModeNotice: 'Local template mode: no external model is called, and every outline field remains editable.',
  name: 'Directory / skill name',
  description: 'Trigger description',
  trigger: 'Trigger moment',
  intent: 'User input / problem',
  inputs: 'Accepted inputs',
  outputArtifact: 'Expected artifact',
  outputDestination: 'Destination',
  destinationReply: 'Reply only',
  destinationSameFolder: 'Same-folder file',
  destinationUserSelected: 'User-selected path',
  workflow: 'Workflow steps',
  boundaries: 'Boundaries / non-goals',
  criteria: 'Acceptance criteria',
  continueQuestions: 'Continue questions',
  backInput: 'Back to input',
  regenerateOutline: 'Regenerate',
  discardDraft: 'Discard draft',
  generateNow: 'Generate draft now',
  questionsDone: 'Key questions are answered. Generate the draft next.',
  generateDraft: 'Generate SKILL.md',
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
  mainSource: 'Main source',
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
