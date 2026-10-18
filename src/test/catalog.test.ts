/**
 * The classified catalog: that a refresh writes the three files, that a later
 * service reads them back, and that the hierarchy provider reports fresh vs
 * stale so the Composition view knows when to fall back to the index.
 *
 * Mirrors `database.test.ts`: the real `CatalogService` runs against a
 * throwaway workspace folder, so the paths under `.vscode/rtlens/` and the
 * fingerprint/fallback logic are exercised for real.
 */
import { test, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Module } from 'node:module';

import { documentFor, vscode } from './vscodeStub';

const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = loader._load;
loader._load = function (request: string, ...rest: unknown[]) {
  return request === 'vscode' ? vscode : originalLoad(request, ...rest);
};

const TEMP = path.join('/tmp/opencode', 'rtlens-catalog-test');
const CHILD = path.join(TEMP, 'child.v');
const PARENT = path.join(TEMP, 'parent.v');
const CHILD_SRC = 'module leaf (input wire a, output wire s); assign s = a; endmodule\n';
const PARENT_SRC = 'module top (input wire x, output wire y); leaf u (.a (x), .s (y)); endmodule\n';

const CATALOG_DIR = path.join(TEMP, '.vscode', 'rtlens');
const INDEX_FILE = path.join(CATALOG_DIR, 'index.json');
const HIERARCHY_FILE = path.join(CATALOG_DIR, 'hierarchy.json');
const GRAPH_FILE = path.join(CATALOG_DIR, 'graph.json');

const originalConfig = vscode.workspace.getConfiguration;

async function setup(settings: Record<string, unknown> = {}) {
  fs.rmSync(TEMP, { recursive: true, force: true });
  fs.mkdirSync(TEMP, { recursive: true });
  fs.writeFileSync(CHILD, CHILD_SRC);
  fs.writeFileSync(PARENT, PARENT_SRC);
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
    { uri: vscode.Uri.file(TEMP), name: 'cat', index: 0 },
  ];
  (vscode.workspace as { getConfiguration: unknown }).getConfiguration = () => ({
    get: (key: string, fallback: unknown) => (key in settings ? settings[key] : fallback),
  });

  const { IndexService } = await import('../vscode/indexService');
  const mod = await import('../vscode/catalog');
  const log = { appendLine() {} };
  const svc = new IndexService(vscode.window.createOutputChannel('test') as never);
  svc.index.addFile(CHILD, CHILD_SRC);
  svc.index.addFile(PARENT, PARENT_SRC);
  const catalog = new mod.CatalogService(svc as never, log as never);
  return { mod, svc, catalog };
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

after(() => {
  fs.rmSync(TEMP, { recursive: true, force: true });
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  vscode.workspace.getConfiguration = originalConfig;
});

test('catalog: a refresh writes index/hierarchy/graph under .vscode/rtlens', async () => {
  const { catalog } = await setup();
  const summary = await catalog.refresh('full');
  catalog.dispose();

  assert.equal(summary.files, 2);
  assert.equal(summary.modules, 2);
  assert.equal(summary.instances, 1);
  assert.equal(summary.tops, 1);

  for (const file of [INDEX_FILE, HIERARCHY_FILE, GRAPH_FILE]) {
    assert.ok(fs.existsSync(file), `${path.basename(file)} is on disk`);
  }
  const hierarchy = JSON.parse(fs.readFileSync(HIERARCHY_FILE, 'utf8'));
  assert.ok(hierarchy.source, 'the file records a source fingerprint');
  assert.equal(hierarchy.modules['top'].children[0].m, 'leaf');

  const stats = catalog.stats();
  assert.equal(stats.folders, 1);
  assert.equal(stats.index.files, 2);
  assert.equal(stats.hierarchy.instances, 1);
});

test('catalog: a later service loads what the first one wrote', async () => {
  const { mod, svc } = await setup();
  const first = new mod.CatalogService(svc as never, { appendLine() {} } as never);
  await first.refresh('full');
  first.dispose();

  const second = new mod.CatalogService(svc as never, { appendLine() {} } as never);
  second.load();
  assert.equal(second.stats().hierarchy.modules, 2, 'the on-disk databases are picked up on load');
  second.dispose();
});

test('catalog: the provider offers a fresh hierarchy database, then withholds it after an edit', async () => {
  const { svc, catalog } = await setup();
  catalog.load();
  svc.watchDocument(documentFor(PARENT, PARENT_SRC) as never);
  await wait(0);

  assert.equal(svc.hierarchyDatabase?.(), undefined, 'nothing is on disk yet, so the view builds in memory');

  await catalog.refresh('full');
  const fresh = svc.hierarchyDatabase?.();
  assert.ok(fresh, 'after a refresh the persisted database is offered');
  assert.equal(fresh!.modules['top'].children[0].m, 'leaf');

  // An index change marks the databases stale synchronously, before the
  // debounced auto-refresh rewrites them.
  svc.watchDocument(documentFor(CHILD, CHILD_SRC + '\n// touched\n') as never);
  assert.equal(svc.hierarchyDatabase?.(), undefined, 'a stale database is withheld');

  catalog.dispose();
});

test('catalog: load() alone does not write, and auto-update fires after an index change', async () => {
  const { catalog, svc } = await setup();
  catalog.load();
  assert.ok(!fs.existsSync(HIERARCHY_FILE), 'load() alone does not write');

  svc.watchDocument(documentFor(PARENT, PARENT_SRC) as never);
  await wait(700);
  catalog.dispose();

  assert.ok(fs.existsSync(HIERARCHY_FILE), 'an index change auto-refreshes the catalog');
  assert.ok(fs.existsSync(INDEX_FILE));
  assert.ok(fs.existsSync(GRAPH_FILE));
});

test('catalog: auto-update is skipped when disabled, but an explicit schedule runs it', async () => {
  const { catalog, svc } = await setup({ autoUpdateDatabase: false });
  catalog.load();

  svc.watchDocument(documentFor(PARENT, PARENT_SRC) as never);
  await wait(700);
  assert.ok(!fs.existsSync(HIERARCHY_FILE), 'a disabled auto-update leaves disk alone');

  catalog.scheduleAutoRefresh(0);
  await wait(100);
  catalog.dispose();
  assert.ok(fs.existsSync(HIERARCHY_FILE), 'an explicit schedule still rebuilds it');
});

test('catalog: the activation scan alone does not write the catalog', async () => {
  const { catalog, svc } = await setup();
  svc.watchDocument(documentFor(PARENT, PARENT_SRC) as never);
  await wait(700);
  assert.ok(!fs.existsSync(HIERARCHY_FILE), 'auto-update starts only after load()');
  catalog.dispose();
});
