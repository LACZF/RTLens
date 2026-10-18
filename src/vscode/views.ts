import * as vscode from 'vscode';

import type { IndexService } from './indexService';
import type { HierarchyNode } from '../core/ast';
import { findByPath, subtree } from '../core/hierarchy';
import { collectProblems, type ProblemKind, type ProblemSeverity } from '../core/problems';

/**
 * Composition view: the instance tree of the selected top module, i.e. the
 * "composition relationship" of already-generated modules.
 */
export class CompositionTreeProvider implements vscode.TreeDataProvider<CompositionItem> {
  private readonly emitter = new vscode.EventEmitter<CompositionItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  /** Top module the tree is showing. */
  private rootModule: string | undefined;
  private cached: HierarchyNode | undefined;
  /**
   * TreeItems are memoised per path: `TreeView.reveal` needs the very object
   * `getTreeItem` handed out, and the item is created from data.
   */
  private readonly rendered = new Map<string, vscode.TreeItem>();
  /**
   * What the tree was auto-rooted to: the configured top list, or the
   * `module@file` in the active editor. Re-rooting only when this changes keeps
   * a cursor move inside one module from rebuilding the tree.
   */
  private autoKey: string | undefined;

  constructor(private readonly svc: IndexService) {
    this.svc.onDidChange(() => {
      if (this.svc.state === 'ready') {
        this.refresh();
      }
    });
    this.svc.onDidChangeState((s) => {
      if (s === 'ready') {
        this.refresh();
      } else if (s === 'idle' || s === 'indexing') {
        this.rendered.clear();
      }
    });
  }

  refresh(): void {
    this.cached = undefined;
    this.rendered.clear();
    this.emitter.fire(undefined);
  }

  /**
   * Point the view at the active editor. With `hdl.connectView.topModules` set
   * the tree stays rooted at that top - the whole design, wherever the cursor
   * is; without it the tree follows the module the cursor sits in, so the view
   * always opens on the design you are reading. A missing editor is fine: a
   * configured top still roots the tree, and without one the last root is kept.
   */
  setContext(file: string | undefined, line: number | undefined): void {
    const tops = this.svc.config.topModules;
    if (tops.length) {
      const key = `top:${tops.join(',')}`;
      if (key === this.autoKey) {
        return;
      }
      const def = tops.map((name) => this.svc.index.resolveModule(name)).find((d) => d !== undefined);
      if (!def) {
        return;
      }
      this.autoKey = key;
      this.setRoot(this.svc.compositionHierarchy(def.name, def.file)?.root, def.name);
      return;
    }
    if (!file) {
      return;
    }
    // A cursor above the first `module` (a licence header, the line the editor
    // opens on) belongs to no module; the file's first module is still the
    // sensible root rather than an empty tree.
    const mod = this.svc.moduleAt(file, line ?? 0) ?? this.svc.index.modulesInFile(file)[0];
    if (!mod) {
      return;
    }
    const key = `${mod.name}@${file}`;
    if (key === this.autoKey) {
      return;
    }
    this.autoKey = key;
    this.setRoot(this.svc.compositionHierarchy(mod.name, file)?.root, mod.name);
  }

  get root(): string | undefined {
    return this.rootModule;
  }

  /**
   * Hierarchy node the tree is currently showing. Commands that work on the
   * selection reuse it, so a path picked in the tree means the same thing to
   * them as it does here.
   */
  get hierarchyRoot(): HierarchyNode | undefined {
    return this.cached;
  }

  /** Expand a hierarchy root produced elsewhere (graph, editor command). */
  setRoot(node: HierarchyNode | undefined, moduleName?: string): void {
    this.cached = node;
    this.rootModule = moduleName ?? node?.moduleName;
    this.rendered.clear();
    this.emitter.fire(undefined);
  }

  getTreeItem(e: CompositionItem): vscode.TreeItem {
    const cached = this.rendered.get(e.node.path);
    if (cached) {
      return cached;
    }
    const item = this.render(e);
    this.rendered.set(e.node.path, item);
    return item;
  }

  /**
   * Return the row for `path`, expanding its ancestors, so the caller can hand
   * it to `TreeView.reveal`.
   */
  modelFor(path: string): CompositionItem | undefined {
    const root = this.cached;
    if (!root) {
      return undefined;
    }
    const node = findByPath(root, path);
    if (!node) {
      return undefined;
    }
    this.emitter.fire(undefined);
    return this.toItem(node, node.path === root.path);
  }

  private render(e: CompositionItem): vscode.TreeItem {
    const collapsible =
      e.childCount > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(e.label, collapsible);
    item.id = `hdl:${e.node.path}`;
    // The counts are part of what makes a row worth reading, so they belong in
    // the description next to the instance/module pair.
    item.description = [e.note, e.badge].filter((part) => part.length > 0).join(' · ');
    item.tooltip = e.tooltip;
    item.contextValue = e.unresolved ? 'hdl.instance.unresolved' : 'hdl.instance';
    item.iconPath = new vscode.ThemeIcon(e.icon);
    if (e.file) {
      item.command = {
        command: 'hdl.connectView.revealInstance',
        title: 'Open',
        arguments: [e],
      };
    }
    return item;
  }

