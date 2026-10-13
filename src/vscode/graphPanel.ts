import * as vscode from 'vscode';

import type { IndexService } from './indexService';
import type { Graph } from '../core/graph';
import { containingDesign, findByPath, pathChain } from '../core/hierarchy';
import { signalUsage } from '../core/nets';
import type { HierarchyNode } from '../core/ast';

/**
 * Parent-scope signals a child page may claim. Each revealed child attaches its
 * wires to the parent's scope, so a page of `defaultChildLimit` children needs
 * more than one signal page of headroom; the child page grants this many extra
 * signals so the newly drawn boxes are wired rather than dangling.
 */
const CHILD_SIGNAL_FACTOR = 3;

/**
 * Connectivity graph panel.
 *
 * The webview is a single self-contained HTML document: the graph model arrives
 * as JSON and is drawn as SVG, grouped the way the picture reads - one box per
 * module, its signals as rows inside that box, and every wire attached to the
 * signal row it belongs to rather than to the module outline. No CDN, no web
 * worker, no bundler - the payload is the model itself.
 */
export class GraphPanel {
  private static panels = new Map<string, GraphPanel>();

  static readonly viewType = 'hdl.connectView.graph';

  private readonly disposables: vscode.Disposable[] = [];
  private node?: HierarchyNode;
  private focus: string | undefined;
  /**
   * The top of the hierarchy the node was picked from. The graph shows the
   * nodes that contain the root above it, so a mid-tree module keeps the
   * context of who instantiates it.
   */
  private chainRoot: HierarchyNode;
  /**
   * The full ancestor chain from `chainRoot` down to the root's parent. The
   * graph starts without it and the webview's `+` walks up one entry at a time,
   * so a mid-tree module is not shown with its whole containing context at once.
   */
  private ancestors: HierarchyNode[] = [];
  /** How many of `ancestors` (from the parent upward) are currently drawn. */
  private ancestorsShown = 0;
  /**
   * Instance paths whose direct children are drawn. Each module toggles only
   * itself: the root's + adds its path here to show its children; a child's +
   * adds that child's path to show its children.
   */
  private readonly expanded = new Set<string>();
  // Kept for compatibility with older protocol; not used with per-module expansion.
  // private readonly descendantsAvailable = 0;
  /**
   * Instance paths the user collapsed in the webview. Sent back with every
   * request so the graph itself shrinks: nothing below a collapsed box is
   * expanded, and the webview only has to hide what it is told about.
   */
  private readonly collapsed = new Set<string>();
  /**
   * Per-box signal cap raised by the webview's "show more". The graph sends at
   * most `hdl.connectView.graph.maxSignalsPerGroup` rows per box; each click
   * raises that box's ceiling so the next build carries more of its signals.
   */
  private signalLimits = new Map<string, number>();
  /**
   * Per-box child window raised by the same "show more". A module with more
   * children than fit the current budgets stays in `Graph.pagedScopes`, and
   * every click on its paged box raises this page so the next build draws the
   * next children instead of stalling on the node budget.
   */
  private childLimits = new Map<string, number>();
  /**
   * Effective node budget, `undefined` until the first page of children is
   * asked for. Every child page grants the walk one more `graph.maxNodes`
   * worth of nodes, so a huge module pages out one bounded window after another
   * instead of stopping dead at the configured cap.
   */
  private nodeBudget: number | undefined;
  /**
   * The per-module search: the box the webview typed in, and what was typed.
   * Its matches are revealed on the next refresh by expanding their ancestor
   * chain and raising the signal/child ceilings along it, so a signal or child
   * module that was paged or capped away shows up instead of only being
   * reported as missing.
   */
  private boxSearch: { path: string; query: string } | null = null;
  /** Instance paths expanded only to reach a match of `boxSearch`. */
  private searchExpanded = new Set<string>();
  /** Child-window bumps that keep a matching child inside the drawn page. */
  private searchChildLimits = new Map<string, number>();
  /** Signal-ceiling bumps for scopes holding a matching signal. */
  private searchSignalLimits = new Map<string, number>();
  /**
   * Signals a search matched that the graph would not otherwise carry, keyed by
   * instance path. A net that is only named in a sensitivity list or a plain
   * declaration has no port and no assign endpoint, so without this the row the
   * reader searched for would never be materialised.
   */
  private searchSignals = new Map<string, string[]>();

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly svc: IndexService,
    private readonly extensionUri: vscode.Uri,
    readonly rootPath: string,
    chainRoot: HierarchyNode,
  ) {
    this.chainRoot = chainRoot;
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
    chainRoot?: HierarchyNode,
  ): GraphPanel {
    const existing = GraphPanel.panels.get(rootPath);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Beside, true);
      existing.setChainRoot(chainRoot ?? node);
      existing.setNode(node);
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      GraphPanel.viewType,
      `Connectivity: ${rootPath}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
    );
    const p = new GraphPanel(panel, svc, extensionUri, rootPath, chainRoot ?? node);
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

  /** Change the containing hierarchy the next setNode walks up. */
  setChainRoot(root: HierarchyNode): void {
    this.chainRoot = root;
  }

  setNode(node: HierarchyNode, focus?: string): void {
    // A graph rooted at a bare module definition (the module, not an instance)
    // cannot say who instantiates it, so its containing chain is invisible: the
    // left-edge + finds nothing. Walk the index upward and re-root the walk at
    // the design that contains the module - chip_top above datapath above adder
    // - remapping the node and focus onto the real instance paths. Anything
    // already rooted inside a hierarchy keeps its chain as given.
    if (!this.chainRoot.path.includes('.')) {
      const containing = containingDesign(
        this.svc.index,
        this.chainRoot.moduleName,
        this.chainRoot.file,
        this.svc.config.topModules,
      );
      if (containing && containing.node.path !== containing.root.path) {
        const base = this.chainRoot.path;
        const remap = (p: string) =>
          p === base
            ? containing.node.path
            : p.startsWith(base + '.')
              ? containing.node.path + p.slice(base.length)
              : p;
        const mapped = findByPath(containing.root, remap(node.path));
        if (mapped) {
          focus = remap(focus ?? node.path);
          this.chainRoot = containing.root;
          node = mapped;
        }
      }
    }
    this.node = node;
    this.focus = focus ?? node.path;
    this.ancestors = pathChain(this.chainRoot, node.path).slice(0, -1);
    // A fresh root starts with no containing modules and no children; the plus
    // signs at its edges reveal them one level at a time.
    this.ancestorsShown = 0;
    this.expanded.clear();
    this.signalLimits.clear();
    this.childLimits.clear();
    this.nodeBudget = undefined;
    this.boxSearch = null;
    this.searchExpanded.clear();
    this.searchChildLimits.clear();
    this.searchSignalLimits.clear();
    this.searchSignals.clear();
    // `subtreeDepth` is no longer driving the per-module toggle; the extension
    // still computes it so external callers are unchanged, but it is ignored.
    // A collapse that would hide the new root (or anything on its ancestor
    // chain) is meaningless once we zoom there - drop it instead of drawing an
    // empty graph.
    for (const c of [...this.collapsed]) {
      if (node.path === c || node.path.startsWith(c + '.') || node.path.startsWith(c + '::')) {
        this.collapsed.delete(c);
      }
    }
    void this.refresh();
  }

  /** Zoom the graph to a subtree. */
  focusNode(path: string): void {
    if (!this.node) {
      return;
    }
    const n = findByPath(this.chainRoot, path);
    if (n) {
      this.setNode(n, n.path);
    }
  }

  async refresh(): Promise<void> {
    if (!this.node) {
      return;
    }
    // The chain is stored top-down; reveal from the root upward, so the last
    // `ancestorsShown` entries are the ones nearest the graph root.
    const first = Math.max(0, this.ancestors.length - this.ancestorsShown);
    const shown = this.ancestors.slice(first);
    const graph = this.svc.graphFor(this.node, {
      maxDepth: 8,
      ancestors: shown,
      collapsed: [...this.collapsed],
      expanded: [...this.expanded, ...this.searchExpanded],
      signalLimits: { ...Object.fromEntries(this.signalLimits), ...Object.fromEntries(this.searchSignalLimits) },
      includeSignals: Object.fromEntries(this.searchSignals),
      childLimits: { ...Object.fromEntries(this.childLimits), ...Object.fromEntries(this.searchChildLimits) },
      maxNodes: this.nodeBudget,
    });
    this.panel.title = `Connectivity: ${graph.root}`;
    await this.panel.webview.postMessage({
      type: 'graph',
      graph,
      focus: this.focus,
      collapsed: [...this.collapsed],
      ancestorsShown: shown.length,
      ancestorsLeft: this.ancestors.length - shown.length,
      expanded: [...this.expanded],
    });
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
          const n = findByPath(this.chainRoot, path);
          if (n) {
            this.setNode(n, n.path);
          }
        }
        return;
      }
      case 'collapse': {
        const path = String(msg.path ?? '');
        if (!path) {
          return;
        }
        if (msg.collapsed) {
          this.collapsed.add(path);
        } else {
          this.collapsed.delete(path);
        }
        void this.refresh();
        return;
      }
      case 'ancestors': {
        // How many containing modules to draw, clamped to the chain actually
        // available above the root.
        const want = Number(msg.shown ?? 0);
        const n = Number.isFinite(want) ? Math.round(want) : 0;
        this.ancestorsShown = Math.max(0, Math.min(this.ancestors.length, n));
        void this.refresh();
        return;
      }
      case 'descendants': {
        const want = String(msg.path ?? '');
        const open = !!msg.expanded;
        if (want) {
          if (open) this.expanded.add(want);
          else this.expanded.delete(want);
        }
        void this.refresh();
        return;
      }
      case 'moreSignals': {
        // Two distinct rows ask this: the box's `...` row (its signals were cut
        // by the cap) and its `more children` row (its children are paged). The
        // signal row raises the box's signal ceiling by the configured page size
        // as before; `children: true` (the box is in `Graph.pagedScopes`) instead
        // raises the child window by one page and grants the walk one more node
        // budget, so a module with thousands of children reveals one page at a
        // time instead of stopping dead at `graph.maxNodes`.
        const path = String(msg.path ?? '');
        if (!path) {
          return;
        }
        const cap = this.svc.config.graphMaxSignalsPerGroup;
        const childPage = this.svc.config.defaultChildLimit;
        if (msg.children === true) {
          const cl = this.childLimits.get(path) ?? childPage;
          this.childLimits.set(path, cl + childPage);
          if (cap > 0) {
            const sig = this.signalLimits.get(path) ?? cap;
            this.signalLimits.set(path, sig + childPage * CHILD_SIGNAL_FACTOR);
          }
          this.nodeBudget =
            (this.nodeBudget ?? this.svc.config.graphMaxNodes) + this.svc.config.graphMaxNodes;
        } else if (cap > 0) {
          const current = this.signalLimits.get(path) ?? cap;
          this.signalLimits.set(path, current + cap);
        }
        void this.refresh();
        return;
      }
      case 'boxSearch': {
        // One module box was searched. Recompute what has to be revealed so the
        // matches are actually drawn (their ancestor chain expanded, the child
        // windows and signal ceilings along it raised), then rebuild.
        const path = String(msg.path ?? '');
        const query = String(msg.query ?? '').trim();
        this.boxSearch = query ? { path, query } : null;
        this.rebuildSearchReveal();
        void this.refresh();
        return;
      }
      case 'error':
        void vscode.window.showErrorMessage(`HDL: ${String(msg.message ?? 'unknown error')}`);
        return;
      default:
        return;
    }
  }

  /**
   * Work out what the current per-module search needs drawn. A match is one of
   * the box's own signals whose name contains the query, or a direct child
   * instance whose instance or module name does. Only the searched box's own
   * signal ceiling is lifted and only its child window is widened far enough to
   * reach the matched child; nothing deeper is expanded, so a box search never
   * unfolds a whole subtree.
   */
  private rebuildSearchReveal(): void {
    const s = this.boxSearch;
    if (!s || !this.node) {
      this.searchExpanded.clear();
      this.searchChildLimits.clear();
      this.searchSignalLimits.clear();
      this.searchSignals.clear();
      return;
    }
    // A new query adds to what earlier queries revealed rather than reshuffling
    // it: once a box or row has been brought on screen it stays, so typing a
    // second search never takes the first one's results away.
    const scope =
      s.path === this.node.path
        ? this.node
        : findByPath(this.chainRoot, s.path) ?? findByPath(this.node, s.path);
    if (!scope) {
      return;
    }
    const q = s.query.toLowerCase();
    const names = new Map<string, string[]>();
    const signalsOf = (n: HierarchyNode): string[] => {
      const key = n.moduleName + '\u0000' + n.file;
      let cached = names.get(key);
      if (!cached) {
        const def = this.svc.index.resolveModule(n.moduleName, n.file);
        // The graph can draw a module's ports and any signal its assignments or
        // port connections name, so those are the names a search may match.
        cached = def
          ? [...def.ports.map((p) => p.name), ...signalUsage(this.svc.index, def).keys()]
          : [];
        names.set(key, cached);
      }
      return cached;
    };
    // The module's own signals.
    const matchedSignals = signalsOf(scope).filter((name) => name.toLowerCase().includes(q));
    const signalHit = matchedSignals.length > 0;
    // Carry the matched names forward so the graph materialises them even when
    // they are not a port or an assign endpoint; the union keeps an earlier
    // query's internal signals on screen.
    if (matchedSignals.length) {
      const prev = this.searchSignals.get(scope.path) ?? [];
      this.searchSignals.set(scope.path, Array.from(new Set([...prev, ...matchedSignals])));
    }
    // Its direct children, and no deeper: the walk stops here.
    let childHit = false;
    const kids = scope.children ?? [];
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      const hit = (c.instName || '').toLowerCase().includes(q)
        || (c.moduleName || '').toLowerCase().includes(q);
      if (!hit) {
        continue;
      }
      childHit = true;
      const cur = this.searchChildLimits.get(scope.path) ?? 0;
      if (i + 1 > cur) {
        this.searchChildLimits.set(scope.path, i + 1);
      }
    }
    // A revealed child is only drawn if it can claim a wire into the parent
    // scope, so lifting the box's signal ceiling is what lets the match show.
    if (signalHit || childHit) {
      this.searchSignalLimits.set(scope.path, Infinity);
    }
    if (childHit) {
      this.searchExpanded.add(scope.path);
    }
    // The reveal brings in a child the walk would otherwise not have budgeted
    // for; grant a page of headroom so it is not cut off.
    const budget = this.svc.config.graphMaxNodes;
    this.nodeBudget = Math.max(this.nodeBudget ?? 0, budget + this.searchExpanded.size * budget);
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
  <label><input type="checkbox" id="hierarchy" checked> hierarchy layout</label>
  <span id="stats"></span>
</header>
<svg id="canvas" tabindex="0"></svg>
<footer id="legend">
  <span class="k inst">module group</span>
  <span class="k net">signal</span>
  <span class="k root">graph root</span>
  <span class="k in">input port</span>
  <span class="k out">output port</span>
  <span class="k inout">inout</span>
  <span class="k bad">unresolved</span>
  <span class="hint">chevron folds a module's signals · double-click a header collapses its subtree · a + on the left edge reveals the module above, a + on the right edge the modules below, one level per click</span>
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
  .hint { opacity: .6; }
  .grp { cursor: pointer; }
  .grp .mod { stroke-width: 1.4; }
  .grp text { pointer-events: none; }
  .grp text.chev { pointer-events: all; cursor: pointer; }
  .hit { fill: transparent; }
  .sep { stroke: var(--vscode-panel-border, #454545); stroke-width: 1; opacity: .8; }
  .rsep { stroke: var(--vscode-panel-border, #454545); stroke-width: 1; opacity: .45; }
  .hd { font-size: 11.5px; font-weight: 600; fill: currentColor; }
  .hm { font-size: 10.5px; fill: currentColor; opacity: .6; }
  .sig { font-size: 10.5px; fill: currentColor; }
  .wt { font-size: 9px; fill: currentColor; opacity: .55; }
  .chev { font-size: 11px; fill: currentColor; opacity: .8; }
  .sm { font-size: 18px; font-weight: 600; opacity: .9; }
  .smhit { fill: transparent; pointer-events: all; cursor: pointer; }
  .bsearch { overflow: visible; }
  .boxsearch {
    width: 100%; height: 100%; box-sizing: border-box; padding: 0 4px;
    font-family: inherit; font-size: 10px; line-height: 1;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; outline: none;
  }
  .grp.match > .mod { stroke-width: 2.6; }
  .rowg .mhl { opacity: .5; pointer-events: none; }
  .rowg.match > .sig { font-weight: 700; }
  .edge { fill: none; stroke-width: 1.4; opacity: .55; }
  .edge:hover { opacity: 1; stroke-width: 2; }
  #tip {
    position: fixed; pointer-events: none; padding: 3px 6px; max-width: 420px;
    background: var(--vscode-editorHoverWidget-background, #252526);
    color: var(--vscode-editorHoverWidget-foreground, #fff);
    border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
    border-radius: 3px; display: none; z-index: 10; white-space: pre-wrap;
  }
`;

