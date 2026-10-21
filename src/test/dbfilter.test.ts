/**
 * Composition filtering end to end, including the leak guards.
 *
 * The filter (`composition.filterModules` + `composition.filterMode`) removes
 * rows when the tree is built, but the host also streams levels on demand:
 * cursor-follow (`setContext` -> `materializeTo`) and the webview's `expand`
 * message both used to descend through hidden nodes and post their children,
 * so a filtered-out subtree could reappear as orphan rows (mode 2) or as a
 * fully revealed subtree under a row that claimed to be a leaf (mode 1).
 * These tests pin both leaks: after the fix, moving the cursor into a hidden
 * subtree or expanding a hidden node must not emit any children for it.
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

const TEMP = path.join('/tmp/opencode', 'rtlens-dbfilter-test');

// top -> u_a (a) -> { u_la (leaf_a), u_mid (mid) -> u_leaf (leaf) };
// top -> u_b (b); top -> u_la2 (leaf_a). `a` and `leaf_a` live in rtl/a.v.
const FILES: [string, string][] = [
  [
    'rtl/a.v',
    'module leaf_a (input wire x); endmodule\n' +
      'module a (input wire x); leaf_a u_la (.x(x)); mid u_mid (.x(x)); endmodule\n',
  ],
  ['rtl/mid.v', 'module mid (input wire x); leaf u_leaf (.x(x)); endmodule\n'],
  ['rtl/leaf.v', 'module leaf (input wire x); endmodule\n'],
  ['rtl/sub/b.v', 'module b (input wire x); endmodule\n'],
  ['top/top.v', 'module top (input wire x); a u_a (.x(x)); b u_b (.x(x)); leaf_a u_la2 (.x(x)); endmodule\n'],
];

/** Fresh per test via `setupSpace`, so no setting leaks into the next test. */
let settings: Record<string, unknown> = { topModules: ['top'], autoUpdateDatabase: false };

const originalConfig = vscode.workspace.getConfiguration;
const originalFindFiles = vscode.workspace.findFiles;
const originalOnDidChangeConfiguration = vscode.workspace.onDidChangeConfiguration;
const originalRegisterWebviewViewProvider = vscode.window.registerWebviewViewProvider;

/** Everything the fake webview saw, plus helpers to drive and query it. */
interface Posted {
  type?: string;
  parentPath?: string;
  rows?: { path: string; childCount?: number; badge?: string }[];
}

function attach(provider: { resolveWebviewView(view: unknown): void }, opts: { ready?: boolean } = {}) {
  const posted: Posted[] = [];
  let onMessage: ((m: unknown) => unknown) | undefined;
  provider.resolveWebviewView({
    webview: {
      options: {},
      html: '',
      onDidReceiveMessage: (f: (m: unknown) => unknown) => {
        onMessage = f;
        if (opts.ready) {
          setTimeout(() => f({ type: 'ready' }), 0);
        }
        return { dispose() {} };
      },
      postMessage: async (m: Posted) => {
        posted.push(m);
      },
    },
  } as unknown as import('vscode').WebviewView);
  return {
    posted,
    send: (m: unknown) => onMessage?.(m),
    rowsPaths: () => {
      const rows = [...posted].reverse().find((m) => m.type === 'rows')?.rows;
      return rows?.map((r) => r.path);
    },
    lastRows: () => [...posted].reverse().find((m) => m.type === 'rows')?.rows,
  };
}

