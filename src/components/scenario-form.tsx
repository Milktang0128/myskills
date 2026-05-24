'use client';

import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { Scenario } from '@shared/types';
import { slugify } from '@shared/slug';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

const PALETTE = ['#3B82F6', '#10B981', '#F59E0B', '#EC4899', '#8B5CF6', '#6366F1', '#EF4444', '#14B8A6'];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scenario?: Scenario | null;
  onSaved: () => void;
  /**
   * Optional shortcut to AI Lens. When provided (caller decides — e.g. only
   * when the user has zero scenarios), renders a left-aligned secondary
   * button in the footer that closes this dialog and opens AI Lens instead.
   * Edit mode hides it regardless.
   */
  onOpenAiLens?: () => void;
}

export function ScenarioForm({ open, onOpenChange, scenario, onSaved, onOpenAiLens }: Props) {
  const t = useT();
  const editing = !!scenario;
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(PALETTE[0]!);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Tracks whether the user has manually edited the key field. If they haven't,
  // we keep deriving it from `name`. Without this ref the prior implementation
  // would lock in after the first character of `name` was typed.
  const keyManuallyEdited = useRef(false);

  useEffect(() => {
    if (!open) return;
    setName(scenario?.name ?? '');
    setKey(scenario?.key ?? '');
    setDescription(scenario?.description ?? '');
    setColor(scenario?.color ?? PALETTE[0]!);
    setError(null);
    keyManuallyEdited.current = !!scenario; // editing → treat as manually set
  }, [open, scenario]);

  // Auto-slug from name unless the user has typed in the key field themselves.
  // Uses the same slugify as the server to avoid client-only invalid keys.
  useEffect(() => {
    if (editing) return;
    if (keyManuallyEdited.current) return;
    setKey(slugify(name));
  }, [name, editing]);

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      if (editing && scenario) {
        await api.scenarios.update({ id: scenario.id, name, description, color });
      } else {
        await api.scenarios.create({ name, key, description, color });
      }
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? t('scenarios.form.edit.title') : t('scenarios.form.create.title')}</DialogTitle>
          <DialogDescription>
            {t('scenarioForm.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="sc-name">{t('scenarios.form.name')}</Label>
            <Input id="sc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('scenarioForm.name.placeholder')} autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sc-key">{t('scenarios.form.key')}</Label>
            <Input
              id="sc-key"
              value={key}
              onChange={(e) => {
                keyManuallyEdited.current = true;
                setKey(e.target.value);
              }}
              placeholder={t('scenarioForm.key.placeholder')}
              disabled={editing}
              className="font-mono text-xs"
            />
            {editing && <p className="text-[10px] text-muted-foreground">{t('scenarioForm.key.immutable')}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sc-desc">{t('scenarioForm.description.optional')}</Label>
            <Input id="sc-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('scenarios.form.color')}</Label>
            <div className="flex flex-wrap gap-1.5">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={`h-6 w-6 rounded-full border-2 transition-transform ${color === c ? 'border-foreground scale-110' : 'border-transparent'}`}
                  style={{ backgroundColor: c }}
                  aria-label={t('scenarioForm.color.aria', { value: c })}
                />
              ))}
            </div>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter className={onOpenAiLens && !editing ? 'sm:justify-between' : undefined}>
          {onOpenAiLens && !editing && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onOpenChange(false);
                onOpenAiLens();
              }}
              disabled={submitting}
              title={t('scenarioForm.aiLens.hint')}
              className="gap-1.5"
            >
              <Sparkles className="h-3.5 w-3.5 text-violet-500" />
              {t('scenarioForm.aiLens.cta')}
            </Button>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              {t('common.cancel')}
            </Button>
            <Button onClick={submit} disabled={submitting || !name.trim()}>
              {submitting ? t('scenarioForm.saving') : editing ? t('common.save') : t('scenarioForm.create')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
