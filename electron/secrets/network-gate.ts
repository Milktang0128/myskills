/**
 * Master "Allow external network" gate.
 *
 * Reads the `allow_external_network` setting from the DB. Any module that
 * performs an outbound network call (catalog search, LLM requests, fetching
 * remote skill content) must call isExternalNetworkAllowed() first and refuse
 * with code 'EXTERNAL_NETWORK_DISABLED' when it returns false.
 *
 * Default (when the row is missing or unparseable) is true — fail-open during
 * fresh installs before seedDefaults() has run. Once the setting exists, only
 * the literal string '1' counts as "on".
 */
import { getDb } from '../db';

export const EXTERNAL_NETWORK_SETTING_KEY = 'allow_external_network';

export function isExternalNetworkAllowed(): boolean {
  try {
    const row = getDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(EXTERNAL_NETWORK_SETTING_KEY) as { value: string } | undefined;
    if (!row) return true;
    return row.value === '1';
  } catch {
    // DB not initialized yet — be permissive; the gate will work once
    // settings load. (Modules that care should also fail closed on errors.)
    return true;
  }
}
