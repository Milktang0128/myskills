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

const basePlatforms = [
  {
    id: 'shared',
    label: 'User Agents Folder',
    skillsDir: '/tmp/myskills-onboarding/shared',
    isBuiltin: true,
    enabled: true,
    sortOrder: 0,
  },
  {
    id: 'claude',
    label: 'Claude Code',
    skillsDir: '/tmp/myskills-onboarding/claude',
    isBuiltin: true,
    enabled: true,
    sortOrder: 1,
  },
  {
    id: 'codex',
    label: 'Codex',
    skillsDir: '/tmp/myskills-onboarding/codex',
    isBuiltin: true,
    enabled: true,
    sortOrder: 2,
  },
];

const scanResult = {
  totalFound: 4,
  newSkills: 4,
  updatedSkills: 0,
  removedSkills: 0,
  errors: [],
  durationMs: 33,
  scannedAt: now,
};

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
    throw new Error(`Could not find enabled button "${label}"\n\n${text()}`);
  }
  button.click();
}

function expectButtonDisabled(label) {
  const buttons = [...document.querySelectorAll('button')];
  const button = buttons.find((candidate) => {
    const candidateText = normalizeText(candidate.textContent ?? '');
    return candidate.getAttribute('aria-label') === label || candidateText === label || candidateText.includes(label);
  });
  if (!button) {
    throw new Error(`Could not find button "${label}"\n\n${text()}`);
  }
  if (!button.disabled) {
    throw new Error(`Expected button "${label}" to be disabled\n\n${text()}`);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function renderWorkspace({ locale, scanMode = 'success', enabledPlatforms = basePlatforms }) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myskills-onboarding-smoke-'));
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
    url: 'http://myskills-onboarding-smoke.local/',
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
  installGlobal('InputEvent', window.InputEvent);
  installGlobal('MouseEvent', window.MouseEvent);
  installGlobal('CustomEvent', window.CustomEvent);
  installGlobal('MutationObserver', window.MutationObserver);
  installGlobal('ResizeObserver', window.ResizeObserver);
  installGlobal('NodeFilter', window.NodeFilter);
  installGlobal('getComputedStyle', window.getComputedStyle.bind(window));
  installGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(Date.now()), 0));
  installGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
  window.localStorage.setItem('myskills.locale', locale);
  document.body.innerHTML = '<div id="root"></div>';

  const scanGate = deferred();
  const calls = {
    scanRun: 0,
    completedAtSet: false,
  };
  const settings = new Map([
    ['canonical_platform', 'shared'],
    ['allow_external_network', '0'],
  ]);
  const stats = {
    totalSkills: calls.scanRun > 0 ? scanResult.totalFound : 0,
    byPlatform: calls.scanRun > 0 ? { shared: 2, claude: 1, codex: 1 } : {},
    scenarios: 0,
    brokenSymlinks: 0,
    duplicates: 0,
    unscenarized: 0,
    disabledSkills: 0,
    dbPath: '/tmp/myskills-onboarding/myskills.db',
    lastScanAt: calls.scanRun > 0 ? now : null,
  };

  function invoke(command, payload = {}) {
    switch (command) {
      case 'settings_get':
        return Promise.resolve(settings.get(payload.key) ?? null);
      case 'settings_set':
        settings.set(payload.key, payload.value);
        if (payload.key === 'onboarding_completed_at') calls.completedAtSet = true;
        return Promise.resolve({ ok: true });
      case 'settings_stats':
        stats.totalSkills = calls.scanRun > 0 ? scanResult.totalFound : 0;
        stats.byPlatform = calls.scanRun > 0 ? { shared: 2, claude: 1, codex: 1 } : {};
        stats.lastScanAt = calls.scanRun > 0 ? now : null;
        return Promise.resolve(stats);
      case 'platforms_list':
        return Promise.resolve(enabledPlatforms);
      case 'platforms_known_candidates':
        return Promise.resolve(
          basePlatforms.map((platform) => ({
            id: platform.id,
            label: platform.label,
            defaultDir: platform.skillsDir,
            description: `${platform.label} skills directory.`,
          })),
        );
      case 'platforms_probe':
        return Promise.resolve({
          resolvedPath: payload.path,
          exists: true,
          readable: true,
          skillCount: payload.path.includes('shared') ? 2 : 1,
          alreadyRegistered: enabledPlatforms.some((platform) => platform.skillsDir === payload.path),
        });
      case 'scan_run':
        calls.scanRun += 1;
        if (scanMode === 'controlled') return scanGate.promise;
        if (scanMode === 'failure') return Promise.reject({ code: 'SCAN_FAILED', message: 'permission denied' });
        return Promise.resolve(scanResult);
      case 'coverage_matrix':
        return Promise.resolve({ platforms: ['shared', 'claude', 'codex'], canonicalPlatform: 'shared', rows: [] });
      case 'skills_list':
      case 'scenarios_list':
      case 'scan_last_result':
        return Promise.resolve([]);
      case 'llm_get_config':
        return Promise.resolve({ provider: 'deepseek', model: null, hasApiKey: false, baseUrl: null });
      case 'llm_get_features':
        return Promise.resolve({ search: false, autoCategorize: false, recommend: false });
      case 'ai_library_overview_get':
        return Promise.resolve({ overview: null, language: locale, generatedAt: null });
      default:
        return Promise.resolve({ ok: true });
    }
  }

  globalThis.__MYSKILLS_UI_SMOKE__ = {
    invoke,
    listen: () => () => {},
  };

  await import(pathToFileURL(bundle).href);
  return {
    calls,
    scanGate,
    cleanup: () => fs.rmSync(tempRoot, { recursive: true, force: true }),
  };
}

