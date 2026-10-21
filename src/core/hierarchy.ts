/**
 * Hierarchy construction.
 *
 * Turns the flat per-file module index into an instance tree rooted at a top
 * module. Expansion is lazy and bounded: depth limit, total node budget, and
 * cycle detection along the active path (a module that instantiates itself
 * through a parameter, or a generate loop that never terminates, would
 * otherwise expand forever).
 */

import type { HdlIndex, ParentRef } from './index';
import type { HierarchyNode, ModuleDef, ParamDecl, PortDecl, InstanceSite } from './ast';
import type { Range } from './lexer';
import { MapScope, rangeWidth, typeWidth } from './fold';

export interface HierarchyOptions {
  /**
   * Depth cap; omitted keeps the default 32, an explicit 0 means no limit
   * (cycle detection still stops a module that instantiates itself).
   */
  maxDepth?: number;
  /** Node budget; omitted keeps the default 20000, an explicit 0 means no limit. */
  maxInstances?: number;
  /** Modules along the current path, for cycle detection. */
  stopOnCycle?: boolean;
}

export interface HierarchyResult {
  root: HierarchyNode;
  /** Set when expansion was cut short by a limit. */
  truncated: boolean;
  totalNodes: number;
  unresolved: number;
}

/**
 * A module's direct instances compiled for the view, without any path prefix:
 * the same template is reused for every occurrence of the module, so a module
 * instantiated N times compiles its child rows once. `resolved`/`hasChildren`
 * are precomputed so drawing a row needs no further index lookups.
 */
export interface RowTemplate {
  instName: string;
  rawName: string;
  moduleName: string;
  nameRange: Range;
  moduleNameRange: Range;
  range: Range;
  genPrefix?: string;
  conditional?: boolean;
  file: string;
  resolved: boolean;
  hasChildren: boolean;
}

/**
 * The level-at-a-time tree walk the Composition view drives. Both
 * {@link HierarchyBuilder} (built from the index) and the database-backed
 * `HierarchyDbBuilder` satisfy it, so a view can switch between them when the
 * persisted database goes stale without changing anything else.
 */
export interface HierarchyExpander {
  root(moduleName: string, fromFile?: string): HierarchyNode | undefined;
  childCount(node: HierarchyNode): number;
  expandLevel(node: HierarchyNode): HierarchyNode;
}

export class HierarchyBuilder implements HierarchyExpander {
  private nodeCount = 0;
  private budget: number;
  private maxDepth: number;
  truncated = false;
  unresolved = 0;
  /** Per-module compiled child rows, reused across occurrences for this builder's life. */
  private readonly templateCache = new Map<ModuleDef, RowTemplate[]>();

  constructor(private readonly index: HdlIndex, opts: HierarchyOptions) {
    // `undefined` keeps the historic default; an explicit 0 lifts the cap.
    this.budget =
      opts.maxInstances === undefined ? 20000 : opts.maxInstances > 0 ? opts.maxInstances : Infinity;
    this.maxDepth =
      opts.maxDepth === undefined ? 32 : opts.maxDepth > 0 ? opts.maxDepth : Infinity;
  }

  build(moduleName: string, fromFile?: string): HierarchyResult | undefined {
    const def = this.index.resolveModule(moduleName, fromFile);
    if (!def) {
      return undefined;
    }
    const root: HierarchyNode = {
      path: def.name,
      instName: def.name,
      moduleName: def.name,
      depth: 0,
      file: def.file,
      nameRange: def.nameRange,
      moduleNameRange: def.nameRange,
      range: def.range,
      children: [],
      unresolved: false,
    };
    this.expand(root, def, [def.name], new MapScope());
    return {
      root,
      truncated: this.truncated,
      totalNodes: this.nodeCount,
      unresolved: this.unresolved,
    };
  }

  // ------------------------------------------------------------------ lazy

