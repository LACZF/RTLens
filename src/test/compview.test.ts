/**
 * The composition webview, run for real against a stub DOM.
 *
 * The webview is one inline script inside an HTML string, so nothing else in
 * the suite can reach the rules that make the hierarchy readable: which rows
 * survive a level's collapse, that a search keeps the path down to a match and
 * forces it open, and that clicking a row asks the host to reveal it. This
 * loads the actual script and checks the rows it draws.
 */
import { test, before } from 'node:test';
import * as assert from 'node:assert/strict';
import { Module } from 'node:module';

import { vscode } from './vscodeStub';

// The stub has to be in place before compView asks for the `vscode` module.
const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = loader._load;
loader._load = function (request: string, ...rest: unknown[]) {
  return request === 'vscode' ? vscode : originalLoad(request, ...rest);
};

type Listener = (ev: { data?: unknown; key?: string; stopPropagation?: () => void }) => void;

class FakeEl {
  readonly tagName: string;
  children: FakeEl[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  style: Record<string, string> = {};
  value = '';
  checked = false;
  scrolledIntoView = false;

  private text = '';

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  get textContent(): string {
    return this.text;
  }
  set textContent(v: string) {
    this.text = v;
    // Real DOM: assigning textContent wipes the element's children.
    if (v === '') this.children = [];
  }

  setAttribute(k: string, v: unknown): void {
    this.attrs[k] = String(v);
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  get classList(): { contains: (c: string) => boolean } {
    const tokens = (this.attrs.class || '').split(/\s+/).filter(Boolean);
    return { contains: (c: string) => tokens.includes(c) };
  }
  appendChild<T extends FakeEl>(c: T): T {
    this.children.push(c);
    return c;
  }
  addEventListener(type: string, fn: Listener): void {
    (this.listeners[type] ??= []).push(fn);
  }
  scrollIntoView(): void {
    this.scrolledIntoView = true;
  }
}

function fire(el: FakeEl, type: string, ev: Record<string, unknown> = {}): void {
  for (const fn of el.listeners[type] ?? []) {
    fn({ stopPropagation: () => {}, ...ev });
  }
}

/** Every row currently drawn, in order. */
function drawn(list: FakeEl): FakeEl[] {
  return list.children;
}

/** The `.tw` (chevron) of a row. */
function chevron(row: FakeEl): FakeEl {
  return row.children.find((c) => c.attrs.class === 'tw' || c.attrs.class === 'tw leaf')!;
}

function rowText(row: FakeEl): string {
  const nm = row.children.find((c) => c.attrs.class === 'nm')!;
  let s = nm.textContent;
  for (const c of nm.children) s += c.textContent;
  return s;
}

let SCRIPT: string | undefined;

before(async () => {
  const mod = (await import('../vscode/compView')) as { SCRIPT: string };
  SCRIPT = mod.SCRIPT;
});

function start(rows: unknown[], rootPath = 'top'): {
  list: FakeEl;
  input: FakeEl;
  posted: Record<string, unknown>[];
  message: (data: Record<string, unknown>) => void;
  scrollCount: () => number;
} {
  const posted: Record<string, unknown>[] = [];
  const elements: Record<string, FakeEl> = {
    q: new FakeEl('input'),
    list: new FakeEl('div'),
    empty: new FakeEl('div'),
    mod: new FakeEl('span'),
    file: new FakeEl('span'),
  };
  const winListeners: Record<string, Listener[]> = {};
  const doc = {
    getElementById: (id: string): FakeEl | null => elements[id] ?? null,
    createElement: (tag: string): FakeEl => new FakeEl(tag),
    createTextNode: (text: string): FakeEl => {
      const el = new FakeEl('#text');
      el.textContent = text;
      return el;
    },
  };
  const win = {
    addEventListener: (type: string, fn: Listener): void => {
      (winListeners[type] ??= []).push(fn);
    },
  };
  const run = new Function('acquireVsCodeApi', 'document', 'window', SCRIPT!);
  run(() => ({ postMessage: (m: Record<string, unknown>) => posted.push(m) }), doc, win);
  const message = (data: Record<string, unknown>): void => {
    for (const fn of winListeners.message ?? []) fn({ data });
  };
  message({ type: 'rows', rootModule: 'top', rootPath, file: '/w/top.v', rows });
  return {
    list: elements.list,
    input: elements.q,
    posted,
    message,
    scrollCount: () => drawn(elements.list).filter((r) => r.scrolledIntoView).length,
  };
}

function row(path: string, parentPath: string, instName: string, moduleName: string, depth: number, childCount: number) {
  return {
    path,
    parentPath,
    instName,
    moduleName,
    label: instName || moduleName,
    note: '',
    badge: childCount ? `${childCount} children` : '',
    icon: 'symbol-module',
    childCount,
    depth,
    file: '/w/top.v',
    unresolved: false,
  };
}

// top -> u_mid (mid) -> u_a (leaf); top -> u_top (leaf)
const ROWS = [
  row('top', '', '', 'top', 0, 2),
  row('top.u_mid', 'top', 'u_mid', 'mid', 1, 1),
  row('top.u_mid.u_a', 'top.u_mid', 'u_a', 'leaf', 2, 0),
  row('top.u_top', 'top', 'u_top', 'leaf', 1, 0),
];

test('composition webview: every level starts collapsed', () => {
  const ui = start(ROWS);
  const rows = drawn(ui.list);
  assert.equal(rows.length, 1, 'only the root is shown until it is expanded');
  assert.equal(chevron(rows[0]).textContent, '\u25B6', 'a collapsed row shows a right-pointing chevron');
});

test('composition webview: clicking a chevron expands one level at a time', () => {
  const ui = start(ROWS);

  fire(chevron(drawn(ui.list)[0]), 'click');
  let rows = drawn(ui.list);
  assert.deepEqual(
    rows.map(rowText),
    ['top', 'u_mid : mid', 'u_top : leaf'],
    'expanding the root reveals its direct children only',
  );
  assert.equal(chevron(rows[0]).textContent, '\u25BC', 'an expanded row shows a down chevron');

  fire(chevron(rows[1]), 'click');
  rows = drawn(ui.list);
  assert.equal(rows.length, 4, 'expanding the child reveals its own child');
  assert.ok(rows.some((r) => rowText(r) === 'u_a : leaf'));
});

test('composition webview: a search keeps matches plus their ancestors and opens them', () => {
  const ui = start(ROWS);
  ui.input.value = 'u_a';
  fire(ui.input, 'input');

  const rows = drawn(ui.list);
  assert.deepEqual(
    rows.map(rowText),
    ['top', 'u_mid : mid', 'u_a : leaf'],
    'the match and every ancestor survive; unrelated siblings are dropped',
  );
  // The match is highlighted (a <b> run) and the chevrons show the path is open.
  const leaf = rows[2];
  const nm = leaf.children.find((c) => c.attrs.class === 'nm')!;
  assert.ok(nm.children.some((c) => c.tagName === 'b' && c.textContent === 'a'), 'the matched letter is highlighted');
  assert.equal(chevron(rows[1]).textContent, '\u25BC', 'a path to a match is force-opened');
});

test('composition webview: a space separated query matches every token as a subsequence', () => {
  const ui = start(ROWS);
  ui.input.value = 'u mid';
  fire(ui.input, 'input');

  const rows = drawn(ui.list);
  assert.deepEqual(
    rows.map(rowText),
    ['top', 'u_mid : mid'],
    'both tokens match u_mid and only its ancestors survive',
  );

  const matched = rows[1].children.find((c) => c.attrs.class === 'nm')!;
  const hits = matched.children.filter((c) => c.tagName === 'b').map((c) => c.textContent);
  assert.deepEqual(hits, ['u', 'm', 'i', 'd'], 'both tokens are highlighted within the instance name');
});

test('composition webview: a space separated query with an unmatched token hides everything', () => {
  const ui = start(ROWS);
  ui.input.value = 'mid zzz';
  fire(ui.input, 'input');
  assert.equal(drawn(ui.list).length, 0, 'no row satisfies every token');
});

test('composition webview: clicking a row asks the host to reveal it', () => {
  const ui = start(ROWS);
  fire(chevron(drawn(ui.list)[0]), 'click');
  fire(drawn(ui.list)[2], 'click');
  // The webview also reports its expand state; only the row click is a request.
  assert.deepEqual(
    ui.posted.filter((m) => m.type === 'open'),
    [{ type: 'open', path: 'top.u_top' }],
  );
});

test('composition webview: the title button expands and collapses every level', () => {
  const ui = start(ROWS);
  assert.equal(drawn(ui.list).length, 1, 'a new tree starts fully collapsed');

  ui.message({ type: 'setExpanded', expanded: true });
  assert.deepEqual(
    drawn(ui.list).map(rowText),
    ['top', 'u_mid : mid', 'u_a : leaf', 'u_top : leaf'],
    'expand-all opens every level at once',
  );

  ui.message({ type: 'setExpanded', expanded: false });
  assert.equal(drawn(ui.list).length, 1, 'collapse-all folds the whole tree back to the root');
});

test('composition webview: it reports whether the whole tree is expanded', () => {
  const ui = start(ROWS);
  const states = () => ui.posted.filter((m) => m.type === 'expandState').map((m) => m.expanded);

  assert.deepEqual(states(), [false], 'a new tree reports itself fully collapsed');

  ui.message({ type: 'setExpanded', expanded: true });
  assert.deepEqual(states(), [false, true], 'expand-all reports itself fully expanded');

  // Opening a single level by hand leaves the rest folded: still not "expanded".
  ui.message({ type: 'setExpanded', expanded: false });
  fire(chevron(drawn(ui.list)[0]), 'click');
  assert.deepEqual(states(), [false, true, false], 'a partial expansion does not flip the button');
});

test('composition webview: a reveal opens the path down to the row and scrolls to it', () => {
  const ui = start(ROWS);
  assert.equal(drawn(ui.list).length, 1);
  ui.message({ type: 'revealPath', path: 'top.u_mid.u_a' });
  const rows = drawn(ui.list);
  assert.ok(rows.some((r) => rowText(r) === 'u_a : leaf'), 'the revealed row is now visible');
  assert.equal(ui.scrollCount(), 1, 'and it is scrolled into view');
});

test('composition webview: a highlight marks only the current module row and scrolls to it', () => {
  const ui = start(ROWS);
  assert.equal(drawn(ui.list).length, 1);

  ui.message({ type: 'highlightPath', path: 'top.u_mid.u_a' });
  let rows = drawn(ui.list);
  const leaf = rows.find((r) => rowText(r) === 'u_a : leaf')!;
  assert.ok(leaf, 'the highlighted row is revealed along with its ancestors');
  assert.ok(leaf.classList.contains('sel'), 'the current module row carries the selection class');
  assert.equal(ui.scrollCount(), 1, 'and it is scrolled into view');
  assert.ok(
    rows.filter((r) => r.classList.contains('sel')).length === 1,
    'no other row is marked',
  );

  // The highlight moves with the cursor; the old row is no longer selected.
  ui.message({ type: 'highlightPath', path: 'top.u_top' });
  rows = drawn(ui.list);
  assert.ok(rows.find((r) => rowText(r) === 'u_top : leaf')!.classList.contains('sel'));
  assert.ok(!rows.find((r) => rowText(r) === 'u_a : leaf')!.classList.contains('sel'), 'the previous highlight is cleared');

  // An empty path clears the selection.
  ui.message({ type: 'highlightPath', path: '' });
  assert.equal(drawn(ui.list).filter((r) => r.classList.contains('sel')).length, 0);
});

test('composition webview: collapsing an ancestor hides its whole subtree, grandchildren included', () => {
  // Hidden rows still join the ancestor stack: if they did not, a grandchild
  // seen after a hidden sibling would lose its collapsed ancestor and be drawn.
  const rows = [
    row('top', '', '', 'top', 0, 1),
    row('top.a', 'top', 'a', 'mid', 1, 2),
    row('top.a.b', 'top.a', 'b', 'mid', 2, 1),
    row('top.a.b.d', 'top.a.b', 'd', 'leaf', 3, 0),
    row('top.a.c', 'top.a', 'c', 'leaf', 2, 0),
  ];
  const ui = start(rows);
  fire(chevron(drawn(ui.list)[0]), 'click'); // expand top
  fire(chevron(drawn(ui.list)[1]), 'click'); // expand top.a
  fire(chevron(drawn(ui.list)[2]), 'click'); // expand top.a.b
  assert.deepEqual(
    drawn(ui.list).map(rowText),
    ['top', 'a : mid', 'b : mid', 'd : leaf', 'c : leaf'],
    'both levels are open',
  );

  fire(chevron(drawn(ui.list)[1]), 'click'); // collapse top.a
  assert.deepEqual(
    drawn(ui.list).map(rowText),
    ['top', 'a : mid'],
    'a collapsed row hides every descendant, not just its direct children',
  );
});

test('composition webview: thousands of siblings expand and collapse in one click', () => {
  const wide = [row('top', '', '', 'top', 0, 4000)];
  for (let i = 0; i < 4000; i++) wide.push(row(`top.u${i}`, 'top', `u${i}`, 'leaf', 1, 0));
  const ui = start(wide);
  assert.equal(drawn(ui.list).length, 1, 'the wide level starts collapsed');

  fire(chevron(drawn(ui.list)[0]), 'click');
  assert.equal(drawn(ui.list).length, 4001, 'one click lists every instance, with no paging');

  fire(chevron(drawn(ui.list)[0]), 'click');
  assert.equal(drawn(ui.list).length, 1, 'and one click folds them all away again');
});

test('composition webview: opening an unloaded level asks the host, then splices the level in', () => {
  // Only the root row is present; its level has not been streamed yet.
  const ui = start([row('top', '', '', 'top', 0, 3)]);
  assert.equal(drawn(ui.list).length, 1);

  fire(chevron(drawn(ui.list)[0]), 'click');
  assert.deepEqual(
    ui.posted.filter((m) => m.type === 'expand'),
    [{ type: 'expand', path: 'top' }],
    'an unloaded level is requested from the host',
  );
  assert.equal(drawn(ui.list).length, 1, 'nothing is drawn until the children arrive');

  // The host streams one level; it is spliced right after the parent, open.
  ui.message({
    type: 'children',
    parentPath: 'top',
    rows: [
      row('top.u_mid', 'top', 'u_mid', 'mid', 1, 1),
      row('top.u_top', 'top', 'u_top', 'leaf', 1, 0),
    ],
  });
  assert.deepEqual(
    drawn(ui.list).map(rowText),
    ['top', 'u_mid : mid', 'u_top : leaf'],
    'the streamed children are inserted and the level opens',
  );

  // A nested level is requested the same way and lands under its own parent.
  fire(chevron(drawn(ui.list)[1]), 'click');
  assert.deepEqual(
    ui.posted.filter((m) => m.type === 'expand').map((m) => m.path),
    ['top', 'top.u_mid'],
    'the next unloaded level is requested by its path',
  );
  ui.message({
    type: 'children',
    parentPath: 'top.u_mid',
    rows: [row('top.u_mid.u_a', 'top.u_mid', 'u_a', 'leaf', 2, 0)],
  });
  assert.deepEqual(
    drawn(ui.list).map(rowText),
    ['top', 'u_mid : mid', 'u_a : leaf', 'u_top : leaf'],
    'the nested level is inserted under its parent',
  );

  // A level that is already loaded collapses locally, without asking again.
  fire(chevron(drawn(ui.list)[1]), 'click');
  assert.deepEqual(
    drawn(ui.list).map(rowText),
    ['top', 'u_mid : mid', 'u_top : leaf'],
    'a loaded level folds without another request',
  );
  assert.equal(ui.posted.filter((m) => m.type === 'expand').length, 2, 'no extra expand message');
});

test('composition webview: a level streamed in chunks renders once, in order', () => {
  const ui = start([row('top', '', '', 'top', 0, 4)]);
  ui.message({ type: 'children', parentPath: 'top', rows: [row('top.a', 'top', 'a', 'leaf', 1, 0)], more: true });
  assert.equal(drawn(ui.list).length, 1, 'the first chunk alone does not render');
  ui.message({ type: 'childrenMore', parentPath: 'top', rows: [row('top.b', 'top', 'b', 'leaf', 1, 0)], more: true });
  assert.equal(drawn(ui.list).length, 1, 'a middle chunk alone does not render');
  ui.message({ type: 'childrenMore', parentPath: 'top', rows: [row('top.c', 'top', 'c', 'leaf', 1, 0)], more: false });
  assert.deepEqual(
    drawn(ui.list).map(rowText),
    ['top', 'a : leaf', 'b : leaf', 'c : leaf'],
    'the final chunk renders the whole level, chunks in order',
  );
});

test('composition webview: a file open folds every branch outside the revealed path', () => {
  // top -> a -> {b -> d, c}: the fold must hide d while keeping the path to c open.
  const rows = [
    row('top', '', '', 'top', 0, 1),
    row('top.a', 'top', 'a', 'mid', 1, 2),
    row('top.a.b', 'top.a', 'b', 'mid', 2, 1),
    row('top.a.b.d', 'top.a.b', 'd', 'leaf', 3, 0),
    row('top.a.c', 'top.a', 'c', 'leaf', 2, 0),
  ];
  const ui = start(rows);
  fire(chevron(drawn(ui.list)[0]), 'click'); // expand top
  fire(chevron(drawn(ui.list)[1]), 'click'); // expand top.a
  fire(chevron(drawn(ui.list)[2]), 'click'); // expand top.a.b
  assert.deepEqual(
    drawn(ui.list).map(rowText),
    ['top', 'a : mid', 'b : mid', 'd : leaf', 'c : leaf'],
    'both branches are open before the file opens',
  );

  ui.message({ type: 'highlightPath', path: 'top.a.c', collapseOthers: true });
  assert.deepEqual(
    drawn(ui.list).map(rowText),
    ['top', 'a : mid', 'b : mid', 'c : leaf'],
    'only the path to the revealed row stays open; the other branch folds away',
  );
  const sel = drawn(ui.list).filter((r) => r.classList.contains('sel'));
  assert.equal(sel.length, 1, 'exactly the revealed row is selected');
  assert.equal(rowText(sel[0]), 'c : leaf');

  // The target can already be selected (the cursor re-entered the same
  // module); the fold must still run instead of taking the stutter shortcut.
  fire(chevron(drawn(ui.list)[2]), 'click'); // expand top.a.b again
  ui.message({ type: 'highlightPath', path: 'top.a.c', collapseOthers: true });
  assert.deepEqual(
    drawn(ui.list).map(rowText),
    ['top', 'a : mid', 'b : mid', 'c : leaf'],
    're-revealing the already selected row still folds the other branches',
  );
});

test('composition webview: a highlight without a file open keeps manually expanded branches', () => {
  const rows = [
    row('top', '', '', 'top', 0, 1),
    row('top.a', 'top', 'a', 'mid', 1, 2),
    row('top.a.b', 'top.a', 'b', 'mid', 2, 1),
    row('top.a.b.d', 'top.a.b', 'd', 'leaf', 3, 0),
    row('top.a.c', 'top.a', 'c', 'leaf', 2, 0),
  ];
  const ui = start(rows);
  fire(chevron(drawn(ui.list)[0]), 'click');
  fire(chevron(drawn(ui.list)[1]), 'click');
  fire(chevron(drawn(ui.list)[2]), 'click');

  ui.message({ type: 'highlightPath', path: 'top.a.c' });
  assert.deepEqual(
    drawn(ui.list).map(rowText),
    ['top', 'a : mid', 'b : mid', 'd : leaf', 'c : leaf'],
    'a cursor-move highlight opens the path without folding what the reader expanded',
  );
  assert.ok(drawn(ui.list)[4].classList.contains('sel'), 'the revealed row is selected');
});
