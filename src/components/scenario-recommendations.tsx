'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Loader2, Sparkles } from 'lucide-react';
import type {
  PlatformId,
  Scenario,
  Skill,
  SyncExecuteResult,
  SyncPlan,
} from '@shared/types';
import { Button } from '@/components/ui/button';
import { SyncConfirm } from '@/components/sync-confirm';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Recommendation {
  source: string;
  skillId: string;
  name: string;
  description: string;
  why: string;
  installs: number;
}

interface Props {
  scenario: Scenario;
  installedSkills: Skill[];
  onInstalled: () => void;
}

interface CacheEntry {
  recs: Recommendation[];
  fetchedAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CACHE = new Map<string, CacheEntry>();

const SYSTEM_PROMPT =
  'You are a skill recommender. The user has a scenario described below, with some skills already in it. From the candidate list, suggest up to 5 skills that would complement what they already have. Return strict JSON:\n' +
  '{ "recommendations": [ { "id": string, "why": string } ] }\n' +
  'The "id" must match a candidate\'s id exactly. "why" is one sentence explaining the value-add. If fewer than 5 are clearly useful, return fewer. If none, return empty array.';

function cacheKey(scenarioId: number, installedCount: number): string {
  return `${scenarioId}-${installedCount}`;
}

export function ScenarioRecommendations({ scenario, installedSkills, onInstalled }: Props) {
  const t = useT();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [recs, setRecs] = useState<Recommendation[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [pendingPlan, setPendingPlan] = useState<SyncPlan | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [canonicalPlatform, setCanonicalPlatform] = useState<PlatformId>('shared');

  // Used to ignore stale async responses when scenario/installed list changes.
  const fetchSeqRef = useRef(0);

  const installedNames = useMemo(
    () => installedSkills.map((s) => s.name.toLowerCase()),
    [installedSkills],
  );
  const installedNameSet = useMemo(() => new Set(installedNames), [installedNames]);

  const load = useCallback(async () => {
    const mySeq = ++fetchSeqRef.current;
    setError(null);

    // Check feature + key gate first.
    let features;
    let cfg;
    try {
      [features, cfg] = await Promise.all([api.llm.getFeatures(), api.llm.getConfig()]);
    } catch (e) {
      if (fetchSeqRef.current !== mySeq) return;
      setEnabled(false);
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (fetchSeqRef.current !== mySeq) return;
    if (!features.recommend || !cfg.hasApiKey) {
      setEnabled(false);
      setRecs(null);
      return;
    }
    setEnabled(true);

    // Cache check.
    const key = cacheKey(scenario.id, installedSkills.length);
    const cached = CACHE.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      setRecs(cached.recs);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      // Resolve canonical platform for the install action.
      const canon = (await api.settings.get('canonical_platform')) ?? 'shared';
      if (fetchSeqRef.current !== mySeq) return;
      setCanonicalPlatform(canon as PlatformId);

      // Search the catalog using the scenario name as the query.
      const resp = await api.catalog.search(scenario.name, 50);
      if (fetchSeqRef.current !== mySeq) return;

      // Filter out candidates already installed in this scenario (by name, ci).
      const candidates = resp.skills.filter(
        (s) => !installedNameSet.has(s.name.toLowerCase()),
      );

      if (candidates.length === 0) {
        const empty: Recommendation[] = [];
        CACHE.set(key, { recs: empty, fetchedAt: Date.now() });
        setRecs(empty);
        return;
      }

      const userMessage = buildUserMessage(scenario, installedSkills, candidates);
      const llmRes = await api.llm.chat({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.3,
        maxTokens: 1024,
        jsonMode: true,
      });
      if (fetchSeqRef.current !== mySeq) return;

      const parsed = parseRecs(llmRes.text, candidates);
      CACHE.set(key, { recs: parsed, fetchedAt: Date.now() });
      setRecs(parsed);
    } catch (e) {
      if (fetchSeqRef.current !== mySeq) return;
      setError(e instanceof Error ? e.message : String(e));
      setRecs(null);
    } finally {
      if (fetchSeqRef.current === mySeq) setLoading(false);
    }
  }, [scenario, installedSkills, installedNameSet]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!window.myskills) {
      // Wait for bridge.
      const iv = setInterval(() => {
        if (window.myskills) {
          clearInterval(iv);
          load();
        }
      }, 50);
      return () => clearInterval(iv);
    }
    load();
    // load is memoized on scenario + installedSkills so this re-runs on change.
  }, [load]);

