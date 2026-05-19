import { registerPlatformHandlers } from './platforms';
import { registerSkillHandlers } from './skills';
import { registerScenarioHandlers } from './scenarios';
import { registerSettingsHandlers } from './settings';
import { registerScanHandlers } from './scan';
import { registerCoverageHandlers } from './coverage';
import { registerSyncHandlers } from './sync';

export function registerAllHandlers(): void {
  registerPlatformHandlers();
  registerSkillHandlers();
  registerScenarioHandlers();
  registerSettingsHandlers();
  registerScanHandlers();
  registerCoverageHandlers();
  registerSyncHandlers();
}
