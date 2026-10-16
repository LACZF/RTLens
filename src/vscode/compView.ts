import * as vscode from 'vscode';

import type { IndexService } from './indexService';
import type { HierarchyNode, ModuleDef } from '../core/ast';
import type { Range } from '../core/lexer';
import { childOnPath, findByPath, type HierarchyBuilder } from '../core/hierarchy';

/** Whether `(line, character)` sits inside `range`. */
function inRange(range: Range, line: number, character: number): boolean {
  if (line < range.start.line || line > range.end.line) return false;
  if (line === range.start.line && character < range.start.character) return false;
  if (line === range.end.line && character > range.end.character) return false;
  return true;
}

/**
 * The instance of `mod` the cursor is on, as its hierarchy-path segment
 * (`genPrefix.name`), or `undefined` when the cursor is not on an instantiation.
 *
 * The whole instantiation statement counts, not just its name: the instance
 * name, the instantiated module name, and every port connection
 * (`.busy(busy)`, `.a(operand_a)`) all keep the instance row highlighted.
 * Character precision matters here, so making a selection elsewhere in the
 * module (its declaration, an unrelated wire, an `assign`) leaves the plain
 * module row highlighted. Without a character (line-only callers) no instance
 * is claimed, which keeps those callers on the module row.
 */
function instanceLocalAt(mod: ModuleDef, line: number, character: number | undefined): string | undefined {
  if (character === undefined) return undefined;
  const inst = mod.instances.find((i) => inRange(i.range, line, character));
  if (!inst) return undefined;
  return inst.genPrefix ? `${inst.genPrefix}.${inst.name}` : inst.name;
}

/** Row payload sent to the webview. */
export interface CompRow {
  path: string;
  /** Path of the containing row; empty for the root. */
  parentPath: string;
  instName: string;
  moduleName: string;
  label: string;
  note: string;
  badge: string;
  icon: 'symbol-module' | 'warning';
  childCount: number;
  depth: number;
  file?: string;
  unresolved: boolean;
  /** The subtree was cut off by a limit or a cycle, not a true leaf. */
  truncated: boolean;
}

/** Flattened tree rows with depth, drawn and filtered client-side. */
export interface CompPayload {
  rootModule: string;
  rootPath: string;
  file: string;
  rows: CompRow[];
}

/**
 * Composition view.
 *
 * A native tree cannot host a search box, so this view is a WebviewView: the
 * filter lives in the sidebar itself. Unlike nets (a flat list), the rows keep
 * their hierarchy - each row knows its `depth` and `parentPath` - so the
 * webview can draw disclosure triangles, expand/collapse one level at a time,
 * and, while searching, keep the matches plus the path down to them.
 */
