#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { Window } from 'happy-dom';

const root = process.cwd();

const now = 1780243000000;
const platforms = [
  {
    id: 'shared',
    label: 'User Agents Folder',
    skillsDir: '/tmp/myskills-ui/shared',
    isBuiltin: true,
    enabled: true,
    sortOrder: 0,
  },
  {
    id: 'claude',
    label: 'Claude Code',
    skillsDir: '/tmp/myskills-ui/claude',
    isBuiltin: true,
    enabled: true,
    sortOrder: 1,
  },
  {
    id: 'codex',
    label: 'Codex',
    skillsDir: '/tmp/myskills-ui/codex',
    isBuiltin: true,
    enabled: true,
    sortOrder: 2,
  },
];

const scenarios = [
  {
    id: 1,
    key: 'research',
    name: 'Research',
    description: 'Research workflow',
    color: '#2563eb',
    icon: 'book',
    sortOrder: 1,
    isBuiltin: false,
    skillCount: 1,
  },
  {
    id: 2,
    key: 'ops',
    name: 'Ops',
    description: 'Operations workflow',
    color: '#059669',
    icon: 'terminal',
    sortOrder: 2,
    isBuiltin: false,
    skillCount: 1,
  },
];

function location(id, platformId, name, overrides = {}) {
  const disabled = overrides.isDisabled ? '/.disabled' : '';
  return {
    id,
    platformId,
    installPath: `/tmp/myskills-ui/${platformId}${disabled}/${name}`,
    realPath: `/tmp/myskills-ui/${platformId}${disabled}/${name}`,
    isSymlink: false,
    isBrokenSymlink: false,
    isDisabled: false,
    contentHash: `${name}-${platformId}`,
    mtime: now - id * 1000,
    lastSeenAt: now,
    ...overrides,
  };
}

function skill(id, name, description, locations, scenarioRefs = []) {
  return {
    id,
    name,
    sourceKey: 'local',
    description,
    version: null,
    author: null,
    license: null,
    bodyExcerpt: `Body excerpt for ${name}`,
    contentHash: `${name}-hash`,
    sizeBytes: 2048,
    fileCount: 1,
    locations,
    scenarios: scenarioRefs,
    tags: [],
    createdAt: now - 10_000,
    updatedAt: now - 5_000,
    lastScannedAt: now,
  };
}

const skillFixtures = [
  skill(
    'fixture-in-sync',
    'fixture-in-sync',
    'Same content on every platform.',
    [
      location(1, 'shared', 'fixture-in-sync', { contentHash: 'same' }),
      location(2, 'claude', 'fixture-in-sync', { contentHash: 'same' }),
      location(3, 'codex', 'fixture-in-sync', { contentHash: 'same' }),
    ],
    [{ id: 1, key: 'research', name: 'Research' }],
  ),
  skill(
    'fixture-stale',
    'fixture-stale',
    'Canonical copy for stale drift smoke.',
    [
      location(4, 'shared', 'fixture-stale', { contentHash: 'canonical' }),
      location(5, 'claude', 'fixture-stale', { contentHash: 'stale' }),
    ],
  ),
  skill(
    'fixture-claude-only',
    'fixture-claude-only',
    'Only installed on Claude.',
    [location(6, 'claude', 'fixture-claude-only', { contentHash: 'orphan' })],
    [{ id: 2, key: 'ops', name: 'Ops' }],
  ),
  skill(
    'fixture-disabled',
    'fixture-disabled',
    'Disabled skill in the shared platform.',
    [
      location(7, 'shared', 'fixture-disabled', {
        isDisabled: true,
        contentHash: 'disabled',
      }),
    ],
  ),
  skill(
    'fixture-broken',
    'fixture-broken',
    'Broken symlink on Codex.',
    [
      location(8, 'codex', 'fixture-broken', {
        isSymlink: true,
        isBrokenSymlink: true,
        contentHash: null,
      }),
    ],
  ),
];

