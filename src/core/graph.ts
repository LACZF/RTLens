/**
 * Connectivity graph construction.
 *
 * Produces a small, self-contained JSON model of "who drives what": instance
 * nodes, net nodes and the edges between them. The webview only needs this
 * structure plus a force-directed layout pass, which keeps the rendering
 * layer completely independent of the parser.
 */

import { generateScopedName, generateScopes } from './index';
import type { HdlIndex } from './index';
import type { HierarchyNode, ModuleDef, PortDir, PortDecl, Range } from './ast';
import { findInstance, paramScopeForPath } from './hierarchy';
import { evalExpression, rangeWidth, typeWidth, type FoldScope } from './fold';

export type GraphNodeKind = 'root' | 'instance' | 'net';
export type GraphEdgeKind = 'port' | 'net' | 'containment';

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** Instance path for instances, `<instancePath>::<signal>` for nets. */
  path: string;
  /** Module name (instances) or the net's scope path (nets). */
  moduleName?: string;
  file?: string;
  /** Instance statement range, used for click-to-jump. */
  range?: Range;
  nameRange?: Range;
  depth: number;
  direction?: 'input' | 'output' | 'inout';
  width?: number;
  truncated?: boolean;
  unresolved?: boolean;
  childCount?: number;
  /** Secondary label, e.g. the module name of an instance. */
  detail?: string;
  tooltip?: string;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: GraphEdgeKind;
  /** Port name on the instance node. */
  port?: string;
  /** Net / signal name. */
  signal?: string;
  direction?: 'input' | 'output' | 'inout';
  width?: number;
  /** Bit or part select as written, e.g. `[7:0]`. */
  select?: string;
  file?: string;
  range?: Range;
  dashed?: boolean;
  label?: string;
  /** The signal could not be found in the enclosing module. */
  unresolved?: boolean;
}

export interface GraphStats {
  nodes: number;
  edges: number;
  instances: number;
  nets: number;
  unresolvedInstances: number;
  unresolvedSignals: number;
  maxDepth: number;
  truncated: boolean;
}

export interface GraphIssue {
  severity: 'warning' | 'info';
  kind: 'unresolved-module' | 'unresolved-signal' | 'truncated' | 'empty-connection';
  message: string;
  file?: string;
  range?: Range;
  /** Instance or signal path the issue belongs to. */
  path: string;
}

export interface Graph {
  /** Instance path of the graph root. */
  root: string;
  rootModule: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: GraphStats;
  truncated: boolean;
  issues: GraphIssue[];
}

export interface GraphOptions {
  maxDepth?: number;
  maxNodes?: number;
  /** Draw an edge from a parent instance to each of its children. */
  showContainment?: boolean;
  /** Render the graph root itself as a node (default true). */
  includeRoot?: boolean;
  /** Skip `assign` edges; only keep instance port wiring. */
  portWiringOnly?: boolean;
}

const DEFAULT_MAX_NODES = 800;

interface NetInfo {
  width?: number;
  /**
   * Width of the whole net, when `width` is the width of a select of it. A node
   * is the net; the select belongs to the edge that reads or writes one element
   * of it, so `mem[1]` of a 32-bit `mem` is a node 32 bits wide and an edge 8
   * bits wide. It used to give the node the element width, so a net came out as
   * wide as the narrowest select of it.
   */
  netWidth?: number;
  file?: string;
  range?: Range;
  nameRange?: Range;
  direction?: 'input' | 'output' | 'inout';
  unresolved?: boolean;
  tooltip?: string;
}

class GraphBuilder {
  private nodes = new Map<string, GraphNode>();
  private edges: GraphEdge[] = [];
  private edgeIds = new Set<string>();
  private issues: GraphIssue[] = [];
  private unresolvedSignals = 0;
  /**
   * Paths whose expansion the graph itself stopped. Kept separately so that
   * building a graph never mutates the hierarchy it was given.
   */
  private readonly truncatedPaths = new Set<string>();
  private maxDepthSeen = 0;
  private overflowed = false;

