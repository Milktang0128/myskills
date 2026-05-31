#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function fail(message, details = []) {
  console.error(`command audit failed: ${message}`);
  for (const detail of details) {
    console.error(`  - ${detail}`);
  }
  process.exit(1);
}

function sorted(values) {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function setDiff(left, right) {
  return sorted([...left].filter((value) => !right.has(value)));
}

function extractBalancedObject(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) fail(`marker not found: ${marker}`);
  const braceStart = source.indexOf('{', start);
  if (braceStart < 0) fail(`object start not found after marker: ${marker}`);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(braceStart, i + 1);
      }
    }
  }
  fail(`object end not found after marker: ${marker}`);
}

function extractBracketBlock(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) fail(`marker not found: ${marker}`);
  const bracketStart = source.indexOf('[', start);
  if (bracketStart < 0) fail(`block start not found after marker: ${marker}`);
  let depth = 0;
  for (let i = bracketStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '[') depth += 1;
    if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(bracketStart, i + 1);
      }
    }
  }
  fail(`block end not found after marker: ${marker}`);
}

const apiTs = read('src/lib/api.ts');
const commandObject = extractBalancedObject(apiTs, 'const COMMANDS');
const frontendCommands = new Set(
  [...commandObject.matchAll(/:\s*'([a-z0-9_]+)'/g)].map((match) => match[1]),
);

const rustLib = read('src-tauri/src/lib.rs');
const handlerBlock = extractBracketBlock(rustLib, 'tauri::generate_handler!');
const rustHandlers = new Set(
  [...handlerBlock.matchAll(/commands::([a-zA-Z0-9_]+)/g)].map((match) => match[1]),
);

const missingRustHandlers = setDiff(frontendCommands, rustHandlers);
const unexposedRustHandlers = setDiff(rustHandlers, frontendCommands);
if (missingRustHandlers.length || unexposedRustHandlers.length) {
  fail('frontend command mapping and Rust handler registration diverged', [
    ...(missingRustHandlers.length
      ? [`missing Rust handler(s): ${missingRustHandlers.join(', ')}`]
      : []),
    ...(unexposedRustHandlers.length
      ? [`registered but unmapped handler(s): ${unexposedRustHandlers.join(', ')}`]
      : []),
  ]);
}

const ipcTs = read('shared/ipc-channels.ts');
const eventsObject = extractBalancedObject(ipcTs, 'events:');
const ipcEvents = new Set(
  [...eventsObject.matchAll(/:\s*'(event:[^']+)'/g)].map((match) => match[1]),
);
const rustSource = [
  'src-tauri/src/lib.rs',
  'src-tauri/src/commands/mod.rs',
  'src-tauri/src/scanner/mod.rs',
]
  .map(read)
  .join('\n');
const emittedEvents = new Set(
  [...rustSource.matchAll(/emit\(\s*"([^"]+)"/g)].map((match) => match[1]),
);
const missingEventEmits = setDiff(ipcEvents, emittedEvents);
if (missingEventEmits.length) {
  fail('IPC event(s) are declared but never emitted by the Tauri backend', [
    `missing emit(s): ${missingEventEmits.join(', ')}`,
  ]);
}

console.log(
  `command audit passed: ${frontendCommands.size} command mappings, ${ipcEvents.size} backend events`,
);