  /**
   * Create a root node whose children are not materialised yet.
   *
   * This is the entry point for the Composition view: it pulls one level at a
   * time through {@link expandLevel}, so a design with a huge instance count
   * never materialises nor serialises the whole tree up front. `children`
   * staying `undefined` is what marks a node as unexpanded; the eager
   * {@link build} fills it in for every node instead.
   */
  root(moduleName: string, fromFile?: string): HierarchyNode | undefined {
    const def = this.index.resolveModule(moduleName, fromFile);
    if (!def) {
      return undefined;
    }
    this.nodeCount = 0;
    return {
      path: def.name,
      instName: def.name,
      moduleName: def.name,
      depth: 0,
      file: def.file,
      nameRange: def.nameRange,
      moduleNameRange: def.nameRange,
      range: def.range,
      unresolved: false,
    };
  }

  /**
   * How many direct children `node` would have, without materialising them.
   * A node that is already expanded answers its real child count; an
   * unexpanded one is asked of its definition, so the view can draw a
   * disclosure triangle before the level is loaded.
   */
  childCount(node: HierarchyNode): number {
    if (node.children !== undefined) {
      return node.children.length;
    }
    if (node.truncated || node.cycle || node.depth >= this.maxDepth || this.nodeCount >= this.budget) {
      return 0;
    }
    const def = this.index.resolveModule(node.moduleName, node.file);
    return def ? this.levelTemplate(def).length : 0;
  }

  /** The compiled direct instances of `def`, memoised per module. */
  private levelTemplate(def: ModuleDef): RowTemplate[] {
    let t = this.templateCache.get(def);
    if (!t) {
      t = [];
      const seen = new Set<string>();
      for (const inst of def.instances) {
        const instName = inst.genPrefix ? `${inst.genPrefix}.${inst.name}` : inst.name;
        // `ifdef` alternatives can repeat one instance name (both branches are
        // parsed for navigation). The tree is keyed by path, so the first
        // branch wins and later duplicates are dropped.
        if (seen.has(instName)) {
          continue;
        }
        seen.add(instName);
        const child = this.index.resolveModule(inst.moduleName, def.file);
        t.push({
          instName,
          rawName: inst.rawName,
          moduleName: inst.moduleName,
          nameRange: inst.nameRange,
          moduleNameRange: inst.moduleNameRange,
          range: inst.range,
          genPrefix: inst.genPrefix,
          conditional: inst.conditional,
          file: def.file,
          resolved: !!child,
          hasChildren: !!child && child.instances.length > 0,
        });
      }
      this.templateCache.set(def, t);
    }
    return t;
  }

  /**
   * Materialise `node`'s *direct* children only, leaving each child
   * unexpanded. The lazy counterpart of {@link expand}: the tree view asks for
   * a level when the reader opens a node, so an untouched subtree costs
   * nothing.
   */
  expandLevel(node: HierarchyNode): HierarchyNode {
    if (node.children !== undefined) {
      return node;
    }
    node.children = [];
    if (node.truncated || node.cycle) {
      return node;
    }
    const def = this.index.resolveModule(node.moduleName, node.file);
    if (!def) {
      node.unresolved = true;
      return node;
    }
    if (node.depth >= this.maxDepth) {
      if (def.instances.length > 0) {
        node.truncated = true;
        this.truncated = true;
      }
      return node;
    }
    const onPath = this.moduleNamesOnPath(node.path);
    for (const t of this.levelTemplate(def)) {
      if (this.nodeCount >= this.budget) {
        this.truncated = true;
        node.truncated = true;
        break;
      }
      this.nodeCount++;
      const childPath = node.path ? `${node.path}.${t.instName}` : t.instName;
      const onCycle = onPath.has(t.moduleName);
      const child: HierarchyNode = {
        path: childPath,
        instName: t.instName,
        moduleName: t.moduleName,
        depth: node.depth + 1,
        parentPath: node.path,
        file: t.file,
        nameRange: t.nameRange,
        moduleNameRange: t.moduleNameRange,
        range: t.range,
        unresolved: !t.resolved,
        cycle: onCycle,
        generate: t.genPrefix,
      };
      if (onCycle) {
        child.truncated = true;
      }
      node.children.push(child);
    }
    return node;
  }

