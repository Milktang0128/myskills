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
  /** mtime (ms) of SKILL.md — used to surface "which version is newest". */
  mtime: number;
}

export type SkillParseKind =
  | 'missing_frontmatter'
  | 'parse_error'
  | 'unreadable'
  | 'icloud_evicted'
  | 'too_large';

export class SkillParseError extends Error {
  constructor(public kind: SkillParseKind, msg: string) {
    super(msg);
  }
}

const SKILL_MD = 'SKILL.md';
const ICLOUD_PLACEHOLDER = '.SKILL.md.icloud';
const EXCERPT_CHARS = 500;
const SKILL_MD_MAX_BYTES = 1 * 1024 * 1024; // 1 MB hard limit for SKILL.md
const FILE_COUNT_HARD_CAP = 10_000;

/**
 * Parse a skill directory. Returns null if the directory is not a skill
 * (no SKILL.md and no iCloud placeholder), throws SkillParseError for
 * malformed skills or iCloud-evicted ones.
 */
export function parseSkill(skillDir: string): ParsedSkill | null {
  const skillMdPath = path.join(skillDir, SKILL_MD);

  // Stat first so we can bound reads and detect iCloud eviction explicitly.
  let stat: fs.Stats;
  try {
    stat = fs.statSync(skillMdPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // Distinguish "iCloud has evicted SKILL.md" from "not a skill dir".
      if (hasIcloudPlaceholder(skillDir)) {
        throw new SkillParseError(
          'icloud_evicted',
          `SKILL.md at ${skillDir} is offloaded to iCloud — open the folder in Finder to download it`,
        );
      }
      return null;
    }
    throw new SkillParseError('unreadable', `cannot stat ${skillMdPath}: ${(err as Error).message}`);
  }
  if (!stat.isFile()) return null;
  if (stat.size > SKILL_MD_MAX_BYTES) {
    throw new SkillParseError(
      'too_large',
      `SKILL.md at ${skillDir} is ${stat.size} bytes (limit ${SKILL_MD_MAX_BYTES})`,
    );
  }

  let raw: string;
  try {
    raw = fs.readFileSync(skillMdPath, 'utf-8');
  } catch (err) {
    throw new SkillParseError('unreadable', `cannot read ${skillMdPath}: ${(err as Error).message}`);
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (err) {
    throw new SkillParseError('parse_error', `invalid frontmatter: ${(err as Error).message}`);
  }

  const fm = (parsed.data ?? {}) as Record<string, unknown>;
  const rawName = typeof fm.name === 'string' ? fm.name.trim() : '';
  // Normalize to NFC so macOS NFD filenames and frontmatter NFC text match
  // under our (name, source_key) identity rule.
  const name = rawName ? rawName.normalize('NFC') : null;
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
    mtime: stat.mtimeMs,
  };
}

function strOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function hasIcloudPlaceholder(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, ICLOUD_PLACEHOLDER)).isFile();
  } catch {
    return false;
  }
}

/**
 * Walk the skill directory to compute size and file count.
 * Bounded depth + bounded file count + follows-symlinks=false.
 */
function measureDir(dir: string, depth = 0, runningCount = 0): { sizeBytes: number; fileCount: number } {
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
    if (entry.name === '.DS_Store') continue;
    if (runningCount + count >= FILE_COUNT_HARD_CAP) break;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      count += 1;
      continue;
    }
    if (entry.isDirectory()) {
      const sub = measureDir(full, depth + 1, runningCount + count);
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
