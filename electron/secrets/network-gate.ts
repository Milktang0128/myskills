/**
 * Master "Allow external network" gate.
 *
 * Reads the `allow_external_network` setting from the DB. Any module that
 * performs an outbound network call (catalog search, LLM requests, fetching
 * remote skill content) must call isExternalNetworkAllowed() first and refuse
 * with code 'EXTERNAL_NETWORK_DISABLED' when it returns false.
 *
 * G4/P2-11 — Fail-closed semantics:
 *   - Row missing or DB error → false. The previous fail-open behavior meant
 *     a transient DB hiccup silently re-enabled outbound traffic even when
 *     the user had explicitly opted out. By the time any network call fires,
 *     seedDefaults has already inserted the row, so a missing row implies
 *     corruption / development-mode anomaly — better to lock down than leak.
 *   - Only the literal string '1' counts as "on". Everything else (including
 *     '0', null, empty string, unexpected values) → false.
 */
import { getDb } from '../db';

export const EXTERNAL_NETWORK_SETTING_KEY = 'allow_external_network';

export function isExternalNetworkAllowed(): boolean {
  try {
    const row = getDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(EXTERNAL_NETWORK_SETTING_KEY) as { value: string } | undefined;
    if (!row) return false; // fail-closed: seed should have populated this row
    return row.value === '1';
  } catch (err) {
    // DB error during read — fail closed. Better to surface "network blocked"
    // and let the user investigate than silently allow traffic they thought
    // they'd disabled.
    console.error('[network-gate] DB read failed, blocking outbound traffic:', err);
    return false;
  }
}
