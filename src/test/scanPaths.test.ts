/**
 * The `hdl.connectView.databasePaths` / `databasePathsOnly` scan wiring.
 *
 * These settings change which roots `IndexService` walks, so the real service
 * is driven against throwaway folders with a stubbed `findFiles`: the workspace
 * folder, an external directory, and a lone file, to prove the extra roots are
 * pulled in and that "only configured paths" turns the workspace off.
 */
import { test, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Module } from 'node:module';

import { vscode } from './vscodeStub';

const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = loader._load;
loader._load = function (request: string, ...rest: unknown[]) {
  return request === 'vscode' ? vscode : originalLoad(request, ...rest);
};

const ROOT = path.join('/tmp/opencode', 'rtlens-scan-test');
const WS = path.join(ROOT, 'ws');
const EXT = path.join(ROOT, 'ext');
const SOLO = path.join(ROOT, 'solo');
const WS_A = path.join(WS, 'a.v');
const EXT_B = path.join(EXT, 'b.v');
const SOLO_D = path.join(SOLO, 'd.v');

/** Every file a directory scan can see, keyed by the root it lives under. */
const TREES: Record<string, string[]> = {
  [WS]: [WS_A],
  [EXT]: [EXT_B],
  [SOLO]: [SOLO_D],
};

function reset(): void {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  fs.mkdirSync(EXT, { recursive: true });
  fs.mkdirSync(SOLO, { recursive: true });
  fs.writeFileSync(WS_A, 'module a; endmodule\n');
  fs.writeFileSync(EXT_B, 'module b; endmodule\n');
  fs.writeFileSync(SOLO_D, 'module d; endmodule\n');

  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
    { uri: vscode.Uri.file(WS), name: 'ws', index: 0 },
  ];
  (vscode.workspace as { findFiles: unknown }).findFiles = async (pattern: { base?: { fsPath: string } }) => {
    const base = pattern?.base?.fsPath;
    const files = base ? TREES[base] ?? [] : [];
    return files.map((f) => vscode.Uri.file(f));
  };
}

async function makeService(settings: Record<string, unknown>) {
  reset();
  (vscode.workspace as { getConfiguration: unknown }).getConfiguration = () => ({
    get: (key: string, fallback: unknown) => (key in settings ? settings[key] : fallback),
  });
  const { IndexService } = await import('../vscode/indexService');
  return new IndexService(vscode.window.createOutputChannel('scan') as never);
}

function names(svc: { index: { allFiles(): string[] } }): string[] {
  return svc.index.allFiles().map((f) => path.basename(f)).sort();
}

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('scan paths: the workspace folder is scanned by default', async () => {
  const svc = await makeService({});
  await svc.refresh();
  svc.dispose();
  assert.deepEqual(names(svc), ['a.v']);
});

test('scan paths: databasePaths adds an external directory to the scan', async () => {
  const svc = await makeService({ databasePaths: [EXT], databasePathsOnly: false });
  await svc.refresh();
  svc.dispose();
  assert.deepEqual(names(svc), ['a.v', 'b.v']);
});

test('scan paths: databasePathsOnly drops the workspace and keeps the extra root', async () => {
  const svc = await makeService({ databasePaths: [EXT], databasePathsOnly: true });
  await svc.refresh();
  svc.dispose();
  assert.deepEqual(names(svc), ['b.v']);
});

test('scan paths: a listed file is indexed even when the exclude globs match it', async () => {
  const svc = await makeService({
    databasePaths: [SOLO_D],
    databasePathsOnly: true,
    exclude: ['**/*.v'],
  });
  await svc.refresh();
  svc.dispose();
  assert.deepEqual(names(svc), ['d.v']);
});

test('scan paths: files outside the workspace reach the relation database', async () => {
  const svc = await makeService({ databasePaths: [EXT], databasePathsOnly: false });
  const { DatabaseService } = await import('../vscode/database');
  const db = new DatabaseService(svc as never, { appendLine() {} } as never);
  await db.refresh('full');
  db.dispose();
  svc.dispose();

  const file = path.join(WS, '.vscode', 'rtlens', 'relations.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(parsed.files).sort(), ['../ext/b.v', 'a.v']);
});