const matrix = {
  platforms: ['shared', 'claude', 'codex'],
  canonicalPlatform: 'shared',
  rows: [
    {
      skillId: 'fixture-in-sync',
      skillName: 'fixture-in-sync',
      sourceKey: 'local',
      description: 'Same content on every platform.',
      hasCanonicalSource: true,
      hasDrift: false,
      missingOn: [],
      cells: {
        shared: { state: 'present', drift: 'in_sync', locationId: 1, contentHash: 'same', mtime: now - 1_000 },
        claude: { state: 'present', drift: 'in_sync', locationId: 2, contentHash: 'same', mtime: now - 2_000 },
        codex: { state: 'present', drift: 'in_sync', locationId: 3, contentHash: 'same', mtime: now - 3_000 },
      },
    },
    {
      skillId: 'fixture-stale',
      skillName: 'fixture-stale',
      sourceKey: 'local',
      description: 'Canonical copy for stale drift smoke.',
      hasCanonicalSource: true,
      hasDrift: true,
      missingOn: ['codex'],
      cells: {
        shared: { state: 'present', drift: 'in_sync', locationId: 4, contentHash: 'canonical', mtime: now - 4_000 },
        claude: { state: 'present', drift: 'stale', locationId: 5, contentHash: 'stale', mtime: now - 5_000 },
        codex: { state: 'missing' },
      },
    },
    {
      skillId: 'fixture-claude-only',
      skillName: 'fixture-claude-only',
      sourceKey: 'local',
      description: 'Only installed on Claude.',
      hasCanonicalSource: false,
      hasDrift: false,
      missingOn: ['shared', 'codex'],
      cells: {
        shared: { state: 'missing' },
        claude: { state: 'present', drift: 'only_here', locationId: 6, contentHash: 'orphan', mtime: now - 6_000 },
        codex: { state: 'missing' },
      },
    },
    {
      skillId: 'fixture-disabled',
      skillName: 'fixture-disabled',
      sourceKey: 'local',
      description: 'Disabled skill in the shared platform.',
      hasCanonicalSource: false,
      hasDrift: false,
      missingOn: ['claude', 'codex'],
      cells: {
        shared: { state: 'disabled', drift: 'in_sync', locationId: 7, contentHash: 'disabled', mtime: now - 7_000 },
        claude: { state: 'missing' },
        codex: { state: 'missing' },
      },
    },
    {
      skillId: 'fixture-broken',
      skillName: 'fixture-broken',
      sourceKey: 'local',
      description: 'Broken symlink on Codex.',
      hasCanonicalSource: false,
      hasDrift: true,
      missingOn: ['shared', 'claude'],
      cells: {
        shared: { state: 'missing' },
        claude: { state: 'missing' },
        codex: { state: 'broken', drift: 'stale', locationId: 8, contentHash: null, mtime: now - 8_000 },
      },
    },
  ],
};

const stats = {
  totalSkills: 5,
  byPlatform: { shared: 3, claude: 3, codex: 2 },
  scenarios: 2,
  brokenSymlinks: 1,
  duplicates: 0,
  unscenarized: 3,
  disabledSkills: 1,
  dbPath: '/tmp/myskills-ui/myskills.db',
  lastScanAt: now,
};

const settingsStore = new Map([
  ['canonical_platform', 'shared'],
  ['onboarding_completed_at', String(now)],
  ['allow_external_network', '1'],
  ['backup_retention_days', '30'],
]);

let llmFeatures = {
  search: false,
  autoCategorize: false,
  recommend: false,
  createSkill: false,
};

let llmConfig = {
  provider: 'openai',
  model: null,
  hasApiKey: false,
  baseUrl: null,
};
let migrationConfirmationPath = null;
let createSkillDraft = null;

const migrationCandidates = [
  {
    dbPath: '/Users/example/Library/Application Support/MySkills/myskills.db',
    backupRoot: '/Users/example/Library/Application Support/MySkills/backups',
    sizeBytes: 262144,
    modifiedAt: now - 3600_000,
    sourceSha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    valid: true,
    reason: null,
  },
  {
    dbPath: '/tmp/myskills-ui/invalid-electron/myskills.db',
    backupRoot: null,
    sizeBytes: 8192,
    modifiedAt: now - 7200_000,
    sourceSha256: null,
    valid: false,
    reason: 'MIGRATION_SCHEMA_INVALID: Electron DB is missing required table `skills`',
  },
];

const lastScan = {
  totalFound: 7,
  newSkills: 5,
  updatedSkills: 1,
  removedSkills: 0,
  errors: [
    {
      path: '/tmp/myskills-ui/codex/fixture-broken',
      kind: 'broken_symlink',
      message: 'Broken symlink target is missing.',
    },
    {
      path: '/tmp/myskills-ui/shared/fixture-missing-frontmatter/SKILL.md',
      kind: 'missing_frontmatter',
      message: 'SKILL.md is missing YAML frontmatter.',
    },
  ],
  durationMs: 42,
  scannedAt: now,
};

const historyRows = [
  {
    id: 102,
    skill_id: 'fixture-stale',
    action: 'symlink_create',
    from_path: '/tmp/myskills-ui/shared/fixture-stale',
    to_path: '/tmp/myskills-ui/codex/fixture-stale',
    platform_id: 'codex',
    before_hash: null,
    after_hash: 'canonical',
    backup_path: null,
    conflict_resolution: null,
    rolled_back_at: null,
    success: 1,
    message: null,
    created_at: now,
    op_group_id: 'ui-smoke-sync',
  },
  {
    id: 101,
    skill_id: 'fixture-stale',
    action: 'symlink_replace',
    from_path: '/tmp/myskills-ui/shared/fixture-stale',
    to_path: '/tmp/myskills-ui/claude/fixture-stale',
    platform_id: 'claude',
    before_hash: 'stale',
    after_hash: 'canonical',
    backup_path: '/tmp/myskills-ui/backups/fixture-stale',
    conflict_resolution: null,
    rolled_back_at: null,
    success: 1,
    message: null,
    created_at: now - 1000,
    op_group_id: 'ui-smoke-sync',
  },
];

const syncPlan = {
  token: 'ui-smoke-plan-token',
  generatedAt: now,
  expiresAt: now + 60_000,
  operation: 'sync_from_canonical',
  items: [
    syncPlanItem({
      action: 'symlink_replace',
      targetPlatformId: 'claude',
      targetPath: '/tmp/myskills-ui/claude/fixture-stale',
      targetHash: 'stale',
    }),
    syncPlanItem({
      action: 'symlink_create',
      targetPlatformId: 'codex',
      targetPath: '/tmp/myskills-ui/codex/fixture-stale',
      targetHash: null,
    }),
  ],
};

