'use client';

/**
 * Scenarios management — workspace view (peer of CoverageView).
 *
 * Page-level header handles the title. Import/Export/New buttons sit in a
 * sub-toolbar above the grid (mirroring the CoverageView filter row).
 * Grid widens back to 3 columns at lg now that the view owns the full
 * main area.
 *
 * onChanged fires whenever the scenarios list mutates, so the workspace
 * can refresh sidebar counts.
 */
import { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, Trash2, Download, Upload } from 'lucide-react';
import type { Scenario, ScenarioExport, ScenarioImportResult, Skill } from '@shared/types';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ScenarioForm } from '@/components/scenario-form';
import { ScenarioRecommendations } from '@/components/scenario-recommendations';
import { alertAction, confirmAction } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface Props {
  /** Called whenever the scenarios list changes — workspace refreshes sidebar counts. */
  onChanged: () => void;
}

export function ScenariosView({ onChanged }: Props) {
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
    onChanged();
  }, [onChanged]);

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
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Sub-toolbar: import / export / new. Mirrors CoverageView's filter row
          position so the user finds primary actions in the same place across
          views. */}
      <div className="flex items-center gap-1.5 px-6 pb-3 pt-3">
        <Button variant="outline" size="sm" onClick={handleImport}>
          <Upload className="mr-1.5 h-3.5 w-3.5" /> {t('scenarios.btn.import')}
        </Button>
        <Button variant="outline" size="sm" onClick={handleExport}>
          <Download className="mr-1.5 h-3.5 w-3.5" /> {t('scenarios.btn.export')}
        </Button>
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" /> {t('scenarios.btn.new')}
        </Button>
      </div>

      {importResult && (
        <div className="border-y bg-secondary/40 px-6 py-2 text-xs">
          {t('scenarios.import.summary.short', {
            created: importResult.scenariosCreated,
            merged: importResult.scenariosMerged,
            linked: importResult.skillsLinked,
          })}
          {importResult.skillsNotFound.length > 0 && (
            <span className="ml-2 text-muted-foreground">
              {t('scenarios.import.notFound', { count: importResult.skillsNotFound.length })}
            </span>
          )}
          <button
            className="ml-3 text-muted-foreground hover:text-foreground"
            onClick={() => setImportResult(null)}
          >
            {t('scenarios.import.dismiss')}
          </button>
        </div>
      )}

      <ScrollArea className="flex-1 scrollbar-thin">
        <div className="grid gap-3 p-6 sm:grid-cols-2 lg:grid-cols-3">
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
                  'cursor-pointer border bg-card p-4 transition-colors',
                  'hover:border-foreground/20 hover:bg-accent/30',
                  isSelected && 'border-primary/60 bg-accent/40 ring-1 ring-primary/20',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="inline-block h-3 w-3 shrink-0 rounded-full"
                      style={{ backgroundColor: sc.color ?? '#888' }}
                    />
                    <h3 className="truncate text-sm font-semibold">{sc.name}</h3>
                    {sc.isBuiltin && (
                      <span className="shrink-0 bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {t('scenarios.builtin')}
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing(sc);
                        setFormOpen(true);
                      }}
                      className="p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                      aria-label={t('scenarios.edit.aria')}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    {!sc.isBuiltin && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(sc);
                        }}
                        className="p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        aria-label={t('scenarios.delete.aria')}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
                <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{sc.key}</p>
                {sc.description && (
                  <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{sc.description}</p>
                )}
                <p className="mt-3 text-xs text-muted-foreground">
                  {t('scenarios.skillCount', { count: sc.skillCount ?? 0 })}
                </p>
              </div>
            );
          })}
        </div>

        {selectedId != null &&
          (() => {
            const sc = scenarios.find((s) => s.id === selectedId);
            if (!sc) return null;
            return (
              <div className="border-t bg-secondary/20 px-6 py-6">
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-block h-3 w-3 rounded-full"
                        style={{ backgroundColor: sc.color ?? '#888' }}
                      />
                      <h3 className="text-base font-semibold">{sc.name}</h3>
                    </div>
                    {sc.description && (
                      <p className="mt-1 text-xs text-muted-foreground">{sc.description}</p>
                    )}
                  </div>
                  <button
                    className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setSelectedId(null)}
                  >
                    {t('scenarios.detail.close')}
                  </button>
                </div>

                <section className="mb-6 space-y-2">
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('scenarios.detail.skillsHeading', { count: selectedSkills.length })}
                  </div>
                  {skillsLoading ? (
                    <p className="text-xs text-muted-foreground">
                      {t('scenarios.detail.skillsLoading')}
                    </p>
                  ) : selectedSkills.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {t('scenarios.detail.skillsEmpty')}
                    </p>
                  ) : (
                    <ul className="flex flex-wrap gap-1.5">
                      {selectedSkills.map((s) => (
                        <li
                          key={s.id}
                          className="bg-background px-2 py-1 text-xs"
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
    </div>
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
