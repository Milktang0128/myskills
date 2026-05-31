/**
 * Shared types between Electron main process and Next.js renderer.
 * Keep this file dependency-free — it is imported by both processes.
 *
 * Mirrors SPEC §6.2 (v0.2). The renderer never sees raw DB rows; main
 * assembles these shapes from joined queries and ships them via IPC.
 */

export type BuiltInPlatformId = 'claude' | 'codex' | 'shared';
export type PlatformId = BuiltInPlatformId | string;

export interface Platform {
  id: PlatformId;
  label: string;
  skillsDir: string;
  isBuiltin: boolean;
  enabled: boolean;
  sortOrder: number;
}

export interface SkillLocation {
  id: number;
  platformId: PlatformId;
  installPath: string;
  realPath: string;
  isSymlink: boolean;
  isBrokenSymlink: boolean;
  isDisabled: boolean;
  /** SHA-256 of SKILL.md at this location; null on legacy rows before schema v2. */
  contentHash: string | null;
  /** mtime (ms) of SKILL.md at this location; null on legacy rows before schema v3. */
  mtime: number | null;
  lastSeenAt: number;
}

export interface Skill {
  id: string;
  name: string;
  sourceKey: string;
  description: string | null;
  version: string | null;
  author: string | null;
  license: string | null;
  bodyExcerpt: string | null;
  contentHash: string;
  sizeBytes: number;
  fileCount: number;
  locations: SkillLocation[];
  scenarios: ScenarioRef[];
  tags: string[];
  createdAt: number;
  updatedAt: number;
  lastScannedAt: number;
}

export interface ScenarioRef {
  id: number;
  key: string;
  name: string;
}

export interface Scenario extends ScenarioRef {
  description: string | null;
  color: string | null;
  icon: string | null;
  sortOrder: number;
  isBuiltin: boolean;
  skillCount?: number;
}

export interface SkillFilter {
  search?: string;
  platforms?: PlatformId[];
  scenarioId?: number;
  scope?: SkillScope;
  /** Sort order for the returned list. Omitted → default ('name' asc). */
  sort?: SkillSort;
}

/**
 * Sort options for the skill list.
 *   name    — alphabetical by skill name (default; stable, predictable)
 *   updated — most-recently-changed first (SKILL.md content hash bumped)
 *   created — most-recently-added first (first time MySkills saw this skill)
 *   mtime   — most-recent filesystem mtime (closest to "user edited it")
 */
export type SkillSort = 'name' | 'updated' | 'created' | 'mtime';

export type SkillScope =
  | 'all'
  | 'broken'
  | 'duplicate'
  | 'unscenarized'
  | 'disabled';

export interface ScanError {
  path: string;
  kind:
    | 'broken_symlink'
    | 'missing_frontmatter'
    | 'parse_error'
    | 'unreadable'
    | 'permission'
    | 'icloud_evicted'
    | 'too_large';
  message: string;
}

export interface ScanResult {
  totalFound: number;
  newSkills: number;
  updatedSkills: number;
  removedSkills: number;
  errors: ScanError[];
  durationMs: number;
  scannedAt: number;
}

export interface AppStats {
  totalSkills: number;
  byPlatform: Record<string, number>;
  scenarios: number;
  brokenSymlinks: number;
  duplicates: number;
  unscenarized: number;
  /** Skills with at least one location but zero *live* (non-disabled) ones —
   *  i.e. fully hidden from every agent. Drives the sidebar "Disabled" badge. */
  disabledSkills: number;
  dbPath: string;
  lastScanAt: number | null;
}

export interface ScenarioExport {
  version: '1';
  exportedAt: number;
  scenarios: {
    key: string;
    name: string;
    description: string | null;
    color: string | null;
    icon: string | null;
    skills: { name: string; sourceKey: string }[];
  }[];
}

export interface ScenarioImportResult {
  scenariosCreated: number;
  scenariosMerged: number;
  skillsLinked: number;
  skillsNotFound: { scenarioKey: string; skillName: string; sourceKey: string }[];
}

/**
 * Request body for scenarios:createFromCluster — the AI Lens's sole write
 * entry. The renderer derives `name` and `skillIds` from a
 * LibraryOverviewCluster; color is optional (AI clusters don't carry a
 * color, so the user-edits-later flow is the default).
 */
export interface CreateFromClusterRequest {
  name: string;
  skillIds: string[];
  color?: string | null;
}