  constructor(
    private readonly index: HdlIndex,
    private readonly opts: Required<GraphOptions>,
  ) {}

  build(root: HierarchyNode): Graph {
    // The root is the only node that exists before any instance is visited, so
    // it is added explicitly; containment edges then hang off it.
    if (this.opts.includeRoot) {
      this.addInstanceNode(root, true);
    }
    this.visit(root);
    this.nodes = this.prune(this.nodes);
    this.edges = this.edges.filter(
      (e) => this.nodes.has(e.from) && this.nodes.has(e.to) && e.from !== e.to,
    );

    const nodes = [...this.nodes.values()].sort((a, b) => cmp(a.path, b.path));
    this.edges.sort((a, b) => cmp(a.id, b.id));
    // Emitted after the walk: a node can be discovered before it is known to be
    // truncated, and an unresolved instance is reported once.
    for (const n of this.nodes.values()) {
      if (n.truncated) {
        this.issues.push({
          severity: 'info',
          kind: 'truncated',
          message: `Subtree under "${n.path}" was not expanded (depth or instance budget). Click it to zoom in.`,
          path: n.path,
        });
      }
    }
    const truncated = this.overflowed || nodes.some((n) => n.truncated);
    if (this.overflowed) {
      this.issues.push({
        severity: 'info',
        kind: 'truncated',
        message: `Graph truncated at ${this.opts.maxNodes} nodes. Zoom in on a subtree or raise "hdl.connectView.graph.maxNodes".`,
        path: root.path,
      });
    }

    return {
      root: root.path,
      rootModule: root.moduleName,
      nodes,
      edges: this.edges,
      stats: {
        nodes: nodes.length,
        edges: this.edges.length,
        instances: nodes.filter((n) => n.kind !== 'net').length,
        nets: nodes.filter((n) => n.kind === 'net').length,
        unresolvedInstances: nodes.filter((n) => n.unresolved).length,
        unresolvedSignals: this.unresolvedSignals,
        maxDepth: this.maxDepthSeen,
        truncated,
      },
      truncated,
      issues: this.issues,
    };
  }

  private static ids(path: string): string {
    return `i:${path}`;
  }

  private static netIds(scope: string, signal: string): string {
    return `n:${scope}::${signal}`;
  }

  /** Drop nodes beyond the budget, keeping the ones closest to the root. */
  private prune(input: Map<string, GraphNode>): Map<string, GraphNode> {
    if (input.size <= this.opts.maxNodes) {
      return input;
    }
    this.overflowed = true;
    const kept = [...input.values()].sort((a, b) => {
      if (a.depth !== b.depth) {
        return a.depth - b.depth;
      }
      return cmp(a.path, b.path);
    });
    return new Map(kept.slice(0, this.opts.maxNodes).map((n) => [n.id, n]));
  }

  private addInstanceNode(node: HierarchyNode, isRoot = false): void {
    const id = GraphBuilder.ids(node.path);
    const existing = this.nodes.get(id);
    if (existing) {
      // The node is already in the graph; refresh what later passes learned.
      existing.truncated =
        existing.truncated || !!node.truncated || this.truncatedPaths.has(node.path);
      existing.childCount = node.children?.length ?? existing.childCount;
      return;
    }
    this.nodes.set(id, {
      id,
      kind: isRoot ? 'root' : 'instance',
      label: node.instName,
      path: node.path,
      moduleName: node.moduleName,
      file: node.file,
      range: node.range,
      nameRange: node.nameRange,
      depth: node.depth,
      truncated: node.truncated || this.truncatedPaths.has(node.path),
      unresolved: node.unresolved,
      childCount: node.children?.length ?? 0,
      detail: node.moduleName,
      tooltip: node.unresolved
        ? `${node.instName} : ${node.moduleName} (module not found in the index)`
        : `${node.instName} : ${node.moduleName}`,
    });
    if (node.unresolved) {
      this.issues.push({
        severity: 'warning',
        kind: 'unresolved-module',
        message: `Module "${node.moduleName}" (instance "${node.instName}") was not found. It may live in an unindexed file, inside a macro, or in an inactive \`ifdef branch.`,
        file: node.file,
        range: node.moduleNameRange ?? node.nameRange,
        path: node.path,
      });
    }
  }

