/**
 * IPC handlers for the LLM namespace. These are the ONLY paths the renderer
 * can use to read/write LLM config or invoke a provider. The plaintext API
 * key never crosses the bridge — it only travels renderer → main on
 * llm.setApiKey, and is read by main via safeStorage when building the
 * provider client.
 */
import { getDb } from '../db';
import { registerHandler, makeError } from './dispatcher';
import { IPC } from '../../shared/ipc-channels';
import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmConfig,
  LlmFeatureToggles,
  LlmProvider,
} from '../../shared/types';
import { createProvider } from '../llm/provider';
import {
  deleteSecret,
  hasSecret,
  readSecret,
  storeSecret,
  isAvailable as safeStorageAvailable,
} from '../secrets/safe-storage';

const API_KEY_NAME = 'llm.apiKey';

const VALID_PROVIDERS: ReadonlySet<LlmProvider> = new Set<LlmProvider>([
  'openai',
  'anthropic',
  'deepseek',
  'openrouter',
  'ollama',
  'custom',
]);

const FEATURE_KEYS = {
  search: 'llm.feature.search',
  autoCategorize: 'llm.feature.autoCategorize',
  recommend: 'llm.feature.recommend',
} as const;

function readSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function writeSetting(key: string, value: string): void {
  getDb()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(key, value);
}

function readConfig(): LlmConfig {
  const provider = (readSetting('llm.provider') ?? 'openai') as LlmProvider;
  const model = readSetting('llm.model') ?? '';
  const baseUrl = readSetting('llm.baseUrl') ?? '';
  return {
    provider: VALID_PROVIDERS.has(provider) ? provider : 'openai',
    model,
    baseUrl: baseUrl || undefined,
    hasApiKey: hasSecret(API_KEY_NAME),
  };
}

export function registerLlmHandlers(): void {
  registerHandler(IPC.llm.getConfig, () => readConfig());

  registerHandler(IPC.llm.setConfig, (_e, payload) => {
    const p = payload as Partial<{ provider: LlmProvider; model: string; baseUrl: string }>;
    if (p?.provider !== undefined) {
      if (!VALID_PROVIDERS.has(p.provider)) {
        throw makeError('INVALID_INPUT', `unknown provider "${p.provider}"`);
      }
      writeSetting('llm.provider', p.provider);
    }
    if (p?.model !== undefined) writeSetting('llm.model', String(p.model));
    if (p?.baseUrl !== undefined) writeSetting('llm.baseUrl', String(p.baseUrl));
    return readConfig();
  });

  registerHandler(IPC.llm.setApiKey, (_e, payload) => {
    const p = payload as { key?: string };
    if (typeof p?.key !== 'string' || p.key.trim() === '') {
      throw makeError('INVALID_INPUT', 'key required');
    }
    if (!safeStorageAvailable()) {
      throw makeError(
        'SAFE_STORAGE_UNAVAILABLE',
        'macOS Keychain encryption is unavailable on this system; cannot store API key.',
      );
    }
    storeSecret(API_KEY_NAME, p.key);
    return { ok: true, hasApiKey: true };
  });

  registerHandler(IPC.llm.deleteApiKey, () => {
    deleteSecret(API_KEY_NAME);
    return { ok: true, hasApiKey: false };
  });

  registerHandler(IPC.llm.chat, async (_e, payload) => {
    const p = payload as { req?: LlmChatRequest };
    if (!p?.req || !Array.isArray(p.req.messages) || p.req.messages.length === 0) {
      throw makeError('INVALID_INPUT', 'req.messages required');
    }
    const config = readConfig();
    if (!config.model) {
      throw makeError('LLM_NO_MODEL', 'No model configured. Set one in Settings → AI.');
    }
    const apiKey = readSecret(API_KEY_NAME);
    const client = createProvider(config, apiKey);
    const res: LlmChatResponse = await client.chat(p.req);
    return res;
  });

  registerHandler(IPC.llm.testConnection, async () => {
    const config = readConfig();
    if (!config.model) {
      return { ok: false, message: 'No model configured.' };
    }
    const apiKey = readSecret(API_KEY_NAME);
    const client = createProvider(config, apiKey);
    return client.testConnection();
  });

  registerHandler(IPC.llm.getFeatures, () => readFeatures());

  registerHandler(IPC.llm.setFeatures, (_e, payload) => {
    const p = payload as Partial<LlmFeatureToggles>;
    if (p?.search !== undefined) writeSetting(FEATURE_KEYS.search, p.search ? '1' : '0');
    if (p?.autoCategorize !== undefined) {
      writeSetting(FEATURE_KEYS.autoCategorize, p.autoCategorize ? '1' : '0');
    }
    if (p?.recommend !== undefined) writeSetting(FEATURE_KEYS.recommend, p.recommend ? '1' : '0');
    return readFeatures();
  });
}

function readFeatures(): LlmFeatureToggles {
  return {
    search: readSetting(FEATURE_KEYS.search) === '1',
    autoCategorize: readSetting(FEATURE_KEYS.autoCategorize) === '1',
    recommend: readSetting(FEATURE_KEYS.recommend) === '1',
  };
}
