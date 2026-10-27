/**
 * The providers, driven the way the Extension Host drives them.
 *
 * Everything else in the suite tests the core directly, which is right until a
 * jump has to cross the `vscode` boundary: `provideDefinition` is the only code
 * that turns a saved relation into a location, and it has been wrong in ways
 * the core tests could not see. This activates the real extension against a
 * stubbed `vscode` and asks it for definitions, hovering and index state.
 */
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Module } from 'node:module';

import { vscode, documentFor, fireOpen, fireClose, provider, log, type StubDocument } from './vscodeStub';

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

// The stub has to be in place before the extension - and everything it
// imports - asks for the `vscode` module.
const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = loader._load;
loader._load = function (request: string, ...rest: unknown[]) {
  return request === 'vscode' ? vscode : originalLoad(request, ...rest);
};

let context: { subscriptions: { dispose(): unknown }[] };
let tbDoc: StubDocument | undefined;

before(async () => {
  const folder = { uri: vscode.Uri.file(FIXTURES), name: 'fixtures', index: 0 };
  vscode.workspace.workspaceFolders = [folder];
  vscode.workspace.findFiles = async () => {
    const out: { fsPath: string }[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.(v|sv|svh|vh|vlt)$/.test(entry.name)) out.push(vscode.Uri.file(p));
      }
    };
    walk(FIXTURES);
    return out;
  };
  vscode.workspace.fs.readFile = async (uri: { fsPath: string }) =>
    new Uint8Array(fs.readFileSync(uri.fsPath));

  const extension = (await import('../extension')) as typeof import('../extension');
  context = { subscriptions: [] };
  extension.activate(context as never);

  // Wait for the first scan; an index-backed provider says when it is done.
  const symbols = provider('workspaceSymbols') as { provideWorkspaceSymbols(q: string): Promise<unknown[]> };
  for (let i = 0; i < 200; i++) {
    const found = await symbols.provideWorkspaceSymbols('');
    if (found && found.length) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`the index never became ready: ${log().join(' | ')}`);
});

after(() => {
  for (const sub of context?.subscriptions ?? []) {
    sub.dispose();
  }
});

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

function doc(rel: string): StubDocument {
  const file = path.join(FIXTURES, rel);
  return documentFor(file, read(file));
}

/** 0-based character of `word` on a 0-based line of a document. */
function character(d: StubDocument, line: number, word: string, from = 0): number {
  const text = d.getText().split('\n')[line];
  const col = text.indexOf(word, from);
  assert.notEqual(col, -1, `"${word}" is not on line ${line}: ${text}`);
  return col;
}

async function definition(d: StubDocument, line: number, word: string, from = 0) {
  const def = provider('definition') as {
    provideDefinition(
      d: unknown,
      p: unknown,
    ):
      | Promise<{ uri: { fsPath: string }; range: { start: { line: number; character: number } } }[] | undefined>
      | { uri: { fsPath: string }; range: { start: { line: number; character: number } } }[]
      | undefined;
  };
  const result = await def.provideDefinition(d, new vscode.Position(line, character(d, line, word, from)));
  if (!result) return undefined;
  const list = Array.isArray(result) ? result : [result];
  return list.map((l) => ({
    file: path.relative(FIXTURES, l.uri.fsPath),
    line: l.range.start.line + 1,
    character: l.range.start.character,
  }));
}

async function landing(d: StubDocument, line: number, word: string, from = 0) {
  const hits = await definition(d, line, word, from);
  assert.ok(hits && hits.length, `"${word}" on line ${line + 1} should jump`);
  return hits[0];
}

test('providers: a module word in an instantiation jumps to its declaration', async () => {
  const top = doc('lib/chip_top.v');
  const hit = await landing(top, 18, 'control');
  assert.equal(hit.file, 'lib/control.v');
  assert.equal(hit.line, 2);
  assert.equal(hit.character, 7, 'the name of `module control`');
});

test('providers: an instance name jumps to the module it instantiates', async () => {
  const top = doc('lib/chip_top.v');
  const hit = await landing(top, 18, 'u_ctrl');
  assert.equal(hit.file, 'lib/control.v');
  assert.equal(hit.line, 2);
  assert.equal(hit.character, 7);
});

test('providers: a signal read jumps to its declaration', async () => {
  const top = doc('lib/chip_top.v');
  // `assign carry = ...` reads the output port declared in the header.
  const hit = await landing(top, 44, 'carry');
  assert.equal(hit.file, 'lib/chip_top.v');
  assert.equal(hit.line, 10, 'the port declaration line');
  assert.equal(hit.character, 21);
});

