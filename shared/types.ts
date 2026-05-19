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
 * IPC error envelope. Main always rejects with this shape on handler error
 * so the renderer can render structured errors instead of raw Error objects.
 */
export interface IpcError {
  code: string;
  message: string;
  detail?: unknown;
}
