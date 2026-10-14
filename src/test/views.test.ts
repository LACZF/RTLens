/**
 * Composition tree shape: every child is listed (no paging), each level starts
 * collapsed and expands into its own children down to the leaves, reveal finds
 * a node anywhere, the root follows the configured top or the active module, the
 * nets list filters by signal name, and the graph's child page still follows
 * `hdl.connectView.defaultChildLimit`.
 */
import { test, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { Module } from 'node:module';

import { vscode } from './vscodeStub';

// The stub has to be installed before indexService (and views) ask for the
// `vscode` module.
const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = loader._load;
loader._load = function (request: string, ...rest: unknown[]) {
  return request === 'vscode' ? vscode : originalLoad(request, ...rest);
};

const workspace = vscode.workspace as unknown as {
  getConfiguration: (s: string) => { get: (k: string, fb: unknown) => unknown };
};

/** IndexService whose config reads `customKeys` literally. */
async function svcWith(customKeys: Record<string, unknown> = {}) {
  const { IndexService } = await import('../vscode/indexService');
  const original = workspace.getConfiguration;
  workspace.getConfiguration = () => ({
    get: (key: string, fallback: unknown) => (key in customKeys ? customKeys[key] : fallback),
  });
  try {
    return new IndexService(vscode.window.createOutputChannel('test'));
  } finally {
    workspace.getConfiguration = original;
  }
}

function leafsSource(n: number): string {
  let src = 'module leaf (input wire a, input wire b, output wire s); assign s = a & b; endmodule\n';
  src += 'module wide (input wire din, output wire dout);\n';
  for (let i = 0; i < n; i++) {
    src += `  wire a${i}, b${i}, s${i};\n`;
  }
  for (let i = 0; i < n; i++) {
    src += `  leaf u${i} (.a(a${i}), .b(b${i}), .s(s${i}));\n`;
  }
  src += '  assign dout = s0;\nendmodule\n';
  return src;
}

test('composition: a wide module lists every child and starts collapsed', async () => {
  const svc = await svcWith();
  const { CompositionTreeProvider } = await import('../vscode/views');
  const { buildHierarchy } = await import('../core/hierarchy');

  svc.index.addFile('/w/wide.v', leafsSource(250));
  const root = buildHierarchy(svc.index, 'wide')!.root;
  const tree = new CompositionTreeProvider(svc);
  tree.setRoot(root, root.moduleName);

  const top = tree.getChildren()[0];
  assert.equal(top.node.path, root.path);

  const kids = tree.getChildren(top);
  assert.equal(kids.length, 250, 'every child is handed to the tree, with no load-more row');
  assert.equal(
    tree.getTreeItem(top).collapsibleState,
    vscode.TreeItemCollapsibleState.Collapsed,
    'a module with children starts collapsed',
  );
  assert.equal(
    tree.getTreeItem(kids[0]).collapsibleState,
    vscode.TreeItemCollapsibleState.None,
    'a leaf offers no expander',
  );
  assert.equal(tree.getChildren(kids[0]).length, 0, 'expanding a leaf yields nothing');
});

test('composition: reveal finds a child anywhere in a wide module', async () => {
  const svc = await svcWith();
  const { CompositionTreeProvider } = await import('../vscode/views');
  const { buildHierarchy } = await import('../core/hierarchy');

  svc.index.addFile('/w/wide.v', leafsSource(250));
  const root = buildHierarchy(svc.index, 'wide')!.root;
  const tree = new CompositionTreeProvider(svc);
  tree.setRoot(root, root.moduleName);

  const row = tree.modelFor(root.children![220].path);
  assert.ok(row, 'reveal finds a child deep in a wide module');
  assert.equal(row!.node.path, root.children![220].path);
});

test('composition: roots at the configured top, else at the active module', async () => {
  const src =
    '// header comment, no module on this line\n' +
    'module leaf (input wire a, output wire s); assign s = a; endmodule\n' +
    'module top (input wire i, output wire o); leaf u (.a(i), .s(o)); endmodule\n';

  const { CompositionTreeProvider } = await import('../vscode/views');

  // A configured top wins: the tree shows the whole design no matter the cursor.
  const withTop = await svcWith({ topModules: ['top'] });
  withTop.index.addFile('/w/h.v', src);
  const treeTop = new CompositionTreeProvider(withTop);
  treeTop.setContext('/w/h.v', 0);
  assert.equal(treeTop.root, 'top', 'the configured top roots the tree');
  treeTop.setContext('/w/h.v', 2);
  assert.equal(treeTop.root, 'top', 'the cursor does not move a top-rooted tree');

  // Without a configured top the tree follows the module under the cursor.
  const auto = await svcWith();
  auto.index.addFile('/w/h.v', src);
  const treeAuto = new CompositionTreeProvider(auto);
  treeAuto.setContext('/w/h.v', 2);
  assert.equal(treeAuto.root, 'top', 'the active module roots the tree');
  treeAuto.setContext('/w/h.v', 1);
  assert.equal(treeAuto.root, 'leaf', 'the tree follows the cursor to another module');

  // A cursor above the first `module` (a header comment) still roots the tree:
  // a fresh tree opens on the file's first module rather than staying empty.
  const fresh = new CompositionTreeProvider(auto);
  fresh.setContext('/w/h.v', 0);
  assert.equal(fresh.root, 'leaf', 'a cursor above the first module falls back to that module');
});



test('composition: the graph child page follows defaultChildLimit', async () => {
  const svc = await svcWith({ defaultChildLimit: 13, 'graph.maxSignalsPerGroup': 10000 });
  const { GraphPanel } = await import('../vscode/graphPanel');
  const { buildHierarchy } = await import('../core/hierarchy');

  svc.index.addFile('/w/wide.v', leafsSource(1100));
  const root = buildHierarchy(svc.index, 'wide')!.root;
  GraphPanel.show(svc, vscode.Uri.file('/ww'), root, root.path);
  const panels = (vscode as unknown as { __webviews: { __posted: unknown[]; __send: (m: unknown) => void }[] }).__webviews;
  const panel = panels[panels.length - 1];
  const flip = () => new Promise((r) => setTimeout(r, 0));
  const latest = () => panel.__posted.filter((p) => (p as { type?: string }).type === 'graph').pop() as {
    graph: { nodes: { kind: string }[]; pagedScopes: string[] };
  };
  const instanceCount = () => latest().graph.nodes.filter((n) => n.kind === 'instance' || n.kind === 'root').length;

  panel.__send({ type: 'descendants', path: root.path, expanded: true });
  await flip();
  assert.equal(instanceCount(), 14, 'the first reveal is one page of 13 children plus the root');
  assert.ok(latest().graph.pagedScopes.includes(root.path), 'the box stays paged while children remain');

  panel.__send({ type: 'moreSignals', path: root.path, children: true });
  await flip();
  assert.equal(instanceCount(), 27, 'one child page reveals the configured 13 more children');
  panel.__send({ type: 'moreSignals', path: root.path, children: true });
  await flip();
  assert.equal(instanceCount(), 40, 'the next child page reveals 13 more again');

  GraphPanel.disposeAll();
});

after(() => vscode.__webviews && ((vscode as unknown as { __webviews: unknown[] }).__webviews.length = 0));