  /**
   * Module names along a node path, root first, for cycle detection in the
   * lazy walk. Follows a generate label (`g[0].u`) as the two segments it is
   * on the path, exactly as {@link moduleAtPath} does.
   */
  private moduleNamesOnPath(path: string): Set<string> {    const parts = path.split('.').filter(Boolean);
    const names = new Set<string>();
    if (parts.length === 0) {
      return names;
    }
    let def = this.index.resolveModule(parts[0]);
    names.add(parts[0]);
    for (let i = 1; i < parts.length && def; i++) {
      let inst = findInstance(def, parts[i]);
      if (!inst && i + 1 < parts.length) {
        inst = findInstance(def, `${parts[i]}.${parts[i + 1]}`);
        if (inst) {
          names.add(inst.moduleName);
          def = this.index.resolveModule(inst.moduleName, def.file);
          i++;
          continue;
        }
      }
      if (!inst) {
        break;
      }
      names.add(inst.moduleName);
      def = this.index.resolveModule(inst.moduleName, def.file);
    }
    return names;
  }

  /** Materialise the children of a node that was created lazily. */
  expandChildren(node: HierarchyNode): HierarchyNode {
    if (node.children && node.children.length > 0) {
      return node;
    }
    const def = this.index.resolveModule(node.moduleName);
    if (!def) {
      node.children = [];
      node.truncated = false;
      return node;
    }
    const pathModules = node.path.split('.').filter(Boolean);
    this.expand(node, def, pathModules, this.paramScopeFor(node));
    return node;
  }

  /**
   * Expand `node`'s subtree.
   *
   * Iterative on purpose: the Composition tree lifts the depth cap, so a design
   * with a deep chain of distinct modules must not overflow the JS call stack.
   * An explicit frame stack reproduces the old depth-first order exactly (the
   * child frame sits on top and is finished before the parent moves on), so the
   * truncation points of a budget cut are unchanged. The set of module names
   * along the active path gives cycle detection in O(1) and, unlike the array it
   * replaces, is not copied once per level - a deep chain stays linear instead
   * of quadratic.
   */
  private expand(node: HierarchyNode, def: ModuleDef, pathModules: string[], scope: MapScope): void {
    interface Frame {
      node: HierarchyNode;
      def: ModuleDef;
      scope: MapScope;
      /** Next instance of `def` to visit. */
      i: number;
      /** Whether the frame's `children` array and depth cap were handled. */
      entered: boolean;
      /** Name the frame put on `onPath`, to take off again when it is done. */
      key?: string;
    }
    const onPath = new Set(pathModules);
    const stack: Frame[] = [{ node, def, scope, i: 0, entered: false }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (!frame.entered) {
        frame.entered = true;
        frame.node.children = [];
        if (frame.node.depth >= this.maxDepth) {
          // The depth limit cut this subtree off; say so on the node and on the
          // result, so callers can tell a leaf from an unexpanded instance.
          if (frame.def.instances.length > 0) {
            frame.node.truncated = true;
            this.truncated = true;
          }
          stack.pop();
          if (frame.key !== undefined) {
            onPath.delete(frame.key);
          }
          continue;
        }
      }
      if (frame.i >= frame.def.instances.length) {
        stack.pop();
        if (frame.key !== undefined) {
          onPath.delete(frame.key);
        }
        continue;
      }
      if (this.nodeCount >= this.budget) {
        this.truncated = true;
        frame.node.truncated = true;
        stack.pop();
        if (frame.key !== undefined) {
          onPath.delete(frame.key);
        }
        continue;
      }
      const inst = frame.def.instances[frame.i++];
      this.nodeCount++;
      const instPath = inst.genPrefix ? `${inst.genPrefix}.${inst.name}` : inst.name;
      const childPath = frame.node.path ? `${frame.node.path}.${instPath}` : instPath;
      const childDef = this.index.resolveModule(inst.moduleName, frame.def.file);
      const onCycle = onPath.has(inst.moduleName);
      const child: HierarchyNode = {
        path: childPath,
        instName: instPath,
        moduleName: inst.moduleName,
        depth: frame.node.depth + 1,
        parentPath: frame.node.path,
        file: frame.def.file,
        nameRange: inst.nameRange,
        moduleNameRange: inst.moduleNameRange,
        range: inst.range,
        children: [],
        unresolved: !childDef,
        cycle: onCycle,
        generate: inst.genPrefix,
      };
      frame.node.children!.push(child);
      if (onCycle) {
        child.truncated = true;
      } else {
        this.unresolved += childDef ? 0 : 1;
        if (childDef) {
          const childScope = this.childScope(frame.scope, frame.def, childDef, inst.paramOverrides);
          onPath.add(inst.moduleName);
          stack.push({ node: child, def: childDef, scope: childScope, i: 0, entered: false, key: inst.moduleName });
        }
      }
    }
  }

