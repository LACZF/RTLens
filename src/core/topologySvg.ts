/**
 * Pure SVG-string renderer for the port-level topology model.
 *
 * The picture is a three-column schematic: the module's input ports on the
 * left, the instances it holds in the middle, its output ports on the right.
 * Everything is emitted as one self-contained SVG string - no DOM, no
 * `vscode`, no assets - so the host can write it to disk, inline it into a
 * webview or diff it in a test.
 *
 * Deterministic by construction: no clock, no random, no map iteration order
 * that depends on insertion luck.
 */

import type {
  ModuleTopology,
  TopoChild,
  TopoChildPort,
  TopoEdge,
  TopoEndpoint,
  TopoSignal,
} from './topology';

export type SignalDisplay = 'all' | 'hidden' | 'bundled';

export interface NavRef {
  key?: string;
  href?: string;
  src?: { file: string; line: number; character: number };
}

export interface Crumb {
  label: string;
  ref: NavRef;
}

export interface FrameInput {
  key: string;
  model: ModuleTopology;
  self: NavRef;
  parent?: NavRef;
  top?: NavRef;
  crumbs: Crumb[];
  children: Record<string, NavRef>;
}

export interface RenderOptions {
  signalMode?: SignalDisplay;
  dark?: boolean;
  padding?: number;
}

export interface FrameSvg {
  key: string;
  fileName: string;
  svg: string;
}

/* ------------------------------------------------------------------ */
/* text helpers                                                        */
/* ------------------------------------------------------------------ */

