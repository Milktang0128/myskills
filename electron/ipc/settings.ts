import { getDb, getDbPath } from '../db';
import { registerHandler, makeError } from './dispatcher';
import { IPC } from '../../shared/ipc-channels';
import type { AppStats } from '../../shared/types';
import { cleanupOldBackups } from '../sync/backup-cleanup';

export function registerSettingsHandlers(): void {
  registerHandler(IPC.settings.get, (_e, payload) => {
    const p = payload as { key?: string };
    if (!p?.key) throw makeError('INVALID_INPUT', 'key required');
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(p.key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  });

  registerHandler(IPC.settings.set, (_e, payload) => {
    const p = payload as { key?: string; value?: string };
    if (!p?.key || typeof p.value !== 'string') throw makeError('INVALID_INPUT', 'key and value required');
    getDb()
      .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(p.key, p.value);
    return { ok: true };
  });

  registerHandler(IPC.settings.stats, () => stats());

  registerHandler(IPC.settings.cleanupBackups, () => {
    // Read the current retention setting (default 30 days). Caller doesn't
    // pass it in — the user changed it in settings, so we always read the
    // up-to-date value.
    const row = getDb()
      .prepare(`SELECT value FROM settings WHERE key = 'backup_retention_days'`)
      .get() as { value: string } | undefined;
    const days = row ? Number(row.value) : 30;
    return cleanupOldBackups(days);
  });
}

function stats(): AppStats {
  const db = getDb();
  const totalSkills = (db.prepare('SELECT COUNT(*) AS c FROM skills').get() as { c: number }).c;
  const byPlatformRows = db
    .prepare(
      `SELECT platform_id AS pid, COUNT(DISTINCT skill_id) AS c FROM skill_locations GROUP BY platform_id`,
    )
    .all() as Array<{ pid: string; c: number }>;
  const byPlatform: Record<string, number> = {};
  for (const r of byPlatformRows) byPlatform[r.pid] = r.c;

  const scenarios = (db.prepare('SELECT COUNT(*) AS c FROM scenarios').get() as { c: number }).c;
  const brokenSymlinks = (db
    .prepare('SELECT COUNT(*) AS c FROM skill_locations WHERE is_broken_link = 1')
    .get() as { c: number }).c;
  const duplicates = (db
    .prepare(
      `SELECT COUNT(*) AS c FROM skills WHERE content_hash IN (SELECT content_hash FROM skills GROUP BY content_hash HAVING COUNT(*) > 1)`,
    )
    .get() as { c: number }).c;
  const unscenarized = (db
    .prepare('SELECT COUNT(*) AS c FROM skills WHERE id NOT IN (SELECT skill_id FROM skill_scenarios)')
    .get() as { c: number }).c;
  // Fully-disabled skills: have at least one location, but none of them live.
  const disabledSkills = (db
    .prepare(
      `SELECT COUNT(*) AS c FROM skills s
       WHERE EXISTS (SELECT 1 FROM skill_locations WHERE skill_id = s.id)
         AND NOT EXISTS (SELECT 1 FROM skill_locations WHERE skill_id = s.id AND is_disabled = 0)`,
    )
    .get() as { c: number }).c;
  const lastScanRow = db
    .prepare('SELECT finished_at FROM scan_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1')
    .get() as { finished_at: number } | undefined;

  return {
    totalSkills,
    byPlatform,
    scenarios,
    brokenSymlinks,
    duplicates,
    unscenarized,
    disabledSkills,
    dbPath: getDbPath(),
    lastScanAt: lastScanRow?.finished_at ?? null,
  };
}