async function waitFor(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) {
      return;
    }
    if (Date.now() - start > ms) {
      assert.fail(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** `children` / `childrenMore` messages posted after the `mark` index. */
function childrenAfter(posted: Posted[], mark: number): Posted[] {
  return posted.slice(mark).filter((m) => m.type === 'children' || m.type === 'childrenMore');
}

function setupSpace(cfg: Record<string, unknown> = {}): void {
  fs.rmSync(TEMP, { recursive: true, force: true });
  fs.mkdirSync(TEMP, { recursive: true });
  for (const [rel, src] of FILES) {
    const abs = path.join(TEMP, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, src);
  }
  settings = { topModules: ['top'], autoUpdateDatabase: false, ...cfg };
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
    { uri: vscode.Uri.file(TEMP), name: 'dbf', index: 0 },
  ];
  (vscode.workspace as { getConfiguration: unknown }).getConfiguration = () => ({
    get: (key: string, fallback: unknown) => (key in settings ? settings[key] : fallback),
  });
  (vscode.workspace as { findFiles: unknown }).findFiles = async () =>
    FILES.map(([rel]) => vscode.Uri.file(path.join(TEMP, rel)));
}

/** Disposables pushed by `activate` in the activation test, released in `after`. */
let extensionSubs: { dispose(): unknown }[] = [];

after(() => {
  for (const d of extensionSubs) {
    if (typeof d?.dispose === 'function') d.dispose();
  }
  extensionSubs = [];
  fs.rmSync(TEMP, { recursive: true, force: true });
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  vscode.workspace.getConfiguration = originalConfig;
  vscode.workspace.findFiles = originalFindFiles;
  vscode.workspace.onDidChangeConfiguration = originalOnDidChangeConfiguration;
  vscode.window.registerWebviewViewProvider = originalRegisterWebviewViewProvider;
});

test('config change: adding a file filter after the tree is shown applies it', async () => {
  setupSpace();
  const { IndexService } = await import('../vscode/indexService');
  const svc = new IndexService(vscode.window.createOutputChannel('test') as never);
  await svc.refresh();

  const { CompositionViewProvider } = await import('../vscode/compView');
  const provider = new CompositionViewProvider(svc);
  const ui = attach(provider);
  await provider.setContext(path.join(TEMP, 'top/top.v'), 0);
  await provider.setExpandedAll(true);
  assert.deepEqual(
    ui.rowsPaths(),
    ['top', 'top.u_a', 'top.u_a.u_la', 'top.u_a.u_mid', 'top.u_a.u_mid.u_leaf', 'top.u_b', 'top.u_la2'],
    'the whole design is on screen without a filter',
  );

  // The user edits the setting: the host re-reads the config and refreshes.
  settings['composition.filterModules'] = ['rtl/a.v'];
  settings['composition.filterMode'] = 2;
  await svc.refresh();
  await provider.refresh();

  assert.deepEqual(
    ui.rowsPaths(),
    ['top', 'top.u_b'],
    '`a` and `leaf_a` are defined in rtl/a.v, so their instance rows disappear with the file filter',
  );
});

test('activate: firing onDidChangeConfiguration applies a filter added in settings', async () => {
  setupSpace();
  let configListener: ((e: { affectsConfiguration: (s: string) => boolean }) => unknown) | undefined;
  (vscode.workspace as { onDidChangeConfiguration: unknown }).onDidChangeConfiguration = (f: never) => {
    configListener = f as never;
    return { dispose() {} };
  };
  let view: { resolveWebviewView: (v: unknown) => void } | undefined;
  (vscode.window as { registerWebviewViewProvider: unknown }).registerWebviewViewProvider = (id: string, p: never) => {
    if (id === 'hdl.composition') view = p as never;
    return { dispose() {} };
  };

  const extension = (await import('../extension')) as typeof import('../extension');
  const ctx = { subscriptions: [] as { dispose(): unknown }[] };
  extension.activate(ctx as never);
  extensionSubs = ctx.subscriptions;

  // Activation does not scan; the command the user can run does.
  await vscode.commands.executeCommand('hdl.connectView.refreshIndex');

  const ui = attach(view!, { ready: true });
  await waitFor(() => ui.rowsPaths() !== undefined, 'the first rows to arrive');
  assert.deepEqual(
    ui.rowsPaths(),
    ['top', 'top.u_a', 'top.u_b', 'top.u_la2'],
    'the root level is on screen before the filter is set',
  );

  settings['composition.filterModules'] = ['rtl/a.v'];
  settings['composition.filterMode'] = 2;
  // The listener runs the refresh command asynchronously; poll for the result.
  configListener!({ affectsConfiguration: (s) => s === 'hdl.connectView' || s.startsWith('hdl.connectView.composition') });
  await waitFor(
    () => JSON.stringify(ui.rowsPaths()) === JSON.stringify(['top', 'top.u_b']),
    'the settings change to reach the composition view',
  );
  assert.deepEqual(ui.rowsPaths(), ['top', 'top.u_b'], 'the file filter is applied after the config change');
});

test('db source: file path filter hides modules defined in that file', async () => {
  setupSpace({ 'composition.filterModules': ['rtl/a.v'], 'composition.filterMode': 2 });
  const { IndexService } = await import('../vscode/indexService');
  const { CatalogService } = await import('../vscode/catalog');
  const svc = new IndexService(vscode.window.createOutputChannel('test') as never);
  for (const [rel, src] of FILES) svc.index.addFile(path.join(TEMP, rel), src);
  const catalog = new CatalogService(svc as never, { appendLine() {} } as never);
  await catalog.refresh('full');
  catalog.dispose();

  const { CompositionStore } = await import('../vscode/compositionStore');
  assert.ok(CompositionStore.open(TEMP), 'the hierarchy DB is on disk');

  const { CompositionViewProvider } = await import('../vscode/compView');
  const provider = new CompositionViewProvider(svc);
  const ui = attach(provider);
  await provider.setContext(path.join(TEMP, 'top/top.v'), 0);
  await provider.setExpandedAll(true);
  assert.deepEqual(
    ui.rowsPaths(),
    ['top', 'top.u_b'],
    '`a` and `leaf_a` live in rtl/a.v, so only `b` survives (db source)',
  );
});

test('db source: a module-name filter hides instances of that module', async () => {
  setupSpace({ 'composition.filterModules': ['a'], 'composition.filterMode': 2 });
  const { IndexService } = await import('../vscode/indexService');
  const { CatalogService } = await import('../vscode/catalog');
  const svc = new IndexService(vscode.window.createOutputChannel('test') as never);
  for (const [rel, src] of FILES) svc.index.addFile(path.join(TEMP, rel), src);
  const catalog = new CatalogService(svc as never, { appendLine() {} } as never);
  await catalog.refresh('full');
  catalog.dispose();

  const { CompositionStore } = await import('../vscode/compositionStore');
  assert.ok(CompositionStore.open(TEMP), 'the hierarchy DB is on disk');

  const { CompositionViewProvider } = await import('../vscode/compView');
  const provider = new CompositionViewProvider(svc);
  const ui = attach(provider);
  await provider.setContext(path.join(TEMP, 'top/top.v'), 0);
  await provider.setExpandedAll(true);
  assert.deepEqual(
    ui.rowsPaths(),
    ['top', 'top.u_b', 'top.u_la2'],
    'module `a` is resolved against the db store and hidden by name (db source)',
  );
});

test('config change: a name filter reaches a DB-backed tree through the host refresh path', async () => {
  setupSpace();
  const { IndexService } = await import('../vscode/indexService');
  const { CatalogService } = await import('../vscode/catalog');
  const svc = new IndexService(vscode.window.createOutputChannel('test') as never);
  for (const [rel, src] of FILES) svc.index.addFile(path.join(TEMP, rel), src);
  const catalog = new CatalogService(svc as never, { appendLine() {} } as never);
  await catalog.refresh('full');
  catalog.dispose();

  const { CompositionViewProvider } = await import('../vscode/compView');
  const provider = new CompositionViewProvider(svc);
  const ui = attach(provider);
  await provider.setContext(path.join(TEMP, 'top/top.v'), 0);
  await provider.setExpandedAll(true);
  assert.deepEqual(
    ui.rowsPaths(),
    ['top', 'top.u_a', 'top.u_a.u_la', 'top.u_a.u_mid', 'top.u_a.u_mid.u_leaf', 'top.u_b', 'top.u_la2'],
    'the whole design is on screen without a filter',
  );

  // The user edits the setting; the host path is refreshIndex -> svc.refresh()
  // (which rereads the config) -> composition.refresh().
  settings['composition.filterModules'] = ['a'];
  settings['composition.filterMode'] = 2;
  await svc.refresh();
  await provider.refresh();

  assert.deepEqual(
    ui.rowsPaths(),
    ['top', 'top.u_b', 'top.u_la2'],
    'the name filter applies to the db-backed tree after the host refresh',
  );
});

test('mode 2: following the cursor into a hidden subtree streams nothing', async () => {
  setupSpace({ 'composition.filterModules': ['a'], 'composition.filterMode': 2 });
  const { IndexService } = await import('../vscode/indexService');
  const svc = new IndexService(vscode.window.createOutputChannel('test') as never);
  await svc.refresh();

  const { CompositionViewProvider } = await import('../vscode/compView');
  const provider = new CompositionViewProvider(svc);
  const ui = attach(provider);
  await provider.setContext(path.join(TEMP, 'top/top.v'), 0);
  assert.deepEqual(ui.rowsPaths(), ['top', 'top.u_b', 'top.u_la2'], 'the `a` instance row is hidden (mode 2)');

  const mark = ui.posted.length;
  // The cursor sits in `leaf`, which is only instantiated under the hidden `a`.
  await provider.setContext(path.join(TEMP, 'rtl/leaf.v'), 0);
  const leaked = childrenAfter(ui.posted, mark).filter(
    (m) => (m.parentPath ?? '').startsWith('top.u_a') || (m.rows ?? []).some((r) => r.path.startsWith('top.u_a.')),
  );
  assert.deepEqual(leaked, [], 'no children of a filtered subtree reach the webview');
  assert.ok(
    ui.posted.slice(mark).some((m) => m.type === 'highlightPath'),
    'the reveal still ran (it just has nothing to highlight inside the hidden subtree)',
  );
});

test('mode 1: following the cursor below a pruned instance streams nothing', async () => {
  setupSpace({ 'composition.filterModules': ['a'], 'composition.filterMode': 1 });
  const { IndexService } = await import('../vscode/indexService');
  const svc = new IndexService(vscode.window.createOutputChannel('test') as never);
  await svc.refresh();

  const { CompositionViewProvider } = await import('../vscode/compView');
  const provider = new CompositionViewProvider(svc);
  const ui = attach(provider);
  await provider.setContext(path.join(TEMP, 'top/top.v'), 0);
  assert.deepEqual(
    ui.rowsPaths(),
    ['top', 'top.u_a', 'top.u_b', 'top.u_la2'],
    'mode 1 keeps the filtered instance row itself',
  );
  const prunedRow = ui.lastRows()!.find((r) => r.path === 'top.u_a')!;
  assert.equal(prunedRow.childCount, 0, 'the pruned row claims to be a leaf');
  assert.ok((prunedRow.badge ?? '').includes('filtered'), 'and is badged as filtered');

  const mark = ui.posted.length;
  await provider.setContext(path.join(TEMP, 'rtl/leaf.v'), 0);
  const leaked = childrenAfter(ui.posted, mark).filter(
    (m) => (m.parentPath ?? '').startsWith('top.u_a') || (m.rows ?? []).some((r) => r.path.startsWith('top.u_a.')),
  );
  assert.deepEqual(leaked, [], 'the pruned subtree stays hidden even when the cursor is below it');
  assert.ok(ui.posted.slice(mark).some((m) => m.type === 'highlightPath'), 'the reveal still ran');
});

test('mode 2: an expand answers a visible parent without its filtered child', async () => {
  // The parent guard (childRows on a dropped node) is not enough here: `u_a`
  // is visible and expanding it streams its level, but one of its children
  // (`u_mid`, module `mid`) is filtered out - that child must be skipped while
  // its sibling (`u_la`) still arrives.
  setupSpace({ 'composition.filterModules': ['mid'], 'composition.filterMode': 2 });
  const { IndexService } = await import('../vscode/indexService');
  const svc = new IndexService(vscode.window.createOutputChannel('test') as never);
  await svc.refresh();

  const { CompositionViewProvider } = await import('../vscode/compView');
  const provider = new CompositionViewProvider(svc);
  const ui = attach(provider);
  await provider.setContext(path.join(TEMP, 'top/top.v'), 0);
  assert.deepEqual(ui.rowsPaths(), ['top', 'top.u_a', 'top.u_b', 'top.u_la2']);

  const mark = ui.posted.length;
  ui.send({ type: 'expand', path: 'top.u_a' });
  await waitFor(
    () => childrenAfter(ui.posted, mark).some((m) => m.parentPath === 'top.u_a'),
    'the expand to be answered',
  );
  const answer = childrenAfter(ui.posted, mark).find((m) => m.parentPath === 'top.u_a')!;
  assert.deepEqual(
    (answer.rows ?? []).map((r) => r.path),
    ['top.u_a.u_la'],
    'the filtered `u_mid` is skipped, its visible sibling still streams',
  );
});

test('mode 2: an expand that raced a config change does not stream a hidden level', async () => {
  setupSpace({ 'composition.filterModules': ['a'], 'composition.filterMode': 2 });
  const { IndexService } = await import('../vscode/indexService');
  const svc = new IndexService(vscode.window.createOutputChannel('test') as never);
  await svc.refresh();

  const { CompositionViewProvider } = await import('../vscode/compView');
  const provider = new CompositionViewProvider(svc);
  const ui = attach(provider);
  await provider.setContext(path.join(TEMP, 'top/top.v'), 0);
  assert.deepEqual(ui.rowsPaths(), ['top', 'top.u_b', 'top.u_la2']);

  // The webview still shows `u_a` (the filter landed after it rendered) and
  // asks for its children; the host must refuse because the node is hidden now.
  const mark = ui.posted.length;
  ui.send({ type: 'expand', path: 'top.u_a' });
  await waitFor(
    () => childrenAfter(ui.posted, mark).some((m) => m.parentPath === 'top.u_a'),
    'the expand to be answered',
  );
  const answers = childrenAfter(ui.posted, mark).filter((m) => m.parentPath === 'top.u_a');
  assert.equal(answers.length, 1, 'exactly one answer for the expand request');
  assert.deepEqual(answers[0].rows, [], 'the hidden level answers with no rows');
});
