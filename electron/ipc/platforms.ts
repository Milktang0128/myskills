import { shell } from 'electron';
import { registerHandler, makeError } from './dispatcher';
import { IPC } from '../../shared/ipc-channels';
import {
  listPlatforms,
  updatePlatformDir,
  createPlatform,
  deletePlatform,
  probePath,
} from '../scanner/platforms';
import { KNOWN_PLATFORMS } from '../../shared/known-platforms';

export function registerPlatformHandlers(): void {
  registerHandler(IPC.platforms.list, () => listPlatforms());

  registerHandler(IPC.platforms.openDir, async (_e, payload) => {
    const p = payload as { id?: string };
    if (!p?.id) throw makeError('INVALID_INPUT', 'id required');
    const platform = listPlatforms().find((x) => x.id === p.id);
    if (!platform) throw makeError('NOT_FOUND', `platform ${p.id}`);
    const error = await shell.openPath(platform.skillsDir);
    if (error) throw makeError('OPEN_PATH_FAILED', error, { path: platform.skillsDir });
    return { ok: true, path: platform.skillsDir };
  });

  registerHandler(IPC.platforms.update, (_e, payload) => {
    const p = payload as { id?: string; skillsDir?: string };
    if (!p?.id || !p?.skillsDir) throw makeError('INVALID_INPUT', 'id and skillsDir required');
    updatePlatformDir(p.id, p.skillsDir);
    return { ok: true };
  });

  registerHandler(IPC.platforms.create, (_e, payload) => {
    const p = payload as { id?: string; label?: string; skillsDir?: string };
    if (!p?.id || !p?.label || !p?.skillsDir) {
      throw makeError('INVALID_INPUT', 'id, label, skillsDir required');
    }
    try {
      return createPlatform({ id: p.id, label: p.label, skillsDir: p.skillsDir });
    } catch (err) {
      throw makeError('CREATE_FAILED', err instanceof Error ? err.message : String(err));
    }
  });

  registerHandler(IPC.platforms.delete, (_e, payload) => {
    const p = payload as { id?: string };
    if (!p?.id) throw makeError('INVALID_INPUT', 'id required');
    try {
      deletePlatform(p.id);
      return { ok: true };
    } catch (err) {
      throw makeError('DELETE_FAILED', err instanceof Error ? err.message : String(err));
    }
  });

  registerHandler(IPC.platforms.probe, (_e, payload) => {
    const p = payload as { path?: string };
    if (!p?.path) throw makeError('INVALID_INPUT', 'path required');
    return probePath(p.path);
  });

  // Returns the curated SKILL.md candidate list (purely static — could live in
  // the renderer too, but keeping it server-side makes future updates without
  // a renderer rebuild possible).
  registerHandler(IPC.platforms.knownCandidates, () => KNOWN_PLATFORMS);
}