test('providers: hovering a signal still reports what it is', async () => {
  const top = doc('lib/chip_top.v');
  const hover = provider('hover') as {
    provideHover(d: unknown, p: unknown): Promise<{ contents: unknown } | undefined> | { contents: unknown } | undefined;
  };
  const result = await hover.provideHover(top, new vscode.Position(44, character(top, 44, 'carry')));
  assert.ok(result, 'a signal under the cursor still hovers');
  assert.match(String(JSON.stringify(result?.contents ?? '')), /carry/);
});

test('providers: a file the scan excluded has no relations until it is opened', async () => {
  // `test/fixtures/tb` matches the default exclude patterns, so the bulk scan
  // never sees it and nothing inside it can resolve - this is the contract the
  // next test then widens.
  const tb = doc('tb/tb_chip_top.v');
  const hits = await definition(tb, 11, 'chip_top');
  assert.equal(hits, undefined, 'an unindexed file resolves nothing');
});

test('providers: opening an excluded file makes its jumps work', async () => {
  const tb = doc('tb/tb_chip_top.v');
  tbDoc = tb;
  fireOpen(tb);

  const moduleWord = await landing(tb, 11, 'chip_top');
  assert.equal(moduleWord.file, 'lib/chip_top.v');
  assert.equal(moduleWord.line, 2);

  const instance = await landing(tb, 11, 'dut');
  assert.equal(instance.file, 'lib/chip_top.v', 'the instance names the module under test');
  assert.equal(instance.line, 2);
});

test('providers: closing an excluded file puts the workspace back', async () => {
  assert.ok(tbDoc, 'the previous test opened it');
  fireClose(tbDoc);
  const tb = tbDoc;

  const hits = await definition(tb, 11, 'chip_top');
  assert.equal(hits, undefined, 'an excluded file is not part of the index once it is closed');
});

/** The extension's workspace-symbol feed, as the system `#` box drives it. */
function workspaceSymbols() {
  return provider('workspaceSymbols') as {
    provideWorkspaceSymbols(query: string): Promise<{ name: string; location: { uri: { fsPath: string }; range: { start: { line: number; character: number } } } }[]>;
  };
}

test('workspace symbols: offers every indexed module, sorted, and matched on the path too', async () => {
  const all = await workspaceSymbols().provideWorkspaceSymbols('');
  const names = all.map((s) => s.name);
  for (const name of ['adder', 'chip_top', 'types_pkg', 'bus_if', 'fifo']) {
    assert.ok(names.includes(name), `"${name}" is offered`);
  }
  assert.deepEqual(names, [...names].sort(), 'the list is sorted by module name');

  // `fifo` lives in legacy.v - only the file path matches the query.
  const pathOnly = await workspaceSymbols().provideWorkspaceSymbols('legacy');
  assert.deepEqual(pathOnly.map((s) => s.name), ['fifo'], 'a path-only match is found');

  const none = await workspaceSymbols().provideWorkspaceSymbols('zzz_nope');
  assert.deepEqual(none, [], 'a query that matches nothing clears the list');
});

test('workspace symbols: a module points at its declaration with the cursor on the name', async () => {
  const all = await workspaceSymbols().provideWorkspaceSymbols('adder');
  const adder = all.find((s) => s.name === 'adder');
  assert.ok(adder, 'adder is offered');
  assert.equal(adder.location.uri.fsPath, path.join(FIXTURES, 'lib/adder.v'));
  assert.equal(adder.location.range.start.line, 1, 'the `module adder` line (0-based)');
  assert.equal(adder.location.range.start.character, 7, 'the name inside `module adder`');
});

test('go to module: reuses the system symbol search instead of a second input box', async () => {
  let calls = 0;
  (vscode as unknown as { __commands: Record<string, () => unknown> }).__commands[
    'workbench.action.showAllSymbols'
  ] = () => {
    calls += 1;
  };
  await vscode.commands.executeCommand('hdl.connectView.goToModule');
  assert.equal(calls, 1, 'the command opens the built-in `#` box');
});

test('show call hierarchy: forwards to the built-in editor command', async () => {
  const seen: string[] = [];
  const commands = vscode.commands as unknown as {
    executeCommand: (id: string, ...args: unknown[]) => unknown;
  };
  const original = commands.executeCommand;
  commands.executeCommand = async (id, ...args) => {
    seen.push(id);
    return original(id, ...args);
  };
  const previous = vscode.window.activeTextEditor;
  vscode.window.activeTextEditor = {
    document: doc('lib/chip_top.v'),
    selection: { active: new vscode.Position(0, 0) },
  } as never;
  try {
  await commands.executeCommand('hdl.connectView.showCallHierarchy');
  assert.deepEqual(seen.filter((id) => id !== 'hdl.connectView.showCallHierarchy'), [
    'editor.showCallHierarchy',
  ]);
  assert.ok(seen.includes('editor.showCallHierarchy'));
  } finally {
    commands.executeCommand = original;
    vscode.window.activeTextEditor = previous;
  }
});