export class CompositionViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  /** Lazy builder for the tree; `cachedRoot`'s levels are pulled through it. */
  private expander?: HierarchyBuilder;
  private cachedRoot?: HierarchyNode;
  private cachedRootModule?: string;
  private cachedFile?: string;
  private payload: CompPayload = { rootModule: '', rootPath: '', file: '', rows: [] };
  /** Levels materialised since the last full post, whose child rows are still owed to the webview. */
  private pending: HierarchyNode[] = [];

  constructor(private readonly svc: IndexService) {
    this.svc.onDidChange(() => this.refresh());
    this.svc.onDidChangeState(() => this.refresh());
  }

  /**
   * Follow the active editor without moving the tree: root at the design top
   * (a configured top, else the top that contains the current module) and keep
   * that root while moving around inside it, revealing and highlighting the row
   * under the cursor.
   *
   * When the cursor sits anywhere on an instantiation - its instance name, the
   * module name being instantiated, or one of the port connections wired to it
   * (`.busy(busy)`) - the row for that *instance* (`u_ctrl`, `u_dpath`) is
   * highlighted; anywhere else in the module the module's own row is.
   */
  setContext(file: string | undefined, line: number | undefined, character?: number): void {
    const mod = file
      ? this.svc.moduleAt(file, line ?? 0) ?? this.svc.index.modulesInFile(file)[0]
      : undefined;
    const local = mod && line !== undefined ? instanceLocalAt(mod, line, character) : undefined;
    const tops = this.svc.config.topModules;
    if (tops.length) {
      const def = tops.map((name) => this.svc.index.resolveModule(name)).find((d) => d !== undefined);
      if (!def) return;
      this.ensureRoot(def.name, def.file);
      // A configured top pins the root; the cursor's module is located inside it
      // only when its own chain ends at that same top.
      let modulePath = mod ? this.locateMaterialized(mod.name) : undefined;
      if (mod && file && !modulePath) {
        const design = this.svc.containingPath(mod.name, file);
        if (design && design.top === def.name) {
          modulePath = design.path;
        }
      }
      this.show(modulePath, local);
      return;
    }
    if (!file || !mod) return;
    // The module is already drawn: move the highlight without a reverse walk.
    const here = this.locateMaterialized(mod.name);
    if (here) {
      this.show(here, local);
      return;
    }
    const design = this.svc.containingPath(mod.name, file);
    if (design) {
      this.ensureRoot(design.top, this.svc.index.resolveModule(design.top)?.file);
      this.show(design.path, local);
      return;
    }
    this.ensureRoot(mod.name, file);
    this.show(mod.name, local);
  }

  /** Path of the first materialised row whose module is `name`, root included. */
  private locateMaterialized(name: string): string | undefined {
    const root = this.cachedRoot;
    if (!root) return undefined;
    if (root.moduleName === name) return root.path;
    // Index-pointer BFS to avoid `queue.shift()`'s O(n): this runs every cursor move.
    const queue: HierarchyNode[] = [root];
    for (let head = 0; head < queue.length; head++) {
      for (const child of queue[head].children ?? []) {
        if (child.moduleName === name) return child.path;
        queue.push(child);
      }
    }
    return undefined;
  }

  /**
   * Point the tree at a root without moving it: only a different design (a new
   * path/file) rebuilds, so moving the cursor inside one design keeps the
   * materialised levels and the reader's collapse state.
   */
  private ensureRoot(moduleName: string, fromFile?: string): void {
    if (this.cachedRoot && this.cachedRootModule === moduleName && this.cachedFile === fromFile) {
      return;
    }
    this.expander = this.svc.compositionExpander();
    this.cachedRoot = this.expander.root(moduleName, fromFile);
    this.cachedRootModule = moduleName;
    this.cachedFile = fromFile;
    this.rebuild();
    this.post();
  }

  /**
   * Reveal and highlight the row for a cursor in `modulePath`, pulling the
   * levels above it (and the instance `local` under it when that is where the
   * cursor sits) from the lazy builder. The host materialises first and streams
   * the new `children` before the highlight, so the webview only ever draws
   * rows it has.
   */
  private show(modulePath: string | undefined, local: string | undefined): void {
    const root = this.cachedRoot;
    if (!root) return;
    let target = '';
    if (modulePath) {
      this.materializeTo(modulePath);
      if (findByPath(root, modulePath)) {
        target = modulePath;
        if (local) {
          const full = `${modulePath}.${local}`;
          this.materializeTo(full);
          if (findByPath(root, full)) {
            target = full;
          }
        }
      }
    }
    this.flushChildren();
    void this.view?.webview.postMessage({ type: 'highlightPath', path: target });
  }

  /**
   * Expand every node on the path down to `target`. Only unexpanded nodes are
   * materialised (one level each); the nodes that gained children are queued so
   * their rows can be streamed to the webview.
   */
  private materializeTo(target: string): void {
    const root = this.cachedRoot;
    const expander = this.expander;
    if (!root || !expander) return;
    let node: HierarchyNode | undefined = root;
    while (node && node.path !== target) {
      if (node.children === undefined) {
        if (expander.childCount(node) === 0) break;
        expander.expandLevel(node);
        this.pending.push(node);
      }
      const next = childOnPath(node, target);
      if (!next) break;
      node = next;
    }
  }

  /** Send the child rows of every level materialised since the last flush. */
  private flushChildren(): void {
    if (!this.view || this.pending.length === 0) return;
    const nodes = this.pending;
    this.pending = [];
    for (const node of nodes) {
      void this.view.webview.postMessage({ type: 'children', parentPath: node.path, rows: this.childRows(node) });
    }
  }

  setRoot(node: HierarchyNode | undefined, moduleName?: string): void {
    // A caller hands us a fully built tree (e.g. reveal in Composition); we keep
    // it whole by handing the builder only the root's identity for later
    // refreshes.
    this.expander = this.svc.compositionExpander();
    this.cachedRoot = node;
    this.cachedRootModule = moduleName ?? node?.moduleName;
    this.cachedFile = node?.file;
    this.rebuild();
    this.post();
  }

  get root(): string | undefined {
    return this.cachedRootModule;
  }

  get hierarchyRoot(): HierarchyNode | undefined {
    return this.cachedRoot;
  }

  modelFor(path: string): CompRow | undefined {
    const root = this.cachedRoot;
    if (!root) return undefined;
    if (!findByPath(root, path)) return undefined;
    this.materializeTo(path);
    this.rebuild();
    this.post();
    const row = this.payload.rows.find((r) => r.path === path);
    return row;
  }

  /** Scroll the webview to `path`, expanding the rows above it. */
  reveal(path: string): void {
    this.materializeTo(path);
    this.flushChildren();
    void this.view?.webview.postMessage({ type: 'revealPath', path });
  }

  /**
   * Expand or collapse every row in the instance hierarchy. Expanding is the
   * host's job (it owns the tree): it materialises the whole design, bounded by
   * the Composition limits, then tells the webview. Collapsing is client-side.
   */
  setExpandedAll(expanded: boolean): void {
    if (!expanded) {
      void this.view?.webview.postMessage({ type: 'setExpanded', expanded: false });
      return;
    }
    this.expandAll();
    this.rebuild();
    this.post();
    void this.view?.webview.postMessage({ type: 'setExpanded', expanded: true });
  }

  /** Materialise every level the limits allow, for Expand all. */
  private expandAll(): void {
    const root = this.cachedRoot;
    const expander = this.expander;
    if (!root || !expander) return;
    const stack: HierarchyNode[] = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.children === undefined && expander.childCount(node) > 0) {
        expander.expandLevel(node);
      }
      for (const child of node.children ?? []) {
        stack.push(child);
      }
    }
  }

  refresh(): void {
    if (!this.cachedRootModule) return;
    // Re-derive the tree from the (possibly reindexed) workspace. Reusing the
    // cached `HierarchyNode` would keep the old children, so a module added
    // since the last build - and everything below it - would never show up.
    // The previously materialised frontier is re-opened so the view does not
    // collapse on every edit.
    const expanded = this.cachedRoot ? materializedPaths(this.cachedRoot) : new Set<string>();
    this.expander = this.svc.compositionExpander();
    this.cachedRoot = this.expander.root(this.cachedRootModule, this.cachedFile);
    if (this.cachedRoot) {
      this.rematerialize(expanded);
    }
    this.rebuild();
    this.post();
  }

  /** Re-open every previously materialised path on the freshly built root. */
  private rematerialize(expanded: Set<string>): void {
    const root = this.cachedRoot;
    const expander = this.expander;
    if (!root || !expander) return;
    const stack: HierarchyNode[] = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.children === undefined && expanded.has(node.path) && expander.childCount(node) > 0) {
        expander.expandLevel(node);
      }
      for (const child of node.children ?? []) {
        stack.push(child);
      }
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html();
    view.webview.onDidReceiveMessage((msg: { type?: string; path?: string; expanded?: boolean }) => {
      // The webview reports whether the whole tree is expanded so the title
      // button can show Expand all or Collapse all.
      if (msg?.type === 'expandState') {
        void vscode.commands.executeCommand('setContext', 'hdl.compositionExpanded', !!msg.expanded);
        return;
      }
      // The webview opens a chevron on a level it has not seen yet: materialise
      // just that one level and stream the child rows back.
      if (msg?.type === 'expand' && msg.path) {
        const node = this.cachedRoot ? findByPath(this.cachedRoot, msg.path) : undefined;
        if (node && this.expander && node.children === undefined && this.expander.childCount(node) > 0) {
          this.expander.expandLevel(node);
          void view.webview.postMessage({ type: 'children', parentPath: node.path, rows: this.childRows(node) });
        }
        return;
      }
      if (msg?.type !== 'open' || !msg.path) {
        return;
      }
      // Resolve the row's own node so the jump lands on the instantiation site
      // (its name range in the parent file), not line 0 of the root file.
      const node = this.cachedRoot ? findByPath(this.cachedRoot, msg.path) : undefined;
      if (!node) {
        return;
      }
      void vscode.commands.executeCommand('hdl.connectView.revealInstance', {
        file: node.file ?? this.cachedFile,
        node,
      });
    });
    this.rebuild();
    this.post();
  }

  /** Flatten the materialised tree into pre-order rows for the webview. */
  private rebuild(): void {
    const root = this.cachedRoot;
    if (!root || this.dropped(root)) {
      this.payload = { rootModule: this.cachedRootModule ?? '', rootPath: '', file: this.cachedFile ?? '', rows: [] };
      return;
    }
    const rows: CompRow[] = [];
    rows.push(this.rowFor(root, true));
    // An unloaded level has no rows below it yet; the webview asks for them.
    if (root.children !== undefined) {
      this.pushRows(root, rows);
    }
    this.payload = {
      rootModule: root.moduleName,
      rootPath: root.path,
      file: root.file ?? this.cachedFile ?? '',
      rows,
    };
  }

  /**
   * Append the materialised subtree under `parent` in pre-order.
   *
   * Iterative on purpose: the Composition tree lifts the depth cap, so a chain
   * of distinct modules must not overflow the call stack. Children are pushed
   * in reverse so the flat rows keep their parent-before-child order.
   */
  private pushRows(parent: HierarchyNode, rows: CompRow[]): void {
    const stack: HierarchyNode[] = [];
    const seed = parent.children ?? [];
    for (let i = seed.length - 1; i >= 0; i--) stack.push(seed[i]);
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (this.dropped(node)) continue;
      rows.push(this.rowFor(node, false));
      if (node.children === undefined || this.pruned(node)) continue;
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
    }
  }

  /** The direct child rows of an expanded node, for a `children` message. */
  private childRows(node: HierarchyNode): CompRow[] {
    const rows: CompRow[] = [];
    this.pushRows(node, rows);
    return rows;
  }

  /** Mode 2 (hide) drops a filtered instance and everything below it. */
  private dropped(node: HierarchyNode): boolean {
    const filter = this.svc.config.compositionFilterModules;
    return filter.length > 0 && this.svc.config.compositionFilterMode === 2 && filter.indexOf(node.moduleName) >= 0;
  }

  /** Mode 1 (prune) keeps a filtered instance but hides its whole subtree. */
  private pruned(node: HierarchyNode): boolean {
    const filter = this.svc.config.compositionFilterModules;
    if (filter.length === 0 || this.svc.config.compositionFilterMode !== 1) return false;
    if (filter.indexOf(node.moduleName) < 0) return false;
    return this.directCount(node) > 0;
  }

  private directCount(node: HierarchyNode): number {
    return node.children !== undefined ? node.children.length : this.expander?.childCount(node) ?? 0;
  }

  private rowFor(node: HierarchyNode, isRoot: boolean): CompRow {
    const def = this.svc.index.resolveModule(node.moduleName, node.file);
    const prospective = this.directCount(node);
    const pruned = this.pruned(node);
    const depthCut =
      node.children === undefined &&
      this.svc.config.compositionMaxDepth > 0 &&
      node.depth >= this.svc.config.compositionMaxDepth;
    const parts: string[] = [];
    if (prospective) parts.push(`${prospective} child${prospective === 1 ? '' : 'ren'}`);
    const paramCount = node.params ? Object.keys(node.params).length : 0;
    if (paramCount) parts.push(`${paramCount} param${paramCount === 1 ? '' : 's'}`);
    if (node.truncated || depthCut) parts.push(node.cycle ? 'cycle' : 'truncated');
    if (!def) parts.push('module not found');
    if (pruned) parts.push('filtered');
    return {
      path: node.path,
      parentPath: node.parentPath ?? '',
      instName: node.instName,
      moduleName: node.moduleName,
      label: isRoot ? node.moduleName : node.instName,
      note: isRoot ? (node.file ? this.svc.relFile(node.file) : '') : `${node.instName} : ${node.moduleName}`,
      badge: parts.join(' · '),
      icon: def ? 'symbol-module' : 'warning',
      childCount: pruned ? 0 : prospective,
      depth: node.depth,
      file: node.file,
      unresolved: !def,
      truncated: !!node.truncated,
    };
  }

  private post(): void {
    this.pending = [];
    void this.view?.webview.postMessage({ type: 'rows', ...this.payload });
  }
}