  private addNetNode(scope: string, signal: string, depth: number, info: NetInfo): string {
    const id = GraphBuilder.netIds(scope, signal);
    const width = info.netWidth ?? info.width;
    const existing = this.nodes.get(id);
    if (existing) {
      // A net touched by several ports keeps the widest width and any direction
      // discovered later.
      if (width !== undefined) {
        existing.width = Math.max(existing.width ?? 1, width);
      }
      if (info.direction) {
        if (!existing.direction) {
          existing.direction = info.direction;
        } else if (existing.direction !== info.direction) {
          // Read by one port and written by another: the net flows both ways.
          existing.direction = 'inout';
        }
      }
      if (info.unresolved) {
        existing.unresolved = true;
      }
      return id;
    }
    this.nodes.set(id, {
      id,
      kind: 'net',
      label: signal,
      path: `${scope}::${signal}`,
      moduleName: scope,
      file: info.file,
      range: info.range,
      nameRange: info.nameRange,
      depth,
      direction: info.direction,
      width,
      unresolved: info.unresolved,
      tooltip: info.tooltip,
    });
    return id;
  }

  private addEdge(e: Omit<GraphEdge, 'id'>): void {
    const id = `${e.from}>${e.to}:${e.kind}:${e.port ?? ''}:${e.signal ?? ''}:${e.select ?? ''}`;
    if (this.edgeIds.has(id)) {
      return;
    }
    this.edgeIds.add(id);
    this.edges.push({ id, ...e });
  }

  private visit(node: HierarchyNode): void {
    this.maxDepthSeen = Math.max(this.maxDepthSeen, node.depth);
    if (node.depth >= this.opts.maxDepth) {
      if (node.children?.length) {
        this.truncatedPaths.add(node.path);
        this.addInstanceNode(node);
      }
      return;
    }
    const parentDef = this.index.resolveModule(node.moduleName, node.file);
    if (parentDef) {
      // The node's own ports and continuous assigns belong to the graph even
      // when it has no instances at all.
      this.connectScope(node, parentDef);
    }
    for (const child of node.children ?? []) {
      if (this.nodes.size >= this.opts.maxNodes) {
        this.overflowed = true;
        this.truncatedPaths.add(node.path);
        return;
      }
      this.addInstanceNode(child);
      this.connectInstance(node, child, parentDef);
      if (this.opts.showContainment) {
        this.addEdge({
          from: GraphBuilder.ids(node.path),
          to: GraphBuilder.ids(child.path),
          kind: 'containment',
          label: child.moduleName,
          dashed: true,
        });
      }
      this.visit(child);
    }
  }

  /**
   * Add the ports and continuous assigns of the module that `node` instantiates.
   * Done once per visited node, so a leaf module still shows its own wiring.
   */
  private connectScope(node: HierarchyNode, def: ModuleDef): void {
    const scope = paramScopeForPath(this.index, node.path);
    for (const p of def.ports) {
      if (p.direction === 'ref') {
        continue;
      }
      this.addNetNode(node.path, p.name, node.depth, this.netInfo(def, p.name, scope));
    }
    if (!this.opts.portWiringOnly) {
      this.connectContinuousAssigns(node, def, scope);
    }
  }

