/**
 * Typed wrapper around window.myskills (defined by preload.ts).
 * Renderer code never touches IPC primitives — only this module.
 */
import { IPC } from '@shared/ipc-channels';
import type {
  AiScenarioSuggestion,
  AppStats,
  BulkCategorizeApplyResult,
  BulkCategorizePlan,
  CatalogPreview,
  CatalogSearchResponse,
  CoverageMatrix,
  CreateFromClusterRequest,
  CreateFromClusterResult,
  LibraryOverview,
  LibraryOverviewSnapshot,
  LlmChatRequest,
  LlmChatResponse,
  LlmConfig,
  LlmFeatureToggles,
  LlmProvider,
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
  /**
   * UUID shared by every FS step that came from the same user-level action.
   * NULL on legacy rows written before the column existed — those render
   * as singleton groups in the UI.
   */
  op_group_id: string | null;
  /**
   * Annotated by the IPC handler at query time: true when this row recorded
   * a backup_path but the backup file no longer exists on disk (retention
   * cleanup, manual deletion). The UI uses this to disable the Undo button
   * for orphaned rows instead of failing at execute time with a confusing
   * "backup not found" error.
   */
  backup_orphaned?: boolean;
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
    create: (input: { id: string; label: string; skillsDir: string }) =>
      bridge().invoke(IPC.platforms.create, input) as Promise<Platform>,
    delete: (id: string) =>
      bridge().invoke(IPC.platforms.delete, { id }) as Promise<{ ok: true }>,
    probe: (path: string) =>
      bridge().invoke(IPC.platforms.probe, { path }) as Promise<{
        resolvedPath: string;
        exists: boolean;
        readable: boolean;
        skillCount: number;
        alreadyRegistered: boolean;
        registeredAs?: string;
      }>,
    knownCandidates: () =>
      bridge().invoke(IPC.platforms.knownCandidates) as Promise<
        Array<{ id: string; label: string; defaultDir: string; description: string }>
      >,
    openDir: (id: string) =>
      bridge().invoke(IPC.platforms.openDir, { id }) as Promise<{ ok: true; path: string }>,
  },
  skills: {
    list: (filter: SkillFilter = {}) => bridge().invoke(IPC.skills.list, filter) as Promise<Skill[]>,
    get: (id: string) => bridge().invoke(IPC.skills.get, { id }) as Promise<Skill>,
    openLocation: (locationId: number, kind: 'install' | 'target' = 'install') =>
      bridge().invoke(IPC.skills.openLocation, { locationId, kind }) as Promise<{ ok: true; path: string }>,
    copyLocationPath: (locationId: number, kind: 'install' | 'target' = 'install') =>
      bridge().invoke(IPC.skills.copyLocationPath, { locationId, kind }) as Promise<{ ok: true; path: string }>,
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
    /**
     * Convert an AI Lens cluster into a real scenario (or merge into an
     * existing one with the same name). The renderer hands off the cluster
     * name + skill ids; main runs the atomic insert + links.
     */
    createFromCluster: (req: CreateFromClusterRequest) =>
      bridge().invoke(IPC.scenarios.createFromCluster, req) as Promise<CreateFromClusterResult>,
  },
  scan: {
    run: () => bridge().invoke(IPC.scan.run) as Promise<ScanResult>,
    lastResult: () => bridge().invoke(IPC.scan.lastResult) as Promise<ScanResult | null>,
  },
  // Result shape mirrors electron/sync/backup-cleanup.ts BackupCleanupResult.
  // Inlined here so the renderer doesn't have to import a backend module type.
  settings: {
    get: (key: string) => bridge().invoke(IPC.settings.get, { key }) as Promise<string | null>,
    set: (key: string, value: string) =>
      bridge().invoke(IPC.settings.set, { key, value }) as Promise<{ ok: true }>,
    stats: () => bridge().invoke(IPC.settings.stats) as Promise<AppStats>,
    cleanupBackups: () =>
      bridge().invoke(IPC.settings.cleanupBackups) as Promise<{
        deletedDirs: number;
        deletedBytes: number;
        nulledRows: number;
        remainingBytes: number;
      }>,
  },
  coverage: {
    matrix: () => bridge().invoke(IPC.coverage.matrix) as Promise<CoverageMatrix>,
  },
  sync: {
    planFromCanonical: (requests: Array<{ skillId: string; targetPlatformIds?: PlatformId[] }>) =>
      bridge().invoke(IPC.sync.plan, { kind: 'sync_from_canonical', requests }) as Promise<SyncPlan>,
    planPromote: (requests: Array<{ skillId: string; sourceLocationId?: number }>) =>
      bridge().invoke(IPC.sync.plan, { kind: 'promote_to_canonical', requests }) as Promise<SyncPlan>,
    execute: (token: string) =>
      bridge().invoke(IPC.sync.execute, { token }) as Promise<SyncExecuteResult>,
    history: (skillId?: string, limit = 50) =>
      bridge().invoke(IPC.sync.history, { skillId, limit }) as Promise<SyncHistoryRow[]>,
    rollback: (historyId: number) =>
      bridge().invoke(IPC.sync.rollback, { historyId }) as Promise<{ ok: true }>,
  },
  catalog: {
    search: (q: string, limit?: number, offset?: number) =>
      bridge().invoke(IPC.catalog.search, { q, limit, offset }) as Promise<CatalogSearchResponse>,
    preview: (source: string, skillId: string) =>
      bridge().invoke(IPC.catalog.preview, { source, skillId }) as Promise<CatalogPreview>,
    planInstall: (
      source: string,
      skillId: string,
      skillName: string,
      targetPlatformIds: PlatformId[],
    ) =>
      bridge().invoke(IPC.catalog.planInstall, {
        source,
        skillId,
        skillName,
        targetPlatformIds,
      }) as Promise<SyncPlan>,
    /**
     * Batch-enrich descriptions for catalog search rows. skills.sh search
     * doesn't include description; the main process fetches each SKILL.md
     * from GitHub raw, parses frontmatter, and returns `description` per
     * (source, skillId). Soft-fails to null per row.
     */
    enrichDescriptions: (items: Array<{ source: string; skillId: string }>) =>
      bridge().invoke(IPC.catalog.enrichDescriptions, { items }) as Promise<
        Array<{ source: string; skillId: string; description: string | null }>
      >,
  },
  llm: {
    getConfig: () => bridge().invoke(IPC.llm.getConfig) as Promise<LlmConfig>,
    setConfig: (cfg: { provider?: LlmProvider; model?: string; baseUrl?: string }) =>
      bridge().invoke(IPC.llm.setConfig, cfg) as Promise<LlmConfig>,
    /** Key only travels renderer → main. The renderer never receives it back. */
    setApiKey: (input: { key: string }) =>
      bridge().invoke(IPC.llm.setApiKey, input) as Promise<{ ok: true; hasApiKey: boolean }>,
    deleteApiKey: () =>
      bridge().invoke(IPC.llm.deleteApiKey) as Promise<{ ok: true; hasApiKey: false }>,
    chat: (req: LlmChatRequest) =>
      bridge().invoke(IPC.llm.chat, { req }) as Promise<LlmChatResponse>,
    testConnection: () =>
      bridge().invoke(IPC.llm.testConnection) as Promise<{ ok: boolean; message?: string }>,
    getFeatures: () => bridge().invoke(IPC.llm.getFeatures) as Promise<LlmFeatureToggles>,
    setFeatures: (toggles: Partial<LlmFeatureToggles>) =>
      bridge().invoke(IPC.llm.setFeatures, toggles) as Promise<LlmFeatureToggles>,
  },
  ai: {
    getSuggestionsForSkill: (skillId: string) =>
      bridge().invoke(IPC.ai.getSuggestionsForSkill, { skillId }) as Promise<AiScenarioSuggestion[]>,
    acceptSuggestion: (suggestionId: number) =>
      bridge().invoke(IPC.ai.acceptSuggestion, { suggestionId }) as Promise<{ ok: true }>,
    dismissSuggestion: (suggestionId: number) =>
      bridge().invoke(IPC.ai.dismissSuggestion, { suggestionId }) as Promise<{ ok: true }>,
    queueStatus: () =>
      bridge().invoke(IPC.ai.queueStatus) as Promise<{ pending: number; schedulerRunning: boolean }>,
    /**
     * Build a categorization plan for a set of skills. ONE LLM call (or a
     * few batches for large sets). Returns a plan the user previews + edits
     * in the bulk-categorize dialog before applying.
     */
    bulkCategorize: (skillIds: string[]) =>
      bridge().invoke(IPC.ai.bulkCategorize, { skillIds }) as Promise<BulkCategorizePlan>,
    /** Apply a (possibly user-edited) bulk plan in a DB transaction. */
    applyBulkCategorization: (plan: BulkCategorizePlan) =>
      bridge().invoke(IPC.ai.applyBulkCategorization, { plan }) as Promise<BulkCategorizeApplyResult>,
    /**
     * Library Map ("Skill Map") — read the cached overview snapshot plus a
     * stale flag derived from the current skill set. Cheap (no LLM call).
     */
    libraryOverviewGet: (language: 'zh' | 'en') =>
      bridge().invoke(IPC.ai.libraryOverviewGet, { language }) as Promise<LibraryOverviewSnapshot>,
    /** Run the LLM, replace the cache, return the fresh overview. */
    libraryOverviewGenerate: (language: 'zh' | 'en') =>
      bridge().invoke(IPC.ai.libraryOverviewGenerate, { language }) as Promise<LibraryOverview>,
  },
  on: {
    scanStarted: (cb: (data: { startedAt: number }) => void) =>
      bridge().on(IPC.events.scanStarted, (d) => cb(d as { startedAt: number })),
    scanFinished: (cb: (data: ScanResult) => void) =>
      bridge().on(IPC.events.scanFinished, (d) => cb(d as ScanResult)),
    scanPlatformDone: (
      cb: (data: { platformId: string; index: number; total: number; found: number; skipped: boolean }) => void,
    ) =>
      bridge().on(IPC.events.scanPlatformDone, (d) =>
        cb(d as { platformId: string; index: number; total: number; found: number; skipped: boolean }),
      ),
  },
};