/**
 * Response from scenarios:createFromCluster.
 *   - `created`  true if a new scenario was inserted, false if the slug-key
 *                already existed and we merged into it.
 *   - `skillsLinked` is the count of *newly* added (skill, scenario) pairs.
 *   - `skillsSkipped` covers two cases:
 *       a) skill was already in the scenario (idempotent re-run)
 *       b) skill id no longer exists (stale Map snapshot)
 *     The UI treats both as "already covered" — toast just shows the linked
 *     count and a quiet skipped count.
 */
export interface CreateFromClusterResult {
  scenarioId: number;
  created: boolean;
  skillsLinked: number;
  skillsSkipped: number;
}

/**
 * Per-platform cell in the coverage matrix.
 *
 *   missing        — skill not present on this platform
 *   present        — real directory exists on this platform
 *   symlink        — symlink whose realpath matches a location on the canonical
 *                    platform (the "good" symlink — in sync)
 *   symlink_other  — symlink whose realpath does NOT match the canonical
 *                    platform's location (points elsewhere or outside)
 *   broken         — symlink target missing
 *   disabled       — present but moved to .disabled/ on that platform
 */
export type CoverageCellState =
  | 'missing'
  | 'present'
  | 'symlink'
  | 'symlink_other'
  | 'broken'
  | 'disabled';

/**
 * Drift = how this cell compares to the canonical platform's hash.
 *   in_sync — same hash as canonical (or this IS canonical, or absent canonical)
 *   stale   — present but hash differs from canonical (needs replace)
 *   only_here — canonical doesn't have this skill; this cell is a promote candidate
 *   no_canonical — canonical platform is configured but skill isn't there;
 *                   cell IS present somewhere → promote candidate
 */
export type CoverageDrift = 'in_sync' | 'stale' | 'only_here' | 'no_canonical';

export interface CoverageCell {
  state: CoverageCellState;
  /** The skill_locations.id for this cell (when present). UI uses it to call
   *  adopt-as-canonical actions for stale cells. */
  locationId?: number;
  installPath?: string;
  realPath?: string;
  contentHash?: string | null;
  mtime?: number | null;
  /** Platform id this cell's symlink resolves to (when state=symlink/symlink_other). */
  resolvesToPlatformId?: PlatformId;
  drift?: CoverageDrift;
}

export interface CoverageRow {
  skillId: string;
  skillName: string;
  sourceKey: string;
  description: string | null;
  /** Keyed by PlatformId. */
  cells: Record<string, CoverageCell>;
  /** Convenience: which platforms are missing this skill (for "sync gaps" action). */
  missingOn: PlatformId[];
  /** True iff the canonical platform has this skill (a real or symlinked entry). */
  hasCanonicalSource: boolean;
  /** True if any non-canonical cell's hash differs from canonical. */
  hasDrift: boolean;
}

export interface CoverageMatrix {
  platforms: PlatformId[];
  canonicalPlatform: PlatformId;
  rows: CoverageRow[];
}

export type CoverageFilter =
  | 'all'
  | 'gaps'              // any non-canonical platform missing the skill
  | 'orphans'           // canonical doesn't have it but somewhere does
  | 'drift'             // present on canonical and elsewhere but hashes differ
  | 'broken';           // has at least one broken-link cell

/* ---------------------------------------------------------------------------
 * MVP-B sync types
 *
 * Sync is canonical-driven: there is one "canonical platform" (set in
 * settings.canonical_platform, default 'shared') whose locations are treated
 * as the source of truth. Sync produces symlinks on the other platforms that
 * resolve to the canonical location. Promotion copies an orphan from a
 * non-canonical platform into the canonical platform and replaces the
 * original with a symlink.
 * ------------------------------------------------------------------------- */

export type SyncMode = 'symlink' | 'copy';

/**
 * Each plan item is one filesystem-level action. Composite UX operations
 * (e.g. "promote orphan to canonical") expand into multiple items the user
 * confirms together.
 */
export type SyncAction =
  | 'symlink_create'           // create a symlink at target (target is absent or broken)
  | 'symlink_replace'          // backup existing target dir, then symlink_create
  | 'copy_to_canonical'        // copy source dir into canonical (promote step 1)
  // Enable/disable a single location by moving its folder between the
  // platform's live dir and its `.disabled/` subdir. The agent tool reads
  // only the live dir, so this is how a skill is hidden from / restored to
  // an agent without deleting it. Pure rename — no content change, fully
  // reversible (the move itself is the "backup").
  | 'disable'                  // move <platform>/<name>/ → <platform>/.disabled/<name>/
  | 'enable'                   // move <platform>/.disabled/<name>/ → <platform>/<name>/
  | 'skip'                     // already in sync — no FS change
  | 'conflict';                // user must resolve manually before execute