const catalogInstallPlan = {
  token: 'ui-smoke-catalog-token',
  generatedAt: now,
  expiresAt: now + 60_000,
  operation: 'promote_to_canonical',
  items: [
    {
      skillName: 'catalog-slide-builder',
      skillId: 'catalog-slide-builder',
      opGroupId: 'ui-smoke-catalog-install',
      targetBasename: 'catalog-slide-builder',
      sourcePlatformId: 'catalog',
      sourceLocationId: -1,
      sourceRealPath: '/tmp/myskills-ui/staging/catalog-slide-builder',
      sourceDev: 1,
      sourceIno: 3,
      sourceHash: 'catalog-hash',
      targetPlatformId: 'shared',
      targetPath: '/tmp/myskills-ui/shared/catalog-slide-builder',
      targetHash: null,
      mode: 'copy',
      action: 'copy_to_canonical',
      installedFromSource: 'skills/catalog',
      installedFromSkillId: 'catalog-slide-builder',
    },
  ],
};

const createSkillPlan = {
  token: 'ui-smoke-create-token',
  generatedAt: now,
  expiresAt: now + 300000,
  operation: 'create_skill',
  draftId: 'ui-smoke-create-draft',
  items: [
    {
      skillName: 'ui-smoke-created-skill',
      skillId: 'pending:create-skill:ui-smoke-create-draft',
      opGroupId: 'ui-smoke-create',
      targetBasename: 'ui-smoke-created-skill',
      sourcePlatformId: 'staging',
      sourceLocationId: -1,
      sourceRealPath: '/tmp/myskills/staging/ui-smoke-created-skill',
      sourceDev: 0,
      sourceIno: 0,
      sourceHash: 'create-hash',
      targetPlatformId: 'shared',
      targetPath: '/tmp/myskills/shared/ui-smoke-created-skill',
      targetHash: null,
      mode: 'symlink',
      action: 'copy_to_canonical',
      installedFromSource: 'create-skill',
      installedFromSkillId: 'ui-smoke-create-draft',
    },
  ],
};

function makeCreateSkillDraft(overrides = {}) {
  return {
    id: 'ui-smoke-create-draft',
    status: 'intent_draft',
    rawPrompt: 'Create a PR review checklist skill.',
    intentFrame: {
      userJob: 'Create a PR review checklist skill.',
      triggerContext: 'PR review',
      inputContract: { acceptedInputs: ['PR diff'], privacyClass: 'local_only' },
      outputContract: { artifactType: 'checklist', destination: 'reply_only' },
      workflow: { steps: ['Inspect diff', 'Check tests', 'Report risks'], failClosedRules: ['Ask before writes'] },
      stylePreferences: ['Concise'],
      nonGoals: ['Do not merge code'],
      successCriteria: ['Risks are visible'],
    },
    skillSpec: {
      name: 'ui-smoke-created-skill',
      description: 'Use when reviewing PRs for regressions and test gaps.',
      language: 'en',
      intentFrame: {
        userJob: 'Create a PR review checklist skill.',
        triggerContext: 'PR review',
        inputContract: { acceptedInputs: ['PR diff'], privacyClass: 'local_only' },
        outputContract: { artifactType: 'checklist', destination: 'reply_only' },
        workflow: { steps: ['Inspect diff', 'Check tests', 'Report risks'], failClosedRules: ['Ask before writes'] },
        stylePreferences: ['Concise'],
        nonGoals: ['Do not merge code'],
        successCriteria: ['Risks are visible'],
      },
      needsNetwork: false,
      writesFiles: false,
      overwritePolicy: 'never',
      ready: true,
      missing: [],
    },
    followupQuestions: [
      {
        id: 'strictness',
        question: 'How cautious should it be before taking action?',
        options: [
          { id: 'confirm', label: 'Confirm writes', effect: 'strictness=confirm' },
          { id: 'ask_when_unclear', label: 'Ask when unclear', effect: 'strictness=ask_when_unclear' },
        ],
        allowFreeform: true,
      },
    ],
    answers: {},
    draftMarkdown: null,
    targetPlatformIds: [],
    targetScenarioIds: [],
    targetBasename: 'ui-smoke-created-skill',
    validation: null,
    planToken: null,
    installedSkillId: null,
    createdAt: now,
    updatedAt: now,
    installedAt: null,
    discardedAt: null,
    ...overrides,
  };
}

function syncPlanItem(overrides) {
  return {
    skillName: 'fixture-stale',
    skillId: 'fixture-stale',
    opGroupId: 'ui-smoke-sync',
    targetBasename: 'fixture-stale',
    sourcePlatformId: 'shared',
    sourceLocationId: 4,
    sourceRealPath: '/tmp/myskills-ui/shared/fixture-stale',
    sourceDev: 1,
    sourceIno: 2,
    sourceHash: 'canonical',
    mode: 'symlink',
    ...overrides,
  };
}

