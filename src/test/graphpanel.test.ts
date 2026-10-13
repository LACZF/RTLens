/**
 * The extension half of the graph: how `GraphPanel` decides which module is the
 * root and which containing modules sit above it.
 *
 * The webview suite drives the drawing from a graph handed to the script; this
 * one drives the panel itself, so the walk from a bare module definition up to
 * the design that instantiates it (chip_top above datapath above adder) is
 * covered end to end.
 */
import { test, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Module } from 'node:module';

import { vscode } from './vscodeStub';

// The stub has to be installed before graphPanel (and everything it imports)
// asks for the `vscode` module.
const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = loader._load;
loader._load = function (request: string, ...rest: unknown[]) {
  return request === 'vscode' ? vscode : originalLoad(request, ...rest);
};

const FIXTURES = path.resolve(__dirname, '..', '..', 'test', 'fixtures');

interface WebviewPanel {
  __posted: { type: string; [k: string]: unknown }[];
  __send: (m: unknown) => void;
}

async function setup() {
  const { IndexService } = await import('../vscode/indexService');
  const { GraphPanel } = await import('../vscode/graphPanel');
  const svc = new IndexService(vscode.window.createOutputChannel('test'));
  for (const name of fs.readdirSync(path.join(FIXTURES, 'lib'))) {
    if (!/\.(v|sv|svh|vh)$/.test(name)) {
      continue;
    }
    const file = path.join(FIXTURES, 'lib', name);
    svc.index.addFile(file, fs.readFileSync(file, 'utf8'));
  }
  return { svc, GraphPanel };
}

function lastGraph(): { root: string } & Record<string, unknown> {
  const panels = (vscode as unknown as { __webviews: WebviewPanel[] }).__webviews;
  const panel = panels[panels.length - 1];
  const msg = panel.__posted.find((m) => m.type === 'graph');
  assert.ok(msg, 'the panel posted a graph');
  return msg.graph as { root: string } & Record<string, unknown>;
}

function lastMeta() {
  const panels = (vscode as unknown as { __webviews: WebviewPanel[] }).__webviews;
  const panel = panels[panels.length - 1];
  return panel.__posted.find((m) => m.type === 'graph')!;
}

after(() => vscode.__webviews && ((vscode as unknown as { __webviews: unknown[] }).__webviews.length = 0));

test('graphpanel: opening from a module definition re-roots the walk at the design', async () => {
  const { svc, GraphPanel } = await setup();
  const { buildHierarchy } = await import('../core/hierarchy');
  const root = buildHierarchy(svc.index, 'adder')!.root;
  GraphPanel.show(svc, vscode.Uri.file('/x'), root, root.path);
  const graph = lastGraph();
  const meta = lastMeta();
  assert.equal(graph.root, 'chip_top.u_dpath.u_adder', 'the graph is rooted at the instance, not the bare module');
  assert.equal(meta.ancestorsShown, 0, 'no containing module is drawn yet');
  assert.equal(meta.ancestorsLeft, 2, 'datapath and chip_top are available above');
  GraphPanel.disposeAll();
});

test('graphpanel: a real top keeps an empty chain', async () => {
  const { svc, GraphPanel } = await setup();
  const { buildHierarchy } = await import('../core/hierarchy');
  const root = buildHierarchy(svc.index, 'chip_top')!.root;
  GraphPanel.show(svc, vscode.Uri.file('/y'), root, root.path);
  const graph = lastGraph();
  const meta = lastMeta();
  assert.equal(graph.root, 'chip_top', 'a top is its own root');
  assert.equal(meta.ancestorsLeft, 0, 'nothing sits above a top');
  GraphPanel.disposeAll();
});

test('graphpanel: "show more" pages the children of a wide module', async () => {
  const { svc, GraphPanel } = await setup();
  // Wide enough that drawing every child and its wiring exceeds the default
  // node budget: the paged "show more" must grant budget pages, not just widen
  // the signal window, or the last children stay behind the 800-node cut.
  const N = 250;
  let src = 'module leaf (input wire a, input wire b, output wire s); assign s = a & b; endmodule\n';
  src += 'module wide (input wire din, output wire dout);\n';
  for (let i = 0; i < N; i++) {
    src += `  wire a${i}, b${i}, s${i};\n`;
  }
  for (let i = 0; i < N; i++) {
    src += `  leaf u${i} (.a(a${i}), .b(b${i}), .s(s${i}));\n`;
  }
  src += '  assign dout = s0;\nendmodule\n';
  svc.index.addFile('/w/wide.v', src);
  const { buildHierarchy } = await import('../core/hierarchy');
  const root = buildHierarchy(svc.index, 'wide')!.root;
  GraphPanel.show(svc, vscode.Uri.file('/ww'), root, root.path);
  const panels = (vscode as unknown as { __webviews: WebviewPanel[] }).__webviews;
  const panel = panels[panels.length - 1];
  const flip = () => new Promise((r) => setTimeout(r, 0));
  const latest = () => panel.__posted.filter((p) => p.type === 'graph').pop() as unknown as {
    graph: { nodes: { kind: string }[]; pagedScopes: string[] };
  };
  const instanceCount = () => latest().graph.nodes.filter((n) => n.kind === 'instance' || n.kind === 'root').length;
  const paged = () => latest().graph.pagedScopes;

  panel.__send({ type: 'descendants', path: root.path, expanded: true });
  await flip();
  const firstPage = instanceCount();
  assert.ok(firstPage < 30, 'the first page is capped by the signal budget');
  assert.ok(paged().includes(root.path), 'the box stays paged while children remain');

  for (let i = 0; i < 12 && paged().includes(root.path); i++) {
    panel.__send({ type: 'moreSignals', path: root.path, children: true });
    await flip();
  }
  assert.ok(instanceCount() > firstPage, 'each paged click reveals more children than before');
  assert.equal(instanceCount(), N + 1, 'every child of the wide module is drawn once the pages add up');
  assert.ok(paged().length === 0, 'nothing is left behind the raised window');
  GraphPanel.disposeAll();
});

