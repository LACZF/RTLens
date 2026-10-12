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
