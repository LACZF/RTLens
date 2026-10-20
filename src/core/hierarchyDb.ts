/**
 * Hierarchy database (pure model).
 *
 * Stores the instantiation **graph** (module = node, instantiation = edge) plus
 * the display metadata the Composition view needs, so it can fetch a level in
 * O(1) and locate a module in O(depth) without walking the full index. The graph
 * is bounded by the number of instantiation sites in the source, not by the size
 * of the expanded tree, so it scales to unlimited instances and depth.
 *
 * Nothing here touches `vscode`, `fs` or a clock: the caller supplies the index,
 * the configured tops, the timestamp and the source fingerprint, which keeps the
 * whole thing unit-testable and lets a refresh be a plain function.
 */

import type { HdlIndex } from './index';
import type { HierarchyNode, ModuleKind, Range } from './ast';

/** One instantiation edge: parent module -> child module. */
export interface HierarchyEdge {
  /** Instance name as written, including the generate prefix (`g[0].u`). */
  i: string;
  /** Instantiated module name. */
  m: string;
  /** Generate prefix, e.g. `g[0]`; empty when not generated. */
  g: string;
  /** File that holds the instantiation. */
  f: string;
  /** Instance name range. */
  nr: Range;
  /** Module name range, so a row click jumps to the module, not the instance. */
  mr: Range;
  /** Whole instantiation statement range. */
  r: Range;
  /** Child module resolved in the index. */
  ok: boolean;
  /** Defining file of `m`; lets the view filter by path without the index. */
  df?: string;
  /** Child count of `m`; lets the view draw its chevron without the index. */
  cc?: number;
}

/** One reverse edge: this module is instantiated by that instance. */
export interface HierarchyParent {
  /** Parent module name. */
  p: string;
  /** Instance name, with the generate prefix. */
  i: string;
  /** Generate prefix. */
  g: string;
  /** File that holds the instantiation. */
  f: string;
  /** Instance name range. */
  nr: Range;
  /** Whole instantiation statement range. */
  r: Range;
}

/** Everything known about one module definition. */
export interface HierarchyModule {
  kind: ModuleKind;
  file: string;
  nameRange: Range;
  /** Whole definition range, so a root row can be revealed the same way as in the index builder. */
  range: Range;
  /** Direct instantiation edges, source order. */
  children: HierarchyEdge[];
  /** Reverse edges: who instantiates this module, source order. */
  parents: HierarchyParent[];
  /**
   * Parent edge on the first-branch path to the nearest top; `null` when the
   * module is itself a top. Built by a pre-order DFS from each top.
   */
  firstParent: { p: string; i: string; g: string } | null;
}

export const HIERARCHY_DB_VERSION = 2;

/** The on-disk database: module name -> entry. */
export interface HierarchyDatabase {
  version: number;
  generatedAt: string;
  /**
   * Fingerprint of the source files this was built from (see
   * `sourceFingerprint` in `core/relations`). An empty string means "unknown", and
   * a reader must treat the database as stale.
   */
  source: string;
  /** Modules nothing instantiates (or the configured tops), sorted by name. */
  tops: string[];
  modules: Record<string, HierarchyModule>;
}

/**
 * Build the hierarchy database from the index.
 *
 * A module defined more than once (an RTL definition and a black-box stub, say)
 * is merged under one name: its children are concatenated so no instantiation is
 * lost, and the first definition supplies `file`/`nameRange`. `preferTops` names
 * are always kept in `tops`, even when something instantiates them.
 */
