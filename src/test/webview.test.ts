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
 * A graph rooted at `top` with `descendants` levels of its subtree shown (0 for
 * just the root box), matching the shape GraphPanel.refresh() builds around a
 * root whose children are walked one level per click.
 */
function rootGraph(descendants: number): Graph {
  const index = new HdlIndex();
  index.addFile('/w/top.v', SRC);
  const h = buildHierarchy(index, 'top', { maxDepth: 8 })!;
  return buildGraph(index, h.root, {
    maxDepth: 8,
    maxNodes: 500,
    showContainment: true,
    descendants,
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
    descendantsShown?: number;
    descendantsLeft?: number;
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
  message({
    type: 'graph',
    graph,
    focus: opts.focus,
    collapsed: opts.collapsed ?? [],
    ancestorsShown: opts.ancestorsShown ?? 0,
    ancestorsLeft: opts.ancestorsLeft ?? 0,
    descendantsShown: opts.descendantsShown ?? 0,
    descendantsLeft: opts.descendantsLeft ?? 0,
  });
  const api = (svg as unknown as { __api: PanelApi }).__api;
  return {
    svg,
    api,
    posted,
    elements,
    message,
    draw: () => api.redraw(),
    search: () => elements.search,
    group: (key: string): Drawn => {
      const gd = (svg as unknown as { __api: PanelApi }).__api._els!.groups.find((x) => x.g.key === key);
      assert.ok(gd, 'group ' + key + ' is drawn');
      return gd;
    },
    edge: (to: string, port: string) => {
      const ed = (svg as unknown as { __api: PanelApi }).__api._els!.edgeEls.find(
        (x) => x.e.to === to && x.e.port === port,
      );
      assert.ok(ed, 'edge .' + port + ' -> ' + to + ' is drawn');
      return ed;
    },
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

test('containing modules are hidden and revealed by + / -', () => {
  // One ancestor above the root is available but not drawn yet.
  const p = startPanel(ancestorGraph(0), { ancestorsShown: 0, ancestorsLeft: 1 });

  assert.ok(!p.api._els!.groups.some((gd) => gd.g.key === 'top'), 'the parent module is not drawn yet');
  const root = p.group('top.u_mid');
  const plus = find(root.el, (e) => e.tagName === 'text' && e.textContent === '+' && e.classList.contains('chev'));
  assert.ok(plus, 'the chain-top module wears a + to reveal its parent');

  fire(plus!, 'click');
  const msg = p.posted.find((m) => m.type === 'ancestors');
  assert.ok(msg, 'a ancestors message was posted');
  assert.equal(msg!.shown, 1);
});

test('+ brings the parent module in and - tucks it back', () => {
  // The parent is now drawn; clicking the + again must have asked for one more
  // level beyond it, i.e. a chain that has something still above.
  const g = ancestorGraph(1);
  const p = startPanel(g, { ancestorsShown: 1, ancestorsLeft: 1 });

  assert.ok(p.group('top'), 'the nearest containing module is drawn');
  const top = p.group('top');
  const up = find(top.el, (e) => e.tagName === 'text' && e.textContent === '+' && e.classList.contains('chev'));
  assert.ok(up, 'top has another + because one more level is hidden above it');
  fire(up!, 'click');
  assert.equal(p.posted.find((m) => m.type === 'ancestors')?.shown, 2);
});

test('a fully-revealed chain has no + but a - to fold the parent', () => {
  const p = startPanel(ancestorGraph(1), { ancestorsShown: 1, ancestorsLeft: 0 });

  const top = p.group('top');
  const plus = find(top.el, (e) => e.tagName === 'text' && e.textContent === '+' && e.classList.contains('chev'));
  assert.equal(plus, undefined, 'nothing is left above the chain top, so no +');
  const minus = find(top.el, (e) => e.tagName === 'text' && e.textContent === '−' && e.classList.contains('chev'));
  assert.ok(minus, 'the chain top wears a - to hide the containing module');

  fire(minus!, 'click');
  assert.equal(p.posted.find((m) => m.type === 'ancestors')?.shown, 0);
});

test('children start hidden and the + on the right edge reveals them one level per click', () => {
  // A root whose descendants are not built, exactly what the extension builds
  // the first time a module is focused. The fixture is two levels below `top`
  // (u_mid has u_inner), so the extension reports two levels still available.
  const p = startPanel(rootGraph(0), { descendantsLeft: 2 });

  const keys = p.api._els!.groups.map((gd) => gd.g.key);
  assert.deepEqual(keys, ['top'], 'only the root box is drawn, no children');
  const root = p.group('top');
  assert.equal(root.g.nets.length, 4, 'the root box shows its own ports, not its childrens wires');
  const plus = find(root.el, (e) => e.tagName === 'text' && e.textContent === '+' && e.classList.contains('rm'));
  assert.ok(plus, 'the root wears a + on its right edge when children are hidden');

  fire(plus!, 'click');
  assert.equal(p.posted.find((m) => m.type === 'descendants')?.shown, 1);
});

test('each click reveals exactly one more level of children', () => {
  // One level shown: the root and its direct children are there, but u_mid's
  // own child u_inner is still out - and the root still wears a + because one
  // more level remains below it.
  const p = startPanel(rootGraph(1), { descendantsShown: 1, descendantsLeft: 1 });

  const keys = p.api._els!.groups.map((gd) => gd.g.key).sort();
  assert.deepEqual(keys, ['top', 'top.u_dangling', 'top.u_leaf', 'top.u_mid', 'top.u_missing']);
  assert.equal(p.group('top.u_mid').g.nets.length, 4, 'the leaf at the revealed level shows its own ports only');
  const root = p.group('top');
  const plus = find(root.el, (e) => e.tagName === 'text' && e.textContent === '+' && e.classList.contains('rm'));
  assert.ok(plus, 'a deeper level remains, so the + is still on the right edge');
  const minus = find(root.el, (e) => e.tagName === 'text' && e.textContent === '−' && e.classList.contains('rm'));
  assert.ok(minus, 'the - sits beside the + once any level is shown');

  fire(plus!, 'click');
  assert.equal(p.posted.find((m) => m.type === 'descendants')?.shown, 2);
});

test('the - on the right edge tucks one level back', () => {
  // Full subtree drawn (two levels): the - turns u_inner back off, leaving the
  // root's direct children showing.
  const p = startPanel(rootGraph(2), { descendantsShown: 2, descendantsLeft: 0 });

  const root = p.group('top');
  const minus = find(root.el, (e) => e.tagName === 'text' && e.textContent === '−' && e.classList.contains('rm'));
  assert.ok(minus, 'the root wears a - on its right edge while children are shown');

  fire(minus!, 'click');
  assert.equal(p.posted.find((m) => m.type === 'descendants')?.shown, 1);
});

test('a leaf root has no mark on its right edge', () => {
  const index = new HdlIndex();
  index.addFile('/w/top.v', SRC);
  const h = buildHierarchy(index, 'top', { maxDepth: 8 })!;
  const leaf = findByPath(h.root, 'top.u_leaf')!;
  const g = buildGraph(index, leaf, {
    maxDepth: 8, maxNodes: 500, showContainment: true, descendants: 0,
  });
  const p = startPanel(g);

  const root = p.group('top.u_leaf');
  assert.equal(root.g.head!.childCount, 0, 'the leaf instantiates nothing');
  const mark = find(root.el, (e) => e.tagName === 'text' && e.classList.contains('rm'));
  assert.equal(mark, undefined, 'nothing to reveal, so no right-edge mark');
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
