import { getDb } from '../db';
import { registerHandler, makeError } from './dispatcher';
import { IPC } from '../../shared/ipc-channels';
import {
  planSyncFromCanonical,
  planPromoteToCanonical,
  executeSync,
  type SyncFromCanonicalRequest,
} from '../sync/symlink';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { scanAll } from '../scanner';
import { restoreBackup } from '../sync/backup';

export function registerSyncHandlers(): void {
  registerHandler(IPC.sync.plan, (_e, payload) => {
    const p = payload as
      | { kind: 'sync_from_canonical'; requests: SyncFromCanonicalRequest[] }
      | { kind: 'promote_to_canonical'; skillIds: string[] };
    if (!p || typeof p !== 'object') throw makeError('INVALID_INPUT', 'payload required');
    if (p.kind === 'sync_from_canonical') {
      if (!Array.isArray(p.requests)) throw makeError('INVALID_INPUT', 'requests[] required');
      return planSyncFromCanonical(p.requests);
    }
    if (p.kind === 'promote_to_canonical') {
      if (!Array.isArray(p.skillIds)) throw makeError('INVALID_INPUT', 'skillIds[] required');
      return planPromoteToCanonical(p.skillIds);
    }
    throw makeError('INVALID_INPUT', 'unknown plan kind');
  });

  // Execute only takes a token — the plan is loaded server-side, so the
  // renderer cannot forge a different plan than the one it confirmed.
  registerHandler(IPC.sync.execute, async (_e, payload) => {
    const p = payload as { token?: string };
    if (!p?.token) throw makeError('INVALID_INPUT', 'plan token required');
    return executeSync(p.token);
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
        `SELECT id, action, from_path, to_path, backup_path, success, rolled_back_at
         FROM sync_history WHERE id = ?`,
      )
      .get(p.historyId) as
      | {
          id: number;
          action: string;
          from_path: string | null;
          to_path: string;
          backup_path: string | null;
          success: number;
          rolled_back_at: number | null;
        }
      | undefined;
    if (!row) throw makeError('NOT_FOUND', `history ${p.historyId}`);
    if (!row.success) throw makeError('INVALID_STATE', 'cannot rollback a failed write');
    if (row.rolled_back_at) throw makeError('INVALID_STATE', 'already rolled back');

    if (row.action === 'symlink_create' || row.action === 'symlink_replace') {
      try {
        const lstat = fs.lstatSync(row.to_path);
        if (!lstat.isSymbolicLink()) {
          throw makeError('UNSAFE', `${row.to_path} is no longer a symlink — refusing to rollback`);
        }
        // Verify the symlink still points at what we recorded.
        const resolved = fs.realpathSync(row.to_path);
        if (row.from_path && resolved !== row.from_path) {
          throw makeError(
            'UNSAFE',
            `${row.to_path} now points to ${resolved}, not ${row.from_path} — refusing to rollback`,
          );
        }
        fs.unlinkSync(row.to_path);
        // Restore backup if there was one (symlink_replace path).
        if (row.backup_path) {
          restoreBackup(row.backup_path, row.to_path);
        }
      } catch (err) {
        if (isIpcError(err)) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw makeError('ROLLBACK_FAILED', msg);
      }
    } else if (row.action === 'copy_to_canonical') {
      // Rollback = remove the copy. The matching symlink_replace step (which
      // produced a backup) handles its own restore in its own history row.
      try {
        const lstat = fs.lstatSync(row.to_path);
        if (lstat.isSymbolicLink()) {
          throw makeError('UNSAFE', `${row.to_path} is unexpectedly a symlink — refusing to rollback`);
        }
        fs.rmSync(row.to_path, { recursive: true, force: true });
      } catch (err) {
        if (isIpcError(err)) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw makeError('ROLLBACK_FAILED', msg);
      }
    } else {
      throw makeError('UNSUPPORTED', `rollback for action=${row.action} not implemented`);
    }

    db.prepare('UPDATE sync_history SET rolled_back_at = ? WHERE id = ?').run(Date.now(), p.historyId);
    await scanAll();
    return { ok: true };
  });
}

function isIpcError(x: unknown): x is { code: string; message: string } {
  return typeof x === 'object' && x !== null && 'code' in x && 'message' in x;
}
