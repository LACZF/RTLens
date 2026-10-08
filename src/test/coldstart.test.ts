/**
 * A jump asked for before the first scan finishes.
 *
 * `activate()` returns as soon as the providers are registered - the scan runs
 * on - so the Extension Host will happily call `provideDefinition` against an
 * index that is still empty. The providers therefore await `ensureReady()`,
 * which costs nothing once the index is there. This file proves it: the scan is
 * held open on purpose, a definition is asked for immediately, and only then is
 * the scan allowed to finish.
 */
import { test, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Module } from 'node:module';

import { vscode, documentFor, provider, log, type StubDocument } from './vscodeStub';

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = loader._load;
loader._load = function (request: string, ...rest: unknown[]) {
  return request === 'vscode' ? vscode : originalLoad(request, ...rest);
};

let context: { subscriptions: { dispose(): unknown }[] } = { subscriptions: [] };

after(() => {
  for (const sub of context.subscriptions) {
    sub.dispose();
  }
});

/** 0-based character of `word` on a 0-based line. */
function character(d: StubDocument, line: number, word: string): number {
  const text = d.getText().split('\n')[line];
  const col = text.indexOf(word);
  assert.notEqual(col, -1, `"${word}" is not on line ${line}: ${text}`);
  return col;
}

test('cold start: a definition asked for while the scan runs still resolves', async () => {
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(FIXTURES), name: 'fixtures', index: 0 }];

  // The scan cannot complete until this is released, so the index is provably
  // empty at the moment the definition is asked for.
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vscode.workspace.findFiles = async () => {
    await held;
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

  const file = path.join(FIXTURES, 'lib/chip_top.v');
  const top = documentFor(file, fs.readFileSync(file, 'utf8'));
  const def = provider('definition') as {
    provideDefinition(
      d: unknown,
      p: unknown,
    ):
      | Promise<{ uri: { fsPath: string }; range: { start: { line: number } } }[] | undefined>
      | { uri: { fsPath: string }; range: { start: { line: number } } }[]
      | undefined;
  };

  // Asked now, while `findFiles` is still pending.
  const asked = def.provideDefinition(top, new vscode.Position(18, character(top, 18, 'control')));
  release?.();

  const result = await asked;
  assert.ok(result, `a jump asked during indexing resolves once the scan lands: ${log().join(' | ')}`);
  const first = Array.isArray(result) ? result[0] : (result as never as { uri: { fsPath: string } });
  assert.equal(path.relative(FIXTURES, first.uri.fsPath), 'lib/control.v');
});
