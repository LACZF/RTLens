import * as path from 'node:path';
import * as vscode from 'vscode';

import type { TopoAncestor, TopoChild, ModuleTopology } from '../core/topology';
import { buildModuleTopology } from '../core/topology';
import { renderFrameSvg, type Crumb, type FrameInput, type NavRef, type SignalDisplay } from '../core/topologySvg';
import type { IndexService } from './indexService';
import { topologyOptions } from './topology';

interface FrameState {
  key: string;
  model: ModuleTopology;
  /** Modules above this frame, top first. */
  ancestors: TopoAncestor[];
}

/**
 * Topology panel: one module at a time. It renders the real SVG the exporter
 * writes, so what you see is exactly the file you would save - the only
 * difference is that the panel's links navigate in place instead of opening a
 * definition. Interaction lives here, never in the SVG (an exported file must
 * stay script-free).
 *
 * Navigation is relative to the frame stack: a child box pushes, a breadcrumb
 * pops, and jumping above the frame the panel was opened on rebuilds that
 * ancestor's frame from its definition.
 */
export class TopologyPanel {
  private static current: TopologyPanel | undefined;
  static readonly viewType = 'hdl.connectView.topology';

  private readonly disposables: vscode.Disposable[] = [];
  private stack: FrameState[] = [];
  private signalMode: SignalDisplay = 'all';
  private last?: { input: FrameInput; svg: string };

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly svc: IndexService,
  ) {
    this.panel.webview.html = html();
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg) => void this.onMessage(msg)),
      this.panel.onDidDispose(() => this.dispose()),
      vscode.window.onDidChangeActiveColorTheme(() => void this.render()),
    );
  }

  static show(svc: IndexService, _extensionUri: vscode.Uri, moduleName: string, fromFile?: string): TopologyPanel | undefined {
    const def = svc.index.resolveModule(moduleName, fromFile);
    if (!def) {
      void vscode.window.showErrorMessage(`HDL: cannot find module ${moduleName}.`);
      return undefined;
    }
    const existing = TopologyPanel.current;
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Beside, true);
      existing.open(def.name, def.file);
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      TopologyPanel.viewType,
      `Topology: ${def.name}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
    );
    const p = new TopologyPanel(panel, svc);
    TopologyPanel.current = p;
    p.open(def.name, def.file);
    return p;
  }

  static disposeAll(): void {
    TopologyPanel.current?.panel.dispose();
    TopologyPanel.current = undefined;
  }

  /** Re-root the panel; the signal mode is a viewing preference and survives. */
  private open(moduleName: string, fromFile?: string): void {
    const def = this.svc.index.resolveModule(moduleName, fromFile);
    if (!def) {
      return;
    }
    const model = buildModuleTopology(this.svc.index, def, topologyOptions(this.svc));
    this.stack = [{ key: model.path, model, ancestors: model.ancestors }];
    void this.render();
  }

  private get frame(): FrameState | undefined {
    return this.stack[this.stack.length - 1];
  }

  /** Navigate to a frame key: in-stack, a direct child, or a design ancestor. */
  private navigate(key: string): void {
    const cur = this.frame;
    if (!cur) {
      return;
    }
    const at = this.stack.findIndex((f) => f.key === key);
    if (at >= 0) {
      this.stack.length = at + 1;
      void this.render();
      return;
    }
    const prefix = cur.key + '.';
    if (key.startsWith(prefix)) {
      // The remainder is the child id verbatim - it may itself contain dots
      // when the instance lives in a generate block, so it is never re-split.
      const id = key.slice(prefix.length);
      const child = cur.model.children.find((c) => c.id === id);
      if (child) {
        this.descend(child);
        return;
      }
    }
    const above = cur.ancestors.findIndex((a) => a.path === key);
    if (above >= 0) {
      this.ascend(above);
    }
  }

  private descend(child: TopoChild): void {
    const parent = this.frame;
    if (!parent) {
      return;
    }
    const def = this.svc.index.resolveModule(child.moduleName, child.file);
    if (!def) {
      void vscode.window.showInformationMessage(`HDL: ${child.moduleName} is not in the workspace.`);
      return;
    }
    const key = `${parent.key}.${child.id}`;
    const model = buildModuleTopology(this.svc.index, def, topologyOptions(this.svc));
    const ancestors: TopoAncestor[] = [
      ...parent.ancestors,
      {
        path: parent.key,
        moduleName: parent.model.moduleName,
        file: parent.model.file,
        nameRange: parent.model.nameRange,
        instFile: child.file,
        instRange: child.range,
      },
    ];
    // Trust the walk we just made over the index's own first-parent guess: the
    // picture shows the branch the user clicked down, not another branch.
    model.path = key;
    model.top = ancestors[0]?.moduleName ?? def.name;
    model.ancestors = ancestors;
    this.stack.push({ key, model, ancestors });
    void this.render();
  }

  private ascend(index: number): void {
    const cur = this.frame;
    const target = cur?.ancestors[index];
    if (!target) {
      return;
    }
    const def = this.svc.index.resolveModule(target.moduleName, target.file);
    if (!def) {
      return;
    }
    const model = buildModuleTopology(this.svc.index, def, topologyOptions(this.svc));
    model.path = target.path;
    model.ancestors = model.ancestors.slice(0, index);
    model.top = model.ancestors[0]?.moduleName ?? def.name;
    this.stack = [{ key: target.path, model, ancestors: model.ancestors }];
    void this.render();
  }

  private async onMessage(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== 'object') {
      return;
    }
    const m = msg as { type?: string; key?: string; mode?: SignalDisplay; file?: string; line?: number; character?: number };
    switch (m.type) {
      case 'navigate':
        if (typeof m.key === 'string') {
          this.navigate(m.key);
        }
        return;
      case 'signalMode':
        if (m.mode === 'all' || m.mode === 'hidden' || m.mode === 'bundled') {
          this.signalMode = m.mode;
          await this.render();
        }
        return;
      case 'save':
        await this.save();
        return;
      case 'open':
        if (typeof m.file === 'string') {
          await openAt(m.file, Number(m.line ?? 0), Number(m.character ?? 0));
        }
        return;
      default:
        return;
    }
  }

  private async save(): Promise<void> {
    const cur = this.frame;
    if (!cur || !this.last) {
      return;
    }
    const out = await vscode.window.showSaveDialog({
      title: `HDL: save topology of ${cur.model.moduleName}`,
      defaultUri: vscode.Uri.joinPath(workspaceFolder(), `${cur.model.moduleName}-topology.svg`),
      filters: { 'SVG image': ['svg'] },
      saveLabel: 'Save SVG',
    });
    if (!out) {
      return;
    }
    await vscode.workspace.fs.writeFile(out, Buffer.from(this.last.svg, 'utf8'));
    const pick = await vscode.window.showInformationMessage(`HDL: wrote ${path.basename(out.fsPath)}.`, 'Open');
    if (pick === 'Open') {
      await vscode.env.openExternal(out);
    }
  }

  private async render(): Promise<void> {
    const cur = this.frame;
    if (!cur) {
      return;
    }
    const parent = this.stack.length > 1 ? this.stack[this.stack.length - 2] : undefined;
    const self: NavRef = {
      src: {
        file: cur.model.file,
        line: cur.model.nameRange.start.line,
        character: cur.model.nameRange.start.character,
      },
    };
    const children: Record<string, NavRef> = {};
    for (const child of cur.model.children) {
      if (child.resolved) {
        children[child.id] = { key: `${cur.key}.${child.id}` };
      }
    }
    const crumbs: Crumb[] = [
      ...cur.ancestors.map((a) => ({ label: a.moduleName, ref: { key: a.path } as NavRef })),
      { label: cur.model.moduleName, ref: self },
    ];
    const input: FrameInput = {
      key: cur.key,
      model: cur.model,
      self,
      parent: parent ? { key: parent.key } : undefined,
      top: cur.ancestors.length ? { key: cur.ancestors[0].path } : undefined,
      crumbs,
      children,
    };
    const dark = isDark();
    const frame = renderFrameSvg(input, { signalMode: this.signalMode, dark, padding: 24 });
    this.last = { input, svg: frame.svg };
    this.panel.title = `Topology: ${cur.model.moduleName}`;
    await this.panel.webview.postMessage({
      type: 'frame',
      svg: frame.svg,
      signalMode: this.signalMode,
      meta: `${cur.model.path}  ·  ${path.basename(cur.model.file)}  ·  ${cur.model.children.length} instance${cur.model.children.length === 1 ? '' : 's'}`,
      crumbs: crumbs.map((c) => ({ label: c.label, key: c.ref.key })),
    });
  }

  private dispose(): void {
    TopologyPanel.current = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}

function isDark(): boolean {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
}

function workspaceFolder(): vscode.Uri {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && active.scheme === 'file') {
    return vscode.Uri.joinPath(active, '..');
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.cwd());
}

async function openAt(file: string, line: number, character: number): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const pos = new vscode.Position(Math.max(0, line), Math.max(0, character));
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: false });
}

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0 16px 16px;
  font-family: var(--vscode-font-family, system-ui, sans-serif);
  font-size: 12px;
  color: var(--vscode-foreground, #0f172a);
  background: var(--vscode-editor-background, #fff);
}
header {
  position: sticky; top: 0; z-index: 2;
  display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
  padding: 10px 0 8px;
  background: var(--vscode-editor-background, #fff);
  border-bottom: 1px solid var(--vscode-panel-border, #e2e8f0);
}
#crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; flex: 1 1 240px; min-width: 160px; }
.crumb {
  border: 0; background: none; padding: 3px 6px; border-radius: 4px;
  font: inherit; color: var(--vscode-textLink-foreground, #2563eb); cursor: pointer;
}
.crumb:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.16)); }
.crumb:disabled { color: var(--vscode-foreground, #0f172a); font-weight: 600; cursor: default; background: none; }
.sep { opacity: .5; }
#meta { flex: 1 1 100%; font-size: 11px; opacity: .65; white-space: pre; overflow: hidden; text-overflow: ellipsis; }
#modes { display: inline-flex; border: 1px solid var(--vscode-panel-border, #cbd5e1); border-radius: 6px; overflow: hidden; }
#modes button {
  border: 0; background: none; font: inherit; padding: 4px 9px; cursor: pointer;
  color: var(--vscode-foreground, #0f172a);
}
#modes button + button { border-left: 1px solid var(--vscode-panel-border, #cbd5e1); }
#modes button.on { background: var(--vscode-button-background, #2563eb); color: var(--vscode-button-foreground, #fff); }
#save {
  border: 0; border-radius: 6px; padding: 5px 10px; font: inherit; cursor: pointer;
  background: var(--vscode-button-secondaryBackground, #e2e8f0);
  color: var(--vscode-button-secondaryForeground, #0f172a);
}
#save:hover { background: var(--vscode-button-secondaryHoverBackground, #cbd5e1); }
#stage { padding-top: 12px; overflow: auto; }
#stage svg { max-width: 100%; height: auto; display: block; }
`;

