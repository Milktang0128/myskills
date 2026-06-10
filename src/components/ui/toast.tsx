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

export interface ToastData {
  id: number;
  message: string;
  action?: ToastAction;
  durationMs?: number;
}

/**
 * Bottom-center toast stack.
 *
 * Why a stack (max 3) instead of a single slot: back-to-back operations used
 * to overwrite each other instantly — an "applied, 2 failed" summary followed
 * by an undo toast left the user under 1s to notice the failures, and the
 * 6s undo window itself died the moment any other toast fired.
 *
 * Accessibility:
 *   - The viewport (role="status" + aria-live="polite") is ALWAYS mounted —
 *     a live region that appears together with its first message is not
 *     announced by screen readers.
 *   - Explicit close button per toast; hovering OR focusing a toast (its
 *     action/close button) pauses the auto-dismiss timer.
 */
export function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastData[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={() => onDismiss(toast.id)} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: ToastData; onDismiss: () => void }) {
  const t = useT();
  const durationMs = toast.durationMs ?? 4000;
  const [paused, setPaused] = useState(false);
  // Track elapsed time so hover/focus-pause preserves how long we've been visible.
  const elapsedRef = useRef(0);
  const lastTickRef = useRef<number>(Date.now());

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
  }, [paused, durationMs, onDismiss]);

  return (
    <div
      className={cn(
        'pointer-events-auto flex items-center gap-3 rounded-md border bg-card px-4 py-2 text-sm shadow-lg',
      )}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => {
        // Resume only when focus leaves the toast entirely (not when moving
        // between the action and close buttons).
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaused(false);
      }}
    >
      <span className="max-w-md">{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action!.onClick();
            onDismiss();
          }}
          className="shrink-0 rounded px-1.5 py-0.5 text-sm font-medium text-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {toast.action.label}
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
  );
}
