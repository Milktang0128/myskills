import { registerHandler, makeError } from './dispatcher';
import { IPC } from '../../shared/ipc-channels';
import { listPlatforms, updatePlatformDir } from '../scanner/platforms';

export function registerPlatformHandlers(): void {
  registerHandler(IPC.platforms.list, () => listPlatforms());

  registerHandler(IPC.platforms.update, (_e, payload) => {
    const p = payload as { id?: string; skillsDir?: string };
    if (!p?.id || !p?.skillsDir) throw makeError('INVALID_INPUT', 'id and skillsDir required');
    updatePlatformDir(p.id, p.skillsDir);
    return { ok: true };
  });
}
