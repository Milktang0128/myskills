/**
 * Secret storage facade.
 *
 * The interesting work is split into two layers:
 *
 *   - SecretStore (interface) — owns the actual encrypt/decrypt. Today's
 *     implementation is `ElectronSafeStorage`, which delegates to Electron's
 *     `safeStorage` API (Keychain on macOS, libsecret on Linux, DPAPI on
 *     Windows). A future CLI shell would ship a different implementation
 *     (e.g. `KeytarSecretStore` or an encrypted file) and pass it via
 *     `setSecretStore` from its bootstrap.
 *
 *   - Module-level functions (`storeSecret`/`readSecret`/etc.) — the public
 *     surface every caller already uses. They couple secrets to the existing
 *     `settings` table (where the ciphertext lives) and look up the active
 *     store. Callers don't change when the backing store changes.
 *
 * Why store the ciphertext in `settings`: backup/restore + DB-deletion-wipes-
 * everything already covers it. Adding a new table would split the user's
 * state across two locations.
 */
import { getDb } from '../db';

const SECRET_PREFIX = 'secret:';

function settingsKey(name: string): string {
  return `${SECRET_PREFIX}${name}`;
}

/**
 * Shell-agnostic secret store. Implementations decide where the key lives
 * (Keychain, libsecret, DPAPI, a plain encrypted file…). All values are
 * round-tripped as base64-encoded ciphertext strings so the DB column stays
 * TEXT and existing rows continue to work.
 */
export interface SecretStore {
  isAvailable(): boolean;
  /** Returns base64-encoded ciphertext. */
  encrypt(plaintext: string): string;
  /** Accepts base64-encoded ciphertext. */
  decrypt(ciphertext: string): string;
}

let _store: SecretStore | null = null;

/**
 * Install the active SecretStore. Called once at bootstrap. Calling twice
 * with different implementations throws — silently swapping would leave
 * already-stored ciphertext undecryptable.
 */
export function setSecretStore(store: SecretStore): void {
  if (_store && _store !== store) {
    throw new Error('setSecretStore: already initialized with a different store');
  }
  _store = store;
}

function require_(): SecretStore {
  if (!_store) {
    throw new Error('SecretStore not initialized — call setSecretStore() first');
  }
  return _store;
}

// ── Public API consumed across the codebase ────────────────────────────────

export function isAvailable(): boolean {
  try {
    return require_().isAvailable();
  } catch {
    return false;
  }
}

export function encrypt(plaintext: string): string {
  const s = require_();
  if (!s.isAvailable()) {
    throw new Error('secret store encryption is not available on this system');
  }
  return s.encrypt(plaintext);
}

export function decrypt(ciphertext: string): string {
  const s = require_();
  if (!s.isAvailable()) {
    throw new Error('secret store encryption is not available on this system');
  }
  return s.decrypt(ciphertext);
}

export function storeSecret(name: string, plaintext: string): void {
  const encrypted = encrypt(plaintext);
  getDb()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(settingsKey(name), encrypted);
}

export function readSecret(name: string): string | null {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(settingsKey(name)) as { value: string } | undefined;
  if (!row?.value) return null;
  try {
    return decrypt(row.value);
  } catch {
    // Decryption can fail if the OS keychain rotated (e.g. user reset
    // login keychain) — treat as absent rather than crashing.
    return null;
  }
}

export function deleteSecret(name: string): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(settingsKey(name));
}

/** Probe whether a secret row exists, without attempting to decrypt it. */
export function hasSecret(name: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS one FROM settings WHERE key = ?')
    .get(settingsKey(name)) as { one: number } | undefined;
  return !!row;
}
