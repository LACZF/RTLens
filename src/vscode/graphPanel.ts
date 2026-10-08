import * as vscode from 'vscode';

import type { IndexService } from './indexService';
import type { Graph } from '../core/graph';
import { findByPath } from '../core/hierarchy';
import type { HierarchyNode } from '../core/ast';

/**
 * Connectivity graph panel.
 *
 * The webview is a single self-contained HTML document: the graph model arrives
 * as JSON, a small force-directed layout runs in the webview script, and the
 * result is drawn as SVG. No CDN, no web worker, no bundler - the payload is
 * the model itself.
 */
export class GraphPanel {
  private static panels = new Map<string, GraphPanel>();

  static readonly viewType = 'hdl.connectView.graph';

  private readonly disposables: vscode.Disposable[] = [];
  private node?: HierarchyNode;
  private focus: string | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly svc: IndexService,
    private readonly extensionUri: vscode.Uri,
    readonly rootPath: string,
  ) {
    this.panel.webview.html = this.html();
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg)),
      this.panel.onDidDispose(() => this.dispose()),
    );
  }

  static show(
    svc: IndexService,
    extensionUri: vscode.Uri,
    node: HierarchyNode,
    rootPath: string,
  ): GraphPanel {
    const existing = GraphPanel.panels.get(rootPath);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Beside, true);
      existing.setNode(node);
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      GraphPanel.viewType,
      `Connectivity: ${rootPath}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
    );
    const p = new GraphPanel(panel, svc, extensionUri, rootPath);
    GraphPanel.panels.set(rootPath, p);
    p.setNode(node);
    return p;
  }

  static disposeAll(): void {
    for (const p of GraphPanel.panels.values()) {
      p.dispose();
    }
    GraphPanel.panels.clear();
  }

  get viewColumn(): vscode.ViewColumn | undefined {
    return this.panel.viewColumn;
  }

  setNode(node: HierarchyNode, focus?: string): void {
    this.node = node;
    this.focus = focus ?? node.path;
    void this.refresh();
  }

  /** Zoom the graph to a subtree. */
  focusNode(path: string): void {
    if (!this.node) {
      return;
    }
    const n = findByPath(this.node, path);
    if (n) {
      this.setNode(n, n.path);
    }
  }

  async refresh(): Promise<void> {
    if (!this.node) {
      return;
    }
    const graph = this.svc.graphFor(this.node, { maxDepth: 8 });
    this.panel.title = `Connectivity: ${graph.root}`;
    await this.panel.webview.postMessage({ type: 'graph', graph, focus: this.focus });
    this.panel.webview.postMessage({ type: 'stats', text: statsLine(graph) });
  }

  private onMessage(msg: { type: string; [k: string]: unknown }): void {
    switch (msg.type) {
      case 'ready':
        void this.refresh();
        return;
      case 'open': {
        const file = String(msg.file ?? '');
        const line = Number(msg.line ?? 0);
        const character = Number(msg.character ?? 0);
        if (file) {
          void vscode.window.showTextDocument(vscode.Uri.file(file), {
            viewColumn: vscode.ViewColumn.One,
            selection: new vscode.Range(line, character, line, character),
            preserveFocus: true,
          });
        }
        return;
      }
      case 'focus': {
        const path = String(msg.path ?? '');
        if (this.node && path && path !== this.node.path) {
          const n = findByPath(this.node, path);
          if (n) {
            this.setNode(n, n.path);
          }
        }
        return;
      }
      case 'error':
        void vscode.window.showErrorMessage(`HDL: ${String(msg.message ?? 'unknown error')}`);
        return;
      default:
        return;
    }
  }

  private html(): string {
    const csp = [
      `default-src 'none'`,
      `style-src 'unsafe-inline'`,
      `script-src 'unsafe-inline'`,
      `img-src data:`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>HDL connectivity</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <input id="search" type="search" placeholder="Filter by name, module or signal" spellcheck="false">
  <label><input type="checkbox" id="neighbourhood"> neighbourhood only</label>
  <label><input type="checkbox" id="containment"> containment edges</label>
  <label><input type="checkbox" id="assigns" checked> continuous assigns</label>
  <span id="stats"></span>
</header>
<svg id="canvas" tabindex="0"></svg>
<footer id="legend">
  <span class="k inst">module instance</span>
  <span class="k net">net</span>
  <span class="k root">graph root</span>
  <span class="k in">input port</span>
  <span class="k out">output port</span>
  <span class="k inout">inout</span>
  <span class="k bad">unresolved</span>
</footer>
<script>${SCRIPT}</script>
</body>
</html>`;
  }

  dispose(): void {
    GraphPanel.panels.delete(this.rootPath);
    for (const d of this.disposables) {
      d.dispose();
    }
    this.panel.dispose();
    void this.extensionUri;
  }
}

