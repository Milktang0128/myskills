'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Pencil, Plus, Trash2, Download, Upload } from 'lucide-react';
import type { Scenario, ScenarioExport, ScenarioImportResult, Skill } from '@shared/types';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ScenarioForm } from '@/components/scenario-form';
import { ScenarioRecommendations } from '@/components/scenario-recommendations';
import { alertAction, confirmAction } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export default function ScenariosPage() {
  const t = useT();
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Scenario | null>(null);
  const [importResult, setImportResult] = useState<ScenarioImportResult | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedSkills, setSelectedSkills] = useState<Skill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);

  const refresh = useCallback(async () => {
    setScenarios(await api.scenarios.list());
  }, []);

  // Reload installed skills whenever the selected scenario changes.
  const loadSelectedSkills = useCallback(async (scenarioId: number) => {
    setSkillsLoading(true);
    try {
      const skills = await api.skills.list({ scenarioId });
      setSelectedSkills(skills);
    } finally {
      setSkillsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId == null) {
      setSelectedSkills([]);
      return;
    }
    loadSelectedSkills(selectedId);
  }, [selectedId, loadSelectedSkills]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const iv = setInterval(() => {
      if (window.myskills) {
        refresh();
        clearInterval(iv);
      }
    }, 50);
    return () => clearInterval(iv);
  }, [refresh]);

  const handleDelete = async (sc: Scenario) => {
    if (sc.isBuiltin) return;
    const ok = await confirmAction({
      title: t('scenarios.delete.confirmShort', { name: sc.name }),
      tone: 'destructive',
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) return;
    await api.scenarios.remove(sc.id);
    await refresh();
  };

  const handleExport = async () => {
    const data = await api.scenarios.export();
    downloadJson(`myskills-scenarios-${new Date().toISOString().slice(0, 10)}.json`, data);
  };

  const handleImport = async () => {
    const file = await pickFile();
    if (!file) return;
    const text = await file.text();
    let parsed: ScenarioExport;
    try {
      parsed = JSON.parse(text) as ScenarioExport;
    } catch {
      await alertAction({
        title: t('scenarios.import.invalidJson'),
        tone: 'destructive',
        okLabel: t('common.ok'),
      });
      return;
    }
    try {
      const result = await api.scenarios.import(parsed);
      setImportResult(result);
      await refresh();
    } catch (e) {
      await alertAction({
        title: t('scenarios.import.failed', {
          message: e instanceof Error ? e.message : String(e),
        }),
        tone: 'destructive',
        okLabel: t('common.ok'),
      });
    }
  };

  return (
    <main className="flex h-screen w-screen flex-col overflow-hidden bg-paper">
      <header className="titlebar-drag flex h-11 shrink-0 items-center justify-between border-b border-rule pl-[88px] pr-4">
        <div className="titlebar-no-drag flex items-center gap-2">
          <Link
            href="/"
            className="inline-flex h-6 w-6 items-center justify-center text-mute hover:text-ink"
            aria-label={t('scenarios.back')}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </Link>
          <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase leading-none tracking-[var(--widest)] font-semibold">
            <span className="text-red-brand">MYSKILLS</span>
            <span className="text-mute">·</span>
            <span className="text-ink">{t('scenarios.title')}</span>
          </div>
        </div>
        <div className="titlebar-no-drag flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleImport}>
            <Upload className="mr-1.5 h-3 w-3" /> {t('scenarios.btn.import')}
          </Button>
          <Button variant="outline" size="sm" onClick={handleExport}>
            <Download className="mr-1.5 h-3 w-3" /> {t('scenarios.btn.export')}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <Plus className="mr-1.5 h-3 w-3" /> {t('scenarios.btn.new')}
          </Button>
        </div>
      </header>

      {importResult && (
        <div className="border-b border-rule bg-paper-alt/40 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.06em] text-soft">
          {t('scenarios.import.summary.short', {
            created: importResult.scenariosCreated,
            merged: importResult.scenariosMerged,
            linked: importResult.skillsLinked,
          })}
          {importResult.skillsNotFound.length > 0 && (
            <span className="ml-2 text-mute">
              {t('scenarios.import.notFound', { count: importResult.skillsNotFound.length })}
            </span>
          )}
          <button
            className="ml-3 underline-offset-2 text-mute hover:text-ink hover:underline normal-case"
            onClick={() => setImportResult(null)}
          >
            {t('scenarios.import.dismiss')}
          </button>
        </div>
      )}

      <ScrollArea className="flex-1 scrollbar-thin">
        {/* Editorial grid: 2-column borderless cards separated by hairline
            rules. No card chrome — paper-alt wash on hover, red rail on
            select. Matches prototype's `.scn-grid` / `.scn-card`. */}
        <div className="grid border-t border-rule sm:grid-cols-2">
          {scenarios.map((sc) => {
            const isSelected = selectedId === sc.id;
            return (
              <div
                key={sc.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedId((cur) => (cur === sc.id ? null : sc.id))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelectedId((cur) => (cur === sc.id ? null : sc.id));
                  }
                }}
                className={cn(
                  'cursor-pointer border-r border-b border-rule p-6 transition-colors',
                  'hover:bg-paper-alt/60',
                  isSelected && 'bg-[rgba(225,70,43,0.06)]',
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: sc.color ?? '#888' }}
                    />
                    <h2 className="t-cn text-[20px] truncate leading-tight" title={sc.name}>{sc.name}</h2>
                    {sc.isBuiltin && (
                      <span className="border border-rule px-1.5 py-0.5 font-mono text-[9.5px] uppercase leading-none tracking-[0.06em] text-mute shrink-0">
                        {t('scenarios.builtin')}
                      </span>
                    )}
                  </div>
                  <div className="flex gap-0.5 shrink-0">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing(sc);
                        setFormOpen(true);
                      }}
                      className="inline-flex h-6 w-6 items-center justify-center text-mute hover:bg-paper-alt hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink"
                      aria-label={t('scenarios.edit.aria')}
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    {!sc.isBuiltin && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(sc);
                        }}
                        className="inline-flex h-6 w-6 items-center justify-center text-mute hover:bg-[rgba(225,70,43,0.1)] hover:text-red-brand focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-brand"
                        aria-label={t('scenarios.delete.aria')}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </div>
                <p className="mt-1.5 font-mono text-[10px] uppercase leading-none tracking-[var(--wide)] text-mute">{sc.key}</p>
                {sc.description && <p className="mt-3 text-[12.5px] leading-[1.55] text-soft">{sc.description}</p>}
                <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.06em] text-red-brand tabular-nums">
                  {sc.skillCount ?? 0}
                  <span className="ml-1.5 text-mute">{t('scenarios.skillCount', { count: sc.skillCount ?? 0 })}</span>
                </p>
              </div>
            );
          })}
        </div>

        {selectedId != null && (() => {
          const sc = scenarios.find((s) => s.id === selectedId);
          if (!sc) return null;
          return (
            <div className="border-t border-rule bg-paper-panel px-7 py-6">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: sc.color ?? '#888' }}
                    />
                    <h2 className="t-cn text-[22px]">{sc.name}</h2>
                  </div>
                  {sc.description && (
                    <p className="mt-2 text-[12.5px] leading-[1.55] text-soft">{sc.description}</p>
                  )}
                </div>
                <button
                  className="font-mono text-[10px] uppercase tracking-[var(--wide)] text-mute hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink"
                  onClick={() => setSelectedId(null)}
                >
                  {t('scenarios.detail.close')}
                </button>
              </div>

              <section className="mb-6">
                <div className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[var(--widest)] text-ink">
                  {t('scenarios.detail.skillsHeading', { count: selectedSkills.length })}
                </div>
                {skillsLoading ? (
                  <p className="font-mono text-[10px] uppercase tracking-[0.06em] text-mute">{t('scenarios.detail.skillsLoading')}</p>
                ) : selectedSkills.length === 0 ? (
                  <p className="font-mono text-[10px] uppercase tracking-[0.06em] text-mute">
                    {t('scenarios.detail.skillsEmpty')}
                  </p>
                ) : (
                  <ul className="flex flex-wrap gap-1.5">
                    {selectedSkills.map((s) => (
                      <li
                        key={s.id}
                        className="border border-rule bg-paper-white px-2 py-1 text-[12px]"
                        title={s.description ?? undefined}
                      >
                        {s.name}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <ScenarioRecommendations
                scenario={sc}
                installedSkills={selectedSkills}
                onInstalled={() => {
                  // Refresh skill counts on the cards and the installed list.
                  refresh();
                  loadSelectedSkills(sc.id);
                }}
              />
            </div>
          );
        })()}
      </ScrollArea>

      <ScenarioForm
        open={formOpen}
        onOpenChange={setFormOpen}
        scenario={editing}
        onSaved={refresh}
      />
    </main>
  );
}

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pickFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const f = input.files?.[0] ?? null;
      resolve(f);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