function esc(v: unknown): string {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Every char outside `[A-Za-z0-9_.-]` becomes `_`. */
export function sanitizeName(raw: string): string {
  return String(raw === undefined || raw === null ? '' : raw).replace(/[^A-Za-z0-9_.-]/g, '_');
}

/** `chip_top` -> `chip_top-1.svg`, a second `chip_top` -> `chip_top-2.svg`. */
export function topologyFileNames(frames: { key: string; moduleName: string }[]): string[] {
  const used = new Map<string, number>();
  const out: string[] = [];
  for (const f of frames || []) {
    const base = sanitizeName(f && f.moduleName ? f.moduleName : '');
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    out.push(`${base}-${n}.svg`);
  }
  return out;
}

function num(v: number): string {
  if (typeof v !== 'number' || !isFinite(v)) {
    return '0';
  }
  const r = Math.round(v * 100) / 100;
  return String(r);
}

function baseName(file: string): string {
  const s = String(file ?? '');
  if (!s) {
    return '';
  }
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || s;
}

function trunc(s: string, n: number): string {
  const str = String(s ?? '');
  if (str.length <= n) {
    return str;
  }
  return `${str.slice(0, n)}…`;
}

/* ------------------------------------------------------------------ */
/* theme                                                               */
/* ------------------------------------------------------------------ */

interface Theme {
  bg: string;
  panel: string;
  stroke: string;
  text: string;
  muted: string;
  input: string;
  output: string;
  neutral: string;
  palette: string[];
}

const LIGHT_PALETTE = [
  '#7c3aed',
  '#db2777',
  '#0891b2',
  '#65a30d',
  '#d97706',
  '#4f46e5',
  '#0d9488',
  '#be123c',
];
const DARK_PALETTE = [
  '#a78bfa',
  '#f472b6',
  '#22d3ee',
  '#a3e635',
  '#fbbf24',
  '#818cf8',
  '#2dd4bf',
  '#fb7185',
];

function theme(dark: boolean): Theme {
  return dark
    ? {
        bg: '#0f172a',
        panel: '#1e293b',
        stroke: '#334155',
        text: '#e2e8f0',
        muted: '#94a3b8',
        input: '#60a5fa',
        output: '#34d399',
        neutral: '#64748b',
        palette: DARK_PALETTE,
      }
    : {
        bg: '#ffffff',
        panel: '#f8fafc',
        stroke: '#cbd5e1',
        text: '#0f172a',
        muted: '#64748b',
        input: '#2563eb',
        output: '#059669',
        neutral: '#94a3b8',
        palette: LIGHT_PALETTE,
      };
}

/* ------------------------------------------------------------------ */
/* geometry                                                            */
/* ------------------------------------------------------------------ */

const FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const COL_W = 200;
const GUTTER = 60;
const MIN_MID = 280;
const MID_PER_MODULE = 190;
const MAX_MODULES = 6;
const ROW_H = 26;
const ROW_GAP = 8;
const HEADER_H = 64;
const FOOTER_H = 28;
const CHILD_GAP = 24;
const CHILD_HEAD = 34;
const CHILD_ROW = 18;
const CHILD_PAD = 10;
const GROUP_PAD = 22;
const PORT_CAP = 8;
const TICK = 10;
const BAR_W = 46;
const BAR_GAP = 8;
const RAIL_W = 4;
const HIDDEN_MARGIN = 110;
const LEGEND_CAP = 6;
const CHAR_W = 6;

/* ------------------------------------------------------------------ */
/* ports                                                               */
/* ------------------------------------------------------------------ */

function portSide(p: TopoChildPort): 'left' | 'right' {
  if (p.side === 'input') {
    return 'left';
  }
  if (p.side === 'output') {
    return 'right';
  }
  if (p.direction === 'output' || p.direction === 'inout') {
    return 'right';
  }
  return 'left';
}

function splitPorts(ports: TopoChildPort[]): { left: TopoChildPort[]; right: TopoChildPort[] } {
  const left: TopoChildPort[] = [];
  const right: TopoChildPort[] = [];
  for (const p of ports || []) {
    if (portSide(p) === 'left') {
      left.push(p);
    } else {
      right.push(p);
    }
  }
  return { left, right };
}

function childPorts(child: TopoChild): { left: TopoChildPort[]; right: TopoChildPort[] } {
  return splitPorts(child.ports || []);
}

/* ------------------------------------------------------------------ */
/* port groups                                                         */
/* ------------------------------------------------------------------ */

type PortCat = 'in' | 'out' | 'inout';

function portCat(p: TopoChildPort): PortCat {
  if (p.direction === 'output') {
    return 'out';
  }
  if (p.direction === 'inout') {
    return 'inout';
  }
  return 'in';
}

interface PortGroup {
  cat: PortCat;
  ports: TopoChildPort[];
}

/** The port groups one side of a child box draws: `in`/`inout` on the left, `out` on the right. */
function childGroups(child: TopoChild): { left: PortGroup[]; right: PortGroup[] } {
  const buckets: Record<'left' | 'right', Map<PortCat, TopoChildPort[]>> = {
    left: new Map(),
    right: new Map(),
  };
  for (const p of child.ports || []) {
    const map = buckets[portSide(p)];
    const list = map.get(portCat(p)) ?? [];
    list.push(p);
    map.set(portCat(p), list);
  }
  const order = (map: Map<PortCat, TopoChildPort[]>, cats: PortCat[]): PortGroup[] => {
    const out: PortGroup[] = [];
    for (const c of cats) {
      const list = map.get(c);
      if (list && list.length > 0) {
        out.push({ cat: c, ports: list });
      }
    }
    return out;
  };
  return {
    left: order(buckets.left, ['in', 'inout', 'out']),
    right: order(buckets.right, ['out', 'inout', 'in']),
  };
}

/** How many rows one side of a child box draws: the capped ports plus the `+N more` line. */
function portRows(ports: TopoChildPort[]): number {
  const drawn = Math.min(ports.length, PORT_CAP);
  return ports.length > drawn ? drawn + 1 : drawn;
}

function childRows(child: TopoChild, mode: SignalDisplay): number {
  if (mode === 'bundled') {
    const { left, right } = childGroups(child);
    return Math.max(1, left.length, right.length);
  }
  const { left, right } = childPorts(child);
  return Math.max(1, portRows(left), portRows(right));
}

function childBoxHeight(child: TopoChild, mode: SignalDisplay): number {
  return CHILD_HEAD + CHILD_ROW * childRows(child, mode) + CHILD_PAD;
}

/* ------------------------------------------------------------------ */
/* palette                                                             */
/* ------------------------------------------------------------------ */

/** One key per distinct `(moduleName, defFile)` so twins share a colour. */
function moduleKeys(children: TopoChild[]): string[] {
  const set = new Set<string>();
  for (const c of children || []) {
    set.add(`${c.moduleName} ${c.defFile ?? ''}`);
  }
  return Array.from(set).sort();
}

function moduleNameOfKey(key: string): string {
  const i = key.indexOf(' ');
  return i < 0 ? key : key.slice(0, i);
}

function colorForChild(child: TopoChild, children: TopoChild[], th: Theme): string {
  const keys = moduleKeys(children);
  const idx = keys.indexOf(`${child.moduleName} ${child.defFile ?? ''}`);
  if (idx < 0 || th.palette.length === 0) {
    return th.neutral;
  }
  return th.palette[idx % th.palette.length];
}

/* ------------------------------------------------------------------ */
/* edges                                                               */
/* ------------------------------------------------------------------ */

interface EdgeEnd {
  x: number;
  y: number;
  role: 'input' | 'output' | 'neutral';
}

function findSignalIndex(signals: TopoSignal[], name: string): number {
  for (let i = 0; i < signals.length; i++) {
    if (signals[i].name === name || signals[i].declName === name) {
      return i;
    }
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/* main render                                                         */
/* ------------------------------------------------------------------ */

export function renderFrameSvg(
  input: FrameInput,
  opts?: RenderOptions & { fileName?: string },
): FrameSvg {
  const o = opts ?? {};
  const mode: SignalDisplay = o.signalMode ?? 'all';
  const dark = o.dark === true;
  const th = theme(dark);
  const pad =
    typeof o.padding === 'number' && isFinite(o.padding) && o.padding >= 0 ? o.padding : 24;

  const model = input.model;
  const children = model.children ?? [];
  const inputs = model.inputs ?? [];
  const outputs = model.outputs ?? [];
  const edges = model.edges ?? [];
  const warnings = model.warnings ?? [];
  const crumbs = input.crumbs ?? [];
  const navChildren = input.children ?? {};

  const markerBase = `topo-${sanitizeName(input.key || model.moduleName || 'frame')}`;

  /* ---------------- columns ---------------- */

  const distinctModules = moduleKeys(children).length;
  const midW = Math.max(MIN_MID, MID_PER_MODULE * Math.min(distinctModules, MAX_MODULES));

  const useBars = mode === 'bundled';
  const hidden = mode === 'hidden';

  const bundledIn = inputs.filter((s) => s.direction !== 'inout');
  const bundledIo = inputs.filter((s) => s.direction === 'inout');

  let leftW: number;
  let rightW: number;
  let gutterL: number;
  let gutterR: number;
  if (hidden) {
    leftW = HIDDEN_MARGIN;
    rightW = HIDDEN_MARGIN;
    gutterL = 0;
    gutterR = 0;
  } else if (useBars) {
    const ioBars = bundledIo.length > 0 ? 1 : 0;
    leftW = BAR_W * (1 + ioBars) + BAR_GAP * ioBars;
    rightW = BAR_W;
    gutterL = GUTTER;
    gutterR = GUTTER;
  } else {
    leftW = COL_W;
    rightW = COL_W;
    gutterL = GUTTER;
    gutterR = GUTTER;
  }

  const groupPad = children.length > 0 ? GROUP_PAD : 0;
  if (groupPad > 0) {
    gutterL = Math.max(gutterL, groupPad);
    gutterR = Math.max(gutterR, groupPad);
  }

  const canvasW = leftW + gutterL + midW + gutterR + rightW + pad * 2;

  const leftColX = pad;
  const midColX = pad + leftW + gutterL;
  const rightColX = midColX + midW + gutterR;

  /* ---------------- bands ---------------- */

  const inputColH = inputs.length > 0 ? inputs.length * ROW_H + (inputs.length - 1) * ROW_GAP : 0;
  const outputColH = outputs.length > 0 ? outputs.length * ROW_H + (outputs.length - 1) * ROW_GAP : 0;
  const signalRowsH = Math.max(inputColH, outputColH);

  let childrenH = 0;
  if (children.length > 0) {
    let total = 0;
    for (const c of children) {
      total += childBoxHeight(c, mode);
    }
    childrenH = total + (children.length - 1) * CHILD_GAP;
  }

  const maxCount = Math.max(inputs.length, outputs.length);
  const contentH = Math.max(
    1,
    hidden
      ? Math.max(childrenH + groupPad * 2, maxCount * 18)
      : Math.max(signalRowsH, childrenH + groupPad * 2),
  );

  const canvasH = Math.max(240, pad + HEADER_H + contentH + FOOTER_H + pad);
  const contentTop = pad + HEADER_H;
  const contentBottom = contentTop + contentH;

  /* ---------------- signal rows (mode `all`) ---------------- */

  interface SignalRowGeom {
    signal: TopoSignal;
    x: number;
    y: number;
    w: number;
    h: number;
  }
  const inputRows: SignalRowGeom[] = [];
  const outputRows: SignalRowGeom[] = [];
  if (mode === 'all') {
    let y = contentTop;
    for (const s of inputs) {
      inputRows.push({ signal: s, x: leftColX, y, w: COL_W, h: ROW_H });
      y += ROW_H + ROW_GAP;
    }
    let oy = contentTop;
    for (const s of outputs) {
      outputRows.push({ signal: s, x: rightColX, y: oy, w: COL_W, h: ROW_H });
      oy += ROW_H + ROW_GAP;
    }
  }

  /* ---------------- child boxes ---------------- */

  interface ChildGeom {
    child: TopoChild;
    x: number;
    y: number;
    w: number;
    h: number;
    color: string;
  }
  const childGeoms: ChildGeom[] = [];
  if (children.length > 0) {
    const boxW = Math.max(160, Math.min(200, midW - 40));
    let y = contentTop + Math.max(0, (contentH - childrenH) / 2);
    for (const c of children) {
      const h = childBoxHeight(c, mode);
      childGeoms.push({
        child: c,
        x: midColX + (midW - boxW) / 2,
        y,
        w: boxW,
        h,
        color: colorForChild(c, children, th),
      });
      y += h + CHILD_GAP;
    }
  }

  /* ---------------- boundary rails (mode `hidden`) ---------------- */

  const railInnerLeft = pad + HIDDEN_MARGIN - 26;
  const railInnerRight = canvasW - pad - HIDDEN_MARGIN + 26;

  interface TickGeom {
    x: number;
    y: number;
    name: string;
    side: 'input' | 'output';
  }
  const ticks: TickGeom[] = [];
  if (hidden) {
    const spread = (arr: TopoSignal[], side: 'input' | 'output'): void => {
      if (arr.length === 0) {
        return;
      }
      const step = contentH / arr.length;
      const seen = new Set<string>();
      for (let i = 0; i < arr.length; i++) {
        const name = arr[i].name;
        if (seen.has(name)) {
          continue;
        }
        seen.add(name);
        ticks.push({
          x: side === 'input' ? railInnerLeft : railInnerRight,
          y: contentTop + step * (i + 0.5),
          name,
          side,
        });
      }
    };
    spread(inputs, 'input');
    spread(outputs, 'output');
  }

  /* ---------------- bundles (mode `bundled`) ---------------- */

  interface BarGeom {
    cat: PortCat;
    x: number;
    y: number;
    w: number;
    h: number;
    trunkX: number;
    count: number;
    names: string[];
  }
  const bars: BarGeom[] = [];
  if (useBars) {
    if (bundledIn.length > 0) {
      bars.push({
        cat: 'in',
        x: pad,
        y: contentTop,
        w: BAR_W,
        h: contentH,
        trunkX: pad + BAR_W - 2,
        count: bundledIn.length,
        names: bundledIn.map((s) => s.name),
      });
    }
    if (bundledIo.length > 0) {
      const x = pad + BAR_W + BAR_GAP;
      bars.push({
        cat: 'inout',
        x,
        y: contentTop,
        w: BAR_W,
        h: contentH,
        trunkX: x + BAR_W - 2,
        count: bundledIo.length,
        names: bundledIo.map((s) => s.name),
      });
    }
    if (outputs.length > 0) {
      bars.push({
        cat: 'out',
        x: canvasW - pad - BAR_W,
        y: contentTop,
        w: BAR_W,
        h: contentH,
        trunkX: canvasW - pad - BAR_W + 2,
        count: outputs.length,
        names: outputs.map((s) => s.name),
      });
    }
  }

  /* ---------------- the current module's frame ---------------- */

  // The frame is the module's own boundary, so it is drawn for a module
  // without instances as well.
  let frameLeft: number;
  let frameRight: number;
  if (hidden) {
    // No input or output boxes in this mode; the rails are the boundary.
    frameLeft = railInnerLeft - 6;
    frameRight = railInnerRight + 6;
  } else if (useBars) {
    const inBar = bars.find((b) => b.cat === 'in') ?? bars.find((b) => b.cat === 'inout');
    const outBar = bars.find((b) => b.cat === 'out');
    frameLeft = inBar ? inBar.x + inBar.w / 2 : midColX;
    frameRight = outBar ? outBar.x + outBar.w / 2 : midColX + midW;
  } else {
    frameLeft = inputRows.length > 0 ? inputRows[0].x + inputRows[0].w / 2 : midColX;
    frameRight = outputRows.length > 0 ? outputRows[0].x + outputRows[0].w / 2 : midColX + midW;
  }
  const moduleFrame = {
    x: frameLeft,
    y: contentTop,
    w: Math.max(1, frameRight - frameLeft),
    h: contentH,
  };

  /* ---------------- edge endpoints ---------------- */
  const childById = new Map<string, ChildGeom>();
  for (const g of childGeoms) {
    childById.set(g.child.id, g);
  }

  function endpointFor(ep: TopoEndpoint, side: 'left' | 'right'): EdgeEnd | null {
    if (ep.kind === 'signal') {
      const name = ep.name;
      if (side === 'left') {
        const idx = findSignalIndex(inputs, name);
        if (idx < 0) {
          return null;
        }
        if (mode === 'all') {
          const row = inputRows[idx];
          if (!row) {
            return null;
          }
          return { x: row.x + row.w, y: row.y + row.h / 2, role: 'input' };
        }
        if (mode === 'bundled') {
          const sig = inputs.find((s) => s.name === name || s.declName === name);
          if (!sig) {
            return null;
          }
          const cat: PortCat = sig.direction === 'inout' ? 'inout' : 'in';
          const bar = bars.find((b) => b.cat === cat);
          if (!bar || bar.count <= 0) {
            return null;
          }
          const list = cat === 'inout' ? bundledIo : bundledIn;
          const i = Math.max(
            0,
            Math.min(bar.count - 1, list.findIndex((s) => s.name === name || s.declName === name)),
          );
          return {
            x: bar.trunkX,
            y: bar.y + ((i + 0.5) * bar.h) / bar.count,
            role: cat === 'inout' ? 'neutral' : 'input',
          };
        }
        const tick = ticks.find((t) => t.side === 'input' && t.name === name);
        if (!tick) {
          return null;
        }
        return { x: tick.x, y: tick.y, role: 'input' };
      }
      const idx = findSignalIndex(outputs, name);
      if (idx < 0) {
        return null;
      }
      if (mode === 'all') {
        const row = outputRows[idx];
        if (!row) {
          return null;
        }
        return { x: row.x, y: row.y + row.h / 2, role: 'output' };
      }
      if (mode === 'bundled') {
        const bar = bars.find((b) => b.cat === 'out');
        if (!bar || bar.count <= 0) {
          return null;
        }
        const i = Math.max(0, Math.min(bar.count - 1, idx));
        return {
          x: bar.trunkX - RAIL_W / 2,
          y: bar.y + ((i + 0.5) * bar.h) / bar.count,
          role: 'output',
        };
      }
      const tick = ticks.find((t) => t.side === 'output' && t.name === name);
      if (!tick) {
        return null;
      }
      return { x: tick.x, y: tick.y, role: 'output' };
    }

    const g = childById.get(ep.child);
    if (!g) {
      return null;
    }
    if (mode === 'bundled') {
      const groups = childGroups(g.child);
      const list = ep.side === 'input' ? groups.left : groups.right;
      let row = list.findIndex((grp) => grp.ports.some((p) => p.name === ep.port));
      if (row < 0) {
        row = 0;
      }
      const grp = list[row];
      const rowTop = g.y + CHILD_HEAD + row * CHILD_ROW;
      let portY = rowTop + CHILD_ROW / 2;
      if (grp) {
        const n = grp.ports.length;
        const slot = Math.max(0, grp.ports.findIndex((p) => p.name === ep.port));
        portY = rowTop + ((slot + 0.5) * CHILD_ROW) / n;
      }
      const y = Math.max(g.y + CHILD_HEAD, Math.min(g.y + g.h - 4, portY));
      const x = ep.side === 'input' ? g.x : g.x + g.w;
      return { x, y, role: 'neutral' };
    }
    const ports = childPorts(g.child);
    const list = ep.side === 'input' ? ports.left : ports.right;
    let idx = list.findIndex((p) => p.name === ep.port);
    if (idx < 0) {
      idx = 0;
    }
    const portY = g.y + CHILD_HEAD + (idx + 0.5) * CHILD_ROW;
    const y = Math.max(g.y + CHILD_HEAD, Math.min(g.y + g.h - 4, portY));
    const x = ep.side === 'input' ? g.x : g.x + g.w;
    return { x, y, role: 'neutral' };
  }

  /* ---------------- edge geometry ---------------- */

  interface EdgeGeom {
    edge: TopoEdge;
    d: string;
    color: string;
    markerId: string;
    labelX: number;
    labelY: number;
    title?: string;
  }
  const edgeGeoms: EdgeGeom[] = [];
  const margin = 2;

  let drawEdges: {
    edge: TopoEdge;
    role?: 'input' | 'output' | 'neutral';
    merged?: { cat: PortCat; ports: string[] };
  }[] = edges.map((edge) => ({
    edge,
  }));
  if (useBars) {
    const childGroupCat = (childId: string, side: 'input' | 'output', portName: string): PortCat | null => {
      const cg = childGeoms.find((g) => g.child.id === childId);
      if (!cg) {
        return null;
      }
      const groups = childGroups(cg.child);
      const list = side === 'input' ? groups.left : groups.right;
      const grp = list.find((gr) => gr.ports.some((p) => p.name === portName));
      return grp ? grp.cat : null;
    };
    const lineOf = (ep: TopoEndpoint, side: 'left' | 'right'): { id: string; cat: PortCat } | null => {
      if (ep.kind === 'signal') {
        if (side === 'right') {
          return { id: 'bus:out', cat: 'out' };
        }
        const sig = inputs.find((s) => s.name === ep.name || s.declName === ep.name);
        if (!sig) {
          return null;
        }
        const cat: PortCat = sig.direction === 'inout' ? 'inout' : 'in';
        return { id: `bus:${cat}`, cat };
      }
      const cat = childGroupCat(ep.child, ep.side, ep.port);
      return cat ? { id: `child:${ep.child}:${cat}`, cat } : null;
    };
    const labelOf = (ep: TopoEndpoint): string =>
      ep.kind === 'signal' ? ep.name : `${ep.child}.${ep.port}`;
    interface MergedLink {
      edge: TopoEdge;
      cat: PortCat;
      ports: string[];
    }
    const links = new Map<string, MergedLink>();
    const singles: { edge: TopoEdge }[] = [];
    for (const e of edges) {
      const fromLine = lineOf(e.from, 'left');
      const toLine = lineOf(e.to, 'right');
      if (!fromLine || !toLine) {
        singles.push({ edge: e });
        continue;
      }
      const cat: PortCat = fromLine.id.startsWith('bus:')
        ? fromLine.cat
        : toLine.id === 'bus:out'
          ? 'out'
          : fromLine.cat;
      const key = `${fromLine.id}->${toLine.id}`;
      const pair = `${labelOf(e.from)}→${labelOf(e.to)}`;
      const found = links.get(key);
      if (found) {
        found.ports.push(pair);
      } else {
        links.set(key, { edge: e, cat, ports: [pair] });
      }
    }
    drawEdges = [
      ...singles,
      ...Array.from(links.values()).map((l) => ({
        edge: l.edge,
        role: (l.cat === 'in' ? 'input' : l.cat === 'out' ? 'output' : 'neutral') as
          | 'input'
          | 'output'
          | 'neutral',
        merged: { cat: l.cat, ports: l.ports },
      })),
    ];
  }

  for (const item of drawEdges) {
    const e = item.edge;
    const from = endpointFor(e.from, 'left');
    const to = endpointFor(e.to, 'right');
    if (!from || !to) {
      continue;
    }

    let role: 'input' | 'output' | 'neutral' = item.role ?? 'neutral';
    if (!item.role) {
      if (from.role !== 'neutral') {
        role = from.role;
      } else if (to.role !== 'neutral') {
        role = to.role;
      }
    }
    const color = role === 'input' ? th.input : role === 'output' ? th.output : th.neutral;

    const x0 = from.x;
    const y0 = from.y;
    const x1 = to.x;
    const y1 = to.y;

    let dx = Math.max(24, Math.abs(x1 - x0) * 0.45);
    let c1x: number;
    let c2x: number;
    if (x1 >= x0) {
      dx = Math.min(dx, Math.max(0, canvasW - margin - x0), Math.max(0, x1 - margin));
      c1x = x0 + dx;
      c2x = x1 - dx;
    } else {
      dx = Math.min(dx, Math.max(0, x0 - margin), Math.max(0, canvasW - margin - x1));
      c1x = x0 - dx;
      c2x = x1 + dx;
    }
    if (!isFinite(dx) || dx < 0) {
      dx = 0;
    }

    const d = `M ${num(x0)},${num(y0)} C ${num(c1x)},${num(y0)} ${num(c2x)},${num(y1)} ${num(x1)},${num(y1)}`;

    const roleTag = role === 'input' ? 'in' : role === 'output' ? 'out' : 'neutral';
    const markerId = `${markerBase}-marker-${roleTag}${e.kind === 'expression' ? '-x' : ''}`;

    const labelX = (x0 + 3 * c1x + 3 * c2x + x1) / 8;
    const labelY = (y0 + 3 * y0 + 3 * y1 + y1) / 8;

    const titleParts: string[] = [];
    if (item.merged) {
      const label = item.merged.cat === 'in' ? 'in' : item.merged.cat === 'out' ? 'out' : 'inout';
      titleParts.push(`${label} (${item.merged.ports.length}): ${item.merged.ports.join(', ')}`);
    }
    if (e.kind === 'expression' && e.label) {
      titleParts.push(e.label);
    }
    if (e.select) {
      titleParts.push(e.select);
    }

    edgeGeoms.push({
      edge: e,
      d,
      color,
      markerId,
      labelX,
      labelY,
      title: titleParts.length > 0 ? titleParts.join(' — ') : undefined,
    });
  }

  /* ---------------- assemble ---------------- */

  const parts: string[] = [];

  const titleText = `${model.moduleName} topology`;
  const descText =
    `Connectivity diagram for module ${model.moduleName}` +
    `${inputs.length || outputs.length ? ` with ${inputs.length} input(s) and ${outputs.length} output(s)` : ''}` +
    `${children.length ? ` and ${children.length} child instance(s)` : ''}.`;

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(canvasW)} ${num(
      canvasH,
    )}" width="${num(canvasW)}" height="${num(canvasH)}" role="img" aria-label="${esc(titleText)}">`,
  );
  parts.push(`<title>${esc(titleText)}</title>`);
  parts.push(`<desc>${esc(descText)}</desc>`);

  parts.push(
    '<style>' +
      `:root{--bg:${th.bg};--panel:${th.panel};--stroke:${th.stroke};--text:${th.text};--muted:${th.muted};--input:${th.input};--output:${th.output};--neutral:${th.neutral};}` +
      `.mono{font-family:${FONT};}` +
      '.nav,a{cursor:pointer;}' +
      '</style>',
  );

  const seenMarkers = new Set<string>();
  const markerDefs: string[] = [];
  for (const eg of edgeGeoms) {
    if (seenMarkers.has(eg.markerId)) {
      continue;
    }
    seenMarkers.add(eg.markerId);
    if (eg.edge.kind === 'expression') {
      markerDefs.push(
        `<marker id="${esc(eg.markerId)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">` +
          `<path d="M 0,1 L 9,5 L 0,9 z" fill="${esc(th.bg)}" stroke="${esc(eg.color)}" stroke-width="1.4"/>` +
          '</marker>',
      );
    } else {
      markerDefs.push(
        `<marker id="${esc(eg.markerId)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">` +
          `<path d="M 0,0 L 10,5 L 0,10 z" fill="${esc(eg.color)}"/>` +
          '</marker>',
      );
    }
  }
  if (markerDefs.length > 0) {
    parts.push(`<defs>${markerDefs.join('')}</defs>`);
  }

  parts.push(
    `<rect x="0" y="0" width="${num(canvasW)}" height="${num(canvasH)}" fill="${esc(th.bg)}"/>`,
  );

  /* ---------------- header ---------------- */

  const headerParts: string[] = [];
  headerParts.push(
    `<text class="mono" x="${num(pad)}" y="${num(pad + 18)}" font-family="${FONT}" font-size="16" font-weight="bold" fill="${esc(
      th.text,
    )}">${esc(model.moduleName)}</text>`,
  );

  const crumbLabels = crumbs.map((c) => c.label).filter((l) => !!l);
  const subtitle = crumbLabels.concat([model.moduleName]).join(' › ');
  if (subtitle) {
    headerParts.push(
      `<text class="mono" x="${num(pad)}" y="${num(pad + 36)}" font-family="${FONT}" font-size="11" fill="${esc(
        th.muted,
      )}">${esc(subtitle)}</text>`,
    );
  }
  headerParts.push(
    `<text class="mono" x="${num(pad)}" y="${num(pad + 52)}" font-family="${FONT}" font-size="10" fill="${esc(
      th.muted,
    )}">${esc(`${model.path ?? ''} · ${baseName(model.file ?? '')}`)}</text>`,
  );

  // legend: input, output, then one swatch per distinct child module
  interface LegendItem {
    color: string;
    label: string;
  }
  const modKeys = moduleKeys(children);
  const hasInout =
    bundledIo.length > 0 ||
    children.some((c) => {
      const groups = childGroups(c);
      return (
        groups.left.some((grp) => grp.cat === 'inout') ||
        groups.right.some((grp) => grp.cat === 'inout')
      );
    });
  const legendItems: LegendItem[] = [
    { color: th.input, label: 'input' },
    { color: th.output, label: 'output' },
  ];
  if (hasInout) {
    legendItems.push({ color: th.neutral, label: 'inout' });
  }
  const fixedItems = legendItems.length;
  for (const mk of modKeys.slice(0, LEGEND_CAP)) {
    const idx = modKeys.indexOf(mk);
    const color = th.palette.length > 0 ? th.palette[idx % th.palette.length] : th.neutral;
    legendItems.push({ color, label: moduleNameOfKey(mk) });
  }
  const legendOverflow = Math.max(0, modKeys.length - LEGEND_CAP);

  const legendWidth = (items: LegendItem[]): number => {
    let w = 0;
    for (const it of items) {
      w += 14 + it.label.length * CHAR_W + 10;
    }
    return Math.max(0, w - 10);
  };

  const titleW = model.moduleName.length * 10 + 24;
  let legendAvail = canvasW - pad - (pad + titleW);
  if (legendAvail < 80) {
    legendAvail = Math.max(80, canvasW - pad * 2);
  }

  let shown = legendItems.slice();
  let maxChars = 20;
  while (legendWidth(shown) > legendAvail && maxChars > 4) {
    maxChars -= 1;
    shown = shown.map((it, i) =>
      i < fixedItems ? it : { color: it.color, label: trunc(it.label, maxChars) },
    );
  }
  let droppedModules = 0;
  while (shown.length > fixedItems && legendWidth(shown) > legendAvail) {
    shown.pop();
    droppedModules += 1;
  }
  if (legendOverflow > 0) {
    shown.push({ color: th.muted, label: `+${legendOverflow}` });
  }
  if (droppedModules > 0) {
    shown.push({ color: th.muted, label: `+${droppedModules}` });
  }

  const legendStart = Math.max(pad, canvasW - pad - legendWidth(shown));
  let lx = legendStart;
  for (const it of shown) {
    headerParts.push(
      `<rect x="${num(lx)}" y="${num(pad + 9)}" width="10" height="10" rx="2" fill="${esc(it.color)}"/>`,
    );
    headerParts.push(
      `<text class="mono" x="${num(lx + 14)}" y="${num(pad + 18)}" font-family="${FONT}" font-size="10" fill="${esc(
        th.muted,
      )}">${esc(trunc(it.label, 24))}</text>`,
    );
    lx += 14 + it.label.length * CHAR_W + 10;
  }

  parts.push(`<g class="header">${headerParts.join('')}</g>`);

  /* ---------------- edges (behind the boxes) ---------------- */

  const edgeParts: string[] = [];
  for (const eg of edgeGeoms) {
    const dash = eg.edge.kind === 'expression' ? ' stroke-dasharray="5 4"' : '';
    const titleEl = eg.title ? `<title>${esc(eg.title)}</title>` : '';
    edgeParts.push(
      `<g class="edge">${titleEl}` +
        `<path d="${eg.d}" fill="none" stroke="${esc(eg.color)}" stroke-width="${
          eg.edge.kind === 'expression' ? '1.4' : '1.6'
        }"${dash} marker-end="url(#${esc(eg.markerId)})"/>` +
        '</g>',
    );
  }
  parts.push(`<g class="edges">${edgeParts.join('')}</g>`);

  /* ---------------- signal rows ---------------- */

  if (mode === 'all') {
    const rowParts: string[] = [];
    for (const r of inputRows) {
      rowParts.push(signalRow(r, th, 'input'));
    }
    for (const r of outputRows) {
      rowParts.push(signalRow(r, th, 'output'));
    }
    parts.push(`<g class="signals">${rowParts.join('')}</g>`);
  }

  /* ---------------- boundary rails ---------------- */

  if (hidden) {
    const railParts: string[] = [];
    railParts.push(
      `<line x1="${num(railInnerLeft - 6)}" y1="${num(contentTop)}" x2="${num(
        railInnerLeft - 6,
      )}" y2="${num(contentBottom)}" stroke="${esc(th.stroke)}" stroke-width="1" stroke-dasharray="3 3"/>`,
    );
    railParts.push(
      `<line x1="${num(railInnerRight + 6)}" y1="${num(contentTop)}" x2="${num(
        railInnerRight + 6,
      )}" y2="${num(contentBottom)}" stroke="${esc(th.stroke)}" stroke-width="1" stroke-dasharray="3 3"/>`,
    );
    for (const t of ticks) {
      const color = t.side === 'input' ? th.input : th.output;
      const x0 = t.side === 'input' ? t.x - 14 : t.x;
      const x1 = t.side === 'input' ? t.x : t.x + 14;
      railParts.push(
        `<line x1="${num(x0)}" y1="${num(t.y)}" x2="${num(x1)}" y2="${num(t.y)}" stroke="${esc(
          color,
        )}" stroke-width="2"/>`,
      );
      const lx2 = t.side === 'input' ? t.x - 18 : t.x + 18;
      const anchor = t.side === 'input' ? 'end' : 'start';
      railParts.push(
        `<g class="rail-signal"><title>${esc(t.name)}</title>` +
          `<text class="mono" x="${num(lx2)}" y="${num(t.y + 3)}" font-family="${FONT}" font-size="10" text-anchor="${anchor}" fill="${esc(
            th.muted,
          )}">${esc(trunc(t.name, 20))}</text>` +
          '</g>',
      );
    }
    parts.push(`<g class="rails">${railParts.join('')}</g>`);
  }

  /* ---------------- bundles ---------------- */

  if (useBars) {
    const barParts: string[] = [];
    for (const b of bars) {
      const color = b.cat === 'in' ? th.input : b.cat === 'out' ? th.output : th.neutral;
      const label = b.cat === 'in' ? 'inputs' : b.cat === 'out' ? 'outputs' : 'inout';
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      barParts.push(
        `<g class="bundle"><title>${esc(b.names.join('\n'))}</title>` +
          `<rect x="${num(b.x)}" y="${num(b.y)}" width="${num(b.w)}" height="${num(
            b.h,
          )}" rx="8" fill="${esc(th.panel)}" stroke="${esc(color)}" stroke-width="1.4"/>` +
          `<line x1="${num(b.trunkX)}" y1="${num(b.y)}" x2="${num(b.trunkX)}" y2="${num(
            b.y + b.h,
          )}" stroke="${esc(color)}" stroke-width="${num(RAIL_W)}"/>` +
          `<text class="mono" x="${num(cx)}" y="${num(cy)}" font-family="${FONT}" font-size="11" text-anchor="middle" fill="${esc(
            th.muted,
          )}" transform="rotate(-90 ${num(cx)} ${num(cy)})">${esc(
            `${label} (${b.count})`,
          )}</text>` +
          '</g>',
      );
    }
    parts.push(`<g class="bundles">${barParts.join('')}</g>`);
  }

  /* ---------------- the current module's frame ---------------- */

  parts.push(
    `<g class="module-frame">` +
      `<rect x="${num(moduleFrame.x)}" y="${num(moduleFrame.y)}" width="${num(
        moduleFrame.w,
      )}" height="${num(moduleFrame.h)}" rx="12" fill="none" stroke="${esc(
        th.stroke,
      )}" stroke-width="1.2"/>` +
      `</g>`,
  );

  /* ---------------- child boxes ---------------- */

  const childParts: string[] = [];
  for (const g of childGeoms) {
    childParts.push(childBox(g, navChildren[g.child.id], th, mode));
  }
  parts.push(`<g class="children">${childParts.join('')}</g>`);

  /* ---------------- edge labels ---------------- */

  const labelParts: string[] = [];
  for (const eg of edgeGeoms) {
    const lbl = eg.edge.label;
    if (!lbl || eg.edge.kind !== 'expression' || lbl.length > 24) {
      continue;
    }
    const w = Math.max(24, lbl.length * CHAR_W + 10);
    const cx = Math.max(pad + w / 2, Math.min(canvasW - pad - w / 2, eg.labelX));
    const cy = Math.max(pad + 9, Math.min(canvasH - pad - 9, eg.labelY));
    labelParts.push(
      `<g class="edge-label"><title>${esc(lbl)}</title>` +
        `<rect x="${num(cx - w / 2)}" y="${num(cy - 9)}" width="${num(w)}" height="18" rx="4" fill="${esc(
          th.bg,
        )}" stroke="${esc(th.stroke)}" stroke-width="0.8"/>` +
        `<text class="mono" x="${num(cx)}" y="${num(cy + 3)}" font-family="${FONT}" font-size="10" text-anchor="middle" fill="${esc(
          th.muted,
        )}">${esc(lbl)}</text>` +
        '</g>',
    );
  }
  parts.push(`<g class="edge-labels">${labelParts.join('')}</g>`);

  /* ---------------- footer ---------------- */

  if (warnings.length > 0) {
    const first = warnings[0];
    const extra = warnings.length - 1;
    const text = extra > 0 ? `${first.message} +${extra} more` : first.message;
    const allTitles = warnings.map((w) => w.message).join('\n');
    parts.push(
      `<g class="footer"><title>${esc(allTitles)}</title>` +
        `<text class="mono" x="${num(pad)}" y="${num(canvasH - pad - 8)}" font-family="${FONT}" font-size="10" fill="${esc(
          th.muted,
        )}">${esc(trunc(text, 160))}</text>` +
        '</g>',
    );
  }

  parts.push('</svg>');

  const fileName = o.fileName ?? `${sanitizeName(model.moduleName)}.svg`;
  return { key: input.key, fileName, svg: parts.join('') };
}

/* ------------------------------------------------------------------ */
/* pieces                                                              */
/* ------------------------------------------------------------------ */

function signalRow(
  r: { signal: TopoSignal; x: number; y: number; w: number; h: number },
  th: Theme,
  side: 'input' | 'output',
): string {
  const color = side === 'input' ? th.input : th.output;
  const s = r.signal;
  const suffix = typeof s.width === 'number' && s.width > 1 ? ` [${s.width}]` : '';
  const suffixX = side === 'input' ? r.x + 8 : r.x + r.w - 8;
  const suffixAnchor = side === 'input' ? 'start' : 'end';
  const textX = side === 'input' ? r.x + 22 : r.x + r.w - 22;
  const textAnchor = side === 'input' ? 'start' : 'end';
  return (
    `<g class="signal"><title>${esc(s.name)}</title>` +
    `<rect x="${num(r.x)}" y="${num(r.y)}" width="${num(r.w)}" height="${num(
      r.h,
    )}" rx="6" fill="${esc(th.panel)}" stroke="${esc(color)}" stroke-width="1.2"/>` +
    `<text class="mono" x="${num(suffixX)}" y="${num(r.y + r.h / 2 + 3)}" font-family="${FONT}" font-size="9" fill="${esc(
      th.muted,
    )}" text-anchor="${suffixAnchor}">${esc(suffix)}</text>` +
    `<text class="mono" x="${num(textX)}" y="${num(r.y + r.h / 2 + 4)}" font-family="${FONT}" font-size="11" fill="${esc(
      th.text,
    )}" text-anchor="${textAnchor}">${esc(trunc(s.name, 22))}</text>` +
    '</g>'
  );
}

function childBox(
  g: { child: TopoChild; x: number; y: number; w: number; h: number; color: string },
  nav: NavRef | undefined,
  th: Theme,
  mode: SignalDisplay,
): string {
  const c = g.child;
  const unresolved = c.resolved === false;
  const dash = unresolved ? ' stroke-dasharray="5 3"' : '';
  const body: string[] = [];

  body.push(
    `<rect x="${num(g.x)}" y="${num(g.y)}" width="${num(g.w)}" height="${num(
      g.h,
    )}" rx="8" fill="${esc(th.panel)}" stroke="${esc(g.color)}" stroke-width="1.4"${dash}/>`,
  );
  body.push(
    `<rect x="${num(g.x)}" y="${num(g.y)}" width="${num(g.w)}" height="${num(
      CHILD_HEAD,
    )}" rx="8" fill="${esc(g.color)}" fill-opacity="0.12"/>`,
  );
  body.push(
    `<line x1="${num(g.x)}" y1="${num(g.y + CHILD_HEAD)}" x2="${num(
      g.x + g.w,
    )}" y2="${num(g.y + CHILD_HEAD)}" stroke="${esc(g.color)}" stroke-width="1"/>`,
  );

  // header text: instance name, module name, params
  const badges: string[] = [];
  if (c.array) {
    badges.push(c.array);
  }
  if (c.generated) {
    badges.push('⟳');
  }
  if (c.conditional) {
    badges.push('?');
  }
  let badgeW = 0;
  for (const b of badges) {
    badgeW += b.length * 7 + 8 + 4;
  }

  const textLeft = g.x + 10;
  const textRight = g.x + g.w - 10 - badgeW;
  const instW = Math.min(c.instName.length, 22) * 7.2;
  const modW = Math.min(c.moduleName.length, 24) * 6.4;
  const sameLine = instW + 8 + modW <= textRight - textLeft;

  let instY: number;
  let modY: number | null = null;
  if (sameLine) {
    instY = g.y + 17;
    body.push(
      `<text class="mono" x="${num(textLeft)}" y="${num(instY)}" font-family="${FONT}" font-size="12" font-weight="bold" fill="${esc(
        th.text,
      )}">${esc(trunc(c.instName, 22))}</text>`,
    );
    body.push(
      `<text class="mono" x="${num(textLeft + instW + 8)}" y="${num(instY)}" font-family="${FONT}" font-size="10" fill="${esc(
        th.muted,
      )}">${esc(trunc(c.moduleName, 24))}</text>`,
    );
  } else {
    instY = g.y + 13;
    modY = g.y + 24;
    body.push(
      `<text class="mono" x="${num(textLeft)}" y="${num(instY)}" font-family="${FONT}" font-size="12" font-weight="bold" fill="${esc(
        th.text,
      )}">${esc(trunc(c.instName, 22))}</text>`,
    );
    body.push(
      `<text class="mono" x="${num(textLeft)}" y="${num(modY)}" font-family="${FONT}" font-size="10" fill="${esc(
        th.muted,
      )}">${esc(trunc(c.moduleName, 24))}</text>`,
    );
  }

  if (c.params) {
    const py = modY !== null ? modY + 9 : instY + 12;
    body.push(
      `<text class="mono" x="${num(textLeft)}" y="${num(py)}" font-family="${FONT}" font-size="9" fill="${esc(
        th.muted,
      )}">#(${esc(trunc(c.params, 48))})</text>`,
    );
  }

  // badges, right aligned in the header band
  let bx = g.x + g.w - 10;
  for (let i = badges.length - 1; i >= 0; i--) {
    const b = badges[i];
    const bw = b.length * 7 + 8;
    bx -= bw;
    body.push(
      `<rect x="${num(bx)}" y="${num(g.y + 10)}" width="${num(bw)}" height="14" rx="4" fill="${esc(
        th.bg,
      )}" stroke="${esc(g.color)}" stroke-width="0.8"/>`,
    );
    body.push(
      `<text class="mono" x="${num(bx + bw / 2)}" y="${num(g.y + 20)}" font-family="${FONT}" font-size="9" text-anchor="middle" fill="${esc(
        g.color,
      )}">${esc(b)}</text>`,
    );
    bx -= 4;
  }

  // port stubs
  if (mode === 'bundled') {
    const groups = childGroups(c);
    const drawGroups = (list: PortGroup[], side: 'left' | 'right'): void => {
      list.forEach((grp, row) => {
        const rowTop = g.y + CHILD_HEAD + row * CHILD_ROW;
        const py = rowTop + CHILD_ROW / 2;
        const color = grp.cat === 'in' ? th.input : grp.cat === 'out' ? th.output : th.neutral;
        const x = side === 'left' ? g.x : g.x + g.w - TICK;
        const lx = side === 'left' ? g.x + TICK + 4 : g.x + g.w - TICK - 4;
        const anchor = side === 'left' ? 'start' : 'end';
        const label = `${grp.cat === 'in' ? 'in' : grp.cat === 'out' ? 'out' : 'inout'} (${
          grp.ports.length
        })`;
        body.push(
          `<g class="port-group"><title>${esc(grp.ports.map((p) => p.name).join('\n'))}</title>` +
            `<rect x="${num(x)}" y="${num(rowTop + 2)}" width="${num(TICK)}" height="${num(
              CHILD_ROW - 4,
            )}" rx="3" fill="${esc(color)}" fill-opacity="0.25" stroke="${esc(color)}" stroke-width="1.2"/>` +
            `<text class="mono" x="${num(lx)}" y="${num(py + 3)}" font-family="${FONT}" font-size="9" text-anchor="${anchor}" fill="${esc(
              th.muted,
            )}">${esc(label)}</text>` +
            '</g>',
        );
      });
    };
    drawGroups(groups.left, 'left');
    drawGroups(groups.right, 'right');
  } else {
    const { left, right } = childPorts(c);
    const drawPorts = (ports: TopoChildPort[], side: 'left' | 'right'): void => {
      const cap = ports.slice(0, PORT_CAP);
      const more = ports.length - cap.length;
      for (let i = 0; i < cap.length; i++) {
        const p = cap[i];
        const py = g.y + CHILD_HEAD + (i + 0.5) * CHILD_ROW;
        if (side === 'left') {
          body.push(
            `<line x1="${num(g.x)}" y1="${num(py)}" x2="${num(g.x + TICK)}" y2="${num(
              py,
            )}" stroke="${esc(th.neutral)}" stroke-width="1.2"/>`,
          );
          body.push(
            `<text class="mono" x="${num(g.x + TICK + 4)}" y="${num(py + 3)}" font-family="${FONT}" font-size="9" text-anchor="start" fill="${esc(
              th.muted,
            )}">${esc(trunc(p.name, 16))}</text>`,
          );
        } else {
          body.push(
            `<line x1="${num(g.x + g.w - TICK)}" y1="${num(py)}" x2="${num(g.x + g.w)}" y2="${num(
              py,
            )}" stroke="${esc(th.neutral)}" stroke-width="1.2"/>`,
          );
          body.push(
            `<text class="mono" x="${num(g.x + g.w - TICK - 4)}" y="${num(py + 3)}" font-family="${FONT}" font-size="9" text-anchor="end" fill="${esc(
              th.muted,
            )}">${esc(trunc(p.name, 16))}</text>`,
          );
        }
      }
      if (more > 0) {
        const py = g.y + CHILD_HEAD + (cap.length + 0.5) * CHILD_ROW;
        const lx2 = side === 'left' ? g.x + TICK + 4 : g.x + g.w - TICK - 4;
        const anchor = side === 'left' ? 'start' : 'end';
        body.push(
          `<text class="mono" x="${num(lx2)}" y="${num(py + 3)}" font-family="${FONT}" font-size="9" text-anchor="${anchor}" fill="${esc(
            th.muted,
          )}">+${more} more</text>`,
        );
      }
    };
    drawPorts(left, 'left');
    drawPorts(right, 'right');
  }

  const titleText = unresolved ? 'module not found' : c.instName;
  const inner = `<title>${esc(titleText)}</title>${body.join('')}`;

  const navKey = nav && nav.key ? nav.key : undefined;
  const navHref = nav && nav.href ? nav.href : undefined;
  const navSrc = nav && nav.src ? nav.src : undefined;

  if (navHref) {
    const dataNav = navKey ? ` data-nav="${esc(navKey)}"` : '';
    return `<a href="${esc(navHref)}"${dataNav} class="nav">${inner}</a>`;
  }
  if (navKey) {
    return `<g class="nav" data-nav="${esc(navKey)}" role="link" tabindex="0">${inner}</g>`;
  }
  if (navSrc) {
    return `<g class="src" data-src="${esc(`${navSrc.file}:${navSrc.line}:${navSrc.character}`)}">${inner}</g>`;
  }
  return `<g class="child">${inner}</g>`;
}

/* ------------------------------------------------------------------ */
/* frames                                                              */
/* ------------------------------------------------------------------ */

export function renderFramesSvg(inputs: FrameInput[], opts?: RenderOptions): FrameSvg[] {
  const list = inputs ?? [];
  const names = topologyFileNames(
    list.map((f) => ({ key: f.key, moduleName: f.model ? f.model.moduleName : '' })),
  );
  const out: FrameSvg[] = [];
  for (let i = 0; i < list.length; i++) {
    out.push(renderFrameSvg(list[i], { ...(opts ?? {}), fileName: names[i] }));
  }
  return out;
}
