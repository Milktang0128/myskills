/**
 * Catalog install pipeline.
 *
 * Pipeline:
 *   1. Fetch raw SKILL.md from skills.sh / GitHub via skillssh.fetchSkillContent.
 *   2. Parse the frontmatter with gray-matter, validate `name`, hash the content.
 *   3. Stage the SKILL.md into `userData/staging/{uuid}/<basename>/SKILL.md`.
 *      The staging directory is named after the catalog skillId (sanitized)
 *      so the eventual install path uses it as the basename.
 *   4. Hand off to sync/symlink.planInstallFromStaging to build a SyncPlan
 *      that copies staging → canonical and symlinks the requested targets.
 *
 * The staging dir lives until execute is called. The plan token TTL (5 min)
 * matches the staging lifetime — if the user lets the plan expire, the
 * staging dir is left on disk and `gcStaleStaging` (called at startup) will
 * sweep it next launch.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import { randomUUID, createHash } from 'node:crypto';
import matter from 'gray-matter';
import type { PlatformId, SyncPlan } from '../../shared/types';
import { fetchSkillContent } from './skillssh';
import { planInstallFromStaging } from '../sync/symlink';

const STAGING_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour — well past plan TTL

function stagingRoot(): string {
  const root = path.join(app.getPath('userData'), 'staging');
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/**
 * Plan an install. Returns a SyncPlan the renderer presents in its confirm
 * dialog; the renderer then calls sync:execute with the plan token to
 * actually write files.
 */
export async function planInstall(
  source: string,
  skillId: string,
  skillName: string,
  targetPlatformIds: PlatformId[],
): Promise<SyncPlan> {
  if (!source || typeof source !== 'string') {
    throw makeErr('INVALID_INPUT', 'source required');
  }
  if (!skillId || typeof skillId !== 'string') {
    throw makeErr('INVALID_INPUT', 'skillId required');
  }
  if (!skillName || typeof skillName !== 'string') {
    throw makeErr('INVALID_INPUT', 'skillName required');
  }
  if (!Array.isArray(targetPlatformIds)) {
    throw makeErr('INVALID_INPUT', 'targetPlatformIds[] required');
  }

  // 1) Fetch raw SKILL.md.
  const raw = await fetchSkillContent(source, skillId);

  // 2) Parse + validate.
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw makeErr('PARSE_ERROR', `SKILL.md frontmatter is invalid: ${msg}`);
  }
  const fmName =
    typeof parsed.data?.name === 'string' ? (parsed.data.name as string).trim() : '';
  if (!fmName) {
    throw makeErr(
      'MISSING_FRONTMATTER',
      `SKILL.md from ${source}/${skillId} has no \`name\` field — cannot install.`,
    );
  }
  const sourceHash = createHash('sha256').update(raw).digest('hex');

  // 3) Stage into userData/staging/{uuid}/{safeBasename}/SKILL.md.
  // Sanitize the basename: derive from skillId (the catalog identifier), not
  // frontmatter name, to keep filesystem identity stable across upgrades.
  const safeBasename = sanitizeBasename(skillId);
  if (!safeBasename) {
    throw makeErr('INVALID_INPUT', `cannot derive safe install basename from "${skillId}"`);
  }

  const stageWrap = path.join(stagingRoot(), randomUUID());
  const stageDir = path.join(stageWrap, safeBasename);
  try {
    fs.mkdirSync(stageDir, { recursive: true });
    fs.writeFileSync(path.join(stageDir, 'SKILL.md'), raw, { encoding: 'utf8' });
  } catch (err) {
    // Try to clean up partial writes; ignore secondary errors.
    try {
      fs.rmSync(stageWrap, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw makeErr('STAGING_FAILED', `Could not stage skill for install: ${msg}`);
  }

  // 4) Build the SyncPlan via the symlink module.
  let plan: SyncPlan;
  try {
    plan = planInstallFromStaging({
      stagingDir: stageDir,
      skillName: fmName || skillName,
      sourceHash,
      installedFromSource: source,
      installedFromSkillId: skillId,
      targetPlatformIds,
    });
  } catch (err) {
    try {
      fs.rmSync(stageWrap, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }

  return plan;
}

/**
 * Sweep abandoned staging dirs older than STAGING_MAX_AGE_MS. Safe to call
 * at app startup; never touches the user's skill directories.
 */
export function gcStaleStaging(): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(stagingRoot(), { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - STAGING_MAX_AGE_MS;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(stagingRoot(), e.name);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) {
        fs.rmSync(full, { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }
  }
}

function sanitizeBasename(s: string): string {
  // Strip path separators, leading dots, control chars. Preserve dashes and
  // underscores. Cap length to keep us well under filesystem limits.
  const cleaned = s
    .normalize('NFC')
    .replace(/[\x00-\x1f\x7f/\\:?*"<>|]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 100);
  if (!cleaned || cleaned === '.' || cleaned === '..') return '';
  return cleaned;
}

function makeErr(code: string, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}