  /** Bind a child's parameters from the parent's scope plus overrides. */
  private childScope(
    parentScope: MapScope,
    parentDef: ModuleDef,
    childDef: ModuleDef,
    overrides: { name?: string; expr: { raw: string; value?: number }; byPosition: boolean }[],
  ): MapScope {
    const scope = parentScope.clone();
    // What gets measured from here on is the child's declaration: its ports,
    // params and signals. Type names therefore resolve through the child's own
    // scope - the parent may well define the same name as a different type.
    scope.setTypeResolver((name) => this.index.underlyingType(childDef, name));
    // `defparam` wins over `#(...)` in Verilog, but the elaboration order makes
    // the override set more useful for the reader, so apply overrides first and
    // let defparam correct them.
    let positional = 0;
    // Names bound by an override; their module default must not win later.
    const overridden = new Set<string>();
    for (const o of overrides) {
      if (!o.byPosition && o.name) {
        const v = o.expr.value ?? undefined;
        if (v !== undefined) {
          scope.set(o.name, v);
          overridden.add(o.name);
        }
        continue;
      }
      const p = childDef.params[positional++];
      if (p) {
        const v = o.expr.value ?? undefined;
        if (v !== undefined) {
          scope.set(p.name, v);
          overridden.add(p.name);
        }
      }
    }
    for (const d of parentDef.defparams) {
      if (scope.has(d.param)) {
        continue;
      }
      const v = d.expr.value;
      if (v !== undefined) {
        scope.set(d.param, v);
      }
    }
    // Seed the child's own parameter defaults that were not overridden.
    for (const p of childDef.params) {
      if (!overridden.has(p.name) && p.value?.value !== undefined) {
        scope.set(p.name, p.value.value);
      }
    }
    for (const p of childDef.params) {
      const w = typeWidth(p.dataType, scope);
      if (w !== undefined) {
        scope.setWidth(p.name, w);
      }
    }
    return scope;
  }

  /** Rebuild the parameter scope in effect at an existing node. */
  paramScopeFor(node: HierarchyNode): MapScope {
    const parts = node.path.split('.').filter(Boolean);
    let def = this.index.resolveModule(parts[0]);
    if (!def) {
      return new MapScope();
    }
    let scope = this.index.scopeFor(def);
    for (const part of parts.slice(1)) {
      const childDef = def;
      if (!childDef) {
        return scope;
      }
      // `g_par[0].u_par` style segments: find the instance under this module.
      const inst = findInstance(childDef, part);
      if (!inst) {
        return scope;
      }
      const next = this.index.resolveModule(inst.moduleName);
      if (!next) {
        return scope;
      }
      scope = this.childScope(scope, childDef, next, inst.paramOverrides);
      def = next;
    }
    return scope;
  }
}

/**
 * Locate an instance by plain name or generate-prefixed name.
 *
 * The linear scan this used to be is O(instances) per call, and the graph asks
 * once per visited child, so a module with thousands of instances turned the
 * whole build quadratic. The name -> instance map is built once per module and
 * cached; a plain name wins over a generate-prefixed one, exactly as the two
 * ordered scans did.
 */
const instanceNameCache = new WeakMap<ModuleDef, Map<string, InstanceSite>>();

