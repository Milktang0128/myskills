/**
 * Anthropic Messages API client.
 *
 * Different from OpenAI in three ways:
 *   1. Endpoint is POST /v1/messages (not /chat/completions).
 *   2. Auth header is `x-api-key`, plus `anthropic-version` is required.
 *   3. Request body keeps `messages: [user/assistant]` but the system prompt
 *      moves to a top-level `system` string. We fold any 'system' messages
 *      together when mapping from our normalized LlmChatMessage shape.
 *
 * Response: { content: [{ type: 'text', text: '...' }, ...] }.
 */
import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmConfig,
} from '../../shared/types';
import type { LlmProviderClient } from './provider';
import { isExternalNetworkAllowed } from '../secrets/network-gate';

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

const NETWORK_DENIED_ERROR = Object.freeze({
  code: 'EXTERNAL_NETWORK_DISABLED',
  message:
    'External network is disabled in Settings. Toggle "Allow external network requests" to enable LLM calls.',
});

export class AnthropicClient implements LlmProviderClient {
  constructor(
    private readonly config: LlmConfig,
    private readonly apiKey: string | null,
  ) {}

  async chat(req: LlmChatRequest): Promise<LlmChatResponse> {
    if (!isExternalNetworkAllowed()) throw NETWORK_DENIED_ERROR;
    if (!this.apiKey) {
      throw { code: 'LLM_NO_KEY', message: 'Anthropic provider requires an API key.' };
    }

    const baseUrl = (this.config.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const url = `${baseUrl}/messages`;

    // Extract system messages (Anthropic puts them at top level, not in messages[]).
    const systemParts: string[] = [];
    const userAssistantMsgs: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const m of req.messages) {
      if (m.role === 'system') {
        systemParts.push(m.content);
      } else {
        userAssistantMsgs.push({ role: m.role, content: m.content });
      }
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature ?? 0.2,
      messages: userAssistantMsgs,
    };
    if (systemParts.length) body.system = systemParts.join('\n\n');
    // Anthropic has no response_format flag; jsonMode is encouraged via the
    // system prompt. We still forward the hint so callers can rely on the
    // contract; the helper appends a soft instruction.
    if (req.jsonMode) {
      body.system = [
        body.system,
        'Respond with a single JSON object and no surrounding prose.',
      ]
        .filter(Boolean)
        .join('\n\n');
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await safeText(res);
      throw {
        code: 'LLM_HTTP_ERROR',
        message: `Anthropic request failed (${res.status}): ${truncate(text, 400)}`,
      };
    }

    const json = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (json.content ?? [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text!)
      .join('');

    return {
      text,
      usage: json.usage
        ? {
            promptTokens: json.usage.input_tokens ?? 0,
            completionTokens: json.usage.output_tokens ?? 0,
            totalTokens: (json.usage.input_tokens ?? 0) + (json.usage.output_tokens ?? 0),
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
