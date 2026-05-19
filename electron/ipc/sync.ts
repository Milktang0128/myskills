import { getDb } from '../db';
import { registerHandler, makeError } from './dispatcher';
import { IPC } from '../../shared/ipc-channels';
import { planSync, executeSync, type PlanRequest } from '../sync/symlink';
import * as fs from 'node:fs';
import { scanAll } from '../scanner';
import type { SyncPlan } from '../../shared/types';

export function registerSyncHandlers(): void {
  registerHandler(IPC.sync.plan, (_e, payload) => {
    const p = payload as { requests?: PlanRequest[] };
    if (!Array.isArray(p?.requests)) throw makeError('INVALID_INPUT', 'requests[] required');
    return planSync(p.requests);
  });

  registerHandler(IPC.sync.execute, async (_e, payload) => {
    const p = payload as { plan?: SyncPlan };
    if (!p?.plan || !Array.isArray(p.plan.items)) throw makeError('INVALID_INPUT', 'plan required');
    return executeSync(p.plan);
  });

  registerHandler(IPC.sync.history, (_e, payload) => {
    const p = (payload ?? {}) as { skillId?: string; limit?: number };
    const limit = Math.min(Math.max(p.limit ?? 50, 1), 500);
    const db = getDb();
    if (p.skillId) {
      return db
        .prepare(
          `SELECT id, skill_id, action, from_path, to_path, platform_id, before_hash, after_hash,
                  backup_path, conflict_resolution, rolled_back_at, success, message, created_at
           FROM sync_history WHERE skill_id = ? ORDER BY id DESC LIMIT ?`,
        )
        .all(p.skillId, limit);
    }
    return db
      .prepare(
        `SELECT id, skill_id, action, from_path, to_path, platform_id, before_hash, after_hash,
                backup_path, conflict_resolution, rolled_back_at, success, message, created_at
         FROM sync_history ORDER BY id DESC LIMIT ?`,
      )
      .all(limit);
  });

  registerHandler(IPC.sync.rollback, async (_e, payload) => {
    const p = payload as { historyId?: number };
    if (!p?.historyId) throw makeError('INVALID_INPUT', 'historyId required');
    const db = getDb();
    const row = db
      .prepare(
        `SELECT id, action, to_path, success, rolled_back_at FROM sync_history WHERE id = ?`,
      )
      .get(p.historyId) as
      | { id: number; action: string; to_path: string; success: number; rolled_back_at: number | null }
      | undefined;
    if (!row) throw makeError('NOT_FOUND', `history ${p.historyId}`);
    if (!row.success) throw makeError('INVALID_STATE', 'cannot rollback a failed write');
    if (row.rolled_back_at) throw makeError('INVALID_STATE', 'already rolled back');

    if (row.action === 'symlink') {
      // For our first-pass executor (only creates fresh symlinks), rollback = unlink the symlink.
      try {
        const lstat = fs.lstatSync(row.to_path);
        if (!lstat.isSymbolicLink()) {
          throw makeError('UNSAFE', `${row.to_path} is no longer a symlink — refusing to rollback`);
        }
        fs.unlinkSync(row.to_path);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw makeError('ROLLBACK_FAILED', msg);
      }
    } else {
      throw makeError('UNSUPPORTED', `rollback for action=${row.action} not yet implemented`);
    }

    db.prepare('UPDATE sync_history SET rolled_back_at = ? WHERE id = ?').run(Date.now(), p.historyId);
    await scanAll();
    return { ok: true };
  });
}