function filteredSkills(payload = {}) {
  let out = [...skillFixtures];
  const q = typeof payload.search === 'string' ? payload.search.trim().toLowerCase() : '';
  if (q) {
    out = out.filter(
      (skill) =>
        skill.name.toLowerCase().includes(q) ||
        (skill.description ?? '').toLowerCase().includes(q),
    );
  }
  if (Array.isArray(payload.platforms) && payload.platforms.length > 0) {
    out = out.filter((skill) =>
      skill.locations.some(
        (location) => payload.platforms.includes(location.platformId) && !location.isDisabled,
      ),
    );
  }
  if (typeof payload.scenarioId === 'number') {
    out = out.filter((skill) => skill.scenarios.some((scenario) => scenario.id === payload.scenarioId));
  }
  if (payload.scope === 'unscenarized') {
    out = out.filter((skill) => skill.scenarios.length === 0);
  } else if (payload.scope === 'disabled') {
    out = out.filter(
      (skill) => skill.locations.length > 0 && skill.locations.every((location) => location.isDisabled),
    );
  } else if (payload.scope === 'broken') {
    out = out.filter((skill) => skill.locations.some((location) => location.isBrokenSymlink));
  } else if (payload.scope === 'duplicate') {
    out = [];
  }
  return out;
}

function invoke(command, payload = {}) {
  switch (command) {
    case 'platforms_list':
      return Promise.resolve(platforms);
    case 'scenarios_list':
      return Promise.resolve(scenarios);
    case 'settings_stats':
      return Promise.resolve(stats);
    case 'settings_get':
      return Promise.resolve(settingsStore.get(payload.key) ?? null);
    case 'settings_set':
      settingsStore.set(payload.key, payload.value);
      return Promise.resolve({ ok: true });
    case 'settings_cleanup_backups':
      return Promise.resolve({ deletedDirs: 1, deletedBytes: 2048, nulledRows: 1, remainingBytes: 4096 });
    case 'migration_discover':
      return Promise.resolve(migrationCandidates);
    case 'migration_confirm':
      migrationConfirmationPath = '/tmp/myskills-ui/stable-migration-confirmation.json';
      return Promise.resolve({
        ok: true,
        confirmationPath: migrationConfirmationPath,
        restartRequired: true,
      });
    case 'scan_last_result':
      return Promise.resolve(lastScan);
    case 'scan_run':
      return Promise.resolve(lastScan);
    case 'platforms_known_candidates':
      return Promise.resolve([
        {
          id: 'opencode',
          label: 'OpenCode',
          defaultDir: '/tmp/myskills-ui/opencode',
          description: 'OpenCode skills directory.',
        },
      ]);
    case 'platforms_probe':
      return Promise.resolve({
        resolvedPath: payload.path,
        exists: false,
        readable: false,
        skillCount: 0,
        alreadyRegistered: false,
      });
    case 'skills_list':
      return Promise.resolve(filteredSkills(payload));
    case 'skills_get':
      return Promise.resolve(skillFixtures.find((skill) => skill.id === payload.id) ?? skillFixtures[0]);
    case 'coverage_matrix':
      return Promise.resolve(matrix);
    case 'catalog_search':
      return Promise.resolve({
        query: payload.q ?? 'skill',
        searchType: 'fuzzy',
        count: 2,
        duration_ms: 12,
        skills: [
          {
            id: 'catalog-slide-builder',
            skillId: 'catalog-slide-builder',
            name: 'catalog-slide-builder',
            source: 'skills/catalog',
            description: 'Build slide decks from markdown.',
            installs: 2400,
          },
          {
            id: 'fixture-in-sync',
            skillId: 'fixture-in-sync',
            name: 'fixture-in-sync',
            source: 'skills/catalog',
            description: 'Already installed local fixture.',
            installs: 1200,
          },
        ],
      });
    case 'catalog_enrich_descriptions':
      return Promise.resolve(
        (payload.items ?? []).map((item) => ({
          source: item.source,
          skillId: item.skillId,
          description:
            item.skillId === 'catalog-slide-builder'
              ? 'Build slide decks from markdown.'
              : 'Already installed local fixture.',
        })),
      );
    case 'catalog_preview':
      return Promise.resolve({
        source: payload.source,
        skillId: payload.skillId,
        rawMarkdown:
          '---\nname: catalog-slide-builder\ndescription: Build slide decks from markdown.\n---\n\nUse this skill to draft slide decks from markdown outlines.\n',
        frontmatter: {
          name: 'catalog-slide-builder',
          description: 'Build slide decks from markdown.',
        },
        bodyExcerpt: 'Use this skill to draft slide decks from markdown outlines.',
      });
    case 'catalog_plan_install':
      return Promise.resolve(catalogInstallPlan);
    case 'sync_plan':
      return Promise.resolve(syncPlan);
    case 'sync_execute':
      return Promise.resolve({ applied: syncPlan.items, skipped: [], failed: [] });
    case 'sync_history':
      return Promise.resolve(historyRows);
    case 'llm_get_config':
      return Promise.resolve(llmConfig);
    case 'llm_set_config':
      llmConfig = {
        ...llmConfig,
        provider: payload.provider ?? llmConfig.provider,
        model: payload.model ?? null,
        baseUrl: payload.baseUrl ?? null,
      };
      return Promise.resolve(llmConfig);
    case 'llm_set_api_key':
      if (!payload.key || String(payload.key).length < 4) {
        return Promise.reject({ code: 'INVALID_INPUT', message: 'API key required' });
      }
      llmConfig = { ...llmConfig, hasApiKey: true };
      return Promise.resolve({ ok: true, hasApiKey: true });
    case 'llm_delete_api_key':
      llmConfig = { ...llmConfig, hasApiKey: false };
      return Promise.resolve({ ok: true, hasApiKey: false });
    case 'llm_get_features':
      return Promise.resolve(llmFeatures);
    case 'llm_set_features':
      llmFeatures = { ...llmFeatures, ...payload };
      return Promise.resolve(llmFeatures);
    case 'llm_test_connection':
      return Promise.resolve({ ok: false, message: 'network disabled in UI smoke' });
    case 'ai_create_skill_start':
      createSkillDraft = makeCreateSkillDraft({ rawPrompt: payload.prompt });
      return Promise.resolve({ draft: createSkillDraft, aiUsed: false });
    case 'ai_create_skill_refine':
      createSkillDraft = makeCreateSkillDraft({
        ...createSkillDraft,
        status: 'spec_ready',
        skillSpec: payload.skillSpec,
        intentFrame: payload.skillSpec.intentFrame,
        targetBasename: payload.targetBasename,
      });
      return Promise.resolve(createSkillDraft);
    case 'ai_create_skill_answer':
      createSkillDraft = makeCreateSkillDraft({
        ...createSkillDraft,
        status: 'spec_ready',
        answers: { ...(createSkillDraft?.answers ?? {}), [payload.questionId]: payload.answer },
      });
      return Promise.resolve({ draft: createSkillDraft, nextQuestion: null, aiUsed: false });
    case 'ai_create_skill_generate':
      createSkillDraft = makeCreateSkillDraft({
        ...createSkillDraft,
        status: 'artifact_draft',
        draftMarkdown:
          '---\nname: ui-smoke-created-skill\ndescription: Use when reviewing PRs for regressions and test gaps.\n---\n\n# ui-smoke-created-skill\n\n## Inputs\n\n- PR diff\n\n## Workflow\n\n1. Inspect diff\n2. Check tests\n3. Report risks\n\n## Output\n\n- Checklist\n\n## Boundaries\n\n- Ask before writes\n\n## Quality Bar\n\n- Risks are visible\n',
        validation: {
          blocking: [],
          warnings: [],
          checks: {
            safeName: true,
            parseableFrontmatter: true,
            sizeUnderLimit: true,
            triggerDescription: true,
            hasInputs: true,
            hasWorkflow: true,
            hasOutput: true,
            hasBoundaries: true,
            hasQualityBar: true,
            conciseBody: true,
            frontmatterOnlyNameDescription: true,
            nameMatchesBasename: true,
            nameIsKebabCase: true,
            noPrivateFields: true,
            noSilentNetwork: true,
            noSilentOverwrite: true,
            noSecretExfiltration: true,
            noDangerousShellDefault: true,
          },
        },
      });
      return Promise.resolve({ draft: createSkillDraft, aiUsed: false });
    case 'ai_create_skill_review':
      createSkillDraft = makeCreateSkillDraft({
        ...createSkillDraft,
        status: 'reviewed',
        draftMarkdown: payload.markdown,
        validation: {
          blocking: [],
          warnings: [],
          checks: {
            safeName: true,
            parseableFrontmatter: true,
            sizeUnderLimit: true,
            triggerDescription: true,
            hasInputs: true,
            hasWorkflow: true,
            hasOutput: true,
            hasBoundaries: true,
            hasQualityBar: true,
            conciseBody: true,
            frontmatterOnlyNameDescription: true,
            nameMatchesBasename: true,
            nameIsKebabCase: true,
            noPrivateFields: true,
            noSilentNetwork: true,
            noSilentOverwrite: true,
            noSecretExfiltration: true,
            noDangerousShellDefault: true,
          },
        },
      });
      return Promise.resolve({ draft: createSkillDraft, review: createSkillDraft.validation });
    case 'ai_create_skill_plan':
      createSkillDraft = makeCreateSkillDraft({
        ...createSkillDraft,
        status: 'planned',
        planToken: createSkillPlan.token,
        targetPlatformIds: payload.targetPlatformIds,
        targetScenarioIds: payload.targetScenarioIds ?? [],
      });
      return Promise.resolve({ draft: createSkillDraft, plan: createSkillPlan });
    case 'ai_create_skill_execute':
      createSkillDraft = makeCreateSkillDraft({
        ...createSkillDraft,
        status: 'installed',
        installedSkillId: 'skill-created-ui-smoke',
        installedAt: now,
      });
      return Promise.resolve({
        draft: createSkillDraft,
        sync: { applied: createSkillPlan.items, skipped: [], failed: [] },
        scan: { totalFound: 6, newSkills: 1, updatedSkills: 0, removedSkills: 0, errors: [], durationMs: 12, scannedAt: now },
        skillId: 'skill-created-ui-smoke',
        warnings: [],
      });
    case 'ai_library_overview_get':
      return Promise.resolve({ overview: null, language: payload.language ?? 'en', generatedAt: null });
    case 'scenarios_export':
      return Promise.resolve({
        version: '1',
        exportedAt: now,
        scenarios: scenarios.map((scenario) => ({
          key: scenario.key,
          name: scenario.name,
          description: scenario.description,
          color: scenario.color,
          icon: scenario.icon,
          skills: filteredSkills({ scenarioId: scenario.id }).map((skill) => ({
            name: skill.name,
            sourceKey: skill.sourceKey,
          })),
        })),
      });
    default:
      return Promise.resolve({ ok: true });
  }
}

