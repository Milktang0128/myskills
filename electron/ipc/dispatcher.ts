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
      throw makeError('IPC_FORBIDDEN', `Sender not allowed for channel ${channel}`);
    }
    try {
      return await handler(event, payload);
    } catch (err) {
      if (isIpcError(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw makeError('IPC_HANDLER_ERROR', message, { channel });
    }
  });
}

export function makeError(code: string, message: string, detail?: unknown): IpcError {
  return { code, message, detail };
}

function isIpcError(x: unknown): x is IpcError {
  return typeof x === 'object' && x !== null && 'code' in x && 'message' in x;
}
