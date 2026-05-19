'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  RefreshCw,
  AlertTriangle,
  FileWarning,
  FolderSearch,
  Crown,
  CloudOff,
  FileX2,
  Plus,
  Trash2,
  Search,
  Check,
  X,
} from 'lucide-react';
import type { AppStats, Platform, ScanResult } from '@shared/types';
import { PlatformBadge } from '@/components/platform-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/utils';

export default function SettingsPage() {
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [stats, setStats] = useState<AppStats | null>(null);
  const [lastScan, setLastScan] = useState<ScanResult | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [scanning, setScanning] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [bridgeReady, setBridgeReady] = useState(false);
  const [canonical, setCanonical] = useState<string>('shared');
  const [savingCanonical, setSavingCanonical] = useState(false);
  const [candidates, setCandidates] = useState<
    Array<{ id: string; label: string; defaultDir: string; description: string }>
  >([]);
  const [probeResults, setProbeResults] = useState<
    Record<string, { exists: boolean; readable: boolean; skillCount: number; resolvedPath: string; alreadyRegistered: boolean }>
  >({});
  const [addingCandidate, setAddingCandidate] = useState<string | null>(null);
  const [customForm, setCustomForm] = useState<{ id: string; label: string; skillsDir: string }>({
    id: '',
    label: '',
    skillsDir: '',
  });
  const [customError, setCustomError] = useState<string | null>(null);
  const [savingCustom, setSavingCustom] = useState(false);

  const refresh = useCallback(async () => {
    const [pls, st, ls, c, cands] = await Promise.all([
      api.platforms.list(),
      api.settings.stats(),
      api.scan.lastResult(),
      api.settings.get('canonical_platform'),
      api.platforms.knownCandidates(),
    ]);
    setPlatforms(pls);
    setStats(st);
    setLastScan(ls);
    if (c) setCanonical(c);
    setCandidates(cands);
    // Probe each known candidate's default dir in parallel.
    const probes = await Promise.all(
      cands.map((cand) => api.platforms.probe(cand.defaultDir).then((r) => [cand.id, r] as const)),
    );
    const probeMap: typeof probeResults = {};
    for (const [id, r] of probes) probeMap[id] = r;
    setProbeResults(probeMap);
  }, []);

  async function saveCanonical(value: string) {
    setSavingCanonical(true);
    try {
      await api.settings.set('canonical_platform', value);
      setCanonical(value);
    } finally {
      setSavingCanonical(false);
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.myskills) {
      setBridgeReady(true);
      return;
    }
    const t = setInterval(() => {
      if (window.myskills) {
        setBridgeReady(true);
        clearInterval(t);
      }
    }, 50);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!bridgeReady) return;
    refresh();
    const offEnd = api.on.scanFinished(() => {
      setScanning(false);
      refresh();
    });
    return () => {
      offEnd();
    };
  }, [bridgeReady, refresh]);

  const errorsByKind = useMemo(() => {
    const map = new Map<string, ScanResult['errors']>();
    if (!lastScan) return map;
    for (const err of lastScan.errors) {
      const arr = map.get(err.kind) ?? [];
      arr.push(err);
      map.set(err.kind, arr);
    }
    return map;
  }, [lastScan]);

  async function saveDir(p: Platform) {
    const newDir = edits[p.id]?.trim();
    if (!newDir || newDir === p.skillsDir) return;
    setSavingId(p.id);
    try {
      await api.platforms.update(p.id, newDir);
      setEdits((prev) => {
        const next = { ...prev };
        delete next[p.id];
        return next;
      });
      await refresh();
    } finally {
      setSavingId(null);
    }
  }

  async function deletePlatform(p: Platform) {
    if (p.isBuiltin) return;
    if (!confirm(`Remove "${p.label}" from MySkills? Existing skills under this platform must be removed first.`)) return;
    setDeletingId(p.id);
    try {
      await api.platforms.delete(p.id);
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
    }
  }

  async function enableCandidate(cand: { id: string; label: string; defaultDir: string }) {
    setAddingCandidate(cand.id);
    try {
      await api.platforms.create({ id: cand.id, label: cand.label, skillsDir: cand.defaultDir });
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setAddingCandidate(null);
    }
  }

  async function submitCustom() {
    setCustomError(null);
    setSavingCustom(true);
    try {
      await api.platforms.create({
        id: customForm.id.trim(),
        label: customForm.label.trim(),
        skillsDir: customForm.skillsDir.trim(),
      });
      setCustomForm({ id: '', label: '', skillsDir: '' });
      await refresh();
    } catch (err) {
      setCustomError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingCustom(false);
    }
  }

  async function runScan() {
    setScanning(true);
    try {
      await api.scan.run();
      await refresh();
    } finally {
      setScanning(false);
    }
  }

  return (
    <main className="flex h-screen w-screen flex-col overflow-hidden">
      <header className="titlebar-drag flex h-12 shrink-0 items-center border-b pl-[88px] pr-4">
        <div className="titlebar-no-drag flex items-center gap-2">
          <Link
            href="/"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-accent"
            aria-label="Back"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <h1 className="text-sm font-semibold">Settings</h1>
        </div>
      </header>

      <ScrollArea className="flex-1 scrollbar-thin">
        <div className="mx-auto w-full max-w-3xl space-y-8 p-6">
          <section className="space-y-3">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Crown className="h-4 w-4 text-amber-500" />
              Canonical platform
            </h2>
            <p className="text-xs text-muted-foreground">
              MySkills treats one platform as the source of truth. Sync creates symlinks on
              other platforms pointing at the canonical copy; promote moves orphans into it.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {platforms.map((p) => {
                const active = p.id === canonical;
                return (
                  <button
                    key={p.id}
                    onClick={() => saveCanonical(p.id)}
                    disabled={savingCanonical}
                    className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors ${
                      active
                        ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/30'
                        : 'hover:bg-accent'
                    }`}
                  >
                    {active && <Crown className="h-3.5 w-3.5 text-amber-500" />}
                    <PlatformBadge platformId={p.id} />
                    <span>{p.label}</span>
                    <span className="text-[10px] text-muted-foreground">
                      ({stats?.byPlatform?.[p.id] ?? 0})
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">Last scan</h2>
              <Button variant="outline" size="sm" onClick={runScan} disabled={scanning}>
                <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${scanning ? 'animate-spin' : ''}`} />
                {scanning ? 'Scanning…' : 'Rescan now'}
              </Button>
            </div>
            {lastScan ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Total found" value={lastScan.totalFound} />
                <Stat label="New" value={lastScan.newSkills} />
                <Stat label="Updated" value={lastScan.updatedSkills} />
                <Stat label="Removed" value={lastScan.removedSkills} />
                <Stat label="Duration" value={`${lastScan.durationMs} ms`} />
                <Stat label="Errors" value={lastScan.errors.length} tone={lastScan.errors.length ? 'warn' : undefined} />
                <Stat label="Finished" value={formatRelative(lastScan.scannedAt)} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No scan recorded yet. Click "Rescan now".</p>
            )}
          </section>

          {lastScan && lastScan.errors.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-base font-semibold">Scan errors ({lastScan.errors.length})</h2>
              {Array.from(errorsByKind.entries()).map(([kind, errors]) => (
                <details key={kind} className="rounded-md border bg-card">
                  <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm">
                    <ErrorIcon kind={kind} />
                    <span className="font-medium">{labelForKind(kind)}</span>
                    <span className="text-xs text-muted-foreground">({errors.length})</span>
                  </summary>
                  <ul className="space-y-1 border-t px-3 py-2">
                    {errors.map((e, i) => (
                      <li key={i} className="font-mono text-xs">
                        <div className="break-all text-muted-foreground">{e.path}</div>
                        <div className="break-all">{e.message}</div>
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
            </section>
          )}

          <Separator />

          <section className="space-y-3">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Search className="h-4 w-4" />
              Discover platforms
            </h2>
            <p className="text-xs text-muted-foreground">
              Common SKILL.md-compatible agent tools. MySkills probes each default path; click <em>Add</em> on any
              that exist but aren't enabled yet.
            </p>
            <div className="space-y-2">
              {candidates.map((cand) => {
                const probe = probeResults[cand.id];
                const isRegistered = !!probe?.alreadyRegistered;
                const exists = probe?.exists ?? false;
                return (
                  <div
                    key={cand.id}
                    className="flex items-center gap-3 rounded-md border bg-card px-3 py-2"
                  >
                    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full">
                      {isRegistered ? (
                        <Check className="h-3.5 w-3.5 text-emerald-600" />
                      ) : exists ? (
                        <Check className="h-3.5 w-3.5 text-blue-600" />
                      ) : (
                        <X className="h-3.5 w-3.5 text-muted-foreground/40" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{cand.label}</div>
                      <div className="font-mono text-[10px] text-muted-foreground truncate">
                        {probe?.resolvedPath ?? cand.defaultDir}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {cand.description}
                        {probe && probe.exists && probe.readable
                          ? ` · ${probe.skillCount} skill${probe.skillCount === 1 ? '' : 's'} detected`
                          : probe && !probe.exists
                          ? ' · path not found'
                          : ''}
                      </div>
                    </div>
                    {isRegistered ? (
                      <span className="text-[11px] text-muted-foreground">enabled</span>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => enableCandidate(cand)}
                        disabled={addingCandidate === cand.id}
                      >
                        {addingCandidate === cand.id ? 'Adding…' : 'Add'}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold">Platform directories</h2>
            <p className="text-xs text-muted-foreground">
              Edit a platform's path, or remove non-built-in ones. Built-in platforms can be re-pointed but not deleted.
            </p>
            <div className="space-y-3">
              {platforms.map((p) => (
                <div key={p.id} className="space-y-1.5">
                  <Label htmlFor={`dir-${p.id}`} className="flex items-center gap-2">
                    {p.label}
                    {!p.isBuiltin && (
                      <span className="rounded bg-secondary px-1 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">
                        custom
                      </span>
                    )}
                    <span className="text-[10px] font-normal text-muted-foreground">
                      {stats?.byPlatform?.[p.id] ?? 0} skills
                    </span>
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id={`dir-${p.id}`}
                      value={edits[p.id] ?? p.skillsDir}
                      onChange={(e) => setEdits((prev) => ({ ...prev, [p.id]: e.target.value }))}
                      className="font-mono text-xs"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => saveDir(p)}
                      disabled={savingId === p.id || !edits[p.id] || edits[p.id] === p.skillsDir}
                    >
                      {savingId === p.id ? 'Saving…' : 'Save'}
                    </Button>
                    {!p.isBuiltin && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => deletePlatform(p)}
                        disabled={deletingId === p.id}
                        title="Remove this platform from MySkills"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Plus className="h-4 w-4" />
              Add custom platform
            </h2>
            <p className="text-xs text-muted-foreground">
              For tools not in the discover list, or any other directory you keep SKILL.md folders in.
            </p>
            <div className="grid gap-2 sm:grid-cols-[140px_1fr] sm:grid-rows-[auto_auto_auto] sm:items-center">
              <Label htmlFor="cp-id">ID</Label>
              <Input
                id="cp-id"
                placeholder="e.g. work_skills"
                value={customForm.id}
                onChange={(e) => setCustomForm({ ...customForm, id: e.target.value })}
                className="font-mono text-xs"
              />
              <Label htmlFor="cp-label">Label</Label>
              <Input
                id="cp-label"
                placeholder="e.g. Work Skills"
                value={customForm.label}
                onChange={(e) => setCustomForm({ ...customForm, label: e.target.value })}
              />
              <Label htmlFor="cp-dir">Skills directory</Label>
              <Input
                id="cp-dir"
                placeholder="~/Dropbox/team-skills"
                value={customForm.skillsDir}
                onChange={(e) => setCustomForm({ ...customForm, skillsDir: e.target.value })}
                className="font-mono text-xs"
              />
            </div>
            {customError && <p className="text-xs text-destructive">{customError}</p>}
            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={submitCustom}
                disabled={
                  savingCustom ||
                  !customForm.id.trim() ||
                  !customForm.label.trim() ||
                  !customForm.skillsDir.trim()
                }
              >
                {savingCustom ? 'Adding…' : 'Add platform'}
              </Button>
            </div>
          </section>

          <Separator />

          <section className="space-y-3">
            <h2 className="text-base font-semibold">Stats</h2>
            {stats && (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <Stat label="Skills" value={stats.totalSkills} />
                <Stat label="Scenarios" value={stats.scenarios} />
                <Stat label="Broken symlinks" value={stats.brokenSymlinks} tone={stats.brokenSymlinks ? 'warn' : undefined} />
                <Stat label="Duplicate hashes" value={stats.duplicates} tone={stats.duplicates ? 'warn' : undefined} />
                <Stat label="Unscenarized" value={stats.unscenarized} />
              </dl>
            )}
            {stats && (
              <p className="font-mono text-[10px] text-muted-foreground break-all">DB: {stats.dbPath}</p>
            )}
          </section>
        </div>
      </ScrollArea>
    </main>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: 'warn';
}) {
  return (
    <div className="rounded-md border bg-card px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${tone === 'warn' ? 'text-amber-600' : ''}`}>{value}</div>
    </div>
  );
}

function ErrorIcon({ kind }: { kind: string }) {
  if (kind === 'broken_symlink') return <AlertTriangle className="h-3.5 w-3.5 text-destructive" />;
  if (kind === 'missing_frontmatter') return <FileWarning className="h-3.5 w-3.5 text-amber-600" />;
  if (kind === 'icloud_evicted') return <CloudOff className="h-3.5 w-3.5 text-blue-600" />;
  if (kind === 'too_large') return <FileX2 className="h-3.5 w-3.5 text-amber-600" />;
  return <FolderSearch className="h-3.5 w-3.5 text-muted-foreground" />;
}

function labelForKind(kind: string): string {
  switch (kind) {
    case 'broken_symlink':
      return 'Broken symlinks';
    case 'missing_frontmatter':
      return 'Missing frontmatter';
    case 'parse_error':
      return 'Parse errors';
    case 'unreadable':
      return 'Unreadable';
    case 'permission':
      return 'Permission denied';
    case 'icloud_evicted':
      return 'iCloud-offloaded (download the folder to fix)';
    case 'too_large':
      return 'SKILL.md too large (> 1 MB)';
    default:
      return kind;
  }
}