function normalizeText(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function text() {
  return normalizeText(document.body.textContent ?? '');
}

async function waitFor(label, predicate, timeoutMs = 3000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      if (predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}\n\n${text()}`);
}

function expectText(label, expected) {
  const bodyText = text();
  if (!bodyText.includes(expected)) {
    throw new Error(`Expected ${label} to include "${expected}"\n\n${bodyText}`);
  }
}

function expectNoText(label, unexpected) {
  const bodyText = text();
  if (bodyText.includes(unexpected)) {
    throw new Error(`Expected ${label} not to include "${unexpected}"\n\n${bodyText}`);
  }
}

function clickButton(label) {
  const buttons = [...document.querySelectorAll('button')];
  const button = buttons.find((candidate) => {
    if (candidate.disabled) return false;
    const candidateText = normalizeText(candidate.textContent ?? '');
    return candidate.getAttribute('aria-label') === label || candidateText === label || candidateText.includes(label);
  });
  if (!button) {
    throw new Error(`Could not find button "${label}"\n\n${text()}`);
  }
  button.click();
}

function hasEnabledButton(label) {
  return [...document.querySelectorAll('button')].some((candidate) => {
    if (candidate.disabled) return false;
    const candidateText = normalizeText(candidate.textContent ?? '');
    return candidate.getAttribute('aria-label') === label || candidateText === label || candidateText.includes(label);
  });
}

function setInputValue(id, value) {
  const input = document.getElementById(id);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Could not find input #${id}\n\n${text()}`);
  }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  input.focus();
  setter?.call(input, value);
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function setTextareaBySmokeAction(action, value) {
  const textarea = document.querySelector(`textarea[data-smoke-action="${action}"]`);
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error(`Could not find textarea [data-smoke-action="${action}"]\n\n${text()}`);
  }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  textarea.focus();
  setter?.call(textarea, value);
  textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
}

