import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { ALL_INVOKE_CHANNELS } from '../../shared/ipc-channels';
import type { IpcError } from '../../shared/types';

type Handler = (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown> | unknown;

let allowedWebContents: WebContents | null = null;

/**
 * Restrict IPC to a single WebContents (our main window). Per Electron security
 * docs, every handler should validate event.sender. We centralize that here.
 */
export function setAllowedSender(contents: WebContents): void {
  allowedWebContents = contents;
}

export function registerHandler(channel: string, handler: Handler): void {
  if (!ALL_INVOKE_CHANNELS.has(channel)) {
    throw new Error(`IPC channel "${channel}" is not in the whitelist`);
  }
  ipcMain.handle(channel, async (event, payload) => {
    if (allowedWebContents && event.sender !== allowedWebContents) {
      throwAsError(makeError('IPC_FORBIDDEN', `Sender not allowed for channel ${channel}`));
    }
    try {
      return await handler(event, payload);
    } catch (err) {
      const ipcErr = isIpcError(err)
        ? err
        : makeError(
            'IPC_HANDLER_ERROR',
            err instanceof Error ? err.message : String(err),
            { channel },
          );
      throwAsError(ipcErr);
    }
  });
}

export function makeError(code: string, message: string, detail?: unknown): IpcError {
  return { code, message, detail };
}

function isIpcError(x: unknown): x is IpcError {
  return typeof x === 'object' && x !== null && 'code' in x && 'message' in x;
}

// Electron's ipcMain.handle stringifies non-Error throws as "[object Object]"
// on the renderer side. Wrap our IpcError in a real Error so the renderer's
// catch sees the actual .message. Code/detail are attached for handlers that
// want the structured form (note: structured clone may strip them in transit).
function throwAsError(err: IpcError): never {
  const wrapped = new Error(err.message) as Error & { code: string; detail?: unknown };
  wrapped.code = err.code;
  wrapped.detail = err.detail;
  throw wrapped;
}
