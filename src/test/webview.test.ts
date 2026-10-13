/**
 * The connectivity webview, run for real against a stub DOM.
 *
 * The webview is the only part of the extension the rest of the suite cannot
 * reach: it is one inline script inside an HTML string, so nothing type-checks
 * or tests the rules that make the picture readable - which module owns which
 * signal, where a wire attaches, what folding does to it. This loads the actual
 * script, hands it a graph built by the real builder, and checks the drawing.
 */
import { test, before } from 'node:test';
import * as assert from 'node:assert/strict';
import { Module } from 'node:module';

import { vscode } from './vscodeStub';
import { HdlIndex } from '../core/index';
import { buildHierarchy, findByPath, pathChain } from '../core/hierarchy';
import { buildGraph } from '../core/graph';
import type { Graph } from '../core/graph';

// The stub has to be in place before graphPanel - and everything it imports -
// asks for the `vscode` module.
const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = loader._load;
loader._load = function (request: string, ...rest: unknown[]) {
  return request === 'vscode' ? vscode : originalLoad(request, ...rest);
};

/** Mirrors HEAD_H in the panel script: the height of a module header row. */
const HEAD_H = 26;

const SRC = `
module leaf #(parameter int W = 8) (
  input  wire [W-1:0] a,
  input  wire [W-1:0] b,
  output wire [W-1:0] s,
  output wire         c
);
  assign s = a + b;
  assign c = 1'b0;
endmodule

module top (input wire [7:0] din, input wire [7:0] other, output wire [7:0] dout, output wire flag);
  wire [7:0] mid_out;
  wire       carry;

  mid #(.W (8)) u_mid (.x (din), .y (mid_out), .cout (carry));

  leaf #(.W (8)) u_leaf (
    .a (mid_out),
    .b (other),
    .s (dout),
    .c ()
  );

  leaf u_dangling (.a (din), .b (din), .s (), .c ());
  missing_mod u_missing ();
endmodule

module mid #(parameter int W = 8) (
  input  wire [W-1:0] x,
  output wire [W-1:0] y,
  output wire         cout
);
  wire [W-1:0] t;
  leaf #(.W (W)) u_inner (.a (x), .b (x), .s (t), .c (cout));
  assign y = t;
endmodule
`;

function fixtureGraph(opts: { collapsed?: string[] } = {}): Graph {
  const index = new HdlIndex();
  index.addFile('/w/top.v', SRC);
  const h = buildHierarchy(index, 'top', { maxDepth: 8 })!;
  return buildGraph(index, h.root, { maxDepth: 8, maxNodes: 500, showContainment: true, ...opts });
}

/**
 * A graph rooted at `top.u_mid` with up to `shown` levels of the containing
 * module chain above it, exactly the way GraphPanel.refresh() slices it.
 */
function ancestorGraph(shown: number): Graph {
  const index = new HdlIndex();
  index.addFile('/w/top.v', SRC);
  const h = buildHierarchy(index, 'top', { maxDepth: 8 })!;
  const root = findByPath(h.root, 'top.u_mid')!;
  const chain = pathChain(h.root, root.path).slice(0, -1);
  const first = Math.max(0, chain.length - shown);
  return buildGraph(index, root, {
    maxDepth: 8,
    maxNodes: 500,
    showContainment: true,
    ancestors: chain.slice(first),
  });
}

/**
 * A graph rooted at `top` with the given instance paths expanded. Each path's
 * children are drawn when the path is in `expanded`.
 */
function rootGraph(expanded: string[]): Graph {
  const index = new HdlIndex();
  index.addFile('/w/top.v', SRC);
  const h = buildHierarchy(index, 'top', { maxDepth: 8 })!;
  return buildGraph(index, h.root, {
    maxDepth: 8,
    maxNodes: 500,
    showContainment: true,
    expanded,
  });
}

const CHIP_SRC = `
module chip (input wire [7:0] data, output wire [7:0] out, output wire ok);
  top #(.W (8)) u_top (.din (data), .other (data), .dout (out), .flag (ok));
endmodule
module top #(parameter int W = 8) (
  input  wire [W-1:0] din,
  input  wire [W-1:0] other,
  output wire [W-1:0] dout,
  output wire         flag
);
  wire [W-1:0] mid_out;
  wire         carry;
  mid #(.W (W)) u_mid (.x (din), .y (mid_out), .cout (carry));
endmodule
module mid #(parameter int W = 8) (
  input  wire [W-1:0] x,
  output wire [W-1:0] y,
  output wire         cout
);
  assign y = x;
  assign cout = 1'b0;
endmodule
`;