function setSelectValue(id, value) {
  const select = document.getElementById(id);
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error(`Could not find select #${id}\n\n${text()}`);
  }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function expectInputPlaceholder(id, expected) {
  const input = document.getElementById(id);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Could not find input #${id}\n\n${text()}`);
  }
  if (!input.placeholder.includes(expected)) {
    throw new Error(`Expected #${id} placeholder to include "${expected}", got "${input.placeholder}"`);
  }
}

function clickRoleButtonText(label) {
  const buttons = [...document.querySelectorAll('[role="button"]')];
  const button = buttons.find((candidate) => normalizeText(candidate.textContent ?? '').includes(label));
  if (!button) {
    throw new Error(`Could not find role=button containing "${label}"\n\n${text()}`);
  }
  button.click();
}

async function renderWorkspace() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myskills-ui-smoke-'));
  const entry = path.join(tempRoot, 'entry.tsx');
  const bundle = path.join(tempRoot, 'bundle.mjs');
  fs.writeFileSync(
    entry,
    [
      "import React from 'react';",
      "import { createRoot } from 'react-dom/client';",
      `import Workspace from ${JSON.stringify(path.join(root, 'src/app/page.tsx'))};`,
      `import { I18nProvider } from ${JSON.stringify(path.join(root, 'src/lib/i18n.tsx'))};`,
      "createRoot(document.getElementById('root')).render(<I18nProvider><Workspace /></I18nProvider>);",
      '',
    ].join('\n'),
  );

  await esbuild.build({
    entryPoints: [entry],
    outfile: bundle,
    absWorkingDir: root,
    nodePaths: [path.join(root, 'node_modules')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
    plugins: [uiSmokePlugin()],
  });

  const window = new Window({
    url: 'http://myskills-ui-smoke.local/',
    settings: { disableJavaScriptFileLoading: true },
  });
  installGlobal('window', window);
  installGlobal('document', window.document);
  installGlobal('navigator', window.navigator);
  installGlobal('localStorage', window.localStorage);
  installGlobal('HTMLElement', window.HTMLElement);
  installGlobal('HTMLButtonElement', window.HTMLButtonElement);
  installGlobal('HTMLInputElement', window.HTMLInputElement);
  installGlobal('HTMLTextAreaElement', window.HTMLTextAreaElement);
  installGlobal('HTMLSelectElement', window.HTMLSelectElement);
  installGlobal('Node', window.Node);
  installGlobal('Event', window.Event);
  installGlobal('InputEvent', window.InputEvent);
  installGlobal('MouseEvent', window.MouseEvent);
  installGlobal('CustomEvent', window.CustomEvent);
  installGlobal('MutationObserver', window.MutationObserver);
  installGlobal('ResizeObserver', window.ResizeObserver);
  installGlobal('NodeFilter', window.NodeFilter);
  installGlobal('getComputedStyle', window.getComputedStyle.bind(window));
  installGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(Date.now()), 0));
  installGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
  window.confirm = () => true;
  globalThis.__MYSKILLS_UI_SMOKE__ = {
    invoke,
    listen: () => () => {},
  };
  window.localStorage.setItem('myskills.locale', 'en');
  document.body.innerHTML = '<div id="root"></div>';

  await import(pathToFileURL(bundle).href);
  return () => fs.rmSync(tempRoot, { recursive: true, force: true });
}