export function buildHierarchyDatabase(
  index: HdlIndex,
  preferTops: string[] = [],
  generatedAt = '',
  source = '',
): HierarchyDatabase {
  const modules: Record<string, HierarchyModule> = {};
  for (const def of index.allModules()) {
    let entry = modules[def.name];
    if (!entry) {
      entry = {
        kind: def.kind,
        file: def.file,
        nameRange: def.nameRange,
        range: def.range,
        children: [],
        parents: [],
        firstParent: null,
      };
      modules[def.name] = entry;
    }
    for (const inst of def.instances) {
      const child = index.resolveModule(inst.moduleName, def.file);
      entry.children.push({
        i: inst.genPrefix ? `${inst.genPrefix}.${inst.name}` : inst.name,
        m: inst.moduleName,
        g: inst.genPrefix ?? '',
        f: def.file,
        nr: inst.nameRange,
        mr: inst.moduleNameRange,
        r: inst.range,
        ok: !!child,
      });
    }
  }

  // Hints the Composition view needs to answer "which file defines this" and
  // "does this row have children" without touching the index. Filled after the
  // module map is complete, so merged duplicate definitions are counted once.
  for (const entry of Object.values(modules)) {
    for (const edge of entry.children) {
      const child = modules[edge.m];
      edge.df = child?.file ?? '';
      edge.cc = child?.children.length ?? 0;
    }
  }

  // Reverse edges: every resolved child learns who instantiates it.
  for (const [name, entry] of Object.entries(modules)) {
    for (const edge of entry.children) {
      if (!edge.ok) {
        continue;
      }
      const child = modules[edge.m];
      if (!child) {
        continue;
      }
      child.parents.push({ p: name, i: edge.i, g: edge.g, f: edge.f, nr: edge.nr, r: edge.r });
    }
  }

  // Tops: nothing instantiates them. Configured tops are kept even when
  // something does instantiate them.
  const tops = Object.keys(modules)
    .filter((n) => modules[n].parents.length === 0)
    .sort();
  for (const t of preferTops) {
    if (modules[t] && !tops.includes(t)) {
      tops.push(t);
    }
  }
  tops.sort();

  // First-branch parent: a pre-order DFS from each top, first visit wins, so
  // every module's `firstParent` chain reaches exactly one top.
  const visited = new Set<string>();
  for (const top of tops) {
    if (visited.has(top)) {
      continue;
    }
    if (!modules[top]) {
      continue;
    }
    visited.add(top);
    const stack: string[] = [top];
    while (stack.length > 0) {
      const name = stack.pop()!;
      const entry = modules[name];
      if (!entry) {
        continue;
      }
      // Pushed in reverse so the children are visited in source order.
      for (let k = entry.children.length - 1; k >= 0; k--) {
        const edge = entry.children[k];
        if (!edge.ok) {
          continue;
        }
        const child = modules[edge.m];
        if (!child || visited.has(edge.m)) {
          continue;
        }
        visited.add(edge.m);
        child.firstParent = { p: name, i: edge.i, g: edge.g };
        stack.push(edge.m);
      }
    }
  }

  return { version: HIERARCHY_DB_VERSION, generatedAt, source, tops, modules };
}

/**
 * The dotted path from the nearest top down to `moduleName`, or `undefined` when
 * the module is unknown or sits on a cycle with no reachable top.
 *
 * The first segment is the top itself, then one segment per instance
 * (`top.u_mid.u_a`), matching the paths the Composition view already uses.
 */
export function firstParentPath(db: HierarchyDatabase, moduleName: string): string[] | undefined {
  if (!moduleName) {
    return undefined;
  }
  const segs: string[] = [];
  const seen = new Set<string>();
  let cur = moduleName;
  while (cur) {
    if (seen.has(cur)) {
      return undefined;
    }
    seen.add(cur);
    const entry = db.modules[cur];
    if (!entry) {
      return undefined;
    }
    if (!entry.firstParent) {
      break;
    }
    segs.unshift(entry.firstParent.i);
    cur = entry.firstParent.p;
  }
  segs.unshift(cur);
  return segs;
}

/** Direct children of a module, empty when unknown. */
export function childrenOf(db: HierarchyDatabase, moduleName: string): HierarchyEdge[] {
  return db.modules[moduleName]?.children ?? [];
}

/** Compact, stable serialisation. `modules` is already key-sorted. */
export function serializeHierarchyDatabase(db: HierarchyDatabase): string {
  return JSON.stringify(db);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse a database written by an earlier run; `undefined` when unusable. */
export function parseHierarchyDatabase(text: string): HierarchyDatabase | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.version !== HIERARCHY_DB_VERSION || !isRecord(value.modules)) {
    return undefined;
  }
  if (!Array.isArray(value.tops)) {
    return undefined;
  }
  const modules: Record<string, HierarchyModule> = {};
  for (const [name, raw] of Object.entries(value.modules)) {
    if (!isRecord(raw) || !Array.isArray(raw.children) || !Array.isArray(raw.parents)) {
      return undefined;
    }
    modules[name] = raw as unknown as HierarchyModule;
  }
  return {
    version: HIERARCHY_DB_VERSION,
    generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : '',
    source: typeof value.source === 'string' ? value.source : '',
    tops: value.tops as string[],
    modules,
  };
}

export interface HierarchyStats {
  modules: number;
  instances: number;
  tops: number;
}

