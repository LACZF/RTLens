/**
 * Port-level topology model: one module read as a 3-column schematic.
 *
 * The picture reads left to right - the module's input ports, the modules it
 * instantiates, the module's output ports - and every wire is derived from net
 * identity, not from source order: two connections that name the same net are
 * the same wire, so `input -> instance`, `instance -> output`, a pass-through
 * `input -> output` and an `instance -> instance` hop all fall out of the same
 * walk.
 *
 * An `assign x = y;` whose right side is a single plain name is *net identity*
 * (a continuous assignment is a buffer, so the two names are one net); any
 * other assignment is a real data-flow hop and the wire it produces is drawn as
 * an expression edge carrying its right-hand side as the label. That keeps a
 * `assign carry = dp_carry;` a plain port wire while still showing that
 * `carry` comes from a multiplexer.
 *
 * Pure: no `vscode`, never throws. A shape the parser could not make sense of
 * becomes a warning on the model, never an exception.
 */

import type { InstanceSite, ModuleDef, PortDecl, PortDir, Range, RefSite } from './ast';
import type { HdlIndex } from './index';
import { entryOf, type HierarchyEntry } from './hierarchy';
import { evalExpression, rangeWidth, typeWidth } from './fold';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type TopoSide = 'input' | 'output';

export interface TopoSignal {
  /** Port name as written in the module header. */
  name: string;
  /** The internal net it connects to (differs for `.ext(internal)`). */
  declName: string;
  side: TopoSide;
  direction: PortDir;
  /** Folded bit width, when statically known. */
  width?: number;
  /** Module file - the port is declared in the header. */
  file: string;
  range: Range;
  nameRange: Range;
}

export interface TopoChildPort {
  /** Port name on the child module. */
  name: string;
  side: TopoSide;
  direction: PortDir;
  width?: number;
  /** False for `.p()` or a port the instantiation never names. */
  connected: boolean;
}

export interface TopoChild {
  /** Unique inside the frame: the instance name, generate prefix included. */
  id: string;
  instName: string;
  moduleName: string;
  /** Set when the child module resolves in the workspace. */
  defFile?: string;
  file: string;
  range: Range;
  nameRange: Range;
  moduleNameRange: Range;
  resolved: boolean;
  /** `#(...)` overrides, formatted `WIDTH=8, DEPTH=4`. */
  params?: string;
  /** Arrayed instance text, e.g. `[3:0]`. */
  array?: string;
  generated?: boolean;
  conditional?: boolean;
  ports: TopoChildPort[];
}

export type TopoEndpoint =
  | { kind: 'signal'; name: string }
  | { kind: 'child'; child: string; port: string; side: TopoSide };

export interface TopoEdge {
  from: TopoEndpoint;
  to: TopoEndpoint;
  /** `port` = direct net; `expression` = crosses a non-alias assignment. */
  kind: 'port' | 'expression';
  /** RHS text of the assignment that created an `expression` edge. */
  label?: string;
  /** Bit-select text on the parent-side connection, e.g. `[3:0]`. */
  select?: string;
  width?: number;
}

export interface TopoAncestor {
  /** Dotted instance path of the ancestor from the design top. */
  path: string;
  moduleName: string;
  /** Ancestor module definition. */
  file: string;
  nameRange: Range;
  /** Instantiation site of the ancestor's child on the path. */
  instFile?: string;
  instRange?: Range;
}

export interface TopoWarning {
  message: string;
  file?: string;
  range?: Range;
}

export interface ModuleTopology {
  moduleName: string;
  file: string;
  nameRange: Range;
  /** Dotted instance path from the design top; equals the module name at the top. */
  path: string;
  /** Design top module name. */
  top: string;
  /** Top first, excluding this module. */
  ancestors: TopoAncestor[];
  inputs: TopoSignal[];
  outputs: TopoSignal[];
  children: TopoChild[];
  edges: TopoEdge[];
  warnings: TopoWarning[];
}