function uiSmokePlugin() {
  return {
    name: 'ui-smoke',
    setup(build) {
      build.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({
        path: 'tauri-core',
        namespace: 'ui-smoke',
      }));
      build.onResolve({ filter: /^@tauri-apps\/api\/event$/ }, () => ({
        path: 'tauri-event',
        namespace: 'ui-smoke',
      }));
      build.onResolve({ filter: /^@tauri-apps\/api\/app$/ }, () => ({
        path: 'tauri-app',
        namespace: 'ui-smoke',
      }));
      build.onResolve({ filter: /^@tauri-apps\/plugin-updater$/ }, () => ({
        path: 'tauri-updater',
        namespace: 'ui-smoke',
      }));
      build.onResolve({ filter: /^@tauri-apps\/plugin-process$/ }, () => ({
        path: 'tauri-process',
        namespace: 'ui-smoke',
      }));
      build.onResolve({ filter: /^@\// }, (args) => ({
        path: resolveSourcePath(path.join(root, 'src', args.path.slice(2))),
      }));
      build.onResolve({ filter: /^@shared\// }, (args) => ({
        path: resolveSourcePath(path.join(root, 'shared', args.path.slice('@shared/'.length))),
      }));
      build.onLoad({ filter: /.*/, namespace: 'ui-smoke' }, (args) => {
        if (args.path === 'tauri-core') {
          return {
            loader: 'js',
            contents:
              'export class Resource {} export class Channel {} export async function invoke(command, options = {}) { return globalThis.__MYSKILLS_UI_SMOKE__.invoke(command, options.payload ?? {}); }',
          };
        }
        if (args.path === 'tauri-app') {
          return {
            loader: 'js',
            contents: 'export async function getVersion() { return "0.2.0-tauri.0"; }',
          };
        }
        if (args.path === 'tauri-updater') {
          return {
            loader: 'js',
            contents: 'export async function check() { return null; }',
          };
        }
        if (args.path === 'tauri-process') {
          return {
            loader: 'js',
            contents: 'export async function relaunch() {}',
          };
        }
        return {
          loader: 'js',
          contents:
            'export async function listen(channel, cb) { return globalThis.__MYSKILLS_UI_SMOKE__.listen(channel, cb); }',
        };
      });
    },
  };
}

function resolveSourcePath(basePath) {
  if (fs.existsSync(basePath)) return basePath;
  for (const ext of ['.tsx', '.ts', '.jsx', '.js']) {
    const candidate = `${basePath}${ext}`;
    if (fs.existsSync(candidate)) return candidate;
  }
  return basePath;
}

function installGlobal(key, value) {
  Object.defineProperty(globalThis, key, {
    value,
    configurable: true,
    writable: true,
  });
}

const consoleErrors = [];
const originalError = console.error;
console.error = (...args) => {
  consoleErrors.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
  originalError(...args);
};