/** Every path with a materialised level below it (used to preserve the frontier). */
function materializedPaths(root: HierarchyNode): Set<string> {
  const out = new Set<string>();
  const stack: HierarchyNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.children === undefined) continue;
    out.add(node.path);
    for (const child of node.children) stack.push(child);
  }
  return out;
}

function html(): string {
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
<title>HDL composition</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <div class="where"><span id="mod"></span><span id="file"></span></div>
  <input id="q" type="search" placeholder="Filter instances/modules (fuzzy, space separated)" spellcheck="false" autocomplete="off" autofocus>
</header>
<div id="empty" class="empty"></div>
<div id="list" class="list"></div>
<script>${SCRIPT}</script>
</body>
</html>`;
}

const STYLE = `
:root { color-scheme: light dark; }
body { margin:0; font-family:var(--vscode-font-family); font-size:var(--vscode-font-size,13px); color:var(--vscode-foreground); background:transparent; }
header { position:sticky; top:0; padding:6px 8px; background:var(--vscode-sideBar-background,transparent); border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.35)); }
.where { display:flex; justify-content:space-between; gap:8px; margin-bottom:6px; min-height:1em; }
#mod { font-weight:600; }
#file { color:var(--vscode-descriptionForeground); font-size:.9em; }
#q { width:100%; box-sizing:border-box; color:var(--vscode-input-foreground); background:var(--vscode-input-background); border:1px solid var(--vscode-input-border,transparent); padding:3px 6px; }
#q:focus { outline:1px solid var(--vscode-focusBorder); outline-offset:-1px; }
.empty { padding:10px 8px; color:var(--vscode-descriptionForeground); }
.list { padding:2px 0; }
.row { display:flex; align-items:baseline; gap:6px; padding:2px 8px 2px 4px; cursor:pointer; white-space:nowrap; }
.row:hover { background:var(--vscode-list-hoverBackground); }
.row.sel { background:var(--vscode-list-activeSelectionBackground,var(--vscode-list-inactiveSelectionBackground)); color:var(--vscode-list-activeSelectionForeground,var(--vscode-foreground)); }
.row.sel .badge { color:inherit; }
.indent { flex:0 0 auto; }
.tw { flex:0 0 14px; width:14px; text-align:center; color:var(--vscode-icon-foreground,var(--vscode-foreground)); font-size:.75em; user-select:none; }
.tw.leaf { visibility:hidden; }
.nm { flex:0 1 70%; overflow:hidden; text-overflow:ellipsis; }
.nm b { color:var(--vscode-list-highlightForeground,var(--vscode-focusBorder)); font-weight:700; }
.badge { flex:1 1 30%; overflow:hidden; text-overflow:ellipsis; color:var(--vscode-descriptionForeground); font-size:.9em; text-align:right; }
`;

/**
 * The whole webview script, kept as a string so tests can run the real thing
 * against a stub DOM instead of a copy. It expects `#q`, `#mod`, `#file`,
 * `#empty` and `#list`, gets `{type:'rows', rootModule, rootPath, rows}` on a
 * rebuild, `{type:'children', parentPath, rows}` with one more level the reader
 * opened, `{type:'revealPath', path}` to scroll to a row,
 * `{type:'highlightPath', path}` to mark the current module's row (revealing
 * it), and `{type:'setExpanded', expanded}` from the title button to open or
 * fold every row; it posts `{type:'open', path}` when a row is clicked,
 * `{type:'expand', path}` when a row's level is not loaded yet, and
 * `{type:'expandState', expanded}` so the host can swap the title button.
 */
