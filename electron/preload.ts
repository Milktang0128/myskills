import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  ALL_EVENT_CHANNELS,
  ALL_INVOKE_CHANNELS,
} from '../shared/ipc-channels';

/**
 * The single API surface exposed to the renderer. Two operations:
 *   - invoke(channel, payload): one-shot RPC, returns a Promise
 *   - on(channel, cb): subscribe to main-emitted events, returns an unsubscribe fn
 *
 * Both validate the channel against the shared whitelist. Anything else is rejected
 * synchronously, so the renderer cannot poke arbitrary ipcMain channels.
 */
const api = {
  invoke: (channel: string, payload?: unknown): Promise<unknown> => {
    if (!ALL_INVOKE_CHANNELS.has(channel)) {
      return Promise.reject(new Error(`Channel "${channel}" is not allowed`));
    }
    return ipcRenderer.invoke(channel, payload);
  },
  on: (channel: string, callback: (data: unknown) => void): (() => void) => {
    if (!ALL_EVENT_CHANNELS.has(channel)) {
      throw new Error(`Event channel "${channel}" is not allowed`);
    }
    const listener = (_e: IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.off(channel, listener);
  },
};

contextBridge.exposeInMainWorld('myskills', api);

export type MySkillsApi = typeof api;