  async function startInstall(rec: Recommendation) {
    const key = `${rec.source}/${rec.skillId}`;
    setInstalling(key);
    try {
      const plan = await api.catalog.planInstall(
        rec.source,
        rec.skillId,
        rec.name,
        [canonicalPlatform],
      );
      setPendingPlan(plan);
      setPlanOpen(true);
    } catch (e) {
      setError(t('recs.planError', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setInstalling(null);
    }
  }

  function onApplied(_result: SyncExecuteResult) {
    setPlanOpen(false);
    setPendingPlan(null);
    // Invalidate cache for any entry for this scenario so the new install is
    // reflected on the next render pass.
    for (const k of Array.from(CACHE.keys())) {
      if (k.startsWith(`${scenario.id}-`)) CACHE.delete(k);
    }
    onInstalled();
  }

  // --- render -------------------------------------------------------------

  const Header = (
    <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      <Sparkles className="h-3.5 w-3.5 text-violet-500" />
      {t('recs.heading')}
    </div>
  );

  if (enabled === false) {
    return (
      <section className="space-y-2">
        {Header}
        <p className="text-xs text-muted-foreground">
          {t('recs.disabled')}
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-2">
      {Header}

      {loading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('recs.loading')}
        </div>
      )}

      {!loading && error && (
        <p className="text-xs text-destructive">{t('recs.error', { message: error })}</p>
      )}

      {!loading && !error && recs && recs.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {t('recs.empty')}
        </p>
      )}

      {!loading && !error && recs && recs.length > 0 && (
        <ul className="space-y-2">
          {recs.map((r) => {
            const key = `${r.source}/${r.skillId}`;
            return (
              <li key={key} className="rounded-md border bg-card px-3 py-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold">{r.name}</span>
                      <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-secondary-foreground">
                        {r.source}
                      </span>
                    </div>
                    {r.description && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {r.description}
                      </p>
                    )}
                    {r.why && (
                      <p className="mt-1 text-xs italic text-foreground/80">{r.why}</p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => startInstall(r)}
                    disabled={installing === key}
                  >
                    {installing === key ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    {t('recs.install')}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <SyncConfirm
        open={planOpen}
        plan={pendingPlan}
        canonicalPlatform={canonicalPlatform}
        onOpenChange={setPlanOpen}
        onApplied={onApplied}
      />
    </section>
  );
}

function buildUserMessage(
  scenario: Scenario,
  installed: Skill[],
  candidates: { id: string; name: string; installs: number; description?: string }[],
): string {
  const lines: string[] = [];
  lines.push(
    `Scenario: ${scenario.name}${scenario.description ? ` — ${scenario.description}` : ''}`,
  );
  lines.push('Already installed in this scenario:');
  if (installed.length === 0) {
    lines.push('- (none)');
  } else {
    for (const s of installed) lines.push(`- ${s.name}`);
  }
  lines.push('Candidates:');
  for (const c of candidates) {
    const desc = (c.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    lines.push(`- id=${c.id} name=${c.name} installs=${c.installs} description=${desc}`);
  }
  return lines.join('\n');
}

function parseRecs(
  text: string,
  candidates: {
    id: string;
    skillId: string;
    name: string;
    source: string;
    installs: number;
    description?: string;
  }[],
): Recommendation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Try to extract the first JSON object from a wrapped response.
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return [];
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return [];
    }
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const list = (parsed as { recommendations?: unknown }).recommendations;
  if (!Array.isArray(list)) return [];

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const out: Recommendation[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const id = (item as { id?: unknown }).id;
    const why = (item as { why?: unknown }).why;
    if (typeof id !== 'string') continue;
    if (seen.has(id)) continue;
    const cand = byId.get(id);
    if (!cand) continue;
    seen.add(id);
    out.push({
      source: cand.source,
      skillId: cand.skillId,
      name: cand.name,
      description: cand.description ?? '',
      why: typeof why === 'string' ? why : '',
      installs: cand.installs,
    });
    if (out.length >= 5) break;
  }
  return out;
}