export type SyncConflictReason =
  | 'target_exists_dir'
  | 'target_exists_symlink_other'
  | 'target_exists_file'
  | 'source_outside_roots'
  | 'target_outside_root'
  | 'canonical_missing'
  | 'unsafe_target_name'
  | 'source_changed_since_plan'
  | 'unreadable'
  /**
   * Source tree contains a symbolic link. We refuse to copy any tree that
   * has internal symlinks — they could point outside the staging/source
   * area (data exfiltration in catalog installs; broken-link landmines in
   * promote) and `fs.cpSync({dereference:false})` would preserve them as-is
   * into the canonical platform. Caller must materialize the tree without
   * symlinks before retrying.
   */
  | 'source_has_symlink'
  /**
   * Target platform dir already contains an entry whose name differs only
   * in case (e.g. `MySkill` exists, planning `myskill`). macOS APFS is
   * case-preserving but case-insensitive by default, so a naive symlink-
   * create would case-fold onto the existing inode and clobber it without
   * a backup. We refuse the plan instead.
   */
  | 'case_collision'
  /**
   * Disable target is a *real directory* that one or more live symlinks on
   * other platforms point at. Moving it into `.disabled/` would orphan those
   * symlinks (the scanner drops broken links, even inside `.disabled/`). The
   * user must disable the dependent platforms first, then this one.
   */
  | 'canonical_has_dependents'
  /** Disable requested but the location is already in `.disabled/`. */
  | 'already_disabled'
  /** Enable requested but the location is already live. */
  | 'already_enabled';

export type SyncSkipReason = 'already_linked' | 'same_hash';

export interface SyncPlanItem {
  /** Human-readable label used in dialogs. */
  skillName: string;
  /** The DB id of the skill this row touches. */
  skillId: string;
  /** Operation grouping — useful when one user action expands into multiple items. */
  opGroupId: string;
  /** Filesystem-safe basename used for both source and target — comes from the actual source dir basename, not frontmatter. */
  targetBasename: string;

  sourcePlatformId: PlatformId;
  sourceLocationId: number;
  sourceRealPath: string;
  /** Identity captured at plan time, verified at execute (TOCTOU defense). */
  sourceDev: number;
  sourceIno: number;
  sourceHash: string | null;

  targetPlatformId: PlatformId;
  targetPath: string;
  targetHash: string | null;

  mode: SyncMode;
  action: SyncAction;
  reason?: SyncConflictReason | SyncSkipReason;

  /**
   * Catalog-install provenance. Set by the catalog install planner so executeSync
   * records where this skill came from. Both fields are null for plain sync /
   * promote operations originating from the user's own filesystem.
   */
  installedFromSource?: string;
  installedFromSkillId?: string;
}

export interface SyncPlan {
  /** Opaque, server-issued. Renderer must pass this back to execute. */
  token: string;
  generatedAt: number;
  /** Used to drop expired plans. */
  expiresAt: number;
  /** The intended high-level user operation, for telemetry/UI. */
  operation: 'sync_from_canonical' | 'promote_to_canonical' | 'disable' | 'enable';
  items: SyncPlanItem[];
}

export interface SyncExecuteResult {
  applied: SyncPlanItem[];
  skipped: SyncPlanItem[];
  failed: Array<{ item: SyncPlanItem; message: string }>;
}

/**
 * IPC error envelope. Main always rejects with this shape on handler error
 * so the renderer can render structured errors instead of raw Error objects.
 */
export interface IpcError {
  code: string;
  message: string;
  detail?: unknown;
}

/* ---------------------------------------------------------------------------
 * Catalog (skills.sh) types
 *
 * The catalog is queried live — no DB caching of search results. Identity in
 * the catalog is (source, skillId) where source is typically "owner/repo" on
 * GitHub and skillId is the directory basename of the skill.
 * ------------------------------------------------------------------------- */

export interface CatalogSearchResult {
  /** skills.sh-internal id. */
  id: string;
  /** Directory basename of the skill — used to fetch its SKILL.md. */
  skillId: string;
  name: string;
  installs: number;
  /** Typically "owner/repo" for GitHub-hosted skills. */
  source: string;
  /** May be absent in search results — fetch from SKILL.md for the full text. */
  description?: string;
}

