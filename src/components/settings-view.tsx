'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  RefreshCw,
  AlertTriangle,
  FileWarning,
  FolderSearch,
  FolderOpen,
  Target,
  CloudOff,
  FileX2,
  Download,
  Plus,
  Trash2,
  Check,
  X,
  Wifi,
  Sparkles,
  KeyRound,
  Power,
  ShieldCheck,
  Boxes,
} from 'lucide-react';
import type {
  AppUpdateInfo,
  AppUpdateInstallProgress,
  AppStats,
  LlmConfig,
  LlmFeatureToggles,
  LlmProvider,
  Platform,
  ScanResult,
} from '@shared/types';
import { PlatformBadge } from '@/components/platform-badge';
import { LangToggle } from '@/components/lang-toggle';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { alertAction, confirmAction } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { formatRelative } from '@/lib/utils';

interface Props {
  /** Called when the user does something that might change sidebar counts
   * (registering a platform, rescanning, switching canonical). */
  onChanged?: () => void;
  onAiChanged?: () => void;
  focusSection?: 'ai' | null;
}

export function SettingsView({ onChanged, onAiChanged, focusSection }: Props) {
  const t = useT();
  const aiSectionRef = useRef<HTMLElement | null>(null);
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
  // Custom-platform form is collapsed by default — most users just add presets.
  const [showCustomForm, setShowCustomForm] = useState(false);
  // External-network master toggle.
  const [networkAllowed, setNetworkAllowed] = useState(true);
  const [savingNetwork, setSavingNetwork] = useState(false);
  // AI integration.
  const [llmConfig, setLlmConfig] = useState<LlmConfig | null>(null);
  const [llmFeatures, setLlmFeatures] = useState<LlmFeatureToggles>({
    search: false,
    autoCategorize: false,
    recommend: false,
    createSkill: false,
  });
  const [llmDraft, setLlmDraft] = useState<{ provider: LlmProvider; model: string; baseUrl: string }>(
    { provider: 'openai', model: '', baseUrl: '' },
  );
  const [llmApiKeyDraft, setLlmApiKeyDraft] = useState('');
  const [savingLlm, setSavingLlm] = useState(false);
  const [testingLlm, setTestingLlm] = useState(false);
  const [llmTestResult, setLlmTestResult] = useState<{ ok: boolean; message?: string } | null>(null);

  useEffect(() => {
    if (focusSection !== 'ai') return;
    window.requestAnimationFrame(() => {
      aiSectionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      window.setTimeout(() => document.getElementById('llm-key')?.focus(), 250);
    });
  }, [focusSection]);
  const [appVersion, setAppVersion] = useState('');
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateInstalled, setUpdateInstalled] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [updateProgress, setUpdateProgress] = useState<AppUpdateInstallProgress | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [pls, st, ls, c, cands, netRaw, cfg, feats] = await Promise.all([
      api.platforms.list(),
      api.settings.stats(),
      api.scan.lastResult(),
      api.settings.get('canonical_platform'),
      api.platforms.knownCandidates(),
      api.settings.get('allow_external_network'),
      api.llm.getConfig(),
      api.llm.getFeatures(),
    ]);
    setPlatforms(pls);
    setStats(st);
    setLastScan(ls);
    if (c) setCanonical(c);
    setCandidates(cands);
    // netRaw missing → default to allowed (matches the seed default).
    setNetworkAllowed(netRaw === null ? true : netRaw === '1');
    setLlmConfig(cfg);
    setLlmDraft({
      provider: cfg.provider,
      model: cfg.model ?? '',
      baseUrl: cfg.baseUrl ?? '',
    });
    setLlmFeatures(feats);
    // Probe each known candidate's default dir in parallel.
    const probes = await Promise.all(
      cands.map((cand) => api.platforms.probe(cand.defaultDir).then((r) => [cand.id, r] as const)),
    );
    const probeMap: typeof probeResults = {};
    for (const [id, r] of probes) probeMap[id] = r;
    setProbeResults(probeMap);
    // Anything that triggers a settings refresh — initial mount, scan, add/
    // remove platform, change canonical — also invalidates the parent's
    // cached sidebar counts. Cheap to over-notify; expensive to under-notify.
    onChanged?.();
  }, [onChanged]);

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
    const iv = setInterval(() => {
      if (window.myskills) {
        setBridgeReady(true);
        clearInterval(iv);
      }
    }, 50);
    return () => clearInterval(iv);
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

  useEffect(() => {
    if (!bridgeReady) return;
    api.app
      .version()
      .then(setAppVersion)
      .catch(() => {});
  }, [bridgeReady]);

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

  async function pickPlatformDir(currentDir?: string): Promise<string | null> {
    try {
      const result = await api.platforms.pickDir(currentDir);
      return result.path;
    } catch (err) {
      await alertAction({
        title: t('common.error'),
        description: err instanceof Error ? err.message : String(err),
        tone: 'destructive',
        okLabel: t('common.ok'),
      });
      return null;
    }
  }

  async function deletePlatform(p: Platform) {
    if (p.isBuiltin) return;
    const ok = await confirmAction({
      title: t('settings.platforms.removeConfirm', { label: p.label }),
      tone: 'destructive',
      confirmLabel: t('common.remove'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) return;
    setDeletingId(p.id);
    try {
      await api.platforms.delete(p.id);
      await refresh();
    } catch (err) {
      await alertAction({
        title: t('common.error'),
        description: err instanceof Error ? err.message : String(err),
        tone: 'destructive',
        okLabel: t('common.ok'),
      });
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
      await alertAction({
        title: t('common.error'),
        description: err instanceof Error ? err.message : String(err),
        tone: 'destructive',
        okLabel: t('common.ok'),
      });
    } finally {
      setAddingCandidate(null);
    }
  }

  async function submitCustom(): Promise<boolean> {
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
      return true;
    } catch (err) {
      setCustomError(err instanceof Error ? err.message : String(err));
      return false;
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

  async function toggleNetwork(next: boolean) {
    setSavingNetwork(true);
    try {
      await api.settings.set('allow_external_network', next ? '1' : '0');
      setNetworkAllowed(next);
    } finally {
      setSavingNetwork(false);
    }
  }

  async function saveAiSettings(showError = true, testAfterSave = true) {
    setSavingLlm(true);
    setLlmTestResult(null);
    try {
      await api.llm.setConfig({
        provider: llmDraft.provider,
        model: llmDraft.model.trim(),
        baseUrl: llmDraft.baseUrl.trim(),
      });
      if (llmDraft.provider !== 'ollama') {
        const key = llmApiKeyDraft.trim();
        if (key) {
          await api.llm.setApiKey({ key });
          setLlmApiKeyDraft('');
        }
      }
      const cfg = await api.llm.getConfig();
      setLlmConfig(cfg);
      onAiChanged?.();
      if (testAfterSave && llmDraft.model.trim()) {
        setTestingLlm(true);
        const result = await api.llm.testConnection();
        setLlmTestResult(result);
        if (result.ok) onAiChanged?.();
      }
      return cfg;
    } catch (err) {
      if (showError) {
        await alertAction({
          title: t('common.error'),
          description: err instanceof Error ? err.message : String(err),
          tone: 'destructive',
          okLabel: t('common.ok'),
        });
        return null;
      }
      throw err;
    } finally {
      setTestingLlm(false);
      setSavingLlm(false);
    }
  }

  async function clearLlmKey() {
    const ok = await confirmAction({
      title: t('settings.ai.removeKeyConfirm'),
      tone: 'destructive',
      confirmLabel: t('common.remove'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) return;
    await api.llm.deleteApiKey();
    const cfg = await api.llm.getConfig();
    setLlmConfig(cfg);
    setLlmTestResult(null);
    onAiChanged?.();
  }

  async function testLlm() {
    setTestingLlm(true);
      setLlmTestResult(null);
    try {
      // Persist current draft first so the test uses what the user sees.
      await saveAiSettings(false, false);
      const result = await api.llm.testConnection();
      setLlmTestResult(result);
      if (result.ok) onAiChanged?.();
    } catch (err) {
      setLlmTestResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTestingLlm(false);
    }
  }

  async function toggleFeature(key: keyof LlmFeatureToggles, next: boolean) {
    const updated = await api.llm.setFeatures({ [key]: next });
    setLlmFeatures(updated);
    onAiChanged?.();
  }

  async function checkForUpdate() {
    setCheckingUpdate(true);
    setUpdateError(null);
    setUpdateInstalled(false);
    setUpdateProgress(null);
    try {
      const result = await api.updates.check();
      setUpdateInfo(result);
      if (result.currentVersion) setAppVersion(result.currentVersion);
    } catch (err) {
      setUpdateInfo(null);
      setUpdateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingUpdate(false);
    }
  }

  async function installUpdate() {
    setInstallingUpdate(true);
    setUpdateError(null);
    try {
      await api.updates.downloadAndInstall(setUpdateProgress);
      setUpdateInstalled(true);
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstallingUpdate(false);
    }
  }

  async function relaunchApp() {
    await api.updates.relaunch();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Thin header bar that matches the other workspace views (matrix,
          scenarios, history). The sidebar handles back-navigation by view
          state; no per-view back arrow needed. Language toggle stays here
          because settings is the one place users actually flip it. */}
      <div className="flex items-center justify-between border-b px-4 py-2 text-xs">
        <h2 className="font-medium">{t('settings.title')}</h2>
        <LangToggle />
      </div>

      <ScrollArea className="flex-1 scrollbar-thin">
        <div className="mx-auto w-full max-w-3xl space-y-8 p-6">
          {/* Unified Platforms section — merges what used to be three
              separate blocks (canonical chooser at top + Discover list +
              Platform Directories list + Add Custom form). One mental
              model: this is the complete list of SKILL.md sources, with
              every per-row action exposed in context (set as core, edit
              path, remove, or add a not-yet-enabled preset). */}
          <section className="space-y-3">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Boxes className="h-4 w-4" />
              {t('settings.platforms.unified.header')}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t('settings.platforms.unified.help')}
            </p>

            <div className="space-y-3">
              {/* Registered platforms — canonical pinned to the top so the
                  crown is the first thing the eye lands on. */}
              {[...platforms]
                .sort((a, b) => {
                  if (a.id === canonical) return -1;
                  if (b.id === canonical) return 1;
                  return a.sortOrder - b.sortOrder;
                })
                .map((p) => {
                  const isCanonical = p.id === canonical;
                  const editVal = edits[p.id] ?? p.skillsDir;
                  const dirty = editVal.trim() !== p.skillsDir && editVal.trim().length > 0;
                  return (
                    <div key={p.id} className="space-y-2 rounded-md border bg-card p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <PlatformBadge platformId={p.id} />
                          <span className="text-sm font-medium">{p.label}</span>
                          <span className="rounded bg-secondary px-1 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">
                            {p.isBuiltin
                              ? t('settings.platforms.builtinBadge')
                              : t('settings.platforms.customBadge')}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {t('settings.platforms.skillsSuffix', {
                              count: stats?.byPlatform?.[p.id] ?? 0,
                            })}
                          </span>
                        </div>
                        {isCanonical ? (
                          <span className="inline-flex items-center gap-1 rounded bg-secondary px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                            <Target className="h-3 w-3" />
                            {t('settings.platforms.canonical.badge')}
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => saveCanonical(p.id)}
                            disabled={savingCanonical}
                            className="inline-flex items-center gap-1 rounded border border-transparent px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:border-border hover:bg-accent disabled:opacity-50"
                          >
                            <Target className="h-3 w-3" />
                            {t('settings.platforms.canonical.setAs')}
                          </button>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <Input
                          id={`dir-${p.id}`}
                          value={editVal}
                          onChange={(e) =>
                            setEdits((prev) => ({ ...prev, [p.id]: e.target.value }))
                          }
                          className="font-mono text-xs"
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={async () => {
                            const picked = await pickPlatformDir(editVal);
                            if (picked) {
                              setEdits((prev) => ({ ...prev, [p.id]: picked }));
                            }
                          }}
                          title={t('settings.platforms.pickDir')}
                        >
                          <FolderOpen className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => saveDir(p)}
                          disabled={savingId === p.id || !dirty}
                        >
                          {savingId === p.id
                            ? t('settings.platforms.savingBtn')
                            : t('settings.platforms.saveBtn')}
                        </Button>
                        {!p.isBuiltin && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => deletePlatform(p)}
                            disabled={deletingId === p.id}
                            title={t('settings.platforms.removeTitle')}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}

              {/* Unregistered preset candidates — only render the section if
                  there's actually something to add. Otherwise the divider
                  reads as "you can also add… nothing", which is noise. */}
              {(() => {
                const unregistered = candidates.filter(
                  (c) => !probeResults[c.id]?.alreadyRegistered,
                );
                if (unregistered.length === 0) return null;
                return (
                  <div className="space-y-3 pt-1">
                    <div className="flex items-center gap-3 text-[10px] uppercase tracking-wider text-muted-foreground">
                      <span className="h-px flex-1 bg-border" />
                      <span>{t('settings.platforms.discoverSeparator')}</span>
                      <span className="h-px flex-1 bg-border" />
                    </div>
                    {unregistered.map((cand) => {
                      const probe = probeResults[cand.id];
                      const exists = probe?.exists ?? false;
                      const skillsLine =
                        probe && probe.exists && probe.readable
                          ? ` · ${
                              probe.skillCount === 1
                                ? t('settings.discover.skillsDetected', { count: probe.skillCount })
                                : t('settings.discover.skillsDetectedMany', {
                                    count: probe.skillCount,
                                  })
                            }`
                          : probe && !probe.exists
                          ? ` · ${t('settings.discover.pathNotFound')}`
                          : '';
                      return (
                        <div
                          key={cand.id}
                          className="flex items-start gap-3 rounded-md border border-dashed bg-card/50 p-3"
                        >
                          <span className="mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full">
                            {exists ? (
                              <Check className="h-3.5 w-3.5 text-blue-600" />
                            ) : (
                              <X className="h-3.5 w-3.5 text-muted-foreground/40" />
                            )}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-medium">{cand.label}</span>
                              <span className="rounded bg-secondary px-1 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">
                                {t('settings.platforms.presetBadge')}
                              </span>
                            </div>
                            <div className="mt-0.5 text-[11px] text-muted-foreground">
                              {t('settings.platforms.recommendedPath')}{' '}
                              <span
                                className="font-mono break-all"
                                title={probe?.resolvedPath ?? cand.defaultDir}
                              >
                                {probe?.resolvedPath ?? cand.defaultDir}
                              </span>
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              {cand.description}
                              {skillsLine}
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => enableCandidate(cand)}
                            disabled={addingCandidate === cand.id}
                          >
                            <Plus className="mr-1 h-3.5 w-3.5" />
                            {addingCandidate === cand.id
                              ? t('settings.discover.adding')
                              : t('settings.discover.add')}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

              {/* Custom-platform form: collapsed by default. Only the
                  "Add custom" power user needs this; the form takes up
                  enough vertical space that always-on costs everyone. */}
              <div className="pt-1">
                {!showCustomForm ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setShowCustomForm(true)}
                  >
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    {t('settings.platforms.addCustomToggle')}
                  </Button>
                ) : (
                  <div className="space-y-3 rounded-md border bg-card p-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-medium">{t('settings.custom.header')}</h3>
                      <button
                        type="button"
                        onClick={() => {
                          setShowCustomForm(false);
                          setCustomError(null);
                        }}
                        className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                        aria-label={t('settings.platforms.addCustomClose')}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t('settings.custom.help')}
                    </p>
                    <div className="grid gap-2 sm:grid-cols-[140px_1fr] sm:items-center">
                      <Label htmlFor="cp-id">{t('settings.custom.id')}</Label>
                      <Input
                        id="cp-id"
                        placeholder={t('settings.custom.idPlaceholder')}
                        value={customForm.id}
                        onChange={(e) =>
                          setCustomForm({ ...customForm, id: e.target.value })
                        }
                        className="font-mono text-xs"
                      />
                      <Label htmlFor="cp-label">{t('settings.custom.labelField')}</Label>
                      <Input
                        id="cp-label"
                        placeholder={t('settings.custom.labelPlaceholder')}
                        value={customForm.label}
                        onChange={(e) =>
                          setCustomForm({ ...customForm, label: e.target.value })
                        }
                      />
                      <Label htmlFor="cp-dir">{t('settings.custom.dir')}</Label>
                      <div className="flex gap-2">
                        <Input
                          id="cp-dir"
                          placeholder={t('settings.custom.dirPlaceholder')}
                          value={customForm.skillsDir}
                          onChange={(e) =>
                            setCustomForm({ ...customForm, skillsDir: e.target.value })
                          }
                          className="font-mono text-xs"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          onClick={async () => {
                            const picked = await pickPlatformDir(customForm.skillsDir);
                            if (picked) setCustomForm({ ...customForm, skillsDir: picked });
                          }}
                        >
                          <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                          {t('settings.custom.pickDir')}
                        </Button>
                      </div>
                    </div>
                    {customError && (
                      <p className="text-xs text-destructive">{customError}</p>
                    )}
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        onClick={async () => {
                          const ok = await submitCustom();
                          if (ok) setShowCustomForm(false);
                        }}
                        disabled={
                          savingCustom ||
                          !customForm.id.trim() ||
                          !customForm.label.trim() ||
                          !customForm.skillsDir.trim()
                        }
                      >
                        {savingCustom
                          ? t('settings.custom.adding')
                          : t('settings.custom.addBtn')}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>

          <Separator />

          <UpdateSection
            currentVersion={appVersion}
            update={updateInfo}
            checking={checkingUpdate}
            installing={installingUpdate}
            installed={updateInstalled}
            progress={updateProgress}
            error={updateError}
            onCheck={checkForUpdate}
            onInstall={installUpdate}
            onRelaunch={relaunchApp}
          />

          <Separator />

          <section className="space-y-3">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Wifi className="h-4 w-4" />
              {t('settings.network.header')}
            </h2>
            <div className="flex items-start gap-3 rounded-md border bg-card px-3 py-3">
              <ToggleSwitch
                checked={networkAllowed}
                onChange={toggleNetwork}
                disabled={savingNetwork}
                label={t('settings.network.header')}
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">
                  {networkAllowed ? t('settings.network.enabled') : t('settings.network.offline')}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('settings.network.bodyHelp')}
                </p>
              </div>
            </div>
          </section>

          <section ref={aiSectionRef} className="scroll-mt-4 space-y-3">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Sparkles className="h-4 w-4 text-violet-500" />
              {t('settings.ai.header')}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t('settings.ai.intro')}
            </p>

            <div className={`space-y-3 ${!networkAllowed ? 'opacity-60' : ''}`}>
              <div className="grid gap-2 sm:grid-cols-[140px_1fr] sm:items-center">
                <Label htmlFor="llm-provider">{t('settings.ai.providerLabel')}</Label>
                <select
                  id="llm-provider"
                  value={llmDraft.provider}
                  onChange={(e) =>
                    setLlmDraft({ ...llmDraft, provider: e.target.value as LlmProvider })
                  }
                  disabled={!networkAllowed}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {/* Same order as the onboarding step — DeepSeek first as
                      the recommended default. */}
                  <option value="deepseek">{t('settings.ai.providerOpt.deepseek')}</option>
                  <option value="anthropic">{t('settings.ai.providerOpt.anthropic')}</option>
                  <option value="openai">{t('settings.ai.providerOpt.openai')}</option>
                  <option value="openrouter">{t('settings.ai.providerOpt.openrouter')}</option>
                  <option value="ollama">{t('settings.ai.providerOpt.ollama')}</option>
                  <option value="custom">{t('settings.ai.providerOpt.custom')}</option>
                </select>

                <Label htmlFor="llm-model">{t('settings.ai.modelLabel')}</Label>
                <Input
                  id="llm-model"
                  value={llmDraft.model}
                  onChange={(e) => setLlmDraft({ ...llmDraft, model: e.target.value })}
                  placeholder={modelPlaceholder(llmDraft.provider)}
                  disabled={!networkAllowed}
                  className="font-mono text-xs"
                />

                {(llmDraft.provider === 'custom' || llmDraft.provider === 'ollama') && (
                  <>
                    <Label htmlFor="llm-base-url">{t('settings.ai.baseUrl.label')}</Label>
                    <Input
                      id="llm-base-url"
                      value={llmDraft.baseUrl}
                      onChange={(e) => setLlmDraft({ ...llmDraft, baseUrl: e.target.value })}
                      placeholder={
                        llmDraft.provider === 'ollama'
                          ? t('settings.ai.baseUrl.placeholder.ollama')
                          : t('settings.ai.baseUrl.placeholder.custom')
                      }
                      disabled={!networkAllowed}
                      className="font-mono text-xs"
                    />
                  </>
                )}

                <Label htmlFor="llm-key" className="flex items-center gap-1.5">
                  <KeyRound className="h-3.5 w-3.5" />
                  {t('settings.ai.key.label')}
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="llm-key"
                    type="password"
                    autoComplete="off"
                    value={llmApiKeyDraft}
                    onChange={(e) => setLlmApiKeyDraft(e.target.value)}
                    placeholder={
                      llmConfig?.hasApiKey
                        ? t('settings.ai.key.placeholder.saved')
                        : llmDraft.provider === 'ollama'
                        ? t('settings.ai.key.placeholder.ollama')
                        : t('settings.ai.key.placeholder.default')
                    }
                    disabled={!networkAllowed || llmDraft.provider === 'ollama'}
                    className="font-mono text-xs"
                  />
                  {llmConfig?.hasApiKey && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={clearLlmKey}
                      disabled={!networkAllowed}
                      title={t('settings.ai.key.removeTitle')}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span className="sr-only">{t('settings.ai.removeKey')}</span>
                    </Button>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => saveAiSettings()}
                    disabled={!networkAllowed || savingLlm || testingLlm}
                  >
                    {savingLlm ? t('settings.ai.saving') : t('settings.ai.save')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={testLlm}
                    disabled={!networkAllowed || testingLlm || savingLlm || !llmDraft.model.trim()}
                  >
                    {testingLlm ? t('settings.ai.test.testing') : t('settings.ai.test.label')}
                  </Button>
                </div>
                {llmTestResult && (
                  <span
                    className={`text-xs ${
                      llmTestResult.ok ? 'text-emerald-600' : 'text-destructive'
                    }`}
                  >
                    {llmTestResult.ok ? t('settings.ai.test.ok.short') : t('settings.ai.test.fail.short')}
                    {llmTestResult.message ? `: ${llmTestResult.message}` : ''}
                  </span>
                )}
              </div>

              <div className="space-y-2 rounded-md border bg-card px-3 py-3">
                <div className="text-xs font-medium text-muted-foreground">{t('settings.ai.featuresHeading')}</div>
                <FeatureToggleRow
                  checked={llmFeatures.search}
                  onChange={(v) => toggleFeature('search', v)}
                  disabled={!networkAllowed}
                  label={t('settings.ai.feature.searchLong')}
                />
                <FeatureToggleRow
                  checked={llmFeatures.recommend}
                  onChange={(v) => toggleFeature('recommend', v)}
                  disabled={!networkAllowed}
                  label={t('settings.ai.feature.recommendLong')}
                />
                <FeatureToggleRow
                  checked={llmFeatures.createSkill}
                  onChange={(v) => toggleFeature('createSkill', v)}
                  disabled={!networkAllowed}
                  label={t('settings.ai.feature.createSkillLong')}
                />
              </div>

              <div className="flex items-start gap-2 text-[11px] text-muted-foreground">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <p>
                  {t('settings.ai.security')}
                </p>
              </div>
            </div>
          </section>

          <Separator />

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">{t('settings.scan.lastHeader')}</h2>
              <Button variant="outline" size="sm" onClick={runScan} disabled={scanning}>
                <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${scanning ? 'animate-spin' : ''}`} />
                {scanning ? t('settings.scan.scanningNow') : t('settings.scan.rescanNow')}
              </Button>
            </div>
            {lastScan ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label={t('settings.scan.stat.totalFound')} value={lastScan.totalFound} />
                <Stat label={t('settings.scan.stat.new')} value={lastScan.newSkills} />
                <Stat label={t('settings.scan.stat.updated')} value={lastScan.updatedSkills} />
                <Stat label={t('settings.scan.stat.removed')} value={lastScan.removedSkills} />
                <Stat label={t('settings.scan.stat.duration')} value={`${lastScan.durationMs} ms`} />
                <Stat label={t('settings.scan.stat.errors')} value={lastScan.errors.length} tone={lastScan.errors.length ? 'warn' : undefined} />
                <Stat label={t('settings.scan.stat.finished')} value={formatRelative(lastScan.scannedAt)} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('settings.scan.none')}</p>
            )}
          </section>

          {lastScan && lastScan.errors.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-base font-semibold">{t('settings.scan.errorsHeader', { count: lastScan.errors.length })}</h2>
              {Array.from(errorsByKind.entries()).map(([kind, errors]) => (
                <details key={kind} className="rounded-md border bg-card">
                  <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm">
                    <ErrorIcon kind={kind} />
                    <span className="font-medium">{labelForKind(kind, t)}</span>
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
            <h2 className="text-base font-semibold">{t('settings.onboarding.rerun')}</h2>
            <p className="text-xs text-muted-foreground">{t('settings.onboarding.rerun.help')}</p>
            <div>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  // Re-running = clear the completion timestamp + send the user
                  // back to the workspace, where the wizard will re-mount.
                  await api.settings.set('onboarding_completed_at', '');
                  // Use replace so the back button doesn't return to settings.
                  window.location.assign('/');
                }}
              >
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                {t('settings.onboarding.rerun')}
              </Button>
            </div>
          </section>

          <Separator />

          <BackupsSection />

          <Separator />

          <section className="space-y-3">
            <h2 className="text-base font-semibold">{t('settings.stats.header')}</h2>
            {stats && (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <Stat label={t('settings.stats.skills')} value={stats.totalSkills} />
                <Stat label={t('settings.stats.scenarios')} value={stats.scenarios} />
                <Stat label={t('settings.stats.broken')} value={stats.brokenSymlinks} tone={stats.brokenSymlinks ? 'warn' : undefined} />
                <Stat label={t('settings.stats.duplicates')} value={stats.duplicates} tone={stats.duplicates ? 'warn' : undefined} />
                <Stat label={t('settings.stats.unscenarized')} value={stats.unscenarized} />
              </dl>
            )}
            {stats && (
              <p className="font-mono text-[10px] text-muted-foreground break-all">{t('settings.stats.dbPath', { path: stats.dbPath })}</p>
            )}
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}

function UpdateSection({
  currentVersion,
  update,
  checking,
  installing,
  installed,
  progress,
  error,
  onCheck,
  onInstall,
  onRelaunch,
}: {
  currentVersion: string;
  update: AppUpdateInfo | null;
  checking: boolean;
  installing: boolean;
  installed: boolean;
  progress: AppUpdateInstallProgress | null;
  error: string | null;
  onCheck: () => void;
  onInstall: () => void;
  onRelaunch: () => void;
}) {
  const t = useT();
  const progressLabel = progress
    ? progress.contentLength && progress.contentLength > 0
      ? `${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.contentLength)}`
      : formatBytes(progress.downloadedBytes)
    : null;
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Download className="h-4 w-4" />
            {t('settings.updates.header')}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('settings.updates.help')}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={onCheck} disabled={checking || installing}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} />
          {checking ? t('settings.updates.checking') : t('settings.updates.check')}
        </Button>
      </div>

      <div className="rounded-md border bg-card p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-medium">
            {t('settings.updates.currentVersion', {
              version: currentVersion || 'unknown',
            })}
          </div>
          {update?.available ? (
            <span className="rounded bg-emerald-100 px-2 py-0.5 text-[10px] uppercase tracking-wider text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
              {t('settings.updates.availableBadge')}
            </span>
          ) : update ? (
            <span className="rounded bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              {t('settings.updates.currentBadge')}
            </span>
          ) : null}
        </div>

        {update?.available && (
          <div className="mt-3 space-y-2">
            <div className="text-sm">
              {t('settings.updates.available', { version: update.version ?? '' })}
            </div>
            {update.body && (
              <pre className="max-h-32 overflow-auto rounded border bg-background p-2 whitespace-pre-wrap text-xs text-muted-foreground">
                {update.body}
              </pre>
            )}
            {progress && progressLabel && (
              <div className="text-xs text-muted-foreground">
                {progress.event === 'Finished'
                  ? t('settings.updates.downloadFinished')
                  : t('settings.updates.downloadProgress', { progress: progressLabel })}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={onInstall} disabled={installing || installed}>
                <Download className="mr-1.5 h-3.5 w-3.5" />
                {installing ? t('settings.updates.installing') : t('settings.updates.install')}
              </Button>
              {installed && (
                <Button size="sm" variant="outline" onClick={onRelaunch}>
                  <Power className="mr-1.5 h-3.5 w-3.5" />
                  {t('settings.updates.relaunch')}
                </Button>
              )}
            </div>
          </div>
        )}

        {update && !update.available && (
          <p className="mt-2 text-xs text-muted-foreground">
            {t('settings.updates.none')}
          </p>
        )}

        {error && (
          <p className="mt-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-950 dark:bg-amber-950/20 dark:text-amber-300">
            {t('settings.updates.error', { message: error })}
          </p>
        )}
      </div>
    </section>
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

/**
 * Backups: retention setting + on-demand cleanup. Wired to the cleanupBackups
 * IPC handler. The retention setting itself uses the generic settings:set IPC
 * so the value persists across launches and is read by the startup auto-sweep.
 */
function BackupsSection() {
  const t = useT();
  const [retentionDays, setRetentionDays] = useState<string>('30');
  const [cleaning, setCleaning] = useState(false);
  const [lastResult, setLastResult] = useState<{
    deletedDirs: number;
    deletedBytes: number;
    nulledRows: number;
    remainingBytes: number;
  } | null>(null);

  // Load the current setting on first mount (bridge-ready already by this section).
  useEffect(() => {
    if (typeof window === 'undefined' || !window.myskills) return;
    api.settings
      .get('backup_retention_days')
      .then((v) => v && setRetentionDays(v))
      .catch(() => {});
  }, []);

  const saveRetention = async (raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return;
    setRetentionDays(String(Math.floor(n)));
    await api.settings.set('backup_retention_days', String(Math.floor(n)));
  };

  const runCleanup = async () => {
    setCleaning(true);
    try {
      const r = await api.settings.cleanupBackups();
      setLastResult(r);
    } finally {
      setCleaning(false);
    }
  };

  return (
    <>
      <Separator />
      <section className="space-y-3">
        <h2 className="text-base font-semibold">{t('settings.section.backups')}</h2>
        <div className="flex items-center gap-3">
          <Label htmlFor="retention-days" className="shrink-0 text-sm">
            {t('settings.backups.retentionDays')}
          </Label>
          <input
            id="retention-days"
            type="number"
            min={0}
            max={3650}
            value={retentionDays}
            onChange={(e) => setRetentionDays(e.target.value)}
            onBlur={(e) => saveRetention(e.target.value)}
            className="h-8 w-20 rounded-md border border-input bg-background px-2 text-sm"
          />
          <button
            type="button"
            onClick={runCleanup}
            disabled={cleaning}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm transition-colors hover:bg-accent disabled:opacity-50"
          >
            {t('settings.backups.cleanup')}
          </button>
        </div>
        {lastResult && (
          <p className="text-xs text-muted-foreground">
            {t('settings.backups.cleanupResult', {
              deleted: lastResult.deletedDirs,
              bytes: formatBytes(lastResult.deletedBytes),
              remaining: formatBytes(lastResult.remainingBytes),
            })}
          </p>
        )}
      </section>
    </>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function shortHash(hash: string): string {
  if (hash.length <= 16) return hash;
  return `${hash.slice(0, 12)}…${hash.slice(-8)}`;
}

function ErrorIcon({ kind }: { kind: string }) {
  if (kind === 'broken_symlink') return <AlertTriangle className="h-3.5 w-3.5 text-destructive" />;
  if (kind === 'missing_frontmatter') return <FileWarning className="h-3.5 w-3.5 text-amber-600" />;
  if (kind === 'icloud_evicted') return <CloudOff className="h-3.5 w-3.5 text-blue-600" />;
  if (kind === 'too_large') return <FileX2 className="h-3.5 w-3.5 text-amber-600" />;
  return <FolderSearch className="h-3.5 w-3.5 text-muted-foreground" />;
}

function ToggleSwitch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 ${
        checked ? 'border-emerald-500 bg-emerald-500' : 'border-input bg-muted'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

function FeatureToggleRow({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-3 text-sm">
      <ToggleSwitch checked={checked} onChange={onChange} disabled={disabled} label={label} />
      <span className={disabled ? 'text-muted-foreground' : ''}>{label}</span>
    </label>
  );
}

function modelPlaceholder(provider: LlmProvider): string {
  switch (provider) {
    case 'openai':
      return 'gpt-4o-mini';
    case 'anthropic':
      return 'claude-haiku-4-5';
    case 'deepseek':
      return 'deepseek-v4-pro';
    case 'openrouter':
      return 'anthropic/claude-3.5-sonnet';
    case 'ollama':
      return 'llama3.1:8b';
    case 'custom':
      return 'your-model-id';
  }
}

function labelForKind(kind: string, t: ReturnType<typeof useT>): string {
  switch (kind) {
    case 'broken_symlink':
      return t('settings.scan.errorKind.broken_symlink');
    case 'missing_frontmatter':
      return t('settings.scan.errorKind.missing_frontmatter');
    case 'parse_error':
      return t('settings.scan.errorKind.parse_error');
    case 'unreadable':
      return t('settings.scan.errorKind.unreadable');
    case 'permission':
      return t('settings.scan.errorKind.permission');
    case 'icloud_evicted':
      return t('settings.scan.errorKind.icloud_evicted');
    case 'too_large':
      return t('settings.scan.errorKind.too_large');
    default:
      return kind;
  }
}
