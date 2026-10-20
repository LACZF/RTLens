/**
 * Activation must stay cheap.
 *
 * VS Code asks every restored editor for its outline during startup, so a
 * document-symbol provider that waits for the workspace index turns opening a
 * window into a full scan. The scan is synchronous parsing on the extension
 * host: it delays this extension and every other extension activating beside
 * it. These tests pin the things that keep startup light - the outline parses
 * only its own buffer, a hidden composition view records the active editor
 * without parsing it, and the manifest does not ask VS Code to search the
 * workspace for HDL files before activating.
 */
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Module } from 'node:module';

import { vscode, documentFor, provider, log } from './vscodeStub';

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = loader._load;
loader._load = function (request: string, ...rest: unknown[]) {
  return request === 'vscode' ? vscode : originalLoad(request, ...rest);
};

let context: { subscriptions: { dispose(): unknown }[] };
let activationReads = 0;

before(async () => {
  vscode.workspace.workspaceFolders = [
    { uri: vscode.Uri.file(FIXTURES), name: 'fixtures', index: 0 },
  ];
  // A scan during activation would call this; failing loudly makes the test
  // report the reason instead of merely a slow run.
  vscode.workspace.findFiles = async () => {
    throw new Error('activation requested a workspace scan');
  };
  const active = documentFor(path.join(FIXTURES, 'lib/chip_top.v'), '');
  const read = active.getText;
  active.getText = () => {
    activationReads++;
    return read();
  };
  vscode.workspace.textDocuments.push(active);
  vscode.window.activeTextEditor = {
    document: active,
    selection: { active: { line: 0, character: 0 } },
  } as never;
  const extension = (await import('../extension')) as typeof import('../extension');
  context = { subscriptions: [] };
  extension.activate(context as never);
  await new Promise((r) => setTimeout(r, 0));
});

after(() => {
  for (const sub of context?.subscriptions ?? []) {
    sub.dispose();
  }
});

test('document symbols parse the buffer without scanning the workspace', async () => {
  const file = path.join(FIXTURES, 'lib/chip_top.v');
  const doc = documentFor(file, fs.readFileSync(file, 'utf8'));
  const symbols = provider('symbols') as {
    provideDocumentSymbols(d: unknown): Promise<unknown[]> | unknown[];
  };

  const found = await symbols.provideDocumentSymbols(doc);

  assert.ok(found.length > 0, 'the outline of an open file comes from its own text');
  assert.deepEqual(
    log().filter((line) => line.includes('[index]')),
    [],
    'no workspace scan was started',
  );
});

test('activation does not parse the active buffer for a hidden composition view', async () => {
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(activationReads, 0, 'the composition view stays hidden during activation');
});

test('the manifest does not activate on workspaceContains', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    activationEvents?: string[];
  };
  const eager = (pkg.activationEvents ?? []).filter((e) => e.startsWith('workspaceContains:'));
  assert.deepEqual(eager, [], 'startup must not search the workspace for HDL globs');
});
