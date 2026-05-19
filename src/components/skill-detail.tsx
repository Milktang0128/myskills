'use client';

import { useEffect, useState } from 'react';
import { Crown, Link2, AlertTriangle, EyeOff, Check, Upload } from 'lucide-react';
import type { Scenario, Skill, SkillLocation, SyncExecuteResult, SyncPlan } from '@shared/types';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { PlatformBadge } from './platform-badge';
import { SyncConfirm } from './sync-confirm';
import { api } from '@/lib/api';
import { cn, formatBytes, formatRelative } from '@/lib/utils';

interface Props {
  skillId: string;
  scenarios: Scenario[];
  onClose: () => void;
  onMutated: () => void;
}

export function SkillDetail({ skillId, scenarios, onClose, onMutated }: Props) {
  const [skill, setSkill] = useState<Skill | null>(null);
  const [loading, setLoading] = useState(true);
  const [canonicalPlatform, setCanonicalPlatform] = useState<string>('shared');
  const [pendingPlan, setPendingPlan] = useState<SyncPlan | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [busy, setBusy] = useState(false);

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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [s, c] = await Promise.all([
          api.skills.get(skillId),
          api.settings.get('canonical_platform'),
        ]);
        if (cancelled) return;
        setSkill(s);
        if (c) setCanonicalPlatform(c);
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
          {loading ? 'Loading…' : 'Not found'}
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
    <aside className="flex h-full w-[460px] flex-col border-l bg-card/40">
      <div className="titlebar-drag flex h-9 shrink-0 items-center justify-end border-b px-3">
        <button
          onClick={onClose}
          className="titlebar-no-drag text-xs text-muted-foreground hover:text-foreground"
        >
          Close
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
              {skill.author && <span>by {skill.author}</span>}
              <span>{formatBytes(skill.sizeBytes)}</span>
              <span>{skill.fileCount} files</span>
              <span>scanned {formatRelative(skill.lastScannedAt)}</span>
            </div>
          </header>

          <Separator />

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Scenarios
              </h3>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {scenarios.length === 0 ? (
                <span className="text-xs text-muted-foreground">No scenarios defined yet.</span>
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
                        active
                          ? 'border-transparent bg-primary text-primary-foreground'
                          : 'hover:bg-accent',
                      )}
                    >
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ backgroundColor: sc.color ?? '#888' }}
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
                Locations ({skill.locations.length})
              </h3>
              <span className="text-[10px] text-muted-foreground">
                Canonical: <span className="font-medium">{canonicalPlatform}</span>
              </span>
            </div>
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
          </section>

          <Separator />

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Frontmatter
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
                  SKILL.md
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
  busy,
}: {
  loc: SkillLocation;
  isCanonical: boolean;
  canonicalHash: string | null;
  onAdopt: () => void;
  busy: boolean;
}) {
  // Decide what status to show + whether Adopt makes sense.
  let statusIcon: React.ReactNode = null;
  let statusLabel = '';
  let statusTone = 'text-muted-foreground';
  let canAdopt = false;

  if (loc.isBrokenSymlink) {
    statusIcon = <AlertTriangle className="h-3 w-3" />;
    statusLabel = 'Broken';
    statusTone = 'text-destructive';
    canAdopt = false; // can't adopt content we can't read
  } else if (loc.isDisabled) {
    statusIcon = <EyeOff className="h-3 w-3" />;
    statusLabel = 'Disabled';
  } else if (isCanonical) {
    statusIcon = <Crown className="h-3 w-3" />;
    statusLabel = 'Canonical — source of truth';
    statusTone = 'text-amber-600';
  } else if (loc.isSymlink) {
    statusIcon = <Link2 className="h-3 w-3" />;
    statusLabel = 'Symlink';
  } else {
    // Real dir, non-canonical → compare to canonical
    if (canonicalHash && loc.contentHash && loc.contentHash === canonicalHash) {
      statusIcon = <Check className="h-3 w-3" />;
      statusLabel = 'In sync';
      statusTone = 'text-emerald-600';
    } else if (canonicalHash && loc.contentHash) {
      statusIcon = <AlertTriangle className="h-3 w-3" />;
      statusLabel = 'Stale — content differs from canonical';
      statusTone = 'text-amber-600';
      canAdopt = true;
    } else {
      // No canonical to compare against → this IS the only version
      statusIcon = <Check className="h-3 w-3" />;
      statusLabel = 'Only version (canonical missing this skill)';
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
              modified {formatRelative(loc.mtime)}
            </span>
          )}
          {canAdopt && (
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={onAdopt}
              disabled={busy}
              title="Copy this version into canonical (with backup) and symlink every other platform to it"
            >
              <Upload className="mr-1 h-3 w-3" />
              Adopt as canonical
            </Button>
          )}
        </div>
      </div>
      <div className="mt-2 space-y-0.5 font-mono text-[10px] text-muted-foreground">
        <div className="break-all">install: {loc.installPath}</div>
        {loc.isSymlink && <div className="break-all">→ {loc.realPath}</div>}
        {loc.contentHash && <div>hash: {loc.contentHash.slice(0, 12)}…</div>}
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