export function findInstance(def: ModuleDef, segment: string): InstanceSite | undefined {
  let byName = instanceNameCache.get(def);
  if (!byName) {
    byName = new Map<string, InstanceSite>();
    // Two passes so every plain name beats every prefixed name, matching the
    // old `find(name) ?? find(prefixed)` order.
    for (const i of def.instances) {
      if (!byName.has(i.name)) {
        byName.set(i.name, i);
      }
    }
    for (const i of def.instances) {
      const full = i.genPrefix ? `${i.genPrefix}.${i.name}` : i.name;
      if (!byName.has(full)) {
        byName.set(full, i);
      }
    }
    instanceNameCache.set(def, byName);
  }
  return byName.get(segment);
}

/** Build the instance tree for a top module. */
export function buildHierarchy(
  index: HdlIndex,
  moduleName: string,
  opts: HierarchyOptions = {},
  fromFile?: string,
): HierarchyResult | undefined {
  return new HierarchyBuilder(index, opts).build(moduleName, fromFile);
}

/** A module's place in the design: the root module and the dotted path to it. */
export interface HierarchyEntry {
  top: string;
  path: string;
  /** Bottom-up parent sites, from the module's direct parent up to the root. */
  segs: { parent: string; inst: InstanceSite }[];
}

/**
 * The first reverse edge of `moduleName`: the parent site with the smallest
 * `(file, line, character, rawName)` key. Deterministic, so "the first branch"
 * of a module with several instantiators is stable and reproducible.
 */
export function firstParent(index: HdlIndex, moduleName: string): ParentRef | undefined {
  let best: ParentRef | undefined;
  for (const r of index.parentsOf(moduleName)) {
    if (!best || parentLess(r, best)) {
      best = r;
    }
  }
  return best;
}

function parentLess(a: ParentRef, b: ParentRef): boolean {
  if (a.file !== b.file) {
    return a.file < b.file;
  }
  const al = a.inst.nameRange.start;
  const bl = b.inst.nameRange.start;
  if (al.line !== bl.line) {
    return al.line < bl.line;
  }
  if (al.character !== bl.character) {
    return al.character < bl.character;
  }
  return a.inst.rawName < b.inst.rawName;
}

/**
 * The design entry of `moduleName`: follow the *first* parent edge at each step
 * up to a module with no parent (or a configured top, or a cycle). The chain is
 * deterministic, so the tree root and the branch opened for an editor are
 * always the same line, computed without materialising the tree in O(depth).
 */
export function entryOf(
  index: HdlIndex,
  moduleName: string,
  fromFile?: string,
  preferTops: string[] = [],
): HierarchyEntry | undefined {
  if (!index.resolveModule(moduleName, fromFile)) {
    return undefined;
  }
  const segs: { parent: string; inst: InstanceSite }[] = [];
  const seen = new Set<string>([moduleName]);
  let cur = moduleName;
  while (!preferTops.includes(cur)) {
    const p = firstParent(index, cur);
    if (!p || seen.has(p.parentModule)) {
      break;
    }
    segs.push({ parent: p.parentModule, inst: p.inst });
    seen.add(p.parentModule);
    cur = p.parentModule;
  }
  let path = cur;
  for (let i = segs.length - 1; i >= 0; i--) {
    const inst = segs[i].inst;
    const local = inst.genPrefix ? `${inst.genPrefix}.${inst.name}` : inst.name;
    path = `${path}.${local}`;
  }
  return { top: cur, path, segs };
}

/**
 * The design top that contains `moduleName`, and the dotted path from that top
 * down to the module - computed without materialising the tree, so the lazy
 * Composition view can root at the design top and walk its own way down to the
 * cursor's module. Follows the {@link entryOf} first branch; a name in
 * `preferTops` ends the walk there (a configured top is the root even when
 * something instantiates it).
 */
export function containingPath(
  index: HdlIndex,
  moduleName: string,
  fromFile?: string,
  preferTops: string[] = [],
): { top: string; path: string } | undefined {
  const entry = entryOf(index, moduleName, fromFile, preferTops);
  return entry ? { top: entry.top, path: entry.path } : undefined;
}

