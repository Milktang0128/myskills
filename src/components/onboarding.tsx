'use client';

/**
 * First-launch onboarding wizard. Full-screen overlay above the workspace,
 * shown when `settings.onboarding_completed_at` is unset. The user can also
 * re-trigger it from Settings (clears that setting, reloads).
 *
 * Four steps:
 *   1. Language — pick EN or 中. Updates immediately so the rest of the
 *      wizard is in the chosen language.
 *   2. Platforms — probe known candidates, let user enable each one and
 *      see live skill counts. Continuing from this step runs the first DB scan.
 *   3. Canonical — pick which enabled platform is source-of-truth from scanned data.
 *   4. LLM (optional) — provider + model + API key + test connection.
 *
 * Design notes
 * - The shell renders inside the workspace's <main>, so it inherits the
 *   desktop WebView environment without needing a separate window.
 * - Each step is a small component that takes a `goNext` callback. The
 *   wizard manages step index + completion side effects (writing setting).
 * - "Skip setup" anywhere closes the wizard without writing
 *   onboarding_completed_at — so the next launch shows it again. We only
 *   write the timestamp from the finish button on the last step. This is
 *   intentional: skipping is recoverable; completing is one-shot.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, FolderOpen, Loader2, X } from 'lucide-react';
import type { LlmProvider, Platform, PlatformId, ScanResult } from '@shared/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { useI18n, useT, type Locale } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const TOTAL_STEPS = 4;

interface Props {
  onDone: () => void;
}

type Step = 'language' | 'platforms' | 'canonical' | 'llm';
const STEP_ORDER: Step[] = ['language', 'platforms', 'canonical', 'llm'];
type PlatformsStepStatus = { loading: boolean; enabledCount: number; busy: boolean };
type CanonicalStepStatus = { canContinue: boolean };

export function OnboardingWizard({ onDone }: Props) {
  const t = useT();
  const [stepIdx, setStepIdx] = useState(0);
  const [completing, setCompleting] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [advanceError, setAdvanceError] = useState<string | null>(null);
  const [initialScanResult, setInitialScanResult] = useState<ScanResult | null>(null);
  const [platformsStatus, setPlatformsStatus] = useState<PlatformsStepStatus>({
    loading: true,
    enabledCount: 0,
    busy: false,
  });
  const [canonicalStatus, setCanonicalStatus] = useState<CanonicalStepStatus>({
    canContinue: false,
  });
  const step = STEP_ORDER[stepIdx]!;

  const goNext = useCallback(() => {
    setStepIdx((i) => Math.min(i + 1, STEP_ORDER.length - 1));
  }, []);
  const goBack = useCallback(() => {
    setStepIdx((i) => Math.max(i - 1, 0));
  }, []);

  const handleNext = useCallback(async () => {
    setAdvanceError(null);
    if (step === 'platforms') {
      setAdvancing(true);
      try {
        const result = await api.scan.run();
        setInitialScanResult(result);
        goNext();
      } catch (err) {
        setAdvanceError(err instanceof Error ? err.message : String(err));
      } finally {
        setAdvancing(false);
      }
      return;
    }
    goNext();
  }, [goNext, step]);

  // Pressing Escape always closes without writing the completion timestamp.
  // The user can find "Re-run Onboarding" in Settings → About if they regret it.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !advancing) onDone();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [advancing, onDone]);

  const finish = useCallback(async () => {
    setCompleting(true);
    try {
      await api.settings.set('onboarding_completed_at', String(Date.now()));
    } catch (err) {
      // Non-fatal — the user still gets the app. Re-trigger next launch is fine.
      console.error('failed to mark onboarding complete', err);
    } finally {
      setCompleting(false);
      onDone();
    }
  }, [onDone]);

  return (
    // Full-screen frosted overlay. Pointer-events-auto on the inner card so
    // clicks don't fall through to the workspace below.
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="relative flex h-[min(640px,92vh)] w-[min(720px,92vw)] flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl">
        {/* Header: brand + step indicator + skip */}
        <header className="flex shrink-0 items-center justify-between border-b px-5 py-3">
          <div className="flex items-center gap-2">
            <img src="./app-logo.png" alt="" aria-hidden="true" className="h-5 w-5 shrink-0" />
            <span className="text-sm font-semibold">{t('onboarding.welcome.brand')}</span>
            <span className="ml-2 text-[11px] text-muted-foreground">
              {t('onboarding.stepN', { n: stepIdx + 1, total: TOTAL_STEPS })}
            </span>
          </div>
          <button
            onClick={onDone}
            disabled={advancing}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={advancing ? t('onboarding.scan.closeDisabled') : t('onboarding.skipAll')}
            title={advancing ? t('onboarding.scan.closeDisabled') : t('onboarding.skipAll')}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* Step indicator dots */}
        <div className="flex shrink-0 justify-center gap-1.5 py-3">
          {STEP_ORDER.map((s, i) => (
            <span
              key={s}
              className={cn(
                'h-1.5 rounded-full transition-all',
                i === stepIdx ? 'w-6 bg-primary' : i < stepIdx ? 'w-1.5 bg-primary/60' : 'w-1.5 bg-muted',
              )}
            />
          ))}
        </div>

        {/* Step body */}
        <div className="flex-1 overflow-y-auto px-8 py-4">
          {step === 'language' && <LanguageStep />}
          {step === 'platforms' && <PlatformsStep onStatusChange={setPlatformsStatus} />}
          {step === 'canonical' && (
            <CanonicalStep initialScanResult={initialScanResult} onStatusChange={setCanonicalStatus} />
          )}
          {step === 'llm' && <LlmStep />}
        </div>

        {advanceError && (
          <div className="shrink-0 border-t bg-destructive/5 px-5 py-2 text-xs text-destructive">
            {t('onboarding.scan.error', { message: advanceError })}
          </div>
        )}

        {/* Footer: back / next */}
        <footer className="flex shrink-0 items-center justify-between border-t px-5 py-3">
          <Button variant="ghost" size="sm" onClick={goBack} disabled={stepIdx === 0 || advancing}>
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
            {t('onboarding.back')}
          </Button>
          {stepIdx < STEP_ORDER.length - 1 ? (
            <Button
              size="sm"
              onClick={handleNext}
              disabled={
                advancing ||
                (step === 'platforms' &&
                  (platformsStatus.loading || platformsStatus.busy || platformsStatus.enabledCount === 0)) ||
                (step === 'canonical' && !canonicalStatus.canContinue)
              }
            >
              {advancing && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {advancing
                ? t('onboarding.scan.running')
                : step === 'platforms' && platformsStatus.loading
                ? t('onboarding.platforms.scanning')
                : step === 'platforms' && platformsStatus.busy
                ? t('onboarding.platforms.updating')
                : step === 'platforms' && platformsStatus.enabledCount === 0
                ? t('onboarding.scan.enableFirst')
                : step === 'platforms'
                ? t('onboarding.scan.continue')
                : t('onboarding.next')}
              {!advancing && <ArrowRight className="ml-1.5 h-3.5 w-3.5" />}
            </Button>
          ) : (
            <Button size="sm" onClick={finish} disabled={completing}>
              {completing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
              {t('onboarding.finish')}
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Step 1: Language
// ─────────────────────────────────────────────────────────────────────────
function LanguageStep() {
  const { locale, setLocale } = useI18n();
  const t = useT();
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <h2 className="text-2xl font-semibold tracking-tight">{t('onboarding.welcome.brand')}</h2>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">{t('onboarding.welcome.tagline')}</p>
      <div className="mt-6 w-full max-w-sm space-y-2">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t('onboarding.lang.title')}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <LangButton active={locale === 'en'} onClick={() => setLocale('en')} label={t('onboarding.lang.en')} hint="EN" />
          <LangButton active={locale === 'zh'} onClick={() => setLocale('zh')} label={t('onboarding.lang.zh')} hint="中" />
        </div>
        <p className="pt-3 text-[11px] text-muted-foreground">{t('onboarding.lang.subtitle')}</p>
      </div>
    </div>
  );
}

function LangButton({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex flex-col items-center gap-1 rounded-xl border-2 px-4 py-5 text-sm font-medium transition-colors',
        active
          ? 'border-primary bg-primary/5 text-foreground'
          : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground',
      )}
    >
      <span className="text-xl">{hint}</span>
      <span>{label}</span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Step 2: Discover platforms
// ─────────────────────────────────────────────────────────────────────────

interface ProbedCandidate {
  id: string;
  label: string;
  defaultDir: string;
  description: string;
  // probe result
  exists: boolean;
  readable: boolean;
  skillCount: number;
  alreadyRegistered: boolean;
}

function PlatformsStep({ onStatusChange }: { onStatusChange: (status: PlatformsStepStatus) => void }) {
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [candidates, setCandidates] = useState<ProbedCandidate[]>([]);
  const [registered, setRegistered] = useState<Set<string>>(new Set());
  const [enabledCount, setEnabledCount] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Custom platform form state. Hidden by default — power-user feature.
  const [customOpen, setCustomOpen] = useState(false);
  const [customForm, setCustomForm] = useState({ id: '', label: '', skillsDir: '' });
  const [customError, setCustomError] = useState<string | null>(null);
  const [customBusy, setCustomBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [cands, plats] = await Promise.all([
        api.platforms.knownCandidates(),
        api.platforms.list(),
      ]);
      const probes = await Promise.all(
        cands.map(async (c) => {
          const r = await api.platforms.probe(c.defaultDir);
          return { ...c, ...r };
        }),
      );
      setCandidates(probes);
      setRegistered(new Set(plats.map((p) => p.id)));
      setEnabledCount(plats.filter((p) => p.enabled).length);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    onStatusChange({ loading, enabledCount, busy: busyId !== null || customBusy });
  }, [busyId, customBusy, enabledCount, loading, onStatusChange]);

  async function enable(cand: ProbedCandidate) {
    setBusyId(cand.id);
    try {
      await api.platforms.create({ id: cand.id, label: cand.label, skillsDir: cand.defaultDir });
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function submitCustom() {
    setCustomError(null);
    setCustomBusy(true);
    try {
      await api.platforms.create({
        id: customForm.id.trim(),
        label: customForm.label.trim(),
        skillsDir: customForm.skillsDir.trim(),
      });
      setCustomForm({ id: '', label: '', skillsDir: '' });
      setCustomOpen(false);
      await refresh();
    } catch (err) {
      setCustomError(err instanceof Error ? err.message : String(err));
    } finally {
      setCustomBusy(false);
    }
  }

  async function pickCustomDir() {
    setCustomError(null);
    try {
      const result = await api.platforms.pickDir(customForm.skillsDir);
      if (result.path) setCustomForm((form) => ({ ...form, skillsDir: result.path! }));
    } catch (err) {
      setCustomError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-xl font-semibold tracking-tight">{t('onboarding.platforms.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('onboarding.platforms.subtitle')}</p>
      </header>

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('onboarding.platforms.scanning')}
        </div>
      ) : (
        <div className="space-y-2">
          {candidates.map((cand) => {
            const isEnabled = registered.has(cand.id) || cand.alreadyRegistered;
            const skillsHint = !cand.exists
              ? t('onboarding.platforms.notInstalled')
              : cand.skillCount === 1
              ? t('onboarding.platforms.detected', { count: cand.skillCount })
              : t('onboarding.platforms.detectedMany', { count: cand.skillCount });
            // Localized display label + description: built-in generic concepts
            // like 'shared' get translated. Product-name platforms (Claude
            // Code etc.) keep their English brand/description.
            const displayLabel = cand.id === 'shared' ? t('platform.shared.label') : cand.label;
            const displayDescription =
              cand.id === 'shared' ? t('platform.shared.description') : cand.description;
            return (
              <div
                key={cand.id}
                className={cn(
                  'flex items-center gap-3 rounded-lg border bg-background px-3 py-2.5',
                  isEnabled && 'border-emerald-500/30 bg-emerald-50/30 dark:bg-emerald-950/10',
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {displayLabel}
                    {isEnabled && (
                      <Check className="h-3.5 w-3.5 text-emerald-600" aria-label={t('onboarding.platforms.enabled')} />
                    )}
                  </div>
                  <div
                    className="mt-0.5 font-mono text-[10px] text-muted-foreground truncate"
                    title={cand.defaultDir}
                  >
                    {cand.defaultDir}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {displayDescription} · {skillsHint}
                  </div>
                </div>
                {isEnabled ? (
                  <span className="text-[11px] font-medium text-emerald-600">
                    {t('onboarding.platforms.enabled')}
                  </span>
                ) : cand.exists ? (
                  <Button size="sm" variant="outline" onClick={() => enable(cand)} disabled={busyId === cand.id}>
                    {busyId === cand.id ? t('onboarding.platforms.enabling') : t('onboarding.platforms.enable')}
                  </Button>
                ) : (
                  <span className="text-[11px] text-muted-foreground">—</span>
                )}
              </div>
            );
          })}
          {enabledCount === 0 && !loading && (
            <p className="text-center text-xs text-amber-600">{t('onboarding.platforms.none')}</p>
          )}

          {/* Custom platform expander — power-user escape hatch for tools
              not in KNOWN_PLATFORMS. Hidden by default so the page stays
              uncluttered for the common case. */}
          <div className="pt-2">
            {!customOpen ? (
              <button
                type="button"
                onClick={() => setCustomOpen(true)}
                className="w-full rounded-lg border border-dashed bg-background/40 px-3 py-2 text-center text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-accent/30 hover:text-foreground"
              >
                {t('onboarding.platforms.custom.expand')}
              </button>
            ) : (
              <div className="space-y-3 rounded-lg border bg-background px-3 py-3">
                <div>
                  <p className="text-xs font-medium">{t('onboarding.platforms.custom.intro')}</p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    {t('onboarding.platforms.custom.hint')}
                  </p>
                </div>
                <div className="grid grid-cols-[80px_1fr] items-center gap-2">
                  <Label htmlFor="ob-cp-id" className="text-xs">{t('onboarding.platforms.custom.id')}</Label>
                  <Input
                    id="ob-cp-id"
                    value={customForm.id}
                    onChange={(e) => setCustomForm({ ...customForm, id: e.target.value })}
                    placeholder={t('onboarding.platforms.custom.idPlaceholder')}
                    className="h-8 font-mono text-xs"
                  />
                  <Label htmlFor="ob-cp-label" className="text-xs">{t('onboarding.platforms.custom.label')}</Label>
                  <Input
                    id="ob-cp-label"
                    value={customForm.label}
                    onChange={(e) => setCustomForm({ ...customForm, label: e.target.value })}
                    placeholder={t('onboarding.platforms.custom.labelPlaceholder')}
                    className="h-8 text-xs"
                  />
                  <Label htmlFor="ob-cp-dir" className="text-xs">{t('onboarding.platforms.custom.dir')}</Label>
                  <div className="flex gap-2">
                    <Input
                      id="ob-cp-dir"
                      value={customForm.skillsDir}
                      onChange={(e) => setCustomForm({ ...customForm, skillsDir: e.target.value })}
                      placeholder={t('onboarding.platforms.custom.dirPlaceholder')}
                      className="h-8 font-mono text-xs"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={pickCustomDir}
                      className="h-8 shrink-0"
                    >
                      <FolderOpen className="mr-1 h-3.5 w-3.5" />
                      {t('onboarding.platforms.custom.pickDir')}
                    </Button>
                  </div>
                </div>
                {customError && (
                  <p className="text-[11px] text-destructive break-all">{customError}</p>
                )}
                <div className="flex items-center justify-end gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setCustomOpen(false);
                      setCustomError(null);
                      setCustomForm({ id: '', label: '', skillsDir: '' });
                    }}
                    disabled={customBusy}
                  >
                    {t('onboarding.platforms.custom.collapse')}
                  </Button>
                  <Button
                    size="sm"
                    onClick={submitCustom}
                    disabled={
                      customBusy ||
                      !customForm.id.trim() ||
                      !customForm.label.trim() ||
                      !customForm.skillsDir.trim()
                    }
                  >
                    {customBusy ? t('onboarding.platforms.custom.adding') : t('onboarding.platforms.custom.add')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Step 3: Choose canonical
// ─────────────────────────────────────────────────────────────────────────

function CanonicalStep({
  initialScanResult,
  onStatusChange,
}: {
  initialScanResult: ScanResult | null;
  onStatusChange: (status: CanonicalStepStatus) => void;
}) {
  const t = useT();
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [canonical, setCanonical] = useState<string>('shared');
  const [skillCounts, setSkillCounts] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [pls, c, stats] = await Promise.all([
          api.platforms.list(),
          api.settings.get('canonical_platform'),
          api.settings.stats(),
        ]);
        if (cancelled) return;
        // Sort enabled platforms with the cross-tool agents folder ('shared')
        // pinned at the top — matches the discovery list order in step 2 and
        // matches our recommendation in `onboarding.canonical.sharedHint`.
        // Stable for the rest so users don't get surprises if they've reordered
        // platforms elsewhere.
        const enabled = pls.filter((p) => p.enabled);
        const reordered = [
          ...enabled.filter((p) => p.id === 'shared'),
          ...enabled.filter((p) => p.id !== 'shared'),
        ];
        setPlatforms(reordered);
        if (c) setCanonical(c);
        setSkillCounts(stats.byPlatform ?? {});
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    onStatusChange({ canContinue: !loading && !loadError && platforms.length > 0 });
  }, [loadError, loading, onStatusChange, platforms.length]);

  const scanSummary = initialScanResult ? getScanSummary(initialScanResult, t) : null;

  async function pick(id: PlatformId) {
    setSaving(true);
    try {
      await api.settings.set('canonical_platform', id);
      setCanonical(id);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-xl font-semibold tracking-tight">{t('onboarding.canonical.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('onboarding.canonical.subtitle')}</p>
      </header>

      {scanSummary && (
        <p
          className={cn(
            'rounded-md border px-3 py-2 text-[11px]',
            scanSummary.tone === 'success'
              ? 'border-emerald-500/30 bg-emerald-50/40 text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300'
              : 'border-amber-500/30 bg-amber-50/50 text-amber-800 dark:bg-amber-950/20 dark:text-amber-300',
          )}
        >
          {scanSummary.message}
        </p>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('onboarding.canonical.loading')}
        </div>
      ) : loadError ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-3 text-xs text-destructive">
          {t('onboarding.canonical.error', { message: loadError })}
        </p>
      ) : platforms.length === 0 ? (
        <p className="rounded-md border border-amber-500/30 bg-amber-50/50 px-3 py-3 text-xs text-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
          {t('onboarding.canonical.empty')}
        </p>
      ) : (
        <div className="space-y-2">
        {platforms.map((p) => {
          const active = p.id === canonical;
          // Same localization trick as the wizard's platforms step — the
          // built-in 'shared' platform's label is shown in the user's locale.
          // The DB label is left untouched (migration v7 already updates
          // legacy "Shared Pool" rows to the new English default).
          const displayLabel = p.id === 'shared' ? t('platform.shared.label') : p.label;
          return (
            <button
              key={p.id}
              onClick={() => pick(p.id)}
              disabled={saving}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg border-2 bg-background px-3 py-3 text-left transition-colors',
                active
                  ? 'border-primary bg-accent/40'
                  : 'border-border hover:border-foreground/20 hover:bg-accent/40',
              )}
            >
              <div
                className={cn(
                  'flex h-4 w-4 items-center justify-center rounded-full border-2',
                  active ? 'border-primary bg-primary' : 'border-muted-foreground/40',
                )}
              >
                {active && <Check className="h-2.5 w-2.5 text-white" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{displayLabel}</div>
                <div
                  className="font-mono text-[10px] text-muted-foreground truncate"
                  title={p.skillsDir}
                >
                  {p.skillsDir}
                </div>
              </div>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {t('onboarding.canonical.skillsLabel', { count: skillCounts[p.id] ?? 0 })}
              </span>
            </button>
          );
        })}
        </div>
      )}

      <p className="rounded-md border bg-secondary/30 px-3 py-2 text-[11px] text-muted-foreground">
        💡 {t('onboarding.canonical.sharedHint')}
      </p>
    </div>
  );
}

function getScanSummary(result: ScanResult, t: ReturnType<typeof useT>) {
  if (result.totalFound === 0) {
    return { tone: 'warning' as const, message: t('onboarding.scan.summary.empty') };
  }
  if (result.errors.length > 0) {
    return {
      tone: 'warning' as const,
      message: t('onboarding.scan.summary.errors', { errors: result.errors.length }),
    };
  }
  return {
    tone: 'success' as const,
    message: t('onboarding.scan.summary.success', { total: result.totalFound }),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Step 4: LLM (optional)
// ─────────────────────────────────────────────────────────────────────────

function LlmStep() {
  const t = useT();
  // DeepSeek is the default recommendation — cheap, fast, OpenAI-compatible.
  // Pre-fill the model too so the user can hit Save without typing anything;
  // if they load a previously saved config the useEffect below overrides.
  const [provider, setProvider] = useState<LlmProvider>('deepseek');
  const [model, setModel] = useState('deepseek-v4-flash');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message?: string } | null>(null);
  const [alreadyConfigured, setAlreadyConfigured] = useState(false);

  // Load existing config so re-running onboarding doesn't overwrite a working setup.
  useEffect(() => {
    (async () => {
      try {
        const cfg = await api.llm.getConfig();
        setProvider(cfg.provider);
        // Only override the prefilled default if the saved config actually
        // has a model — otherwise we'd blank the field for a first-run user
        // whose stored config is just {provider:'deepseek', model:''}.
        if (cfg.model) setModel(cfg.model);
        setAlreadyConfigured(cfg.hasApiKey);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  const placeholderModel = useMemo(() => modelPlaceholder(provider), [provider]);

  /**
   * Persist whatever the user has typed (config + optional API key) so a
   * subsequent test or save reads the right values. Called by both runTest
   * and save; centralised here so the two stay in lockstep.
   *
   * IMPORTANT: this writes to the OS credential store when an apiKey is present.
   * That's intentional — testConnection reads from that store, so there's
   * no way to "preview" a key without committing it. The user typed it
   * deliberately; they can clear it from Settings later if they change
   * their mind.
   */
  async function persistDraft() {
    await api.llm.setConfig({ provider, model: model.trim() });
    if (apiKey.trim()) {
      await api.llm.setApiKey({ key: apiKey.trim() });
      setApiKey('');
      setAlreadyConfigured(true);
    }
  }

  /** Test the current draft without enabling features or advancing. */
  async function runTest() {
    setTesting(true);
    setResult(null);
    try {
      await persistDraft();
      const r = await api.llm.testConnection();
      setResult(r);
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  }

  /** Persist + enable AI feature toggles + run final verification test. */
  async function save() {
    setSaving(true);
    setResult(null);
    try {
      await persistDraft();
      // Enable a sensible default feature set.
      await api.llm.setFeatures({ search: true, autoCategorize: true, recommend: true });
      setTesting(true);
      const r = await api.llm.testConnection();
      setResult(r);
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
      setTesting(false);
    }
  }

  return (
    <div className="space-y-4">
      <header>
        <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          {t('onboarding.llm.title')}
          <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {t('onboarding.optional')}
          </span>
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('onboarding.llm.subtitle')}</p>
      </header>

      <div className="space-y-3">
        <div className="grid grid-cols-[100px_1fr] items-center gap-2">
          <Label htmlFor="ob-provider">{t('onboarding.llm.providerLabel')}</Label>
          <select
            id="ob-provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value as LlmProvider)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            {/* DeepSeek first — it's the recommended default (price/quality
                ratio + OpenAI-compatible wire format). Anthropic and OpenAI
                follow as the most familiar fallbacks. */}
            <option value="deepseek">DeepSeek</option>
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="openrouter">OpenRouter</option>
            <option value="ollama">Ollama (local)</option>
            <option value="custom">Custom (OpenAI-compatible)</option>
          </select>

          <Label htmlFor="ob-model">{t('onboarding.llm.modelLabel')}</Label>
          <Input
            id="ob-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={placeholderModel}
            className="font-mono text-xs"
          />

          <Label htmlFor="ob-key">{t('onboarding.llm.keyLabel')}</Label>
          <Input
            id="ob-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={alreadyConfigured ? '••••••••' : t('onboarding.llm.keyPlaceholder')}
            disabled={provider === 'ollama'}
            className="font-mono text-xs"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Independent Test button — lets users verify the provider/key
              before committing to enable AI features. testConnection still
              writes the config + key to disk first (it has to, since the IPC
              reads from there), but feature toggles are deferred to Save. */}
          <Button
            size="sm"
            variant="outline"
            onClick={runTest}
            disabled={testing || saving || !model.trim() || (!apiKey.trim() && !alreadyConfigured && provider !== 'ollama')}
          >
            {testing && !saving ? t('onboarding.llm.testing') : t('onboarding.llm.testBtn')}
          </Button>
          <Button
            size="sm"
            onClick={save}
            disabled={saving || testing || !model.trim() || (!apiKey.trim() && !alreadyConfigured && provider !== 'ollama')}
          >
            {saving ? t('onboarding.llm.saving') : t('onboarding.llm.save')}
          </Button>
          {result && (
            <span className={cn('text-xs', result.ok ? 'text-emerald-600' : 'text-destructive')}>
              {result.ok ? t('onboarding.llm.testOk', { message: result.message ?? 'OK' }) : t('onboarding.llm.testFail', { message: result.message ?? '' })}
            </span>
          )}
        </div>

        <p className="rounded-md border bg-secondary/30 px-3 py-2 text-[11px] text-muted-foreground">
          🔐 {t('onboarding.llm.security')}
        </p>
      </div>
    </div>
  );
}

function modelPlaceholder(provider: LlmProvider): string {
  switch (provider) {
    case 'openai':
      return 'gpt-4o-mini';
    case 'anthropic':
      return 'claude-haiku-4-5';
    case 'deepseek':
      return 'deepseek-v4-flash';
    case 'openrouter':
      return 'anthropic/claude-3.5-sonnet';
    case 'ollama':
      return 'llama3.1:8b';
    case 'custom':
      return 'your-model-id';
  }
}
