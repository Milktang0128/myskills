/**
 * Electron-backed SecretStore.
 *
 * Delegates to Electron's `safeStorage`: Keychain on macOS, libsecret on
 * Linux, DPAPI on Windows. This is the only file in electron/secrets/ that
 * imports from 'electron' — the rest of the codebase talks to the
 * SecretStore interface in safe-storage.ts.
 */
import { safeStorage } from 'electron';
import type { SecretStore } from './safe-storage';

export const electronSafeStorage: SecretStore = {
  isAvailable() {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  },
  encrypt(plaintext: string): string {
    return safeStorage.encryptString(plaintext).toString('base64');
  },
  decrypt(ciphertext: string): string {
    return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'));
  },
};