export interface CatalogSearchResponse {
  query: string;
  /** skills.sh returns "fuzzy" currently. */
  searchType: string;
  skills: CatalogSearchResult[];
  count: number;
  duration_ms: number;
}

export interface CatalogPreview {
  source: string;
  skillId: string;
  rawMarkdown: string;
  frontmatter: Record<string, unknown>;
  bodyExcerpt: string | null;
}

/* ---------------------------------------------------------------------------
 * LLM provider types
 *
 * The renderer never sees the API key — it only knows whether one is stored
 * (LlmConfig.hasApiKey). Keys are written via llm.setApiKey({ key }) and
 * stored in macOS Keychain via Electron's safeStorage.
 *
 * All outbound network calls (including LLM requests) must check
 * isExternalNetworkAllowed() first; when the master toggle is off, providers
 * refuse with code 'EXTERNAL_NETWORK_DISABLED'.
 * ------------------------------------------------------------------------- */

export type LlmProvider = 'openai' | 'anthropic' | 'deepseek' | 'openrouter' | 'ollama' | 'custom';

/**
 * Single source of truth for "what providers does MySkills accept".
 *
 * Two main-process files validate provider strings before using them: the IPC
 * handler in `electron/ipc/llm.ts` and the auto-categorize service in
 * `electron/ai/categorize.ts`. Previously each kept its own private Set, and
 * a copy fell out of sync when DeepSeek was added — auto-categorize silently
 * downgraded the user's DeepSeek selection to OpenAI. Centralizing here means
 * any drift becomes a TypeScript error instead of a silent wrong-provider call.
 */
export const VALID_LLM_PROVIDERS: ReadonlySet<LlmProvider> = new Set<LlmProvider>([
  'openai',
  'anthropic',
  'deepseek',
  'openrouter',
  'ollama',
  'custom',
]);

export interface LlmConfig {
  provider: LlmProvider;
  model: string;
  /** For custom / ollama (or override). Optional for the four built-in providers. */
  baseUrl?: string;
  /** Whether a key is stored in safeStorage. The key itself is never returned. */
  hasApiKey: boolean;
}

export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmChatRequest {
  messages: LlmChatMessage[];
  /** Default 0.2. */
  temperature?: number;
  /** Default 1024. */
  maxTokens?: number;
  /** Request JSON output if true (uses response_format on OpenAI-compatible APIs). */
  jsonMode?: boolean;
}

