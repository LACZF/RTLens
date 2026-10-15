import * as vscode from 'vscode';

import type { IndexService } from './indexService';
import type { HierarchyNode } from '../core/ast';
import { findByPath } from '../core/hierarchy';

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
  private cachedRoot?: HierarchyNode;
  private cachedRootModule?: string;
  private cachedFile?: string;
  private payload: CompPayload = { rootModule: '', rootPath: '', file: '', rows: [] };

  constructor(private readonly svc: IndexService) {
    this.svc.onDidChange(() => this.refresh());
    this.svc.onDidChangeState(() => this.refresh());
  }

  /**
   * Follow the active editor without moving the tree: root at the design top
   * (a configured top, else the top that contains the current module) and keep
   * that root while moving around inside it, revealing and highlighting the row
   * for the module under the cursor.
   */
  setContext(file: string | undefined, line: number | undefined): void {
    const mod = file
      ? this.svc.moduleAt(file, line ?? 0) ?? this.svc.index.modulesInFile(file)[0]
      : undefined;
    const tops = this.svc.config.topModules;
    if (tops.length) {
      const def = tops.map((name) => this.svc.index.resolveModule(name)).find((d) => d !== undefined);
      if (!def) return;
      const root = this.svc.compositionHierarchy(def.name, def.file)?.root;
      if (!root) return;
      this.show(root, mod ? this.locate(root, mod.name) : undefined);
      return;
    }
    if (!file || !mod) return;
    // Already inside the shown design: just move the highlight, no rebuild.
    if (this.cachedRoot) {
      const here = this.locate(this.cachedRoot, mod.name);
      if (here) {
        this.show(this.cachedRoot, here);
        return;
      }
    }
    const design = this.svc.containingDesign(mod.name, file);
    if (design) {
      this.show(design.root, design.node.path);
      return;
    }
    const root = this.svc.compositionHierarchy(mod.name, file)?.root;
    if (!root) return;
    this.show(root, root.path);
  }

  /** Re-root only when the design changed, then reveal + highlight `path`. */
  private show(root: HierarchyNode, path: string | undefined): void {
    const changed = this.cachedRoot?.path !== root.path || this.cachedFile !== root.file;
    this.cachedRoot = root;
    this.cachedRootModule = root.moduleName;
    this.cachedFile = root.file;
    if (changed) {
      this.rebuild();
      this.post();
    }
    void this.view?.webview.postMessage({ type: 'highlightPath', path: path ?? '' });
  }

  /** Path of the first (nearest) row whose module is `name`, root included. */
  private locate(root: HierarchyNode, name: string): string | undefined {
    if (root.moduleName === name) return root.path;
    const queue: HierarchyNode[] = [root];
    while (queue.length) {
      const node = queue.shift()!;
      for (const child of node.children ?? []) {
        if (child.moduleName === name) return child.path;
        queue.push(child);
      }
    }
    return undefined;
  }

  setRoot(node: HierarchyNode | undefined, moduleName?: string): void {
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
    const node = findByPath(root, path);
    if (!node) return undefined;
    this.rebuild();
    this.post();
    const row = this.payload.rows.find((r) => r.path === path);
    return row;
  }

  /** Scroll the webview to `path`, expanding the rows above it. */
  reveal(path: string): void {
    void this.view?.webview.postMessage({ type: 'revealPath', path });
  }

  refresh(): void {
    if (!this.cachedRootModule) return;
    const root = this.cachedRoot;
    this.rebuild(root ? undefined : this.cachedRootModule);
    this.post();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html();
    view.webview.onDidReceiveMessage((msg: { type?: string; path?: string }) => {
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
    this.post();
  }

  private rebuild(rootName?: string): void {
    const root = this.cachedRoot ?? (rootName ? this.svc.compositionHierarchy(rootName)?.root : undefined);
    if (!root) {
      this.payload = { rootModule: this.cachedRootModule ?? '', rootPath: '', file: this.cachedFile ?? '', rows: [] };
      return;
    }
    this.cachedRoot = root;
    const rows: CompRow[] = [];
    const walk = (node: HierarchyNode, depth: number, parentPath: string) => {
      const def = this.svc.index.resolveModule(node.moduleName, node.file);
      const childCount = node.children?.length ?? 0;
      const paramCount = node.params ? Object.keys(node.params).length : 0;
      const parts: string[] = [];
      if (childCount) parts.push(`${childCount} child${childCount === 1 ? '' : 'ren'}`);
      if (paramCount) parts.push(`${paramCount} param${paramCount === 1 ? '' : 's'}`);
      if (!def) parts.push('module not found');
      const isRoot = depth === 0;
      rows.push({
        path: node.path,
        parentPath,
        instName: node.instName,
        moduleName: node.moduleName,
        label: isRoot ? node.moduleName : node.instName,
        note: isRoot ? (node.file ? this.svc.relFile(node.file) : '') : `${node.instName} : ${node.moduleName}`,
        badge: parts.join(' · '),
        icon: def ? 'symbol-module' : 'warning',
        childCount,
        depth,
        file: node.file,
        unresolved: !def,
      });
      for (const c of node.children ?? []) {
        walk(c, depth + 1, node.path);
      }
    };
    walk(root, 0, '');
    this.payload = {
      rootModule: root.moduleName,
      rootPath: root.path,
      file: root.file ?? this.cachedFile ?? '',
      rows,
    };
  }

  private post(): void {
    void this.view?.webview.postMessage({ type: 'rows', ...this.payload });
  }
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
 * rebuild, `{type:'revealPath', path}` to scroll to a row, and
 * `{type:'highlightPath', path}` to mark the current module's row (revealing
 * it); it posts `{type:'open', path}` when a row is clicked.
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
  var lastRoot = '';
  var selected = '';

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
    for (var i = 0; i < rows.length; i++) byPath[rows[i].path] = rows[i];
  }

  function ancestorsCollapsed(row) {
    var p = row.parentPath;
    while (p) {
      if (collapsed[p]) return true;
      var pr = byPath[p];
      p = pr ? pr.parentPath : '';
    }
    return false;
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
    if (collapsed[path]) delete collapsed[path];
    else collapsed[path] = true;
    render();
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

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var m = null;
      if (found) {
        if (!found.keep[r.path]) continue;
        m = found.matched[r.path] || null;
      } else if (ancestorsCollapsed(r)) {
        continue;
      }
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
      selected = m.path || '';
      if (selected) {
        expandAncestors(selected);
        delete collapsed[selected];
      }
      render();
      var mark = els[selected];
      if (mark && mark.scrollIntoView) mark.scrollIntoView({ block: 'center' });
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