/**
 * A graph rooted at `chip.u_top.u_mid` with the containing chain chip -> top
 * cut to `shown` parents, so the per-box ancestor marks have two levels to
 * walk instead of the single level the shared fixture offers.
 */
function deepAncestorGraph(shown: number): Graph {
  const index = new HdlIndex();
  index.addFile('/w/chip.v', CHIP_SRC);
  const h = buildHierarchy(index, 'chip', { maxDepth: 8 })!;
  const root = findByPath(h.root, 'chip.u_top.u_mid')!;
  const chain = pathChain(h.root, root.path).slice(0, -1);
  const first = Math.max(0, chain.length - shown);
  return buildGraph(index, root, {
    maxDepth: 8,
    maxNodes: 500,
    showContainment: true,
    ancestors: chain.slice(first),
  });
}

type Listener = (ev: Record<string, unknown>) => void;

function event(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientX: 0,
    clientY: 0,
    stopPropagation() { /* noop */ },
    preventDefault() { /* noop */ },
    ...extra,
  };
}

class FakeEl {
  readonly attrs: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  parent: FakeEl | null = null;
  textContent = '';
  id = '';
  value = '';
  checked = false;
  clientWidth = 800;
  clientHeight = 600;
  readonly style: Record<string, string> = {};
  readonly listeners: Record<string, Listener[]> = {};

  constructor(readonly tagName: string) {}

  private tokens(): string[] {
    return (this.attrs.class || '').split(/\s+/).filter(Boolean);
  }

  readonly classList = {
    add: (...cs: string[]) => {
      const t = new Set(this.tokens());
      for (const c of cs) t.add(c);
      this.attrs.class = [...t].join(' ');
    },
    remove: (...cs: string[]) => {
      const t = new Set(this.tokens());
      for (const c of cs) t.delete(c);
      this.attrs.class = [...t].join(' ');
    },
    toggle: (c: string, force?: boolean) => {
      const has = this.tokens().includes(c);
      const on = force === undefined ? !has : force;
      if (on === has) return on;
      if (on) this.classList.add(c);
      else this.classList.remove(c);
      return on;
    },
    contains: (c: string) => this.tokens().includes(c),
  };

