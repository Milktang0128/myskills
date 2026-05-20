import type { WebContents } from 'electron';
import { registerHandler } from './dispatcher';
import { IPC } from '../../shared/ipc-channels';
import { scanAll, getLastScanResult, type ScanProgressEvent } from '../scanner';

/**
 * Translate scanner progress events into IPC channel sends. Lives here
 * (the IPC layer), not in the scanner, so the scanner stays pure Node.
 */
function forwardProgress(sender: WebContents): (event: ScanProgressEvent) => void {
  return (event) => {
    if (sender.isDestroyed()) return;
    try {
      switch (event.type) {
        case 'started':
          sender.send(IPC.events.scanStarted, { startedAt: event.startedAt });
          return;
        case 'platformDone':
          sender.send(IPC.events.scanPlatformDone, {
            platformId: event.platformId,
            index: event.index,
            total: event.total,
            found: event.found,
            skipped: event.skipped,
          });
          return;
        case 'finished':
          sender.send(IPC.events.scanFinished, event.result);
          return;
      }
    } catch {
      /* ignore — sender may have been destroyed between the check and send */
    }
  };
}

export function registerScanHandlers(): void {
  registerHandler(IPC.scan.run, async (event) => scanAll(forwardProgress(event.sender)));
  registerHandler(IPC.scan.lastResult, () => getLastScanResult());
}

/**
 * Helper for callers that need to forward scan progress to a specific
 * WebContents (e.g. main.ts on app launch). Exported so main.ts can wire
 * `maybeAutoScan` to the renderer's window without importing IPC internals.
 */
export { forwardProgress as makeScanProgressForwarder };
