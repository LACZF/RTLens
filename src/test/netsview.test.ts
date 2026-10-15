/**
 * The nets webview, run for real against a stub DOM.
 *
 * The filter lives inside the webview, so only this test can reach it. It loads
 * the actual script and checks which rows survive a space-separated fuzzy query
 * and which letters are highlighted.
 */
import { test, before } from 'node:test';
import * as assert from 'node:assert/strict';
import { Module } from 'node:module';

import { vscode } from './vscodeStub';

// The stub has to be in place before netsView asks for the `vscode` module.
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

  private text = '';

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  get textContent(): string {
    return this.text;
  }
  set textContent(v: string) {
    this.text = v;
    if (v === '') this.children = [];
  }

  setAttribute(k: string, v: unknown): void {
    this.attrs[k] = String(v);
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  appendChild<T extends FakeEl>(c: T): T {
    this.children.push(c);
    return c;
  }
  addEventListener(type: string, fn: Listener): void {
    (this.listeners[type] ??= []).push(fn);
  }
}

function fire(el: FakeEl, type: string, ev: Record<string, unknown> = {}): void {
  for (const fn of el.listeners[type] ?? []) {
    fn({ stopPropagation: () => {}, ...ev });
  }
}

function drawn(list: FakeEl): FakeEl[] {
  return list.children;
}

function rowText(row: FakeEl): string {
  const nm = row.children.find((c) => c.attrs.class === 'nm')!;
  let s = nm.textContent;
  for (const c of nm.children) s += c.textContent;
  return s;
}

let SCRIPT: string | undefined;

before(async () => {
  const mod = (await import('../vscode/netsView')) as { SCRIPT: string };
  SCRIPT = mod.SCRIPT;
});

function start(rows: unknown[]): { list: FakeEl; input: FakeEl; empty: FakeEl } {
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
  run(() => ({ postMessage: () => {} }), doc, win);
  for (const fn of winListeners.message ?? []) {
    fn({ data: { type: 'rows', module: 'm', file: '/w/m.v', rows } });
  }
  return { list: elements.list, input: elements.q, empty: elements.empty };
}

function row(name: string, isPort = false): unknown {
  return { name, isPort, tooltip: name, description: '', line: 1 };
}

const ROWS = [row('clk'), row('clk_enable'), row('rst_n')];

test('nets webview: every signal is drawn when the filter is empty', () => {
  const ui = start(ROWS);
  assert.deepEqual(drawn(ui.list).map(rowText), ['clk', 'clk_enable', 'rst_n']);
});

test('nets webview: a space separated query matches every token as a subsequence', () => {
  const ui = start(ROWS);
  ui.input.value = 'clk n';
  fire(ui.input, 'input');

  const rows = drawn(ui.list);
  assert.deepEqual(
    rows.map(rowText),
    ['clk_enable'],
    'only clk_enable has both "clk" and a later "n"',
  );
  const nm = rows[0].children.find((c) => c.attrs.class === 'nm')!;
  assert.deepEqual(
    nm.children.filter((c) => c.tagName === 'b').map((c) => c.textContent),
    ['c', 'l', 'k', 'n'],
    'every character of every token is highlighted',
  );
});

test('nets webview: a space separated query with an unmatched token hides everything', () => {
  const ui = start(ROWS);
  ui.input.value = 'clk zzz';
  fire(ui.input, 'input');
  assert.equal(drawn(ui.list).length, 0, 'no signal satisfies every token');
  assert.equal(ui.empty.style.display, 'block');
});
