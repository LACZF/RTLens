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



test('composition webview: a row click jumps to its instance, not line 0', async () => {
  const svc = await svcWith({ topModules: ['top'] });
  const { CompositionViewProvider } = await import('../vscode/compView');
  const { buildHierarchy } = await import('../core/hierarchy');

  const src =
    'module leaf (input wire a, output wire s); assign s = a; endmodule\n' +
    'module top (input wire i, output wire o);\n' +
    '  leaf u (.a(i), .s(o));\n' +
    'endmodule\n';
  svc.index.addFile('/w/top.v', src);
  const root = buildHierarchy(svc.index, 'top')!.root;

  const provider = new CompositionViewProvider(svc);
  provider.setRoot(root, 'top');

  let onMsg: ((m: unknown) => void) | undefined;
  provider.resolveWebviewView({
    webview: {
      options: {},
      html: '',
      onDidReceiveMessage: (cb: (m: unknown) => void) => {
        onMsg = cb;
        return { dispose() {} };
      },
      postMessage: async () => undefined,
    },
  } as unknown as import('vscode').WebviewView);

  const cmds = vscode.commands as unknown as { executeCommand: (id: string, ...a: unknown[]) => unknown };
  const original = cmds.executeCommand;
  const calls: { id: string; args: unknown[] }[] = [];
  cmds.executeCommand = (id: string, ...args: unknown[]) => {
    calls.push({ id, args });
    return undefined;
  };
  try {
    onMsg!({ type: 'open', path: 'top.u' });
  } finally {
    cmds.executeCommand = original;
  }

  assert.equal(calls.length, 1, 'clicking a row asks the host to open it');
  assert.equal(calls[0].id, 'hdl.connectView.revealInstance');
  const arg = calls[0].args[0] as { file?: string; node?: { nameRange?: unknown; moduleNameRange?: unknown } };
  assert.equal(arg.file, '/w/top.v', 'the jump uses the parent file that holds the instantiation');
  assert.ok(arg.node, 'the full instance node travels so the command can find its name range');
  assert.ok(
    arg.node!.nameRange || arg.node!.moduleNameRange,
    'the node carries a range, so the jump lands on the instance and not line 0',
  );
});

test('composition webview: the title button expands/collapses all and reflects its state', async () => {
  const svc = await svcWith({ topModules: ['top'] });
  const { CompositionViewProvider } = await import('../vscode/compView');
  svc.index.addFile('/w/top.v', 'module leaf (input wire a, output wire s); assign s=a; endmodule\n' +
    'module top (input wire i, output wire o); leaf u (.a(i), .s(o)); endmodule\n');
  const provider = new CompositionViewProvider(svc);

  const posted: { type?: string; expanded?: boolean }[] = [];
  let onMsg: ((m: unknown) => void) | undefined;
  provider.resolveWebviewView({
    webview: {
      options: {},
      html: '',
      onDidReceiveMessage: (cb: (m: unknown) => void) => {
        onMsg = cb;
        return { dispose() {} };
      },
      postMessage: async (m: { type?: string; expanded?: boolean }) => {
        posted.push(m);
      },
    },
  } as unknown as import('vscode').WebviewView);

  provider.setExpandedAll(false);
  provider.setExpandedAll(true);
  assert.deepEqual(
    posted.filter((m) => m.type === 'setExpanded').map((m) => m.expanded),
    [false, true],
    'the button asks the webview to open or fold every row',
  );

  // The webview reports its state back; the host publishes it so the title
  // button can switch between Expand all and Collapse all.
  const cmds = vscode.commands as unknown as { executeCommand: (id: string, ...a: unknown[]) => unknown };
  const original = cmds.executeCommand;
  const calls: { id: string; args: unknown[] }[] = [];
  cmds.executeCommand = (id: string, ...args: unknown[]) => {
    calls.push({ id, args });
    return undefined;
  };
  try {
    onMsg!({ type: 'expandState', expanded: true });
    onMsg!({ type: 'expandState', expanded: false });
  } finally {
    cmds.executeCommand = original;
  }
  assert.deepEqual(calls, [
    { id: 'setContext', args: ['hdl.compositionExpanded', true] },
    { id: 'setContext', args: ['hdl.compositionExpanded', false] },
  ]);
});

