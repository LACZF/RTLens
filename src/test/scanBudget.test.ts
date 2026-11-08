/**
 * The `hdl.connectView.maxFiles` scan budget.
 *
 * A workspace with more HDL files than the budget must still activate: the
 * scan asks `findFiles` for one file past the budget, indexes at most that
 * many, and says so instead of handing the extension host an unbounded list.
 */
import { test, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Module } from 'node:module';

import { documentFor, vscode } from './vscodeStub';
import { SAFE_MODE_KEY, SAFE_MODE_MAX_FILES, ScanGuard } from '../vscode/safeMode';

const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = loader._load;
loader._load = function (request: string, ...rest: unknown[]) {
  return request === 'vscode' ? vscode : originalLoad(request, ...rest);
};

const ROOT = path.join('/tmp/opencode', 'rtlens-budget-test');
const WS = path.join(ROOT, 'ws');
const FILES = [1, 2, 3, 4, 5].map((n) => path.join(WS, `f${n}.v`));

interface FindCall {
  maxResults: number | undefined;
}

let findCalls: FindCall[] = [];

function reset(): void {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  for (const file of FILES) {
    fs.writeFileSync(file, `module m${path.basename(file, '.v')}; endmodule\n`);
  }
  findCalls = [];
  (vscode.workspace as { textDocuments: unknown }).textDocuments = [];
  (vscode.window as { activeTextEditor: unknown }).activeTextEditor = undefined;
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
    { uri: vscode.Uri.file(WS), name: 'ws', index: 0 },
  ];
  (vscode.workspace as { findFiles: unknown }).findFiles = async (
    pattern: { base?: { fsPath: string } },
    _exclude: unknown,
    maxResults?: number,
  ) => {
    findCalls.push({ maxResults });
    const base = pattern?.base?.fsPath;
    const found = base === WS ? FILES.map((f) => vscode.Uri.file(f)) : [];
    return maxResults === undefined ? found : found.slice(0, maxResults);
  };
}

class FakeState {
  private readonly values = new Map<string, unknown>();

  constructor(initial: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(initial)) {
      this.values.set(key, value);
    }
  }

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

async function makeService(settings: Record<string, unknown>, lines: string[], guard?: ScanGuard) {
  reset();
  (vscode.workspace as { getConfiguration: unknown }).getConfiguration = () => ({
    get: (key: string, fallback: unknown) => (key in settings ? settings[key] : fallback),
  });
  const { IndexService } = await import('../vscode/indexService');
  return new IndexService({ appendLine: (line: string) => lines.push(line) } as never, guard);
}

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('scan budget: findFiles is asked for one past the budget and the scan stops there', async () => {
  const lines: string[] = [];
  const svc = await makeService({ maxFiles: 2 }, lines);
  await svc.refresh();
  svc.dispose();

  assert.equal(findCalls.length, 1);
  assert.equal(findCalls[0].maxResults, 3, 'budget + 1 proves the list was cut');
  assert.equal(svc.index.allFiles().length, 2);
  assert.equal(svc.stats.files, 2);
  assert.ok(lines.some((l) => l.includes('file budget reached')), 'the truncation is logged');
});

test('scan budget: a workspace that fits is indexed whole and not reported as truncated', async () => {
  const lines: string[] = [];
  const svc = await makeService({ maxFiles: 10 }, lines);
  await svc.refresh();
  svc.dispose();

  assert.equal(findCalls[0].maxResults, 11);
  assert.equal(svc.index.allFiles().length, FILES.length);
  assert.ok(!lines.some((l) => l.includes('file budget reached')));
});

test('scan budget: explicit databasePaths files are capped by the same budget', async () => {
  const lines: string[] = [];
  const svc = await makeService({ maxFiles: 2, databasePathsOnly: true, databasePaths: FILES }, lines);
  await svc.refresh();
  svc.dispose();

  assert.equal(svc.index.allFiles().length, 2);
  assert.ok(lines.some((l) => l.includes('file budget reached')));
});

