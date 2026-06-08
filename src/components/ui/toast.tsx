'use client';

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/** Optional inline action on a toast (e.g. "Undo" after a safe-instant write). */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface Props {
  message: string;
  /** Default 4000ms. */
  durationMs?: number;
  /** Optional action button shown before the close affordance. */
  action?: ToastAction;
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
export function Toast({ message, durationMs = 4000, action, onDismiss }: Props) {
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
          'pointer-events-auto flex items-center gap-3 rounded-md border bg-card px-4 py-2 text-sm shadow-lg',
        )}
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        <span className="max-w-md">{message}</span>
        {action && (
          <button
            type="button"
            onClick={() => {
              action.onClick();
              onDismiss();
            }}
            className="shrink-0 rounded px-1.5 py-0.5 text-sm font-medium text-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {action.label}
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('common.close')}
          className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
