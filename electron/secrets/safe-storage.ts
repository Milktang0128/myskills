/**
 * Thin wrapper over Electron's safeStorage API. On macOS this is backed by
 * the Keychain — encrypted blobs are bound to the local user account.
 *
 * Secrets are stored in the existing `settings` table under the key
 * `secret:${name}`. The encrypted Buffer is serialized as base64 in the
 * `value` TEXT column. We deliberately reuse `settings` rather than create
 * a new table so the rest of the app's backup/restore story still covers
 * keys (and so users can wipe everything by deleting the DB).
 */
import { safeStorage } from 'electron';
import { getDb } from '../db';

const SECRET_PREFIX = 'secret:';

function settingsKey(name: string): string {
  return `${SECRET_PREFIX}${name}`;
}

export function isAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function encrypt(plaintext: string): string {
  if (!isAvailable()) {
    throw new Error('safeStorage encryption is not available on this system');
  }
  const buf = safeStorage.encryptString(plaintext);
  return buf.toString('base64');
}

export function decrypt(base64: string): string {
  if (!isAvailable()) {
    throw new Error('safeStorage encryption is not available on this system');
  }
  const buf = Buffer.from(base64, 'base64');
  return safeStorage.decryptString(buf);
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