  /** Wire one instance to the signals of its parent scope. */
  private connectInstance(
    parent: HierarchyNode,
    child: HierarchyNode,
    parentDef: ModuleDef | undefined,
  ): void {
    if (!parentDef) {
      return;
    }
    const inst = findInstance(parentDef, child.instName);
    if (!inst) {
      return;
    }
    const childDef = this.index.resolveModule(child.moduleName, child.file);
    // Nets of the parent scope: the ports and assigns of the instantiating
    // module, as seen with its own parameters bound.
    const scope = paramScopeForPath(this.index, parent.path);
    const childId = GraphBuilder.ids(child.path);

    for (const conn of inst.connections) {
      if (conn.empty) {
        this.issues.push({
          severity: 'info',
          kind: 'empty-connection',
          message: `Port ${conn.portName ? `.${conn.portName}` : ''} of "${child.instName}" is left unconnected.`,
          file: parentDef.file,
          range: conn.nameRange,
          path: child.path,
        });
        continue;
      }
      if (conn.shorthand && conn.portName === '*') {
        // `.*` binds every child port to the same-named signal of the parent.
        for (const p of childDef?.ports ?? []) {
          this.addNetNode(parent.path, p.name, parent.depth, this.netInfo(parentDef, p.name, scope));
          this.addEdge({
            from: GraphBuilder.netIds(parent.path, p.name),
            to: childId,
            kind: 'port',
            port: p.name,
            signal: p.name,
            direction: flowDir(p.direction),
            width: widthOfPort(p, scope),
            file: parentDef.file,
            range: inst.range,
          });
        }
        continue;
      }
      if (conn.shorthand) {
        // `.name` (SystemVerilog implicit port connection).
        const port = childDef?.ports.find((p) => p.name === conn.portName);
        this.addNetNode(parent.path, conn.portName, parent.depth, this.netInfo(parentDef, conn.portName, scope));
        this.addEdge({
          from: GraphBuilder.netIds(parent.path, conn.portName),
          to: childId,
          kind: 'port',
          port: conn.portName,
          signal: conn.portName,
          direction: flowDir(port?.direction),
          width: port ? widthOfPort(port, scope) : undefined,
          file: parentDef.file,
          range: inst.range,
        });
        continue;
      }

      const port = conn.portName ? childDef?.ports.find((p) => p.name === conn.portName) : undefined;
      if (conn.portName && !port) {
        this.issues.push({
          severity: 'warning',
          kind: 'unresolved-signal',
          message: `Instance "${child.instName}" has no port "${conn.portName}" in module "${child.moduleName}".`,
          file: parentDef.file,
          range: conn.nameRange,
          path: child.path,
        });
      }
      for (const ref of conn.refs) {
        const info = this.netInfo(parentDef, ref.fullPath, scope, ref.select);
        // Seen from this scope, the net flows opposite to the child port: an
        // input port of the child is fed from here, an output port feeds it.
        if (info.direction === undefined) {
          const flow = flowDir(port?.direction);
          info.direction = flow === 'output' ? 'input' : flow === 'input' ? 'output' : flow;
        }
        const netId = this.addNetNode(parent.path, ref.fullPath, parent.depth, info);
        this.addEdge({
          from: netId,
          to: childId,
          kind: 'port',
          port: conn.portName || undefined,
          signal: ref.fullPath,
          direction: flowDir(port?.direction),
          width: info.width ?? (port ? widthOfPort(port, scope) : undefined),
          select: ref.select,
          file: parentDef.file,
          range: conn.nameRange,
          unresolved: info.unresolved,
          label: conn.portName && conn.portName !== ref.fullPath ? conn.portName : undefined,
        });
        if (info.unresolved) {
          this.issues.push({
            severity: 'warning',
            kind: 'unresolved-signal',
            message: `Signal "${ref.fullPath}" in "${parent.path}" is not declared in module "${parentDef.name}".`,
            file: parentDef.file,
            range: conn.nameRange,
            path: `${parent.path}::${ref.fullPath}`,
          });
        }
      }
      if (conn.refs.length === 0) {
        this.issues.push({
          severity: 'info',
          kind: 'unresolved-signal',
          message: `Port ${conn.portName ? `.${conn.portName}` : ''} of "${child.instName}" is tied to a constant expression.`,
          file: parentDef.file,
          range: conn.nameRange,
          path: child.path,
        });
      }
    }

  }

