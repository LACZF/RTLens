/**
 * Hierarchy construction.
 *
 * Turns the flat per-file module index into an instance tree rooted at a top
 * module. Expansion is lazy and bounded: depth limit, total node budget, and
 * cycle detection along the active path (a module that instantiates itself
 * through a parameter, or a generate loop that never terminates, would
 * otherwise expand forever).
 */

import type { HdlIndex } from './index';
import type { HierarchyNode, ModuleDef, ParamDecl, PortDecl } from './ast';
import { MapScope, rangeWidth, typeWidth } from './fold';

export interface HierarchyOptions {
  maxDepth?: number;
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

class Builder {
  private nodeCount = 0;
  private budget: number;
  private maxDepth: number;
  truncated = false;
  unresolved = 0;

  constructor(private readonly index: HdlIndex, opts: HierarchyOptions) {
    this.budget = opts.maxInstances ?? 20000;
    this.maxDepth = opts.maxDepth ?? 32;
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

  private expand(node: HierarchyNode, def: ModuleDef, pathModules: string[], scope: MapScope): void {
    const children: HierarchyNode[] = [];
    node.children = children;
    if (node.depth >= this.maxDepth) {
      // The depth limit cut this subtree off; say so on the node and on the
      // result, so callers can tell a leaf from an unexpanded instance.
      if (def.instances.length > 0) {
        node.truncated = true;
        this.truncated = true;
      }
      return;
    }
    for (const inst of def.instances) {
      if (this.nodeCount >= this.budget) {
        this.truncated = true;
        node.truncated = true;
        return;
      }
      this.nodeCount++;
      const instPath = inst.genPrefix ? `${inst.genPrefix}.${inst.name}` : inst.name;
      const childPath = node.path ? `${node.path}.${instPath}` : instPath;
      const childDef = this.index.resolveModule(inst.moduleName, def.file);
      const onPath = pathModules.includes(inst.moduleName);
      const child: HierarchyNode = {
        path: childPath,
        instName: instPath,
        moduleName: inst.moduleName,
        depth: node.depth + 1,
        parentPath: node.path,
        file: def.file,
        nameRange: inst.nameRange,
        moduleNameRange: inst.moduleNameRange,
        range: inst.range,
        children: [],
        unresolved: !childDef,
        cycle: onPath,
        generate: inst.genPrefix,
      };
      if (onPath) {
        child.truncated = true;
      } else {
        this.unresolved += childDef ? 0 : 1;
        if (childDef) {
          const childScope = this.childScope(scope, def, childDef, inst.paramOverrides);
          this.expand(child, childDef, [...pathModules, inst.moduleName], childScope);
        }
      }
      children.push(child);
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

/** Locate an instance by plain name or generate-prefixed name. */
export function findInstance(def: ModuleDef, segment: string) {
  return (
    def.instances.find((i) => i.name === segment) ??
    def.instances.find((i) => (i.genPrefix ? `${i.genPrefix}.${i.name}` : i.name) === segment)
  );
}

/** Build the instance tree for a top module. */
export function buildHierarchy(
  index: HdlIndex,
  moduleName: string,
  opts: HierarchyOptions = {},
  fromFile?: string,
): HierarchyResult | undefined {
  return new Builder(index, opts).build(moduleName, fromFile);
}

/**
 * The constant-folding scope in effect at a hierarchy path, i.e. the parameter
 * values visible there after applying `#(...)` overrides and `defparam`.
 */
export function paramScopeForPath(index: HdlIndex, path: string): MapScope {
  return new Builder(index, {}).paramScopeFor({ path } as HierarchyNode);
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

function findNodeByPath(root: HierarchyNode, path: string): HierarchyNode | undefined {
  if (root.path === path) {
    return root;
  }
  const prefix = root.path + '.';
  for (const c of root.children ?? []) {
    if (c.path === path || c.path.startsWith(prefix)) {
      const hit = findNodeByPath(c, path);
      if (hit) {
        return hit;
      }
    }
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

/** The chain of nodes from the root down to `path`, inclusive. */
export function pathChain(root: HierarchyNode, path: string): HierarchyNode[] {
  if (root.path === path) {
    return [root];
  }
  for (const c of root.children ?? []) {
    if (path === c.path || path.startsWith(c.path + '.')) {
      const head = pathChain(c, path);
      if (head.length) {
        return [root, ...head];
      }
    }
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