/**
 * Where a module's definition lives inside the wider design: the hierarchy
 * rooted at the containing top and the node standing for the module inside it,
 * so the containing chain can be revealed above the graph root with the
 * left-edge +/-.
 */
export function containingDesign(
  index: HdlIndex,
  moduleName: string,
  fromFile?: string,
  preferTops: string[] = [],
  opts: HierarchyOptions = { maxDepth: 128 },
): { root: HierarchyNode; node: HierarchyNode } | undefined {
  const found = containingPath(index, moduleName, fromFile, preferTops);
  if (!found) {
    return undefined;
  }
  const res = buildHierarchy(index, found.top, opts);
  const root = res?.root;
  if (!root) {
    return undefined;
  }
  const node = findByPath(root, found.path);
  return node ? { root, node } : undefined;
}

/**
 * The constant-folding scope in effect at a hierarchy path, i.e. the parameter
 * values visible there after applying `#(...)` overrides and `defparam`.
 */
export function paramScopeForPath(index: HdlIndex, path: string): MapScope {
  return new HierarchyBuilder(index, {}).paramScopeFor({ path } as HierarchyNode);
}

/** Bit width of a port / signal as seen at a hierarchy path. */
export function signalWidth(
  index: HdlIndex,
  path: string,
  name: string,
): number | undefined {
  const def = moduleAtPath(index, path);
  if (!def) {
    return undefined;
  }
  const scope = paramScopeForPath(index, path);
  const d = index.findDecl(def, name);
  if (!d) {
    return undefined;
  }
  if (d.kind !== 'port' && d.kind !== 'var') {
    return undefined;
  }
  // Every declared dimension counts: `typeWidth` only covers the first packed
  // range, so `logic [3:0][7:0] buf` is 4 and not 32 until the rest is
  // multiplied in - and it was not, which is why the tree view said 4 bits for a
  // 32-bit vector while the generator said 32.
  const dims = d.kind === 'port' ? [...(d.decl.packed ?? []), ...(d.decl.unpacked ?? [])]
    : [...(d.decl.packedDims ?? []), ...(d.decl.dims ?? [])];
  let total = typeWidth(d.decl.dataType, scope) ?? 1;
  for (const dim of dims) {
    const n = rangeWidth(dim, scope);
    if (n === undefined) {
      return undefined;
    }
    total *= n;
  }
  return total;
}

/**
 * Module that owns `path`: walk the instance chain from the top module down,
 * following generate labels (`g[0].u_sub`) as two segments.
 */
export function moduleAtPath(index: HdlIndex, path: string): ModuleDef | undefined {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  let def = index.resolveModule(parts[0]);
  for (let i = 1; i < parts.length && def; i++) {
    let inst = findInstance(def, parts[i]);
    if (!inst && i + 1 < parts.length) {
      // The segment is a generate label and the instance name follows it.
      inst = findInstance(def, `${parts[i]}.${parts[i + 1]}`);
      if (inst) {
        i++;
      }
    }
    if (!inst) {
      return undefined;
    }
    def = index.resolveModule(inst.moduleName, def.file);
  }
  return def;
}

/**
 * Find a node by dotted path.
 *
 * An arrayed instantiation is one node, so `u[2]` finds the node of `u` and
 * `u[0]` the same one: the path that names an element of the array is how a
 * reference reads, and it has to reach the instance it belongs to.
 */
export function findByPath(root: HierarchyNode, path: string): HierarchyNode | undefined {
  const exact = findNodeByPath(root, path);
  if (exact) {
    return exact;
  }
  const withoutIndices = path.replace(/\[\d+\]/g, '');
  return withoutIndices === path ? undefined : findNodeByPath(root, withoutIndices);
}

/**
 * The one child of `node` whose own segment is the next step of `path`.
 *
 * `path` must sit below `node.path`. A child is matched on just its segment -
 * the text after `node.path + '.'` - not with a `startsWith` of its full path,
 * which would rescan the entire prefix once per level and make a deep chain
 * quadratic. Comparing the segment in place keeps navigation O(path length).
 */