const cleanup = await renderWorkspace();
try {
  await waitFor('coverage matrix rows', () => text().includes('Main source:') && text().includes('fixture-in-sync'));
  expectText('coverage matrix', 'Main source:');
  expectText('coverage matrix', 'User Agents Folder');
  expectText('coverage matrix', 'Claude Code');
  expectText('coverage matrix', 'Codex');
  expectText('coverage matrix', 'fixture-stale');
  expectText('coverage matrix', 'fixture-broken');
  expectText('coverage matrix', 'Sync 2 total');
  expectText('coverage matrix', 'Manage sync');
  expectText('coverage matrix', 'Disabled');

  clickButton('Sync 2 total');
  await waitFor('sync confirm dialog', () => text().includes('Sync from main source'));
  expectText('sync confirm', '2 writes');
  expectText('sync confirm', 'backup then replace');
  expectText('sync confirm', 'new copy');
  expectText('sync confirm', 'Apply 2 writes');
  expectText('sync confirm', 'You can roll this back anytime from Sync history');
  clickButton('Cancel');
  await waitFor('sync confirm close', () => !text().includes('Apply 2 writes'));

  clickButton('Broken');
  await waitFor('broken filter', () => text().includes('fixture-broken'));
  expectNoText('broken-filtered matrix', 'fixture-stale');

  clickButton('Orphans');
  await waitFor('orphan filter', () => text().includes('fixture-claude-only'));
  expectNoText('orphan-filtered matrix', 'fixture-stale');

  clickButton('All Skills');
  await waitFor('library list rows', () => text().includes('fixture-stale'));
  expectText('library list', '5 skills');
  expectText('library list', 'Same content on every platform.');
  expectText('library list', 'Research');
  expectText('library list', 'Ops');

  clickButton('Scenarios');
  await waitFor('kanban rows', () => text().includes('Untagged'));
  expectText('kanban', 'Research');
  expectText('kanban', 'Ops');
  expectText('kanban', 'fixture-in-sync');
  expectText('kanban', 'fixture-claude-only');

  clickButton('Discover');
  await waitFor('discover popular results', () => text().includes('Popular on skills.sh') && text().includes('catalog-slide-builder'));
  expectText('discover keyword results', 'via skills.sh');
  expectText('discover keyword results', 'Build slide decks from markdown.');
  expectText('discover installed badge', 'Installed');
  clickButton('catalog-slide-builder');
  await waitFor('discover preview', () => text().includes('Preview from skills.sh') && text().includes('SKILL.md'));
  expectText('discover preview', 'Install to');
  expectText('discover preview', 'main source');
  expectText('discover preview', 'Use this skill to draft slide decks from markdown outlines.');
  clickButton('Install to 1 platform');
  await waitFor('discover install plan', () => text().includes('Move to main source'));
  expectText('discover install plan', 'copy into main source');
  expectText('discover install plan', 'Apply 1 write');
  clickButton('Cancel');
  await waitFor('discover install plan close', () => !text().includes('Apply 1 write'));

  clickButton('Create Skill');
  await waitFor('create skill view', () => text().includes('Create Skill') && text().includes('Generate outline'));
  setTextareaBySmokeAction('create-skill-input', 'Create a PR review checklist skill.');
  clickButton('Generate outline');
  await waitFor('create skill outline', () => text().includes('Directory / skill name') && text().includes('ui-smoke-created-skill'));
  clickButton('Continue questions');
  await waitFor('create skill question', () => text().includes('How cautious should it be before taking action?'));
  clickButton('Confirm writes');
  await waitFor('create skill questions done', () => text().includes('Key questions are answered. Generate the draft next.'));
  clickButton('Generate SKILL.md');
  await waitFor('create skill draft', () => text().includes('SKILL.md') && text().includes('Local safety checks passed'));
  clickButton('Review draft');
  await waitFor('create skill review', () => text().includes('Local safety checks passed'));
  await waitFor('create skill plan button enabled', () => hasEnabledButton('Create install plan'));
  clickButton('Create install plan');
  await waitFor('create skill plan', () => text().includes('Create skill') && text().includes('Apply 1 write'));
  clickButton('Apply 1 write');
  await waitFor('create skill done', () => text().includes('Skill was written, scanned, and added to the library.'));

  clickButton('Manage scenarios');
  await waitFor('scenarios view', () => text().includes('New') && text().includes('Research workflow'));
  expectText('scenarios view', 'Import');
  expectText('scenarios view', 'Export');
  clickRoleButtonText('Research');
  await waitFor('scenario detail', () => text().includes('Skills in this scenario (1)'));
  expectText('scenario detail', 'fixture-in-sync');
  expectText('scenario recommendations gate', 'Enable AI Recommendations in Settings to see suggestions.');

  clickButton('Sync history');
  await waitFor('history view', () => text().includes('2 entries'));
  expectText('history view', 'symlink_replace');
  expectText('history view', 'symlink_create');
  expectText('history view', 'backup →');
  expectText('history view', 'Rollback');

  clickButton('Settings');
  await waitFor('settings view', () => text().includes('Allow external network requests'));
  expectText('settings view', 'Platforms');
  expectText('settings view', 'App updates');
  expectText('settings view', 'Check for updates');
  expectText('settings view', 'Network enabled');
  expectText('settings view', 'AI integration');
  expectText('settings migration discovery', 'Electron migration');
  expectText('settings migration discovery', '1 valid of 2 candidate DBs');
  expectText('settings migration discovery', 'read-only');
  expectText('settings migration discovery', 'Valid Electron database');
  expectText('settings migration discovery', 'Invalid candidate');
  clickButton('Confirm for next launch');
  await waitFor('migration confirmation saved', () =>
    text().includes('Confirmation saved') && migrationConfirmationPath !== null,
  );
  expectText('settings view', 'Scan errors (2)');
  expectText('settings view', 'Broken copy');
  expectText('settings view', 'Stats');
  setSelectValue('llm-provider', 'openai');
  setInputValue('llm-model', 'gpt-4o-mini');
  clickButton('Save');
  setInputValue('llm-key', 'sk-ui-smoke-secret');
  await waitFor('save API key button', () => text().includes('Save API key'));
  clickButton('Save API key');
  await waitFor('api key write-only placeholder', () => {
    const input = document.getElementById('llm-key');
    return input instanceof HTMLInputElement && input.placeholder.includes('saved in the OS credential store');
  });
  expectInputPlaceholder('llm-key', 'saved in the OS credential store');
  expectNoText('api key write-only UI', 'sk-ui-smoke-secret');
  clickButton('Use AI for catalog search (Discover)');
  await waitFor('AI search feature enabled', () => llmFeatures.search === true);
  clickButton('Suggest scenarios for new skills (auto-categorize)');
  await waitFor('auto categorize feature enabled', () => llmFeatures.autoCategorize === true);
  clickButton('Recommend missing skills for active scenarios');
  await waitFor('recommend feature enabled', () => llmFeatures.recommend === true);
  clickButton('Assist Create Skill with outlines, questions, and drafts');
  await waitFor('create skill feature enabled', () => llmFeatures.createSkill === true);
  clickButton('Test connection');
  await waitFor('LLM test result', () => text().includes('Failed: network disabled in UI smoke'));
  clickButton('Allow external network requests');
  await waitFor('network toggle', () => text().includes('Offline mode'));
  clickButton('Discover');
  await waitFor('discover offline gate', () => text().includes('External network is disabled in Settings'));
  expectText('discover offline gate', 'Enable external network access in Settings to browse the catalog.');

  if (consoleErrors.length > 0) {
    throw new Error(`UI smoke captured console errors:\n${consoleErrors.join('\n')}`);
  }
  console.log('ui workbench smoke passed: matrix, sync confirm, library, kanban, discover, create skill, scenarios, history, settings, and LLM settings rendered from mocked Tauri bridge');
} finally {
  cleanup();
}
