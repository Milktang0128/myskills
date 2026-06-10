'use client';

/**
 * Day-0 guidance banner pointing the user at AI Lens. Surfaces in the
 * library shell (above list AND kanban) when the user has many unscenarized
 * skills and hasn't run AI Lens yet. Once a cached overview exists, the
 * banner self-retires — AI Lens is a one-shot bootstrap tool, not a daily
 * driver.
 *
 * Page-level conditions are evaluated in app/page.tsx; this component only
 * renders its own visual.
 */
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n';

export const UNSCENARIZED_GUIDANCE_THRESHOLD = 0.8;

export function LibraryOverviewGuidance({
  total,
  unscenarized,
  onOpenAiLens,
}: {
  total: number;
  unscenarized: number;
  onOpenAiLens: () => void;
}) {
  const t = useT();
  return (
    <div className="border-b bg-violet-50/50 px-6 py-3 dark:bg-violet-950/20">
      <div className="flex items-start gap-3">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-violet-500" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-foreground">
            {t('kanban.empty.guidance.title')}
          </p>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {t('kanban.empty.guidance.body', { unscenarized, total })}
          </p>
        </div>
        <Button variant="ai" onClick={onOpenAiLens} className="h-7 shrink-0 gap-1.5 px-3 text-[12px]">
          <Sparkles className="h-3.5 w-3.5" />
          {t('kanban.empty.guidance.cta')}
        </Button>
      </div>
    </div>
  );
}
