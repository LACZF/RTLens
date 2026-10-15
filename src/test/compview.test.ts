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

test('composition webview: clicking a row asks the host to reveal it', () => {
  const ui = start(ROWS);
  fire(chevron(drawn(ui.list)[0]), 'click');
  fire(drawn(ui.list)[2], 'click');
  assert.deepEqual(ui.posted, [{ type: 'open', path: 'top.u_top' }]);
});

test('composition webview: a reveal opens the path down to the row and scrolls to it', () => {
  const ui = start(ROWS);
  assert.equal(drawn(ui.list).length, 1);
  ui.message({ type: 'revealPath', path: 'top.u_mid.u_a' });
  const rows = drawn(ui.list);
  assert.ok(rows.some((r) => rowText(r) === 'u_a : leaf'), 'the revealed row is now visible');
  assert.equal(ui.scrollCount(), 1, 'and it is scrolled into view');
});