export interface TopologyOptions {
  /** Modules left out: they get no box and take their wires with them. */
  filterModules?: string[];
  /** Preferred roots for the ancestor walk. */
  topModules?: string[];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** The local instance id: generate prefix included, `[i]` already in `name`. */
function localId(inst: InstanceSite): string {
  return inst.genPrefix ? `${inst.genPrefix}.${inst.name}` : inst.name;
}

/** One id per instance site, disambiguated the same way in the builder and the tree walk. */
function instanceIds(mod: ModuleDef, filter: string[] | undefined): Map<InstanceSite, string> {
  const used = new Set<string>();
  const out = new Map<InstanceSite, string>();
  for (const inst of mod.instances) {
    if (filter?.includes(inst.moduleName)) {
      continue;
    }
    const base = localId(inst);
    let id = base;
    for (let n = 2; used.has(id); n++) {
      id = `${base}#${n}`;
    }
    used.add(id);
    out.set(inst, id);
  }
  return out;
}

/** The net a reference names, select included. Undefined for non-signals. */
function netKey(ref: RefSite): string | undefined {
  if (ref.system || ref.isDecl) {
    return undefined;
  }
  if (ref.kind !== 'signal' && ref.kind !== 'unknown') {
    return undefined;
  }
  const base = ref.pathSuffix ? ref.fullPath : ref.name;
  return ref.select ? `${base}${ref.select}` : base;
}

function isAlias(lhs: RefSite[], rhs: RefSite[], rhsText: string): boolean {
  if (lhs.length !== 1 || rhs.length !== 1) {
    return false;
  }
  const l = lhs[0];
  const r = rhs[0];
  if (l.pathSuffix || r.pathSuffix || l.select || r.select) {
    return false;
  }
  if (netKey(l) === undefined || netKey(r) === undefined) {
    return false;
  }
  // `assign x = y;` is identity; `assign x = ~y;` is not.
  return rhsText.trim() === r.name;
}

/** Union-find over net keys, with the lexicographically smaller key as root. */
class NetGroups {
  private readonly parent = new Map<string, string>();