const SCRIPT = `
(function () {
  const vscode = acquireVsCodeApi();
  const stage = document.getElementById('stage');
  const crumbBar = document.getElementById('crumbs');
  const meta = document.getElementById('meta');
  const modes = Array.prototype.slice.call(document.querySelectorAll('[data-mode]'));
  const save = document.getElementById('save');
  let current = 'all';

  function drawCrumbs(items) {
    crumbBar.textContent = '';
    items.forEach(function (c, i) {
      if (i) {
        const sep = document.createElement('span');
        sep.className = 'sep';
        sep.textContent = '\\u203a';
        crumbBar.appendChild(sep);
      }
      const b = document.createElement('button');
      b.className = 'crumb';
      b.textContent = c.label;
      if (c.key) {
        b.title = 'Open ' + c.label;
        b.addEventListener('click', function () {
          vscode.postMessage({ type: 'navigate', key: c.key });
        });
      } else {
        b.disabled = true;
      }
      crumbBar.appendChild(b);
    });
  }

  function paint() {
    modes.forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-mode') === current);
    });
  }

  window.addEventListener('message', function (event) {
    const msg = event.data || {};
    if (msg.type !== 'frame') return;
    stage.innerHTML = msg.svg;
    meta.textContent = msg.meta;
    drawCrumbs(msg.crumbs || []);
    current = msg.signalMode;
    paint();
  });

  stage.addEventListener('click', function (event) {
    const target = event.target;
    if (!target || !target.closest) return;
    const nav = target.closest('[data-nav]');
    if (nav) {
      vscode.postMessage({ type: 'navigate', key: nav.getAttribute('data-nav') });
      return;
    }
    const src = target.closest('[data-src]');
    if (!src) return;
    const value = src.getAttribute('data-src');
    const colon = value.lastIndexOf(':');
    const second = value.lastIndexOf(':', colon - 1);
    if (second <= 0) return;
    vscode.postMessage({
      type: 'open',
      file: value.slice(0, second),
      line: Number(value.slice(second + 1, colon)),
      character: Number(value.slice(colon + 1)),
    });
  });

  // Boxes are focusable links; keyboard users get the same navigation as clicks.
  stage.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target;
    if (!target || !target.closest) return;
    const hit = target.closest('[data-nav],[data-src]');
    if (!hit) return;
    event.preventDefault();
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

  modes.forEach(function (b) {
    b.addEventListener('click', function () {
      current = b.getAttribute('data-mode');
      paint();
      vscode.postMessage({ type: 'signalMode', mode: current });
    });
  });
  save.addEventListener('click', function () {
    vscode.postMessage({ type: 'save' });
  });
})();
`;

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
<title>HDL topology</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <nav id="crumbs" aria-label="Module hierarchy"></nav>
  <div id="modes" role="group" aria-label="Signal display">
    <button type="button" data-mode="all" title="Show every input and output">Signals</button>
    <button type="button" data-mode="hidden" title="Keep only the instance boxes">Hide</button>
    <button type="button" data-mode="bundled" title="Merge inputs, inouts, and outputs into separate buses by direction">Bundle</button>
  </div>
  <button type="button" id="save" title="Write this frame to an SVG file">Save SVG</button>
  <div id="meta"></div>
</header>
<main id="stage"></main>
<script>${SCRIPT}</script>
</body>
</html>`;
}
