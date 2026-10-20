/**
 * The classified catalog: that a refresh writes the three databases, that a
 * later service reads them back, and that the Composition view's sharded
 * hierarchy store is readable and announced when a new generation lands.
 *
 * Mirrors `database.test.ts`: the real `CatalogService` runs against a
 * throwaway workspace folder, so the paths under `.vscode/rtlens/` and the
 * fingerprint/generation logic are exercised for real.
 */
import { test, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Module } from 'node:module';

import { documentFor, vscode } from './vscodeStub';
import { shardFile, shardOf } from '../core/hierarchyStore';

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
const HIERARCHY_BASE = path.join(CATALOG_DIR, 'hierarchy');
const HIERARCHY_FILE = path.join(HIERARCHY_BASE, 'current.json');
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
  assert.equal(hierarchy.version, 3, 'the manifest records the store version');
  assert.ok(hierarchy.source, 'the manifest records a source fingerprint');
  const shard = JSON.parse(
    fs.readFileSync(path.join(HIERARCHY_BASE, hierarchy.generation, shardFile(shardOf('top'))), 'utf8'),
  );
  assert.equal(shard.modules['top'].children[0].m, 'leaf');

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
  await second.load();
  assert.equal(second.stats().index.files, 2, 'the on-disk databases are picked up on load');
  second.dispose();
});

test('catalog: the hierarchy store is readable and a new generation is announced', async () => {
  const { svc, catalog } = await setup();
  await catalog.load();
  svc.watchDocument(documentFor(PARENT, PARENT_SRC) as never);
  await wait(0);

  const { CompositionStore } = await import('../vscode/compositionStore');
  assert.equal(CompositionStore.open(TEMP), undefined, 'nothing is on disk yet, so the view builds in memory');

  let changes = 0;
  catalog.onDidChangeDatabase(() => changes++);
  await catalog.refresh('full');
  const store = CompositionStore.open(TEMP)!;
  assert.ok(store, 'after a refresh the persisted hierarchy is readable');
  const top = (await store.module('top'))!;
  assert.equal(top.children[0].m, 'leaf');
  assert.equal(top.children[0].df, CHILD, 'the persisted edge names the child definition file');
  assert.equal(top.children[0].cc, 0, 'the persisted edge carries the child count hint');
  assert.equal(await store.topFile('top'), PARENT);
  assert.deepEqual(await store.modulesAmong(['top', 'leaf', 'missing']), new Set(['top', 'leaf']));
  assert.deepEqual(await store.firstParentChain('leaf'), { top: 'top', path: ['top', 'u'] });
  assert.equal(changes, 1, 'the refresh announces the new generation');
  const generation = store.generation;

  // An index change is written as a new generation; an open reader stays
  // pinned to the one it opened with until it reloads.
  svc.watchDocument(documentFor(CHILD, CHILD_SRC + '\n// touched\n') as never);
  await wait(700);
  assert.equal(store.generation, generation, 'a reader keeps its generation');
  assert.notEqual(CompositionStore.open(TEMP)!.generation, generation, 'the auto-refresh wrote a new one');
  assert.equal(changes, 2, 'the auto-refresh is announced too');

  catalog.dispose();
});

test('catalog: load() alone does not write, and auto-update fires after an index change', async () => {
  const { catalog, svc } = await setup();
  await catalog.load();
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