  find(key: string): string {
    let root = key;
    for (;;) {
      const p = this.parent.get(root);
      if (p === undefined || p === root) {
        break;
      }
      root = p;
    }
    // Path compression, iteratively: an assign chain can be long.
    let cur = key;
    for (;;) {
      const p = this.parent.get(cur);
      if (p === undefined) {
        this.parent.set(cur, root);
        break;
      }
      if (p === root) {
        break;
      }
      this.parent.set(cur, root);
      cur = p;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) {
      return;
    }
    if (ra < rb) {
      this.parent.set(rb, ra);
    } else {
      this.parent.set(ra, rb);
    }
  }
}

/** Port width: packed dims, then unpacked dims, folded through the scope. */
function portWidth(p: PortDecl, scope: ReturnType<HdlIndex['scopeFor']>): number | undefined {
  let w = typeWidth(p.dataType, scope);
  for (const r of [...(p.packed ?? []), ...(p.unpacked ?? [])]) {
    const n = rangeWidth(r, scope);
    if (n === undefined) {
      return undefined;
    }
    w = (w ?? 1) * n;
  }
  return w;
}

function ordered(ports: PortDecl[], order: string[]): PortDecl[] {
  const index = new Map<string, number>();
  order.forEach((name, i) => index.set(name, i));
  return ports
    .map((p, i) => ({ p, i, key: index.get(p.name) }))
    .sort((a, b) => {
      const ak = a.key ?? Number.MAX_SAFE_INTEGER;
      const bk = b.key ?? Number.MAX_SAFE_INTEGER;
      return ak !== bk ? ak - bk : a.i - b.i;
    })
    .map((x) => x.p);
}

function signalOf(mod: ModuleDef, p: PortDecl, scope: ReturnType<HdlIndex['scopeFor']>, side: TopoSide): TopoSignal {
  return {
    name: p.name,
    declName: p.declName,
    side,
    direction: p.direction,
    width: portWidth(p, scope),
    file: mod.file,
    range: p.range,
    nameRange: p.nameRange,
  };
}

/** Keys a module port is reachable by: the header name and the internal net. */
function portKeys(p: PortDecl): string[] {
  return p.declName === p.name ? [p.name] : [p.name, p.declName];
}

function paramText(
  inst: InstanceSite,
  child: ModuleDef | undefined,
  parentScope: ReturnType<HdlIndex['scopeFor']>,
): string | undefined {
  if (inst.paramOverrides.length === 0) {
    return undefined;
  }
  const parts = inst.paramOverrides.map((o, i) => {
    const name = o.name ?? child?.params[i]?.name ?? `#${i}`;
    // `.WIDTH(WIDTH)` is folded through the parent, so the picture reads
    // `WIDTH=8` rather than the tautology `WIDTH=WIDTH`.
    const value = o.expr.value ?? evalExpression(o.expr.raw, parentScope).value;
    return `${name}=${value !== undefined ? value : o.expr.raw}`;
  });
  return parts.join(', ');
}

function arrayText(inst: InstanceSite): string | undefined {
  const r = inst.arrayCount;
  return r ? `[${r.msb.raw}:${r.lsb.raw}]` : undefined;
}

function endpointKey(ep: TopoEndpoint): string {
  return ep.kind === 'signal' ? `s\u0000${ep.name}` : `c\u0000${ep.child}\u0000${ep.port}\u0000${ep.side}`;
}

function childScope(index: HdlIndex, def: ModuleDef, inst: InstanceSite): ReturnType<HdlIndex['scopeFor']> {
  const overrides = new Map<string, number>();
  inst.paramOverrides.forEach((o, i) => {
    const name = o.name ?? def.params[i]?.name;
    const value = o.expr.value;
    if (name !== undefined && value !== undefined) {
      overrides.set(name, value);
    }
  });
  return index.scopeFor(def, overrides);
}

// ---------------------------------------------------------------------------
// Ancestors
// ---------------------------------------------------------------------------

function ancestorChain(index: HdlIndex, entry: HierarchyEntry | undefined, fromFile: string): TopoAncestor[] {
  if (!entry || entry.segs.length === 0) {
    return [];
  }
  // `segs` is bottom-up; turn it into the top-down instance order.
  const insts: InstanceSite[] = [];
  for (let i = entry.segs.length - 1; i >= 0; i--) {
    insts.push(entry.segs[i].inst);
  }
  const out: TopoAncestor[] = [];
  for (let i = 0; i < entry.segs.length; i++) {
    // Ancestor `i` is the module at level `i`; the instance leaving it is
    // `insts[i]`, and that instance's parent is the ancestor itself.
    const moduleName = entry.segs[entry.segs.length - 1 - i].parent;
    const def = index.resolveModule(moduleName, fromFile);
    const path = i === 0
      ? entry.top
      : `${entry.top}.${insts.slice(0, i).map((x) => localId(x)).join('.')}`;
    const site = insts[Math.min(i, insts.length - 1)];
    out.push({
      path,
      moduleName,
      file: def?.file ?? fromFile,
      nameRange: def?.nameRange ?? site.nameRange,
      instFile: def?.file ?? fromFile,
      instRange: site.range,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Connection normalisation
// ---------------------------------------------------------------------------

interface Conn {
  port: PortDecl;
  net?: string;
  select?: string;
  rawExpr: string;
  named: boolean;
}

function connOf(port: PortDecl, conn: InstanceSite['connections'][number]): Conn {
  const ref = conn.empty ? undefined : conn.refs[0];
  return {
    port,
    net: ref ? netKey(ref) : undefined,
    select: ref?.select,
    rawExpr: conn.rawExpr,
    named: true,
  };
}

/**
 * One connection per child port: positional lists, named lists, `.name`
 * shorthand and `.*` all collapse to `port -> parent net`.
 */
function normalise(inst: InstanceSite, child: ModuleDef | undefined): Conn[] {
  if (!child) {
    return [];
  }
  const byName = new Map<string, PortDecl>();
  for (const p of child.ports) {
    byName.set(p.name, p);
  }
  const conns: Conn[] = [];
  const seen = new Set<string>();

  if (inst.positional) {
    inst.connections.forEach((c, i) => {
      const name = child.portOrder[i];
      const port = name !== undefined ? byName.get(name) : undefined;
      if (!port || seen.has(port.name)) {
        return;
      }
      seen.add(port.name);
      conns.push(connOf(port, c));
    });
  } else {
    for (const c of inst.connections) {
      if (c.portName === '*' || c.portName === '') {
        continue;
      }
      const port = byName.get(c.portName);
      if (!port || seen.has(port.name)) {
        continue;
      }
      seen.add(port.name);
      conns.push(connOf(port, c));
    }
    // `.*` connects every port not named explicitly to its own name.
    if (inst.connections.some((c) => c.portName === '*')) {
      for (const p of child.ports) {
        if (seen.has(p.name)) {
          continue;
        }
        seen.add(p.name);
        conns.push({ port: p, net: p.name, rawExpr: p.name, named: true });
      }
    }
  }
  return conns;
}

// ---------------------------------------------------------------------------
// buildModuleTopology
// ---------------------------------------------------------------------------

export function buildModuleTopology(
  index: HdlIndex,
  mod: ModuleDef,
  opts: TopologyOptions = {},
): ModuleTopology {
  const entry = entryOf(index, mod.name, mod.file, opts.topModules ?? []);
  const model: ModuleTopology = {
    moduleName: mod.name,
    file: mod.file,
    nameRange: mod.nameRange,
    path: entry?.path ?? mod.name,
    top: entry?.top ?? mod.name,
    ancestors: ancestorChain(index, entry, mod.file),
    inputs: [],
    outputs: [],
    children: [],
    edges: [],
    warnings: [],
  };
  if (mod.kind !== 'module') {
    model.warnings.push({
      message: `${mod.kind} ${mod.name} has no module-level topology`,
      file: mod.file,
      range: mod.nameRange,
    });
    return model;
  }

  const scope = index.scopeFor(mod);
  const ports = ordered(mod.ports, mod.portOrder);
  for (const p of ports) {
    if (p.direction === 'output') {
      model.outputs.push(signalOf(mod, p, scope, 'output'));
    } else {
      model.inputs.push(signalOf(mod, p, scope, 'input'));
    }
  }

  // --- children + connections ---------------------------------------------
  const ids = instanceIds(mod, opts.filterModules);
  const unresolved = new Set<string>();
  let sawHierarchical = false;
  const childById = new Map<string, TopoChild>();
  const connsById = new Map<string, Conn[]>();

  for (const inst of mod.instances) {
    const id = ids.get(inst);
    if (id === undefined) {
      continue;
    }
    const resolved = index.resolveModule(inst.moduleName, mod.file);
    const def = resolved;
    const child: TopoChild = {
      id,
      instName: inst.name,
      moduleName: inst.moduleName,
      defFile: def?.file,
      file: mod.file,
      range: inst.range,
      nameRange: inst.nameRange,
      moduleNameRange: inst.moduleNameRange,
      resolved: def !== undefined,
      params: paramText(inst, def, scope),
      array: arrayText(inst),
      generated: inst.inGenerate || undefined,
      conditional: inst.conditional || undefined,
      ports: [],
    };
    if (!def) {
      if (!unresolved.has(inst.moduleName)) {
        unresolved.add(inst.moduleName);
        model.warnings.push({
          message: `module ${inst.moduleName} is not indexed; its connections are not drawn`,
          file: mod.file,
          range: inst.moduleNameRange,
        });
      }
    }

    const conns = normalise(inst, def);
    connsById.set(id, conns);
    if (def) {
      const cscope = childScope(index, def, inst);
      const connByPortName = new Map<string, Conn>();
      for (const c of conns) {
        if (!connByPortName.has(c.port.name)) {
          connByPortName.set(c.port.name, c);
        }
      }
      // Declared port order first, then any port the instantiation names that
      // the definition does not declare (the parser tolerates such a mismatch).
      for (const p of ordered(def.ports, def.portOrder)) {
        const c = connByPortName.get(p.name);
        if (!c) {
          continue;
        }
        connByPortName.delete(p.name);
        child.ports.push({
          name: p.name,
          side: p.direction === 'output' ? 'output' : 'input',
          direction: p.direction,
          width: portWidth(p, cscope),
          connected: c.net !== undefined,
        });
      }
      for (const c of connByPortName.values()) {
        child.ports.push({
          name: c.port.name,
          side: c.port.direction === 'output' ? 'output' : 'input',
          direction: c.port.direction,
          width: portWidth(c.port, cscope),
          connected: c.net !== undefined,
        });
      }
    }
    for (const c of conns) {
      // A parent-side reference like `u_alu.result` cannot be resolved to a row
      // in this frame; it is tracked as an opaque net and reported once.
      if (c.net !== undefined && c.select === undefined && c.rawExpr.includes('.')) {
        sawHierarchical = true;
      }
    }
    childById.set(id, child);
    model.children.push(child);
  }

  if (sawHierarchical) {
    model.warnings.push({
      message: 'hierarchical connection references are treated as opaque nets',
      file: mod.file,
    });
  }

  // --- net identity --------------------------------------------------------
  const nets = new NetGroups();
  const flow: { from: string; to: string; label: string }[] = [];

  for (const a of mod.assigns) {
    if (a.local || a.lhs.length === 0 || a.rhs.length === 0) {
      continue;
    }
    const lhsKeys: string[] = [];
    for (const r of a.lhs) {
      const k = netKey(r);
      if (k !== undefined && !lhsKeys.includes(k)) {
        lhsKeys.push(k);
      }
    }
    const rhsKeys: string[] = [];
    for (const r of a.rhs) {
      const k = netKey(r);
      if (k !== undefined && !rhsKeys.includes(k)) {
        rhsKeys.push(k);
      }
    }
    if (lhsKeys.length === 0 || rhsKeys.length === 0) {
      continue;
    }
    if (isAlias(a.lhs, a.rhs, a.rhsText)) {
      nets.union(lhsKeys[0], rhsKeys[0]);
      continue;
    }
    for (const from of rhsKeys) {
      for (const to of lhsKeys) {
        flow.push({ from, to, label: a.rhsText });
      }
    }
  }

  // --- sources and sinks ---------------------------------------------------
  const sources = new Map<string, TopoEndpoint[]>();
  const sinks = new Map<string, TopoEndpoint[]>();
  const selects = new Map<string, string>();

  const add = (map: Map<string, TopoEndpoint[]>, key: string, ep: TopoEndpoint) => {
    const group = nets.find(key);
    const list = map.get(group);
    if (!list) {
      map.set(group, [ep]);
      return;
    }
    if (!list.some((x) => endpointKey(x) === endpointKey(ep))) {
      list.push(ep);
    }
  };

  for (const p of ports) {
    if (p.direction === 'output') {
      const ep: TopoEndpoint = { kind: 'signal', name: p.name };
      for (const k of portKeys(p)) {
        add(sinks, k, ep);
      }
    } else {
      const ep: TopoEndpoint = { kind: 'signal', name: p.name };
      for (const k of portKeys(p)) {
        add(sources, k, ep);
      }
    }
  }

  for (const child of model.children) {
    for (const c of connsById.get(child.id) ?? []) {
      if (c.net === undefined) {
        continue;
      }
      const ep: TopoEndpoint =
        c.port.direction === 'output'
          ? { kind: 'child', child: child.id, port: c.port.name, side: 'output' }
          : { kind: 'child', child: child.id, port: c.port.name, side: 'input' };
      if (c.select !== undefined) {
        selects.set(endpointKey(ep), c.select);
      }
      add(c.port.direction === 'output' ? sources : sinks, c.net, ep);
    }
  }

  // --- walk sources forward ------------------------------------------------
  const adj = new Map<string, { to: string; label: string }[]>();
  for (const f of flow) {
    const from = nets.find(f.from);
    const to = nets.find(f.to);
    const list = adj.get(from);
    if (list) {
      list.push({ to, label: f.label });
    } else {
      adj.set(from, [{ to, label: f.label }]);
    }
  }

  const HOP_CAP = 64;
  const NET_CAP = 512;
  const chosen = new Map<string, { edge: TopoEdge; depth: number }>();

  const widthOf = (ep: TopoEndpoint): number | undefined => {
    if (ep.kind === 'signal') {
      const sig = model.inputs.find((s) => s.name === ep.name) ?? model.outputs.find((s) => s.name === ep.name);
      return sig?.width;
    }
    const child = childById.get(ep.child);
    return child?.ports.find((p) => p.name === ep.port && p.side === ep.side)?.width;
  };

  const emit = (from: TopoEndpoint, to: TopoEndpoint, depth: number, labels: string[]) => {
    if (endpointKey(from) === endpointKey(to)) {
      return;
    }
    if (from.kind === 'child' && to.kind === 'child' && from.child === to.child && from.port === to.port) {
      return;
    }
    const key = `${endpointKey(from)}\u0001${endpointKey(to)}`;
    const prior = chosen.get(key);
    if (prior && prior.depth <= depth) {
      return;
    }
    const edge: TopoEdge = {
      from,
      to,
      kind: depth === 0 ? 'port' : 'expression',
      label: depth === 0 ? undefined : labels.length ? labels.slice(0, 3).join(' · ') + (labels.length > 3 ? ' · …' : '') : undefined,
      select: selects.get(endpointKey(from)) ?? selects.get(endpointKey(to)),
      width: widthOf(to.kind === 'signal' ? to : from),
    };
    chosen.set(key, { edge, depth });
  };

  for (const [start, eps] of sources) {
    const visits = new Map<string, { depth: number; labels: string[] }>();
    visits.set(start, { depth: 0, labels: [] });
    const queue: string[] = [start];
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      const v = visits.get(cur);
      if (!v || v.depth >= HOP_CAP) {
        continue;
      }
      for (const e of adj.get(cur) ?? []) {
        if (visits.has(e.to) || visits.size >= NET_CAP) {
          continue;
        }
        visits.set(e.to, { depth: v.depth + 1, labels: [...v.labels, e.label] });
        queue.push(e.to);
      }
    }
    for (const ep of eps) {
      for (const [net, v] of visits) {
        for (const sink of sinks.get(net) ?? []) {
          emit(ep, sink, v.depth, v.labels);
        }
      }
    }
  }

  const edges = [...chosen.values()].map((c) => c.edge);
  edges.sort((a, b) => {
    const ka = `${a.from.kind}\u0000${a.from.kind === 'signal' ? a.from.name : `${a.from.child}\u0000${a.from.port}`}`;
    const kb = `${b.from.kind}\u0000${b.from.kind === 'signal' ? b.from.name : `${b.from.child}\u0000${b.from.port}`}`;
    if (ka !== kb) {
      return ka < kb ? -1 : 1;
    }
    const ta = `${a.to.kind}\u0000${a.to.kind === 'signal' ? a.to.name : `${a.to.child}\u0000${a.to.port}`}`;
    const tb = `${b.to.kind}\u0000${b.to.kind === 'signal' ? b.to.name : `${b.to.child}\u0000${b.to.port}`}`;
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
  model.edges = edges;
  return model;
}

// ---------------------------------------------------------------------------
// Frame tree
// ---------------------------------------------------------------------------

export interface TopologyFrame {
  /** Dotted instance path from the design top; unique inside the tree. */
  key: string;
  moduleName: string;
  file: string;
  /** Parent frame key, absent for the generation root. */
  parent?: string;
  /** Child frame keys, in source order. */
  children: string[];
  model: ModuleTopology;
}

export interface TopologyTree {
  /** Design top module name. */
  top: string;
  rootKey: string;
  /** Root first, then depth-first in source order. */
  frames: TopologyFrame[];
  /** Set when `maxDepth` / `maxFrames` / a cycle cut the tree short. */
  truncated: boolean;
  warnings: TopoWarning[];
}

export interface TreeOptions extends TopologyOptions {
  /** Descendant levels below the root; 0 or omitted means no limit. */
  maxDepth?: number;
  /** Frame budget; 0 or omitted means no limit. */
  maxFrames?: number;
}

/**
 * One frame per module occurrence below `moduleName`, keyed by instance path so
 * two branches instantiating the same module get two frames.
 */
export function buildTopologyTree(
  index: HdlIndex,
  moduleName: string,
  fromFile?: string,
  opts: TreeOptions = {},
): TopologyTree | undefined {
  const entry = entryOf(index, moduleName, fromFile, opts.topModules ?? []);
  const rootDef = index.resolveModule(moduleName, fromFile);
  if (!entry || !rootDef) {
    return undefined;
  }
  const maxDepth = opts.maxDepth !== undefined && opts.maxDepth > 0 ? opts.maxDepth : Infinity;
  const maxFrames = opts.maxFrames !== undefined && opts.maxFrames > 0 ? opts.maxFrames : Infinity;

  const frames: TopologyFrame[] = [];
  const warnings: TopoWarning[] = [];
  let truncated = false;

  const root: TopologyFrame = {
    key: entry.path,
    moduleName: rootDef.name,
    file: rootDef.file,
    children: [],
    model: buildModuleTopology(index, rootDef, opts),
  };
  frames.push(root);

  const walk = (frame: TopologyFrame, def: ModuleDef, depth: number, onPath: Set<string>, insts: Map<InstanceSite, string>) => {
    for (const child of frame.model.children) {
      if (depth + 1 > maxDepth) {
        truncated = true;
        continue;
      }
      if (frames.length >= maxFrames) {
        truncated = true;
        return;
      }
      let site: InstanceSite | undefined;
      for (const [inst, id] of insts) {
        if (id === child.id) {
          site = inst;
          break;
        }
      }
      if (!site) {
        continue;
      }
      const resolved = index.resolveModule(child.moduleName, def.file);
      if (!resolved) {
        continue;
      }
      const key = `${frame.key}.${child.id}`;
      const model = buildModuleTopology(index, resolved, opts);
      model.path = key;
      model.top = entry.top;
      model.ancestors = [
        ...frame.model.ancestors,
        {
          path: frame.key,
          moduleName: frame.moduleName,
          file: frame.file,
          nameRange: frame.model.nameRange,
          instFile: frame.file,
          instRange: site.range,
        },
      ];
      const next: TopologyFrame = {
        key,
        moduleName: resolved.name,
        file: resolved.file,
        parent: frame.key,
        children: [],
        model,
      };
      frame.children.push(key);
      frames.push(next);
      if (onPath.has(resolved.name)) {
        warnings.push({
          message: `cycle: ${resolved.name} instantiates itself through ${key}`,
          file: resolved.file,
          range: resolved.nameRange,
        });
        continue;
      }
      onPath.add(resolved.name);
      walk(next, resolved, depth + 1, onPath, instanceIds(resolved, opts.filterModules));
      onPath.delete(resolved.name);
    }
  };

  walk(root, rootDef, 0, new Set([rootDef.name]), instanceIds(rootDef, opts.filterModules));
  return { top: entry.top, rootKey: entry.path, frames, truncated, warnings };
}
