/**
 * Shared status-color vocabulary for sync/coverage state across the app.
 *
 * One place to keep the light AND dark variants in lockstep — the matrix
 * glyphs, legend, sync-confirm rows, detail-panel location status, and the
 * sidebar scan dot must all mean the same thing with the same color. Raw
 * `text-emerald-600`-style classes scattered per-component kept drifting
 * (several spots shipped without a `dark:` companion, dropping contrast to
 * ~3:1 on the dark canvas).
 *
 * Semantics (keep this mapping stable):
 *   ok     — in sync / enabled / success
 *   link   — healthy synced copy (symlink onto the source)
 *   warn   — stale / diverged / needs a human decision (the ONLY amber)
 *   danger — broken / failed
 *   muted  — disabled / inert
 */
export const STATUS_TONE = {
  ok: 'text-emerald-600 dark:text-emerald-400',
  link: 'text-blue-600 dark:text-blue-400',
  warn: 'text-amber-600 dark:text-amber-400',
  /** Slightly heavier amber used for misdirected-link glyphs on light bg. */
  warnStrong: 'text-amber-700 dark:text-amber-400',
  danger: 'text-destructive',
  muted: 'text-muted-foreground',
} as const;

export type StatusTone = keyof typeof STATUS_TONE;
