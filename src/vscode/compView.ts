import * as path from 'path';
import * as vscode from 'vscode';

import type { IndexService } from './indexService';
import type { HierarchyNode, ModuleDef } from '../core/ast';
import type { Range } from '../core/lexer';
import { childOnPath, findByPath } from '../core/hierarchy';
import { parseSource } from '../core/parser';
import { CompositionStore } from './compositionStore';
import {
  DbCompositionSource,
  IndexCompositionSource,
  type CompositionSource,
} from './compositionSource';

/** Whether `(line, character)` sits inside `range`. */
function inRange(range: Range, line: number, character: number): boolean {
  if (line < range.start.line || line > range.end.line) return false;
  if (line === range.start.line && character < range.start.character) return false;
  if (line === range.end.line && character > range.end.character) return false;
  return true;
}

/** Whether `file` lives under directory `dir` (equal paths are not "under"). */
function isUnder(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
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

/** Rows per `children` message; wider levels are split, and the last chunk (`more: false`) triggers the render. */
const ROW_CHUNK = 2000;

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

/** A parsed filter list: literal module names plus resolved file/directory paths. */
interface CompositionFilter {
  names: Set<string>;
  paths: string[];
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
  /**
   * Whether the webview is actually visible. Activation happens from commands,
   * the status bar, or the activity-bar icon, and the view stays hidden in the
   * first two cases. Parsing the active buffer for an invisible tree is pure
   * extension-host work (a large file can take seconds); remember the context
   * instead and apply it when the user opens the view.
   */
  private visible = false;
  /** Latest editor context seen while hidden, applied on first visibility. */
  private pendingContext?: { file: string | undefined; line: number | undefined; character: number | undefined };
  private source?: CompositionSource;
  private sourceFolder?: string;
  private sourceLimits?: { maxDepth: number; maxInstances: number };
  private cachedRoot?: HierarchyNode;
  private cachedRootModule?: string;
  private cachedFile?: string;
  private payload: CompPayload = { rootModule: '', rootPath: '', file: '', rows: [] };
  /** Levels materialised since the last full post, whose child rows are still owed to the webview. */
  private pending: HierarchyNode[] = [];
  /** The last defined file `setContext` saw: a move to another file is an open (and folds the other branches). */
  private lastContextFile: string | undefined;
  /** Bumped per context request so a slow parse cannot overwrite a newer cursor position. */
  private contextGen = 0;
  /** Parsed modules of the last file, reused across cursor moves. */
  private fileCache?: { file: string; version: number; modules: ModuleDef[] };
  /** Parsed `composition.filterModules`, rebuilt when the config is reread (a fresh array). */
  private filterCache?: { source: string[]; value: CompositionFilter };
  private readonly prompted = new Set<string>();

  constructor(private readonly svc: IndexService) {
    this.svc.onDidChange(() => {
      if (this.svc.state === 'ready' && this.source?.kind === 'index') {
        void this.refresh();
      }
    });
    this.svc.onDidChangeState((s) => {
      if (s === 'ready' && (!this.source || this.source.kind === 'index')) {
        void this.refresh();
      }
    });
  }

  /**
   * Follow the editor, but do not parse while the view is hidden. The extension
   * calls this on activation, cursor moves, and editor switches; `setContext`
   * stays the direct entry point for an already-visible tree.
   *
   * `setContext` alone owns `lastContextFile`: writing it here would make the
   * switch look like a same-file cursor move inside `setContext`, so the fold
   * flag on a file open would never fire on the editor path.
   */
  async followEditor(file: string | undefined, line: number | undefined, character?: number): Promise<void> {
    this.pendingContext = { file, line, character };
    if (this.visible) {
      await this.setContext(file, line, character);
    }
  }

  /**
   * Follow the active editor without moving the tree: root at the design top
   * (a configured top, else the top that contains the current module) and keep
   * that root while moving around inside it, revealing and highlighting the row
   * under the cursor.
   */
  async setContext(file: string | undefined, line: number | undefined, character?: number): Promise<void> {
    const fileOpened = file !== undefined && file !== this.lastContextFile;
    if (file !== undefined) this.lastContextFile = file;
    const gen = ++this.contextGen;
    const mod = file ? await this.moduleAt(file, line ?? 0) : undefined;
    if (gen !== this.contextGen) return;
    await this.ensureSource(file);
    if (gen !== this.contextGen) return;
    await this.prepareFilter();
    if (gen !== this.contextGen) return;
    const source = this.source;
    if (!source) {
      this.clear();
      return;
    }
    const local = mod && line !== undefined ? instanceLocalAt(mod, line, character) : undefined;
    const tops = this.svc.config.topModules;
    if (tops.length) {
      const top = await this.firstTop(tops);
      if (!top || gen !== this.contextGen) return;
      await this.ensureRoot(top, await source.topFile(top));
      if (gen !== this.contextGen) return;
      let modulePath = mod ? this.locateMaterialized(mod.name) : undefined;
      if (mod && file && !modulePath) {
        const design = await source.locate(mod.name, file);
        if (gen !== this.contextGen) return;
        if (design && design.top === top) {
          modulePath = design.path.join('.');
        }
      }
      await this.show(modulePath, local, fileOpened);
      return;
    }
    if (!file || !mod) return;
    const here = this.locateMaterialized(mod.name);
    if (here) {
      await this.show(here, local, fileOpened);
      return;
    }
    const design = await source.locate(mod.name, file);
    if (gen !== this.contextGen) return;
    if (design) {
      await this.ensureRoot(design.top, design.topFile ?? (await source.topFile(design.top)));
      await this.show(design.path.join('.'), local, fileOpened);
      return;
    }
    await this.ensureRoot(mod.name, file);
    await this.show(mod.name, local, fileOpened);
  }

  /** Parse the active file (buffer text when open, disk otherwise) and find the module at `line`. */
  private async moduleAt(file: string, line: number): Promise<ModuleDef | undefined> {
    const modules = await this.fileModules(file);
    let parsed: ModuleDef | undefined;
    if (modules && modules.length) {
      let lo = 0;
      let hi = modules.length - 1;
      let at = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (modules[mid].range.start.line <= line) {
          at = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (at >= 0 && modules[at].range.end.line >= line) {
        parsed = modules[at];
      }
      return parsed ?? modules[0];
    }
    return this.svc.moduleAt(file, line) ?? this.svc.index.modulesInFile(file)[0];
  }

  private async fileModules(file: string): Promise<ModuleDef[] | undefined> {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.fileName === file);
    if (doc) {
      if (this.fileCache?.file === file && this.fileCache.version === doc.version) {
        return this.fileCache.modules;
      }
      const modules = parseSource(file, doc.getText()).modules;
      this.fileCache = { file, version: doc.version, modules };
      return modules;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
      const modules = parseSource(file, Buffer.from(bytes).toString('utf8')).modules;
      this.fileCache = { file, version: -1, modules };
      return modules;
    } catch {
      return undefined;
    }
  }

  private folderFor(file?: string): string | undefined {
    if (file) {
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
      if (folder) {
        return folder.uri.fsPath;
      }
    }
    return (vscode.workspace.workspaceFolders ?? [])[0]?.uri.fsPath;
  }

  private async ensureSource(file?: string): Promise<void> {
    const folder = this.folderFor(file) ?? this.folderFor(undefined);
    if (!folder) {
      this.source = undefined;
      this.sourceFolder = undefined;
      this.sourceLimits = undefined;
      return;
    }
    const limits = {
      maxDepth: this.svc.config.compositionMaxDepth,
      maxInstances: this.svc.config.compositionMaxInstances,
    };
    if (
      this.source &&
      this.sourceFolder === folder &&
      this.sourceLimits?.maxDepth === limits.maxDepth &&
      this.sourceLimits?.maxInstances === limits.maxInstances
    ) {
      return;
    }
    const store = CompositionStore.open(folder);
    this.sourceFolder = folder;
    this.sourceLimits = limits;
    this.filterCache = undefined;
    if (store) {
      this.source = new DbCompositionSource(store, limits);
      return;
    }
    if (this.svc.index.allFiles().length > 0) {
      this.source = new IndexCompositionSource(this.svc, limits);
      return;
    }
    this.source = undefined;
    this.promptBuild(folder);
  }

  private promptBuild(folder: string): void {
    if (this.prompted.has(folder)) {
      return;
    }
    this.prompted.add(folder);
    void vscode.window
      .showInformationMessage(
        'RTLens: no composition database found for this workspace. Build it to enable the composition view.',
        'Build Database',
      )
      .then((pick) => {
        if (pick) {
          void vscode.commands.executeCommand('hdl.connectView.refreshDatabase');
        }
      });
  }

  private async firstTop(tops: readonly string[]): Promise<string | undefined> {
    const source = this.source;
    if (!source) {
      return undefined;
    }
    for (const name of tops) {
      if (await source.hasModule(name)) {
        return name;
      }
    }
    return undefined;
  }

  private locateMaterialized(name: string): string | undefined {
    const root = this.cachedRoot;
    if (!root) return undefined;
    if (root.moduleName === name) return root.path;
    const queue: HierarchyNode[] = [root];
    for (let head = 0; head < queue.length; head++) {
      for (const child of queue[head].children ?? []) {
        if (child.moduleName === name) return child.path;
        queue.push(child);
      }
    }
    return undefined;
  }

  /** Point the tree at a root without moving it; the root level is always loaded. */
  private async ensureRoot(moduleName: string, fromFile?: string): Promise<void> {
    const source = this.source;
    if (!source) {
      return;
    }
    if (this.cachedRoot && this.cachedRootModule === moduleName && this.cachedFile === fromFile) {
      return;
    }
    const root = await source.root(moduleName);
    this.cachedRoot = root;
    this.cachedRootModule = moduleName;
    this.cachedFile = fromFile;
    this.pending = [];
    if (root && !this.dropped(root) && !this.pruned(root)) {
      await source.expand(root);
    }
    this.rebuild();
    this.post();
  }

  /**
   * Reveal and highlight the row for a cursor in `modulePath`, pulling the
   * levels above it (and the instance `local` under it) from the source.
   */
  private async show(modulePath: string | undefined, local: string | undefined, collapseOthers = false): Promise<void> {
    const root = this.cachedRoot;
    if (!root) return;
    const gen = this.contextGen;
    let target = '';
    if (modulePath) {
      await this.materializeTo(modulePath);
      if (gen !== this.contextGen) return;
      if (findByPath(root, modulePath)) {
        target = modulePath;
        if (local) {
          const full = `${modulePath}.${local}`;
          await this.materializeTo(full);
          if (gen !== this.contextGen) return;
          if (findByPath(root, full)) {
            target = full;
          }
        }
      }
    }
    this.flushChildren();
    void this.view?.webview.postMessage({
      type: 'highlightPath',
      path: target,
      ...(collapseOthers && target ? { collapseOthers: true } : {}),
    });
  }

  /** Expand every node on the path down to `target`, one level at a time. */
  private async materializeTo(target: string): Promise<void> {
    const root = this.cachedRoot;
    const source = this.source;
    if (!root || !source) return;
    let node: HierarchyNode | undefined = root;
    while (node && node.path !== target) {
      // A level hidden by the filter is never expanded and never streamed:
      // cursor-follow must not re-materialise a subtree the filter removed.
      if (this.dropped(node) || this.pruned(node)) break;
      if (node.children === undefined) {
        if (this.childCount(node) === 0) break;
        await source.expand(node);
        this.pending.push(node);
      }
      const next = childOnPath(node, target);
      if (!next) break;
      node = next;
    }
  }

  private childCount(node: HierarchyNode): number {
    return node.children !== undefined ? node.children.length : node.childCountHint ?? 0;
  }

  /** Send the child rows of every level materialised since the last flush. */
  private flushChildren(): void {
    if (!this.view || this.pending.length === 0) return;
    const nodes = this.pending;
    this.pending = [];
    for (const node of nodes) {
      this.postChildren(node.path, this.childRows(node));
    }
  }

  /** Stream one level's rows, splitting an oversized level into chunks. */
  private postChildren(parentPath: string, rows: CompRow[]): void {
    if (!this.view) return;
    if (rows.length <= ROW_CHUNK) {
      void this.view.webview.postMessage({ type: 'children', parentPath, rows, more: false });
      return;
    }
    for (let i = 0; i < rows.length; i += ROW_CHUNK) {
      void this.view.webview.postMessage({
        type: i === 0 ? 'children' : 'childrenMore',
        parentPath,
        rows: rows.slice(i, i + ROW_CHUNK),
        more: i + ROW_CHUNK < rows.length,
      });
    }
  }

  async setRoot(node: HierarchyNode | undefined, moduleName?: string): Promise<void> {
    await this.ensureSource(node?.file ?? this.lastContextFile);
    await this.prepareFilter();
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

  async modelFor(path: string): Promise<CompRow | undefined> {
    const root = this.cachedRoot;
    if (!root) return undefined;
    if (!findByPath(root, path)) return undefined;
    await this.materializeTo(path);
    this.rebuild();
    this.post();
    return this.payload.rows.find((r) => r.path === path);
  }

  /** Scroll the webview to `path`, expanding the rows above it. */
  async reveal(path: string): Promise<void> {
    await this.materializeTo(path);
    this.flushChildren();
    void this.view?.webview.postMessage({ type: 'revealPath', path });
  }

  /** Re-root at the first branch of `file` (the reveal-in-composition command). */
  async revealFile(file: string): Promise<void> {
    await this.setContext(file, 0, undefined);
  }

  /**
   * Expand or collapse every row. Expanding materialises the whole design,
   * bounded by the Composition limits.
   */
  async setExpandedAll(expanded: boolean): Promise<void> {
    if (!expanded) {
      void this.view?.webview.postMessage({ type: 'setExpanded', expanded: false });
      return;
    }
    await this.prepareFilter();
    await this.expandAll();
    this.rebuild();
    this.post();
    void this.view?.webview.postMessage({ type: 'setExpanded', expanded: true });
  }

  private async expandAll(): Promise<void> {
    const root = this.cachedRoot;
    const source = this.source;
    if (!root || !source) return;
    const stack: HierarchyNode[] = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (this.dropped(node) || this.pruned(node)) continue;
      if (node.children === undefined && this.childCount(node) > 0) {
        await source.expand(node);
      }
      for (const child of node.children ?? []) {
        stack.push(child);
      }
    }
  }

  /** Re-derive the tree from the current source (index rebuild or DB generation swap). */
  async refresh(): Promise<void> {
    if (!this.cachedRootModule) {
      if (this.view) {
        await this.ready();
      }
      return;
    }
    const expanded = this.cachedRoot ? materializedPaths(this.cachedRoot) : new Set<string>();
    await this.ensureSource(this.cachedFile ?? this.lastContextFile);
    await this.source?.reload();
    await this.prepareFilter();
    const source = this.source;
    if (!source) {
      this.clear();
      return;
    }
    const root = await source.root(this.cachedRootModule);
    this.pending = [];
    if (!root) {
      // A reindex can briefly not know the module: keep the last tree on
      // screen instead of blanking the view during the scan.
      this.rebuild();
      this.post();
      return;
    }
    this.cachedRoot = root;
    if (!this.dropped(root) && !this.pruned(root)) {
      await source.expand(root);
    }
    await this.rematerialize(expanded);
    this.rebuild();
    this.post();
  }

  /** Re-open every previously materialised path on the freshly built root. */
  private async rematerialize(expanded: Set<string>): Promise<void> {
    const root = this.cachedRoot;
    const source = this.source;
    if (!root || !source) return;
    const stack: HierarchyNode[] = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (this.dropped(node) || this.pruned(node)) continue;
      if (node.children === undefined && expanded.has(node.path) && this.childCount(node) > 0) {
        await source.expand(node);
      }
      for (const child of node.children ?? []) {
        stack.push(child);
      }
    }
  }

  private clear(): void {
    this.cachedRoot = undefined;
    this.cachedRootModule = undefined;
    this.cachedFile = undefined;
    this.pending = [];
    this.payload = { rootModule: '', rootPath: '', file: '', rows: [] };
    this.post();
  }

  private async ready(): Promise<void> {
    const pending = this.pendingContext;
    if (pending?.file !== undefined) {
      await this.setContext(pending.file, pending.line, pending.character);
      return;
    }
    if (this.cachedRoot) {
      this.rebuild();
      this.post();
      return;
    }
    await this.ensureSource(this.lastContextFile);
    await this.prepareFilter();
    const source = this.source;
    if (!source) {
      this.rebuild();
      this.post();
      return;
    }
    const top = await source.defaultTop(this.svc.config.topModules);
    if (!top) {
      this.rebuild();
      this.post();
      return;
    }
    await this.ensureRoot(top.name, top.file);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.visible = view.visible;
    view.onDidChangeVisibility?.(() => {
      this.visible = view.visible;
      if (this.visible) {
        const pending = this.pendingContext;
        if (pending?.file !== undefined) {
          void this.setContext(pending.file, pending.line, pending.character);
        }
      }
    });
    view.webview.options = { enableScripts: true };
    view.webview.html = html();
    view.webview.onDidReceiveMessage((msg: { type?: string; path?: string; expanded?: boolean }) => {
      void this.handleMessage(msg);
    });
  }

  private async handleMessage(msg: { type?: string; path?: string; expanded?: boolean }): Promise<void> {
    if (msg?.type === 'ready') {
      await this.ready();
      return;
    }
    if (msg?.type === 'expandState') {
      void vscode.commands.executeCommand('setContext', 'hdl.compositionExpanded', !!msg.expanded);
      return;
    }
    if (msg?.type === 'expand' && msg.path) {
      const node = this.cachedRoot ? findByPath(this.cachedRoot, msg.path) : undefined;
      if (node && this.source && node.children === undefined && this.childCount(node) > 0) {
        await this.source.expand(node);
        this.postChildren(node.path, this.childRows(node));
      }
      return;
    }
    if (msg?.type !== 'open' || !msg.path) {
      return;
    }
    const node = this.cachedRoot ? findByPath(this.cachedRoot, msg.path) : undefined;
    if (!node) {
      return;
    }
    void vscode.commands.executeCommand('hdl.connectView.revealInstance', {
      file: node.file ?? this.cachedFile,
      node,
    });
  }

  /** Flatten the materialised tree into pre-order rows for the webview. */
  private rebuild(): void {
    const root = this.cachedRoot;
    if (!root || this.dropped(root)) {
      this.payload = { rootModule: this.cachedRootModule ?? '', rootPath: '', file: this.cachedFile ?? '', rows: [] };
      this.pending = [];
      return;
    }
    const rows: CompRow[] = [];
    rows.push(this.rowFor(root, true));
    if (root.children !== undefined) {
      this.pushRows(root, rows);
    }
    this.payload = {
      rootModule: root.moduleName,
      rootPath: root.path,
      file: root.file ?? this.cachedFile ?? '',
      rows,
    };
    // A full rebuild posts every materialised level via 'rows'; any levels
    // still queued for incremental 'children' messages would duplicate them.
    this.pending = [];
  }

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

  private childRows(node: HierarchyNode): CompRow[] {
    // An expand may race a config change: a level that is now hidden must not
    // stream its children into the webview.
    if (this.dropped(node) || this.pruned(node)) return [];
    // One level only: the webview splices a 'children' payload directly after
    // its parent row, and a deep cursor-follow flushes one message per
    // materialised level — a whole subtree here would re-splice the deeper
    // rows once per ancestor and draw them duplicated.
    const rows: CompRow[] = [];
    for (const child of node.children ?? []) {
      if (this.dropped(child)) continue;
      rows.push(this.rowFor(child, false));
    }
    return rows;
  }

  /**
   * Resolve filter names before a build so the first paint is already
   * filtered; `compositionFilter` only starts this when a build still races it.
   */
  private async prepareFilter(): Promise<void> {
    const source = this.svc.config.compositionFilterModules;
    if (source.length === 0 || !this.source) return;
    if (this.filterCache && this.filterCache.source === source) return;
    const names = await this.source.knownModules(source);
    this.filterCache = { source, value: this.buildFilter(source, names) };
  }

  /**
   * Parse the configured filter entries. A name wins over a path; the name set
   * arrives from the source asynchronously (one shard lookup per entry) and is
   * resolved once per config array.
   */
  private compositionFilter(): CompositionFilter {
    const source = this.svc.config.compositionFilterModules;
    if (this.filterCache && this.filterCache.source === source) {
      return this.filterCache.value;
    }
    const cache = { source, value: this.buildFilter(source, new Set<string>()) };
    this.filterCache = cache;
    const resolver = this.source;
    if (source.length && resolver) {
      void resolver.knownModules(source).then((names) => {
        if (this.filterCache !== cache) return;
        this.filterCache = { source, value: this.buildFilter(source, names) };
        if (this.cachedRoot) {
          this.rebuild();
          this.post();
        }
      });
    }
    if (this.cachedRoot) {
      this.rebuild();
      this.post();
    }
    return cache.value;
  }

  private buildFilter(source: string[], known: Set<string>): CompositionFilter {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    const names = new Set<string>();
    const paths: string[] = [];
    for (const entry of source) {
      if (known.has(entry)) {
        names.add(entry);
        continue;
      }
      if (path.isAbsolute(entry)) {
        paths.push(path.resolve(entry));
      } else if (roots.length === 0) {
        paths.push(path.resolve(entry));
      } else {
        for (const root of roots) {
          paths.push(path.resolve(root, entry));
        }
      }
    }
    return { names, paths };
  }

  /** Whether `node` is filtered out by name, by its definition file, or by a directory. */
  private filtered(node: HierarchyNode | undefined): boolean {
    if (!node) return false;
    const filter = this.compositionFilter();
    if (filter.names.has(node.moduleName)) return true;
    const file = node.defFile ?? node.file;
    if (!file) return false;
    for (const entry of filter.paths) {
      if (file === entry || isUnder(file, entry)) return true;
    }
    return false;
  }

  /** Mode 2 (hide) drops a filtered instance and everything below it. */
  private dropped(node: HierarchyNode): boolean {
    if (this.svc.config.compositionFilterModules.length === 0) return false;
    if (this.svc.config.compositionFilterMode !== 2) return false;
    return this.filtered(node);
  }

  /** Mode 1 (prune) keeps a filtered instance but hides its whole subtree. */
  private pruned(node: HierarchyNode): boolean {
    if (this.svc.config.compositionFilterModules.length === 0) return false;
    if (this.svc.config.compositionFilterMode !== 1) return false;
    if (!this.filtered(node)) return false;
    return this.directCount(node) > 0;
  }

  private directCount(node: HierarchyNode): number {
    return this.childCount(node);
  }

  private rowFor(node: HierarchyNode, isRoot: boolean): CompRow {
    const unresolved = !!node.unresolved;
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
    if (unresolved) parts.push('module not found');
    if (pruned) parts.push('filtered');
    return {
      path: node.path,
      parentPath: node.parentPath ?? '',
      instName: node.instName,
      moduleName: node.moduleName,
      label: isRoot ? node.moduleName : node.instName,
      note: isRoot ? (node.file ? this.svc.relFile(node.file) : '') : `${node.instName} : ${node.moduleName}`,
      badge: parts.join(' · '),
      icon: unresolved ? 'warning' : 'symbol-module',
      childCount: pruned ? 0 : prospective,
      depth: node.depth,
      file: node.file,
      unresolved,
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
 * rebuild, `{type:'children', parentPath, rows, more}` with one more level the
 * reader opened (a wide level arrives as further `{type:'childrenMore', ...}`
 * chunks until `more` is false), `{type:'revealPath', path}` to scroll to a row,
 * `{type:'highlightPath', path, collapseOthers?}` to mark the current module's
 * row (revealing it; `collapseOthers` from the host on a file open/switch also
 * folds every branch outside that path), and `{type:'setExpanded', expanded}`
 * from the title button to open or
 * fold every row; it posts `{type:'open', path}` when a row is clicked,
 * `{type:'expand', path}` when a row's level is not loaded yet, and
 * `{type:'expandState', expanded}` (true while any branch is open) so the
 * host can swap the title button.
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
  // Last row inserted for a parent, so a streamed level's later chunks (and not
  // just its first) land right after the row already on screen.
  var lastInserted = {};
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
  function foldEveryBranch() {
    collapsed = {};
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].childCount > 0) collapsed[rows[i].path] = true;
    }
  }

  function anyOpen() {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].childCount > 0 && !collapsed[rows[i].path]) return true;
    }
    return false;
  }

  function collapseAll() {
    foldEveryBranch();
    render();
  }

  // A file was opened/switched: the reader's other expanded branches fold,
  // and only the path down to the revealed row stays open.
  function collapseExcept(path) {
    foldEveryBranch();
    expandAncestors(path);
    delete collapsed[path];
  }

  // Tell the host which way the title button should read: a single open branch
  // offers "collapse all"; only a fully folded tree offers "expand all". Only
  // a change is sent: rendering runs on every cursor move, and the state
  // rarely moves.
  function reportExpanded() {
    if (!rows.length) return;
    var expanded = anyOpen();
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
      // A different file just opened: fold every branch except the path down
      // to the revealed row. The stutter guard below must not swallow this -
      // the target can already be selected from an earlier reveal.
      var foldOthers = !!m.collapseOthers && !!next;
      // Cursor moves inside one module fire this repeatedly; if the row is
      // already drawn and marked, redrawing a wide expanded level every time
      // would stutter, so only the scroll is repeated.
      if (next === selected && els[next] && !foldOthers) {
        els[next].scrollIntoView({ block: 'center' });
        return;
      }
      selected = next;
      if (foldOthers) {
        collapseExcept(selected);
      } else if (selected) {
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
    if (m.type === 'children' || m.type === 'childrenMore') {
      // One more level (or one more chunk of it) arrived. Rows are flat
      // pre-order, so a parent's children go right after the parent - or right
      // after the previous chunk of this same level. The final chunk renders;
      // intermediate chunks only grow the list, so a huge level costs one
      // render, not one per chunk.
      var add = m.rows || [];
      if (add.length) {
        var at = -1;
        if (m.type === 'children') {
          for (var ci = 0; ci < rows.length; ci++) {
            if (rows[ci].path === m.parentPath) { at = ci; break; }
          }
        } else {
          var prev = lastInserted[m.parentPath];
          if (prev) {
            for (var pi = 0; pi < rows.length; pi++) {
              if (rows[pi].path === prev) { at = pi; break; }
            }
          }
        }
        if (at >= 0) Array.prototype.splice.apply(rows, [at + 1, 0].concat(add));
        else rows = rows.concat(add);
        for (var ai = 0; ai < add.length; ai++) {
          var ar = add[ai];
          byPath[ar.path] = ar;
          if (ar.childCount > 0) collapsed[ar.path] = true;
        }
        loaded[m.parentPath] = true;
        lastInserted[m.parentPath] = add[add.length - 1].path;
      }
      delete collapsed[m.parentPath];
      if (!m.more) render();
      return;
    }
    if (m.type !== 'rows') return;
    rows = m.rows || [];
    lastInserted = {};
    modEl.textContent = m.rootModule || '';
    fileEl.textContent = m.file || '';
    index();
    // A new root opens on its first level: the root stays expanded (the host
    // already sent its children), while deeper levels stay folded.
    if (m.rootPath !== lastRoot) {
      lastRoot = m.rootPath;
      collapsed = {};
      for (var ri = 0; ri < rows.length; ri++) {
        if (rows[ri].path !== m.rootPath && rows[ri].childCount > 0) collapsed[rows[ri].path] = true;
      }
    }
    render();
  });
  render();
  vscode.postMessage({ type: 'ready' });
})();
`;
