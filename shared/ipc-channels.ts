/**
 * Whitelist of IPC channel names. Both preload and main import this so the
 * set of valid channels is single-source. Anything not listed here is rejected
 * by the IPC dispatcher in main.
 */

export const IPC = {
  platforms: {
    list: 'platforms:list',
    update: 'platforms:update',
  },
  skills: {
    list: 'skills:list',
    get: 'skills:get',
  },
  scenarios: {
    list: 'scenarios:list',
    create: 'scenarios:create',
    update: 'scenarios:update',
    delete: 'scenarios:delete',
    addSkill: 'scenarios:addSkill',
    removeSkill: 'scenarios:removeSkill',
    export: 'scenarios:export',
    import: 'scenarios:import',
  },
  scan: {
    run: 'scan:run',
    lastResult: 'scan:lastResult',
  },
  settings: {
    get: 'settings:get',
    set: 'settings:set',
    stats: 'settings:stats',
  },
  events: {
    scanStarted: 'event:scanStarted',
    scanFinished: 'event:scanFinished',
  },
} as const;

export type IpcChannel =
  | typeof IPC.platforms[keyof typeof IPC.platforms]
  | typeof IPC.skills[keyof typeof IPC.skills]
  | typeof IPC.scenarios[keyof typeof IPC.scenarios]
  | typeof IPC.scan[keyof typeof IPC.scan]
  | typeof IPC.settings[keyof typeof IPC.settings];

export type IpcEventChannel = typeof IPC.events[keyof typeof IPC.events];

export const ALL_INVOKE_CHANNELS: ReadonlySet<string> = new Set<string>([
  ...Object.values(IPC.platforms),
  ...Object.values(IPC.skills),
  ...Object.values(IPC.scenarios),
  ...Object.values(IPC.scan),
  ...Object.values(IPC.settings),
]);

export const ALL_EVENT_CHANNELS: ReadonlySet<string> = new Set<string>(Object.values(IPC.events));
