'use client';

/**
 * Promise-based confirmation dialog.
 *
 * Replaces native window.confirm() / alert() everywhere. Two motivations:
 *
 *   1. Safety: native confirm on macOS focuses OK by default — a stray
 *      Enter after triggering a destructive action (delete platform,
 *      rollback sync, drop DB) deletes data immediately. This primitive
 *      focuses Cancel by default for `tone="destructive"`.
 *
 *   2. Style: native dialogs ignore our theme + i18n styling and look
 *      out-of-place inside an Electron renderer.
 *
 * Usage:
 *
 *   const ok = await confirmAction({
 *     title: 'Delete scenario "Writing"?',
 *     description: 'Linked skills stay; only the scenario is removed.',
 *     tone: 'destructive',
 *     confirmLabel: 'Delete',
 *   });
 *   if (!ok) return;
 *   await api.scenarios.remove(id);
 *
 * The component renders into a portal; the host page renders <ConfirmHost/>
 * once near the root. No prop drilling, single global queue, one dialog at
 * a time (concurrent requests are sequenced — uncommon for confirm flows).
 */
import { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ConfirmOptions {
  title: string;
  description?: string;
  /** Default: 'default'. 'destructive' tints the confirm button + focuses Cancel. */
  tone?: 'default' | 'destructive';
  /** Default: i18n's common.confirm or 'Confirm'. */
  confirmLabel?: string;
  /** Default: i18n's common.cancel or 'Cancel'. */
  cancelLabel?: string;
}

export interface AlertOptions {
  title: string;
  description?: string;
  /** Default: 'default'. 'destructive' colors the title/icon. */
  tone?: 'default' | 'destructive';
  /** Default: i18n's common.ok or 'OK'. */
  okLabel?: string;
}

interface PendingRequest extends ConfirmOptions {
  /** When true, render only the confirm button (alert variant). */
  alertOnly?: boolean;
  resolve: (ok: boolean) => void;
}

let pushRequest: ((req: PendingRequest) => void) | null = null;

/** Programmatic API used by callers. Mounts a single ConfirmHost somewhere. */
export function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (!pushRequest) {
      // Safety fallback if ConfirmHost wasn't mounted — degrade to native
      // confirm so the action still gates somehow.
      const ok = window.confirm(
        opts.description ? `${opts.title}\n\n${opts.description}` : opts.title,
      );
      resolve(ok);
      return;
    }
    pushRequest({ ...opts, resolve });
  });
}

/** OK-only notification dialog. Replaces native window.alert. */
export function alertAction(opts: AlertOptions): Promise<void> {
  return new Promise((resolve) => {
    if (!pushRequest) {
      window.alert(opts.description ? `${opts.title}\n\n${opts.description}` : opts.title);
      resolve();
      return;
    }
    pushRequest({
      title: opts.title,
      description: opts.description,
      tone: opts.tone,
      confirmLabel: opts.okLabel ?? 'OK',
      alertOnly: true,
      resolve: () => resolve(),
    });
  });
}

/**
 * Mount once near the workspace root. Subscribes to the module-level push
 * function and renders one dialog at a time, queuing further requests
 * until the current one resolves.
 */
export function ConfirmHost() {
  const [current, setCurrent] = useState<PendingRequest | null>(null);
  const queueRef = useRef<PendingRequest[]>([]);
  // Focus Cancel by default — destructive ops should require a deliberate
  // mouse click / Tab+Enter to confirm.
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    pushRequest = (req) => {
      if (current) {
        queueRef.current.push(req);
      } else {
        setCurrent(req);
      }
    };
    return () => {
      if (pushRequest) pushRequest = null;
    };
  }, [current]);

  function done(ok: boolean) {
    if (current) current.resolve(ok);
    const next = queueRef.current.shift() ?? null;
    setCurrent(next);
  }

  // Auto-focus Cancel when a request becomes active. Stops Enter-after-
  // trigger from accidentally confirming. For alert-only dialogs there is no
  // Cancel button, so we focus the OK button instead.
  const okButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!current) return;
    const target = current.alertOnly ? okButtonRef : cancelButtonRef;
    // Microtask so Radix has time to mount the dialog content.
    const id = setTimeout(() => target.current?.focus(), 30);
    return () => clearTimeout(id);
  }, [current]);

  if (!current) return null;
  const tone = current.tone ?? 'default';
  const isDestructive = tone === 'destructive';
  const isAlert = !!current.alertOnly;
  return (
    <Dialog open onOpenChange={(o) => !o && done(false)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className={cn(isAlert && isDestructive && 'text-destructive')}>
            {current.title}
          </DialogTitle>
          {current.description && (
            <DialogDescription>{current.description}</DialogDescription>
          )}
        </DialogHeader>
        <DialogFooter>
          {!isAlert && (
            <Button
              ref={cancelButtonRef}
              variant="outline"
              onClick={() => done(false)}
            >
              {current.cancelLabel ?? 'Cancel'}
            </Button>
          )}
          <Button
            ref={okButtonRef}
            variant={!isAlert && isDestructive ? 'destructive' : 'default'}
            onClick={() => done(true)}
            className={cn(!isAlert && isDestructive && 'bg-destructive hover:bg-destructive/90')}
          >
            {current.confirmLabel ?? 'Confirm'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