  getChildren(e?: CompositionItem): CompositionItem[] {
    if (!e) {
      if (!this.rootModule) {
        return [];
      }
      const node = this.ensureRoot();
      return node ? [this.toItem(node, true)] : [];
    }
    // Every child is handed out: the tree's own expand/collapse is what pages
    // through a wide module, so nothing sits behind a "load more" row.
    return (e.node.children ?? []).map((c) => this.toItem(c, false));
  }

  getParent(e: CompositionItem): CompositionItem | undefined {
    if (!e.node.parentPath) {
      return undefined;
    }
    const node = this.ensureRoot();
    if (!node) {
      return undefined;
    }
    const found = subtree(node).find((n) => n.path === e.node.parentPath);
    return found ? this.toItem(found, false) : undefined;
  }

  private ensureRoot(): HierarchyNode | undefined {
    if (this.cached) {
      return this.cached;
    }
    if (!this.rootModule) {
      return undefined;
    }
    const res = this.svc.compositionHierarchy(this.rootModule);
    this.cached = res?.root;
    return this.cached;
  }

  private toItem(node: HierarchyNode, isRoot: boolean): CompositionItem {
    const def = this.svc.index.resolveModule(node.moduleName, node.file);
    const childCount = node.children?.length ?? 0;
    const paramCount = node.params ? Object.keys(node.params).length : 0;
    const parts: string[] = [];
    if (childCount) {
      parts.push(`${childCount} child${childCount === 1 ? '' : 'ren'}`);
    }
    if (paramCount) {
      parts.push(`${paramCount} param${paramCount === 1 ? '' : 's'}`);
    }
    if (!def) {
      parts.push('module not found');
    }
    const tooltip = def
      ? `${node.path}
${node.moduleName}${node.file ? `
${this.svc.relFile(node.file)}` : ''}`
      : `Module "${node.moduleName}" was not found in the index.
Path: ${node.path}`;
    return {
      node,
      label: isRoot ? node.moduleName : node.instName,
      note: isRoot ? (node.file ? this.svc.relFile(node.file) : '') : `${node.instName} : ${node.moduleName}`,
      badge: parts.join(' · '),
      icon: def ? 'symbol-module' : 'warning',
      file: node.file,
      childCount,
      unresolved: !def,
      tooltip,
    };
  }
}

/** One row of the composition tree; also the payload of the reveal command. */
export interface CompositionItem {
  node: HierarchyNode;
  label: string;
  /** Secondary text shown after the label. */
  note: string;
  /** Child / parameter counts. */
  badge: string;
  icon: string;
  file: string | undefined;
  childCount: number;
  unresolved: boolean;
  tooltip: string;
}

/** Problems view: unresolved modules, undriven or multiply driven nets. */
export class ProblemsTreeProvider implements vscode.TreeDataProvider<ProblemsItem> {
  private readonly emitter = new vscode.EventEmitter<ProblemsItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private issues: ProblemsItem[] = [];

  constructor(private readonly svc: IndexService) {
    this.svc.onDidChange(() => this.rebuild());
    this.svc.onDidChangeState(() => this.rebuild());
  }

  refresh(): void {
    this.rebuild();
  }

  private rebuild(): void {
    this.issues = collectProblems(this.svc.index).map(
      (p) =>
        new ProblemsItem(
          p.kind,
          p.label,
          p.tooltip,
          p.file,
          p.line,
          p.character,
          p.severity,
          p.moduleName,
        ),
    );
    this.emitter.fire(undefined);
  }

  get count(): number {
    return this.issues.length;
  }

  getTreeItem(e: ProblemsItem): vscode.TreeItem {
    const item = new vscode.TreeItem(e.label ?? e.kind, vscode.TreeItemCollapsibleState.None);
    item.description = e.description;
    item.tooltip = e.tooltip;
    item.contextValue = 'hdl.problem';
    item.iconPath = new vscode.ThemeIcon(
      e.severity === 'error' ? 'error' : 'warning',
      new vscode.ThemeColor(e.severity === 'error' ? 'problemsErrorIcon.foreground' : 'problemsWarningIcon.foreground'),
    );
    // A problem row knows the exact column of the offending name, which the
    // generic reveal command cannot work out.
    item.command = { command: 'hdl.connectView.openProblem', title: 'Open', arguments: [e] };
    return item;
  }

  getChildren(): ProblemsItem[] {
    return this.issues;
  }
}

export class ProblemsItem extends vscode.TreeItem {
  constructor(
    readonly kind: ProblemKind,
    readonly label: string,
    readonly tooltip: string,
    readonly file: string,
    readonly line: number,
    readonly character: number,
    readonly severity: ProblemSeverity,
    /** Module the problem was found in, shown next to the label. */
    readonly description: string = '',
  ) {
    super(label);
  }
}