function uiSmokePlugin() {
  return {
    name: 'ui-onboarding-smoke',
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

async function runSuccessCase() {
  const rendered = await renderWorkspace({ locale: 'zh', scanMode: 'controlled' });
  try {
    await waitFor('Chinese onboarding language step', () => text().includes('第 1 / 4 步') && text().includes('下一步'));
    clickButton('下一步');
    await waitFor('Chinese platforms step', () => text().includes('发现你的平台'));
    expectText('platform copy clarifies inclusion', '启用后纳入首次扫描');
    clickButton('扫描已启用平台并继续');
    await waitFor('scan_run called before canonical step', () => rendered.calls.scanRun === 1);
    expectText('scan progress', '正在扫描');
    expectNoText('canonical gated until scan resolves', '选定主源平台');
    rendered.scanGate.resolve(scanResult);
    await waitFor('canonical after scan resolve', () => text().includes('选定主源平台'));
    expectText('scan summary', '首次扫描完成：已索引 4 个技能。');
    expectText('canonical counts from scanned stats', '2 个技能');
    clickButton('下一步');
    await waitFor('LLM optional step', () => text().includes('连接一个大语言模型'));
    clickButton('开始使用');
    await waitFor('onboarding completion setting', () => rendered.calls.completedAtSet);
  } finally {
    rendered.cleanup();
  }
}

async function runFailureCase() {
  const rendered = await renderWorkspace({ locale: 'en', scanMode: 'failure' });
  try {
    await waitFor('English onboarding language step', () => text().includes('Step 1 of 4') && text().includes('Next'));
    clickButton('Next');
    await waitFor('English platforms step', () => text().includes('Discover your platforms'));
    clickButton('Scan enabled platforms and continue');
    await waitFor('scan error', () => text().includes('First scan did not finish'));
    expectText('retry guidance', 'Check folder access');
    expectText('still on platforms step', 'Discover your platforms');
    expectNoText('does not advance after scan failure', 'Pick a main source platform');
  } finally {
    rendered.cleanup();
  }
}

async function runNoEnabledCase() {
  const rendered = await renderWorkspace({ locale: 'en', enabledPlatforms: [] });
  try {
    await waitFor('no-enabled language step', () => text().includes('Step 1 of 4') && text().includes('Next'));
    clickButton('Next');
    await waitFor('no-enabled platforms step', () => text().includes('Discover your platforms'));
    expectText('no-enabled guidance', 'No platforms enabled yet');
    expectButtonDisabled('Enable at least one platform to scan');
  } finally {
    rendered.cleanup();
  }
}

await runSuccessCase();
await runFailureCase();
await runNoEnabledCase();

if (consoleErrors.length > 0) {
  throw new Error(`Onboarding UI smoke captured console errors:\n${consoleErrors.join('\n')}`);
}

console.log('ui onboarding smoke passed: first scan gates canonical selection, failure stays on platforms, and no-enabled state blocks scan');