export function hierarchyDbStats(db: HierarchyDatabase | undefined): HierarchyStats {
  const out: HierarchyStats = { modules: 0, instances: 0, tops: 0 };
  if (!db) {
    return out;
  }
  out.tops = db.tops.length;
  for (const entry of Object.values(db.modules)) {
    out.modules++;
    out.instances += entry.children.length;
  }
  return out;
}

export interface HierarchyDbOptions {
  maxDepth?: number;
  maxInstances?: number;
}

/**
 * A lazy level-by-level walker over a {@link HierarchyDatabase}.
 *
 * This is the Composition view's engine: it exposes the same `root` /
 * `childCount` / `expandLevel` surface as the index-backed `HierarchyBuilder`,
 * but reads the precomputed graph, so a level costs one map lookup instead of a
 * walk over the index. Its output is deliberately identical to
 * `HierarchyBuilder`'s (same fields, same `moduleNameRange`), so switching a
 * view between the two when the database goes stale is invisible.
 */
export class HierarchyDbBuilder {
  private budget: number;
  private maxDepth: number;
  private nodeCount = 0;

  constructor(
    private readonly db: HierarchyDatabase,
    opts: HierarchyDbOptions = {},
  ) {
    // `undefined` keeps the historic default; an explicit 0 lifts the cap.
    this.budget =
      opts.maxInstances === undefined ? 20000 : opts.maxInstances > 0 ? opts.maxInstances : Infinity;
    this.maxDepth =
      opts.maxDepth === undefined ? 32 : opts.maxDepth > 0 ? opts.maxDepth : Infinity;
  }

  /** Create a root node whose children are not materialised yet. */
  root(moduleName: string, _fromFile?: string): HierarchyNode | undefined {
    const entry = this.db.modules[moduleName];
    if (!entry) {
      return undefined;
    }
    this.nodeCount = 0;
    return {
      path: moduleName,
      instName: moduleName,
      moduleName,
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

  /** Direct child count, predicted without materialising the level. */
  childCount(node: HierarchyNode): number {
    if (node.children !== undefined) {
      return node.children.length;
    }
    if (node.truncated || node.cycle || node.depth >= this.maxDepth || this.nodeCount >= this.budget) {
      return 0;
    }
    return this.db.modules[node.moduleName]?.children.length ?? 0;
  }

  /** Materialise `node`'s direct children only, leaving each unexpanded. */
  expandLevel(node: HierarchyNode): HierarchyNode {
    if (node.children !== undefined) {
      return node;
    }
    node.children = [];
    if (node.truncated || node.cycle) {
      return node;
    }
    const entry = this.db.modules[node.moduleName];
    if (!entry) {
      node.unresolved = true;
      return node;
    }
    if (node.depth >= this.maxDepth) {
      if (entry.children.length > 0) {
        node.truncated = true;
      }
      return node;
    }
    const onPath = this.moduleNamesOnPath(node.path);
    for (const edge of entry.children) {
      if (this.nodeCount >= this.budget) {
        node.truncated = true;
        break;
      }
      this.nodeCount++;
      const childPath = node.path ? `${node.path}.${edge.i}` : edge.i;
      const childEntry = this.db.modules[edge.m];
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
        defFile: childEntry?.file,
        childCountHint: childEntry?.children.length ?? 0,
        unresolved: !childEntry,
        cycle: onCycle,
        generate: edge.g || undefined,
      };
      if (onCycle) {
        child.truncated = true;
      }
      node.children.push(child);
    }
    return node;
  }

  /** Module names along a node path, root first, for cycle detection. */
  private moduleNamesOnPath(path: string): Set<string> {
    const parts = path.split('.').filter(Boolean);
    const names = new Set<string>();
    if (parts.length === 0) {
      return names;
    }
    let cur = parts[0];
    names.add(cur);
    for (let i = 1; i < parts.length; i++) {
      const entry = this.db.modules[cur];
      if (!entry) {
        break;
      }
      let edge = entry.children.find((c) => c.i === parts[i]);
      if (!edge && i + 1 < parts.length) {
        // The segment is a generate label and the instance name follows it.
        edge = entry.children.find((c) => c.i === `${parts[i]}.${parts[i + 1]}`);
        if (edge) {
          i++;
        }
      }
      if (!edge) {
        break;
      }
      names.add(edge.m);
      cur = edge.m;
    }
    return names;
  }
}
