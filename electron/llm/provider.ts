/**
 * LLM provider abstraction. Concrete implementations live alongside this file
 * (openai-compatible.ts, anthropic.ts). The IPC layer never branches on
 * provider — it calls createProvider() and then chat()/testConnection().
 */
import type { LlmChatRequest, LlmChatResponse, LlmConfig } from '../../shared/types';
import { OpenAiCompatibleClient } from './openai-compatible';
import { AnthropicClient } from './anthropic';

export interface LlmProviderClient {
  chat(req: LlmChatRequest): Promise<LlmChatResponse>;
  testConnection(): Promise<{ ok: boolean; message?: string }>;
}

/**
 * Build a provider client from config + (optional) API key. The key is the
 * plaintext value already decrypted by the caller (typically the IPC handler
 * via safeStorage.readSecret). Renderer code MUST NOT see this function.
 */
export function createProvider(config: LlmConfig, apiKey: string | null): LlmProviderClient {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicClient(config, apiKey);
    case 'openai':
    case 'openrouter':
    case 'ollama':
    case 'custom':
      return new OpenAiCompatibleClient(config, apiKey);
    default: {
      // Exhaustiveness guard: if we ever add a new provider literal without
      // updating this switch, TS will flag the missing case here.
      const _exhaustive: never = config.provider;
      throw new Error(`Unknown LLM provider: ${String(_exhaustive)}`);
    }
  }
}
