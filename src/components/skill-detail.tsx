'use client';

import { useEffect, useState } from 'react';
import { Crown, Link2, AlertTriangle, EyeOff, Check, Upload, Sparkles, X } from 'lucide-react';
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
      <aside className="flex h-full w-[460px] flex-col border-l bg-card/40">
        <div className="titlebar-drag h-9 shrink-0 border-b" />
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

  function onApplied(_result: SyncExecuteResult) {
    onMutated();
    fetchAll();
  }

  return (
    // Third band of the layout: paper-panel (slightly lighter cream than
    // main). Left rule, kicker-labeled top strip — same editorial vocab
    // as the workspace topbar.
    <aside
      className="flex h-full w-[460px] flex-col border-l border-rule bg-paper-panel"
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
      <div className="titlebar-drag flex h-11 shrink-0 items-center justify-between border-b border-rule px-4">
        <span className="font-mono text-[10px] uppercase leading-none tracking-[var(--widest)] font-semibold text-red-brand">
          SKILL · {t('detail.region.aria')}
        </span>
        <button
          onClick={onClose}
          aria-label={t('common.close')}
          title={t('detail.close.title')}
          className="titlebar-no-drag inline-flex items-center gap-1 font-mono text-[10px] uppercase leading-none tracking-[var(--wide)] text-mute hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink"
        >
          <X className="h-2.5 w-2.5 -translate-y-px" aria-hidden="true" />
          <span>{t('common.close')}</span>
        </button>
      </div>

      <ScrollArea className="flex-1 scrollbar-thin">
        <div className="space-y-0 px-5 py-6">
          <header className="space-y-2.5">
            {/* Kicker: author · version */}
            <div className="tk">
              {[skill.author?.toUpperCase(), skill.version && `V${skill.version}`].filter(Boolean).join(' · ') || 'SKILL'}
            </div>
            <h2 className="t-cn-h2">{skill.name}</h2>
            {skill.description && (
              <p className="text-[13px] leading-relaxed text-soft">{skill.description}</p>
            )}
            <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] uppercase leading-none tracking-[var(--wide)] tabular-nums text-mute pt-2">
              {skill.version && <span>V{skill.version}</span>}
              {skill.author && <span>{skill.author}</span>}
              {skill.license && <span>{skill.license}</span>}
              <span>{formatBytes(skill.sizeBytes)}</span>
              <span>{t('detail.subtitle.files', { count: skill.fileCount })}</span>
              <span>{t('detail.subtitle.scanned', { when: formatRelative(skill.lastScannedAt) })}</span>
              <span className="break-all">HASH {skill.contentHash.slice(0, 8)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 pt-2">
              {Array.from(new Set(skill.locations.map((l) => l.platformId))).map((p) => (
                <PlatformBadge key={p} platformId={p} canonical={p === canonicalPlatform} />
              ))}
            </div>
          </header>


          <DrawerSection title={t('detail.section.scenarios')}>
            {aiSuggestions.length > 0 && (
              <div className="mb-3 border border-dashed border-red-brand/40 bg-[rgba(225,70,43,0.05)] p-2">
                <div className="mb-1.5 flex items-center gap-1 font-mono text-[10px] font-semibold uppercase leading-none tracking-[var(--wide)] text-red-brand">
                  <Sparkles className="h-3 w-3 -translate-y-px" />
                  {t('detail.aiSuggestions.heading')}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {aiSuggestions.map((sg) => {
                    const label = sg.scenarioName ?? sg.scenarioKey;
                    return (
                      <div
                        key={sg.id}
                        className="group inline-flex items-center overflow-hidden border border-dashed border-red-brand/50 bg-paper-white text-xs"
                        title={sg.reason ?? undefined}
                      >
                        <button
                          onClick={async () => {
                            try {
                              await api.ai.acceptSuggestion(sg.id);
                            } catch {
                              /* refresh resolves the list */
                            }
                            await refreshSuggestions();
                            const refreshed = await api.skills.get(skill.id);
                            setSkill(refreshed);
                            onMutated();
                          }}
                          className="inline-flex items-center gap-1.5 px-2 py-1 hover:bg-[rgba(225,70,43,0.08)]"
                        >
                          <span
                            className="inline-block h-1.5 w-1.5 rounded-full"
                            style={{ backgroundColor: sg.scenarioColor ?? '#888' }}
                          />
                          <span>{label}</span>
                          <span className="text-red-brand">+</span>
                        </button>
                        <button
                          onClick={async () => {
                            await api.ai.dismissSuggestion(sg.id);
                            await refreshSuggestions();
                          }}
                          className="border-l border-dashed border-red-brand/30 px-1.5 py-1 text-mute opacity-60 transition-opacity hover:bg-[rgba(225,70,43,0.1)] hover:text-red-brand hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-brand group-hover:opacity-100"
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
                <span className="font-mono text-[10px] uppercase tracking-[var(--wide)] text-mute">
                  {t('detail.scenarios.noneDefined')}
                </span>
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
                        'inline-flex items-center gap-1.5 border px-2 py-1.5 font-mono text-[10px] uppercase leading-none tracking-[0.06em] transition-colors',
                        active
                          ? 'border-ink bg-ink text-[#f2eee2]'
                          : 'border-rule text-soft hover:border-ink hover:text-ink',
                      )}
                    >
                      <span
                        className="inline-block h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: sc.color ?? '#888' }}
                      />
                      {sc.name}
                    </button>
                  );
                })
              )}
            </div>
          </DrawerSection>

          <DrawerSection
            title={t('detail.section.locations', { count: skill.locations.length })}
            aux={
              <>
                {t('detail.section.locations.canonicalLabel')}{' '}
                <span className="text-red-brand uppercase">{canonicalPlatform}</span>
              </>
            }
          >
            <div className="space-y-2">
              {skill.locations.map((loc) => (
                <LocationRow
                  key={loc.id}
                  loc={loc}
                  isCanonical={loc.platformId === canonicalPlatform}
                  canonicalHash={canonicalHash}
                  onAdopt={() => handleAdopt(loc)}
                  busy={busy}
                />
              ))}
            </div>
          </DrawerSection>

          <DrawerSection title={t('detail.section.frontmatter')}>
            <dl className="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1 font-mono text-[12px]">
              <Meta label="name" value={skill.name} />
              <Meta label="source" value={skill.sourceKey} />
              <Meta label="version" value={skill.version} />
              <Meta label="author" value={skill.author} />
              <Meta label="license" value={skill.license} />
              <Meta label="hash" value={skill.contentHash.slice(0, 12) + '…'} mono />
            </dl>
          </DrawerSection>

          {skill.bodyExcerpt && (
            <DrawerSection title={t('detail.section.skillmd')}>
              <pre className="overflow-x-auto border border-rule bg-paper-white p-3.5 font-mono text-[11.5px] leading-[1.7] whitespace-pre-wrap text-soft">
                {skill.bodyExcerpt}
              </pre>
            </DrawerSection>
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

/**
 * Editorial section block: mono kicker title on the left, optional muted
 * aux line on the right, hairline rule on top. Replaces the previous
 * <Separator /> + h3 pattern with the world-of-windows section rhythm.
 */
function DrawerSection({
  title,
  aux,
  children,
}: {
  title: string;
  aux?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6 border-t border-rule pt-4">
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[var(--widest)] text-ink">
          {title}
        </h3>
        {aux && (
          <span className="font-mono text-[9.5px] uppercase tracking-[var(--wide)] text-mute">
            {aux}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

function LocationRow({
  loc,
  isCanonical,
  canonicalHash,
  onAdopt,
  busy,
}: {
  loc: SkillLocation;
  isCanonical: boolean;
  canonicalHash: string | null;
  onAdopt: () => void;
  busy: boolean;
}) {
  const t = useT();
  // Decide what status to show + whether Adopt makes sense.
  let statusIcon: React.ReactNode = null;
  let statusLabel = '';
  let statusTone = 'text-soft';
  let canAdopt = false;

  if (loc.isBrokenSymlink) {
    statusIcon = <AlertTriangle className="h-2.5 w-2.5" />;
    statusLabel = t('detail.loc.broken');
    statusTone = 'text-red-brand';
    canAdopt = false;
  } else if (loc.isDisabled) {
    statusIcon = <EyeOff className="h-2.5 w-2.5" />;
    statusLabel = t('detail.loc.disabled');
    statusTone = 'text-mute';
  } else if (isCanonical) {
    statusIcon = <Crown className="h-2.5 w-2.5" />;
    statusLabel = t('detail.loc.canonical');
    statusTone = 'text-red-brand';
  } else if (loc.isSymlink) {
    statusIcon = <Link2 className="h-2.5 w-2.5" />;
    statusLabel = t('detail.loc.symlink');
    statusTone = 'text-soft';
  } else {
    if (canonicalHash && loc.contentHash && loc.contentHash === canonicalHash) {
      statusIcon = <Check className="h-2.5 w-2.5" />;
      statusLabel = t('detail.loc.inSync');
      statusTone = 'text-soft';
    } else if (canonicalHash && loc.contentHash) {
      statusIcon = <AlertTriangle className="h-2.5 w-2.5" />;
      statusLabel = t('detail.loc.stale');
      statusTone = 'text-amber-warn';
      canAdopt = true;
    } else {
      statusIcon = <Check className="h-2.5 w-2.5" />;
      statusLabel = t('detail.loc.onlyVersion');
      statusTone = 'text-soft';
      canAdopt = true;
    }
  }

  return (
    // White paper card (the "near-white" --paper-white token), hairline
    // ink-rule border, mono status caps. Modified date on the right is
    // a meta cap — same vocab as the matrix legend.
    <div className="border border-rule bg-paper-white p-3 text-[12px]">
      <div className="flex items-center gap-2">
        <PlatformBadge platformId={loc.platformId} canonical={isCanonical} />
        <span className={cn('inline-flex items-center gap-1 font-mono text-[10px] uppercase leading-none tracking-[var(--wide)]', statusTone)}>
          <span className="-translate-y-px">{statusIcon}</span>
          {statusLabel}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {loc.mtime && (
            <span className="font-mono text-[9.5px] uppercase leading-none tracking-[0.04em] tabular-nums text-mute" title={new Date(loc.mtime).toLocaleString()}>
              {t('detail.loc.modified', { when: formatRelative(loc.mtime) })}
            </span>
          )}
          {canAdopt && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onAdopt}
              disabled={busy}
              title={t('detail.loc.adoptTitle')}
            >
              <Upload className="mr-1 h-3 w-3" />
              {t('detail.loc.adoptBtn')}
            </Button>
          )}
        </div>
      </div>
      <div className="mt-2.5 space-y-0.5 font-mono text-[10px] leading-[1.6] tabular-nums text-mute">
        <div className="break-all">{t('detail.loc.installPrefix')} {loc.installPath}</div>
        {loc.isSymlink && (
          <div className="break-all">
            <span className="text-red-brand">→</span> {loc.realPath}
          </div>
        )}
        {loc.contentHash && <div>{t('detail.loc.hashPrefix')} {loc.contentHash.slice(0, 12)}…</div>}
      </div>
    </div>
  );
}

function Meta({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <>
      <dt className="font-mono text-[10px] uppercase tracking-[var(--wide)] text-mute self-center">{label}</dt>
      <dd className={cn('m-0 text-ink', mono && 'font-mono')}>
        {value ?? <span className="text-mute">—</span>}
      </dd>
    </>
  );
}
