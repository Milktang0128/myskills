/**
 * Typed wrapper around the desktop bridge.
 * Renderer code never touches transport primitives — only this module.
 *
 * Tauri is the primary runtime on the v0.2 branch. We still expose a
 * `window.myskills` compatibility object so the existing components'
 * bridge-ready checks can stay unchanged while the backend moves from
 * Electron IPC to Tauri commands.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getVersion } from '@tauri-apps/api/app';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { IPC, type IpcChannel, type IpcEventChannel } from '@shared/ipc-channels';
import type {
  AiScenarioSuggestion,
  AiJob,
  AppUpdateInfo,
  AppUpdateInstallProgress,
  AppStats,
  BulkCategorizeApplyResult,
  BulkCategorizePlan,
  CatalogPreview,
  CatalogSearchResponse,
  CoverageMatrix,
  CreateFromClusterRequest,
  CreateFromClusterResult,
  CreateSkillDraft,
  CreateSkillExecuteResult,
  CreateSkillGenerateResult,
  CreateSkillPlanResult,
  CreateSkillQuestion,
  CreateSkillReviewReport,
  CreateSkillSpec,
  CreateSkillStartResult,
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

const COMMANDS: Record<IpcChannel, string> = {
  [IPC.platforms.list]: 'platforms_list',
  [IPC.platforms.update]: 'platforms_update',
  [IPC.platforms.create]: 'platforms_create',
  [IPC.platforms.delete]: 'platforms_delete',
  [IPC.platforms.probe]: 'platforms_probe',
  [IPC.platforms.pickDir]: 'platforms_pick_dir',
  [IPC.platforms.knownCandidates]: 'platforms_known_candidates',
  [IPC.platforms.openDir]: 'platforms_open_dir',

  [IPC.skills.list]: 'skills_list',
  [IPC.skills.get]: 'skills_get',
  [IPC.skills.openLocation]: 'skills_open_location',
  [IPC.skills.copyLocationPath]: 'skills_copy_location_path',
  [IPC.skills.readLocation]: 'skills_read_location',

  [IPC.scenarios.list]: 'scenarios_list',
  [IPC.scenarios.create]: 'scenarios_create',
  [IPC.scenarios.update]: 'scenarios_update',
  [IPC.scenarios.delete]: 'scenarios_delete',
  [IPC.scenarios.addSkill]: 'scenarios_add_skill',
  [IPC.scenarios.removeSkill]: 'scenarios_remove_skill',
  [IPC.scenarios.export]: 'scenarios_export',
  [IPC.scenarios.import]: 'scenarios_import',
  [IPC.scenarios.createFromCluster]: 'scenarios_create_from_cluster',


  [IPC.scan.run]: 'scan_run',
  [IPC.scan.lastResult]: 'scan_last_result',
  [IPC.coverage.matrix]: 'coverage_matrix',

  [IPC.sync.plan]: 'sync_plan',
  [IPC.sync.planToggleDisabled]: 'sync_plan_toggle_disabled',
  [IPC.sync.execute]: 'sync_execute',
  [IPC.sync.history]: 'sync_history',
  [IPC.sync.rollback]: 'sync_rollback',

  [IPC.catalog.search]: 'catalog_search',
  [IPC.catalog.preview]: 'catalog_preview',
  [IPC.catalog.planInstall]: 'catalog_plan_install',
  [IPC.catalog.enrichDescriptions]: 'catalog_enrich_descriptions',

  [IPC.settings.get]: 'settings_get',
  [IPC.settings.set]: 'settings_set',
  [IPC.settings.stats]: 'settings_stats',
  [IPC.settings.cleanupBackups]: 'settings_cleanup_backups',

  [IPC.llm.getConfig]: 'llm_get_config',
  [IPC.llm.setConfig]: 'llm_set_config',
  [IPC.llm.setApiKey]: 'llm_set_api_key',
  [IPC.llm.deleteApiKey]: 'llm_delete_api_key',
  [IPC.llm.chat]: 'llm_chat',
  [IPC.llm.testConnection]: 'llm_test_connection',
  [IPC.llm.getFeatures]: 'llm_get_features',
  [IPC.llm.setFeatures]: 'llm_set_features',

  [IPC.ai.jobGet]: 'ai_job_get',
  [IPC.ai.jobLatest]: 'ai_job_latest',
  [IPC.ai.getSuggestionsForSkill]: 'ai_get_suggestions_for_skill',
  [IPC.ai.acceptSuggestion]: 'ai_accept_suggestion',
  [IPC.ai.dismissSuggestion]: 'ai_dismiss_suggestion',
  [IPC.ai.queueStatus]: 'ai_queue_status',
  [IPC.ai.createSkillStart]: 'ai_create_skill_start',
  [IPC.ai.createSkillStartJob]: 'ai_create_skill_start_job',
  [IPC.ai.createSkillGet]: 'ai_create_skill_get',
  [IPC.ai.createSkillRefine]: 'ai_create_skill_refine',
  [IPC.ai.createSkillAnswer]: 'ai_create_skill_answer',
  [IPC.ai.createSkillGenerate]: 'ai_create_skill_generate',
  [IPC.ai.createSkillReview]: 'ai_create_skill_review',
  [IPC.ai.createSkillPlan]: 'ai_create_skill_plan',
  [IPC.ai.createSkillExecute]: 'ai_create_skill_execute',
  [IPC.ai.createSkillDiscard]: 'ai_create_skill_discard',
  [IPC.ai.bulkCategorize]: 'ai_bulk_categorize',
  [IPC.ai.applyBulkCategorization]: 'ai_apply_bulk_categorization',
  [IPC.ai.libraryOverviewGet]: 'ai_library_overview_get',
  [IPC.ai.libraryOverviewGenerate]: 'ai_library_overview_generate',
  [IPC.ai.libraryOverviewGenerateJob]: 'ai_library_overview_generate_job',
};

function normalizeApiError(err: unknown): Error & { code?: string; detail?: unknown } {
  if (err instanceof Error) return err as Error & { code?: string; detail?: unknown };
  if (typeof err === 'object' && err !== null) {
    const e = err as { code?: unknown; message?: unknown; detail?: unknown };
    const wrapped = new Error(typeof e.message === 'string' ? e.message : JSON.stringify(err)) as Error & {
      code?: string;
      detail?: unknown;
    };
    if (typeof e.code === 'string') wrapped.code = e.code;
    if ('detail' in e) wrapped.detail = e.detail;
    return wrapped;
  }
  return new Error(String(err));
}

async function call(channel: string, payload?: unknown): Promise<unknown> {
  const command = COMMANDS[channel as IpcChannel];
  if (!command) throw new Error(`Channel "${channel}" is not allowed`);
  try {
    return await invoke(command, { payload });
  } catch (err) {
    throw normalizeApiError(err);
  }
}

function onEvent(channel: string, cb: (data: unknown) => void): () => void {
  const allowed = Object.values(IPC.events).includes(channel as IpcEventChannel);
  if (!allowed) throw new Error(`Event channel "${channel}" is not allowed`);

  let disposed = false;
  let unlisten: (() => void) | null = null;
  void listen(channel, (event) => cb(event.payload))
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch((err) => {
      console.error(`Failed to subscribe to ${channel}`, err);
    });

  return () => {
    disposed = true;
    unlisten?.();
  };
}

function installTauriBridge(): void {
  if (typeof window === 'undefined') return;
  if (window.myskills) return;
  window.myskills = { invoke: call, on: onEvent };
}

installTauriBridge();

export function useApiReady(): boolean {
  return typeof window !== 'undefined' && !!window.myskills;
}

function bridge(): BridgeApi {
  if (typeof window === 'undefined' || !window.myskills) {
    throw new Error('Desktop bridge unavailable — running outside Tauri?');
  }
  return window.myskills;
}

let pendingUpdate: Update | null = null;

function updateToInfo(update: Update | null, currentVersion?: string): AppUpdateInfo {
  if (!update) {
    return {
      available: false,
      currentVersion: currentVersion ?? '',
      version: null,
    };
  }
  return {
    available: true,
    currentVersion: update.currentVersion,
    version: update.version,
    date: update.date,
    body: update.body,
  };
}

export const api = {
  app: {
    version: async () => getVersion(),
  },
  updates: {
    check: async () => {
      const update = await check();
      pendingUpdate = update;
      if (update) return updateToInfo(update);
      const currentVersion = await getVersion().catch(() => '');
      return updateToInfo(null, currentVersion);
    },
    downloadAndInstall: async (onProgress?: (progress: AppUpdateInstallProgress) => void) => {
      if (!pendingUpdate) throw new Error('No pending update. Check for updates first.');
      let downloadedBytes = 0;
      await pendingUpdate.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          downloadedBytes = 0;
          onProgress?.({
            event: 'Started',
            downloadedBytes,
            contentLength: event.data.contentLength,
          });
        } else if (event.event === 'Progress') {
          downloadedBytes += event.data.chunkLength;
          onProgress?.({
            event: 'Progress',
            downloadedBytes,
          });
        } else {
          onProgress?.({
            event: 'Finished',
            downloadedBytes,
          });
        }
      });
      pendingUpdate = null;
    },
    relaunch: async () => relaunch(),
  },
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
    pickDir: (startDir?: string) =>
      bridge().invoke(IPC.platforms.pickDir, { startDir }) as Promise<{ path: string | null }>,
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
    readLocation: (locationId: number) =>
      bridge().invoke(IPC.skills.readLocation, { locationId }) as Promise<{ content: string; path: string }>,
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
    planFromCanonical: (requests: Array<{ skillId: string; targetPlatformIds?: PlatformId[]; sourcePlatformId?: PlatformId; forceReplace?: boolean }>) =>
      bridge().invoke(IPC.sync.plan, { kind: 'sync_from_canonical', requests }) as Promise<SyncPlan>,
    planCopyToPlatform: (requests: Array<{ skillId: string; targetPlatformId: PlatformId }>) =>
      bridge().invoke(IPC.sync.plan, { kind: 'copy_to_platform', requests }) as Promise<SyncPlan>,
    planPromote: (requests: Array<{ skillId: string; sourceLocationId?: number }>) =>
      bridge().invoke(IPC.sync.plan, { kind: 'promote_to_canonical', requests }) as Promise<SyncPlan>,
    planToggleDisabled: (
      requests: Array<{ skillId: string; locationId: number; disable: boolean }>,
    ) => bridge().invoke(IPC.sync.planToggleDisabled, { requests }) as Promise<SyncPlan>,
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
    jobGet: <T = unknown>(jobId: string) =>
      bridge().invoke(IPC.ai.jobGet, { jobId }) as Promise<AiJob<T>>,
    jobLatest: <T = unknown>(kind: string, key?: string) =>
      bridge().invoke(IPC.ai.jobLatest, { kind, key }) as Promise<AiJob<T> | null>,
    getSuggestionsForSkill: (skillId: string) =>
      bridge().invoke(IPC.ai.getSuggestionsForSkill, { skillId }) as Promise<AiScenarioSuggestion[]>,
    acceptSuggestion: (suggestionId: number) =>
      bridge().invoke(IPC.ai.acceptSuggestion, { suggestionId }) as Promise<{ ok: true }>,
    dismissSuggestion: (suggestionId: number) =>
      bridge().invoke(IPC.ai.dismissSuggestion, { suggestionId }) as Promise<{ ok: true }>,
    queueStatus: () =>
      bridge().invoke(IPC.ai.queueStatus) as Promise<{ pending: number; schedulerRunning: boolean }>,
    createSkill: {
      start: (input: { prompt: string; language?: 'zh' | 'en' }) =>
        bridge().invoke(IPC.ai.createSkillStart, input) as Promise<CreateSkillStartResult>,
      startJob: (input: { prompt: string; language?: 'zh' | 'en' }) =>
        bridge().invoke(IPC.ai.createSkillStartJob, input) as Promise<AiJob<CreateSkillStartResult>>,
      get: (draftId: string) =>
        bridge().invoke(IPC.ai.createSkillGet, { draftId }) as Promise<CreateSkillDraft>,
      refine: (input: { draftId: string; skillSpec: CreateSkillSpec; targetBasename?: string }) =>
        bridge().invoke(IPC.ai.createSkillRefine, input) as Promise<CreateSkillDraft>,
      answer: (input: { draftId: string; questionId: string; answer: string }) =>
        bridge().invoke(IPC.ai.createSkillAnswer, input) as Promise<{
          draft: CreateSkillDraft;
          nextQuestion: CreateSkillQuestion | null;
          aiUsed: boolean;
        }>,
      generate: (input: { draftId: string; skillSpec?: CreateSkillSpec }) =>
        bridge().invoke(IPC.ai.createSkillGenerate, input) as Promise<CreateSkillGenerateResult>,
      review: (input: { draftId: string; markdown?: string; targetBasename?: string }) =>
        bridge().invoke(IPC.ai.createSkillReview, input) as Promise<{
          draft: CreateSkillDraft;
          review: CreateSkillReviewReport;
        }>,
      plan: (input: {
        draftId: string;
        markdown?: string;
        targetBasename: string;
        targetPlatformIds: PlatformId[];
        targetScenarioIds?: number[];
      }) => bridge().invoke(IPC.ai.createSkillPlan, input) as Promise<CreateSkillPlanResult>,
      execute: (input: { draftId: string; token: string; targetScenarioIds?: number[] }) =>
        bridge().invoke(IPC.ai.createSkillExecute, input) as Promise<CreateSkillExecuteResult>,
      discard: (draftId: string) =>
        bridge().invoke(IPC.ai.createSkillDiscard, { draftId }) as Promise<{ ok: true }>,
    },
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
    libraryOverviewGenerateJob: (language: 'zh' | 'en') =>
      bridge().invoke(IPC.ai.libraryOverviewGenerateJob, { language }) as Promise<AiJob<LibraryOverview>>,
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
