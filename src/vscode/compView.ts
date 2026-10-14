import * as vscode from 'vscode';

import type { IndexService } from './indexService';
import type { HierarchyNode } from '../core/ast';
import { findByPath } from '../core/hierarchy';

/** Row payload sent to the webview. */
export interface CompRow {
  path: string;
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

/** Flattened tree rows with depth, filtered client-side by the webview. */
export interface CompPayload {
  rootModule: string;
  rootPath: string;
  file: string;
  rows: CompRow[];
}

/**
 * Composition view as a WebviewView so it can host an inline search box.
 * The tree is flattened to rows with depth; the webview renders and fuzzy-filters.
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

  setContext(file: string | undefined, line: number | undefined): void {
    const tops = this.svc.config.topModules;
    if (tops.length) {
      const def = tops.map((name) => this.svc.index.resolveModule(name)).find((d) => d !== undefined);
      if (!def) return;
      const h = this.svc.hierarchy(def.name, def.file);
      const root = h?.root;
      if (!root) return;
      if (this.cachedRootModule === def.name && this.cachedFile === root.file) return;
      this.cachedRootModule = def.name;
      this.cachedFile = root.file;
      this.cachedRoot = root;
      this.rebuild();
      this.post();
      return;
    }
    if (!file) return;
    const mod = this.svc.moduleAt(file, line ?? 0) ?? this.svc.index.modulesInFile(file)[0];
    if (!mod) return;
    const h = this.svc.hierarchy(mod.name, file);
    const root = h?.root;
    if (!root) return;
    if (this.cachedRootModule === mod.name && this.cachedFile === root.file) return;
    this.cachedRootModule = mod.name;
    this.cachedFile = root.file;
    this.cachedRoot = root;
    this.rebuild();
    this.post();
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
      if (msg?.type === 'reveal' && msg.path) {
        void vscode.commands.executeCommand('hdl.connectView.revealInstance', { file: this.cachedFile, path: msg.path });
      }
    });
    this.post();
  }

  private rebuild(rootName?: string): void {
    const root = this.cachedRoot ?? (rootName ? this.svc.hierarchy(rootName)?.root : undefined);
    if (!root) {
      this.payload = { rootModule: this.cachedRootModule ?? '', rootPath: '', file: this.cachedFile ?? '', rows: [] };
      return;
    }
    this.cachedRoot = root;
    const rows: CompRow[] = [];
    const walk = (node: HierarchyNode, depth: number) => {
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
        walk(c, depth + 1);
      }
    };
    walk(root, 0);
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
  <input id="q" type="search" placeholder="Filter instances/modules (fuzzy)" spellcheck="false" autocomplete="off" autofocus>
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
.row { display:flex; align-items:baseline; gap:8px; padding:2px 8px 2px 4px; cursor:pointer; white-space:nowrap; }
.row:hover { background:var(--vscode-list-hoverBackground); }
.nm { flex:0 1 70%; overflow:hidden; text-overflow:ellipsis; }
.nm b { color:var(--vscode-list-highlightForeground,var(--vscode-focusBorder)); font-weight:700; }
.badge { flex:1 1 30%; overflow:hidden; text-overflow:ellipsis; color:var(--vscode-descriptionForeground); font-size:.9em; text-align:right; }
`;

export const SCRIPT = String.raw`
(function () {
  var vscode = acquireVsCodeApi();
  var input = document.getElementById('q');
  var list = document.getElementById('list');
  var empty = document.getElementById('empty');
  var modEl = document.getElementById('mod');
  var fileEl = document.getElementById('file');
  var rows = [];

  function fuzzy(text, query) {
    var t = text.toLowerCase();
    var q = query.toLowerCase();
    var idx = [];
    var ti = 0;
    var streak = 0;
    var score = 0;
    var first = -1;
    for (var i = 0; i < q.length; i++) {
      var at = t.indexOf(q.charAt(i), ti);
      if (at < 0) return null;
      if (first < 0) first = at;
      if (at === ti) { streak += 1; score += 2 + streak; } else { streak = 0; score += 1; }
      if (at === 0 || /[._\s]/.test(text.charAt(at - 1))) score += 3;
      idx.push(at);
      ti = at + 1;
    }
    score -= first * 0.05;
    return { idx: idx, score: score };
  }

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

  function render() {
    var query = (input.value || '').trim();
    var items;
    if (query) {
      items = [];
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var m1 = fuzzy(r.instName, query);
        var m2 = fuzzy(r.moduleName, query);
        if (m1 || m2) items.push({ row: r, m: m1 || m2 });
      }
      items.sort(function (a, b) {
        return b.m.score - a.m.score || a.row.path.localeCompare(b.row.path);
      });
    } else {
      items = rows.map(function (r) { return { row: r, m: null }; });
    }
    list.textContent = '';
    if (!rows.length) {
      empty.textContent = 'No composition hierarchy';
      empty.style.display = 'block';
      return;
    }
    if (!items.length) {
      empty.textContent = 'No matches for "' + query + '"';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    for (var j = 0; j < items.length; j++) {
      var row = items[j].row;
      var el = document.createElement('div');
      el.setAttribute('class', 'row');
      var pad = document.createElement('span');
      pad.textContent = new Array(row.depth + 1).join('  ');
      var nm = document.createElement('span');
      nm.setAttribute('class', 'nm');
      var target = row.depth === 0 ? row.moduleName : (row.instName + ' : ' + row.moduleName);
      var parts = items[j].m ? highlight(target, items[j].m.idx) : [{ text: target, hit: false }];
      for (var k = 0; k < parts.length; k++) {
        if (parts[k].hit) {
          var b = document.createElement('b');
          b.textContent = parts[k].text;
          nm.appendChild(b);
        } else {
          nm.appendChild(document.createTextNode(parts[k].text));
        }
      }
      var badge = document.createElement('span');
      badge.setAttribute('class', 'badge');
      badge.textContent = row.badge;
      el.appendChild(pad);
      el.appendChild(nm);
      el.appendChild(badge);
      (function (path) {
        el.addEventListener('click', function () {
          vscode.postMessage({ type: 'reveal', path: path });
        });
      })(row.path);
      list.appendChild(el);
    }
  }

  input.addEventListener('input', render);
  input.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { input.value = ''; render(); }
  });
  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (!m || m.type !== 'rows') return;
    rows = m.rows || [];
    modEl.textContent = m.rootModule || '';
    fileEl.textContent = m.file || '';
    render();
  });
  render();
})();
`;