/**
 * The whole view, as one script. Exported so the test suite can run it against
 * a stub DOM: the webview is the only part of the extension with no other way
 * to check it, and the grouping/anchoring rules below are easy to get subtly
 * wrong.
 */
export const SCRIPT = String.raw`
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
  const cbHier = document.getElementById('hierarchy');
  const stats = document.getElementById('stats');

  let model = null;
  let nodes = [];
  let edges = [];
  // The picture, grouped the way it is drawn: one group per module scope, the
  // instance as the header and the signals the scope declares as rows below it.
  let groups = [];
  // The focus module's hierarchy depth; boxes at depth < rootDepth are its
  // containing chain, boxes below it are revealed children. Every box wears
  // its own left-edge mark for the chain and right-edge mark for its children.
  let rootDepth = 0;
  // node id -> its group, for edge anchoring and drag.
  let gm = new Map();
  // Layout state per group, keyed by scope path. A group is rebuilt from the
  // nodes on every frame, so where it settled (or was dragged to) lives here.
  let gpos = new Map();
  // Groups whose signal rows are folded away. Webview-local: folding hides the
  // rows but keeps the signals in the model, so their edges reroute to the
  // module header instead of disappearing with them.
  let folded = new Set();
  // Instance paths the extension told us are hierarchy-collapsed.
  let collapsed = new Set();
  // '+' probes that found nothing behind them on click: a box whose left
  // probe found no containing module above, or whose right probe found no
  // children below. The '+' stays hidden once probed empty.
  let probedUp = new Set();
  let probedDown = new Set();
  // How many containing modules the extension is currently drawing, and how
  // many more are available above the top one. The chain is hidden by default;
  // the '+' on any box reveals the whole chain at once.
  let ancShown = 0;
  let ancLeft = 0;
  let cappedScopes = new Set(); // group keys the graph cut short
  let pagedScopes = new Set(); // group keys that still have children behind the cut
// How many levels of the root's subtree the extension is currently drawing,
// and how many more are available below the deepest one. The children are
// hidden by default: the plus on the root's right edge walks down one level
// at a time, the minus tucks one level back.
  // deprecated: per-module expansion replaces global counts
  // let descShown = 0;
  // let descLeft = 0;
  let view = { x: 0, y: 0, k: 1 };
  // Whether the user has panned/zoomed/dragged since the last graph, which
  // stops the initial fit-to-view from yanking the graph out from under them.
  var interacted = false;
  let drag = null;
  let highlight = null;
  // Per-module search: the box a query was typed into and the query itself.
  // Only one module is searched at a time - typing in another box moves it.
  let boxSearch = null;
  // What the view already showed when the box search was committed. A box search
  // only ever adds its matches; this set keeps every node that was on screen
  // before from changing, so the result is the old picture plus the results.
  let searchBase = null;
  // The box input the caret was last in, so a redraw can put it back.
  let searchFocus = null;
  var boxSearchTimer = null;
  // Redraws are coalesced into one per frame: a rebuild of the whole graph
  // costs more than a frame, and mousemove fires far more often than the
  // display refreshes.
  var queued = 0;
  function scheduleDraw() {
    if (queued) return;
    queued = requestAnimationFrame(function () { queued = 0; draw(); });
  }
  // Set once the pointer has travelled far enough to count as a drag, so the
  // click that follows a drag does not also open or zoom into the group.
  var dragged = false;
  // Focus on a single click is deferred: a double-click collapses/expands the
  // module instead, and re-rooting the graph first would make that impossible.
  var clickTimer = null;

  const NS = 'http://www.w3.org/2000/svg';
  const el = (name, attrs) => {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  };
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // One module group is a rounded box: a header row for the instance, then one
  // row per signal of its scope. Edges attach to those rows, so a wire lands on
  // the signal it belongs to instead of somewhere on the module outline.
  const HEAD_H = 26, ROW_H = 22, GAP_V = 40, GAP_H = 90, MIN_W = 168, MAX_W = 340;
  // Signals read down the group: inputs first, then the ones that flow both
  // ways, then the outputs a scope drives.
  const DIR_ORDER = { input: 0, inout: 1, output: 2 };

  function labelW(s, fs) { return (s || '').length * fs * 0.62; }
  function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  // The graph itself caps how many signals it sends per scope; the view shows
  // every row it was given. A scope in cappedScopes has more signals behind the
  // cut and earns a ... row that asks for another signal page; a scope in
  // pagedScopes still has children behind the child window and earns a separate
  // "more children" row that asks for the next child page instead. The two
  // controls stay distinct: the ... row is about the module's own signal rows,
  // the more-children row about the boxes below it.
  function visibleNets(g) {
    return g && g.nets ? g.nets : [];
  }
  function hasMoreNets(g) {
    return !!g && cappedScopes.has(g.key);
  }
  function hasMoreChildren(g) {
    return !!g && pagedScopes.has(g.key);
  }

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

  // A per-module search reaches only the module's own signals and its direct
  // child instances - matching by name, never by path, and never down a whole
  // subtree. Searching a module name must not pull in every row whose scope
  // happens to contain that name, nor anything below a grandchild.
  function boxHit(n, q) {
    if (!boxSearch) return false;
    const s = q.toLowerCase();
    if (n.kind === 'net') {
      return scopeOf(n) === boxSearch.key && (n.label || '').toLowerCase().includes(s);
    }
    return isBoxChild(n.path) && ((n.label || '').toLowerCase().includes(s)
      || (n.moduleName || '').toLowerCase().includes(s));
  }

  // The path of a direct child of the searched box, e.g. "top.u_mid" when the
  // search is in "top" (and nothing deeper).
  function isBoxChild(path) {
    const k = boxSearch.key;
    const prefix = k ? k + '.' : '';
    if (path.indexOf(prefix) !== 0) return false;
    const rest = path.slice(prefix.length);
    return rest.length > 0 && rest.indexOf('.') < 0;
  }

  // A node the per-module search matched: kept, and drawn highlighted.
  function isBoxMatch(n) {
    return !!boxSearch && boxHit(n, boxSearch.q);
  }

  function queueBoxSearch() {
    if (boxSearchTimer) clearTimeout(boxSearchTimer);
    boxSearchTimer = setTimeout(function () {
      boxSearchTimer = null;
      vscode.postMessage(boxSearch
        ? { type: 'boxSearch', path: boxSearch.key, query: boxSearch.q }
        : { type: 'boxSearch', path: '', query: '' });
    }, 150);
  }

  // A box search starts on Enter. It never takes anything away: the view as it
  // stands is frozen into searchBase, and the redraw adds only the matches the
  // extension reveals. Clearing the field and pressing Enter puts it back.
  function commitBoxSearch(key, raw) {
    const q = raw.trim();
    const shown = new Set();
    for (const n of visible().n) shown.add(n.id);
    searchBase = searchBase ? new Set([...searchBase, ...shown]) : shown;
    boxSearch = q ? { key: key, q: q } : null;
    if (!boxSearch) searchBase = null;
    searchFocus = { key: key, start: raw.length, end: raw.length };
    queueBoxSearch();
    draw();
  }

  /** Give the caret back to the box input a redraw just rebuilt. */
  function restoreSearchFocus(drawn) {
    if (!searchFocus) return;
    for (const gd of drawn) {
      if (gd.input && gd.g.key === searchFocus.key) {
        if (gd.input.focus) gd.input.focus();
        try {
          gd.input.selectionStart = searchFocus.start;
          gd.input.selectionEnd = searchFocus.end;
        } catch (e) { /* selection is best-effort */ }
        return;
      }
    }
  }

  // A hierarchy-collapsed box hides everything whose path lives inside it: its
  // child instances and the nets of its own scope. Instance paths nest with
  // '.', net paths hang off their scope with '::'.
  function insideCollapsed(path) {
    for (const c of collapsed) {
      if (path === c) continue;
      if (path.startsWith(c + '.') || path.startsWith(c + '::')) return true;
    }
    return false;
  }

  /** The module scope a node belongs to: the instance path, or the net's scope. */
  function scopeOf(n) {
    if (n.kind !== 'net') return n.path;
    const i = n.path.lastIndexOf('::');
    return i < 0 ? '' : n.path.slice(0, i);
  }

  /** Last path segment, for a group whose instance box was filtered away. */
  function scopeLabel(key) {
    if (!key) return 'signals';
    const i = key.lastIndexOf('.');
    return i < 0 ? key : key.slice(i + 1);
  }

  function headerParts(g) {
    if (!g.head) return { title: scopeLabel(g.key), mod: '' };
    return { title: g.head.label, mod: g.head.detail || g.head.moduleName || '' };
  }

  function sizeGroup(g) {
    const p = headerParts(g);
    const vnets = visibleNets(g);
    const show = !folded.has(g.key) && vnets.length > 0;
    let w = labelW(p.mod ? p.title + ' : ' + p.mod : p.title, 11.5) + 44;
    if (show) {
      for (const n of vnets) {
        let rw = labelW(n.label, 10.5) + 40;
        if (n.width && n.width > 1) rw += labelW(n.width + 'b', 9) + 8;
        if (rw > w) w = rw;
      }
    }
    g.w = Math.max(MIN_W, Math.min(MAX_W, Math.ceil(w)));
    const moreRow = !folded.has(g.key) && hasMoreNets(g) ? 1 : 0;
    const childRow = !folded.has(g.key) && hasMoreChildren(g) ? 1 : 0;
    g.h = HEAD_H + (show || childRow ? (vnets.length + moreRow + childRow) * ROW_H + 4 : 0);
  }

  /** Group the visible nodes: every instance box owns the signals of its scope. */
  function buildGroups(ns) {
    const map = new Map();
    const grab = (key) => {
      let g = map.get(key);
      if (!g) { g = { key, head: null, nets: [], depth: 0, w: MIN_W, h: HEAD_H }; map.set(key, g); }
      return g;
    };
    for (const n of ns) {
      if (n.kind === 'net') {
        // Only I/O-facing signals (ports or signals connected to child ports)
        // are shown by default; a box search may also pin one internal signal,
        // so a matched net is drawn even with no direction.
        if ((n.direction !== undefined && n.direction !== null) || isBoxMatch(n)) {
          grab(scopeOf(n)).nets.push(n);
        }
      } else {
        const g = grab(n.path);
        g.head = n;
        g.depth = n.depth;
      }
    }
    const gs = [];
    for (const g of map.values()) {
      if (!g.head) {
        // The instance was pruned away but its signals survived; the group
        // still needs a column, so it takes the deepest signal's.
        for (const n of g.nets) if ((n.depth || 0) > g.depth) g.depth = n.depth || 0;
      }
      g.nets.sort((a, b) => {
        const da = DIR_ORDER[a.direction] == null ? 3 : DIR_ORDER[a.direction];
        const db = DIR_ORDER[b.direction] == null ? 3 : DIR_ORDER[b.direction];
        if (da !== db) return da - db;
        return (a.label || '') < (b.label || '') ? -1 : (a.label || '') > (b.label || '') ? 1 : 0;
      });
      sizeGroup(g);
      gs.push(g);
    }
    // Rows ordered by direction and then name keep each box tidy but ignore
    // what hangs off every row, so the wires between two boxes fan out and
    // cross. Reorder: a row sorts by the mean position (barycenter) of the rows
    // it connects to in other boxes, and we re-run until it stabilises, because
    // moving a row here lets its partners move in their boxes too.
    orderRowsForConnections(gs);
    gm = new Map();
    for (const g of gs) {
      if (g.head) gm.set(g.head.id, g);
      for (const n of g.nets) gm.set(n.id, g);
    }
    return gs;
  }

  /**
   * Align the rows of every box with the boxes they wire into, so the wires
   * between two modules do not criss-cross.
   *
   * A wire joins exactly two rows: the driving net of the parent scope and the
   * same-named port row inside the child. Each row is given the mean y-rank
   * (barycenter) of the rows it shares wires with, and both ends of every wire
   * feed the pair - a child port moves to meet its parent net and the parent
   * net meets it back. Sorting each group's rows by that value, and re-running
   * the sweep until it stabilises, lines related rows up across boxes. Rows
   * with no cross-box wire keep their direction-by-name order, so an isolated
   * signal does not wander off.
   */
  function orderRowsForConnections(gs) {
    // Node id -> the group box holding it. Local to this pass: gm is rebuilt
    // after buildGroups returns, and ordering must not depend on a stale map.
    const byNode = new Map();
    for (const g of gs) {
      if (g.head) byNode.set(g.head.id, g);
      for (const n of g.nets) byNode.set(n.id, g);
    }
    const sweep = () => {
      const rowRank = new Map();
      const refresh = () => {
        rowRank.clear();
        for (const g of gs) { for (let i = 0; i < g.nets.length; i++) rowRank.set(g.nets[i].id, i); }
      };
      refresh();
      // A visible wire joins two rows, one on each box: the driving net of the
      // parent scope and the same-named port row inside the child. Both ends
      // share the pair, so a child port moves to meet its parent net, not just
      // the other way around.
      const links = new Map();
      for (const g of gs) { for (const n of g.nets) links.set(n.id, []); }
      for (const e of edges) {
        if (e.kind !== 'port') continue;
        const a = byNode.get(e.from), b = byNode.get(e.to);
        if (!a || !b || a === b) continue;
        const ra = a.nets.find((n) => n.id === e.from);
        const rb = portRow(b, e);
        if (ra && rb && rb.id !== ra.id) {
          links.get(ra.id).push(rb.id);
          links.get(rb.id).push(ra.id);
        }
      }
      const bary = new Map();
      for (const g of gs) {
        for (const n of g.nets) {
          let sum = 0, count = 0;
          for (const pid of links.get(n.id) || []) {
            const r = rowRank.get(pid);
            if (r != null) { sum += r; count++; }
          }
          bary.set(n.id, count ? sum / count : null);
        }
        g.nets.sort((a, b) => {
          const ba = bary.get(a.id), bb = bary.get(b.id);
          if (ba != null && bb != null && ba !== bb) return ba - bb;
          if (ba != null && bb == null) return -1;
          if (ba == null && bb != null) return 1;
          const da = DIR_ORDER[a.direction] == null ? 3 : DIR_ORDER[a.direction];
          const db = DIR_ORDER[b.direction] == null ? 3 : DIR_ORDER[b.direction];
          if (da !== db) return da - db;
          return (a.label || '') < (b.label || '') ? -1 : (a.label || '') > (b.label || '') ? 1 : 0;
        });
        // The sort just moved this group's rows; later groups must read the
        // new ranks, and the next sweep starts from here too.
        refresh();
      }
    };
    // A handful of sweeps is enough for a layout this small; beyond that the
    // relative order of the connected rows has long settled.
    for (let i = 0; i < 6; i++) sweep();
  }

  function ensurePos(g) {
    let st = gpos.get(g.key);
    if (!st) { st = { x: (g.depth || 0) * 320, y: 0, moved: false, laid: false }; gpos.set(g.key, st); }
    return st;
  }

  /** Park the group's nodes on the group box the layout just placed. */
  function placeGroup(g) {
    const st = ensurePos(g);
    g.x = st.x; g.y = st.y;
    const top = g.y - g.h / 2;
    if (g.head) { g.head.x = g.x; g.head.y = top + HEAD_H / 2; }
    const show = !folded.has(g.key) && g.nets.length > 0;
    const bodyTop = top + HEAD_H + 2;
    const vnets = visibleNets(g);
    const posBase = new Map(vnets.map((n, i) => [n.id, i]));
    for (let i = 0; i < g.nets.length; i++) {
      const n = g.nets[i];
      n.x = g.x;
      const idx = posBase.get(n.id);
      if (idx !== undefined && show) {
        n.y = bodyTop + ROW_H / 2 + idx * ROW_H;
      } else {
        n.y = show ? (bodyTop + ROW_H / 2 + vnets.length * ROW_H) : (top + HEAD_H / 2);
      }
    }
  }

  /** One-hop neighbours of a node id. */
  function nearOf(id) {
    const s = new Set([id]);
    for (const e of model.edges) {
      if (e.from === id) s.add(e.to);
      if (e.to === id) s.add(e.from);
    }
    return s;
  }

  /**
   * Signals belong to their module: any set of kept nodes that touches a group
   * takes the whole group. A search for one signal then shows the module it
   * lives in instead of a bare row floating without its box, and highlighting a
   * module shows all of its signals, not only the wired ones.
   */
  function withGroups(keep) {
    const scopes = new Set();
    for (const n of model.nodes) if (keep.has(n.id)) scopes.add(scopeOf(n));
    const out = new Set(keep);
    for (const n of model.nodes) if (scopes.has(scopeOf(n))) out.add(n.id);
    return out;
  }

  function visible() {
    if (!model) return { n: [], e: [] };
    const q = search.value.trim();
    const bq = boxSearch ? boxSearch.q.trim() : '';
    let keep = new Set();
    if (bq) {
      // The per-module search adds only its results on top of what is already
      // on screen. It never takes a whole group and never drops a node that was
      // shown when the search was committed, so a module search leaves the old
      // picture alone and just brings the matches in.
      if (searchBase) for (const id of searchBase) keep.add(id);
      const heads = new Set();
      let p = boxSearch.key;
      while (p) {
        heads.add(p);
        const i = p.lastIndexOf('.');
        p = i < 0 ? '' : p.slice(0, i);
      }
      for (const n of model.nodes) {
        if (!boxHit(n, bq)) continue;
        keep.add(n.id);
        if (n.kind === 'net') heads.add(scopeOf(n)); else heads.add(n.path);
      }
      for (const n of model.nodes) {
        if (n.kind !== 'net' && heads.has(n.path)) keep.add(n.id);
      }
    } else {
      for (const n of model.nodes) {
        if (matches(n, q)) keep.add(n.id);
      }
      if (q) {
        // keep direct neighbours of a match so the wiring stays visible
        for (const e of model.edges) {
          if (keep.has(e.from)) keep.add(e.to);
          if (keep.has(e.to)) keep.add(e.from);
        }
        keep = withGroups(keep);
      }
    }
    if (cbNeigh.checked && highlight) {
      keep = withGroups(nearOf(highlight));
    }
    if (collapsed.size) {
      for (const n of model.nodes) if (insideCollapsed(n.path)) keep.delete(n.id);
    }
    const ns = model.nodes.filter(n => keep.has(n.id));
    const es = model.edges.filter(e => keep.has(e.from) && keep.has(e.to)
      && (cbAssign.checked || e.kind !== 'net')
      && (cbCont.checked || e.kind !== 'containment'));
    return { n: ns, e: es };
  }

  // Repulsion is only worth computing for boxes that are close together, so the
  // groups are bucketed into a grid and each one only looks at its own cell and
  // the eight around it. That turns the quadratic sweep into roughly linear
  // work and keeps a large graph responsive.
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
            // Groups are boxes, not points: when two of them overlap, add a
            // push proportional to the overlap so they part instead of nesting.
            var ra = Math.sqrt((a.w || 160) * (a.h || 60)) * 0.6;
            var rb = Math.sqrt((b2.w || 160) * (b2.h || 60)) * 0.6;
            if (d < ra + rb) f += (ra + rb - d) * 0.5;
            a.vx += (dx / d) * f; a.vy += (dy / d) * f;
          }
        }
      }
    }
  }

  /**
   * The optional force layout, run over module groups rather than single
   * nodes. Positions are written straight into the per-group layout state, so
   * the relaxation keeps its progress across the frames it is sliced over.
   */
  function runForce(gs, done) {
    var sts = [];
    for (var i = 0; i < gs.length; i++) {
      var st = ensurePos(gs[i]);
      st.w = gs[i].w; st.h = gs[i].h;
      sts.push(st);
    }
    sts.forEach(function (s, i) {
      var a = (i / sts.length) * Math.PI * 2;
      var r = 90 + 55 * Math.sqrt(i);
      s.x = Math.cos(a) * r;
      s.y = Math.sin(a) * r;
      s.vx = 0; s.vy = 0;
      s.seed = i + 1;
    });
    CELL = Math.max(150, Math.min(340, 80 * Math.sqrt(sts.length)));
    var seen = new Set(), links = [];
    for (var i = 0; i < edges.length; i++) {
      var e = edges[i];
      var a = gm.get(e.from), b = gm.get(e.to);
      if (!a || !b || a === b) continue;
      var k = a.key < b.key ? a.key + ' ' + b.key : b.key + ' ' + a.key;
      if (seen.has(k)) continue;
      seen.add(k);
      links.push([gpos.get(a.key), gpos.get(b.key), e.kind === 'containment' ? 0.25 : 1]);
    }
    var iters = sts.length > 120 ? 60 : sts.length > 40 ? 110 : 180;
    var iter = 0;
    function step() {
      var t0 = Date.now();
      while (iter < iters) {
        var cool = 1 - iter / iters;
        repel(sts);
        for (var l = 0; l < links.length; l++) {
          var a = links[l][0], b = links[l][1], w = links[l][2];
          var dx = b.x - a.x, dy = b.y - a.y;
          var d = Math.max(0.01, Math.hypot(dx, dy));
          var f = (d - 220) * 0.05 * w;
          var ux = dx / d * f, uy = dy / d * f;
          a.vx += ux; a.vy += uy; b.vx -= ux; b.vy -= uy;
        }
        for (var i = 0; i < sts.length; i++) {
          var p = sts[i];
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

  /**
   * One column per hierarchy depth, so the wiring reads left to right through
   * the instance tree. A column stacks the module groups of that depth, centred
   * on the column axis; a group the user dragged keeps its dropped position.
   * Deterministic: same graph, same picture.
   */
  function layoutHierarchical(gs) {
    var cols = new Map();
    for (const g of gs) {
      var d = g.depth || 0;
      if (!cols.has(d)) cols.set(d, []);
      cols.get(d).push(g);
    }
    var depths = Array.from(cols.keys()).sort(function (a, b) { return a - b; });
    var x = 0;
    for (var c = 0; c < depths.length; c++) {
      var col = cols.get(depths[c]).sort(function (a, b) {
        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
      });
      var maxW = 0, total = -GAP_V;
      for (var i = 0; i < col.length; i++) {
        if (col[i].w > maxW) maxW = col[i].w;
        total += col[i].h + GAP_V;
      }
      var y = -total / 2;
      for (var i = 0; i < col.length; i++) {
        var g = col[i];
        var st = ensurePos(g);
        if (!st.moved) { st.x = x + maxW / 2; st.y = y + g.h / 2; }
        y += g.h + GAP_V;
      }
      x += maxW + GAP_H;
    }
    settleHeld(gs);
  }

  /**
   * A group the user dragged keeps its dropped spot, so the auto-placed groups
   * have to clear it rather than being stacked as if its slot were still empty.
   * Without this, expanding a box re-lays the column and lands a fresh group on
   * top of the one that was moved aside. Packed top-down then bottom-up so a
   * held box shoves its neighbours both ways and no two boxes overlap.
   */
  function settleHeld(gs) {
    var cols = new Map();
    for (var i = 0; i < gs.length; i++) {
      var d = gs[i].depth || 0;
      var col = cols.get(d);
      if (!col) cols.set(d, col = []);
      col.push(gs[i]);
    }
    cols.forEach(function (col) {
      var held = false;
      for (var h = 0; h < col.length; h++) if (ensurePos(col[h]).moved) { held = true; break; }
      if (!held) return;
      col.sort(function (a, b) { return ensurePos(a).y - ensurePos(b).y; });
      var y = -Infinity;
      for (var i = 0; i < col.length; i++) {
        var g = col[i], st = ensurePos(g);
        if (st.moved) { y = Math.max(y, st.y + g.h / 2); }
        else { st.y = Math.max(st.y, y + GAP_V + g.h / 2); y = st.y + g.h / 2; }
      }
      y = Infinity;
      for (var i = col.length - 1; i >= 0; i--) {
        var g = col[i], st = ensurePos(g);
        if (st.moved) { y = Math.min(y, st.y - g.h / 2); }
        else { st.y = Math.min(st.y, y - GAP_V - g.h / 2); y = st.y - g.h / 2; }
      }
    });
  }

  /**
   * Fold or unfold one module's signal rows. Purely local: the signals stay in
   * the model, so the wiring that used to end on a row ends on the module
   * header instead and nothing silently vanishes.
   */
  function toggleFold(g) {
    if (folded.has(g.key)) folded.delete(g.key);
    else folded.add(g.key);
    draw();
  }

  /**
   * Collapse or expand one hierarchy level. The local set flips immediately so
   * the box reacts on the spot; the extension then rebuilds the model without
   * the hidden subtree and sends the authoritative set back with it.
   */
  function toggleCollapse(n) {
    const had = collapsed.has(n.path);
    if (had) collapsed.delete(n.path);
    else collapsed.add(n.path);
    vscode.postMessage({ type: 'collapse', path: n.path, collapsed: !had });
    scheduleDraw();
  }

  /**
   * Per-module expansion: each module's right-side +/- toggles only its own
   * children. This function remains for compatibility but does nothing.
   */
  function showDescendants(delta) {
    // no-op in per-module mode
  }

  /**
   * Set how many levels of the containing chain are drawn. The '-' on a box
   * whose parent is shown folds the chain back to that box's own level
   * (next = u); the '+' reveals exactly one more parent (next = shown + 1).
   * The extension rebuilds the graph with that many ancestors and sends the
   * authoritative counts back; the local numbers move first so the box reacts
   * on the spot.
   */
  function setAncestors(next) {
    const total = ancShown + ancLeft;
    const n = Math.max(0, Math.min(total, next));
    if (n === ancShown) return;
    ancShown = n;
    ancLeft = total - n;
    vscode.postMessage({ type: 'ancestors', shown: n });
    scheduleDraw();
  }

  /** The row inside an instance's group that names the port the edge connects. */
  function portRow(g, e) {
    if (e.kind !== 'port') return null;
    const names = [];
    if (e.port) names.push(e.port);
    if (e.signal) {
      names.push(e.signal);
      const parts = e.signal.split('.');
      names.push(parts[parts.length - 1]);
    }
    for (const n of g.nets) if (names.indexOf(n.label) >= 0) return n;
    return null;
  }

  /**
   * Where an edge touches its node, on the side of the group box that faces the
   * other end. A signal anchors on the side at the height of its own row; an
   * instance anchors on the row inside it that names the port the edge
   * connects, so a wire reads as signal -> signal across module boxes. Folded
   * rows and edges that name no signal fall back to the module header.
   */
  function anchorOf(n, other, e) {
    const g = gm.get(n.id);
    if (!g) return { x: n.x, y: n.y };
    const og = other ? gm.get(other.id) : null;
    const ocx = og ? og.x : (other ? other.x : g.x + 1);
    const side = ocx > g.x + 0.5 ? 1 : ocx < g.x - 0.5 ? -1 : 1;
    const x = g.x + side * g.w / 2;
    const headerY = g.y - g.h / 2 + HEAD_H / 2;
    if (folded.has(g.key)) return { x: x, y: headerY };
    if (n.kind !== 'net') {
      const row = portRow(g, e);
      return { x: x, y: row ? row.y : headerY };
    }
    return { x: x, y: n.y };
  }

  function curve(pa, pb, sameGroup) {
    const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
    if (sameGroup) {
      // Both ends sit on one box: bow the wire out past its right edge instead
      // of drawing a flat line over the rows.
      const ox = Math.max(pa.x, pb.x) + 26 + Math.abs(pb.y - pa.y) * 0.25;
      return 'M' + pa.x + ',' + pa.y + ' Q' + ox + ',' + my + ' ' + pb.x + ',' + pb.y;
    }
    const nx = -(pb.y - pa.y) * 0.12, ny = (pb.x - pa.x) * 0.12;
    return 'M' + pa.x + ',' + pa.y + ' Q' + (mx + nx) + ',' + (my + ny) + ' ' + pb.x + ',' + pb.y;
  }

  function draw() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!model) return;
    const sel = visible();
    nodes = sel.n; edges = sel.e;
    if (!nodes.length) return;
    groups = buildGroups(nodes);
    // The focus root's hierarchy depth: the containing chain sits above it
    // (up > 0 walking up), while revealed children sit below it (up < 0).
    rootDepth = 0;
    for (const g of groups) {
      if (g.head && g.head.path === model.root) { rootDepth = g.depth || 0; break; }
    }
    if (cbHier.checked) {
      layoutHierarchical(groups);
      if (!interacted) fitView();
    } else if (groups.some(g => !ensurePos(g).laid)) {
      // The layout runs over several frames; render what is settled so far and
      // mark the groups as laid out so a redraw does not restart it.
      runForce(groups, function () { if (!interacted) fitView(); draw(); });
      for (const g of groups) ensurePos(g).laid = 1;
      const pending = el('text', {
        x: 12, y: 24, fill: 'currentColor', opacity: .75, 'font-size': 12,
      });
      pending.textContent = 'laying out ' + groups.length + ' module groups...';
      svg.appendChild(pending);
      return;
    }
    for (const g of groups) placeGroup(g);

    const gRoot = el('g', { transform: 'translate(' + view.x + ',' + view.y + ') scale(' + view.k + ')' });
    svg.appendChild(gRoot);
    const edgeLayer = el('g', {}), boxLayer = el('g', {});
    gRoot.appendChild(edgeLayer); gRoot.appendChild(boxLayer);
    const byId = new Map(nodes.map(n => [n.id, n]));

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
        'stroke-width': e.kind === 'containment' ? 0.9 : 1.4,
      });
      const pa = anchorOf(a, b, e);
      const pb = anchorOf(b, a, e);
      path.setAttribute('d', curve(pa, pb, gm.get(a.id) === gm.get(b.id)));
      path.addEventListener('mouseenter', (ev) => showTip(ev, edgeTip(e)));
      path.addEventListener('mousemove', moveTip);
      path.addEventListener('mouseleave', hideTip);
      path.addEventListener('click', () => {
        if (e.file) vscode.postMessage({ type: 'open', file: e.file, line: e.range ? e.range.start.line : 0, character: e.range ? e.range.start.character : 0 });
      });
      edgeLayer.appendChild(path);
      edgeEls.push({ e, el: path });
    }

    const drawn = [];
    for (const g of groups) {
      const gd = drawGroup(g);
      boxLayer.appendChild(gd.el);
      drawn.push(gd);
    }
    api._els = { groups: drawn, edgeEls };
    restoreSearchFocus(drawn);
  }

  /** A clickable mark that sits on a box edge, outside the box outline. */
  function sideMark(parent, x, y, glyph, tip, onClick, cls) {
    // A transparent rect gives the small glyph a comfortable click target;
    // both carry the edge class so queries still find the text by class.
    const hit = el('rect', { x: x - 11, y: y - 13, width: 22, height: 24, class: 'smhit ' + cls });
    const t = el('text', { x, y, 'text-anchor': 'middle', class: 'chev sm ' + cls });
    t.textContent = glyph;
    for (const node of [hit, t]) {
      node.addEventListener('mousedown', (ev) => ev.stopPropagation());
      node.addEventListener('click', (ev) => { ev.stopPropagation(); onClick(); });
      node.addEventListener('mouseenter', (ev) => showTip(ev, tip));
      node.addEventListener('mousemove', moveTip);
      node.addEventListener('mouseleave', hideTip);
    }
    parent.appendChild(hit);
    parent.appendChild(t);
  }

  /** One module box: header for the instance, one row per signal of its scope. */
  function drawGroup(g) {
    const isFolded = folded.has(g.key);
    const top = g.y - g.h / 2;
    const left = g.x - g.w / 2, right = g.x + g.w / 2;
    const hy = top + HEAD_H / 2;
    const grp = el('g', { class: 'grp' });
    if (g.head && isBoxMatch(g.head)) grp.classList.add('match');
    grp.appendChild(el('rect', {
      x: left, y: top, width: g.w, height: g.h, rx: 6,
      fill: 'var(--vscode-editorWidget-background, #252526)',
      stroke: g.head ? colorFor(g.head) : '#4d9de0',
      class: 'mod',
    }));

    const els = [];
    const headg = el('g', { class: 'headg' });
    const hit = el('rect', { x: left + 1, y: top + 1, width: g.w - 2, height: HEAD_H - 1, rx: 5, class: 'hit' });
    headg.appendChild(hit);
    headg.appendChild(el('line', {
      x1: left, y1: top + HEAD_H, x2: right, y2: top + HEAD_H, class: 'sep',
    }));

    const hasChev = g.nets.length > 0;
    // Only the focus subtree owns the per-module +/- marks: an ancestor box is
    // context, and its own children are not part of this graph.
    const inFocus = !!(g.head && model && (g.head.path === model.root
      || (model.root !== '' && g.head.path.indexOf(model.root + '.') === 0)));
    const hasExpand = !!(g.head && g.head.childCount && inFocus);
    const isExpanded = hasExpand && expanded.has(g.head.path);
    const hasPlus = hasExpand && collapsed.has(g.head.path);
    // Per-module expansion: every module with children can toggle its own subtree.
    const marks = [];
    if (hasChev && !hasPlus) {
      marks.push({
        glyph: isFolded ? '▸' : '▾',
        tip: (isFolded ? 'Show ' : 'Fold ') + g.nets.length + ' signal(s)',
        onClick: () => toggleFold(g),
      });
    }
    if (hasPlus) {
      marks.push({
        glyph: '+',
        tip: 'Subtree collapsed - double-click the header to expand it',
        onClick: null,
      });
    }
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i];
      const t = el('text', { x: left + 13 + i * 17, y: hy + 4, 'text-anchor': 'middle', class: 'chev' });
      t.textContent = m.glyph;
      if (m.onClick) {
        t.addEventListener('mousedown', (ev) => ev.stopPropagation());
        t.addEventListener('click', (ev) => { ev.stopPropagation(); m.onClick(); });
      }
      t.addEventListener('mouseenter', (ev) => showTip(ev, m.tip));
      t.addEventListener('mousemove', moveTip);
      t.addEventListener('mouseleave', hideTip);
      headg.appendChild(t);
    }

    const p = headerParts(g);
    const markW = marks.length ? 9 + marks.length * 17 : 16;
    // The search field sits in the middle of the header; the instance name stays
    // on the left and the module name on the right, exactly as before.
    const inpW = Math.min(112, Math.max(56, Math.round(g.w * 0.4)));
    const inpX = g.x - inpW / 2;
    const roomLeft = inpX - 6;          // right edge of the instance-name area
    const roomRight = inpX + inpW + 6;  // left edge of the module-name area
    const titleX = left + markW;
    const modX = right - 7;
    const leftSpace = Math.max(0, roomLeft - titleX);
    const rightSpace = Math.max(0, modX - roomRight);
    const title = el('text', { x: titleX, y: hy + 4, 'text-anchor': 'start', class: 'hd' });
    title.textContent = truncate(p.title, Math.max(4, Math.floor(leftSpace / 6.6)));
    headg.appendChild(title);
    if (p.mod && rightSpace > 24) {
      const mt = el('text', { x: modX, y: hy + 4, 'text-anchor': 'end', class: 'hm' });
      mt.textContent = truncate(p.mod, Math.max(4, Math.floor(rightSpace / 6)));
      headg.appendChild(mt);
    }
    // The box's own search: type a signal or a direct child-module name and
    // press Enter. The extension reveals the matches among this module's signals
    // and its immediate children, and the redraw adds them without touching what
    // is already on screen. The field sits in the header, centred, so every
    // module can be searched where it stands; focus survives the redraw.
    const fo = el('foreignObject', { x: inpX, y: top + 4, width: inpW, height: HEAD_H - 8, class: 'bsearch' });
    const inp = document.createElement('input');
    inp.setAttribute('type', 'search');
    inp.setAttribute('class', 'boxsearch');
    inp.setAttribute('placeholder', 'find');
    inp.setAttribute('spellcheck', 'false');
    inp.setAttribute('data-key', g.key);
    inp.value = boxSearch && boxSearch.key === g.key ? boxSearch.q : '';
    inp.addEventListener('mousedown', (ev) => ev.stopPropagation());
    inp.addEventListener('click', (ev) => ev.stopPropagation());
    inp.addEventListener('focus', () => {
      searchFocus = { key: g.key, start: inp.selectionStart || 0, end: inp.selectionEnd || 0 };
    });
    inp.addEventListener('input', () => {
      const v = inp.value;
      searchFocus = {
        key: g.key,
        start: inp.selectionStart || v.length,
        end: inp.selectionEnd !== undefined ? inp.selectionEnd : v.length,
      };
    });
    inp.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.keyCode !== 13) return;
      ev.preventDefault();
      commitBoxSearch(g.key, inp.value);
    });
    fo.appendChild(inp);
    headg.appendChild(fo);
    attachHead(hit, g);
    grp.appendChild(headg);
    if (g.head) els.push({ n: g.head, el: headg });

    if (!isFolded) {
      const vnets = visibleNets(g);
      const more = hasMoreNets(g);
      const childMore = hasMoreChildren(g);
      for (let i = 0; i < vnets.length; i++) {
        const n = vnets[i];
        const ry = n.y;
        const rowg = el('g', { class: 'rowg' });
        const hit = isBoxMatch(n);
        if (hit) {
          rowg.classList.add('match');
          rowg.appendChild(el('rect', {
            x: left + 2, y: ry - ROW_H / 2, width: g.w - 4, height: ROW_H, rx: 3, class: 'mhl',
            fill: 'var(--vscode-editor-findMatchHighlightBackground, #613214)',
          }));
        }
        if (i) {
          rowg.appendChild(el('line', {
            x1: left + 10, y1: ry - ROW_H / 2, x2: right - 10, y2: ry - ROW_H / 2, class: 'rsep',
          }));
        }
        rowg.appendChild(el('circle', { cx: left + 14, cy: ry, r: 3.2, fill: colorFor(n) }));
        const t = el('text', { x: left + 25, y: ry + 3.5, 'text-anchor': 'start', class: 'sig' });
        t.textContent = truncate(n.label || '', Math.max(4, Math.floor((g.w - (n.width && n.width > 1 ? 66 : 42)) / 6)));
        rowg.appendChild(t);
        if (n.width && n.width > 1) {
          const wt = el('text', { x: right - 10, y: ry + 3.5, 'text-anchor': 'end', class: 'wt' });
          wt.textContent = n.width + 'b';
          rowg.appendChild(wt);
        }
        const rhit = el('rect', { x: left + 2, y: ry - ROW_H / 2, width: g.w - 4, height: ROW_H, class: 'hit' });
        rowg.appendChild(rhit);
        attachRow(rhit, n, g);
        grp.appendChild(rowg);
        els.push({ n, el: rowg });
      }
      if (more) {
        const ry = top + HEAD_H + 2 + ROW_H / 2 + vnets.length * ROW_H;
        const rowg = el('g', { class: 'rowg' });
        rowg.appendChild(el('line', {
          x1: left + 10, y1: ry - ROW_H / 2, x2: right - 10, y2: ry - ROW_H / 2, class: 'rsep',
        }));
        const t = el('text', { x: left + 14, y: ry + 3.5, 'text-anchor': 'start', class: 'sig' });
        t.textContent = '...';
        t.style.cursor = 'pointer';
        const askMore = () => vscode.postMessage({ type: 'moreSignals', path: g.key });
        t.addEventListener('mousedown', (ev) => ev.stopPropagation());
        t.addEventListener('click', (ev) => { ev.stopPropagation(); askMore(); });
        t.addEventListener('mouseenter', (ev) => showTip(ev, 'Show more signals'));
        t.addEventListener('mousemove', moveTip);
        t.addEventListener('mouseleave', hideTip);
        rowg.appendChild(t);
        const rhit = el('rect', { x: left + 2, y: ry - ROW_H / 2, width: g.w - 4, height: ROW_H, class: 'hit' });
        rhit.style.cursor = 'pointer';
        rhit.addEventListener('mousedown', (ev) => ev.stopPropagation());
        rhit.addEventListener('click', (ev) => { ev.stopPropagation(); askMore(); });
        rowg.appendChild(rhit);
        grp.appendChild(rowg);
      }
      // Children paged behind the child window get their own row, below the
      // signal rows: it asks the extension to reveal the next child page
      // (granting an extra node budget), leaving the signal ... row to its own
      // page of rows.
      if (childMore) {
        const ry = top + HEAD_H + 2 + ROW_H / 2 + (vnets.length + (more ? 1 : 0)) * ROW_H;
        const rowg = el('g', { class: 'rowg' });
        rowg.appendChild(el('line', {
          x1: left + 10, y1: ry - ROW_H / 2, x2: right - 10, y2: ry - ROW_H / 2, class: 'rsep',
        }));
        const t = el('text', { x: left + 14, y: ry + 3.5, 'text-anchor': 'start', class: 'sig' });
        t.textContent = 'more children';
        t.style.cursor = 'pointer';
        const askChildren = () =>
          vscode.postMessage({ type: 'moreSignals', path: g.key, children: true });
        t.addEventListener('mousedown', (ev) => ev.stopPropagation());
        t.addEventListener('click', (ev) => { ev.stopPropagation(); askChildren(); });
        t.addEventListener('mouseenter', (ev) => showTip(ev, 'Show more children'));
        t.addEventListener('mousemove', moveTip);
        t.addEventListener('mouseleave', hideTip);
        rowg.appendChild(t);
        const rhit = el('rect', { x: left + 2, y: ry - ROW_H / 2, width: g.w - 4, height: ROW_H, class: 'hit' });
        rhit.style.cursor = 'pointer';
        rhit.addEventListener('mousedown', (ev) => ev.stopPropagation());
        rhit.addEventListener('click', (ev) => { ev.stopPropagation(); askChildren(); });
        rowg.appendChild(rhit);
        grp.appendChild(rowg);
      }
    }
    // Every box carries a '+' on each edge by default: the left one searches
    // one level upward and reveals the next containing module (or hides the +
    // when no containing module exists above), the right one toggles that
    // box's own children (or hides when there are none). Once revealed, the
    // '-' folds the chain/children back. These land after the header in the
    // DOM so the chevron stays the first 'chev' element a test or query finds.
    // Distance from the focus root, in hierarchy levels: 0 is the root itself,
    // i > 0 are its containing modules, i < 0 are revealed children.
    const up = g.head ? rootDepth - (g.depth || 0) : -1;
    if (g.head) {
      // Left edge - the containing modules above the focus root.
      if (up >= 0 && up < ancShown) {
        sideMark(grp, left - 12, hy + 4, '−', 'Hide the containing modules',
          () => setAncestors(up), 'lm');
      } else if (ancLeft > 0) {
        sideMark(grp, left - 12, hy + 4, '+', 'Show the containing module',
          () => setAncestors(ancShown + 1), 'lm');
      } else if (!probedUp.has(g.head.path)) {
        sideMark(grp, left - 12, hy + 4, '+', 'No containing module above',
          () => { probedUp.add(g.head.path); scheduleDraw(); }, 'lm');
      }
    }
    // Right edge - each module with children toggles only its own subtree; a
    // module without children probes '+' and hides it once nothing was found.
    if (hasExpand) {
      if (isExpanded) {
        sideMark(grp, right + 30, hy + 4, '−', 'Hide child modules',
          () => {
            vscode.postMessage({ type: 'descendants', path: g.head.path, expanded: false });
            expanded.delete(g.head.path);
            scheduleDraw();
          }, 'rm');
      } else {
        sideMark(grp, right + 12, hy + 4, '+',
          g.head.childCount === 1 ? 'Show child module' : 'Show child modules (' + g.head.childCount + ')',
          () => {
            vscode.postMessage({ type: 'descendants', path: g.head.path, expanded: true });
            expanded.add(g.head.path);
            scheduleDraw();
          }, 'rm');
      }
    } else if (g.head && !probedDown.has(g.head.path)) {
      sideMark(grp, right + 12, hy + 4, '+', 'No child modules below',
        () => { probedDown.add(g.head.path); scheduleDraw(); }, 'rm');
    }
    return { el: grp, g, els, input: inp };
  }

  function attachHead(hit, g) {
    hit.addEventListener('mouseenter', (ev) => showTip(ev, nodeTip(g.head || { label: scopeLabel(g.key), path: g.key }, g)));
    hit.addEventListener('mousemove', moveTip);
    hit.addEventListener('mouseleave', hideTip);
    hit.addEventListener('mousedown', (ev) => {
      ev.stopPropagation();
      drag = { key: g.key, ev };
      highlight = g.head ? g.head.id : null;
      dragged = false;
    });
    hit.addEventListener('click', () => {
      if (dragged) { dragged = false; return; }
      if (!g.head) return;
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        clickTimer = null;
        vscode.postMessage({ type: 'focus', path: g.head.path });
      }, 200);
    });
    hit.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      if (g.head && g.head.childCount) toggleCollapse(g.head);
    });
  }

  function attachRow(hit, n, g) {
    hit.addEventListener('mouseenter', (ev) => showTip(ev, nodeTip(n, g)));
    hit.addEventListener('mousemove', moveTip);
    hit.addEventListener('mouseleave', hideTip);
    hit.addEventListener('mousedown', (ev) => {
      ev.stopPropagation();
      drag = { key: g.key, ev };
      highlight = n.id;
      dragged = false;
    });
    hit.addEventListener('click', () => {
      if (dragged) { dragged = false; return; }
      if (n.file) vscode.postMessage({ type: 'open', file: n.file, line: n.range ? n.range.start.line : 0, character: n.range ? n.range.start.character : 0 });
    });
    hit.addEventListener('dblclick', (ev) => { ev.stopPropagation(); });
  }

  const api = { _els: null, redraw: draw };
  // A handle on the rendered model, for the test suite and for poking at a live
  // panel from the devtools console.
  svg.__api = api;

  // The layout is centred on the origin, which maps to the top-left corner of
  // the SVG once translated by the identity view, so half the graph would sit
  // off-screen to the left. After the layout settles, shift and scale the view
  // so the whole graph fills the canvas.
  function fitView() {
    if (!groups.length) return;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i], st = ensurePos(g);
      if (st.x - g.w / 2 < minX) minX = st.x - g.w / 2;
      if (st.x + g.w / 2 > maxX) maxX = st.x + g.w / 2;
      if (st.y - g.h / 2 < minY) minY = st.y - g.h / 2;
      if (st.y + g.h / 2 > maxY) maxY = st.y + g.h / 2;
    }
    var pad = 40;
    var bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
    var w = Math.max(1, svg.clientWidth - pad * 2), h = Math.max(1, svg.clientHeight - pad * 2);
    var k = Math.max(0.15, Math.min(1.2, Math.min(w / bw, h / bh)));
    view.k = k;
    view.x = svg.clientWidth / 2 - (minX + bw / 2) * k;
    view.y = svg.clientHeight / 2 - (minY + bh / 2) * k;
  }

  function nodeTip(n, g) {
    if (!n) return '';
    const lines = [n.label + (n.detail ? '  :  ' + n.detail : '')];
    if (n.path) lines.push(n.path);
    if (n.width) lines.push(n.width + ' bit' + (n.width === 1 ? '' : 's') + (n.direction ? '  ' + n.direction : ''));
    if (n.truncated) lines.push('(subtree not expanded)');
    if (n.unresolved) lines.push('(module not found in the index)');
    if (n.childCount) {
      lines.push(n.childCount + ' child instance(s) - click to focus, double-click to '
        + (collapsed.has(n.path) ? 'expand' : 'collapse'));
    }
    if (g && g.nets.length && n.kind !== 'net') {
      lines.push(g.nets.length + ' signal(s) - use the chevron to '
        + (folded.has(g.key) ? 'show them' : 'fold them'));
    }
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

  // pan / zoom
  svg.addEventListener('mousedown', (ev) => { drag = { pan: true, sx: ev.clientX, sy: ev.clientY, ox: view.x, oy: view.y }; svg.classList.add('dragging'); });
  window.addEventListener('mouseup', () => { drag = null; svg.classList.remove('dragging'); });
  window.addEventListener('mousemove', (ev) => {
    if (!drag) return;
    if (drag.pan) {
      interacted = true;
      view.x = drag.ox + (ev.clientX - drag.sx);
      view.y = drag.oy + (ev.clientY - drag.sy);
      scheduleDraw();
    } else if (drag.key !== undefined) {
      interacted = true;
      var dx = (ev.clientX - drag.ev.clientX) / view.k, dy = (ev.clientY - drag.ev.clientY) / view.k;
      if (Math.abs(ev.clientX - drag.ev.clientX) + Math.abs(ev.clientY - drag.ev.clientY) > 3) dragged = true;
      // Moving a group moves every row in it: the layout state is the only
      // thing that changes, and placeGroup parks the signals back on it.
      var st = gpos.get(drag.key);
      if (st) { st.x += dx; st.y += dy; st.moved = 1; }
      drag.ev = ev;
      scheduleDraw();
    }
  });
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    interacted = true;
    const f = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
    const k = Math.max(0.15, Math.min(4, view.k * f));
    view.x = ev.clientX - (ev.clientX - view.x) * (k / view.k);
    view.y = ev.clientY - (ev.clientY - view.y) * (k / view.k);
    view.k = k;
    scheduleDraw();
  }, { passive: false });
  svg.addEventListener('dblclick', () => { interacted = true; fitView(); draw(); });

  for (const el of [search, cbNeigh, cbCont, cbAssign]) {
    el.addEventListener('input', () => { draw(); });
    el.addEventListener('change', () => { draw(); });
  }

  // The layout mode owns the group positions, so switching it clears whatever
  // the other mode wrote and refits: force -> hierarchy re-columns the groups,
  // hierarchy -> force starts a fresh relaxation instead of freezing the
  // column positions in place.
  cbHier.addEventListener('change', () => {
    for (const st of gpos.values()) { st.laid = false; st.moved = false; }
    interacted = false;
    draw();
  });

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg.type === 'graph') {
      // A new root is a different picture: the box that was searched no longer
      // exists, so drop the per-module search with it.
      if (model && msg.graph && msg.graph.root !== model.root) {
        boxSearch = null;
        searchFocus = null;
        searchBase = null;
      }
      model = msg.graph;
      highlight = null;
      nodes = []; edges = [];
      groups = [];
      // A reveal answer must not yank a view the user is typing in; every other
      // rebuild keeps the fit-to-view.
      if (!boxSearch) interacted = false;
      // The extension owns the collapse set once it has answered; a message
      // without the field (older hosts) keeps whatever we toggled locally.
      if (msg.collapsed !== undefined) collapsed = new Set(msg.collapsed || []);
      expanded = new Set(msg.expanded || []);
      ancShown = Number(msg.ancestorsShown ?? 0) || 0;
      ancLeft = Number(msg.ancestorsLeft ?? 0) || 0;
      cappedScopes = new Set((model && model.cappedScopes) || []);
      pagedScopes = new Set((model && model.pagedScopes) || []);
      // A new model may settle differently under the force layout. The
      // hierarchy layout ignores the flag and re-columns on the next frame,
      // while a group the user dragged keeps its position either way.
      for (const st of gpos.values()) st.laid = false;
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
