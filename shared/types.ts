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
}

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
  | 'unreadable';

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
  operation: 'sync_from_canonical' | 'promote_to_canonical';
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

export type LlmProvider = 'openai' | 'anthropic' | 'openrouter' | 'ollama' | 'custom';

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
