import type { Database } from 'better-sqlite3';
import * as os from 'node:os';
import * as path from 'node:path';

interface SeedPlatform {
  id: string;
  label: string;
  skillsDir: string;
  sortOrder: number;
}

const DEFAULT_PLATFORMS: SeedPlatform[] = [
  { id: 'claude', label: 'Claude Code', skillsDir: path.join(os.homedir(), '.claude', 'skills'), sortOrder: 0 },
  { id: 'codex',  label: 'Codex',       skillsDir: path.join(os.homedir(), '.codex', 'skills'),  sortOrder: 1 },
  // Label rebranded from "Shared Pool" in v0.3 — see migration v7 for legacy DBs.
  // Concept unchanged: the cross-tool ~/.agents/skills convention.
  { id: 'shared', label: 'User Agents Folder', skillsDir: path.join(os.homedir(), '.agents', 'skills'), sortOrder: 2 },
];

// Scenarios are deliberately NOT seeded. Day-0 is when AI Lens shines —
// running it once produces clusters that the user can promote to real
// scenarios. Pre-seeding 6 hardcoded zh scenarios (Writing/Coding/Ops/…)
// created a parallel ontology that AI Lens then had to fight or ignore,
// and locked English users into Chinese labels. Empty sidebar + the
// guidance banner is the cleaner Day-0 surface.

// NOTE: schema_version is intentionally NOT seeded here. The authoritative
// version is `schema_migrations` (one row per applied migration). A previous
// version of this file seeded `settings.schema_version = '5'` via INSERT OR
// IGNORE — but once a DB had been seeded at v1, that row was frozen and never
// updated, producing the misleading inspection result `schema_version=1` on
// DBs whose `schema_migrations` was actually at v5. Migration v6 deletes any
// existing stale row.
const DEFAULT_SETTINGS: Array<[string, string]> = [
  ['theme', 'system'],
  ['auto_scan_on_launch', '1'],
  ['default_sync_mode', 'symlink'],
  ['backup_retention_days', '30'],
  ['canonical_platform', 'shared'],
  // Master toggle. When '0', all outbound network calls (catalog search, LLM,
  // remote skill content) must refuse. See electron/secrets/network-gate.ts.
  ['allow_external_network', '1'],
  // LLM defaults. Provider/model/baseUrl live here; API key lives in safeStorage.
  // DeepSeek is the recommended starting point — cheap, fast, OpenAI-compatible.
  // These are seeded on first DB init only; existing installs keep whatever
  // they already had.
  ['llm.provider', 'deepseek'],
  ['llm.model', 'deepseek-v4-flash'],
  ['llm.baseUrl', ''],
  ['llm.feature.search', '0'],
  ['llm.feature.autoCategorize', '0'],
  ['llm.feature.recommend', '0'],
  // Rate-limit between auto-categorize LLM batches (ms).
  ['ai.categorize.minIntervalMs', '10000'],
];

export function seedDefaults(db: Database): void {
  const insertPlatform = db.prepare(
    `INSERT OR IGNORE INTO platforms (id, label, skills_dir, is_builtin, enabled, sort_order)
     VALUES (?, ?, ?, 1, 1, ?)`,
  );
  const insertSetting = db.prepare(
    `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`,
  );

  const tx = db.transaction(() => {
    for (const p of DEFAULT_PLATFORMS) insertPlatform.run(p.id, p.label, p.skillsDir, p.sortOrder);
    for (const [k, v] of DEFAULT_SETTINGS) insertSetting.run(k, v);
  });
  tx();
}
