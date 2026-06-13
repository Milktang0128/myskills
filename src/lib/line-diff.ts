/**
 * Minimal LCS line diff for the optimization confirm view. We render the
 * proposed SKILL.md against its baseline so the user sees exactly what one
 * fix changes before it lands. Not a general-purpose diff — just enough to
 * mark added / removed / unchanged lines.
 */

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string };

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;

  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: 'del', text: a[i] });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ kind: 'del', text: a[i++] });
  while (j < m) out.push({ kind: 'add', text: b[j++] });
  return out;
}

/** Collapse long runs of unchanged lines to keep the diff readable. */
export function collapseContext(lines: DiffLine[], context = 3): (DiffLine | { kind: 'gap'; count: number })[] {
  const changed = lines.map((l) => l.kind !== 'same');
  const keep = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (changed[i]) {
      for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) {
        keep[k] = true;
      }
    }
  }
  const out: (DiffLine | { kind: 'gap'; count: number })[] = [];
  let gap = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (gap > 0) {
        out.push({ kind: 'gap', count: gap });
        gap = 0;
      }
      out.push(lines[i]);
    } else {
      gap++;
    }
  }
  if (gap > 0) out.push({ kind: 'gap', count: gap });
  return out;
}
