'use client';

import { useEffect, useState } from 'react';
import { ExternalLink, Link2, AlertTriangle, EyeOff, RefreshCw } from 'lucide-react';
import type { Scenario, Skill } from '@shared/types';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { PlatformBadge } from './platform-badge';
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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.skills
      .get(skillId)
      .then((s) => {
        if (!cancelled) setSkill(s);
      })
      .catch(() => {
        if (!cancelled) setSkill(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [skillId]);

  if (loading || !skill) {
    return (
      <aside className="flex h-full w-[420px] flex-col border-l bg-card/40">
        <div className="titlebar-drag h-9 shrink-0 border-b" />
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {loading ? 'Loading…' : 'Not found'}
        </div>
      </aside>
    );
  }

  const inScenarioIds = new Set(skill.scenarios.map((s) => s.id));

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
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Locations ({skill.locations.length})
            </h3>
            <div className="space-y-2">
              {skill.locations.map((loc) => (
                <div key={loc.id} className="rounded-md border bg-background p-3 text-xs">
                  <div className="flex items-center gap-2">
                    <PlatformBadge platformId={loc.platformId} />
                    {loc.isSymlink && (
                      <span className="inline-flex items-center gap-1 text-muted-foreground">
                        <Link2 className="h-3 w-3" /> symlink
                      </span>
                    )}
                    {loc.isBrokenSymlink && (
                      <span className="inline-flex items-center gap-1 text-destructive">
                        <AlertTriangle className="h-3 w-3" /> broken
                      </span>
                    )}
                    {loc.isDisabled && (
                      <span className="inline-flex items-center gap-1 text-muted-foreground">
                        <EyeOff className="h-3 w-3" /> disabled
                      </span>
                    )}
                  </div>
                  <div className="mt-2 space-y-1 font-mono">
                    <div className="break-all">
                      <span className="text-muted-foreground">install:</span> {loc.installPath}
                    </div>
                    {loc.isSymlink && (
                      <div className="break-all">
                        <span className="text-muted-foreground">real:</span> {loc.realPath}
                      </div>
                    )}
                  </div>
                </div>
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
    </aside>
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