test('composition webview: follows the editor by highlighting the current module without moving the root', async () => {
  const src =
    'module leaf (input wire a, output wire s); assign s = a; endmodule\n' +
    'module top (input wire i, output wire o); leaf u (.a(i), .s(o)); endmodule\n';
  const svc = await svcWith();
  svc.index.addFile('/w/h.v', src);
  const { CompositionViewProvider } = await import('../vscode/compView');
  const provider = new CompositionViewProvider(svc);

  const posted: { type?: string; path?: string }[] = [];
  provider.resolveWebviewView({
    webview: {
      options: {},
      html: '',
      onDidReceiveMessage: () => ({ dispose() {} }),
      postMessage: async (m: { type?: string; path?: string }) => {
        posted.push(m);
      },
    },
  } as unknown as import('vscode').WebviewView);

  // Active module `top`: the design-top row is highlighted.
  provider.setContext('/w/h.v', 1);
  assert.equal(provider.root, 'top', 'the tree roots at the design top, not the cursor module');
  assert.deepEqual(
    [posted[posted.length - 1].type, posted[posted.length - 1].path],
    ['highlightPath', 'top'],
  );

  // Move to `leaf`: the root stays put, the highlight follows down to its row.
  const before = posted.length;
  provider.setContext('/w/h.v', 0);
  assert.equal(provider.root, 'top', 'moving inside the design does not move the root');
  const moved = posted.slice(before);
  assert.equal(moved.filter((m) => m.type === 'rows').length, 0, 'no rebuild when only the highlight changes');
  assert.deepEqual(
    moved.filter((m) => m.type === 'highlightPath').map((m) => m.path),
    ['top.u'],
    'the highlight follows to the module under the cursor',
  );

  // A fresh tree opened directly on the nested module roots at the design top
  // (found upward from the cursor module) rather than at that module.
  const fresh = new CompositionViewProvider(svc);
  fresh.setContext('/w/h.v', 0);
  assert.equal(fresh.root, 'top', 'a fresh tree roots at the design top of the cursor module');

  // A configured top pins the root; the highlight is located inside the full design.
  const pinnedSvc = await svcWith({ topModules: ['top'] });
  pinnedSvc.index.addFile('/w/h.v', src);
  const pinned = new CompositionViewProvider(pinnedSvc);
  const pinnedPosted: { type?: string; path?: string }[] = [];
  pinned.resolveWebviewView({
    webview: {
      options: {},
      html: '',
      onDidReceiveMessage: () => ({ dispose() {} }),
      postMessage: async (m: { type?: string; path?: string }) => {
        pinnedPosted.push(m);
      },
    },
  } as unknown as import('vscode').WebviewView);

  pinned.setContext('/w/h.v', 0);
  assert.equal(pinned.root, 'top', 'a configured top stays the root');
  assert.equal(
    pinnedPosted[pinnedPosted.length - 1].path,
    'top.u',
    'the highlight is located by module name inside the configured top',
  );
  pinned.setContext('/w/h.v', 1);
  assert.equal(pinnedPosted[pinnedPosted.length - 1].path, 'top', 'the root module highlights itself');
});

test('composition webview: points at an instantiation or its connections to highlight the instance row', async () => {
  // Mirrors the real chip_top fixture: `datapath #(...)` puts the instantiated
  // module name and the instance name on different lines, and the port
  // connections `.port(expr)` span further lines still.
  const src =
    'module control (input wire clk, input wire busy); endmodule\n' +
    'module datapath (input wire clk, input wire a); endmodule\n' +
    'module chip_top (input wire clk);\n' +
    '  control u_ctrl (\n' +
    '    .clk(clk),\n' +
    '    .busy(busy)\n' +
    '  );\n' +
    '  datapath #(\n' +
    '    .WIDTH(8)\n' +
    '  ) u_dpath (\n' +
    '    .clk(clk),\n' +
    '    .a(operand_a)\n' +
    '  );\n' +
    'endmodule\n';
  const svc = await svcWith();
  svc.index.addFile('/w/chip_top.v', src);
  const { CompositionViewProvider } = await import('../vscode/compView');
  const provider = new CompositionViewProvider(svc);

  const posted: { type?: string; path?: string }[] = [];
  provider.resolveWebviewView({
    webview: {
      options: {},
      html: '',
      onDidReceiveMessage: () => ({ dispose() {} }),
      postMessage: async (m: { type?: string; path?: string }) => {
        posted.push(m);
      },
    },
  } as unknown as import('vscode').WebviewView);
  const lastPath = () => posted[posted.length - 1].path;

  const mod = svc.index.resolveModule('chip_top')!;
  const ctrl = mod.instances.find((i) => i.name === 'u_ctrl')!;
  const dpath = mod.instances.find((i) => i.name === 'u_dpath')!;
  const busy = ctrl.connections.find((c) => c.portName === 'busy')!;
  const a = dpath.connections.find((c) => c.portName === 'a')!;
  const at = (r: { start: { line: number; character: number } }) => [r.start.line, r.start.character] as const;

  // Cursor on the instance name / module name: that instance row.
  provider.setContext('/w/chip_top.v', ...at(ctrl.nameRange));
  assert.equal(lastPath(), 'chip_top.u_ctrl', 'pointing at u_ctrl highlights its row');
  provider.setContext('/w/chip_top.v', ...at(ctrl.moduleNameRange));
  assert.equal(lastPath(), 'chip_top.u_ctrl', 'pointing at the module name of the instantiation too');

  // Cursor on a port connection: still the same instance row, even though the
  // connection sits several lines below the instance name.
  provider.setContext('/w/chip_top.v', ...at(busy.range));
  assert.equal(lastPath(), 'chip_top.u_ctrl', 'the .busy(busy) connection tracks to u_ctrl');

  // The parameterized instantiation follows from its module name, its instance
  // name, and its connections alike.
  provider.setContext('/w/chip_top.v', ...at(dpath.moduleNameRange));
  assert.equal(lastPath(), 'chip_top.u_dpath', 'pointing at the module name a few lines above the name');
  provider.setContext('/w/chip_top.v', ...at(dpath.nameRange));
  assert.equal(lastPath(), 'chip_top.u_dpath', 'pointing at u_dpath highlights its row');
  provider.setContext('/w/chip_top.v', ...at(a.range));
  assert.equal(lastPath(), 'chip_top.u_dpath', 'the .a(operand_a) connection tracks to u_dpath');

  // Cursor in the module but off any instantiation: the module row.
  provider.setContext('/w/chip_top.v', mod.nameRange.start.line, 0);
  assert.equal(lastPath(), 'chip_top', 'off an instantiation, the module itself is highlighted');
});

