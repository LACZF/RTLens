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

import { vscode, documentFor, fireOpen, fireClose, provider, log, openedEditors, type StubDocument } from './vscodeStub';

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

  // Wait for the first scan; the index log says when it is done.
  const top = documentFor(path.join(FIXTURES, 'lib/chip_top.v'), read(path.join(FIXTURES, 'lib/chip_top.v')));
  const symbols = provider('symbols') as { provideDocumentSymbols(d: unknown): Promise<unknown[]> };
  for (let i = 0; i < 200; i++) {
    const found = await symbols.provideDocumentSymbols(top);
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

/** The quick pick the go-to-module command opened, and what it was asked for. */
async function goToModule(pickLabel: string): Promise<{
  labels: string[];
  details: string[];
  opts: { matchOnDescription?: boolean; matchOnDetail?: boolean };
}> {
  const labels: string[] = [];
  const details: string[] = [];
  let opts: { matchOnDescription?: boolean; matchOnDetail?: boolean } = {};
  (vscode as unknown as { __quickPick?: unknown }).__quickPick = (
    items: { label: string; detail?: string }[],
    o: typeof opts,
  ) => {
    for (const i of items) {
      labels.push(i.label);
      details.push(i.detail ?? '');
    }
    opts = o ?? {};
    return items.find((i) => i.label === pickLabel);
  };
  try {
    await vscode.commands.executeCommand('hdl.connectView.goToModule');
  } finally {
    (vscode as unknown as { __quickPick?: unknown }).__quickPick = undefined;
  }
  return { labels, details, opts };
}

test('go to module: offers every indexed module, sorted, and fuzzy-matched on path too', async () => {
  const { labels, opts } = await goToModule('adder');
  for (const name of ['adder', 'chip_top', 'types_pkg', 'bus_if', 'fifo']) {
    assert.ok(labels.includes(name), `"${name}" is offered`);
  }
  assert.deepEqual(labels, [...labels].sort(), 'the list is sorted by module name');
  assert.equal(opts.matchOnDescription, true, 'kind is fuzzy-matched');
  assert.equal(opts.matchOnDetail, true, 'file path is fuzzy-matched');
});

test('go to module: picking a module opens its definition with the cursor on the name', async () => {
  const before = openedEditors().length;
  await goToModule('adder');
  const editors = openedEditors();
  assert.equal(editors.length, before + 1, 'exactly one document opened');
  const editor = editors[before];
  assert.equal(editor.document.uri.fsPath, path.join(FIXTURES, 'lib/adder.v'));
  assert.equal(editor.selection.start.line, 1, 'the `module adder` line (0-based)');
  assert.equal(editor.selection.start.character, 7, 'the name inside `module adder`');
});
