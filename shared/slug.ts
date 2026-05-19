/**
 * Single source of truth for scenario key generation, used by both the
 * client form and the server-side scenarios IPC handler.
 *
 * Rules:
 *   - Lowercase, NFC normalized.
 *   - Whitespace and slashes (`/` `\`) collapse to `-`.
 *   - Leading/trailing dashes stripped.
 *   - Truncated to 64 chars.
 *   - Allowed in result: unicode letters/numbers, `_`, `-`.
 *
 * `isValidKey` accepts any string that survives slugify *plus* an
 * additional check that the first char is a letter/number.
 */

export function slugify(input: string): string {
  return input
    .normalize('NFC')
    .toLowerCase()
    .trim()
    .replace(/[\s/\\]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 64);
}

export function isValidKey(s: string): boolean {
  return /^[\p{Letter}\p{Number}][\p{Letter}\p{Number}_-]{0,63}$/u.test(s);
}