  /**
   * `assign lhs = rhs;` and `always ... lhs <= rhs;` become a net -> net edge.
   *
   * A procedural assignment is not a wire, but it is the only thing that says
   * what a clocked design does: without it every register and every comb block
   * in the workspace showed up as a set of unconnected nets. The two are drawn
   * the same way and told apart by their label.
   */
  private connectContinuousAssigns(
    parent: HierarchyNode,
    def: ModuleDef,
    scope: FoldScope,
  ): void {
    for (const a of def.assigns) {
      // A function or task body assigns automatic variables. `tmp` there is not
      // a net of the module, so an edge from it would connect nothing.
      if (a.local) {
        continue;
      }
      for (const lhs of a.lhs) {
        const lhsInfo = this.netInfo(def, lhs.fullPath, scope, lhs.select);
        if (lhsInfo.unresolved) {
          continue;
        }
        const lhsId = this.addNetNode(parent.path, lhs.fullPath, parent.depth, lhsInfo);
        for (const rhs of a.rhs) {
          const rhsInfo = this.netInfo(def, rhs.fullPath, scope, rhs.select);
          if (rhsInfo.unresolved && rhs.kind === 'unknown') {
            continue;
          }
          const rhsId = this.addNetNode(parent.path, rhs.fullPath, parent.depth, rhsInfo);
          this.addEdge({
            from: rhsId,
            to: lhsId,
            kind: 'net',
            signal: rhs.fullPath,
            width: rhsInfo.width ?? lhsInfo.width,
            select: rhs.select,
            file: def.file,
            range: lhs.range,
            dashed: true,
            label: a.inAlways ? 'always' : 'assign',
          });
        }
      }
    }
  }

  /** Width / declaration site of a signal as seen in a module scope. */
  private netInfo(def: ModuleDef, name: string, scope: FoldScope, select?: string): NetInfo {
    const head = name.split('.')[0];
    let found = this.index.findDecl(def, head);
    if (!found) {
      // A generate block of this module: `g[0].t` names the copy of `t` that
      // the block declares, so it is a signal of the module and not a missing
      // one. Without this the node stayed unresolved, the edge was dropped and
      // whatever the assignment drove had no driver at all.
      const local = generateScopedName(name, generateScopes(def));
      const decl = local === undefined ? undefined : def.decls.find((d) => d.name === local);
      if (decl) {
        found = { kind: 'var', decl, owner: def };
      }
    }
    if (!found) {
      this.unresolvedSignals++;
      return { unresolved: true, tooltip: `${name} (not declared in ${def.name})` };
    }
    let width: number | undefined;
    if (found.kind === 'port') {
      width = widthOfPort(found.decl, scope);
    } else if (found.kind === 'var') {
      width = widthOfVar(found.decl, scope);
    }
    const netWidth = width;
    if (select) {
      const sliced = selectWidth(select, scope, width, stepWidthOfDecl(found, scope));
      if (sliced !== undefined) {
        width = sliced;
      }
    }
    return {
      width,
      netWidth: netWidth === width ? undefined : netWidth,
      file: def.file,
      range: found.decl.range,
      nameRange: found.decl.nameRange,
      direction: found.kind === 'port' ? flowDir(found.decl.direction) : undefined,
      tooltip: `${found.decl.name} : ${declTypeName(found)}`,
    };
  }
}

/** `ref` ports of SystemVerilog read *and* write, so they flow both ways. */
export function flowDir(d: PortDir | undefined): 'input' | 'output' | 'inout' | undefined {
  return d === 'ref' ? 'inout' : d;
}

function declTypeName(found: NonNullable<ReturnType<HdlIndex['findDecl']>>): string {
  const d = found.decl as { dataType?: { t: string } };
  return d.dataType?.t ?? 'unknown';
}