  setAttribute(k: string, v: unknown): void { this.attrs[k] = String(v); }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  appendChild<T extends FakeEl>(c: T): T {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  removeChild(c: FakeEl): FakeEl {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parent = null;
    return c;
  }
  get firstChild(): FakeEl | null { return this.children[0] ?? null; }
  addEventListener(type: string, fn: Listener): void { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(): void { /* noop */ }
}

function fire(el: FakeEl, type: string, extra: Record<string, unknown> = {}): void {
  for (const fn of el.listeners[type] ?? []) fn(event(extra));
}

function find(root: FakeEl, pred: (e: FakeEl) => boolean): FakeEl | undefined {
  if (pred(root)) return root;
  for (const c of root.children) {
    const hit = find(c, pred);
    if (hit) return hit;
  }
  return undefined;
}

function withClass(root: FakeEl, cls: string): FakeEl | undefined {
  return find(root, (e) => e.classList.contains(cls));
}

/** The `M x,y Q cx,cy x2,y2` the panel writes for every edge. */
function parseD(d: string): { pa: { x: number; y: number }; pb: { x: number; y: number } } {
  const m = /^M(-?[\d.]+),(-?[\d.]+) Q(-?[\d.]+),(-?[\d.]+) (-?[\d.]+),(-?[\d.]+)$/.exec(d);
  assert.ok(m, 'unexpected path data: ' + d);
  return {
    pa: { x: Number(m[1]), y: Number(m[2]) },
    pb: { x: Number(m[5]), y: Number(m[6]) },
  };
}

interface Geom {
  key: string;
  head: { id: string; path: string; childCount?: number } | null;
  nets: { id: string; label: string; x: number; y: number; direction?: string }[];
  depth: number;
  w: number;
  h: number;
  x: number;
  y: number;
}
interface Drawn {
  el: FakeEl;
  g: Geom;
  els: { n: { id: string }; el: FakeEl }[];
}
interface PanelApi {
  _els: {
    groups: Drawn[];
    edgeEls: { e: { to: string; from: string; port?: string; kind: string }; el: FakeEl }[];
  } | null;
  redraw: () => void;
}

let SCRIPT: string | undefined;

before(async () => {
  const mod = (await import('../vscode/graphPanel')) as { SCRIPT: string };
  SCRIPT = mod.SCRIPT;
});

function startPanel(
  graph: Graph,
  opts: {
    focus?: string;
    collapsed?: string[];
    ancestorsShown?: number;
    ancestorsLeft?: number;
    expanded?: string[];
  } = {},
) {
  const posted: Record<string, unknown>[] = [];
  const svg = new FakeEl('svg');
  const elements: Record<string, FakeEl> = {
    canvas: svg,
    search: new FakeEl('input'),
    neighbourhood: new FakeEl('input'),
    containment: new FakeEl('input'),
    assigns: new FakeEl('input'),
    hierarchy: new FakeEl('input'),
    stats: new FakeEl('span'),
  };
  elements.assigns.checked = true;
  elements.hierarchy.checked = true;
  const winListeners: Record<string, Listener[]> = {};
  const doc = {
    documentElement: new FakeEl('html'),
    body: { appendChild: <T extends FakeEl>(c: T): T => c },
    getElementById: (id: string): FakeEl | null => elements[id] ?? null,
    createElement: (tag: string): FakeEl => new FakeEl(tag),
    createElementNS: (_ns: string, tag: string): FakeEl => new FakeEl(tag),
  };
  const win = {
    innerWidth: 800,
    innerHeight: 600,
    addEventListener: (type: string, fn: Listener): void => { (winListeners[type] ??= []).push(fn); },
  };
  const run = new Function(
    'acquireVsCodeApi',
    'document',
    'window',
    'getComputedStyle',
    'requestAnimationFrame',
    SCRIPT!,
  );
  run(
    () => ({ postMessage: (m: Record<string, unknown>) => posted.push(m) }),
    doc,
    win,
    () => ({ getPropertyValue: () => '' }),
    () => 0,
  );
  const message = (data: Record<string, unknown>): void => {
    for (const fn of winListeners.message ?? []) fn({ data });
  };
  const winFire = (type: string, ev: Record<string, unknown>): void => {
    for (const fn of winListeners[type] ?? []) fn(event(ev));
  };
  message({
    type: 'graph',
    graph,
    focus: opts.focus,
    collapsed: opts.collapsed ?? [],
    ancestorsShown: opts.ancestorsShown ?? 0,
    ancestorsLeft: opts.ancestorsLeft ?? 0,
    expanded: opts.expanded ?? [],
  });
  const api = (svg as unknown as { __api: PanelApi }).__api;
  return {
    svg,
    api,
    posted,
    message,
    winFire,
    group: (k: string) => api._els!.groups.find((gd) => gd.g.key === k)!,
    search: () => elements.search,
    edge: (to: string, port: string) =>
      api._els!.edgeEls.find((ee) => ee.e.to === to && ee.e.port === port)!,
  };
}

test('the panel reports ready before it draws anything', () => {
  const p = startPanel(fixtureGraph());
  assert.equal(p.posted[0].type, 'ready');
});

test('every module is one box and its signals are rows inside it', () => {
  const p = startPanel(fixtureGraph());
  const groups = p.api._els!.groups;
  assert.deepEqual(
    groups.map((gd) => gd.g.key).sort(),
    ['top', 'top.u_dangling', 'top.u_leaf', 'top.u_mid', 'top.u_mid.u_inner', 'top.u_missing'],
  );

  const top = p.group('top');
  assert.equal(top.g.head!.path, 'top');
  assert.deepEqual(top.g.nets.map((n) => n.label).sort(), ['carry', 'din', 'dout', 'flag', 'mid_out', 'other']);
  // The rows sit inside their own box, one per line, all centred on it.
  for (const n of top.g.nets) {
    assert.equal(n.x, top.g.x, 'a signal row spans its module box');
    assert.ok(n.y > top.g.y - top.g.h / 2 + HEAD_H, n.label + ' is below the header');
    assert.ok(n.y < top.g.y + top.g.h / 2, n.label + ' is above the box edge');
  }
  const ys = top.g.nets.map((n) => n.y);
  assert.deepEqual(ys, [...ys].sort((a, b) => a - b), 'rows read top to bottom without overlap');

  const leaf = p.group('top.u_leaf');
  assert.deepEqual(leaf.g.nets.map((n) => n.label).sort(), ['a', 'b', 'c', 's']);
  const a = leaf.g.nets.findIndex((n) => n.label === 'a');
  const s = leaf.g.nets.findIndex((n) => n.label === 's');
  assert.ok(a < s, 'inputs come before outputs in a group');
  // One row per signal is drawn, plus the header.
  assert.equal(leaf.els.length, leaf.g.nets.length + 1);
  assert.ok(withClass(leaf.el, 'rowg'), 'rows are drawn as their own elements');
});

test('a scope the graph cut short wears a ... row that asks for more signals', () => {
  const g = fixtureGraph();
  g.cappedScopes = ['top'];
  const p = startPanel(g);
  const top = p.group('top');
  const dots = find(top.el, (e) => e.tagName === 'text' && e.textContent === '...');
  assert.ok(dots, 'a capped scope offers a ... row to fetch the rest');

  fire(dots!, 'click');
  const ask = p.posted.find((m) => m.type === 'moreSignals');
  assert.ok(ask, 'the click asks the extension for another page');
  assert.equal(ask!.path, 'top');
  assert.equal(ask!.children, undefined, 'the ... row pages signals, not children');

  const leaf = p.group('top.u_leaf');
  assert.equal(find(leaf.el, (e) => e.tagName === 'text' && e.textContent === '...'), undefined,
    'a scope the graph left whole has no ... row');
});

test('a scope with children behind its window wears a separate more-children row', () => {
  const g = fixtureGraph();
  g.pagedScopes = ['top'];
  const p = startPanel(g);
  const top = p.group('top');
  assert.equal(find(top.el, (e) => e.tagName === 'text' && e.textContent === '...'), undefined,
    'pending children alone do not dress the box in a signal ... row');
  const moreChildren = find(top.el, (e) => e.tagName === 'text' && e.textContent === 'more children');
  assert.ok(moreChildren,
    'a scope still holding children behind the child window offers a more-children row');

  fire(moreChildren!, 'click');
  const ask = p.posted.filter((m) => m.type === 'moreSignals').pop();
  assert.ok(ask, 'the click asks the extension to reveal more children');
  assert.equal(ask!.path, 'top');
  assert.equal(ask!.children, true, 'the more-children row sends the child paging flag');
});

test('a scope cut both ways wears both rows and they page independently', () => {
  const g = fixtureGraph();
  g.cappedScopes = ['top'];
  g.pagedScopes = ['top'];
  const p = startPanel(g);
  const top = p.group('top');
  const signals = find(top.el, (e) => e.tagName === 'text' && e.textContent === '...');
  const children = find(top.el, (e) => e.tagName === 'text' && e.textContent === 'more children');
  assert.ok(signals && children, 'a scope with signals and children both pending offers both rows');
  fire(signals!, 'click');
  fire(children!, 'click');
  const asks = p.posted.filter((m) => m.type === 'moreSignals');
  assert.equal(asks[0].children, undefined, 'the ... row pages signals');
  assert.equal(asks[1].children, true, 'the more-children row pages children');
});


test('a port edge lands on the signal row inside the target module', () => {
  const p = startPanel(fixtureGraph());
  const ed = p.edge('i:top.u_leaf', 'a');
  const { pa, pb } = parseD(ed.el.attrs.d);

  const top = p.group('top').g;
  const leaf = p.group('top.u_leaf').g;
  const midOut = top.nets.find((n) => n.label === 'mid_out')!;
  const portA = leaf.nets.find((n) => n.label === 'a')!;

  // From the driving signal's row, on the side of the box facing the target...
  assert.equal(pa.x, top.x + top.w / 2);
  assert.equal(pa.y, midOut.y);
  // ...to the same-named port row inside the other module, not to its outline.
  assert.equal(pb.x, leaf.x - leaf.w / 2);
  assert.equal(pb.y, portA.y);
  assert.notEqual(pb.y, leaf.y - leaf.h / 2 + HEAD_H / 2, 'the wire does not stop at the module header');
});

test('two signals of one module are joined outside their shared box', () => {
  const p = startPanel(fixtureGraph());
  const assign = p.api._els!.edgeEls.find(
    (x) => x.e.kind === 'net' && x.e.from.startsWith('n:top.u_mid::'),
  );
  assert.ok(assign, 'the continuous assign in mid is drawn');
  const { pa, pb } = parseD(assign!.el.attrs.d);
  const mid = p.group('top.u_mid').g;
  assert.equal(pa.x, mid.x + mid.w / 2, 'both ends leave the box on the same side');
  assert.equal(pb.x, mid.x + mid.w / 2);
  assert.ok(pa.x > mid.x, 'the bow sits outside the module');
  assert.notEqual(pa.y, pb.y, 'the two signals are still told apart by height');
});

test('folding a module hides its rows and reroutes its wires to the header', () => {
  const p = startPanel(fixtureGraph());
  const top = p.group('top');
  const chevron = withClass(top.el, 'chev')!;
  assert.ok(chevron, 'a module with signals wears a chevron');
  assert.equal(chevron.textContent, '▾');

  fire(chevron, 'click');

  const folded = p.group('top');
  assert.equal(folded.g.h, HEAD_H, 'the box collapses to its header');
  assert.equal(folded.els.length, 1, 'no signal rows are drawn');
  assert.equal(withClass(folded.el, 'rowg'), undefined);

  // The wiring survives: it now ends on the module header it used to reach
  // through a row.
  const ed = p.edge('i:top.u_leaf', 'a');
  const { pa } = parseD(ed.el.attrs.d);
  assert.equal(pa.y, folded.g.y - folded.g.h / 2 + HEAD_H / 2);
  assert.equal(pa.x, folded.g.x + folded.g.w / 2);

  fire(withClass(folded.el, 'chev')!, 'click');
  const back = p.group('top');
  assert.equal(back.g.nets.length, 6);
  assert.equal(back.els.length, 7, 'expanding brings every signal row back');
  assert.equal(withClass(back.el, 'chev')!.textContent, '▾');
});

test('double-clicking a header asks the extension to collapse the subtree', () => {
  const p = startPanel(fixtureGraph());
  const mid = p.group('top.u_mid');
  assert.equal(mid.g.head!.childCount, 1);
  const hit = withClass(mid.els[0].el, 'hit')!;
  fire(hit, 'dblclick');
  const msg = p.posted.find((m) => m.type === 'collapse');
  assert.ok(msg, 'a collapse message was posted');
  assert.equal(msg!.path, 'top.u_mid');
  assert.equal(msg!.collapsed, true);
});

test('a hierarchy-collapsed module keeps its box, marked and without children', () => {
  // The extension builds the smaller model *and* echoes the collapse set back,
  // exactly the way GraphPanel.refresh() does.
  const p = startPanel(fixtureGraph({ collapsed: ['top.u_mid'] }), { collapsed: ['top.u_mid'] });
  const keys = p.api._els!.groups.map((gd) => gd.g.key);
  assert.ok(keys.includes('top.u_mid'), 'the collapsed instance keeps its box');
  assert.ok(!keys.includes('top.u_mid.u_inner'), 'nothing below it is expanded');

  const mid = p.group('top.u_mid');
  assert.equal(mid.g.nets.length, 0, 'a collapsed module shows no signals');
  assert.equal(mid.els.length, 1);
  const mark = find(mid.el, (e) => e.tagName === 'text' && e.textContent === '+');
  assert.ok(mark, 'the collapsed box is marked with a +');
});

test('containing modules are hidden and the + reveals one level', () => {
  // One ancestor above the root is available but not drawn yet.
  const p = startPanel(ancestorGraph(0), { ancestorsShown: 0, ancestorsLeft: 1 });

  assert.ok(!p.api._els!.groups.some((gd) => gd.g.key === 'top'), 'the parent module is not drawn yet');
  const root = p.group('top.u_mid');
  const plus = find(root.el, (e) => e.tagName === 'text' && e.textContent === '+' && e.classList.contains('chev'));
  assert.ok(plus, 'the focus wears a + to reveal its containing modules');

  fire(plus!, 'click');
  const msg = p.posted.find((m) => m.type === 'ancestors');
  assert.ok(msg, 'an ancestors message was posted');
  assert.equal(msg!.shown, 1, 'the next containing module is asked for');
});

test('+ reveals the next containing module and - tucks one back', () => {
  // The parent is already drawn; the + asks for one more level above it.
  const g = ancestorGraph(1);
  const p = startPanel(g, { ancestorsShown: 1, ancestorsLeft: 1 });

  assert.ok(p.group('top'), 'the nearest containing module is drawn');
  const top = p.group('top');
  const up = find(top.el, (e) => e.tagName === 'text' && e.textContent === '+' && e.classList.contains('lm'));
  assert.ok(up, 'top wears a + because one more level is hidden above it');
  fire(up!, 'click');
  assert.equal(p.posted.find((m) => m.type === 'ancestors')?.shown, 2, 'the next level is revealed');
});

test('a + with nothing above it hides on click, and a - folds the parent away', () => {
  // Whole chain already drawn: the ancestor has nothing above it, so its left
  // + is a probe that disappears once clicked; the focus still folds its parent.
  const p = startPanel(ancestorGraph(1), { ancestorsShown: 1, ancestorsLeft: 0 });

  const top = p.group('top');
  const probing = find(top.el, (e) => e.tagName === 'text' && e.textContent === '+' && e.classList.contains('lm'));
  assert.ok(probing, 'every box wears a left + by default, even where nothing is above');
  fire(probing!, 'click');
  p.api.redraw();
  const top2 = p.group('top');
  assert.equal(find(top2.el, (e) => e.tagName === 'text' && e.textContent === '+' && e.classList.contains('lm')),
    undefined, 'the probe + hid once it found no containing module');
  assert.equal(p.posted.find((m) => m.type === 'ancestors'), undefined, 'nothing was re-drawn by the extension');

  const root = p.group('top.u_mid');
  assert.equal(find(root.el, (e) => e.tagName === 'text' && e.textContent === '+' && e.classList.contains('lm')),
    undefined, 'the focus left edge also found nothing above');
  assert.equal(find(top2.el, (e) => e.tagName === 'text' && e.textContent === '−' && e.classList.contains('lm')),
    undefined, 'no chain box has a parent to fold above');

  const fold = find(root.el, (e) => e.tagName === 'text' && e.textContent === '−' && e.classList.contains('lm'));
  assert.ok(fold, 'each box folds its own parent: the focus wears a - while its parent is shown');
  fire(fold!, 'click');
  assert.equal(p.posted.find((m) => m.type === 'ancestors')?.shown, 0);
});

test('each box folds its own parent and the + reveals the next level', () => {
  // chip > top > u_mid: with one ancestor shown, the focus folds its shown
  // parent with a - while the parent ancestor still wears a + of its own; that
  // + reveals one more level (chip), not the whole chain above in one go.
  const p = startPanel(deepAncestorGraph(1), { ancestorsShown: 1, ancestorsLeft: 1 });

  const mid = p.group('chip.u_top.u_mid');
  const fold = find(mid.el, (e) => e.tagName === 'text' && e.textContent === '−' && e.classList.contains('lm'));
  assert.ok(fold, 'the focus folds its shown parent with a left -');
  assert.equal(find(mid.el, (e) => e.tagName === 'text' && e.textContent === '+' && e.classList.contains('lm')),
    undefined, 'the focus left edge has nothing of its own to reveal above');

  const top = p.group('chip.u_top');
  const reveal = find(top.el, (e) => e.tagName === 'text' && e.textContent === '+' && e.classList.contains('lm'));
  assert.ok(reveal, 'the ancestor whose parent is still hidden wears its own left +');
  fire(reveal!, 'click');
  assert.equal(p.posted.find((m) => m.type === 'ancestors')?.shown, 2, 'the next level is revealed');
});

test('each + reveals exactly one more containing module', () => {
  // Two levels above the root, both hidden: the first + asks for the nearest
  // parent only; the next + then asks for the one above it.
  const p = startPanel(deepAncestorGraph(0), { ancestorsShown: 0, ancestorsLeft: 2 });

  assert.ok(!p.api._els!.groups.some((gd) => gd.g.key === 'chip.u_top'), 'no ancestor is drawn yet');
  const mid = p.group('chip.u_top.u_mid');
  const plus = find(mid.el, (e) => e.tagName === 'text' && e.textContent === '+' && e.classList.contains('lm'));
  assert.ok(plus, 'the focus wears a left + while containing modules are hidden');
  fire(plus!, 'click');
  assert.equal(p.posted.filter((m) => m.type === 'ancestors')[0]?.shown, 1, 'only the nearest parent is asked for');

  // The extension rebuilds with one more ancestor drawn; its + asks for the next.
  p.message({ type: 'graph', graph: deepAncestorGraph(1), collapsed: [], ancestorsShown: 1, ancestorsLeft: 1, expanded: [] });
  const top = p.group('chip.u_top');
  const next = find(top.el, (e) => e.tagName === 'text' && e.textContent === '+' && e.classList.contains('lm'));
  assert.ok(next, 'the newly drawn ancestor wears the next +');
  fire(next!, 'click');
  assert.equal(p.posted.filter((m) => m.type === 'ancestors')[1]?.shown, 2, 'the level above it is asked for next');
});

test('the edge +/- marks are enlarged and carry a bigger click target', () => {
  const p = startPanel(ancestorGraph(0), { ancestorsShown: 0, ancestorsLeft: 1 });

  const lm = find(p.group('top.u_mid').el,
    (e) => e.tagName === 'text' && e.textContent === '+' && e.classList.contains('lm'));
  assert.ok(lm, 'the left-edge + is drawn');
  assert.ok(lm!.classList.contains('sm'), 'the edge mark carries the enlarged-sm class');

  const hit = find(p.group('top.u_mid').el,
    (e) => e.tagName === 'rect' && e.classList.contains('smhit') && e.classList.contains('lm'));
  assert.ok(hit, 'a transparent hit rect backs the glyph');
  assert.ok(Number(hit!.attrs.width) >= 20 && Number(hit!.attrs.height) >= 20,
    'the hit target is at least 20x20 graph units');

  // The hit rect is wired to the same action as the glyph.
  fire(hit!, 'click');
  assert.equal(p.posted.find((m) => m.type === 'ancestors')?.shown, 1, 'clicking the target reveals a level');
});

test('children start hidden and the + on the right edge reveals them one level per click', () => {
  // The extension builds a root with nothing expanded; the right-edge + then
  // reveals only that module's own direct children.
  const p = startPanel(rootGraph([]), { expanded: [] });

  const keys = p.api._els!.groups.map((gd) => gd.g.key);
  assert.deepEqual(keys, ['top'], 'only the root box is drawn, no children');
  const root = p.group('top');
  assert.equal(root.g.nets.length, 4, 'the root box shows its own ports, not its childrens wires');
  const plus = find(root.el, (e) => e.tagName === 'text' && e.textContent === '+' && e.classList.contains('rm'));
  assert.ok(plus, 'the root wears a + on its right edge when children are hidden');

  fire(plus!, 'click');
  const msg = p.posted.find((m) => m.type === 'descendants');
  assert.equal(msg?.path, 'top');
  assert.equal(msg?.expanded, true, 'the + asks for this module children');
});

test('each module reveals only its own next level of children', () => {
  // The root is expanded, so it wears a - and its direct children are drawn;
  // each child that still hides a level wears its own + to reveal it.
  const p = startPanel(rootGraph(['top']), { expanded: ['top'] });

  const keys = p.api._els!.groups.map((gd) => gd.g.key).sort();
  assert.deepEqual(keys, ['top', 'top.u_dangling', 'top.u_leaf', 'top.u_mid', 'top.u_missing']);
  assert.equal(p.group('top.u_mid').g.nets.length, 3, 'the child at the revealed level shows its own ports only');

  const root = p.group('top');
  assert.ok(find(root.el, (e) => e.tagName === 'text' && e.textContent === '−' && e.classList.contains('rm')),
    'the expanded root wears a - on its right edge');
  assert.equal(find(root.el, (e) => e.tagName === 'text' && e.textContent === '+' && e.classList.contains('rm')),
    undefined, 'the expanded root has nothing left to reveal');

  const mid = p.group('top.u_mid');
  const plus = find(mid.el, (e) => e.tagName === 'text' && e.textContent === '+' && e.classList.contains('rm'));
  assert.ok(plus, 'the child with a hidden level wears its own +');
  fire(plus!, 'click');
  const msg = p.posted.find((m) => m.type === 'descendants' && m.path === 'top.u_mid');
  assert.ok(msg, 'the click asks for the child module specifically');
  assert.equal(msg?.expanded, true);
});

test('the - on the right edge tucks one level back', () => {
  // Full subtree drawn (two levels): the - turns u_inner back off, leaving the
  // root's direct children showing.
  const p = startPanel(rootGraph(['top', 'top.u_mid']), { expanded: ['top', 'top.u_mid'] });

  const root = p.group('top');
  const minus = find(root.el, (e) => e.tagName === 'text' && e.textContent === '−' && e.classList.contains('rm'));
  assert.ok(minus, 'the root wears a - on its right edge while children are shown');

  fire(minus!, 'click');
  assert.equal(p.posted.find((m) => m.type === 'descendants')?.shown, undefined);
  const msg = p.posted.find((m) => m.type === 'descendants');
  assert.equal(msg?.path, 'top');
  assert.equal(msg?.expanded, false);
});

test('a leaf box probes + on its right edge and hides it once nothing is below', () => {
  const index = new HdlIndex();
  index.addFile('/w/top.v', SRC);
  const h = buildHierarchy(index, 'top', { maxDepth: 8 })!;
  const leaf = findByPath(h.root, 'top.u_leaf')!;
  const g = buildGraph(index, leaf, {
    maxDepth: 8, maxNodes: 500, showContainment: true, expanded: [],
  });
  const p = startPanel(g);

  const root = p.group('top.u_leaf');
  assert.equal(root.g.head!.childCount, 0, 'the leaf instantiates nothing');
  const probe = find(root.el, (e) => e.tagName === 'text' && e.textContent === '+' && e.classList.contains('rm'));
  assert.ok(probe, 'every box wears a + on its right edge by default');
  assert.equal(find(root.el, (e) => e.tagName === 'text' && e.textContent === '−' && e.classList.contains('rm')),
    undefined, 'a leaf never wears a -: nothing was ever revealed');

  fire(probe!, 'click');
  p.api.redraw();
  const after = p.group('top.u_leaf');
  assert.equal(find(after.el, (e) => e.tagName === 'text' && e.classList.contains('rm')),
    undefined, 'the + hid once it found no child modules');
  assert.equal(p.posted.find((m) => m.type === 'descendants'), undefined, 'nothing was asked of the extension');
});

test('searching a signal brings its whole module group along', () => {
  const p = startPanel(fixtureGraph());
  p.search().value = 'mid_out';
  fire(p.search(), 'input');

  const keys = p.api._els!.groups.map((gd) => gd.g.key).sort();
  assert.deepEqual(keys, ['top', 'top.u_leaf', 'top.u_mid'], 'the modules the signal touches are drawn');
  assert.equal(p.group('top').g.nets.length, 6, 'the module keeps every one of its signals');
  assert.equal(p.group('top.u_leaf').g.nets.length, 4);
});

test('wires between two modules do not cross', () => {
  const p = startPanel(fixtureGraph());
  const groups = p.api._els!.groups;
  // Every drawn wire end, resolved to the box and row it touches.
  const wires = p.api._els!.edgeEls
    .filter((x) => x.e.kind === 'port')
    .map((x) => {
      const fromBox = groups.find((gd) => gd.g.nets.some((n) => n.id === x.e.from));
      const toBox = groups.find((gd) => gd.g.head?.id === x.e.to);
      const fromRow = fromBox?.g.nets.find((n) => n.id === x.e.from);
      const toRow = toBox?.g.nets.find((n) => n.label === x.e.port);
      if (!fromBox || !toBox || !fromRow || !toRow) return null;
      return {
        key: fromBox.g.key + ':' + toBox.g.key,
        a: fromBox.g.nets.indexOf(fromRow),
        b: toBox.g.nets.indexOf(toRow),
      };
    })
    .filter((w): w is { key: string; a: number; b: number } => w !== null);
  // Two wires that share a pair of boxes must keep their rows in the same
  // order on both sides, or the wires would cross.
  const byPair = new Map<string, { a: number; b: number }[]>();
  for (const w of wires) {
    const list = byPair.get(w.key) ?? [];
    list.push(w);
    byPair.set(w.key, list);
  }
  for (const pair of byPair.values()) {
    for (let i = 0; i < pair.length; i++) {
      for (let j = i + 1; j < pair.length; j++) {
        const u = pair[i], v = pair[j];
        // A crossing is a strict order flip on the two sides; sharing a row
        // (a fan-out, or two wires meeting mid-bundle) is not a crossing.
        assert.ok(
          !((u.a - v.a < 0 && u.b - v.b > 0) || (u.a - v.a > 0 && u.b - v.b < 0)),
          `rows ${u.a}/${u.b} and ${v.a}/${v.b} cross`,
        );
      }
    }
  }
});

test('a box dragged onto a sibling shoves it aside instead of overlapping', () => {
  const p = startPanel(rootGraph(['top']));
  const target = p.group('top.u_leaf');
  const hit = find(target.el, (e) => e.classList.contains('hit'));
  assert.ok(hit, 'the box has a header to grab');
  // Drop u_leaf down onto u_mid's row, then expand the subtree so the column is
  // laid out again with the held box in the middle.
  fire(hit!, 'mousedown', { clientX: 0, clientY: 0 });
  p.winFire('mousemove', { clientX: 0, clientY: 80 });
  p.winFire('mouseup', {});
  p.api.redraw();
  const heldY = p.group('top.u_leaf').g.y;
  p.message({
    type: 'graph',
    graph: rootGraph(['top', 'top.u_mid', 'top.u_leaf']),
    collapsed: [],
    expanded: ['top', 'top.u_mid', 'top.u_leaf'],
  });

  const rects = p.api._els!.groups.map((d) => d.g);
  const overlaps = (a: Geom, b: Geom): boolean =>
    Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      assert.ok(!overlaps(rects[i], rects[j]), `${rects[i].key} overlaps ${rects[j].key}`);
    }
  }
  assert.equal(p.group('top.u_leaf').g.y, heldY, 'the dragged box keeps the row it was dropped on');
});
