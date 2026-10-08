import * as vscode from 'vscode';

import type { IndexService } from './indexService';
import type { HierarchyNode } from '../core/ast';
import { findByPath, subtree } from '../core/hierarchy';
import { describeUse, signalUsage, summariseUse } from '../core/nets';
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

  constructor(private readonly svc: IndexService) {
    this.svc.onDidChange(() => this.refresh());
    this.svc.onDidChangeState(() => this.refresh());
  }

  refresh(): void {
    this.cached = undefined;
    this.rendered.clear();
    this.emitter.fire(undefined);
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
   * Expand every ancestor of `path` and return the matching row, so the caller
   * can hand it to `TreeView.reveal`.
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
      e.childCount > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None;
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
    const res = this.svc.hierarchy(this.rootModule);
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

/** Nets of the module in the active editor: the signals worth looking at. */
export class NetsTreeProvider implements vscode.TreeDataProvider<NetsItem> {
  private readonly emitter = new vscode.EventEmitter<NetsItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private file: string | undefined;
  private line: number | undefined;
  private scope: string | undefined;
  /** File the current rows were built for. */
  private shownFile: string | undefined;

  constructor(private readonly svc: IndexService) {
    this.svc.onDidChange(() => this.refresh());
  }

  /** Point the view at the module around `line` of `file`. */
  setContext(file: string | undefined, line: number | undefined): void {
    this.file = file;
    this.line = line;
    // Moving the cursor inside the same module must not rebuild the tree, but
    // another file with a same-named module must: the rows point at a file and
    // a line, so keeping the old ones would send the user to the wrong place.
    const scope = file === undefined ? undefined : this.svc.moduleAt(file, line ?? 0)?.name;
    if (scope !== this.scope || file !== this.shownFile) {
      this.scope = scope;
      this.shownFile = file;
      this.emitter.fire(undefined);
    }
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(e: NetsItem): vscode.TreeItem {
    const item = new vscode.TreeItem(e.label ?? e.name, vscode.TreeItemCollapsibleState.None);
    item.id = `hdlnet:${e.file}:${e.line}:${e.name}`;
    item.description = e.description;
    item.tooltip = e.tooltip;
    item.contextValue = e.isPort ? 'hdl.port' : 'hdl.net';
    item.iconPath = new vscode.ThemeIcon(e.icon);
    item.command = { command: 'hdl.connectView.revealInstance', title: 'Open', arguments: [e] };
    return item;
  }

  getChildren(e?: NetsItem): NetsItem[] {
    if (e) {
      return [];
    }
    if (!this.file) {
      return [];
    }
    const mod = this.line === undefined ? undefined : this.svc.moduleAt(this.file, this.line);
    if (!mod) {
      return [];
    }
    const index = this.svc.index;
    const usage = signalUsage(index, mod);
    const items: NetsItem[] = [];
    for (const p of mod.ports) {
      const use = usage.get(p.name);
      // A port is unused only when nothing in the module touches it: an output
      // that an `assign` drives is used even though no instance reads it here.
      const summary = summariseUse(use);
      items.push(
        new NetsItem(
          this.file,
          p.nameRange.start.line,
          p.name,
          `${p.direction} · ${summary}`,
          `port ${p.name}\n${this.svc.relFile(this.file)}:${p.nameRange.start.line + 1}`,
          'symbol-field',
          true,
        ),
      );
    }
    for (const d of mod.decls) {
      if (d.kind === 'typedef' || d.kind === 'genvar') {
        continue;
      }
      items.push(
        new NetsItem(
          this.file,
          d.nameRange.start.line,
          d.name,
          describeUse(d.kind, usage.get(d.name)),
          `${d.name} (${d.kind})\n${this.svc.relFile(this.file)}:${d.nameRange.start.line + 1}`,
          'symbol-variable',
          false,
        ),
      );
    }
    return items;
  }
}

export class NetsItem extends vscode.TreeItem {
  constructor(
    readonly file: string,
    readonly line: number,
    readonly name: string,
    readonly description: string,
    readonly tooltip: string,
    readonly icon: string,
    readonly isPort: boolean,
  ) {
    super(name);
  }
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