/**
 * Bits covered by one index of a declaration: the extra packed dimensions of
 * `logic [3:0][7:0]`, else the element width when the declaration is an unpacked
 * array, else a single bit.
 */
function stepWidthOfDecl(
  found: NonNullable<ReturnType<HdlIndex['findDecl']>>,
  scope: FoldScope,
): number {
  if (found.kind === 'port' || found.kind === 'var') {
    const packed = found.kind === 'port' ? found.decl.packed : found.decl.packedDims;
    const unpacked = found.kind === 'port' ? found.decl.unpacked : found.decl.dims;
    if (packed?.length) {
      let total = 1;
      for (const d of packed) {
        const n = rangeWidth(d, scope);
        if (n === undefined) return 1;
        total *= n;
      }
      return total;
    }
    if (unpacked?.length) {
      return typeWidth(found.decl.dataType, scope) ?? 1;
    }
  }
  return 1;
}

function widthOfPort(p: PortDecl, scope: FoldScope): number | undefined {
  let w = typeWidth(p.dataType, scope);
  // A port declared `logic [3:0][7:0]` is 32 bits, and the extra packed range is
  // part of the type just as the unpacked ones are.
  const dims = [...(p.packed ?? []), ...(p.unpacked ?? [])];
  if (dims.length) {
    let total = w ?? 1;
    for (const d of dims) {
      const n = rangeWidth(d, scope);
      if (n === undefined) {
        return undefined;
      }
      total *= n;
    }
    w = total;
  }
  return w;
}

function widthOfVar(
  v: { dataType: { t: string }; dims?: unknown[]; packedDims?: unknown[] },
  scope: FoldScope,
): number | undefined {
  let w = typeWidth(v.dataType, scope);
  const all = [...(v.packedDims ?? []), ...(v.dims ?? [])];
  if (all.length) {
    let total = w ?? 1;
    for (const d of all) {
      const n = rangeWidth(d as never, scope);
      if (n === undefined) {
        return undefined;
      }
      total *= n;
    }
    w = total;
  }
  return w;
}

/**
 * Width of `base[select]`, given the total width of `base` and `stepWidth`: the
 * number of bits one index of `base` covers.
 *
 * That is 1 for a flat vector, the width of the remaining packed dimensions for
 * `logic [3:0][7:0] buf` (`buf[2]` is one 8-bit row, not one bit), and the
 * element width for an unpacked array (`mem[1]` of `wire [7:0] mem [0:3]`).
 */
function selectWidth(
  select: string,
  scope: FoldScope,
  baseWidth?: number,
  stepWidth = 1,
): number | undefined {
  const inner = select.replace(/^\[/, '').replace(/\]$/, '').trim();
  const m = /^(.+?)\s*:\s*(.+)$/.exec(inner);
  if (m) {
    const hi = evalExpression(m[1], scope).value;
    const lo = evalExpression(m[2], scope).value;
    if (hi === undefined || lo === undefined) {
      return undefined;
    }
    return (Math.abs(hi - lo) + 1) * stepWidth;
  }
  if (/^\d+$/.test(inner)) {
    return stepWidth;
  }
  // Symbolic index: a single bit, or the whole vector when the select is on a
  // packed range of unknown width.
  return baseWidth ?? 1;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Build the connectivity graph rooted at a hierarchy node. */
export function buildGraph(index: HdlIndex, root: HierarchyNode, opts: GraphOptions = {}): Graph {
  const builder = new GraphBuilder(index, {
    maxDepth: opts.maxDepth ?? 8,
    maxNodes: opts.maxNodes ?? DEFAULT_MAX_NODES,
    showContainment: opts.showContainment ?? false,
    includeRoot: opts.includeRoot ?? true,
    portWiringOnly: opts.portWiringOnly ?? false,
  });
  return builder.build(root);
}