test('scan budget: safe mode caps the scan at SAFE_MODE_MAX_FILES', async () => {
  const lines: string[] = [];
  const guard = new ScanGuard(new FakeState({ [SAFE_MODE_KEY]: true }), () => {});
  const svc = await makeService({ maxFiles: 20000 }, lines, guard);
  const many = Array.from({ length: SAFE_MODE_MAX_FILES + 1 }, (_, i) => path.join(WS, `s${i}.v`));
  for (const file of many) {
    fs.writeFileSync(file, `module s${path.basename(file, '.v')}; endmodule\n`);
  }
  (vscode.workspace as { findFiles: unknown }).findFiles = async (
    pattern: { base?: { fsPath: string } },
    _exclude: unknown,
    maxResults?: number,
  ) => {
    findCalls.push({ maxResults });
    const base = pattern?.base?.fsPath;
    const found = base === WS ? many.map((f) => vscode.Uri.file(f)) : [];
    return maxResults === undefined ? found : found.slice(0, maxResults);
  };
  await svc.refresh();
  svc.dispose();

  assert.equal(findCalls[0].maxResults, SAFE_MODE_MAX_FILES + 1);
  assert.equal(svc.index.allFiles().length, SAFE_MODE_MAX_FILES);
  assert.ok(lines.some((l) => l.includes('safe mode budget reached')));
});

test('scan budget: a file above the per-file limit is skipped', async () => {
  const lines: string[] = [];
  const svc = await makeService({ maxFiles: 10 }, lines);
  const { MAX_FILE_CHARS } = await import('../vscode/indexService');
  const big = path.join(WS, 'big.v');
  fs.writeFileSync(big, 'module big; endmodule\n' + ' '.repeat(MAX_FILE_CHARS));
  const all = [...FILES, big];
  (vscode.workspace as { findFiles: unknown }).findFiles = async (
    pattern: { base?: { fsPath: string } },
    _exclude: unknown,
    maxResults?: number,
  ) => {
    findCalls.push({ maxResults });
    const base = pattern?.base?.fsPath;
    const found = base === WS ? all.map((f) => vscode.Uri.file(f)) : [];
    return maxResults === undefined ? found : found.slice(0, maxResults);
  };
  await svc.refresh();
  svc.dispose();

  assert.equal(svc.index.allFiles().length, FILES.length, 'the oversized file is not indexed');
  assert.ok(lines.some((l) => l.includes('per-file limit')));
});

test('open documents: only MAX_PRE_SCAN_OPEN_FILES are parsed before the first scan', async () => {
  const lines: string[] = [];
  const svc = await makeService({ maxFiles: 20 }, lines);
  const { MAX_PRE_SCAN_OPEN_FILES } = await import('../vscode/indexService');
  const docs = Array.from({ length: MAX_PRE_SCAN_OPEN_FILES + 1 }, (_, i) => {
    const file = path.join(WS, `open${i}.v`);
    const text = `module open${i}; endmodule\n`;
    fs.writeFileSync(file, text);
    return documentFor(file, text);
  });
  for (const doc of docs) {
    svc.watchDocument(doc as never);
  }

  assert.equal(svc.index.allFiles().length, MAX_PRE_SCAN_OPEN_FILES);
  assert.ok(!svc.index.allFiles().includes(docs[docs.length - 1].fileName));
  svc.dispose();
});

test('open documents: documents deferred before the first scan are indexed after it', async () => {
  const lines: string[] = [];
  const svc = await makeService({ maxFiles: 20 }, lines);
  const { MAX_PRE_SCAN_OPEN_FILES } = await import('../vscode/indexService');
  let deferred = documentFor(path.join(WS, 'deferred.v'), 'module deferred; endmodule\n');
  fs.writeFileSync(deferred.fileName, deferred.getText());
  for (let i = 0; i < MAX_PRE_SCAN_OPEN_FILES; i++) {
    const file = path.join(WS, `before${i}.v`);
    const text = `module before${i}; endmodule\n`;
    fs.writeFileSync(file, text);
    svc.watchDocument(documentFor(file, text) as never);
  }
  svc.watchDocument(deferred as never);

  assert.ok(!svc.index.allFiles().includes(deferred.fileName));
  await svc.refresh();
  assert.ok(svc.index.allFiles().includes(deferred.fileName));
  svc.dispose();
});

test('open documents: an oversized dirty buffer is not indexed', async () => {
  const lines: string[] = [];
  const svc = await makeService({ maxFiles: 10 }, lines);
  const { MAX_FILE_CHARS } = await import('../vscode/indexService');
  const file = path.join(WS, 'dirty.v');
  const text = 'module dirty; endmodule\n' + ' '.repeat(MAX_FILE_CHARS);
  fs.writeFileSync(file, text);
  const doc = documentFor(file, text);
  doc.isDirty = true;
  (vscode.workspace as { textDocuments: unknown }).textDocuments = [doc];

  svc.syncOpenDocuments();

  assert.ok(!svc.index.allFiles().includes(file));
  assert.ok(lines.some((l) => l.includes('per-file limit')));
  svc.dispose();
});