test("composition: its depth and instance budget are its own settings, unlimited by default", async () => {
  const { findByPath } = await import('../core/hierarchy');
  const src = [
    'module m0 (); m1 u (); endmodule',
    'module m1 (); m2 u (); endmodule',
    'module m2 (); m3 u (); endmodule',
    'module m3 (); endmodule',
  ].join('\n');

  // The global hierarchy keeps its depth cap...
  const svc = await svcWith({ maxDepth: 1 });
  svc.index.addFile('/w/chain.v', src);
  assert.equal(
    findByPath(svc.hierarchy('m0')!.root, 'm0.u')?.children?.length,
    0,
    'the global hierarchy keeps the configured depth cap',
  );
  // ...but the Composition tree ignores it and expands the whole design.
  assert.ok(
    findByPath(svc.compositionHierarchy('m0')!.root, 'm0.u.u.u'),
    'the Composition tree is not bound by the global depth cap',
  );

  // And the Composition tree has its own cap, set independently.
  const capped = await svcWith({ maxDepth: 8, 'composition.maxDepth': 1 });
  capped.index.addFile('/w/chain.v', src);
  assert.equal(
    findByPath(capped.compositionHierarchy('m0')!.root, 'm0.u')?.children?.length,
    0,
    'the Composition depth cap applies to the Composition tree only',
  );
  assert.ok(
    findByPath(capped.hierarchy('m0')!.root, 'm0.u.u.u'),
    'the global tree is untouched by the Composition cap',
  );
});

test('composition: the provider roots at the composition limits, ignoring the global depth cap', async () => {
  // The reveal command builds its root through this provider, so it has to use
  // the same (unlimited) budget as the view - a global cap here would hand the
  // webview a truncated tree on reveal.
  const { findByPath } = await import('../core/hierarchy');
  const src = [
    'module m0 (); m1 u (); endmodule',
    'module m1 (); m2 u (); endmodule',
    'module m2 (); m3 u (); endmodule',
    'module m3 (); endmodule',
  ].join('\n');
  const svc = await svcWith({ maxDepth: 1 });
  svc.index.addFile('/w/chain.v', src);
  const { CompositionTreeProvider } = await import('../vscode/views');
  const tree = new CompositionTreeProvider(svc);
  tree.setContext('/w/chain.v', 0);
  assert.equal(tree.root, 'm0', 'the tree roots at the active module');
  assert.ok(
    findByPath(tree.hierarchyRoot!, 'm0.u.u.u'),
    'the provider expands past the global depth cap',
  );
});

test('composition: a cut subtree is marked, not shown as a leaf', async () => {
  const svc = await svcWith();
  const { CompositionViewProvider } = await import('../vscode/compView');
  const { buildHierarchy } = await import('../core/hierarchy');
  svc.index.addFile('/w/cyc.v', 'module a (); a u (); endmodule\n');
  const root = buildHierarchy(svc.index, 'a', { maxDepth: 0, maxInstances: 0 })!.root;
  const provider = new CompositionViewProvider(svc);
  provider.setRoot(root, 'a');
  const row = provider.modelFor('a.u')!;
  assert.equal(row.truncated, true, 'the recursive instance is flagged');
  assert.match(row.badge, /cycle/, 'and its badge says why it has no children');
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