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
  kind: 'broken_symlink' | 'missing_frontmatter' | 'parse_error' | 'unreadable' | 'permission';
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
 *   missing       — skill not present on this platform
 *   present       — real directory exists on this platform
 *   symlink       — symlink whose realpath matches a location on another platform
 *   symlink_other — symlink whose realpath does NOT match any tracked location
 *                   (e.g. points outside the configured roots)
 *   broken        — symlink target missing
 *   disabled      — present but moved to .disabled/ on that platform
 */
export type CoverageCellState =
  | 'missing'
  | 'present'
  | 'symlink'
  | 'symlink_other'
  | 'broken'
  | 'disabled';

export interface CoverageCell {
  state: CoverageCellState;
  installPath?: string;
  realPath?: string;
  /** Platform id of the location this symlink resolves to (when state=symlink). */
  resolvesToPlatformId?: PlatformId;
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
  /** True if the skill has a `present` cell on the shared pool, the canonical source. */
  hasSharedSource: boolean;
}

export interface CoverageMatrix {
  platforms: PlatformId[];
  rows: CoverageRow[];
}

export type CoverageFilter =
  | 'all'
  | 'gaps'                 // any platform missing
  | 'shared_not_propagated' // present in shared but missing on at least one of the other platforms
  | 'orphan'               // present on exactly one platform
  | 'broken';              // has at least one broken-link cell

/* ---------------------------------------------------------------------------
 * MVP-B sync types
 * ------------------------------------------------------------------------- */

export type SyncMode = 'symlink' | 'copy';
export type SyncAction = 'create' | 'skip' | 'replace' | 'conflict';
export type SyncConflictReason =
  | 'target_exists_dir'
  | 'target_exists_symlink_other'
  | 'target_exists_file'
  | 'source_outside_roots'
  | 'target_outside_root'
  | 'shared_pool_missing'
  | 'unreadable';

export interface SyncPlanItem {
  skillId: string;
  skillName: string;
  sourcePlatformId: PlatformId;
  sourceRealPath: string;
  targetPlatformId: PlatformId;
  targetPath: string;
  mode: SyncMode;
  action: SyncAction;
  /** Filled when action is 'conflict' or 'skip' so the UI can explain why. */
  reason?: SyncConflictReason | 'already_linked' | 'same_hash';
}

export interface SyncPlan {
  generatedAt: number;
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
