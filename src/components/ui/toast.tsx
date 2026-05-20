'use client';

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface Props {
  message: string;
  /** Default 4000ms. */
  durationMs?: number;
  onDismiss: () => void;
}

/**
 * Bottom-center toast notification.
 *
 * Accessibility:
 *   - role="status" + aria-live="polite" so screen readers announce updates
 *     without interrupting (use aria-live="assertive" for critical errors,
 *     not currently exposed).
 *   - Explicit close button — keyboard users can't reach a click-to-dismiss
 *     region otherwise.
 *
 * Behavior:
 *   - Auto-dismisses after durationMs.
 *   - Hovering the toast pauses the timer; leaving resumes from the same
 *     elapsed time so the message doesn't fly away while you're trying to
 *     read it.
 *   - A new `message` prop resets the timer (useful for back-to-back toasts).
 */
export function Toast({ message, durationMs = 4000, onDismiss }: Props) {
  const t = useT();
  const [paused, setPaused] = useState(false);
  // Track elapsed time so hover-pause preserves how long we've been visible.
  const elapsedRef = useRef(0);
  const lastTickRef = useRef<number>(Date.now());

  useEffect(() => {
    elapsedRef.current = 0;
    lastTickRef.current = Date.now();
  }, [message]);

  useEffect(() => {
    if (paused) return;
    lastTickRef.current = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      elapsedRef.current += now - lastTickRef.current;
      lastTickRef.current = now;
      if (elapsedRef.current >= durationMs) onDismiss();
    }, 100);
    return () => clearInterval(id);
  }, [paused, durationMs, message, onDismiss]);

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center"
      role="status"
      aria-live="polite"
    >
      <div
        className={cn(
          'pointer-events-auto flex items-center gap-3 border border-ink bg-paper-white px-4 py-2.5 text-[13px] text-ink',
        )}
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        <span className="max-w-md">{message}</span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('common.close')}
          className="inline-flex h-5 w-5 items-center justify-center text-mute hover:bg-paper-alt hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink"
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
