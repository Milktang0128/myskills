#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const platformIds = ['shared', 'claude', 'codex'];

function parseArgs(argv) {
  const args = { root: '', force: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') {
      args.force = true;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--root') {
      args.root = argv[++i] ?? '';
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function skillMarkdown({ name, description, body }) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

function writeSkill(platformDir, folder, skill) {
  const skillDir = path.join(platformDir, folder);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMarkdown(skill));
}

function createFixtures(root) {
  const platformsRoot = path.join(root, 'platforms');
  const warnings = [];
  const platformDirs = Object.fromEntries(
    platformIds.map((id) => [id, path.join(platformsRoot, id)]),
  );

  for (const dir of Object.values(platformDirs)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const synced = {
    name: 'fixture-in-sync',
    description: 'Same content on every platform.',
    body: 'Use this fixture to verify an in-sync coverage row.',
  };
  for (const dir of Object.values(platformDirs)) {
    writeSkill(dir, 'fixture-in-sync', synced);
  }

  writeSkill(platformDirs.shared, 'fixture-stale', {
    name: 'fixture-stale',
    description: 'Canonical copy for stale drift smoke.',
    body: 'This is the canonical version that should win sync planning.',
  });
  writeSkill(platformDirs.claude, 'fixture-stale', {
    name: 'fixture-stale',
    description: 'Older Claude copy for stale drift smoke.',
    body: 'This stale version should be detected as drift.',
  });

  writeSkill(platformDirs.claude, 'fixture-claude-only', {
    name: 'fixture-claude-only',
    description: 'Only installed on Claude.',
    body: 'Use this fixture to verify orphan / only-here states.',
  });

  writeSkill(path.join(platformDirs.shared, '.disabled'), 'fixture-disabled', {
    name: 'fixture-disabled',
    description: 'Disabled skill in the shared platform.',
    body: 'Use this fixture to verify disabled state handling.',
  });

  const missingTarget = path.join(root, 'missing-target');
  const brokenLinkPath = path.join(platformDirs.codex, 'fixture-broken-link');
  let brokenLinkCreated = false;
  try {
    fs.symlinkSync(
      missingTarget,
      brokenLinkPath,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    brokenLinkCreated = true;
  } catch (error) {
    warnings.push(
      `Could not create broken-link fixture at ${brokenLinkPath}: ${error.message}`,
    );
  }

  const badDir = path.join(platformDirs.shared, 'fixture-missing-frontmatter');
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(
    path.join(badDir, 'SKILL.md'),
    'This intentionally lacks YAML frontmatter for parser diagnostics.\n',
  );

  const manifest = {
    root,
    platforms: platformDirs,
    expected: {
      inSync: ['fixture-in-sync'],
      stale: ['fixture-stale'],
      orphan: ['fixture-claude-only'],
      disabled: ['fixture-disabled'],
      brokenLink: brokenLinkCreated ? ['fixture-broken-link'] : [],
      parserError: ['fixture-missing-frontmatter'],
    },
    warnings,
  };

  fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(
    path.join(root, 'README.md'),
    [
      '# MySkills Tauri Smoke Fixtures',
      '',
      'Use these temporary platform directories in the packaged Tauri app Settings page:',
      '',
      `- User Agents Folder: \`${platformDirs.shared}\``,
      `- Claude Code: \`${platformDirs.claude}\``,
      `- Codex: \`${platformDirs.codex}\``,
      '',
      'These fixtures are disposable and safe to delete after smoke testing.',
      '',
    ].join('\n'),
  );

  return manifest;
}

const args = parseArgs(process.argv.slice(2));
const root = args.root
  ? path.resolve(args.root)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'myskills-tauri-smoke-fixtures-'));

if (fs.existsSync(root) && fs.readdirSync(root).length > 0 && !args.force) {
  throw new Error(`Refusing to write into non-empty directory without --force: ${root}`);
}

fs.mkdirSync(root, { recursive: true });
const manifest = createFixtures(root);

if (args.json) {
  console.log(JSON.stringify(manifest, null, 2));
} else {
  console.log(`Created MySkills Tauri smoke fixtures at ${manifest.root}`);
  console.log('');
  console.log('Set platform paths in Settings:');
  for (const [id, dir] of Object.entries(manifest.platforms)) {
    console.log(`- ${id}: ${dir}`);
  }
  console.log('');
  console.log(`Manifest: ${path.join(manifest.root, 'manifest.json')}`);
  if (manifest.warnings.length > 0) {
    console.log('');
    console.log('Warnings:');
    for (const warning of manifest.warnings) {
      console.log(`- ${warning}`);
    }
  }
}
