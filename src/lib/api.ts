/**
 * Typed wrapper around window.myskills (defined by preload.ts).
 * Renderer code never touches IPC primitives — only this module.
 */
import { IPC } from '@shared/ipc-channels';
import type {
  AppStats,
  CoverageMatrix,
  Platform,
  PlatformId,
  Scenario,
  ScenarioExport,
  ScenarioImportResult,
  ScanResult,
  Skill,
  SkillFilter,
  SyncExecuteResult,
  SyncPlan,
} from '@shared/types';

export interface SyncHistoryRow {
  id: number;
  skill_id: string;
  action: string;
  from_path: string | null;
  to_path: string | null;
  platform_id: string | null;
  before_hash: string | null;
  after_hash: string | null;
  backup_path: string | null;
  conflict_resolution: string | null;
  rolled_back_at: number | null;
  success: number;
  message: string | null;
  created_at: number;
}

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
  coverage: {
    matrix: () => bridge().invoke(IPC.coverage.matrix) as Promise<CoverageMatrix>,
  },
  sync: {
    plan: (requests: Array<{ skillId: string; targetPlatformIds?: PlatformId[] }>) =>
      bridge().invoke(IPC.sync.plan, { requests }) as Promise<SyncPlan>,
    execute: (plan: SyncPlan) =>
      bridge().invoke(IPC.sync.execute, { plan }) as Promise<SyncExecuteResult>,
    history: (skillId?: string, limit = 50) =>
      bridge().invoke(IPC.sync.history, { skillId, limit }) as Promise<SyncHistoryRow[]>,
    rollback: (historyId: number) =>
      bridge().invoke(IPC.sync.rollback, { historyId }) as Promise<{ ok: true }>,
  },
  on: {
    scanStarted: (cb: (data: { startedAt: number }) => void) =>
      bridge().on(IPC.events.scanStarted, (d) => cb(d as { startedAt: number })),
    scanFinished: (cb: (data: ScanResult) => void) =>
      bridge().on(IPC.events.scanFinished, (d) => cb(d as ScanResult)),
  },
};
