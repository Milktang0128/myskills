import type { Database } from 'better-sqlite3';
import * as os from 'node:os';
import * as path from 'node:path';

interface SeedPlatform {
  id: string;
  label: string;
  skillsDir: string;
  sortOrder: number;
}

interface SeedScenario {
  key: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  sortOrder: number;
}

const DEFAULT_PLATFORMS: SeedPlatform[] = [
  { id: 'claude', label: 'Claude Code', skillsDir: path.join(os.homedir(), '.claude', 'skills'), sortOrder: 0 },
  { id: 'codex',  label: 'Codex',       skillsDir: path.join(os.homedir(), '.codex', 'skills'),  sortOrder: 1 },
  // Label rebranded from "Shared Pool" in v0.3 — see migration v7 for legacy DBs.
  // Concept unchanged: the cross-tool ~/.agents/skills convention.
  { id: 'shared', label: 'User Agents Folder', skillsDir: path.join(os.homedir(), '.agents', 'skills'), sortOrder: 2 },
];

const DEFAULT_SCENARIOS: SeedScenario[] = [
  { key: 'writing',   name: '写作', description: '文档、文章、内容创作',     color: '#3B82F6', icon: 'PenLine',    sortOrder: 0 },
  { key: 'coding',    name: '编码', description: '软件开发、调试',           color: '#10B981', icon: 'Code2',      sortOrder: 1 },
  { key: 'ops',       name: '运维', description: '部署、监控、CI/CD',        color: '#F59E0B', icon: 'Server',     sortOrder: 2 },
  { key: 'creative',  name: '创意', description: '视觉、品牌、设计',         color: '#EC4899', icon: 'Palette',    sortOrder: 3 },
  { key: 'data',      name: '数据', description: '表格、PDF、文档处理',      color: '#8B5CF6', icon: 'Database',   sortOrder: 4 },
  { key: 'knowledge', name: '知识', description: '笔记、Obsidian、可视化',    color: '#6366F1', icon: 'BookOpen',   sortOrder: 5 },
];

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
  ['llm.provider', 'openai'],
  ['llm.model', ''],
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
  const insertScenario = db.prepare(
    `INSERT OR IGNORE INTO scenarios (key, name, description, color, icon, sort_order, is_builtin, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
  );
  const insertSetting = db.prepare(
    `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`,
  );

  const now = Date.now();
  const tx = db.transaction(() => {
    for (const p of DEFAULT_PLATFORMS) insertPlatform.run(p.id, p.label, p.skillsDir, p.sortOrder);
    for (const s of DEFAULT_SCENARIOS) insertScenario.run(s.key, s.name, s.description, s.color, s.icon, s.sortOrder, now);
    for (const [k, v] of DEFAULT_SETTINGS) insertSetting.run(k, v);
  });
  tx();
}
