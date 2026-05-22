import { getDb } from '../db';
import { registerHandler, makeError } from './dispatcher';
import { IPC } from '../../shared/ipc-channels';
import {
  planSyncFromCanonical,
  planPromoteToCanonical,
  executeSync,
  type SyncFromCanonicalRequest,
  type PromoteRequest,
} from '../sync/symlink';
import * as fs from 'node:fs';
import { scanAll } from '../scanner';
import { restoreBackup } from '../sync/backup';

/**
 * Shape used by the per-row rollback worker. Mirrors the columns the worker
 * actually touches, intentionally narrower than the full row to make the
 * function's contract obvious.
 */
interface RollbackTarget {
  id: number;
  action: string;
  from_path: string | null;
  to_path: string;
  backup_path: string | null;
}

export function registerSyncHandlers(): void {
  registerHandler(IPC.sync.plan, (_e, payload) => {
    const p = payload as
      | { kind: 'sync_from_canonical'; requests: SyncFromCanonicalRequest[] }
      | { kind: 'promote_to_canonical'; requests: PromoteRequest[] };
    if (!p || typeof p !== 'object') throw makeError('INVALID_INPUT', 'payload required');
    if (p.kind === 'sync_from_canonical') {
      if (!Array.isArray(p.requests)) throw makeError('INVALID_INPUT', 'requests[] required');
      return planSyncFromCanonical(p.requests);
    }
    if (p.kind === 'promote_to_canonical') {
      if (!Array.isArray(p.requests)) throw makeError('INVALID_INPUT', 'requests[] required');
      return planPromoteToCanonical(p.requests);
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
    // op_group_id ships down so the renderer can group rows for the
    // batch-undo UI. Legacy rows return op_group_id = NULL → they render
    // as singleton groups (one row, one undo button).
    const rows = p.skillId
      ? (db
          .prepare(
            `SELECT id, skill_id, action, from_path, to_path, platform_id, before_hash, after_hash,
                    backup_path, conflict_resolution, rolled_back_at, success, message, created_at,
                    op_group_id
             FROM sync_history WHERE skill_id = ? ORDER BY id DESC LIMIT ?`,
          )
          .all(p.skillId, limit) as Array<Record<string, unknown>>)
      : (db
          .prepare(
            `SELECT id, skill_id, action, from_path, to_path, platform_id, before_hash, after_hash,
                    backup_path, conflict_resolution, rolled_back_at, success, message, created_at,
                    op_group_id
             FROM sync_history ORDER BY id DESC LIMIT ?`,
          )
          .all(limit) as Array<Record<string, unknown>>);

    // F2/P2-9: annotate each row with whether its backup file actually exists.
    // A row that recorded a backup_path but whose file is gone (retention
    // cleanup, manual deletion, disk failure) can't roll back — let the UI
    // disable the Undo button and show "backup expired" instead of failing
    // at execute time with an obscure FS error. SQLite has no file_exists
    // primitive so we annotate in JS; the cost is one stat per row, only
    // for rows that recorded a backup.
    for (const row of rows) {
      const bp = row.backup_path as string | null;
      row.backup_orphaned = bp != null && !fs.existsSync(bp);
    }
    return rows;
  });

  /**
   * Rollback contract — user-action level, not FS-action level.
   *
   * The renderer sends ONE historyId. We look it up, find its op_group_id,
   * and undo every still-applied FS step in that group in REVERSE EXECUTION
   * ORDER (largest id first). That way symlink_replace's restore happens
   * before copy_to_canonical's cleanup — never producing an intermediate
   * "broken symlink pointing at a deleted directory" state.
   *
   * Failure semantics: each row's pre-flight FS check (still a symlink,
   * still pointing where we recorded, etc.) is independent. If row N fails,
   * we stop — rows already rolled back stay marked, the failing row and
   * everything older stay applied, and the user gets a structured error
   * naming the row id. They can investigate and retry; the next rollback
   * call will resume from where we stopped (the failing row becomes the
   * new group leader).
   *
   * Legacy rows (op_group_id IS NULL) are treated as groups of one — same
   * path, single-step, no chaining.
   */
  registerHandler(IPC.sync.rollback, async (_e, payload) => {
    const p = payload as { historyId?: number };
    if (!p?.historyId) throw makeError('INVALID_INPUT', 'historyId required');
    const db = getDb();

    const target = db
      .prepare(
        `SELECT id, op_group_id, success, rolled_back_at
         FROM sync_history WHERE id = ?`,
      )
      .get(p.historyId) as
      | { id: number; op_group_id: string | null; success: number; rolled_back_at: number | null }
      | undefined;
    if (!target) throw makeError('NOT_FOUND', `history ${p.historyId}`);
    if (!target.success) throw makeError('INVALID_STATE', 'cannot rollback a failed write');
    if (target.rolled_back_at) throw makeError('INVALID_STATE', 'already rolled back');

    // Build the list of rows to undo. For grouped operations we sweep the
    // whole group; for legacy (NULL group) the row is its own singleton.
    let rowsToRollback: RollbackTarget[];
    if (target.op_group_id) {
      rowsToRollback = db
        .prepare(
          `SELECT id, action, from_path, to_path, backup_path
           FROM sync_history
           WHERE op_group_id = ? AND success = 1 AND rolled_back_at IS NULL
           ORDER BY id DESC`,
        )
        .all(target.op_group_id) as RollbackTarget[];
    } else {
      const row = db
        .prepare(
          `SELECT id, action, from_path, to_path, backup_path
           FROM sync_history WHERE id = ?`,
        )
        .get(p.historyId) as RollbackTarget;
      rowsToRollback = [row];
    }

    const now = Date.now();
    const markRolledBack = db.prepare(
      'UPDATE sync_history SET rolled_back_at = ? WHERE id = ?',
    );

    let failure: { code: string; message: string; rowId: number } | null = null;
    for (const row of rowsToRollback) {
      try {
        rollbackOneRow(row);
        markRolledBack.run(now, row.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failure = {
          code: isIpcError(err) ? err.code : 'ROLLBACK_FAILED',
          message: isIpcError(err) ? err.message : msg,
          rowId: row.id,
        };
        break; // stop the chain — already-undone rows stay marked
      }
    }

    // Rescan regardless of partial failure so the DB reflects the actual FS.
    await scanAll();

    if (failure) {
      // Surface the failing row id so the UI can highlight what to retry.
      throw makeError(failure.code, `Row ${failure.rowId}: ${failure.message}`);
    }
    return { ok: true, rolledBack: rowsToRollback.length };
  });
}

/**
 * Per-row rollback worker. Synchronous (FS ops). Throws on FS validation
 * failure or unsupported action; the caller decides what to do with the
 * partial state.
 */
function rollbackOneRow(row: RollbackTarget): void {
  if (row.action === 'symlink_create' || row.action === 'symlink_replace') {
    // F1/P2-3: ENOENT on lstat means the symlink is already gone (user
    // deleted it externally, or a previous partial rollback removed it).
    // Treat as "already at the post-rollback state" rather than refusing —
    // we can still restore the backup if there is one, which is the
    // important half. The whole point of group rollback is to converge on
    // a clean state; refusing on missing target wedges the chain.
    let targetState: 'symlink' | 'absent' | 'other' = 'other';
    try {
      const lstat = fs.lstatSync(row.to_path);
      targetState = lstat.isSymbolicLink() ? 'symlink' : 'other';
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') targetState = 'absent';
      else throw err;
    }
    if (targetState === 'other') {
      throw makeError(
        'UNSAFE',
        `${row.to_path} is no longer a symlink — refusing to rollback`,
      );
    }
    if (targetState === 'symlink') {
      // Verify the symlink still points at what we recorded — defends against
      // the user re-pointing it manually between original sync and rollback.
      const resolved = fs.realpathSync(row.to_path);
      if (row.from_path && resolved !== row.from_path) {
        throw makeError(
          'UNSAFE',
          `${row.to_path} now points to ${resolved}, not ${row.from_path} — refusing to rollback`,
        );
      }
      fs.unlinkSync(row.to_path);
    }
    if (row.backup_path) {
      // symlink_replace path — bring back the original directory.
      // restoreBackup itself handles "target reappeared during the window"
      // by setting the conflicting content aside (`.myskills-conflict-*`).
      restoreBackup(row.backup_path, row.to_path);
    }
    return;
  }
  if (row.action === 'copy_to_canonical') {
    // Same ENOENT relaxation — the canonical copy may already be gone, in
    // which case rollback is effectively complete. Still proceed so the
    // history row gets marked rolled_back.
    try {
      const lstat = fs.lstatSync(row.to_path);
      if (lstat.isSymbolicLink()) {
        throw makeError(
          'UNSAFE',
          `${row.to_path} is unexpectedly a symlink — refusing to rollback`,
        );
      }
      fs.rmSync(row.to_path, { recursive: true, force: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
      // already gone — nothing to delete
    }
    return;
  }
  throw makeError('UNSUPPORTED', `rollback for action=${row.action} not implemented`);
}

function isIpcError(x: unknown): x is { code: string; message: string } {
  return typeof x === 'object' && x !== null && 'code' in x && 'message' in x;
}
