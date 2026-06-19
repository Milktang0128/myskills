'use client';

/**
 * 翻译成中文 — read-only panel inside SkillDetail, sitting beside the
 * optimization check. Reads the skill's full SKILL.md from its canonical
 * location and asks the configured LLM to translate it into Simplified
 * Chinese, preserving Markdown + YAML frontmatter structure.
 *
 * Pure renderer feature: it reuses the existing `api.llm.chat` bridge, so
 * there are no backend, IPC, schema, or DB changes. The result is
 * preview-only — the SKILL.md file on disk is never written.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy as CopyIcon, Languages, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

const TRANSLATE_SYSTEM_PROMPT =
  'You are a professional technical translator. Translate the SKILL.md the user ' +
  'provides into Simplified Chinese. Preserve every Markdown structure, the YAML ' +
  'frontmatter keys, code blocks, inline code, file paths, URLs, command names, and ' +
  '{{placeholder}} tokens exactly — translate only the natural-language prose and the ' +
  'human-readable frontmatter values (e.g. description). Do not add explanations, ' +
  'notes, or a preamble; output only the translated document.';

function messageOf(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

export function SkillTranslate({
  skillId,
  locationId,
}: {
  skillId: string;
  /** Location whose SKILL.md is read for translation; null disables the run. */
  locationId: number | null;
}) {
  const t = useT();
  const [translated, setTranslated] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Reset when the panel switches to a different skill.
  useEffect(() => {
    setTranslated(null);
    setRunning(false);
    setError(null);
    setCopied(false);
  }, [skillId]);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      if (locationId == null) throw new Error(t('translate.error.noContent'));
      // Translate the FULL SKILL.md — skill.bodyExcerpt is only a preview slice.
      const { content } = await api.skills.readLocation(locationId);
      const md = content.trim();
      if (!md) throw new Error(t('translate.error.noContent'));
      const res = await api.llm.chat({
        messages: [
          { role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
          { role: 'user', content: md },
        ],
        temperature: 0.2,
        maxTokens: 8192,
      });
      setTranslated(res.text.trim());
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setRunning(false);
    }
  }

  function copy() {
    if (!translated) return;
    void navigator.clipboard
      .writeText(translated)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Languages className="h-3 w-3" aria-hidden="true" />
          {t('translate.heading')}
        </h3>
        {translated && !running && (
          <button
            onClick={copy}
            title={t('translate.copy')}
            aria-label={t('translate.copy')}
            className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {copied ? <Check className="h-3 w-3" /> : <CopyIcon className="h-3 w-3" />}
            {copied ? t('translate.copied') : t('translate.copy')}
          </button>
        )}
      </div>

      {error && (
        <div className="mb-2 flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      )}

      {running ? (
        <div className="flex items-center gap-2 rounded-md border bg-background p-3 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('translate.running')}
        </div>
      ) : !translated ? (
        <div className="rounded-md border bg-background p-3 text-xs">
          <p className="mb-2 text-muted-foreground">{t('translate.empty')}</p>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={() => void run()}
            disabled={locationId == null}
          >
            <Languages className="mr-1 h-3 w-3" />
            {t('translate.runBtn')}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="rounded-md bg-secondary/40 p-3">
            <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-relaxed">
              {translated}
            </pre>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-muted-foreground">{t('translate.previewNote')}</span>
            <button
              onClick={() => void run()}
              title={t('translate.rerun')}
              className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Languages className="h-3 w-3" />
              {t('translate.rerun')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
