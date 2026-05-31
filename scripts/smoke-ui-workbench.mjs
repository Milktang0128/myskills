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
      if (payload.key === 'canonical_platform') return Promise.resolve('shared');
      if (payload.key === 'onboarding_completed_at') return Promise.resolve(String(now));
      return Promise.resolve(null);
    case 'skills_list':
      return Promise.resolve(filteredSkills(payload));
    case 'skills_get':
      return Promise.resolve(skillFixtures.find((skill) => skill.id === payload.id) ?? skillFixtures[0]);
    case 'coverage_matrix':
      return Promise.resolve(matrix);
    case 'llm_get_config':
      return Promise.resolve({ provider: 'openai', model: null, hasApiKey: false, baseUrl: null });
    case 'llm_get_features':
      return Promise.resolve({ search: false, descriptions: false, categorization: false, recommendations: false });
    case 'ai_library_overview_get':
      return Promise.resolve({ overview: null, language: payload.language ?? 'en', generatedAt: null });
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
    const candidateText = normalizeText(candidate.textContent ?? '');
    return candidate.getAttribute('aria-label') === label || candidateText === label || candidateText.includes(label);
  });
  if (!button) {
    throw new Error(`Could not find button "${label}"\n\n${text()}`);
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
  installGlobal('HTMLSelectElement', window.HTMLSelectElement);
  installGlobal('Node', window.Node);
  installGlobal('Event', window.Event);
  installGlobal('MouseEvent', window.MouseEvent);
  installGlobal('CustomEvent', window.CustomEvent);
  installGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(Date.now()), 0));
  installGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
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
              'export async function invoke(command, options = {}) { return globalThis.__MYSKILLS_UI_SMOKE__.invoke(command, options.payload ?? {}); }',
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

  if (consoleErrors.length > 0) {
    throw new Error(`UI smoke captured console errors:\n${consoleErrors.join('\n')}`);
  }
  console.log('ui workbench smoke passed: coverage matrix, library list, and kanban rendered from mocked Tauri bridge');
} finally {
  cleanup();
}
