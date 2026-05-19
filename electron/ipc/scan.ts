import { registerHandler } from './dispatcher';
import { IPC } from '../../shared/ipc-channels';
import { scanAll, getLastScanResult } from '../scanner';

export function registerScanHandlers(): void {
  registerHandler(IPC.scan.run, async (event) => scanAll(event.sender));
  registerHandler(IPC.scan.lastResult, () => getLastScanResult());
}
