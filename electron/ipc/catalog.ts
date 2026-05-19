import matter from 'gray-matter';
import { registerHandler, makeError } from './dispatcher';
import { IPC } from '../../shared/ipc-channels';
import { searchCatalog, fetchSkillContent } from '../catalog/skillssh';
import { planInstall } from '../catalog/install';
import type { CatalogPreview, PlatformId } from '../../shared/types';

const EXCERPT_CHARS = 500;

export function registerCatalogHandlers(): void {
  registerHandler(IPC.catalog.search, async (_e, payload) => {
    const p = (payload ?? {}) as { q?: unknown; limit?: unknown; offset?: unknown };
    if (typeof p.q !== 'string') {
      throw makeError('INVALID_INPUT', 'q (string) required');
    }
    const limit = typeof p.limit === 'number' ? p.limit : undefined;
    const offset = typeof p.offset === 'number' ? p.offset : undefined;
    try {
      return await searchCatalog(p.q, limit, offset);
    } catch (err) {
      throw asIpcError(err);
    }
  });

  registerHandler(IPC.catalog.preview, async (_e, payload) => {
    const p = (payload ?? {}) as { source?: unknown; skillId?: unknown };
    if (typeof p.source !== 'string' || typeof p.skillId !== 'string') {
      throw makeError('INVALID_INPUT', 'source (string) and skillId (string) required');
    }
    let raw: string;
    try {
      raw = await fetchSkillContent(p.source, p.skillId);
    } catch (err) {
      throw asIpcError(err);
    }
    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw makeError('PARSE_ERROR', `SKILL.md frontmatter is invalid: ${msg}`);
    }
    const body = parsed.content ?? '';
    const excerpt = body.slice(0, EXCERPT_CHARS).trim() || null;
    const result: CatalogPreview = {
      source: p.source,
      skillId: p.skillId,
      rawMarkdown: raw,
      frontmatter: (parsed.data ?? {}) as Record<string, unknown>,
      bodyExcerpt: excerpt,
    };
    return result;
  });

  registerHandler(IPC.catalog.planInstall, async (_e, payload) => {
    const p = (payload ?? {}) as {
      source?: unknown;
      skillId?: unknown;
      skillName?: unknown;
      targetPlatformIds?: unknown;
    };
    if (typeof p.source !== 'string') throw makeError('INVALID_INPUT', 'source (string) required');
    if (typeof p.skillId !== 'string') throw makeError('INVALID_INPUT', 'skillId (string) required');
    if (typeof p.skillName !== 'string')
      throw makeError('INVALID_INPUT', 'skillName (string) required');
    if (!Array.isArray(p.targetPlatformIds))
      throw makeError('INVALID_INPUT', 'targetPlatformIds (string[]) required');
    for (const t of p.targetPlatformIds) {
      if (typeof t !== 'string') {
        throw makeError('INVALID_INPUT', 'targetPlatformIds entries must be strings');
      }
    }
    try {
      return await planInstall(
        p.source,
        p.skillId,
        p.skillName,
        p.targetPlatformIds as PlatformId[],
      );
    } catch (err) {
      throw asIpcError(err);
    }
  });
}

function asIpcError(err: unknown): { code: string; message: string; detail?: unknown } {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    const e = err as { code: unknown; message: unknown; detail?: unknown };
    if (typeof e.code === 'string' && typeof e.message === 'string') {
      return { code: e.code, message: e.message, detail: e.detail };
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { code: 'CATALOG_ERROR', message: msg };
}
