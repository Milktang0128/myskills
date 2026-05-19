/**
 * OpenAI-compatible chat client. Works for:
 *   - openai      → https://api.openai.com/v1
 *   - openrouter  → https://openrouter.ai/api/v1
 *   - ollama      → http://localhost:11434/v1     (no API key)
 *   - custom      → config.baseUrl
 *
 * Anthropic uses a different API shape; see ./anthropic.ts.
 */
import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmConfig,
  LlmProvider,
} from '../../shared/types';
import type { LlmProviderClient } from './provider';
import { isExternalNetworkAllowed } from '../secrets/network-gate';

const DEFAULT_BASE_URLS: Partial<Record<LlmProvider, string>> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  ollama: 'http://localhost:11434/v1',
};

const NETWORK_DENIED_ERROR = Object.freeze({
  code: 'EXTERNAL_NETWORK_DISABLED',
  message:
    'External network is disabled in Settings. Toggle "Allow external network requests" to enable LLM calls.',
});

function resolveBaseUrl(config: LlmConfig): string {
  if (config.baseUrl && config.baseUrl.trim()) return config.baseUrl.replace(/\/+$/, '');
  const builtin = DEFAULT_BASE_URLS[config.provider];
  if (builtin) return builtin;
  throw new Error(`baseUrl is required for provider "${config.provider}"`);
}

export class OpenAiCompatibleClient implements LlmProviderClient {
  constructor(
    private readonly config: LlmConfig,
    private readonly apiKey: string | null,
  ) {}

  async chat(req: LlmChatRequest): Promise<LlmChatResponse> {
    if (!isExternalNetworkAllowed()) throw NETWORK_DENIED_ERROR;
    const baseUrl = resolveBaseUrl(this.config);
    const url = `${baseUrl}/chat/completions`;

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.2,
      max_tokens: req.maxTokens ?? 1024,
    };
    if (req.jsonMode) body.response_format = { type: 'json_object' };

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey && this.config.provider !== 'ollama') {
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    // OpenRouter recommends an HTTP-Referer + X-Title for routing/attribution.
    if (this.config.provider === 'openrouter') {
      headers['http-referer'] = 'https://myskills.local';
      headers['x-title'] = 'MySkills';
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await safeText(res);
      throw {
        code: 'LLM_HTTP_ERROR',
        message: `LLM request failed (${res.status}): ${truncate(text, 400)}`,
      };
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };
    const text = json.choices?.[0]?.message?.content ?? '';
    return {
      text,
      usage: json.usage
        ? {
            promptTokens: json.usage.prompt_tokens ?? 0,
            completionTokens: json.usage.completion_tokens ?? 0,
            totalTokens: json.usage.total_tokens ?? 0,
          }
        : undefined,
    };
  }

  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    if (!isExternalNetworkAllowed()) {
      return { ok: false, message: NETWORK_DENIED_ERROR.message };
    }
    try {
      const res = await this.chat({
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 8,
        temperature: 0,
      });
      return { ok: true, message: res.text ? `OK (${truncate(res.text, 60)})` : 'OK' };
    } catch (err) {
      const message =
        err && typeof err === 'object' && 'message' in err
          ? String((err as { message: unknown }).message)
          : String(err);
      return { ok: false, message };
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}
