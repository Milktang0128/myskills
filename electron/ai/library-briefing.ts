/**
 * Agent-facing skill library briefing generator.
 *
 * Unlike Library Overview, this does not cluster or summarize every skill.
 * It reads the current platform/location facts and asks the LLM for a
 * concise startup note that tells a future agent where the user's local
 * skill library lives and how to treat it as the default source.
 */
import { getDb } from '../db';
import { listPlatforms } from '../scanner/platforms';
import { createProvider } from '../llm/provider';
import { readSecret, hasSecret } from '../secrets/safe-storage';
import { isExternalNetworkAllowed } from '../secrets/network-gate';
import {
  VALID_LLM_PROVIDERS,
  type LibraryBriefingResult,
  type LlmConfig,
  type LlmProvider,
  type Platform,
} from '../../shared/types';

const API_KEY_NAME = 'llm.apiKey';

interface PlatformStats {
  platformId: string;
  totalLocations: number;
  enabledLocations: number;
  symlinkLocations: number;
  brokenLinks: number;
  disabledLocations: number;
}

export async function generateLibraryBriefing(language: string): Promise<LibraryBriefingResult> {
  if (!isExternalNetworkAllowed()) {
    throw makeErr('EXTERNAL_NETWORK_DISABLED', 'External network is disabled in Settings.');
  }
  if (!hasSecret(API_KEY_NAME)) {
    throw makeErr('LLM_NO_KEY', 'No LLM API key configured. Set one in Settings -> AI.');
  }
  const config = readConfig();
  if (!config.model) {
    throw makeErr('LLM_NO_MODEL', 'No LLM model configured. Set one in Settings -> AI.');
  }

  const platforms = listPlatforms();
  const stats = readPlatformStats();
  const skillCount = readTotalSkillCount();
  const canonicalPlatformId = readSetting('canonical_platform') ?? 'shared';
  const prompt = buildPrompt({ platforms, stats, skillCount, canonicalPlatformId, language });

  const apiKey = readSecret(API_KEY_NAME);
  const client = createProvider(config, apiKey);
  const res = await client.chat({
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    temperature: 0.2,
    maxTokens: 1200,
  });

  const text = cleanupText(res.text);
  if (!text) {
    throw makeErr('AI_EMPTY', 'The model returned an empty briefing.');
  }

  return {
    text,
    generatedAt: Date.now(),
    model: config.model,
    language: language === 'zh' ? 'zh' : 'en',
  };
}

function buildPrompt(input: {
  platforms: Platform[];
  stats: PlatformStats[];
  skillCount: number;
  canonicalPlatformId: string;
  language: string;
}): { system: string; user: string } {
  const outputLanguage =
    input.language === 'zh'
      ? 'Write the final briefing in Chinese.'
      : 'Write the final briefing in English.';
  const core = input.platforms.find((p) => p.id === input.canonicalPlatformId);
  const facts = {
    totalSkills: input.skillCount,
    canonicalPlatformId: input.canonicalPlatformId,
    coreLibrary: core
      ? { id: core.id, label: core.label, skillsDir: core.skillsDir, enabled: core.enabled }
      : null,
    platforms: input.platforms.map((p) => ({
      id: p.id,
      label: p.label,
      skillsDir: p.skillsDir,
      enabled: p.enabled,
      isBuiltin: p.isBuiltin,
      stats: input.stats.find((s) => s.platformId === p.id) ?? null,
    })),
  };

  return {
    system:
      'You write concise startup instructions for a coding agent that will work on the user machine.\n' +
      'Do not claim that MySkills executes skills, injects skills, or manages runtime behavior.\n' +
      'Do not produce a heavy library map. Do not list every skill. Do not include full SKILL.md bodies.\n' +
      'Use only the facts provided. If a relationship is inferred from symlink counts, describe it as "may" or "some", not as certain for every skill.\n' +
      outputLanguage,
    user:
      'Create a paste-ready note for a future agent.\n' +
      'The note should:\n' +
      '- say where the core skill library is, if present\n' +
      '- explain the known platform skill directories and symlink/shared-source relationship\n' +
      '- instruct the agent to default to the core library as its skill source\n' +
      '- instruct the agent to inspect SKILL.md and its frontmatter description before using a skill\n' +
      '- instruct the agent not to modify skill directories unless explicitly asked\n' +
      '- stay concise: roughly 150-260 words in English or 250-420 Chinese characters\n\n' +
      'Current library facts:\n' +
      JSON.stringify(facts, null, 2),
  };
}

function readPlatformStats(): PlatformStats[] {
  return getDb()
    .prepare(
      `SELECT
         platform_id AS platformId,
         COUNT(*) AS totalLocations,
         SUM(CASE WHEN is_disabled = 0 THEN 1 ELSE 0 END) AS enabledLocations,
         SUM(CASE WHEN is_symlink = 1 THEN 1 ELSE 0 END) AS symlinkLocations,
         SUM(CASE WHEN is_broken_link = 1 THEN 1 ELSE 0 END) AS brokenLinks,
         SUM(CASE WHEN is_disabled = 1 THEN 1 ELSE 0 END) AS disabledLocations
       FROM skill_locations
       GROUP BY platform_id
       ORDER BY platform_id`,
    )
    .all() as PlatformStats[];
}

function readTotalSkillCount(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS count FROM skills').get() as
    | { count: number }
    | undefined;
  return row?.count ?? 0;
}

function readConfig(): LlmConfig {
  const provider = (readSetting('llm.provider') ?? 'deepseek') as LlmProvider;
  const model = readSetting('llm.model') ?? '';
  const baseUrl = readSetting('llm.baseUrl') ?? '';
  return {
    provider: VALID_LLM_PROVIDERS.has(provider) ? provider : 'openai',
    model,
    baseUrl: baseUrl || undefined,
    hasApiKey: hasSecret(API_KEY_NAME),
  };
}

function readSetting(key: string): string | null {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get() as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function cleanupText(raw: string): string {
  return raw.trim().replace(/^```(?:text|markdown)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function makeErr(code: string, message: string): { code: string; message: string } {
  return { code, message };
}