function statsLine(g: Graph): string {
  const parts = [
    `${g.stats.instances} instance${g.stats.instances === 1 ? '' : 's'}`,
    `${g.stats.nets} net${g.stats.nets === 1 ? '' : 's'}`,
    `${g.stats.edges} edge${g.stats.edges === 1 ? '' : 's'}`,
  ];
  if (g.truncated) {
    parts.push('truncated');
  }
  if (g.issues.length) {
    parts.push(`${g.issues.length} issue${g.issues.length === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; height: 100vh; display: flex; flex-direction: column;
    font-family: var(--vscode-font-family); font-size: 12px;
    color: var(--vscode-foreground); background: var(--vscode-editor-background);
  }
  header {
    display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
    padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border);
  }
  header label { display: inline-flex; gap: 4px; align-items: center; cursor: pointer; opacity: .85; }
  #search {
    flex: 1 1 220px; min-width: 160px; padding: 3px 6px;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; outline: none;
  }
  #stats { margin-left: auto; opacity: .7; font-variant-numeric: tabular-nums; }
  #canvas { flex: 1 1 auto; width: 100%; height: 100%; display: block; cursor: grab; }
  #canvas.dragging { cursor: grabbing; }
  footer {
    display: flex; gap: 14px; flex-wrap: wrap; padding: 4px 10px;
    border-top: 1px solid var(--vscode-panel-border); opacity: .8;
  }
  .k::before {
    content: ''; display: inline-block; width: 9px; height: 9px;
    border-radius: 2px; margin-right: 4px; vertical-align: -1px; background: currentColor;
  }
  .k.inst { color: #4d9de0; } .k.net { color: #c9a227; } .k.root { color: #8f5fd0; }
  .k.in { color: #57b97b; } .k.out { color: #e0655f; } .k.inout { color: #b07de0; } .k.bad { color: #e0a03f; }
  .node { cursor: pointer; }
  .node rect, .node circle { stroke-width: 1.2; }
  .node text { font-size: 10px; pointer-events: none; }
  .edge { fill: none; stroke-width: 1.1; opacity: .55; }
  .edge:hover { opacity: 1; stroke-width: 2; }
  .dim { opacity: .12; }
  #tip {
    position: fixed; pointer-events: none; padding: 3px 6px; max-width: 420px;
    background: var(--vscode-editorHoverWidget-background, #252526);
    color: var(--vscode-editorHoverWidget-foreground, #fff);
    border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
    border-radius: 3px; display: none; z-index: 10; white-space: pre-wrap;
  }
`;

const SCRIPT = String.raw`
(function () {
  const vscode = acquireVsCodeApi();
  const svg = document.getElementById('canvas');
  const tip = document.createElement('div');
  tip.id = 'tip';
  document.body.appendChild(tip);
  const search = document.getElementById('search');
  const cbNeigh = document.getElementById('neighbourhood');
  const cbCont = document.getElementById('containment');
  const cbAssign = document.getElementById('assigns');
  const stats = document.getElementById('stats');

  let model = null;
  let nodes = [];
  let edges = [];
  let view = { x: 0, y: 0, k: 1 };
  let drag = null;
  let highlight = null;
  // Redraws are coalesced into one per frame: a rebuild of the whole graph costs
  // more than a frame at the default 800 node budget, and mousemove fires far
  // more often than the display refreshes.
  var queued = 0;
  function scheduleDraw() {
    if (queued) return;
    queued = requestAnimationFrame(function () { queued = 0; draw(); });
  }
  // Set once the pointer has travelled far enough to count as a drag, so the
  // click that follows a drag does not also open or zoom into the node.
  var dragged = false;

  const NS = 'http://www.w3.org/2000/svg';
  const el = (name, attrs) => {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  };
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function colorFor(n) {
    if (n.unresolved) return css('--vscode-editorWarning-foreground') || '#e0a03f';
    if (n.kind === 'root') return '#8f5fd0';
    if (n.kind === 'net') return n.direction === 'output' ? '#e0655f' : n.direction === 'inout' ? '#b07de0' : '#57b97b';
    return '#4d9de0';
  }

  function matches(n, q) {
    if (!q) return true;
    const s = q.toLowerCase();
    return (n.label || '').toLowerCase().includes(s)
      || (n.moduleName || '').toLowerCase().includes(s)
      || (n.path || '').toLowerCase().includes(s);
  }

  function visible() {
    if (!model) return { n: [], e: [] };
    const q = search.value.trim();
    let keep = new Set();
    for (const n of model.nodes) if (matches(n, q)) keep.add(n.id);
    if (q) {
      // keep direct neighbours of a match so the wiring stays visible
      for (const e of model.edges) {
        if (keep.has(e.from)) keep.add(e.to);
        if (keep.has(e.to)) keep.add(e.from);
      }
    }
    let ns = model.nodes.filter(n => keep.has(n.id));
    if (cbNeigh.checked && highlight) {
      const near = new Set([highlight]);
      for (const e of model.edges) {
        if (e.from === highlight) near.add(e.to);
        if (e.to === highlight) near.add(e.from);
      }
      ns = model.nodes.filter(n => near.has(n.id));
      keep = near;
    }
    const es = model.edges.filter(e => keep.has(e.from) && keep.has(e.to)
      && (cbAssign.checked || e.kind !== 'net')
      && (cbCont.checked || e.kind !== 'containment'));
    return { n: ns, e: es };
  }

  // Repulsion is only worth computing for nodes that are close together, so the
  // nodes are bucketed into a grid and each one only looks at its own cell and
  // the eight around it. The force is 900/d^2, i.e. below 0.05 beyond ~130 units,
  // so a 140 unit cell covers everything that still matters. That turns the
  // quadratic sweep into roughly linear work and keeps an 800 node graph (the
  // default budget) responsive.
  var CELL = 140;

  function repel(n) {
    var grid = new Map();
    for (var i = 0; i < n.length; i++) {
      var k = Math.floor(n[i].x / CELL) + ',' + Math.floor(n[i].y / CELL);
      var b = grid.get(k);
      if (!b) grid.set(k, b = []);
      b.push(n[i]);
    }
    for (var i = 0; i < n.length; i++) {
      var a = n[i];
      var cx = Math.floor(a.x / CELL), cy = Math.floor(a.y / CELL);
      for (var gx = cx - 1; gx <= cx + 1; gx++) {
        for (var gy = cy - 1; gy <= cy + 1; gy++) {
          var bucket = grid.get(gx + ',' + gy);
          if (!bucket) continue;
          for (var j = 0; j < bucket.length; j++) {
            var b2 = bucket[j];
            if (b2 === a) continue;
            var dx = a.x - b2.x, dy = a.y - b2.y;
            var d2 = dx * dx + dy * dy;
            if (d2 < 0.01) {
              // Coincident points: nudge them apart deterministically, so the
              // same graph always lays out the same way.
              var h = (a.seed * 2654435761 % 97) / 97 - 0.5;
              dx = h * 0.2; dy = (h * 7 % 1) * 0.2; d2 = dx * dx + dy * dy + 0.01;
            }
            var d = Math.sqrt(d2);
            var f = 900 / d2;
            a.vx += (dx / d) * f; a.vy += (dy / d) * f;
          }
        }
      }
    }
  }

  /**
   * Deterministic radial seeding, then relaxation passes. The work is sliced
   * across animation frames so a large graph never freezes the webview; done()
   * runs once the layout has settled.
   */
  function layout(n, e, done) {
    var cx = 0, cy = 0;
    n.forEach(function (x, i) {
      var a = (i / n.length) * Math.PI * 2;
      var r = 60 + 40 * Math.sqrt(i);
      x.x = cx + Math.cos(a) * r;
      x.y = cy + Math.sin(a) * r;
      x.vx = 0; x.vy = 0;
      x.seed = i + 1;
    });
    CELL = Math.max(90, Math.min(220, 40 * Math.sqrt(n.length)));
    var idx = new Map(n.map(function (x) { return [x.id, x]; }));
    var links = e.filter(function (x) { return idx.has(x.from) && idx.has(x.to); })
      .map(function (x) { return [idx.get(x.from), idx.get(x.to), x.kind === 'containment' ? 0.25 : 1]; });
    // Fewer passes for big graphs: they start further apart and converge faster.
    var iters = n.length > 400 ? 70 : n.length > 120 ? 130 : 260;
    var iter = 0;
    function step() {
      var t0 = Date.now();
      while (iter < iters) {
        var cool = 1 - iter / iters;
        repel(n);
        for (var l = 0; l < links.length; l++) {
          var a = links[l][0], b = links[l][1], w = links[l][2];
          var dx = b.x - a.x, dy = b.y - a.y;
          var d = Math.max(0.01, Math.hypot(dx, dy));
          var f = (d - 78) * 0.06 * w;
          var ux = dx / d * f, uy = dy / d * f;
          a.vx += ux; a.vy += uy; b.vx -= ux; b.vy -= uy;
        }
        for (var i = 0; i < n.length; i++) {
          var p = n[i];
          p.vx -= p.x * 0.012; p.vy -= p.y * 0.012;
          p.x += Math.max(-14, Math.min(14, p.vx)) * cool;
          p.y += Math.max(-14, Math.min(14, p.vy)) * cool;
          p.vx *= 0.55; p.vy *= 0.55;
        }
        iter++;
        if (Date.now() - t0 > 20) break;
      }
      if (iter < iters) { requestAnimationFrame(step); return; }
      done();
    }
    requestAnimationFrame(step);
  }

  function draw() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!model) return;
    const sel = visible();
    nodes = sel.n; edges = sel.e;
    if (!nodes.length) return;
    if (!nodes[0].__laid) {
      // The layout runs over several frames; render what is settled so far and
      // mark the nodes as laid out so a redraw does not restart it.
      layout(nodes, edges, function () { draw(); });
      for (const n of nodes) n.__laid = 1;
      const pending = el('text', {
        x: 12, y: 24, fill: 'currentColor', opacity: .75, 'font-size': 12,
      });
      pending.textContent = 'laying out ' + nodes.length + ' nodes...';
      svg.appendChild(pending);
      return;
    }
    const g = el('g', { transform: 'translate(' + view.x + ',' + view.y + ') scale(' + view.k + ')' });
    svg.appendChild(g);
    const byId = new Map(nodes.map(n => [n.id, n]));
    const edgeLayer = el('g', {}), nodeLayer = el('g', {});
    g.appendChild(edgeLayer); g.appendChild(nodeLayer);
    const edgeEls = [];
    for (const e of edges) {
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b) continue;
      const stroke = e.unresolved ? '#e0a03f'
        : e.direction === 'output' ? '#e0655f'
        : e.direction === 'inout' ? '#b07de0' : '#57b97b';
      const path = el('path', {
        class: 'edge',
        stroke: stroke,
        'stroke-dasharray': e.dashed ? '4 3' : '',
        'stroke-width': e.kind === 'containment' ? 0.8 : 1.1,
      });
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const nx = -(b.y - a.y) * 0.12, ny = (b.x - a.x) * 0.12;
      path.setAttribute('d', 'M' + a.x + ',' + a.y + ' Q' + (mx + nx) + ',' + (my + ny) + ' ' + b.x + ',' + b.y);
      path.addEventListener('mouseenter', (ev) => showTip(ev, edgeTip(e)));
      path.addEventListener('mousemove', moveTip);
      path.addEventListener('mouseleave', hideTip);
      path.addEventListener('click', () => {
        if (e.file) vscode.postMessage({ type: 'open', file: e.file, line: e.range ? e.range.start.line : 0, character: e.range ? e.range.start.character : 0 });
      });
      edgeLayer.appendChild(path);
      edgeEls.push({ e, el: path, a, b });
    }
    const nodeEls = [];
    for (const n of nodes) {
      const isNet = n.kind === 'net';
      const w = Math.max(34, Math.min(190, (n.label || '').length * 6.4 + 16));
      const h = 22;
      const grp = el('g', { class: 'node', transform: 'translate(' + n.x + ',' + n.y + ')' });
      const box = el('rect', {
        x: -w / 2, y: -h / 2, width: w, height: h, rx: 5,
        fill: 'var(--vscode-editorWidget-background, #252526)',
        stroke: colorFor(n),
      });
      grp.appendChild(box);
      const label = el('text', { x: 0, y: 4, 'text-anchor': 'middle', fill: 'currentColor' });
      label.textContent = truncate(n.label || '', Math.floor(w / 6.4));
      grp.appendChild(label);
      if (n.width && n.width > 1) {
        const wTag = el('text', { x: w / 2 + 4, y: 4, 'text-anchor': 'start', fill: 'currentColor', opacity: .6 });
        wTag.textContent = n.width + 'b';
        grp.appendChild(wTag);
      }
      grp.addEventListener('mouseenter', (ev) => showTip(ev, nodeTip(n)));
      grp.addEventListener('mousemove', moveTip);
      grp.addEventListener('mouseleave', hideTip);
      grp.addEventListener('mousedown', (ev) => { drag = { n, ev: ev }; highlight = n.id; dragged = false; });
      grp.addEventListener('click', () => {
        if (dragged) { dragged = false; return; }
        if (n.kind === 'net') {
          if (n.file) vscode.postMessage({ type: 'open', file: n.file, line: n.range ? n.range.start.line : 0, character: n.range ? n.range.start.character : 0 });
        } else {
          vscode.postMessage({ type: 'focus', path: n.path });
        }
      });
      nodeLayer.appendChild(grp);
      nodeEls.push({ n, grp, w, h });
    }
    drag = null;
    api._els = { nodeEls, edgeEls, byId };
  }

  const api = { _els: null, redraw: draw };

  function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function nodeTip(n) {
    const lines = [n.label + (n.detail ? '  :  ' + n.detail : '')];
    if (n.path) lines.push(n.path);
    if (n.width) lines.push(n.width + ' bit' + (n.width === 1 ? '' : 's') + (n.direction ? '  ' + n.direction : ''));
    if (n.truncated) lines.push('(subtree not expanded)');
    if (n.unresolved) lines.push('(module not found in the index)');
    if (n.childCount) lines.push(n.childCount + ' child instance(s) - click to focus');
    return lines.join('\n');
  }
  function edgeTip(e) {
    const lines = [];
    lines.push((e.port ? '.' + e.port : e.kind) + (e.signal ? '  <-  ' + e.signal : ''));
    if (e.direction) lines.push('direction: ' + e.direction);
    if (e.select) lines.push('select: ' + e.select);
    if (e.width) lines.push(e.width + ' bits');
    if (e.unresolved) lines.push('signal not declared in this scope');
    if (e.file) lines.push('click to open the source');
    return lines.join('\n');
  }
  function showTip(ev, text) { tip.textContent = text; tip.style.display = 'block'; moveTip(ev); }
  function moveTip(ev) {
    tip.style.left = Math.min(window.innerWidth - 430, ev.clientX + 14) + 'px';
    tip.style.top = (ev.clientY + 16) + 'px';
  }
  function hideTip() { tip.style.display = 'none'; }

  function applyHighlight() {
    if (!api._els) return;
    const near = new Set();
    if (highlight) {
      near.add(highlight);
      for (const e of model.edges) {
        if (e.from === highlight) near.add(e.to);
        if (e.to === highlight) near.add(e.from);
      }
    }
    for (const { n, grp } of api._els.nodeEls) grp.classList.toggle('dim', !!highlight && !near.has(n.id));
    for (const { e, el: path } of api._els.edgeEls) {
      path.classList.toggle('dim', !!highlight && !(e.from === highlight || e.to === highlight));
    }
  }

  // pan / zoom
  svg.addEventListener('mousedown', (ev) => { drag = { pan: true, sx: ev.clientX, sy: ev.clientY, ox: view.x, oy: view.y }; svg.classList.add('dragging'); });
  window.addEventListener('mouseup', () => { drag = null; svg.classList.remove('dragging'); applyHighlight(); });
  window.addEventListener('mousemove', (ev) => {
    if (!drag) return;
    if (drag.pan) {
      view.x = drag.ox + (ev.clientX - drag.sx);
      view.y = drag.oy + (ev.clientY - drag.sy);
      scheduleDraw();
    } else if (drag.n) {
      var dx = (ev.clientX - drag.ev.clientX) / view.k, dy = (ev.clientY - drag.ev.clientY) / view.k;
      if (Math.abs(ev.clientX - drag.ev.clientX) + Math.abs(ev.clientY - drag.ev.clientY) > 3) dragged = true;
      drag.n.x += dx;
      drag.n.y += dy;
      drag.ev = ev;
      scheduleDraw();
    }
  });
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const f = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
    const k = Math.max(0.15, Math.min(6, view.k * f));
    view.x = ev.clientX - (ev.clientX - view.x) * (k / view.k);
    view.y = ev.clientY - (ev.clientY - view.y) * (k / view.k);
    view.k = k;
    scheduleDraw();
  }, { passive: false });
  svg.addEventListener('dblclick', () => { view = { x: 0, y: 0, k: 1 }; draw(); });

  for (const el of [search, cbNeigh, cbCont, cbAssign]) {
    el.addEventListener('input', () => { draw(); });
    el.addEventListener('change', () => { draw(); });
  }

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg.type === 'graph') {
      model = msg.graph;
      highlight = null;
      nodes = []; edges = [];
      for (const n of model.nodes) n.__laid = 0;
      // The root's path is the empty string, so this has to be an undefined
      // check - otherwise opening a graph for a top module highlights nothing.
      if (msg.focus !== undefined && msg.focus !== null) {
        const f = model.nodes.find(n => n.path === msg.focus);
        highlight = f ? f.id : null;
      }
      draw();
    } else if (msg.type === 'stats') {
      stats.textContent = msg.text || '';
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
`;
