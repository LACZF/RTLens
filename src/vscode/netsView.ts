import * as vscode from 'vscode';

import type { IndexService } from './indexService';
import { netsRows } from '../core/nets';
import type { NetRow } from '../core/nets';

/** What the webview is told to draw: the module, its file and its rows. */
interface NetsPayload {
  module: string;
  file: string;
  rows: NetRow[];
}

/**
 * Nets view.
 *
 * A native tree cannot host a search box, so this view is a WebviewView: the
 * filter lives in the sidebar itself and narrows the list as the user types.
 * The rows are built here (ports first, then nets) and the matching is done in
 * the webview, so no round trip happens per keystroke - the fuzzy matcher
 * treats the query as a subsequence and highlights the letters it matched.
 */
export class NetsViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private file: string | undefined;
  private line: number | undefined;
  private scope: string | undefined;
  /** File the current rows were built for. */
  private shownFile: string | undefined;
  /** Last payload, so a view resolved after being hidden redraws without a rebuild. */
  private payload: NetsPayload = { module: '', file: '', rows: [] };

  constructor(private readonly svc: IndexService) {
    this.svc.onDidChange(() => this.refresh());
  }

  /** Point the view at the module around `line` of `file`. */
  setContext(file: string | undefined, line: number | undefined): void {
    this.file = file;
    this.line = line;
    // Moving the cursor inside the same module must not rebuild the list, but
    // another file with a same-named module must: the rows point at a file and
    // a line, so keeping the old ones would send the user to the wrong place.
    const scope = file === undefined ? undefined : this.svc.moduleAt(file, line ?? 0)?.name;
    if (scope !== this.scope || file !== this.shownFile) {
      this.scope = scope;
      this.shownFile = file;
      this.rebuild();
      this.post();
    }
  }

  /** The index changed: rescan the rows for the same context. */
  refresh(): void {
    this.rebuild();
    this.post();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html();
    view.webview.onDidReceiveMessage((msg: { type?: string; line?: number }) => {
      if (msg?.type === 'open' && typeof msg.line === 'number' && this.shownFile) {
        void vscode.commands.executeCommand('hdl.connectView.revealInstance', {
          file: this.shownFile,
          line: msg.line,
        });
      }
    });
    this.post();
  }

  private rebuild(): void {
    const mod = this.file === undefined || this.line === undefined
      ? undefined
      : this.svc.moduleAt(this.file, this.line);
    this.payload = mod && this.shownFile
      ? {
        module: mod.name,
        file: this.svc.relFile(this.shownFile),
        rows: netsRows(this.svc.index, mod, this.svc.relFile(this.shownFile)),
      }
      : { module: '', file: '', rows: [] };
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
<title>HDL nets</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <div class="where"><span id="mod"></span><span id="file"></span></div>
  <input id="q" type="search" placeholder="Filter signals (fuzzy, space separated)" spellcheck="false" autocomplete="off" autofocus>
</header>
<div id="empty" class="empty"></div>
<div id="list" class="list"></div>
<script>${SCRIPT}</script>
</body>
</html>`;
}

const STYLE = `
:root { color-scheme: light dark; }
body {
  margin: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
  color: var(--vscode-foreground);
  background: transparent;
}
header {
  position: sticky;
  top: 0;
  padding: 6px 8px;
  background: var(--vscode-sideBar-background, transparent);
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
}
.where { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 6px; min-height: 1em; }
#mod { font-weight: 600; }
#file { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
#q {
  width: 100%;
  box-sizing: border-box;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent);
  padding: 3px 6px;
}
#q:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.empty { padding: 10px 8px; color: var(--vscode-descriptionForeground); }
.list { padding: 2px 0; }
.row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 8px;
  cursor: pointer;
  white-space: nowrap;
}
.row:hover { background: var(--vscode-list-hoverBackground); }
.row.port .nm { color: var(--vscode-symbolIcon-fieldForeground, var(--vscode-foreground)); }
.nm { flex: 0 1 70%; overflow: hidden; text-overflow: ellipsis; }
.desc { flex: 1 1 30%; overflow: hidden; text-overflow: ellipsis; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
`;

/**
 * The whole webview script, kept as a string so tests can run the real thing
 * against a stub DOM instead of a copy. It expects `#q`, `#mod`, `#file`,
 * `#empty` and `#list`, gets `{type:'rows',...}` messages and posts
 * `{type:'open', line}` when a row is clicked.
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
  var moduleName = '';

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
        if (at < 0) {
          return null;
        }
        if (first < 0) {
          first = at;
        }
        if (at === ti) {
          streak += 1;
          score += 2 + streak;
        } else {
          streak = 0;
          score += 1;
        }
        if (at === 0 || /[._\s]/.test(text.charAt(at - 1))) {
          score += 3;
        }
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
      if (idx[i] > last) {
        parts.push({ text: name.slice(last, idx[i]), hit: false });
      }
      parts.push({ text: name.charAt(idx[i]), hit: true });
      last = idx[i] + 1;
    }
    if (last < name.length) {
      parts.push({ text: name.slice(last), hit: false });
    }
    return parts;
  }

  function render() {
    var query = (input.value || '').trim();
    var items;
    if (query) {
      items = [];
      for (var i = 0; i < rows.length; i++) {
        var m = fuzzy(rows[i].name, query);
        if (m) {
          items.push({ row: rows[i], m: m });
        }
      }
      items.sort(function (a, b) {
        return b.m.score - a.m.score || a.row.name.localeCompare(b.row.name);
      });
    } else {
      items = rows.map(function (r) { return { row: r, m: null }; });
    }

    list.textContent = '';
    if (!rows.length) {
      empty.textContent = moduleName ? 'No signals in this module' : 'Open a Verilog/SystemVerilog file';
      empty.style.display = 'block';
      return;
    }
    if (!items.length) {
      empty.textContent = 'No signal matches "' + query + '"';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    for (var j = 0; j < items.length; j++) {
      var row = items[j].row;
      var el = document.createElement('div');
      el.setAttribute('class', row.isPort ? 'row port' : 'row');
      el.setAttribute('title', row.tooltip);

      var nm = document.createElement('span');
      nm.setAttribute('class', 'nm');
      var parts = items[j].m ? highlight(row.name, items[j].m.idx) : [{ text: row.name, hit: false }];
      for (var k = 0; k < parts.length; k++) {
        if (parts[k].hit) {
          var b = document.createElement('b');
          b.textContent = parts[k].text;
          nm.appendChild(b);
        } else {
          nm.appendChild(document.createTextNode(parts[k].text));
        }
      }

      var de = document.createElement('span');
      de.setAttribute('class', 'desc');
      de.textContent = row.description;

      el.appendChild(nm);
      el.appendChild(de);
      (function (line) {
        el.addEventListener('click', function () {
          vscode.postMessage({ type: 'open', line: line });
        });
      })(row.line);
      list.appendChild(el);
    }
  }

  input.addEventListener('input', render);
  input.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') {
      input.value = '';
      render();
    }
  });
  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (!m || m.type !== 'rows') {
      return;
    }
    rows = m.rows || [];
    moduleName = m.module || '';
    modEl.textContent = moduleName;
    fileEl.textContent = m.file || '';
    render();
  });
  render();
})();
`;
