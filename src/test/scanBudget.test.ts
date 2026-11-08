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

import { vscode } from './vscodeStub';

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

async function makeService(settings: Record<string, unknown>, lines: string[]) {
  reset();
  (vscode.workspace as { getConfiguration: unknown }).getConfiguration = () => ({
    get: (key: string, fallback: unknown) => (key in settings ? settings[key] : fallback),
  });
  const { IndexService } = await import('../vscode/indexService');
  return new IndexService({ appendLine: (line: string) => lines.push(line) } as never);
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