export const SCRIPT = String.raw`
(function () {
  var vscode = acquireVsCodeApi();
  var input = document.getElementById('q');
  var list = document.getElementById('list');
  var empty = document.getElementById('empty');
  var modEl = document.getElementById('mod');
  var fileEl = document.getElementById('file');
  var rows = [];
  var byPath = {};
  var els = {};
  var collapsed = {};
  // Parents whose children have arrived. The host streams deeper levels when a
  // row is opened, so a row can show a disclosure triangle before its children
  // are known; the collapsed set then only switches once the level is loaded.
  var loaded = {};
  var lastRoot = '';
  var selected = '';
  var reportedExpanded;

  // Space-separated fuzzy match: the query is split on whitespace into tokens,
  // each token matches as a subsequence and every token must match. Returns the
  // matched indices and a score that favours contiguous runs and matches at the
  // start of the name (or of a word), or null when any token fails.
  function fuzzy(text, query) {
    var t = text.toLowerCase();
    var q = query.toLowerCase();
    var tokens = q.split(/\s+/);
    var idx = [];
    var ti = 0;
    var streak = 0;
    var score = 0;
    var first = -1;
    for (var k = 0; k < tokens.length; k++) {
      var tok = tokens[k];
      for (var i = 0; i < tok.length; i++) {
        var at = t.indexOf(tok.charAt(i), ti);
        if (at < 0) return null;
        if (first < 0) first = at;
        if (at === ti) { streak += 1; score += 2 + streak; } else { streak = 0; score += 1; }
        if (at === 0 || /[._\s]/.test(text.charAt(at - 1))) score += 3;
        idx.push(at);
        ti = at + 1;
      }
    }
    score -= first * 0.05;
    return { idx: idx, score: score };
  }

  // The name split into plain and highlighted runs.
  function highlight(name, idx) {
    var parts = [];
    var last = 0;
    for (var i = 0; i < idx.length; i++) {
      if (idx[i] > last) parts.push({ text: name.slice(last, idx[i]), hit: false });
      parts.push({ text: name.charAt(idx[i]), hit: true });
      last = idx[i] + 1;
    }
    if (last < name.length) parts.push({ text: name.slice(last), hit: false });
    return parts;
  }

  function appendName(container, text, m) {
    var parts = m ? highlight(text, m.idx) : [{ text: text, hit: false }];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].hit) {
        var b = document.createElement('b');
        b.textContent = parts[i].text;
        container.appendChild(b);
      } else {
        container.appendChild(document.createTextNode(parts[i].text));
      }
    }
  }

  function index() {
    byPath = {};
    loaded = {};
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      byPath[r.path] = r;
      // A parent is loaded as soon as a row under it is present.
      if (r.parentPath) loaded[r.parentPath] = true;
    }
  }

  function expandAncestors(path) {
    var r = byPath[path];
    var p = r ? r.parentPath : '';
    while (p) {
      delete collapsed[p];
      var pr = byPath[p];
      p = pr ? pr.parentPath : '';
    }
  }

  function toggle(path) {
    if (collapsed[path]) {
      // Opening a level the host has not sent yet: ask for it and keep the row
      // folded until its children arrive (the 'children' handler opens it).
      if (!loaded[path]) {
        vscode.postMessage({ type: 'expand', path: path });
        return;
      }
      delete collapsed[path];
    } else {
      collapsed[path] = true;
    }
    render();
  }

  function expandAll() {
    collapsed = {};
    render();
  }

  // Every row with children collapsed means the whole tree is folded, so the
  // title button offers "expand all"; a single open row flips it to "collapse".
  function collapseAll() {
    collapsed = {};
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].childCount > 0) collapsed[rows[i].path] = true;
    }
    render();
  }

  function anyCollapsed() {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].childCount > 0 && collapsed[rows[i].path]) return true;
    }
    return false;
  }

  // Tell the host which way the title button should read. Only a change is
  // sent: rendering runs on every cursor move, and the state rarely moves.
  function reportExpanded() {
    if (!rows.length) return;
    var expanded = !anyCollapsed();
    if (expanded !== reportedExpanded) {
      reportedExpanded = expanded;
      vscode.postMessage({ type: 'expandState', expanded: expanded });
    }
  }

  // Matches plus every ancestor of a match, so the path down to it is walkable.
  function search(query) {
    var matched = {};
    var keep = {};
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var mi = fuzzy(r.instName || '', query);
      var mm = fuzzy(r.moduleName || '', query);
      if (mi || mm) matched[r.path] = { inst: mi, mod: mm };
    }
    for (var path in matched) {
      var cur = path;
      while (cur && !keep[cur]) {
        keep[cur] = true;
        var cr = byPath[cur];
        cur = cr ? cr.parentPath : '';
      }
    }
    return { matched: matched, keep: keep };
  }

  function render() {
    reportExpanded();
    list.textContent = '';
    els = {};
    if (!rows.length) {
      empty.textContent = 'No composition hierarchy';
      empty.style.display = 'block';
      return;
    }
    var query = (input.value || '').trim();
    var found = query ? search(query) : null;
    var shown = 0;
    // Ancestor stack for the collapse test. Rows arrive parent-before-child, so
    // a stack walking down the flat list decides visibility in O(1) per row
    // instead of climbing every row's parent chain - which matters once a wide
    // module puts thousands of rows in the list. hidden is the number of
    // collapsed ancestors currently open, and a row is skipped while it is > 0.
    var stack = [];
    var hidden = 0;

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var m = null;
      var hide = false;
      if (found) {
        if (!found.keep[r.path]) continue;
        m = found.matched[r.path] || null;
      } else {
        while (stack.length && stack[stack.length - 1].p !== r.parentPath) {
          if (stack.pop().c) hidden -= 1;
        }
        hide = hidden > 0;
      }

      if (!hide) {
        shown += 1;

        var el = document.createElement('div');
        el.setAttribute('class', r.path === selected ? 'row sel' : 'row');
        el.setAttribute('title', r.badge);

        var indent = document.createElement('span');
        indent.setAttribute('class', 'indent');
        indent.style.width = (r.depth * 14) + 'px';
        el.appendChild(indent);

        var tw = document.createElement('span');
        tw.setAttribute('class', r.childCount > 0 ? 'tw' : 'tw leaf');
        if (r.childCount > 0) {
          // While searching the tree is forced open so every match is visible.
          tw.textContent = found ? '\u25BC' : (collapsed[r.path] ? '\u25B6' : '\u25BC');
          (function (path) {
            tw.addEventListener('click', function (ev) {
              ev.stopPropagation();
              toggle(path);
            });
          })(r.path);
        }
        el.appendChild(tw);

        var nm = document.createElement('span');
        nm.setAttribute('class', 'nm');
        if (r.depth === 0) {
          appendName(nm, r.moduleName, m ? m.mod : null);
        } else {
          appendName(nm, r.instName, m ? m.inst : null);
          nm.appendChild(document.createTextNode(' : '));
          appendName(nm, r.moduleName, m ? m.mod : null);
        }
        el.appendChild(nm);

        var badge = document.createElement('span');
        badge.setAttribute('class', 'badge');
        badge.textContent = r.badge;
        el.appendChild(badge);

        (function (path) {
          el.addEventListener('click', function () {
            vscode.postMessage({ type: 'open', path: path });
          });
        })(r.path);

        els[r.path] = el;
        list.appendChild(el);
      }

      // Every row joins the stack, hidden or not, so a later sibling still sees
      // its ancestors; a hidden row's own collapse just keeps hidden positive.
      if (!found) {
        var c = collapsed[r.path] ? 1 : 0;
        hidden += c;
        stack.push({ p: r.path, c: c });
      }
    }

    if (!shown) {
      empty.textContent = 'No matches for "' + query + '"';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
  }

  input.addEventListener('input', render);
  input.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { input.value = ''; render(); }
  });
  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (!m) return;
    if (m.type === 'revealPath' && m.path) {
      expandAncestors(m.path);
      delete collapsed[m.path];
      render();
      var target = els[m.path];
      if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center' });
      return;
    }
    if (m.type === 'highlightPath') {
      // The current module's row: mark it, open the path down to it and scroll.
      var next = m.path || '';
      // Cursor moves inside one module fire this repeatedly; if the row is
      // already drawn and marked, redrawing a wide expanded level every time
      // would stutter, so only the scroll is repeated.
      if (next === selected && els[next]) {
        els[next].scrollIntoView({ block: 'center' });
        return;
      }
      selected = next;
      if (selected) {
        expandAncestors(selected);
        delete collapsed[selected];
      }
      render();
      var mark = els[selected];
      if (mark && mark.scrollIntoView) mark.scrollIntoView({ block: 'center' });
      return;
    }
    if (m.type === 'setExpanded') {
      if (m.expanded) expandAll();
      else collapseAll();
      return;
    }
    if (m.type === 'children') {
      // One more level arrived. Rows are flat pre-order, so a parent's children
      // go right after the parent; opening the level reveals them, and each new
      // child starts collapsed so the tree still opens one level at a time.
      var add = m.rows || [];
      if (add.length) {
        var at = -1;
        for (var ci = 0; ci < rows.length; ci++) {
          if (rows[ci].path === m.parentPath) { at = ci; break; }
        }
        if (at >= 0) Array.prototype.splice.apply(rows, [at + 1, 0].concat(add));
        else rows = rows.concat(add);
        for (var ai = 0; ai < add.length; ai++) {
          if (add[ai].childCount > 0) collapsed[add[ai].path] = true;
        }
        index();
      }
      delete collapsed[m.parentPath];
      render();
      return;
    }
    if (m.type !== 'rows') return;
    rows = m.rows || [];
    modEl.textContent = m.rootModule || '';
    fileEl.textContent = m.file || '';
    index();
    // A new root starts fully collapsed: the tree opens one level at a time.
    if (m.rootPath !== lastRoot) {
      lastRoot = m.rootPath;
      collapsed = {};
      for (var ri = 0; ri < rows.length; ri++) {
        if (rows[ri].childCount > 0) collapsed[rows[ri].path] = true;
      }
    }
    render();
  });
  render();
})();
`;
