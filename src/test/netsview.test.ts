/**
 * The nets webview, run for real against a stub DOM.
 *
 * The filter lives inside the webview, so only this test can reach it. It loads
 * the actual script and checks which rows survive a space-separated fuzzy query
 * and which letters are highlighted.
 */
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
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

// Same handshake as Composition: rows posted before the document has installed
// its `message` listener never arrive, and afterwards the host only re-sends
// them on an index change - so a view opened on an already-indexed file would
// sit on its empty placeholder.
test('nets webview: rows are delivered after the webview reports ready', async () => {
  const { IndexService } = await import('../vscode/indexService');
  const { NetsViewProvider } = await import('../vscode/netsView');
  const svc = new IndexService(vscode.window.createOutputChannel('test'));
  svc.index.addFile('/w/m.v', 'module m (input wire clk, output wire q); assign q = clk; endmodule\n');

  const provider = new NetsViewProvider(svc);
  // The module is resolved while the sidebar is still closed.
  provider.setContext('/w/m.v', 0);

  const delivered: { type?: string }[] = [];
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
      postMessage: async (m: { type?: string }) => {
        if (ready) {
          delivered.push(m);
        }
      },
    },
  } as unknown as import('vscode').WebviewView);

  // The document has installed its listener by now, so anything sent from
  // here on arrives - the script asks for the rows at that point.
  ready = true;
  onMsg!({ type: 'ready' });

  assert.ok(
    delivered.some((m) => m.type === 'rows'),
    'the rows reach the webview once it can receive them',
  );
});

// A reindex clears the index and only then announces the new state, so a view
// that rebuilds on every change reads the half-cleared index and pushes an
// empty list - the rows would blink out for the whole scan. The rebuild has to
// wait for `ready`, the same way the composition tree does.
const TEMP = path.join('/tmp/opencode', 'rtlens-nets-test');
const FILE = path.join(TEMP, 'm.v');
const SRC = 'module m (input wire clk, output wire q); assign q = clk; endmodule\n';

after(() => {
  fs.rmSync(TEMP, { recursive: true, force: true });
});

test('nets webview: reindexing keeps the rows on screen', async () => {
  fs.rmSync(TEMP, { recursive: true, force: true });
  fs.mkdirSync(TEMP, { recursive: true });
  fs.writeFileSync(FILE, SRC);
  const folders = (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders;
  const findFiles = (vscode.workspace as { findFiles: unknown }).findFiles;
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
    { uri: vscode.Uri.file(TEMP), name: 'nets', index: 0 },
  ];
  // The scan only re-ingests what findFiles hands back, so the file that has
  // to survive the reindex is offered here.
  (vscode.workspace as { findFiles: unknown }).findFiles = async () => [vscode.Uri.file(FILE)];

  try {
    const { IndexService } = await import('../vscode/indexService');
    const { NetsViewProvider } = await import('../vscode/netsView');
    const svc = new IndexService(vscode.window.createOutputChannel('test'));
    svc.index.addFile(FILE, SRC);

    const provider = new NetsViewProvider(svc);

    const posted: { type?: string; rows?: unknown[] }[] = [];
    let ready = false;
    provider.resolveWebviewView({
      webview: {
        options: {},
        html: '',
        onDidReceiveMessage: () => ({ dispose() {} }),
        // Anything sent before the script has installed its listener never
        // arrives - the real webview behaves the same way.
        postMessage: async (m: { type?: string; rows?: unknown[] }) => {
          if (ready) {
            posted.push(m);
          }
        },
      },
    } as unknown as import('vscode').WebviewView);

    // The document has installed its listener by now, so anything sent from
    // here on arrives - the context set below is what puts the rows on screen.
    ready = true;
    provider.setContext(FILE, 0);

    const rowCounts = () =>
      posted.filter((m) => m.type === 'rows').map((m) => (m.rows ?? []).length);
    assert.ok(rowCounts().pop()! > 0, 'the rows are on screen');

    await svc.refresh();

    assert.equal(
      rowCounts().some((n) => n === 0),
      false,
      'no empty row list is pushed while the workspace is reindexed',
    );
    assert.ok(rowCounts().pop()! > 0, 'the rows are still there when the scan finishes');
    svc.dispose();
  } finally {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = folders;
    (vscode.workspace as { findFiles: unknown }).findFiles = findFiles;
  }
});
