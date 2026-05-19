/**
 * Shared types between Electron main process and Next.js renderer.
 * Keep this file dependency-free.
 */

export type PlatformId = 'claude' | 'codex' | 'shared';

export interface Platform {
  id: PlatformId;
  label: string;
  skillsDir: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string | null;
  version: string | null;
  author: string | null;
  license: string | null;
  body: string | null;
  size: number;
  fileCount: number;
  installPath: string;
  realPath: string;
  isSymlink: boolean;
  contentHash: string;
  platforms: PlatformId[];
  scenarios: Scenario[];
  tags: string[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastScannedAt: number;
}

export interface Scenario {
  id: number;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  sortOrder: number;
  skillCount?: number;
}

export interface ScanResult {
  totalFound: number;
  newSkills: number;
  updatedSkills: number;
  removedSkills: number;
  errors: { path: string; message: string }[];
  durationMs: number;
}

export interface SkillFilter {
  search?: string;
  platforms?: PlatformId[];
  scenarioId?: number;
  tag?: string;
  enabled?: boolean;
}

export interface SyncPlan {
  skillId: string;
  fromPlatform: PlatformId;
  toPlatforms: PlatformId[];
  mode: 'copy' | 'symlink';
}

export interface SyncResult {
  succeeded: { platform: PlatformId; path: string }[];
  failed: { platform: PlatformId; message: string }[];
}

export interface AppStats {
  totalSkills: number;
  uniqueSkills: number;
  byPlatform: Record<PlatformId, number>;
  scenarios: number;
  dbPath: string;
}
