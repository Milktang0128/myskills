'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Pencil, Plus, Trash2, Download, Upload } from 'lucide-react';
import type { Scenario, ScenarioExport, ScenarioImportResult } from '@shared/types';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ScenarioForm } from '@/components/scenario-form';
import { api } from '@/lib/api';

export default function ScenariosPage() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Scenario | null>(null);
  const [importResult, setImportResult] = useState<ScenarioImportResult | null>(null);

  const refresh = useCallback(async () => {
    setScenarios(await api.scenarios.list());
  }, []);

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
    if (!confirm(`Delete scenario "${sc.name}"? Skills will be unlinked but not deleted.`)) return;
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
      alert('Invalid JSON');
      return;
    }
    try {
      const result = await api.scenarios.import(parsed);
      setImportResult(result);
      await refresh();
    } catch (e) {
      alert(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <main className="flex h-screen w-screen flex-col overflow-hidden">
      <header className="titlebar-drag flex h-12 shrink-0 items-center justify-between border-b pl-[88px] pr-4">
        <div className="titlebar-no-drag flex items-center gap-2">
          <Link
            href="/"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-accent"
            aria-label="Back"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <h1 className="text-sm font-semibold">Scenarios</h1>
        </div>
        <div className="titlebar-no-drag flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleImport}>
            <Upload className="mr-1.5 h-3.5 w-3.5" /> Import
          </Button>
          <Button variant="outline" size="sm" onClick={handleExport}>
            <Download className="mr-1.5 h-3.5 w-3.5" /> Export
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" /> New
          </Button>
        </div>
      </header>

      {importResult && (
        <div className="border-b bg-secondary/40 px-4 py-2 text-xs">
          Imported: {importResult.scenariosCreated} new, {importResult.scenariosMerged} merged, {importResult.skillsLinked} skills linked
          {importResult.skillsNotFound.length > 0 && (
            <span className="ml-2 text-muted-foreground">
              ({importResult.skillsNotFound.length} skills not found locally)
            </span>
          )}
          <button
            className="ml-3 text-muted-foreground hover:text-foreground"
            onClick={() => setImportResult(null)}
          >
            dismiss
          </button>
        </div>
      )}

      <ScrollArea className="flex-1 scrollbar-thin">
        <div className="grid gap-3 p-6 sm:grid-cols-2 lg:grid-cols-3">
          {scenarios.map((sc) => (
            <div key={sc.id} className="rounded-lg border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block h-3 w-3 rounded-full"
                    style={{ backgroundColor: sc.color ?? '#888' }}
                  />
                  <h2 className="text-sm font-semibold">{sc.name}</h2>
                  {sc.isBuiltin && (
                    <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      built-in
                    </span>
                  )}
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => {
                      setEditing(sc);
                      setFormOpen(true);
                    }}
                    className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    aria-label="Edit"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  {!sc.isBuiltin && (
                    <button
                      onClick={() => handleDelete(sc)}
                      className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      aria-label="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
              <p className="mt-1 font-mono text-[10px] text-muted-foreground">{sc.key}</p>
              {sc.description && <p className="mt-2 text-xs text-muted-foreground">{sc.description}</p>}
              <p className="mt-3 text-xs text-muted-foreground">{sc.skillCount ?? 0} skills</p>
            </div>
          ))}
        </div>
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
