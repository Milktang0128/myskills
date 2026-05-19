'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, RefreshCw, AlertTriangle, FileWarning, FolderSearch } from 'lucide-react';
import type { AppStats, Platform, ScanResult } from '@shared/types';
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
  const [bridgeReady, setBridgeReady] = useState(false);

  const refresh = useCallback(async () => {
    const [pls, st, ls] = await Promise.all([
      api.platforms.list(),
      api.settings.stats(),
      api.scan.lastResult(),
    ]);
    setPlatforms(pls);
    setStats(st);
    setLastScan(ls);
  }, []);

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
            <h2 className="text-base font-semibold">Platform directories</h2>
            <p className="text-xs text-muted-foreground">
              Where MySkills looks for SKILL.md folders. Changes take effect on next scan.
            </p>
            <div className="space-y-3">
              {platforms.map((p) => (
                <div key={p.id} className="space-y-1.5">
                  <Label htmlFor={`dir-${p.id}`} className="flex items-center gap-2">
                    {p.label}
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
                  </div>
                </div>
              ))}
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
    default:
      return kind;
  }
}
