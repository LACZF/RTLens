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

import { vscode, documentFor } from './vscodeStub';

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

const settle = () => new Promise((r) => setTimeout(r, 0));

/** IndexService whose config reads `customKeys` literally. */
async function svcWith(customKeys: Record<string, unknown> = {}) {
  const { IndexService } = await import('../vscode/indexService');
  const original = workspace.getConfiguration;
  workspace.getConfiguration = () => ({
    get: (key: string, fallback: unknown) => (key in customKeys ? customKeys[key] : fallback),
  });
  const space = vscode.workspace as unknown as {
    workspaceFolders?: { uri: { fsPath: string }; name: string; index: number }[];
  };
  if (!space.workspaceFolders) {
    space.workspaceFolders = [{ uri: vscode.Uri.file('/w'), name: 'w', index: 0 }];
  }
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
  await provider.setRoot(root, 'top');

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

  await provider.setExpandedAll(false);
  await provider.setExpandedAll(true);
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

test('composition webview: the initial root arrives with its first level', async () => {
  const svc = await svcWith({ topModules: ['top'] });
  svc.index.addFile(
    '/w/top.v',
    'module sub (input wire a, output wire s); assign s = a; endmodule\n' +
      'module top (input wire i, output wire o); sub u (.a(i), .s(o)); endmodule\n',
  );
  const { CompositionViewProvider } = await import('../vscode/compView');
  const provider = new CompositionViewProvider(svc);

  const posted: { type?: string; rows?: { path: string; childCount: number }[] }[] = [];
  provider.resolveWebviewView({
    webview: {
      options: {},
      html: '',
      onDidReceiveMessage: () => ({ dispose() {} }),
      postMessage: async (m: { type?: string; rows?: { path: string; childCount: number }[] }) => {
        posted.push(m);
      },
    },
  } as unknown as import('vscode').WebviewView);

  await provider.setContext('/w/top.v', 0);
  const rows = [...posted].reverse().find((m) => m.type === 'rows')?.rows ?? [];
  assert.deepEqual(rows.map((r) => r.path), ['top', 'top.u'], 'the root level is loaded before the first paint');
  assert.equal(rows[0].childCount, 1, 'the root knows it has a child');
});

test('composition webview: refresh rebuilds from the reindexed hierarchy, down to nested children', async () => {
  const svc = await svcWith({ topModules: ['top'] });
  svc.index.addFile('/w/top.v', 'module top (input wire i, output wire o); endmodule\n');
  const { CompositionViewProvider } = await import('../vscode/compView');
  const provider = new CompositionViewProvider(svc);

  const posted: { type?: string; rows?: { path: string; childCount: number }[] }[] = [];
  let onMsg: ((m: unknown) => void) | undefined;
  provider.resolveWebviewView({
    webview: {
      options: {},
      html: '',
      onDidReceiveMessage: (cb: (m: unknown) => void) => {
        onMsg = cb;
        return { dispose() {} };
      },
      postMessage: async (m: { type?: string; rows?: { path: string; childCount: number }[] }) => {
        posted.push(m);
      },
    },
  } as unknown as import('vscode').WebviewView);
  const lastRows = () =>
    [...posted].reverse().find((m) => m.type === 'rows')?.rows ?? [];

  await provider.setContext('/w/top.v', 0);
  assert.deepEqual(lastRows().map((r) => r.path), ['top'], 'the tree starts as a single module');

  // The workspace gains a submodule: `top` now instantiates `sub`, which
  // itself instantiates `leaf` a level further down.
  svc.index.addFile(
    '/w/top.v',
    'module leaf (input wire a, output wire s); assign s = a; endmodule\n' +
    'module sub (input wire a, output wire s); leaf l (.a(a), .s(s)); endmodule\n' +
    'module top (input wire i, output wire o); sub u (.a(i), .s(o)); endmodule\n',
  );
  await provider.refresh();
  // A refresh re-sends the root level and reopens it, so its (new) child
  // arrives with the root; nothing deeper is materialised up front.
  assert.deepEqual(
    lastRows().map((r) => r.path),
    ['top', 'top.u'],
    'refresh sends the root and its first level',
  );
  assert.equal(lastRows()[0].childCount, 1, 'the reindexed root knows it now has a child');

  // Opening `top.u` streams the next level from the new index.
  onMsg!({ type: 'expand', path: 'top' });
  onMsg!({ type: 'expand', path: 'top.u' });
  await settle();
  const children = posted.filter((m) => m.type === 'children');
  assert.deepEqual(
    children.map((m) => (m.rows ?? []).map((r) => r.path)),
    [['top.u.l']],
    'each opened level arrives nested down to the leaves',
  );
});

// VS Code drops every message posted before the webview's document has
// installed its `message` listener, and once the tree is rooted the host only
// ever sends `highlightPath` on a cursor move - so a first `rows` message that
// races the document load leaves the view on "No composition hierarchy"
// forever. The webview has to ask for the tree again once it can receive it.
test('composition webview: rows are delivered after the webview reports ready', async () => {
  const svc = await svcWith({ topModules: ['top'] });
  svc.index.addFile('/w/top.v', 'module top (input wire i, output wire o); endmodule\n');
  const { CompositionViewProvider } = await import('../vscode/compView');
  const provider = new CompositionViewProvider(svc);

  // The tree is rooted while the sidebar is still closed: activation runs
  // `syncEditor` as soon as the scan finishes, long before the view is opened.
  await provider.setContext('/w/top.v', 0, 0);

  const delivered: { type?: string; rows?: { path: string }[] }[] = [];
  let ready = false;
  let onMsg: ((m: unknown) => void) | undefined;
  provider.resolveWebviewView({
    webview: {
      options: {},
      html: '',
      onDidReceiveMessage: (cb: (m: unknown) => void) => {
        onMsg = cb;
        return { dispose() {} };
      },
      // Anything sent before the script has installed its listener never
      // arrives - the real webview behaves the same way.
      postMessage: async (m: { type?: string; rows?: { path: string }[] }) => {
        if (ready) {
          delivered.push(m);
        }
      },
    },
  } as unknown as import('vscode').WebviewView);

  // The document has installed its listener by now, so anything sent from
  // here on arrives - the script asks for the tree at that point.
  ready = true;
  onMsg!({ type: 'ready' });
  await settle();

  const rows = delivered.filter((m) => m.type === 'rows');
  assert.equal(rows.length, 1, 'exactly one rebuild is delivered once the webview can receive it');
  assert.deepEqual(
    rows[0].rows!.map((r) => r.path),
    ['top'],
    'the tree rooted before the view opened arrives instead of an empty view',
  );
});

// A reindex walks idle -> indexing -> ready. Dropping the payload on
// `indexing` blanks a view that already has the tree on screen for the whole
// scan - on a large workspace that is seconds of "No composition hierarchy".
test('composition webview: reindexing keeps the tree on screen', async () => {
  const svc = await svcWith({ topModules: ['top'] });
  svc.index.addFile('/w/top.v', 'module top (input wire i, output wire o); endmodule\n');
  const { CompositionViewProvider } = await import('../vscode/compView');
  const provider = new CompositionViewProvider(svc);
  await provider.setContext('/w/top.v', 0, 0);

  const posted: { type?: string; rows?: { path: string }[] }[] = [];
  let onMsg: ((m: unknown) => void) | undefined;
  provider.resolveWebviewView({
    webview: {
      options: {},
      html: '',
      onDidReceiveMessage: (cb: (m: unknown) => void) => {
        onMsg = cb;
        return { dispose() {} };
      },
      postMessage: async (m: { type?: string; rows?: { path: string }[] }) => {
        posted.push(m);
      },
    },
  } as unknown as import('vscode').WebviewView);
  onMsg!({ type: 'ready' });
  await settle();

  const rowPaths = () =>
    posted.filter((m) => m.type === 'rows').map((m) => (m.rows ?? []).map((r) => r.path));
  assert.deepEqual(rowPaths().pop(), ['top'], 'the rooted tree is on screen');

  await svc.ensureReady();

  assert.equal(
    rowPaths().some((paths) => paths.length === 0),
    false,
    'no empty tree is pushed while the workspace is reindexed',
  );
  assert.deepEqual(rowPaths().pop(), ['top'], 'the tree is still there when the scan finishes');
});

// `IndexService.refresh()` tears the index down synchronously and only then
// announces the new state. Views rebuild on `onDidChange` whenever the state
// reads `ready`, so the event has to arrive *after* the state moved to
// `indexing` - otherwise every view rebuilds from a half-cleared index: the
// composition tree loses its root, and with it the expanded frontier (the
// frontier is captured from the root it had, so an empty root loses it for the
// rebuild that follows).
test('index: a rebuild announces indexing before it clears the index', async () => {
  const svc = await svcWith();
  svc.index.addFile('/w/top.v', 'module top (input wire i, output wire o); endmodule\n');

  const changes: { state: string; files: number }[] = [];
  svc.onDidChange(() => changes.push({ state: svc.state, files: svc.stats.files }));

  await svc.refresh();

  assert.deepEqual(
    changes[0],
    { state: 'indexing', files: 0 },
    'the first change of a rebuild is seen while the index reports indexing, not ready',
  );
});

// `a` is instantiated only under `u_b` and itself instantiates `other`, so the
// two filter modes differ: mode 1 keeps `u_a2 : a` and hides `u_t : other`,
// mode 2 drops `u_a2` and its subtree.
const FILTER_SRC =
  'module other (input wire x); endmodule\n' +
  'module a (input wire x); other u_t (.x(x)); endmodule\n' +
  'module d (input wire x); endmodule\n' +
  'module b (input wire x); a u_a2 (.x(x)); d u_d (.x(x)); endmodule\n' +
  'module c (input wire x); endmodule\n' +
  'module top (input wire x); b u_b (.x(x)); c u_c (.x(x)); endmodule\n';

async function filteredRows(filterMode: number, filterModules: string[] = ['a']) {
  const svc = await svcWith({
    topModules: ['top'],
    'composition.filterModules': filterModules,
    'composition.filterMode': filterMode,
  });
  svc.index.addFile('/w/t.v', FILTER_SRC);
  const { CompositionViewProvider } = await import('../vscode/compView');
  const provider = new CompositionViewProvider(svc);
  const posted: { type?: string; rows?: { path: string; badge: string; childCount: number }[] }[] = [];
  provider.resolveWebviewView({
    webview: {
      options: {},
      html: '',
      onDidReceiveMessage: () => ({ dispose() {} }),
      postMessage: async (m: { type?: string; rows?: { path: string; badge: string; childCount: number }[] }) => {
        posted.push(m);
      },
    },
  } as unknown as import('vscode').WebviewView);
  await provider.setContext('/w/t.v', 0);
  // Expand all so the whole (limit-bounded) tree is materialised and sent,
  // then read its rows.
  await provider.setExpandedAll(true);
  return [...posted].reverse().find((m) => m.type === 'rows')!.rows!;
}

test('composition webview: filter mode 1 keeps a filtered instance but prunes its submodules', async () => {
  const rows = await filteredRows(1);
  assert.deepEqual(
    rows.map((r) => r.path),
    ['top', 'top.u_b', 'top.u_b.u_a2', 'top.u_b.u_d', 'top.u_c'],
    'the `a` instance stays, its submodule `u_t` is gone',
  );
  const filtered = rows.find((r) => r.path === 'top.u_b.u_a2')!;
  assert.equal(filtered.childCount, 0, 'the pruned instance is drawn as a leaf');
  assert.ok(filtered.badge.includes('filtered'), 'the row is marked as filtered');
});

test('composition webview: filter mode 2 drops the filtered instance and its subtree', async () => {
  const rows = await filteredRows(2);
  assert.deepEqual(
    rows.map((r) => r.path),
    ['top', 'top.u_b', 'top.u_b.u_d', 'top.u_c'],
    'the `a` instance and everything below it are hidden',
  );
});

test('composition webview: an empty filter list leaves the tree untouched', async () => {
  const rows = await filteredRows(1, []);
  assert.ok(
    rows.some((r) => r.path === 'top.u_b.u_a2.u_t'),
    'with nothing filtered, `a` still expands into `other`',
  );
});

// `a` (with child `leaf_a`) lives in rtl/a.v, `b` in rtl/sub/b.v, and `top`
// instantiates all of them from top/top.v: a path filter selects modules by
// their defining file, not by the file that instantiates them.
const FILTER_TREE: [string, string][] = [
  [
    '/w/rtl/a.v',
    'module leaf_a (input wire x); endmodule\n' +
      'module a (input wire x); leaf_a u_la (.x(x)); endmodule\n',
  ],
  ['/w/rtl/sub/b.v', 'module b (input wire x); endmodule\n'],
  [
    '/w/top/top.v',
    'module top (input wire x); a u_a (.x(x)); b u_b (.x(x)); leaf_a u_la2 (.x(x)); endmodule\n',
  ],
];

async function treeFilteredRows(filterMode: number, filterModules: string[]) {
  const space = vscode.workspace as unknown as {
    workspaceFolders?: { uri: { fsPath: string }; name: string; index: number }[];
  };
  const previous = space.workspaceFolders;
  space.workspaceFolders = [{ uri: vscode.Uri.file('/w'), name: 'w', index: 0 }];
  try {
    const svc = await svcWith({
      topModules: ['top'],
      'composition.filterModules': filterModules,
      'composition.filterMode': filterMode,
    });
    for (const [file, src] of FILTER_TREE) svc.index.addFile(file, src);
    const { CompositionViewProvider } = await import('../vscode/compView');
    const provider = new CompositionViewProvider(svc);
    const posted: { type?: string; rows?: { path: string; badge: string; childCount: number }[] }[] = [];
    provider.resolveWebviewView({
      webview: {
        options: {},
        html: '',
        onDidReceiveMessage: () => ({ dispose() {} }),
        postMessage: async (m: { type?: string; rows?: { path: string; badge: string; childCount: number }[] }) => {
          posted.push(m);
        },
      },
    } as unknown as import('vscode').WebviewView);
    await provider.setContext('/w/top/top.v', 0);
    await provider.setExpandedAll(true);
    return [...posted].reverse().find((m) => m.type === 'rows')!.rows!;
  } finally {
    space.workspaceFolders = previous;
  }
}

test('composition webview: a filter file path hides every module defined in it', async () => {
  const rows = await treeFilteredRows(2, ['rtl/a.v']);
  assert.deepEqual(
    rows.map((r) => r.path),
    ['top', 'top.u_b'],
    '`a` and `leaf_a` are defined in rtl/a.v, so their instances go; `b` stays',
  );
});

test('composition webview: a filter directory path hides every module under it', async () => {
  const rows = await treeFilteredRows(2, ['rtl']);
  assert.deepEqual(rows.map((r) => r.path), ['top'], 'a, leaf_a and b all live under rtl/');
});

test('composition webview: an absolute filter path skips workspace resolution', async () => {
  const rows = await treeFilteredRows(2, ['/w/rtl/sub']);
  assert.deepEqual(
    rows.map((r) => r.path),
    ['top', 'top.u_a', 'top.u_a.u_la', 'top.u_la2'],
    'only `b`, defined under rtl/sub, is filtered',
  );
});

test('composition webview: mode 1 prunes a module selected by file path', async () => {
  const rows = await treeFilteredRows(1, ['rtl/a.v']);
  assert.deepEqual(
    rows.map((r) => r.path),
    ['top', 'top.u_a', 'top.u_b', 'top.u_la2'],
    'the `a` instance stays; its child `u_la` is hidden',
  );
  const pruned = rows.find((r) => r.path === 'top.u_a')!;
  assert.equal(pruned.childCount, 0, 'the filtered instance is drawn as a leaf');
  assert.ok(pruned.badge.includes('filtered'), 'it is marked as filtered');
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
  await provider.setContext('/w/h.v', 1);
  assert.equal(provider.root, 'top', 'the tree roots at the design top, not the cursor module');
  assert.deepEqual(
    [posted[posted.length - 1].type, posted[posted.length - 1].path],
    ['highlightPath', 'top'],
  );

  // Move to `leaf`: the root stays put, the highlight follows down to its row.
  const before = posted.length;
  await provider.setContext('/w/h.v', 0);
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
  await fresh.setContext('/w/h.v', 0);
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

  await pinned.setContext('/w/h.v', 0);
  assert.equal(pinned.root, 'top', 'a configured top stays the root');
  assert.equal(
    pinnedPosted[pinnedPosted.length - 1].path,
    'top.u',
    'the highlight is located by module name inside the configured top',
  );
  await pinned.setContext('/w/h.v', 1);
  assert.equal(pinnedPosted[pinnedPosted.length - 1].path, 'top', 'the root module highlights itself');
});

test('composition webview: opening a different file carries the fold flag, same-file moves do not', async () => {
  const svc = await svcWith();
  svc.index.addFile('/w/top.v', 'module top (input wire i, output wire o);\n  leaf u (.a(i), .s(o));\nendmodule\n');
  svc.index.addFile('/w/leaf.v', 'module leaf (input wire a, output wire s); assign s = a; endmodule\n');
  const { CompositionViewProvider } = await import('../vscode/compView');
  const provider = new CompositionViewProvider(svc);

  const posted: { type?: string; path?: string; collapseOthers?: boolean }[] = [];
  provider.resolveWebviewView({
    webview: {
      options: {},
      html: '',
      onDidReceiveMessage: () => ({ dispose() {} }),
      postMessage: async (m: { type?: string; path?: string; collapseOthers?: boolean }) => {
        posted.push(m);
      },
    },
  } as unknown as import('vscode').WebviewView);
  const last = () => posted[posted.length - 1];
  const foldFlags = () =>
    posted.filter((m) => m.type === 'highlightPath').map((m) => !!m.collapseOthers);

  // The first file opens the tree: an open, so the flag rides along (a fresh
  // tree has nothing folded away yet, making the flag a no-op).
  await provider.setContext('/w/top.v', 0, 0);
  assert.deepEqual([last().path, last().collapseOthers], ['top', true]);

  // Moving the cursor inside that file (onto the instantiation) must not fold.
  const inst = svc.index.resolveModule('top')!.instances[0]!;
  await provider.setContext('/w/top.v', inst.nameRange.start.line, inst.nameRange.start.character);
  assert.deepEqual(
    [last().path, last().collapseOthers],
    ['top.u', undefined],
    'a same-file cursor move carries no fold flag',
  );

  // Switching to the instance's file folds again.
  await provider.setContext('/w/leaf.v', 0, 0);
  assert.deepEqual(
    [last().path, last().collapseOthers],
    ['top.u', true],
    'a file switch carries the fold flag',
  );

  // A non-HDL editor reveals nothing and does not reset the marker: coming
  // back to the same file is still a cursor move, not a new open.
  await provider.setContext(undefined, undefined);
  await provider.setContext('/w/leaf.v', 0, 4);
  assert.deepEqual(
    [last().path, last().collapseOthers],
    ['top.u', undefined],
    'returning from a non-HDL editor is not a switch',
  );

  assert.deepEqual(foldFlags(), [true, false, true, false]);
});

test('composition webview: the editor-follow path carries the fold flag on a file open', async () => {
  // The extension never calls setContext directly on editor events: every
  // active-editor switch and cursor move arrives through followEditor. The
  // fold flag has to survive that path, or the tree never folds in the real
  // app no matter how well setContext itself behaves.
  const svc = await svcWith();
  svc.index.addFile('/w/top.v', 'module top (input wire i, output wire o);\n  leaf u (.a(i), .s(o));\nendmodule\n');
  svc.index.addFile('/w/leaf.v', 'module leaf (input wire a, output wire s); assign s = a; endmodule\n');
  const { CompositionViewProvider } = await import('../vscode/compView');
  const provider = new CompositionViewProvider(svc);

  const posted: { type?: string; path?: string; collapseOthers?: boolean }[] = [];
  provider.resolveWebviewView({
    visible: true,
    webview: {
      options: {},
      html: '',
      onDidReceiveMessage: () => ({ dispose() {} }),
      postMessage: async (m: { type?: string; path?: string; collapseOthers?: boolean }) => {
        posted.push(m);
      },
    },
  } as unknown as import('vscode').WebviewView);
  const last = () => posted[posted.length - 1];

  await provider.followEditor('/w/top.v', 0, 0);
  assert.deepEqual(
    [last().path, last().collapseOthers],
    ['top', true],
    'opening a file through followEditor carries the fold flag',
  );

  // Moving the cursor inside that file (onto the instantiation) must not fold.
  const inst = svc.index.resolveModule('top')!.instances[0]!;
  await provider.followEditor('/w/top.v', inst.nameRange.start.line, inst.nameRange.start.character);
  assert.deepEqual(
    [last().path, last().collapseOthers],
    ['top.u', undefined],
    'a same-file cursor move through followEditor carries no fold flag',
  );

  // Switching to the instance's file folds again.
  await provider.followEditor('/w/leaf.v', 0, 0);
  assert.deepEqual(
    [last().path, last().collapseOthers],
    ['top.u', true],
    'switching files through followEditor carries the fold flag',
  );
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
  await provider.setContext('/w/chip_top.v', ...at(ctrl.nameRange));
  assert.equal(lastPath(), 'chip_top.u_ctrl', 'pointing at u_ctrl highlights its row');
  await provider.setContext('/w/chip_top.v', ...at(ctrl.moduleNameRange));
  assert.equal(lastPath(), 'chip_top.u_ctrl', 'pointing at the module name of the instantiation too');

  // Cursor on a port connection: still the same instance row, even though the
  // connection sits several lines below the instance name.
  await provider.setContext('/w/chip_top.v', ...at(busy.range));
  assert.equal(lastPath(), 'chip_top.u_ctrl', 'the .busy(busy) connection tracks to u_ctrl');

  // The parameterized instantiation follows from its module name, its instance
  // name, and its connections alike.
  await provider.setContext('/w/chip_top.v', ...at(dpath.moduleNameRange));
  assert.equal(lastPath(), 'chip_top.u_dpath', 'pointing at the module name a few lines above the name');
  await provider.setContext('/w/chip_top.v', ...at(dpath.nameRange));
  assert.equal(lastPath(), 'chip_top.u_dpath', 'pointing at u_dpath highlights its row');
  await provider.setContext('/w/chip_top.v', ...at(a.range));
  assert.equal(lastPath(), 'chip_top.u_dpath', 'the .a(operand_a) connection tracks to u_dpath');

  // Cursor in the module but off any instantiation: the module row.
  await provider.setContext('/w/chip_top.v', mod.nameRange.start.line, 0);
  assert.equal(lastPath(), 'chip_top', 'off an instantiation, the module itself is highlighted');
});

test('composition webview: a deep cursor-follow streams one level per children message', async () => {
  // The webview splices a 'children' payload directly after the parent row and
  // the flush after a deep cursor-follow posts one message per materialised
  // level, so every payload must hold exactly one level: a whole subtree here
  // would splice the deeper rows once per ancestor and draw them duplicated.
  const src = [
    'module m0 (); m1 u (); endmodule',
    'module m1 (); m2 u (); endmodule',
    'module m2 (); m3 u (); endmodule',
    'module m3 (); m4 u (); endmodule',
    'module m4 (); endmodule',
  ].join('\n');
  const svc = await svcWith({ topModules: ['m0'] });
  svc.index.addFile('/w/chain.v', src);
  const { CompositionViewProvider } = await import('../vscode/compView');
  const provider = new CompositionViewProvider(svc);

  const posted: { type?: string; parentPath?: string; rows?: { path: string; parentPath: string }[] }[] = [];
  provider.resolveWebviewView({
    webview: {
      options: {},
      html: '',
      onDidReceiveMessage: () => ({ dispose() {} }),
      postMessage: async (m: (typeof posted)[number]) => {
        posted.push(m);
      },
    },
  } as unknown as import('vscode').WebviewView);

  // The cursor sits in the leaf module, four instance levels below the root.
  await provider.setContext('/w/chain.v', 4, 0);

  const streamed = posted.filter((m) => m.type === 'children');
  assert.ok(streamed.length >= 3, 'the walk down to the leaf streams each newly opened level');
  for (const msg of streamed) {
    for (const r of msg.rows ?? []) {
      assert.equal(
        r.parentPath,
        msg.parentPath,
        `children(${msg.parentPath}) must carry only its own level, got ${r.path}`,
      );
    }
  }
  const paths = streamed.flatMap((m) => (m.rows ?? []).map((r) => r.path));
  assert.equal(new Set(paths).size, paths.length, 'no instance row is streamed twice');
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
  await provider.setRoot(root, 'a');
  const row = (await provider.modelFor('a.u'))!;
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

test('composition webview: a hidden view does not parse the active buffer', async () => {
  const svc = await svcWith();
  const { CompositionViewProvider } = await import('../vscode/compView');
  const source = 'module top (input wire a, output wire b); assign b = a; endmodule\n';
  const doc = documentFor('/w/hidden.v', source);
  let reads = 0;
  doc.getText = () => {
    reads++;
    return source;
  };
  vscode.workspace.textDocuments.push(doc);
  try {
    const provider = new CompositionViewProvider(svc);
    provider.followEditor(doc.fileName, 0, 0);
    await settle();
    assert.equal(reads, 0, 'the hidden view keeps only the editor context, without parsing');
  } finally {
    vscode.workspace.textDocuments.pop();
  }
});

after(() => vscode.__webviews && ((vscode as unknown as { __webviews: unknown[] }).__webviews.length = 0));