export function childOnPath(node: HierarchyNode, path: string): HierarchyNode | undefined {
  // Below `node.path` the path must continue with a `.`; anything else is not a
  // descendant.
  if (path.length <= node.path.length || path.charCodeAt(node.path.length) !== 46 /* '.' */) {
    return undefined;
  }
  const start = node.path.length + 1;
  for (const c of node.children ?? []) {
    const end = c.path.length;
    if (end <= start) {
      continue;
    }
    // The child's segment must be exactly path[start, end) and end on a
    // segment boundary, so `g[0]` never swallows the `g[0].u` route.
    if (path.length !== end && path.charCodeAt(end) !== 46 /* '.' */) {
      continue;
    }
    let match = true;
    for (let k = start; k < end; k++) {
      if (path.charCodeAt(k) !== c.path.charCodeAt(k)) {
        match = false;
        break;
      }
    }
    if (match) {
      return c;
    }
  }
  return undefined;
}

function findNodeByPath(root: HierarchyNode, path: string): HierarchyNode | undefined {
  // Iterative and segment-wise so an unlimited-depth tree neither overflows the
  // call stack nor rescans the prefix at every level.
  let node: HierarchyNode | undefined = root;
  while (node) {
    if (node.path === path) {
      return node;
    }
    node = childOnPath(node, path);
  }
  return undefined;
}

/** Nodes at or below `path`, depth first. */
export function subtree(root: HierarchyNode, path?: string): HierarchyNode[] {
  const start = path ? findByPath(root, path) : root;
  if (!start) {
    return [];
  }
  const out: HierarchyNode[] = [];
  const stack: HierarchyNode[] = [start];
  while (stack.length) {
    const n = stack.pop()!;
    out.push(n);
    for (let i = (n.children ?? []).length - 1; i >= 0; i--) {
      stack.push(n.children![i]);
    }
  }
  return out;
}

/**
 * Levels of descendants below `node`: how many further rows of instances live
 * under it. A leaf (or a node whose subtree was not expanded by the hierarchy
 * budget) answers 0, so the view's right-side plus has somewhere to stop.
 */
export function subtreeDepth(node: HierarchyNode): number {
  let deepest = 0;
  const stack: HierarchyNode[] = [node];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.children?.length) {
      for (let i = n.children.length - 1; i >= 0; i--) {
        const c = n.children[i];
        deepest = Math.max(deepest, c.depth - node.depth);
        stack.push(c);
      }
    }
  }
  return deepest;
}

/** The chain of nodes from the root down to `path`, inclusive. */
export function pathChain(root: HierarchyNode, path: string): HierarchyNode[] {
  // Iterative and segment-wise, like `findNodeByPath`: the chain is a single
  // line, so following one child per level reaches `path` (or proves it absent).
  const chain: HierarchyNode[] = [];
  let node: HierarchyNode | undefined = root;
  while (node) {
    chain.push(node);
    if (node.path === path) {
      return chain;
    }
    node = childOnPath(node, path);
  }
  return [];
}

/** Module definitions of a hierarchy, keyed by instance path. */
export function defsByPath(index: HdlIndex, nodes: HierarchyNode[]): Map<string, ModuleDef> {
  const m = new Map<string, ModuleDef>();
  for (const n of nodes) {
    const def = index.resolveModule(n.moduleName);
    if (def) {
      m.set(n.path, def);
    }
  }
  return m;
}

/** Ports of a node, resolved from its module definition. */
export function portsOf(index: HdlIndex, node: HierarchyNode): PortDecl[] {
  const def = index.resolveModule(node.moduleName);
  return def ? def.ports : [];
}

/** Parameters of a node's module, with values from the node's scope. */
export function paramsOf(index: HdlIndex, node: HierarchyNode, scope: MapScope): { param: ParamDecl; value?: number }[] {
  const def = index.resolveModule(node.moduleName);
  if (!def) {
    return [];
  }
  return def.params.map((p) => ({ param: p, value: scope.get(p.name) ?? p.value?.value }));
}
