'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, FilePlus2, Loader2, Pencil, Sparkles } from 'lucide-react';
import type {
  CreateSkillDraft,
  CreateSkillExecuteResult,
  CreateSkillQuestion,
  CreateSkillReviewReport,
  CreateSkillSpec,
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
  onInstalled: (skillId: string | null, name: string) => void;
  onToast: (message: string) => void;
}

export function CreateSkillView({
  seed = '',
  platforms,
  scenarios,
  canonicalPlatform,
  onInstalled,
  onToast,
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

  async function start() {
    if (prompt.trim().length < 4) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.ai.createSkill.start({ prompt: prompt.trim(), language: locale });
      setDraft(result.draft);
      setSpec(result.draft.skillSpec);
      setMarkdown(result.draft.draftMarkdown ?? '');
      setReview(result.draft.validation);
      setStep('outline');
      setManualMode(!result.aiUsed);
      if (!result.aiUsed) onToast(copy.localMode);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
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
      setDraft(updated);
      setSpec(updated.skillSpec);
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
      setDraft(result.draft);
      setSpec(result.draft.skillSpec);
      setStep(result.nextQuestion ? 'questions' : 'draft');
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
      setDraft(result.draft);
      setSpec(result.draft.skillSpec);
      setMarkdown(result.draft.draftMarkdown ?? '');
      setReview(result.draft.validation);
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
      setDraft(result.draft);
      setReview(result.review);
      if (result.review.blocking.length === 0) setStep('install');
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
      setDraft(result.draft);
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
                <Button onClick={start} disabled={busy || prompt.trim().length < 4} data-smoke-action="create-skill-start">
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                  {copy.start}
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
                    value={spec.intentFrame.inputContract.acceptedInputs.join('\n')}
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
                    value={spec.intentFrame.workflow.steps.join('\n')}
                    onChange={(e) => setWorkflow(e.target.value)}
                    className="min-h-[132px] w-full resize-none border bg-background p-3 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </Field>
                <Field label={copy.boundaries}>
                  <textarea
                    value={[...spec.intentFrame.workflow.failClosedRules, ...spec.intentFrame.nonGoals].join('\n')}
                    onChange={(e) => setBoundaryAndNonGoals(e.target.value)}
                    className="min-h-[104px] w-full resize-none border bg-background p-3 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </Field>
                <Field label={copy.criteria}>
                  <textarea
                    value={spec.intentFrame.successCriteria.join('\n')}
                    onChange={(e) => setCriteria(e.target.value)}
                    className="min-h-[88px] w-full resize-none border bg-background p-3 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </Field>
                <div className="flex gap-2">
                  <Button onClick={() => saveOutline('questions')} disabled={busy}>
                    <Pencil className="mr-2 h-4 w-4" />
                    {copy.continueQuestions}
                  </Button>
                  <Button variant="outline" onClick={generate} disabled={busy}>
                    {copy.generateNow}
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
                  <Button onClick={generate} disabled={busy || !spec}>
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
                    {copy.review}
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
                  disabled={busy || !draft || !markdown.trim() || review?.blocking.length !== 0 || targetPlatformIds.length === 0}
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
          setExecuteResult(result);
          setDraft(result.draft);
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
            onClick={() => onAnswer(`${option.id}: ${option.effect}`)}
            className="border px-3 py-3 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <span className="block font-medium">{option.label}</span>
            <span className="mt-1 block text-muted-foreground">{option.effect}</span>
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
  return (
    <div className="space-y-2">
      {review.blocking.length === 0 ? (
        <Notice tone="success" icon={<CheckCircle2 className="h-4 w-4" />}>
          {copy.reviewPassed}
        </Notice>
      ) : (
        <Notice tone="danger" icon={<AlertTriangle className="h-4 w-4" />}>
          {copy.reviewBlocked}
        </Notice>
      )}
      {[...review.blocking, ...review.warnings].map((issue) => (
        <div key={`${issue.code}-${issue.message}`} className="border bg-background px-3 py-2 text-xs">
          <span className="font-mono text-muted-foreground">{issue.code}</span>
          <span className="ml-2">{issue.message}</span>
        </div>
      ))}
    </div>
  );
}

function SkillBehaviorSummary({ spec, copy }: { spec: CreateSkillSpec; copy: Copy }) {
  return (
    <div className="grid gap-3 border bg-background p-4 text-xs md:grid-cols-2">
      <SummaryItem label={copy.description} value={spec.description} />
      <SummaryItem label={copy.trigger} value={spec.intentFrame.triggerContext} />
      <SummaryItem label={copy.inputs} value={spec.intentFrame.inputContract.acceptedInputs.join('\n')} />
      <SummaryItem
        label={copy.outputArtifact}
        value={`${spec.intentFrame.outputContract.artifactType} / ${spec.intentFrame.outputContract.destination}`}
      />
      <SummaryItem label={copy.boundaries} value={[...spec.intentFrame.workflow.failClosedRules, ...spec.intentFrame.nonGoals].join('\n')} />
      <SummaryItem label={copy.criteria} value={spec.intentFrame.successCriteria.join('\n')} />
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
  const checks = review?.checks;
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
      ok: checks?.triggerDescription ?? spec.description.trim().length > 20,
    },
    {
      label: copy.qualityInputs,
      ok: checks?.hasInputs ?? spec.intentFrame.inputContract.acceptedInputs.length > 0,
    },
    {
      label: copy.qualityWorkflow,
      ok: checks?.hasWorkflow ?? spec.intentFrame.workflow.steps.length >= 3,
    },
    {
      label: copy.qualityOutput,
      ok: checks?.hasOutput ?? Boolean(spec.intentFrame.outputContract.artifactType),
    },
    {
      label: copy.qualityBoundaries,
      ok:
        checks?.hasBoundaries ??
        spec.intentFrame.workflow.failClosedRules.length + spec.intentFrame.nonGoals.length > 0,
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

function normalizeSpec(spec: CreateSkillSpec): CreateSkillSpec {
  return {
    ...spec,
    name: slugInput(spec.name),
    intentFrame: {
      ...spec.intentFrame,
      workflow: {
        ...spec.intentFrame.workflow,
        steps: spec.intentFrame.workflow.steps.filter(Boolean),
      },
    },
  };
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
  localMode: string;
  localDraft: string;
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
  generateNow: string;
  questionsDone: string;
  generateDraft: string;
  backOutline: string;
  review: string;
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
  planInstall: string;
  done: string;
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
  localMode: 'AI 未启用，已进入可编辑的本地轮廓模式。',
  localDraft: 'AI 未启用，已生成本地模板草案；请检查后再安装。',
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
  generateNow: '直接生成草案',
  questionsDone: '关键问题已回答，可以生成草案。',
  generateDraft: '生成 SKILL.md',
  backOutline: '返回轮廓',
  review: '检查草案',
  editOutline: '编辑轮廓',
  reviewPassed: '本地安全检查通过，可以创建安装计划。',
  reviewBlocked: '还有阻塞问题，修正后再继续。',
  installTarget: '安装平台',
  scenarioTarget: '加入场景',
  noScenarios: '暂无场景，可安装后再归类。',
  installSummary: '写入摘要',
  basename: '目录名',
  mainSource: '主源',
  selectedPlatforms: '平台数',
  noWriteUntilConfirm: '这里只是目标摘要；确认安装计划之前不会写入任何 skill 目录。',
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
  planInstall: '创建安装计划',
  done: '技能已写入并重新扫描纳管。',
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
  localMode: 'AI is not enabled; using an editable local outline.',
  localDraft: 'AI is not enabled; generated a local template draft for review.',
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
  generateNow: 'Generate draft now',
  questionsDone: 'Key questions are answered. Generate the draft next.',
  generateDraft: 'Generate SKILL.md',
  backOutline: 'Back to outline',
  review: 'Review draft',
  editOutline: 'Edit outline',
  reviewPassed: 'Local safety checks passed. You can create an install plan.',
  reviewBlocked: 'Blocking issues remain. Fix them before continuing.',
  installTarget: 'Install targets',
  scenarioTarget: 'Add to scenarios',
  noScenarios: 'No scenarios yet. You can categorize after install.',
  installSummary: 'Write summary',
  basename: 'Basename',
  mainSource: 'Main source',
  selectedPlatforms: 'Platforms',
  noWriteUntilConfirm: 'This is only a target summary; no skill directory is written before you confirm the install plan.',
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
  planInstall: 'Create install plan',
  done: 'Skill was written, scanned, and added to the library.',
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