test('graphpanel: a per-box search reveals what paging and the signal cap hid', async () => {
  const { svc, GraphPanel } = await setup();
  // 250 children so a searched child sits well past the first child page, and
  // 60 ports so a searched signal sits past the per-scope cap.
  let wide = 'module leaf (input wire a, input wire b, output wire s); assign s = a & b; endmodule\n';
  wide += 'module wide (input wire din, output wire dout);\n';
  for (let i = 0; i < 250; i++) wide += `  wire a${i}, b${i}, s${i};\n`;
  for (let i = 0; i < 250; i++) wide += `  leaf u${i} (.a(a${i}), .b(b${i}), .s(s${i}));\n`;
  wide += '  assign dout = s0;\nendmodule\n';
  svc.index.addFile('/w/wide.v', wide);
  let many = 'module many (';
  for (let i = 0; i < 60; i++) many += `input wire p${i}, `;
  many += 'output wire out); assign out = p0; endmodule\n';
  svc.index.addFile('/w/many.v', many);

  const { buildHierarchy } = await import('../core/hierarchy');
  const panels = (vscode as unknown as { __webviews: WebviewPanel[] }).__webviews;
  const flip = () => new Promise((r) => setTimeout(r, 0));

  const wideRoot = buildHierarchy(svc.index, 'wide')!.root;
  GraphPanel.show(svc, vscode.Uri.file('/wq'), wideRoot, wideRoot.path);
  const widePanel = panels[panels.length - 1];
  const widePaths = () =>
    (widePanel.__posted.filter((p) => p.type === 'graph').pop()!.graph as {
      nodes: { path: string }[];
    }).nodes.map((n) => n.path);

  assert.ok(!widePaths().includes(wideRoot.path + '.u200'), 'the deep child is not drawn up front');
  widePanel.__send({ type: 'boxSearch', path: wideRoot.path, query: 'u200' });
  await flip();
  assert.ok(widePaths().includes(wideRoot.path + '.u200'), 'the searched child is revealed');

  const manyRoot = buildHierarchy(svc.index, 'many')!.root;
  GraphPanel.show(svc, vscode.Uri.file('/wm'), manyRoot, manyRoot.path);
  const manyPanel = panels[panels.length - 1];
  const manyPaths = () =>
    (manyPanel.__posted.filter((p) => p.type === 'graph').pop()!.graph as {
      nodes: { path: string }[];
    }).nodes.map((n) => n.path);

  assert.ok(!manyPaths().includes(manyRoot.path + '::p55'), 'the late port is capped away up front');
  manyPanel.__send({ type: 'boxSearch', path: manyRoot.path, query: 'p55' });
  await flip();
  assert.ok(manyPaths().includes(manyRoot.path + '::p55'), 'the searched signal is revealed');
  GraphPanel.disposeAll();
});

test('graphpanel: a box search reaches an internal signal the graph never carried', async () => {
  const { svc, GraphPanel } = await setup();
  // `en` is a plain declaration that only shows up in a sensitivity list, so it
  // is neither a port nor an assign endpoint and the builder would never make a
  // node for it. A search has to pull it in on its own.
  svc.index.addFile('/w/evt.v', [
    'module evt (input wire clk, input wire d, output reg q);',
    '  wire en;',
    '  always @(posedge en) q <= d;',
    'endmodule',
  ].join('\n'));
  const { buildHierarchy } = await import('../core/hierarchy');
  const root = buildHierarchy(svc.index, 'evt')!.root;
  GraphPanel.show(svc, vscode.Uri.file('/we'), root, root.path);
  const panels = (vscode as unknown as { __webviews: WebviewPanel[] }).__webviews;
  const panel = panels[panels.length - 1];
  const flip = () => new Promise((r) => setTimeout(r, 0));
  const paths = () => (panel.__posted.filter((p) => p.type === 'graph').pop()!.graph as {
    nodes: { path: string }[];
  }).nodes.map((n) => n.path);

  assert.ok(!paths().includes(root.path + '::en'), 'the event-only net is not in the graph to begin with');
  panel.__send({ type: 'boxSearch', path: root.path, query: 'en' });
  await flip();
  assert.ok(paths().includes(root.path + '::en'), 'the searched internal signal is materialised');
  GraphPanel.disposeAll();
});
