import * as fs from 'node:fs';
import * as path from 'node:path';
import matter from 'gray-matter';
import { createHash } from 'node:crypto';

export interface ParsedSkill {
  name: string;
  description: string | null;
  version: string | null;
  author: string | null;
  license: string | null;
  bodyExcerpt: string | null;
  contentHash: string;
  sizeBytes: number;
  fileCount: number;
}

export class SkillParseError extends Error {
  constructor(public kind: 'missing_frontmatter' | 'parse_error' | 'unreadable', msg: string) {
    super(msg);
  }
}

const SKILL_MD = 'SKILL.md';
const EXCERPT_CHARS = 500;

/**
 * Parse a skill directory. Returns null if the directory is not a skill
 * (no SKILL.md), throws SkillParseError for malformed skills.
 */
export function parseSkill(skillDir: string): ParsedSkill | null {
  const skillMdPath = path.join(skillDir, SKILL_MD);
  let raw: string;
  try {
    const stat = fs.statSync(skillMdPath);
    if (!stat.isFile()) return null;
    raw = fs.readFileSync(skillMdPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new SkillParseError('unreadable', `cannot read ${skillMdPath}: ${(err as Error).message}`);
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (err) {
    throw new SkillParseError('parse_error', `invalid frontmatter: ${(err as Error).message}`);
  }

  const fm = (parsed.data ?? {}) as Record<string, unknown>;
  const name = typeof fm.name === 'string' && fm.name.trim().length > 0 ? fm.name.trim() : null;
  if (!name) {
    throw new SkillParseError('missing_frontmatter', `SKILL.md at ${skillDir} is missing required "name" field`);
  }

  const body = parsed.content ?? '';
  const excerpt = body.slice(0, EXCERPT_CHARS).trim() || null;
  const contentHash = createHash('sha256').update(raw).digest('hex');

  const metadata = (fm.metadata ?? {}) as Record<string, unknown>;
  const description = strOrNull(fm.description);
  const version = strOrNull(fm.version ?? metadata.version);
  const author = strOrNull(fm.author ?? metadata.author);
  const license = strOrNull(fm.license);

  const { sizeBytes, fileCount } = measureDir(skillDir);

  return {
    name,
    description,
    version,
    author,
    license,
    bodyExcerpt: excerpt,
    contentHash,
    sizeBytes,
    fileCount,
  };
}

function strOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/**
 * Walk the skill directory to compute size and file count.
 * Bounded depth + follows-symlinks=false to avoid loops or huge external dirs.
 */
function measureDir(dir: string, depth = 0): { sizeBytes: number; fileCount: number } {
  if (depth > 6) return { sizeBytes: 0, fileCount: 0 };
  let total = 0;
  let count = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { sizeBytes: 0, fileCount: 0 };
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.git')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      // count the link itself as a file; don't follow
      count += 1;
      continue;
    }
    if (entry.isDirectory()) {
      const sub = measureDir(full, depth + 1);
      total += sub.sizeBytes;
      count += sub.fileCount;
      continue;
    }
    if (entry.isFile()) {
      try {
        total += fs.statSync(full).size;
        count += 1;
      } catch {
        // skip unreadable files
      }
    }
  }
  return { sizeBytes: total, fileCount: count };
}
