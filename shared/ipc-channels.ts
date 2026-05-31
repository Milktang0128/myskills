/**
 * Whitelist of IPC channel names. Both preload and main import this so the
 * set of valid channels is single-source. Anything not listed here is rejected
 * by the IPC dispatcher in main.
 */

export const IPC = {
  platforms: {
    list: 'platforms:list',
    update: 'platforms:update',
    create: 'platforms:create',
    delete: 'platforms:delete',
    probe: 'platforms:probe',
    knownCandidates: 'platforms:knownCandidates',
    openDir: 'platforms:openDir',
  },
  skills: {
    list: 'skills:list',
    get: 'skills:get',
    openLocation: 'skills:openLocation',
    copyLocationPath: 'skills:copyLocationPath',
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
    /**
     * AI Lens's sole write entry. Atomic: scenario insert (or merge into
     * existing if slug-key collides) + skill links happen in one txn.
     * The renderer never composes scenarios:create + scenarios:addSkill
     * for this — partial failure between the two would leave the user
     * with an empty named scenario, which is the worst outcome.
     */
    createFromCluster: 'scenarios:createFromCluster',
  },
  scan: {
    run: 'scan:run',
    lastResult: 'scan:lastResult',
  },
  coverage: {
    matrix: 'coverage:matrix',
  },
  sync: {
    plan: 'sync:plan',
    /**
     * Plan an enable/disable toggle for one or more skill locations. Produces
     * a SyncPlan of move items (folder ⇄ `.disabled/`) that the user confirms
     * and runs through the same sync:execute / sync:rollback path as sync.
     */
    planToggleDisabled: 'sync:planToggleDisabled',
    execute: 'sync:execute',
    history: 'sync:history',
    rollback: 'sync:rollback',
  },
  catalog: {
    search: 'catalog:search',
    preview: 'catalog:preview',
    planInstall: 'catalog:planInstall',
    /**
     * Batch-fetch SKILL.md descriptions for search results. Search returns
     * lightweight rows (no description); this enriches them via GitHub raw
     * with concurrency + in-memory cache, so the Discover list isn't a
     * bunch of names without context.
     */
    enrichDescriptions: 'catalog:enrichDescriptions',
  },
  settings: {
    get: 'settings:get',
    set: 'settings:set',
    stats: 'settings:stats',
    /** Run the backup retention sweep on demand. */
    cleanupBackups: 'settings:cleanupBackups',
  },
  llm: {
    getConfig: 'llm:getConfig',
    setConfig: 'llm:setConfig',
    setApiKey: 'llm:setApiKey',
    deleteApiKey: 'llm:deleteApiKey',
    chat: 'llm:chat',
    testConnection: 'llm:testConnection',
    getFeatures: 'llm:getFeatures',
    setFeatures: 'llm:setFeatures',
  },
  ai: {
    getSuggestionsForSkill: 'ai:getSuggestionsForSkill',
    acceptSuggestion: 'ai:acceptSuggestion',
    dismissSuggestion: 'ai:dismissSuggestion',
    queueStatus: 'ai:queueStatus',
    /** Build a bulk-categorization plan for the given skills. One LLM call. */
    bulkCategorize: 'ai:bulkCategorize',
    /** Apply a (possibly user-edited) bulk plan in a single DB transaction. */
    applyBulkCategorization: 'ai:applyBulkCategorization',
    /**
     * Library Map — get the cached AI overview snapshot (may be null) plus
     * a stale flag computed from the current skill-set hash.
     */
    libraryOverviewGet: 'ai:libraryOverview:get',
    /**
     * Generate (or regenerate) the AI library overview. Runs the LLM,
     * writes the single-row cache, returns the fresh overview.
     */
    libraryOverviewGenerate: 'ai:libraryOverview:generate',
  },
  events: {
    scanStarted: 'event:scanStarted',
    scanFinished: 'event:scanFinished',
    scanPlatformDone: 'event:scanPlatformDone',
  },
} as const;

export type IpcChannel =
  | typeof IPC.platforms[keyof typeof IPC.platforms]
  | typeof IPC.skills[keyof typeof IPC.skills]
  | typeof IPC.scenarios[keyof typeof IPC.scenarios]
  | typeof IPC.scan[keyof typeof IPC.scan]
  | typeof IPC.settings[keyof typeof IPC.settings]
  | typeof IPC.coverage[keyof typeof IPC.coverage]
  | typeof IPC.sync[keyof typeof IPC.sync]
  | typeof IPC.catalog[keyof typeof IPC.catalog]
  | typeof IPC.llm[keyof typeof IPC.llm]
  | typeof IPC.ai[keyof typeof IPC.ai];

export type IpcEventChannel = typeof IPC.events[keyof typeof IPC.events];

export const ALL_INVOKE_CHANNELS: ReadonlySet<string> = new Set<string>([
  ...Object.values(IPC.platforms),
  ...Object.values(IPC.skills),
  ...Object.values(IPC.scenarios),
  ...Object.values(IPC.scan),
  ...Object.values(IPC.settings),
  ...Object.values(IPC.coverage),
  ...Object.values(IPC.sync),
  ...Object.values(IPC.catalog),
  ...Object.values(IPC.llm),
  ...Object.values(IPC.ai),
]);

export const ALL_EVENT_CHANNELS: ReadonlySet<string> = new Set<string>(Object.values(IPC.events));
