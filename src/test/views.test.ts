/**
 * Child paging in the composition tree: a wide module's first page ends in a
 * "load more" row instead of silently truncating, reveal widens the window when
 * the target sits past the first page, and the graph's child page follows the
 * configured `hdl.connectView.defaultChildLimit`.
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

test('composition: a wide module pages its children behind a load-more row', async () => {
  const svc = await svcWith();
  const { CompositionTreeProvider } = await import('../vscode/views');
  const { buildHierarchy } = await import('../core/hierarchy');

  svc.index.addFile('/w/wide.v', leafsSource(250));
  const root = buildHierarchy(svc.index, 'wide')!.root;
  const tree = new CompositionTreeProvider(svc);
  tree.setRoot(root, root.moduleName);

  const top = tree.getChildren()[0];
  assert.equal(top.node.path, root.path);

  const first = tree.getChildren(top);
  const firstReal = first.filter((r) => !r.more);
  const more = first.find((r) => r.more);
  assert.equal(firstReal.length, 40, 'the default page is hdl.connectView.defaultChildLimit');
  assert.ok(more, 'a module wider than the page ends in a load-more row');
  assert.match(more!.label, /210 more children/);
  assert.equal(tree.getChildren(more!).length, 0, 'the load-more row is a leaf');
  assert.equal(tree.getParent(more!), undefined, 'the load-more row has no parent of its own');

  tree.moreChildren(root.path);
  const second = tree.getChildren(top);
  const secondReal = second.filter((r) => !r.more);
  assert.equal(secondReal.length, 80, 'one load-more click reveals the next page');
  assert.ok(second.find((r) => r.more), 'the rest of the module still sits behind another page');

  for (let i = 0; i < 10 && tree.getChildren(top).some((r) => r.more); i++) {
    tree.moreChildren(root.path);
  }
  const last = tree.getChildren(top);
  assert.equal(last.length, 250, 'enough clicks page the whole module');
  assert.ok(!last.some((r) => r.more), 'nothing is left behind once the module fits');
});

test('composition: reveal widens the window onto a target past the first page', async () => {
  const svc = await svcWith();
  const { CompositionTreeProvider } = await import('../vscode/views');
  const { buildHierarchy } = await import('../core/hierarchy');

  svc.index.addFile('/w/wide.v', leafsSource(250));
  const root = buildHierarchy(svc.index, 'wide')!.root;
  const tree = new CompositionTreeProvider(svc);
  tree.setRoot(root, root.moduleName);
  const top = tree.getChildren()[0];

  assert.ok(!tree.getChildren(top).some((r) => r.node?.path === root.children![220].path));

  const row = tree.modelFor(root.children![220].path);
  assert.ok(row, 'reveal finds a child that sits behind the first page');
  assert.equal(row!.node.path, root.children![220].path);
  assert.ok(
    tree.getChildren(top).some((r) => r.node?.path === root.children![220].path),
    'the ancestor window widened far enough to include the target',
  );
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