export interface LlmChatResponse {
  text: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface LlmFeatureToggles {
  search: boolean;
  autoCategorize: boolean;
  recommend: boolean;
}

/**
 * AI-generated scenario suggestion for a skill. Rendered as a chip in the
 * skill-detail drawer; user can accept (creates a skill_scenarios link) or
 * dismiss. Only pending suggestions (accepted_at IS NULL AND dismissed_at
 * IS NULL) are returned to the renderer.
 *
 * scenarioName / scenarioColor are joined from the scenarios table for UI
 * convenience. They will be undefined if the scenario_key no longer maps to
 * an existing scenario (e.g. user deleted it after the suggestion was made).
 */
export interface AiScenarioSuggestion {
  id: number;
  skillId: string;
  scenarioKey: string;
  scenarioName?: string;
  scenarioColor?: string | null;
  reason: string | null;
  suggestedAt: number;
}

/* ---------------------------------------------------------------------------
 * Bulk AI categorization
 *
 * Triggered from the 未分类 (unscenarized) view. The user clicks one button,
 * the main process sends every unscenarized skill to the LLM in one batch,
 * and gets back a *plan*: a proposed set of new scenarios + one assignment
 * per skill. The user previews the plan in a dialog, can edit any row's
 * target (existing scenario / proposed-new / skip), can opt out of any
 * proposed-new scenario, and clicks Apply.
 *
 * The plan shape is the contract between renderer and main; it's also what
 * the UI mutates as the user edits, so it carries everything the apply step
 * needs (no second IPC roundtrip to re-fetch state).
 * ------------------------------------------------------------------------- */

/**
 * A scenario the LLM thinks the user should create — they have several
 * skills that don't fit existing buckets and would cluster cleanly into
 * a new one. Has `usedByCount` so the UI can show "version-control —
 * suggested for 7 skills".
 */
export interface BulkCategorizeProposedScenario {
  /** Lower-snake-case identifier suitable for the scenarios.key column. */
  key: string;
  /** Display name in the user's language (intent → label). */
  name: string;
  /** Short 1-sentence rationale shown in the preview UI. */
  reason: string;
  /** Hex color suggested by the LLM (optional — UI assigns a default if missing). */
  color?: string;
  /** Count of assignments in the same plan that point at this scenario. */
  usedByCount: number;
}

/** One row in the proposed plan. */
export interface BulkCategorizeAssignment {
  skillId: string;
  /** Skill name, denormalized so the UI can render without a JOIN. */
  skillName: string;
  /**
   * Target scenario. Three resolution forms:
   *   { existingScenarioId: number } — link to a scenario already in the DB.
   *   { newScenarioKey: string }     — link to a scenario in `proposedScenarios`.
   *   { skip: true }                 — leave skill unscenarized (LLM unsure).
   */
  target:
    | { kind: 'existing'; scenarioId: number }
    | { kind: 'new'; scenarioKey: string }
    | { kind: 'skip'; reason?: string };
  /** Optional 1-sentence justification for the assignment. */
  why?: string;
}

export interface BulkCategorizePlan {
  /** Optional intent summary from Phase 1 of the LLM call, for context. */
  intent?: string;
  /** New scenarios the LLM thinks should be created. */
  proposedScenarios: BulkCategorizeProposedScenario[];
  /** One row per input skill — every skill the user sent gets a row,
   *  even if its target is `skip`. */
  assignments: BulkCategorizeAssignment[];
  /** How many skills were actually classified (assignments.length minus skips). */
  classifiedCount: number;
  /** How many were left unscenarized by the LLM. */
  skippedCount: number;
}

/** Result of applying a (possibly user-edited) plan. */
export interface BulkCategorizeApplyResult {
  newScenariosCreated: number;
  assignmentsApplied: number;
  /** Rows we couldn't apply (skill deleted, scenario name conflict, etc.). */
  errors: Array<{ skillId: string; message: string }>;
}

/* ---------------------------------------------------------------------------
 * Library Overview ("Skill Map") — AI-generated read-only navigation aid.
 *
 * A single snapshot of the user's entire skill library, clustered by theme
 * with per-skill briefs. NOT the same as scenarios:
 *   - Scenarios are user-curated, persistent, written to disk via export.
 *   - Library overview is AI-derived, transient (a cache keyed by set hash),
 *     read-only — clicking a cluster doesn't create a scenario.
 *
 * Lives in the `library_overview` table as a single row (id=1) holding the
 * full JSON payload. `setHash` is a fingerprint of the skill set used to
 * generate it; the UI compares it to the live set and shows a "refresh"
 * banner if they diverge.
 * ------------------------------------------------------------------------- */

export interface LibraryOverviewSkillEntry {
  /** Skill id from the skills table. */
  skillId: string;
  /** Display name at generation time (may have drifted since). */
  name: string;
  /** AI-written ≤15-char (or chars-equivalent) one-line positioning. */
  brief: string;
}

export interface LibraryOverviewCluster {
  /** Stable slug derived from name; used as React key. */
  key: string;
  /** Display name in the user's UI language. */
  name: string;
  /** 1-2 sentence purpose statement for the cluster. */
  purpose: string;
  /** Skills in this cluster, in AI-chosen order (typically most central first). */
  skills: LibraryOverviewSkillEntry[];
}

export interface LibraryOverview {
  /** 1-2 sentence summary of the whole library, in user's language. */
  intro: string;
  clusters: LibraryOverviewCluster[];
  /** Skills the AI failed to fit anywhere — surfaced as their own group. */
  uncategorized: LibraryOverviewSkillEntry[];
  /** Total skills the AI saw at generation time. */
  totalSkills: number;
  /** Wall-clock ms when this was generated. */
  generatedAt: number;
  /** Model used (e.g. 'deepseek-v4-pro') — surfaces in the regenerate hint. */
  model: string;
  /** UI language at generation time ('zh' | 'en'). */
  language: string;
}

/** Returned by ai.libraryOverview.get — overview may be null on first launch. */
export interface LibraryOverviewSnapshot {
  overview: LibraryOverview | null;
  /** True when overview exists but the underlying skill set has changed. */
  stale: boolean;
  /** Current set hash; UI uses this to decide whether to show "Refresh". */
  currentSetHash: string;
}
