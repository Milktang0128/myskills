'use client';

import { useEffect, useState } from 'react';
import { Crown, Link2, AlertTriangle, Eye, EyeOff, Check, Upload, Sparkles, X, FolderOpen, Copy as CopyIcon } from 'lucide-react';
import type {
  AiScenarioSuggestion,
  Scenario,
  Skill,
  SkillLocation,
  SyncExecuteResult,
  SyncPlan,
} from '@shared/types';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { PlatformBadge } from './platform-badge';
import { SyncConfirm } from './sync-confirm';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { cn, formatBytes, formatRelative } from '@/lib/utils';

interface Props {
  skillId: string;
  scenarios: Scenario[];
  onClose: () => void;
  onMutated: () => void;
}

export function SkillDetail({ skillId, scenarios, onClose, onMutated }: Props) {
  const t = useT();
  const [skill, setSkill] = useState<Skill | null>(null);
  const [loading, setLoading] = useState(true);
  const [canonicalPlatform, setCanonicalPlatform] = useState<string>('shared');
  const [pendingPlan, setPendingPlan] = useState<SyncPlan | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [aiSuggestions, setAiSuggestions] = useState<AiScenarioSuggestion[]>([]);

  async function fetchAll() {
    setLoading(true);
    try {
      const [s, c] = await Promise.all([
        api.skills.get(skillId),
        api.settings.get('canonical_platform'),
      ]);
      setSkill(s);
      if (c) setCanonicalPlatform(c);
    } catch {
      setSkill(null);
    } finally {
      setLoading(false);
    }
  }

  async function refreshSuggestions() {
    try {
      const s = await api.ai.getSuggestionsForSkill(skillId);
      setAiSuggestions(s);
    } catch {
      setAiSuggestions([]);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setAiSuggestions([]);
    (async () => {
      try {
        const [s, c, ai] = await Promise.all([
          api.skills.get(skillId),
          api.settings.get('canonical_platform'),
          api.ai.getSuggestionsForSkill(skillId).catch(() => [] as AiScenarioSuggestion[]),
        ]);
        if (cancelled) return;
        setSkill(s);
        if (c) setCanonicalPlatform(c);
        setAiSuggestions(ai);
      } catch {
        if (!cancelled) setSkill(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [skillId]);

  if (loading || !skill) {
    return (
      <aside className="flex h-full w-[460px] flex-col border-l bg-card/40 animate-slide-in-right">
        {/* Matches main header + sidebar top at 48px so the window-wide
            border-b stays continuous even during the loading state. */}
        <div className="titlebar-drag h-12 shrink-0 border-b" />
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {loading ? t('detail.loading') : t('detail.notFound')}
        </div>
      </aside>
    );
  }

  const inScenarioIds = new Set(skill.scenarios.map((s) => s.id));
  const canonicalLoc = skill.locations.find((l) => l.platformId === canonicalPlatform && !l.isDisabled);
  const canonicalHash = canonicalLoc?.contentHash ?? null;

  async function handleAdopt(loc: SkillLocation) {
    setBusy(true);
    try {
      const plan = await api.sync.planPromote([{ skillId, sourceLocationId: loc.id }]);
      setPendingPlan(plan);
      setPlanOpen(true);
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleDisabled(loc: SkillLocation, disable: boolean) {
    setBusy(true);
    try {
      const plan = await api.sync.planToggleDisabled([{ skillId, locationId: loc.id, disable }]);
      setPendingPlan(plan);
      setPlanOpen(true);
    } finally {
      setBusy(false);
    }
  }

  function onApplied(_result: SyncExecuteResult) {
    onMutated();
    fetchAll();
  }

  return (
    <aside
      className="flex h-full w-[460px] flex-col border-l bg-card/40 animate-slide-in-right"
      role="complementary"
      aria-label={t('detail.region.aria')}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      {/* h-12 to align with main header + sidebar top — single continuous
          border-b across the full window. */}
      <div className="titlebar-drag flex h-12 shrink-0 items-center justify-end border-b px-3">
        <button
          onClick={onClose}
          aria-label={t('common.close')}
          title={t('detail.close.title')}
          className="titlebar-no-drag inline-flex h-6 items-center gap-1 rounded px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{t('common.close')}</span>
        </button>
      </div>

      <ScrollArea className="flex-1 scrollbar-thin">
        <div className="space-y-5 p-5">
          <header className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold tracking-tight">{skill.name}</h2>
              {Array.from(new Set(skill.locations.map((l) => l.platformId))).map((p) => (
                <PlatformBadge key={p} platformId={p} />
              ))}
            </div>
            {skill.description && <p className="text-sm text-muted-foreground">{skill.description}</p>}
            <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
              {skill.version && <span>v{skill.version}</span>}
              {skill.author && <span>{t('detail.subtitle.by', { author: skill.author })}</span>}
              <span>{formatBytes(skill.sizeBytes)}</span>
              <span>{t('detail.subtitle.files', { count: skill.fileCount })}</span>
              <span>{t('detail.subtitle.scanned', { when: formatRelative(skill.lastScannedAt) })}</span>
            </div>
          </header>

          <Separator />

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t('detail.section.scenarios')}
              </h3>
            </div>

            {/* AI suggestions — visually distinct (dashed border, sparkle icon).
                A click accepts the suggestion (creates the scenario link); the
                × dismisses it. Both refresh the underlying skill so the chip
                migrates to the regular list below. */}
            {aiSuggestions.length > 0 && (
              <div className="mb-3 rounded-md border border-dashed border-primary/40 bg-primary/5 p-2">
                <div className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-primary/80">
                  <Sparkles className="h-3 w-3" />
                  {t('detail.aiSuggestions.heading')}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {aiSuggestions.map((sg) => {
                    const label = sg.scenarioName ?? sg.scenarioKey;
                    return (
                      <div
                        key={sg.id}
                        className="group inline-flex items-center overflow-hidden rounded-md border border-dashed border-primary/50 bg-background text-xs"
                        title={sg.reason ?? undefined}
                      >
                        <button
                          onClick={async () => {
                            try {
                              await api.ai.acceptSuggestion(sg.id);
                            } catch {
                              // If accept failed (e.g. scenario deleted), just
                              // refresh and let the suggestion list reconcile.
                            }
                            await refreshSuggestions();
                            const refreshed = await api.skills.get(skill.id);
                            setSkill(refreshed);
                            onMutated();
                          }}
                          className="inline-flex items-center gap-1 px-2 py-1 hover:bg-primary/10"
                        >
                          <span
                            className="inline-block h-2 w-2 rounded-full"
                            style={{ backgroundColor: sg.scenarioColor ?? '#888' }}
                          />
                          <span>{label}</span>
                          <span className="text-primary/70">+</span>
                        </button>
                        <button
                          onClick={async () => {
                            await api.ai.dismissSuggestion(sg.id);
                            await refreshSuggestions();
                          }}
                          className="border-l border-dashed border-primary/30 px-1.5 py-1 text-muted-foreground opacity-60 transition-opacity hover:bg-destructive/10 hover:text-destructive hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
                          title={t('detail.aiSuggestions.dismissAria')}
                          aria-label={t('detail.aiSuggestions.dismissAria')}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-1.5">
              {scenarios.length === 0 ? (
                <span className="text-xs text-muted-foreground">{t('detail.scenarios.noneDefined')}</span>
              ) : (
                scenarios.map((sc) => {
                  const active = inScenarioIds.has(sc.id);
                  return (
                    <button
                      key={sc.id}
                      onClick={async () => {
                        if (active) {
                          await api.scenarios.removeSkill(skill.id, sc.id);
                        } else {
                          await api.scenarios.addSkill(skill.id, sc.id);
                        }
                        onMutated();
                        const refreshed = await api.skills.get(skill.id);
                        setSkill(refreshed);
                      }}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors',
                        // Inactive chips drop the scenario color on both
                        // the dot AND the text so the user can tell at a
                        // glance which scenarios this skill is *actually*
                        // in (vs. which are merely available to assign).
                        active
                          ? 'border-transparent bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                      )}
                    >
                      <span
                        className={cn(
                          'inline-block h-2 w-2 rounded-full',
                          !active && 'bg-muted-foreground/30',
                        )}
                        style={active ? { backgroundColor: sc.color ?? '#888' } : undefined}
                      />
                      {sc.name}
                    </button>
                  );
                })
              )}
            </div>
          </section>

          <Separator />

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t('detail.section.locations', { count: skill.locations.length })}
              </h3>
              <span className="text-[10px] text-muted-foreground">
                {t('detail.section.locations.canonicalLabel')} <span className="font-medium">{canonicalPlatform}</span>
              </span>
            </div>
            <div className="space-y-2">
              {/* Canonical-first ordering comes from the backend
                  (electron/ipc/skills.ts ORDER BY clause), so we render the
                  array as-is — no client-side sort needed here. */}
              {skill.locations.map((loc) => {
                // A live real-dir location is "depended on" when some other
                // live location is a symlink resolving to the same realpath.
                // Disabling it would orphan those links, so the button is
                // blocked client-side (the backend refuses too, as a backstop).
                const hasDependents =
                  !loc.isSymlink &&
                  !loc.isDisabled &&
                  skill.locations.some(
                    (o) =>
                      o.id !== loc.id &&
                      !o.isDisabled &&
                      o.isSymlink &&
                      o.realPath === loc.realPath,
                  );
                return (
                  <LocationRow
                    key={loc.id}
                    loc={loc}
                    isCanonical={loc.platformId === canonicalPlatform}
                    canonicalHash={canonicalHash}
                    onAdopt={() => handleAdopt(loc)}
                    onToggleDisabled={(disable) => handleToggleDisabled(loc, disable)}
                    hasDependents={hasDependents}
                    busy={busy}
                  />
                );
              })}
            </div>
          </section>

          <Separator />

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('detail.section.frontmatter')}
            </h3>
            <dl className="grid grid-cols-[80px_1fr] gap-y-1 text-xs">
              <Meta label="name" value={skill.name} />
              <Meta label="source" value={skill.sourceKey} />
              <Meta label="version" value={skill.version} />
              <Meta label="author" value={skill.author} />
              <Meta label="license" value={skill.license} />
              <Meta label="hash" value={skill.contentHash.slice(0, 12) + '…'} mono />
            </dl>
          </section>

          {skill.bodyExcerpt && (
            <>
              <Separator />
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('detail.section.skillmd')}
                </h3>
                <pre className="overflow-x-auto rounded-md bg-secondary/40 p-3 text-xs whitespace-pre-wrap font-mono leading-relaxed">
                  {skill.bodyExcerpt}
                </pre>
              </section>
            </>
          )}
        </div>
      </ScrollArea>

      <SyncConfirm
        open={planOpen}
        plan={pendingPlan}
        canonicalPlatform={canonicalPlatform}
        onOpenChange={setPlanOpen}
        onApplied={onApplied}
      />
    </aside>
  );
}

function LocationRow({
  loc,
  isCanonical,
  canonicalHash,
  onAdopt,
  onToggleDisabled,
  hasDependents,
  busy,
}: {
  loc: SkillLocation;
  isCanonical: boolean;
  canonicalHash: string | null;
  onAdopt: () => void;
  onToggleDisabled: (disable: boolean) => void;
  hasDependents: boolean;
  busy: boolean;
}) {
  const t = useT();
  const [actionBusy, setActionBusy] = useState<'open-install' | 'copy-install' | 'open-target' | 'copy-target' | null>(null);
  const [copied, setCopied] = useState<'install' | 'target' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const hasTarget = loc.isSymlink && !loc.isBrokenSymlink && Boolean(loc.realPath);

  async function handleOpenLocation(kind: 'install' | 'target') {
    setActionBusy(kind === 'install' ? 'open-install' : 'open-target');
    setActionError(null);
    try {
      await api.skills.openLocation(loc.id, kind);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
    }
  }

  async function handleCopyPath(kind: 'install' | 'target') {
    setActionBusy(kind === 'install' ? 'copy-install' : 'copy-target');
    setActionError(null);
    try {
      await api.skills.copyLocationPath(loc.id, kind);
      setCopied(kind);
      window.setTimeout(() => setCopied((current) => (current === kind ? null : current)), 1400);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
    }
  }

  // Decide what status to show + whether Adopt makes sense.
  let statusIcon: React.ReactNode = null;
  let statusLabel = '';
  let statusTone = 'text-muted-foreground';
  let canAdopt = false;

  if (loc.isBrokenSymlink) {
    statusIcon = <AlertTriangle className="h-3 w-3" />;
    statusLabel = t('detail.loc.broken');
    statusTone = 'text-destructive';
    canAdopt = false; // can't adopt content we can't read
  } else if (loc.isDisabled) {
    statusIcon = <EyeOff className="h-3 w-3" />;
    statusLabel = t('detail.loc.disabled');
  } else if (isCanonical) {
    statusIcon = <Crown className="h-3 w-3" />;
    statusLabel = t('detail.loc.canonical');
    statusTone = 'text-amber-600';
  } else if (loc.isSymlink) {
    statusIcon = <Link2 className="h-3 w-3" />;
    statusLabel = t('detail.loc.symlink');
  } else {
    // Real dir, non-canonical → compare to canonical
    if (canonicalHash && loc.contentHash && loc.contentHash === canonicalHash) {
      statusIcon = <Check className="h-3 w-3" />;
      statusLabel = t('detail.loc.inSync');
      statusTone = 'text-emerald-600';
    } else if (canonicalHash && loc.contentHash) {
      statusIcon = <AlertTriangle className="h-3 w-3" />;
      statusLabel = t('detail.loc.stale');
      statusTone = 'text-amber-600';
      canAdopt = true;
    } else {
      // No canonical to compare against → this IS the only version
      statusIcon = <Check className="h-3 w-3" />;
      statusLabel = t('detail.loc.onlyVersion');
      statusTone = 'text-blue-600';
      canAdopt = true;
    }
  }

  return (
    <div className="rounded-md border bg-background p-3 text-xs">
      <div className="flex items-center gap-2">
        <PlatformBadge platformId={loc.platformId} />
        <span className={cn('inline-flex items-center gap-1', statusTone)}>
          {statusIcon}
          {statusLabel}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {loc.mtime && (
            <span className="text-[10px] text-muted-foreground" title={new Date(loc.mtime).toLocaleString()}>
              {t('detail.loc.modified', { when: formatRelative(loc.mtime) })}
            </span>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={() => handleOpenLocation('install')}
            disabled={actionBusy !== null}
            title={t('detail.loc.openInstallTitle')}
          >
            <FolderOpen className="mr-1 h-3 w-3" />
            {t('detail.loc.openInstall')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={() => handleCopyPath('install')}
            disabled={actionBusy !== null}
            title={t('detail.loc.copyInstallTitle')}
          >
            <CopyIcon className="mr-1 h-3 w-3" />
            {copied === 'install' ? t('detail.loc.copiedPath') : t('detail.loc.copyInstall')}
          </Button>
          {hasTarget && (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                onClick={() => handleOpenLocation('target')}
                disabled={actionBusy !== null}
                title={t('detail.loc.openTargetTitle')}
              >
                <FolderOpen className="mr-1 h-3 w-3" />
                {t('detail.loc.openTarget')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                onClick={() => handleCopyPath('target')}
                disabled={actionBusy !== null}
                title={t('detail.loc.copyTargetTitle')}
              >
                <CopyIcon className="mr-1 h-3 w-3" />
                {copied === 'target' ? t('detail.loc.copiedPath') : t('detail.loc.copyTarget')}
              </Button>
            </>
          )}
          {canAdopt && (
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={onAdopt}
              disabled={busy}
              title={t('detail.loc.adoptTitle')}
            >
              <Upload className="mr-1 h-3 w-3" />
              {t('detail.loc.adoptBtn')}
            </Button>
          )}
          {/* Enable/disable toggle. Broken-symlink rows are skipped — there's
              nothing meaningful to hide/restore. */}
          {!loc.isBrokenSymlink &&
            (loc.isDisabled ? (
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-[11px]"
                onClick={() => onToggleDisabled(false)}
                disabled={busy}
                title={t('detail.loc.enableTitle')}
              >
                <Eye className="mr-1 h-3 w-3" />
                {t('detail.loc.enableBtn')}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-[11px]"
                onClick={() => onToggleDisabled(true)}
                disabled={busy || hasDependents}
                title={hasDependents ? t('detail.loc.disableBlockedTitle') : t('detail.loc.disableTitle')}
              >
                <EyeOff className="mr-1 h-3 w-3" />
                {t('detail.loc.disableBtn')}
              </Button>
            ))}
        </div>
      </div>
      <div className="mt-2 space-y-0.5 font-mono text-[10px] text-muted-foreground">
        <div className="break-all">{t('detail.loc.installPrefix')} {loc.installPath}</div>
        {loc.isSymlink && <div className="break-all">{t('detail.loc.targetPrefix')} {loc.realPath}</div>}
        {loc.contentHash && <div>{t('detail.loc.hashPrefix')} {loc.contentHash.slice(0, 12)}…</div>}
        {actionError && <div className="text-destructive">{actionError}</div>}
      </div>
    </div>
  );
}

function Meta({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn(mono && 'font-mono')}>{value ?? <span className="text-muted-foreground">—</span>}</dd>
    </>
  );
}
