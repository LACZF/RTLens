import type { HierarchyNode } from '../core/ast';
import {
  HierarchyDbBuilder,
  buildHierarchyDatabase,
  firstParentPath,
  type HierarchyDatabase,
} from '../core/hierarchyDb';
import type { IndexService } from './indexService';
import { CompositionStore } from './compositionStore';

export interface CompositionLimits {
  maxDepth: number;
  maxInstances: number;
}

export interface LocatedModule {
  top: string;
  path: string[];
  topFile?: string;
}

/**
 * What the Composition view needs from a hierarchy. The DB source reads one
 * module record at a time; the index source is the pre-build fallback and keeps
 * the old in-memory behaviour.
 */
export interface CompositionSource {
  readonly kind: 'db' | 'index';
  readonly folder?: string;
  root(name: string): Promise<HierarchyNode | undefined>;
  expand(node: HierarchyNode): Promise<void>;
  locate(moduleName: string, file: string): Promise<LocatedModule | undefined>;
  knownModules(names: readonly string[]): Promise<Set<string>>;
  hasModule(name: string): Promise<boolean>;
  defaultTop(prefer: readonly string[]): Promise<{ name: string; file?: string } | undefined>;
  topFile(name: string): Promise<string | undefined>;
  reload(): Promise<boolean>;
}

/** DB-backed source: one shard read per module, with the view's limits. */
export class DbCompositionSource implements CompositionSource {
  readonly kind = 'db';
  readonly folder: string;
  private budget: number;
  private maxDepth: number;
  private nodeCount = 0;
  private readonly ancestors = new Map<string, Set<string>>();

  constructor(
    private store: CompositionStore,
    limits: CompositionLimits,
  ) {
    this.folder = store.folder;
    this.budget = limits.maxInstances > 0 ? limits.maxInstances : Infinity;
    this.maxDepth = limits.maxDepth > 0 ? limits.maxDepth : Infinity;
  }

  async root(name: string): Promise<HierarchyNode | undefined> {
    const entry = await this.store.module(name);
    if (!entry) {
      return undefined;
    }
    this.nodeCount = 0;
    this.ancestors.clear();
    this.ancestors.set(name, new Set([name]));
    return {
      path: name,
      instName: name,
      moduleName: name,
      depth: 0,
      file: entry.file,
      nameRange: entry.nameRange,
      moduleNameRange: entry.nameRange,
      range: entry.range,
      defFile: entry.file,
      childCountHint: entry.children.length,
      unresolved: false,
    };
  }

  async expand(node: HierarchyNode): Promise<void> {
    if (node.children !== undefined) {
      return;
    }
    node.children = [];
    if (node.truncated || node.cycle) {
      return;
    }
    const entry = await this.store.module(node.moduleName);
    if (!entry) {
      node.unresolved = true;
      return;
    }
    if (node.depth >= this.maxDepth) {
      if (entry.children.length > 0) {
        node.truncated = true;
      }
      return;
    }
    const onPath = this.ancestors.get(node.path) ?? new Set([node.moduleName]);
    for (const edge of entry.children) {
      if (this.nodeCount >= this.budget) {
        node.truncated = true;
        break;
      }
      this.nodeCount++;
      const childPath = node.path ? `${node.path}.${edge.i}` : edge.i;
      const onCycle = onPath.has(edge.m);
      const child: HierarchyNode = {
        path: childPath,
        instName: edge.i,
        moduleName: edge.m,
        depth: node.depth + 1,
        parentPath: node.path,
        file: edge.f,
        nameRange: edge.nr,
        moduleNameRange: edge.mr,
        range: edge.r,
        defFile: edge.df || undefined,
        childCountHint: edge.cc ?? 0,
        unresolved: !edge.ok,
        cycle: onCycle,
        generate: edge.g || undefined,
      };
      if (onCycle) {
        child.truncated = true;
      }
      const childAncestors = new Set(onPath);
      childAncestors.add(edge.m);
      this.ancestors.set(childPath, childAncestors);
      node.children.push(child);
    }
  }

  async locate(moduleName: string, _file: string): Promise<LocatedModule | undefined> {
    const chain = await this.store.firstParentChain(moduleName);
    if (!chain) {
      return undefined;
    }
    return { top: chain.top, path: chain.path, topFile: await this.store.topFile(chain.top) };
  }

  knownModules(names: readonly string[]): Promise<Set<string>> {
    return this.store.modulesAmong(names);
  }

  hasModule(name: string): Promise<boolean> {
    return this.store.hasModule(name);
  }

  async defaultTop(prefer: readonly string[]): Promise<{ name: string; file?: string } | undefined> {
    for (const name of prefer) {
      if (await this.store.hasModule(name)) {
        return { name, file: await this.store.topFile(name) };
      }
    }
    const first = this.store.manifest.tops[0];
    return first ? { name: first, file: await this.store.topFile(first) } : undefined;
  }

  topFile(name: string): Promise<string | undefined> {
    return this.store.topFile(name);
  }

  async reload(): Promise<boolean> {
    const next = CompositionStore.open(this.folder);
    if (!next) {
      return false;
    }
    this.store = next;
    return true;
  }
}

/** Index-backed fallback: only used once the workspace index already exists. */
export class IndexCompositionSource implements CompositionSource {
  readonly kind = 'index';
  readonly folder?: string;
  private db: HierarchyDatabase;
  private builder: HierarchyDbBuilder;

  constructor(
    private readonly svc: IndexService,
    private readonly limits: CompositionLimits,
  ) {
    this.db = buildHierarchyDatabase(svc.index, svc.config.topModules);
    this.builder = this.makeBuilder();
  }

  private makeBuilder(): HierarchyDbBuilder {
    return new HierarchyDbBuilder(this.db, {
      maxDepth: this.limits.maxDepth,
      maxInstances: this.limits.maxInstances,
    });
  }

  async root(name: string): Promise<HierarchyNode | undefined> {
    return this.builder.root(name);
  }

  async expand(node: HierarchyNode): Promise<void> {
    this.builder.expandLevel(node);
  }

  async locate(moduleName: string, _file: string): Promise<LocatedModule | undefined> {
    const path = firstParentPath(this.db, moduleName);
    if (!path) {
      return undefined;
    }
    const top = path[0];
    return { top, path, topFile: this.db.modules[top]?.file };
  }

  async knownModules(names: readonly string[]): Promise<Set<string>> {
    return new Set(names.filter((name) => this.db.modules[name] !== undefined));
  }

  async hasModule(name: string): Promise<boolean> {
    return this.db.modules[name] !== undefined;
  }

  async defaultTop(prefer: readonly string[]): Promise<{ name: string; file?: string } | undefined> {
    const name = prefer.find((n) => this.db.modules[n] !== undefined) ?? this.db.tops[0];
    return name ? { name, file: this.db.modules[name]?.file } : undefined;
  }

  async topFile(name: string): Promise<string | undefined> {
    return this.db.modules[name]?.file;
  }

  async reload(): Promise<boolean> {
    this.db = buildHierarchyDatabase(this.svc.index, this.svc.config.topModules);
    this.builder = this.makeBuilder();
    return true;
  }
}
