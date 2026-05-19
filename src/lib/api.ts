/**
 * Typed wrapper around window.myskills (defined by preload.ts).
 * Renderer code never touches IPC primitives — only this module.
 */
import { IPC } from '@shared/ipc-channels';
import type {
  AppStats,
  Platform,
  Scenario,
  ScenarioExport,
  ScenarioImportResult,
  ScanResult,
  Skill,
  SkillFilter,
} from '@shared/types';

interface BridgeApi {
  invoke: (channel: string, payload?: unknown) => Promise<unknown>;
  on: (channel: string, cb: (data: unknown) => void) => () => void;
}

declare global {
  interface Window {
    myskills: BridgeApi;
  }
}

function bridge(): BridgeApi {
  if (typeof window === 'undefined' || !window.myskills) {
    throw new Error('IPC bridge unavailable — running outside Electron?');
  }
  return window.myskills;
}

export const api = {
  platforms: {
    list: () => bridge().invoke(IPC.platforms.list) as Promise<Platform[]>,
    update: (id: string, skillsDir: string) =>
      bridge().invoke(IPC.platforms.update, { id, skillsDir }) as Promise<{ ok: true }>,
  },
  skills: {
    list: (filter: SkillFilter = {}) => bridge().invoke(IPC.skills.list, filter) as Promise<Skill[]>,
    get: (id: string) => bridge().invoke(IPC.skills.get, { id }) as Promise<Skill>,
  },
  scenarios: {
    list: () => bridge().invoke(IPC.scenarios.list) as Promise<Scenario[]>,
    create: (s: Partial<Scenario>) => bridge().invoke(IPC.scenarios.create, s) as Promise<Scenario>,
    update: (s: Partial<Scenario> & { id: number }) =>
      bridge().invoke(IPC.scenarios.update, s) as Promise<Scenario>,
    remove: (id: number) =>
      bridge().invoke(IPC.scenarios.delete, { id }) as Promise<{ ok: true }>,
    addSkill: (skillId: string, scenarioId: number) =>
      bridge().invoke(IPC.scenarios.addSkill, { skillId, scenarioId }) as Promise<{ ok: true }>,
    removeSkill: (skillId: string, scenarioId: number) =>
      bridge().invoke(IPC.scenarios.removeSkill, { skillId, scenarioId }) as Promise<{ ok: true }>,
    export: () => bridge().invoke(IPC.scenarios.export) as Promise<ScenarioExport>,
    import: (payload: ScenarioExport) =>
      bridge().invoke(IPC.scenarios.import, payload) as Promise<ScenarioImportResult>,
  },
  scan: {
    run: () => bridge().invoke(IPC.scan.run) as Promise<ScanResult>,
    lastResult: () => bridge().invoke(IPC.scan.lastResult) as Promise<ScanResult | null>,
  },
  settings: {
    get: (key: string) => bridge().invoke(IPC.settings.get, { key }) as Promise<string | null>,
    set: (key: string, value: string) =>
      bridge().invoke(IPC.settings.set, { key, value }) as Promise<{ ok: true }>,
    stats: () => bridge().invoke(IPC.settings.stats) as Promise<AppStats>,
  },
  on: {
    scanStarted: (cb: (data: { startedAt: number }) => void) =>
      bridge().on(IPC.events.scanStarted, (d) => cb(d as { startedAt: number })),
    scanFinished: (cb: (data: ScanResult) => void) =>
      bridge().on(IPC.events.scanFinished, (d) => cb(d as ScanResult)),
  },
};
