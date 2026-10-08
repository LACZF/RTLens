/**
 * Wrapper module generation.
 *
 * Two complementary operations, both producing plain, compilable Verilog-2001
 * that can be dropped into a library, re-indexed and composed again later:
 *
 * - `flattenModule()`  inlines the *contents* of one hierarchy node into a new
 *   standalone module: its parameters become localparams, its nets and
 *   continuous assignments are re-emitted, and its children are instantiated
 *   verbatim. This is the "extract this block as a reusable module" action.
 * - `composeModule()`  keeps one or more sibling instances as instances and
 *   only rebuilds the wiring around them, exposing the signals the selection
 *   touches. This is the "group these blocks" action.
 *
 * Procedural logic (always blocks, initial blocks) is never moved between
 * modules, so the operations refuse to flatten a module whose body it cannot
 * reproduce, and it falls back to a port-forwarding stub.
 */

import type { HdlIndex } from './index';
import type { AssignSite, HierarchyNode, InstanceSite, ModuleDef, PortConn, Range, VarDecl, ValueRange } from './ast';
import { findByPath, findInstance, paramScopeForPath, subtree } from './hierarchy';
import { tokenize } from './lexer';
import { rangeWidth, typeWidth, type FoldScope } from './fold';

export type WrapperDirection = 'input' | 'output' | 'inout';

export interface WrapperPort {
  name: string;
  direction: WrapperDirection;
  /** Bit width when it could be folded. */
  width?: number;
  /** Part select as written in the parent, e.g. `[3:0]`. */
  select?: string;
  /** `wire`, `logic`, `reg`, ... as declared in the parent. */
  netType: string;
  /** True when the name is a port of the original parent module. */
  isParentPort: boolean;
  /** Instances touching this signal. */
  usedBy: string[];
  note?: string;
}

export interface WrapperInstance {
  /** Sanitised identifier used in the generated code. */
  ident: string;
  /** Instance path in the source hierarchy. */
  path: string;
  moduleName: string;
  file: string;
  range: Range;
  /** Verbatim `#(...)` text including the hash, empty when no overrides. */
  paramText: string;
  /** Verbatim `.p(expr)` connection text. */
  connText: string;
}

export interface WrapperGenerateOptions {
  /** Module name of the generated file. */
  moduleName?: string;
  /** Emit the banner comment block. */
  banner?: boolean;
  /** Copy continuous assignments of the parent scope (default true). */
  includeAssigns?: boolean;
  /** Spaces per indent level. */
  indent?: string;
  /** Source path of the selection's parent module, for the banner. */
  sourceModule?: string;
}

export interface WrapperResult {
  ok: true;
  moduleName: string;
  /** Suggested file name. */
  fileName: string;
  ports: WrapperPort[];
  /** Signals kept as internal wires. */
  internalNets: WrapperPort[];
  instances: number;
  /** Instance list with verbatim re-emission data. */
  instanceInfo: WrapperInstance[];
  assigns: string[];
  warnings: string[];
  code: string;
}

export interface WrapperFailure {
  ok: false;
  error: string;
  /** Set when a port-forwarding stub would be a valid alternative. */
  fallback?: 'stub';
}

export type GenerateResult = WrapperResult | WrapperFailure;

interface SignalState {
  /** Driven inside the selection: an instance output port or a copied assign. */
  produced: boolean;
  /** Read inside the selection: an instance input port or a copied assign. */
  consumed: boolean;
  /** `produced` came from a copied continuous assign, not an instance. */
  fromAssign: boolean;
  usedBy: Set<string>;
  selects: Set<string>;
}

/** Normalise a port direction for data flow. */
function flowDir(d: string | undefined): WrapperDirection | undefined {
  if (d === 'input') return 'input';
  if (d === 'output') return 'output';
  if (d === 'inout' || d === 'ref') return 'inout';
  return undefined;
}

export function sanitizeIdent(raw: string): string {
  const s = raw.replace(/[^A-Za-z0-9_$]/g, '_');
  return /^[0-9]/.test(s) ? `_${s}` : s;
}

/** Turn `top.u_dpath.u_adder[0]` into `u_dpath_u_adder_0`. */
export function flattenInstanceName(prefix: string, rawName: string): string {
  const cleaned = rawName.replace(/\[/g, '_').replace(/\]/g, '');
  return sanitizeIdent(cleaned ? `${prefix}_${cleaned}` : prefix);
}

/**
 * Group a set of sibling instances into a new module.
 *
 * @param paths Instance paths relative to the hierarchy root. All of them must
 *   live in the same parent scope so their signals share a namespace.
 */
export function composeModule(
  index: HdlIndex,
  root: HierarchyNode,
  paths: string[],
  opts: WrapperGenerateOptions = {},
): GenerateResult {
  const selection = paths.filter(Boolean);
  if (selection.length === 0) {
    return { ok: false, error: 'No instance selected.' };
  }

  const nodes: HierarchyNode[] = [];
  for (const p of selection) {
    const n = findByPath(root, p);
    if (!n) {
      return { ok: false, error: `Instance path "${p}" is not part of the expanded hierarchy. It may be inside an unexpanded generate block.` };
    }
    if (n.depth === root.depth) {
      return { ok: false, error: `"${p}" is the graph root itself; there is nothing to wrap around it.` };
    }
    nodes.push(n);
  }

  // Every selected instance must live in the same parent scope; otherwise the
  // signals they touch do not share a namespace and composition is meaningless.
  // A generate block is not a scope of its own - it has no module - so the
  // parent of `top.u.g[0].u` is `top.u`: the instance that owns the wiring.
  const parents = nodes.map((n) => enclosingNode(root, n.path));
  if (parents.some((p) => !p)) {
    return { ok: false, error: 'No instance selected.' };
  }
  const parentPaths = new Set(parents.map((p) => p!.path));
  if (parentPaths.size > 1) {
    return {
      ok: false,
      error: `Selected instances live in different scopes (${[...parentPaths].join(', ')}). Select instances that share a parent module, or wrap them one at a time.`,
    };
  }
  const parentPath = [...parentPaths][0];
  const parentNode = parents[0]!;
  if (!parentNode) {
    return { ok: false, error: `Parent instance "${parentPath}" was not found.` };
  }
  const parentDef = index.resolveModule(parentNode.moduleName, parentNode.file);
  if (!parentDef) {
    return { ok: false, error: `Module definition for "${parentNode.moduleName}" was not found in the index.` };
  }
  const scope = paramScopeForPath(index, parentPath);

  // A selection inside a generate block cannot reproduce the value of the loop
  // variable: the wiring of one iteration reads `i`, so the generated module
  // would have to say `w[1]` instead. Nothing in the index holds that
  // substitution, so refuse rather than emit a module that does not compile -
  // the stub of the instance is the useful output for such a selection.
  for (const node of nodes) {
    if (!node.generate) {
      continue;
    }
    const inst = findInstance(parentDef, node.instName);
    const text = `${inst ? paramOverrideText(inst) : ''} ${inst ? connectionText(inst) : ''}`;
    for (const name of identifiersIn(text)) {
      if (isGenvarOf(parentDef, name)) {
        return {
          ok: false,
          fallback: 'stub',
          error: `"${node.path}" is an iteration of a generate block, and its wiring uses the loop variable "${name}". A composed module would need the value of the iteration written into the wiring, so this selection can only be generated as a stub.`,
        };
      }
    }
  }

  // ---------------------------------------------------------------- instances
  const warnings: string[] = [];
  const instanceInfo: WrapperInstance[] = [];
  const state = new Map<string, SignalState>();
  const usedIdents = new Set<string>();
  const localparams = new Map<string, string>();

  for (const node of nodes) {
    // The instance of the iteration that was selected: `g[1].u` and not the
    // first `u` of the loop, whose connections are its own.
    const inst = findInstance(parentDef, node.instName);
    if (!inst) {
      return { ok: false, error: `Instance "${node.instName}" was not found in module "${parentDef.name}".` };
    }
    const childDef = index.resolveModule(node.moduleName, node.file);
    const ident = uniqueIdent(sanitizeIdent(node.instName), usedIdents);
    const paramText = paramOverrideText(inst);
    const connText = connectionText(inst);
    instanceInfo.push({
      ident,
      path: node.path,
      moduleName: node.moduleName,
      file: node.file ?? parentDef.file,
      range: inst.range,
      paramText,
      connText,
    });
    // `#(.WIDTH (WIDTH))` and `.a (bus[WIDTH-1:0])` refer to parameters of the
    // parent module, so the composed module has to re-declare them or the
    // generated code will not compile.
    for (const name of referencedParams(index, parentDef, `${paramText} ${connText}`)) {
      if (localparams.has(name)) {
        continue;
      }
      const v = scope.get(name);
      if (v === undefined) {
        warnings.push(
          `Parameter "${name}" of "${parentDef.name}" could not be folded; the generated module declares it without a value, so check the copied #(...).`,
        );
        localparams.set(name, name);
      } else {
        localparams.set(name, String(v));
      }
    }

    for (const conn of inst.connections) {
      const port = childDef?.ports.find((p) => p.name === conn.portName);
      const dir = conn.shorthand && conn.portName === '*' ? undefined : flowDir(port?.direction ?? (conn.shorthand ? conn.portName : undefined));
      for (const ref of conn.refs) {
        const sig = signalState(state, ref.fullPath);
        if (dir === 'output' || dir === 'inout') sig.produced = true;
        if (dir === 'input' || dir === 'inout') sig.consumed = true;
        if (conn.shorthand && conn.portName && conn.portName !== ref.fullPath) {
          const implied = signalState(state, conn.portName);
          if (dir === 'output' || dir === 'inout') implied.produced = true;
          if (dir === 'input' || dir === 'inout') implied.consumed = true;
        }
        sig.usedBy.add(node.path);
        if (ref.select) {
          sig.selects.add(ref.select);
        }
      }
    }
  }

  // ------------------------------------------------------------------ assigns
  // Only assignments that actually feed the selection are copied, and whatever
  // they read becomes a wrapper input unless the selection already drives it.
  const assignText: string[] = [];
  const includeAssigns = opts.includeAssigns ?? true;
  const continuous = parentDef.assigns.filter(
    (a) => !a.inAlways && a.lhs.length === 1 && a.lhs[0].pathSuffix === '',
  );
  const assignByLhs = new Map<string, AssignSite>();
  for (const a of continuous) {
    const lhs = a.lhs[0].fullPath;
    if (!assignByLhs.has(lhs)) {
      assignByLhs.set(lhs, a);
    }
  }
  const proceduralDriven = new Set<string>();
  for (const a of parentDef.assigns) {
    if (a.inAlways) {
      for (const lhs of a.lhs) {
        proceduralDriven.add(lhs.fullPath);
      }
    }
  }

  const copied = new Set<AssignSite>();
  if (includeAssigns) {
    const queue = [...state.keys()];
    const seen = new Set(queue);
    while (queue.length) {
      const name = queue.shift()!;
      const a = assignByLhs.get(name);
      if (!a || copied.has(a)) {
        continue;
      }
      const st = state.get(name)!;
      if (!st.consumed || st.produced) {
        // Nothing in the selection needs it, or an instance already drives it.
        continue;
      }
      copied.add(a);
      for (const rhs of a.rhs) {
        const rs = signalState(state, rhs.fullPath);
        rs.consumed = true;
        rs.usedBy.add('assign');
        if (rhs.select) {
          rs.selects.add(rhs.select);
        }
        if (!rs.produced && !seen.has(rhs.fullPath)) {
          seen.add(rhs.fullPath);
          queue.push(rhs.fullPath);
        }
      }
    }
  }
  for (const a of copied) {
    const st = signalState(state, a.lhs[0].fullPath);
    st.produced = true;
    st.fromAssign = true;
    assignText.push(`assign ${a.lhsText} = ${a.rhsText};`);
  }
  if (includeAssigns) {
    const skipped = continuous.length - copied.size;
    if (skipped > 0) {
      warnings.push(
        `${skipped} continuous assign${skipped === 1 ? '' : 's'} in "${parentDef.name}" ${skipped === 1 ? 'does' : 'do'} not drive the selection and ${skipped === 1 ? 'was' : 'were'} not copied.`,
      );
    }
  }

  // ------------------------------------------------------------------- ports
  // Boundary = signals the selection reads (wrapper input), signals it drives
  // (wrapper output) and signals that both ends live inside (internal wire).
  const ports: WrapperPort[] = [];
  const internalNets: WrapperPort[] = [];
  for (const [name, st] of state) {
    if (!st.produced && !st.consumed) {
      continue;
    }
    const decl = index.findDecl(parentDef, name);
    const parentPort = decl?.kind === 'port' ? decl.decl : undefined;
    const base: WrapperPort = {
      name: sanitizeIdent(name.split('.')[0]),
      direction: 'input',
      width: declWidth(index, parentDef, name, scope),
      select: st.selects.size === 1 ? [...st.selects][0] : undefined,
      netType: netTypeOf(decl),
      isParentPort: !!parentPort,
      usedBy: [...st.usedBy],
    };
    if (proceduralDriven.has(name)) {
      base.note = 'written by an always block in the parent scope';
    }
    if (base.width === undefined && hasPackedRange(decl)) {
      base.note = base.note ?? 'width could not be folded, emitted as 1 bit';
      warnings.push(
        `The width of "${name}" in "${parentDef.name}" depends on an expression that could not be folded; the generated port is 1 bit wide.`,
      );
    }
    if (st.produced && st.consumed) {
      internalNets.push({ ...base, direction: 'output' });
    } else if (st.produced) {
      ports.push({ ...base, direction: 'output' });
    } else {
      ports.push({ ...base, direction: 'input' });
      // A port of the parent module is driven by its own caller, which is
      // exactly what the wrapper input stands for. An internal net with no
      // driver is suspicious, so say so once.
      if (!parentPort && !proceduralDriven.has(name) && !assignByLhs.has(name)) {
        ports[ports.length - 1].note = 'no driver found in the parent scope';
        warnings.push(
          `"${name}" is read by the selection but is an undriven net of "${parentDef.name}"; it became an input so the generated module still compiles.`,
        );
      }
    }
  }

  ports.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  internalNets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // ------------------------------------------------------------------- render
  const moduleName = opts.moduleName ?? defaultModuleName(nodes.map((n) => n.path), parentNode.path, parentDef.name);
  const code = render(moduleName, ports, internalNets, instanceInfo, assignText, {
    banner: opts.banner ?? true,
    indent: opts.indent ?? '  ',
    sourceModule: opts.sourceModule ?? parentDef.name,
    sourceFile: parentDef.file,
    nodeCount: countSubtree(index, nodes),
    localparams,
  });

  return {
    ok: true,
    moduleName,
    fileName: `${moduleName}.v`,
    ports,
    internalNets,
    instances: instanceInfo.length,
    instanceInfo,
    assigns: assignText,
    warnings,
    code,
  };
}

// ---------------------------------------------------------------------------
// Flattening a subtree into a standalone module
// ---------------------------------------------------------------------------

/** Why a module cannot be inlined; surfaced to the user verbatim. */
/**
 * Inline the contents of the module at `path` into a new standalone module.
 *
 * The new module re-declares the original parameters as localparams (with the
 * overrides of this instance already folded in), re-emits the original net and
 * variable declarations plus its continuous assignments, and instantiates the
 * children verbatim.
 */
export function flattenModule(
  index: HdlIndex,
  root: HierarchyNode,
  path: string,
  opts: WrapperGenerateOptions = {},
): GenerateResult {
  const node = findByPath(root, path);
  if (!node) {
    return {
      ok: false,
      error: `Instance path "${path}" is not part of the expanded hierarchy. It may sit inside an unexpanded generate block.`,
    };
  }
  const def = index.resolveModule(node.moduleName, node.file);
  if (!def) {
    return { ok: false, error: `Module definition for "${node.moduleName}" was not found in the index.` };
  }
  const scope = paramScopeForPath(index, path);
  const warnings: string[] = [];

  // What cannot be reproduced from the structural IR.
  if (def.funcs.length) {
    return {
      ok: false,
      fallback: 'stub',
      error: `"${def.name}" declares ${def.funcs.length} function/task (${def.funcs.map((f) => f.name).join(', ')}); a flattened copy would not compile without their bodies.`,
    };
  }
  const procedural = def.assigns.filter((a) => a.inAlways);
  if (procedural.length) {
    return {
      ok: false,
      fallback: 'stub',
      error: `"${def.name}" contains procedural logic (${procedural.length} assignment${procedural.length === 1 ? '' : 's'} inside always/initial blocks); the parser keeps declarations but not statement bodies, so it cannot be inlined.`,
    };
  }
  // Anything inside a generate construct. The IR records *what* each iteration
  // holds but not the construct itself, so a copy written at module scope is not
  // the design: a wire declared in the block is declared once per iteration
  // (duplicate declarations, a file that will not compile) and an instance in it
  // would sit in the module instead of under `label[i]`. Saying "wires and
  // assignments are fine" was wrong, and the copy said so with no warning.
  const generatedInstances = def.instances.filter((i) => i.inGenerate);
  const generatedAssigns = def.assigns.filter((a) => a.generate !== undefined);
  const generatedDecls = def.decls.filter((d) => d.generate !== undefined);
  const generatedParams = def.params.filter((p) => p.generate !== undefined);
  const generatedPorts = def.ports.filter((p) => p.generate !== undefined);
  if (generatedInstances.length || generatedAssigns.length || generatedDecls.length ||
      generatedParams.length || generatedPorts.length) {
    // The label is what tells the reader where to look, so every kind of
    // generate content names its block. A module whose only generate content is
    // a parameter said `inside a generate construct ()` and left the reader to
    // guess which one.
    const labels = [...new Set([
      ...generatedInstances.map((i) => i.genPrefix),
      ...generatedAssigns.map((a) => a.generate!),
      ...generatedDecls.map((d) => d.generate!),
      ...generatedParams.map((p) => p.generate!),
      ...generatedPorts.map((p) => p.generate!),
    ].filter(Boolean))].join(', ');
    const what = [
      generatedInstances.length ? `${generatedInstances.length} instantiation${generatedInstances.length === 1 ? '' : 's'}` : '',
      generatedAssigns.length ? `${generatedAssigns.length} assignment${generatedAssigns.length === 1 ? '' : 's'}` : '',
      generatedDecls.length ? `${generatedDecls.length} declaration${generatedDecls.length === 1 ? '' : 's'}` : '',
      generatedParams.length ? `${generatedParams.length} parameter${generatedParams.length === 1 ? '' : 's'}` : '',
      generatedPorts.length ? `${generatedPorts.length} port${generatedPorts.length === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join(', ');
    return {
      ok: false,
      fallback: 'stub',
      error: `"${def.name}" holds ${what} inside a generate construct (${labels}); the construct is not reproduced, so a flattened copy would not be the design. Generate a stub of it, or select instances below the block.`,
    };
  }

  // Parameters become localparams so the copied expressions still fold. The
  // value is the one *this* instance sees (its own `#(...)` overrides already
  // applied by the hierarchy walk), not the declared default, so the copy
  // behaves like the slice of the design that was selected.
  const localparams: string[] = [];
  for (const p of def.params) {
    const folded = scope.get(p.name);
    const value = folded !== undefined ? String(folded) : p.value?.value !== undefined ? String(p.value.value) : p.value?.raw;
    if (value === undefined || value === '') {
      warnings.push(`Parameter "${p.name}" of "${def.name}" has no foldable value at "${node.path}"; the flattened copy has to be filled in by hand.`);
      continue;
    }
    if (folded === undefined) {
      warnings.push(`Parameter "${p.name}" of "${def.name}" is overridden at "${node.path}" with an expression that could not be folded, so the declared default was used.`);
      continue;
    }
    localparams.push(`localparam ${p.name} = ${value};`);
  }

  // Net / variable declarations, rendered from the IR.
  const decls: string[] = [];
  const userTyped = new Map<string, string[]>();
  // A type this module declares is already reported above, as a skipped
  // typedef; only a type that lives somewhere else is worth a second word.
  const localTypes = new Set(
    def.decls.filter((d) => d.kind === 'typedef').map((d) => d.name),
  );
  // Every variable that names a user type, so a skipped typedef only warns when
  // something in the copy actually needed it.
  const typeUsedBy = new Map<string, string[]>();
  for (const d of def.decls) {
    if (d.kind !== 'typedef' && d.dataType.t === 'user' && d.dataType.name) {
      const names = typeUsedBy.get(d.dataType.name) ?? [];
      names.push(d.name);
      typeUsedBy.set(d.dataType.name, names);
    }
  }
  for (const d of def.decls) {
    if (d.kind === 'typedef') {
      // A type nothing declares a signal of costs the copy nothing, and saying
      // otherwise makes the warning list cry wolf. One that is used is worth a
      // second word: the variable keeps its width and loses its type, which for
      // an enum or a struct is no longer the same signal.
      if (typeUsedBy.has(d.name)) {
        warnings.push(`Type declaration "${d.name}" was skipped; the flattened copy may not compile.`);
      }
      continue;
    }
    if (d.kind === 'genvar') {
      decls.push(`genvar ${d.name};`);
      continue;
    }
    if (d.dataType.t === 'user' && d.dataType.name) {
      // The copy is standalone, and a type that is not declared in this file
      // cannot be copied with it, so the variable keeps its width and loses its
      // type. That is worth saying out loud: for an enum or a struct it is not
      // the same signal any more.
      const sep = d.dataType.name.indexOf('::');
      const type = sep < 0 ? d.dataType.name : d.dataType.name.slice(sep + 2);
      if (!localTypes.has(type)) {
        const names = userTyped.get(d.dataType.name) ?? [];
        names.push(d.name);
        userTyped.set(d.dataType.name, names);
      }
    }
    if (d.implicit) {
      // A wire the parser created rather than read. Verilog declares it for the
      // copy on its own, so writing it out would be noise.
      continue;
    }
    const t = renderDecl(d);
    if (d.init?.raw) {
      decls.push(`${t} = ${d.init.raw};`);
    } else {
      decls.push(`${t};`);
    }
  }
  for (const [type, names] of userTyped) {
    warnings.push(
      `${names.map((n) => `"${n}"`).join(', ')} use the type "${type}", which this file does not declare, ` +
        `so the flattened copy falls back to a plain net of the same width. For an enum or a struct that is ` +
        `not the same signal any more.`,
    );
  }

  // Children: instantiate verbatim, but only those that are not the node itself.
  const usedIdents = new Set<string>();
  const instanceInfo: WrapperInstance[] = [];
  for (const child of node.children ?? []) {
    const inst = findInstance(def, child.instName);
    if (!inst) {
      continue;
    }
    instanceInfo.push({
      ident: uniqueIdent(sanitizeIdent(child.instName), usedIdents),
      path: child.path,
      moduleName: child.moduleName,
      file: child.file ?? def.file,
      range: inst.range,
      paramText: paramOverrideText(inst),
      connText: connectionText(inst),
    });
  }

  const assigns: string[] = [];
  for (const a of def.assigns) {
    if (a.inAlways) {
      continue;
    }
    assigns.push(`assign ${a.lhsText} = ${a.rhsText};`);
  }

  // The flattened module is standalone, so its ports are the original module's.
  const ports: WrapperPort[] = def.ports.map((p) => {
    // A flattened port has to be a flat vector, so a port declared with more
    // than one dimension is emitted as `[total-1:0]`. It used to be emitted
    // with no range at all - silently a single bit, for a 32-bit bus.
    let w: number | undefined = typeWidth(p.dataType, scope) ?? 1;
    for (const dim of [...(p.packed ?? []), ...(p.unpacked ?? [])]) {
      const n = rangeWidth(dim, scope);
      if (n === undefined) {
        w = undefined;
        break;
      }
      w *= n;
    }
    const multi = (p.packed?.length ?? 0) + (p.unpacked?.length ?? 0) > 0;
    return {
      name: sanitizeIdent(p.declName || p.name),
      direction: flowDir(p.direction) ?? 'input',
      width: w,
      netType: netTypeOf(index.findDecl(def, p.declName || p.name)),
      isParentPort: true,
      usedBy: [path],
      note: multi
        ? `declared with ${1 + (p.packed?.length ?? 0) + (p.unpacked?.length ?? 0)} dimensions; ` +
          'the flattened copy is one flat vector of the same total width'
        : p.declName && p.declName !== p.name
          ? `port ${p.name} drives ${p.declName}`
          : undefined,
    };
  });
  if (def.ports.length === 0) {
    return { ok: false, error: `"${def.name}" has no ports; there is nothing to interface with.` };
  }

  const moduleName = opts.moduleName ?? defaultFlattenName(node);
  const L: string[] = [];
  if (opts.banner ?? true) {
    L.push('// -----------------------------------------------------------------------------');
    L.push(`// Generated by hdl-connect-view - flattened copy of ${def.name}`);
    L.push(`// Extracted from instance path: ${node.path}`);
    L.push(`// Source: ${def.file}`);
    L.push(`// ${instanceInfo.length} child instance${instanceInfo.length === 1 ? '' : 's'} re-instantiated; parameter values of this instance were folded into localparams.`);
    L.push('// -----------------------------------------------------------------------------');
    L.push('');
  }
  L.push(`module ${moduleName} (`);
  ports.forEach((p, i) => {
    L.push(`  ${portDeclText(p)}${i === ports.length - 1 ? '' : ','}`);
  });
  L.push(');');
  if (localparams.length) {
    L.push('');
    L.push('  // parameters of the original module, with this instance\'s overrides folded in');
    for (const lp of localparams) {
      L.push(`  ${lp}`);
    }
  }
  if (decls.length) {
    L.push('');
    for (const d of decls) {
      L.push(`  ${d}`);
    }
  }
  for (const inst of instanceInfo) {
    L.push('');
    L.push(`  ${inst.moduleName} ${inst.paramText ? inst.paramText + ' ' : ''}${inst.ident} ${inst.connText};`);
  }
  for (const a of assigns) {
    L.push('');
    L.push(`  ${a}`);
  }
  L.push('');
  L.push('endmodule');
  L.push('');

  // Wires of the flattened module that are not ports: the preview shows them so
  // it is obvious that the copy carries the original internals.
  const portNames = new Set(def.ports.map((p) => p.name));
  const internalNets: WrapperPort[] = def.decls
    .filter((d) => !d.implicit && !portNames.has(d.name))
    .map((d) => ({
      name: sanitizeIdent(d.name),
      direction: 'output' as WrapperDirection,
      width: declWidth(index, def, d.name, scope),
      netType: netTypeOf(index.findDecl(def, d.name)),
      isParentPort: false,
      usedBy: [path],
      note: `internal to ${def.name}`,
    }));

  return {
    ok: true,
    moduleName,
    fileName: `${moduleName}.v`,
    ports,
    internalNets,
    instances: instanceInfo.length,
    instanceInfo,
    assigns,
    warnings,
    code: L.join('\n'),
  };
}

function defaultFlattenName(node: HierarchyNode): string {
  const leaf = node.path.split('.').pop() ?? node.moduleName;
  return sanitizeIdent(leaf);
}

/** Re-render a variable / net declaration from the IR. */
function renderDecl(d: VarDecl): string {
  const keyword = d.kind === 'integer' || d.kind === 'genvar' || d.kind === 'event' ? d.kind : netTypeFor(d);
  // Packed dimensions are part of the type and go before the name; unpacked
  // ones follow it. `wire [3:0] [7:0] w;` is not `wire [3:0] w [7:0];`.
  const packed = [
    'range' in d.dataType ? renderRange(d.dataType.range) : '',
    ...(d.packedDims ?? []).map((r) => renderRange(r)),
  ].filter((x) => x !== '').join(' ');
  const unpacked = (d.dims ?? []).map((r) => renderRange(r)).join(' ');
  const parts = [keyword, packed, d.name, unpacked].filter((x) => x !== '');
  return parts.join(' ');
}

function netTypeFor(d: VarDecl): string {
  if (d.kind === 'reg') {
    return 'reg';
  }
  if (d.dataType.t === 'logic') {
    return 'logic';
  }
  if (d.dataType.t === 'user') {
    return 'wire';
  }
  return 'wire';
}

function renderRange(r: ValueRange | undefined): string {
  if (!r || (!r.msb.raw && !r.lsb.raw)) {
    return '';
  }
  return `[${r.msb.raw}:${r.lsb.raw}]`;
}

// ---------------------------------------------------------------------------
// Port-forwarding stub
// ---------------------------------------------------------------------------

/**
 * Emit a module that simply instantiates the node and forwards its ports.
 * Always legal, and the right answer for modules that cannot be inlined.
 */
export function stubModule(
  index: HdlIndex,
  root: HierarchyNode,
  path: string,
  opts: WrapperGenerateOptions = {},
): GenerateResult {
  const node = findByPath(root, path);
  if (!node) {
    return { ok: false, error: `Instance path "${path}" was not found in the hierarchy.` };
  }
  const def = index.resolveModule(node.moduleName, node.file);
  if (!def) {
    return { ok: false, error: `Module definition for "${node.moduleName}" was not found in the index.` };
  }
  const scope = paramScopeForPath(index, path);
  const moduleName = opts.moduleName ?? defaultFlattenName(node);
  const ports: WrapperPort[] = def.ports.map((p) => ({
    name: sanitizeIdent(p.declName || p.name),
    direction: flowDir(p.direction) ?? 'input',
    width: typeWidth(p.dataType, scope),
    netType: netTypeOf(index.findDecl(def, p.declName || p.name)),
    isParentPort: true,
    usedBy: [path],
  }));
  const ident = sanitizeIdent(node.instName);
  const L: string[] = [];
  L.push('// -----------------------------------------------------------------------------');
  L.push(`// Generated by hdl-connect-view - port-forwarding wrapper for ${def.name}`);
  L.push(`// Instance path: ${node.path}`);
  L.push(`// Source: ${def.file}`);
  L.push('// The module body could not be inlined, so it is kept as an instance and its ports are re-exported.');
  L.push('// -----------------------------------------------------------------------------');
  L.push('');
  L.push(`module ${moduleName} (`);
  ports.forEach((p, i) => L.push(`  ${portDeclText(p)}${i === ports.length - 1 ? '' : ','}`));
  L.push(');');
  L.push('');
  L.push(`  ${def.name} ${ident} (`);
  ports.forEach((p, i) => {
    const inner = p.note ? sanitizeIdent(p.note.split(' ').pop()!) : p.name;
    L.push(`    .${p.name} (${inner})${i === ports.length - 1 ? '' : ','}`);
  });
  L.push('  );');
  L.push('');
  L.push('endmodule');
  L.push('');

  return {
    ok: true,
    moduleName,
    fileName: `${moduleName}.v`,
    ports,
    internalNets: [],
    instances: 1,
    instanceInfo: [
      {
        ident,
        path: node.path,
        moduleName: def.name,
        file: def.file,
        range: def.range,
        paramText: '',
        connText: '',
      },
    ],
    assigns: [],
    warnings: [],
    code: L.join('\n'),
  };
}

/** Flatten when possible, otherwise fall back to a port-forwarding stub. */
export function generateWrapper(
  index: HdlIndex,
  root: HierarchyNode,
  paths: string | string[],
  opts: WrapperGenerateOptions = {},
): GenerateResult {
  const selection = Array.isArray(paths) ? paths.filter(Boolean) : [paths];
  if (selection.length > 1) {
    return composeModule(index, root, selection, opts);
  }
  const single = selection[0];
  if (!single) {
    return { ok: false, error: 'No instance selected.' };
  }
  const flat = flattenModule(index, root, single, opts);
  if (flat.ok || !flat.fallback) {
    return flat;
  }
  const stub = stubModule(index, root, single, opts);
  if (!stub.ok) {
    return stub;
  }
  stub.warnings.unshift(flat.error);
  return stub;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** The nearest ancestor of `path` that is a node of the tree. */
function enclosingNode(root: HierarchyNode, path: string): HierarchyNode | undefined {
  for (let p = path; ; ) {
    const at = p.lastIndexOf('.');
    if (at < 0) {
      return undefined;
    }
    p = p.slice(0, at);
    const n = findByPath(root, p);
    if (n) {
      return n;
    }
  }
}

function signalState(map: Map<string, SignalState>, name: string): SignalState {
  let st = map.get(name);
  if (!st) {
    st = { produced: false, consumed: false, fromAssign: false, usedBy: new Set(), selects: new Set() };
    map.set(name, st);
  }
  return st;
}

function uniqueIdent(base: string, used: Set<string>): string {
  let name = base;
  let n = 2;
  while (used.has(name)) {
    name = `${base}_${n++}`;
  }
  used.add(name);
  return name;
}



function paramOverrideText(inst: InstanceSite): string {
  if (inst.paramOverrides.length === 0) {
    return '';
  }
  const parts = inst.paramOverrides.map((p) => {
    return p.byPosition ? p.expr.raw : `.${p.name ?? ''} (${p.expr.raw})`;
  });
  return `#(${parts.join(', ')})`;
}

function connectionText(inst: InstanceSite): string {
  const parts: string[] = [];
  for (const c of inst.connections) {
    parts.push(connText(c));
  }
  return parts.length ? `(\n${parts.map((p) => `    ${p}`).join(',\n')}\n  )` : '()';
}

function connText(c: PortConn): string {
  if (c.shorthand && c.portName === '*') {
    return '.*';
  }
  if (c.shorthand) {
    return `.${c.portName}`;
  }
  if (c.empty) {
    return `.${c.portName}()`;
  }
  return `.${c.portName} (${c.rawExpr})`;
}

/** Identifiers in `text` that are parameters of `def`. */
/** The names a piece of source text mentions. */
function identifiersIn(text: string): string[] {
  const out: string[] = [];
  for (const t of tokenize(text)) {
    if (t.kind === 'ident' && !out.includes(t.text)) {
      out.push(t.text);
    }
  }
  return out;
}

function isGenvarOf(def: ModuleDef, name: string): boolean {
  return def.decls.some((d) => d.name === name && d.kind === 'genvar');
}

function referencedParams(index: HdlIndex, def: ModuleDef, text: string): string[] {
  const out: string[] = [];
  for (const t of tokenize(text)) {
    if (t.kind !== 'ident' || out.includes(t.text)) {
      continue;
    }
    if (index.findDecl(def, t.text)?.kind === 'param') {
      out.push(t.text);
    }
  }
  return out;
}

function hasPackedRange(decl: ReturnType<HdlIndex['findDecl']>): boolean {
  if (!decl) {
    return false;
  }
  if (decl.kind === 'port') {
    return 'range' in decl.decl.dataType || (decl.decl.unpacked?.length ?? 0) > 0;
  }
  if (decl.kind === 'var') {
    return 'range' in decl.decl.dataType || (decl.decl.dims?.length ?? 0) > 0;
  }
  return false;
}

function netTypeOf(
  decl: ReturnType<HdlIndex['findDecl']>,
): string {
  if (!decl) {
    return 'wire';
  }
  if (decl.kind === 'port') {
    switch (decl.decl.dataType.t) {
      case 'logic':
        return 'logic';
      case 'nets':
        return 'wire';
      default:
        return 'wire';
    }
  }
  if (decl.kind === 'var') {
    if (decl.decl.kind === 'reg') {
      return 'reg';
    }
    if (decl.decl.dataType.t === 'logic') {
      return 'logic';
    }
    return 'wire';
  }
  return 'wire';
}

function declWidth(index: HdlIndex, def: ModuleDef, name: string, scope: FoldScope): number | undefined {
  const d = index.findDecl(def, name.split('.')[0]);
  if (!d) {
    return undefined;
  }
  if (d.kind !== 'port' && d.kind !== 'var') {
    return undefined;
  }
  // `typeWidth` covers the first packed range only; every further dimension,
  // packed or unpacked, is a factor of the total.
  const dims = d.kind === 'port' ? [...(d.decl.packed ?? []), ...(d.decl.unpacked ?? [])]
    : [...(d.decl.packedDims ?? []), ...(d.decl.dims ?? [])];
  let total = typeWidth(d.decl.dataType, scope) ?? 1;
  for (const dim of dims) {
    const n = rangeWidth(dim, scope);
    if (n === undefined) return undefined;
    total *= n;
  }
  return total;
}

function defaultModuleName(paths: string[], parentPath: string, parentName: string): string {
  if (paths.length === 1) {
    const leaf = paths[0].split('.').pop() ?? 'sel';
    return sanitizeIdent(leaf);
  }
  void parentPath;
  return sanitizeIdent(`${parentName}_composed`);
}

function countSubtree(index: HdlIndex, nodes: HierarchyNode[]): number {
  let n = 0;
  for (const node of nodes) {
    n += subtree(node).length;
  }
  void index;
  return n;
}

function portDeclText(p: WrapperPort): string {
  const range = p.select ?? (p.width && p.width > 1 ? `[${p.width - 1}:0]` : '');
  const width = p.select ? '' : range;
  return `${p.direction} ${p.netType}${width ? ' ' + width : ''} ${p.name}`;
}

function render(
  moduleName: string,
  ports: WrapperPort[],
  internalNets: WrapperPort[],
  instances: WrapperInstance[],
  assigns: string[],
  meta: {
    banner: boolean;
    indent: string;
    sourceModule: string;
    sourceFile: string;
    nodeCount: number;
    localparams?: Map<string, string>;
  },
): string {
  const ind = meta.indent;
  const L: string[] = [];

  if (meta.banner) {
    L.push('// -----------------------------------------------------------------------------');
    L.push(`// Generated by hdl-connect-view - composition wrapper for ${meta.sourceModule}`);
    L.push(`// Source: ${meta.sourceFile}`);
    L.push(`// Contains ${instances.length} instance${instances.length === 1 ? '' : 's'} ` +
      `covering ${meta.nodeCount} module${meta.nodeCount === 1 ? '' : 's'} of the original hierarchy.`);
    L.push('// Review port directions and widths before use; internal wiring is copied verbatim.');
    L.push('// -----------------------------------------------------------------------------');
    L.push('');
  }

  L.push(`module ${moduleName} (`);
  const decls: string[] = ports.map((p) => `${ind}${portDeclText(p)}`);
  L.push(...decls.map((d, i) => (i === decls.length - 1 ? d : `${d},`)));
  L.push(');');

  if (meta.localparams?.size) {
    L.push('');
    L.push(`${ind}// parameters of ${meta.sourceModule} used by the copied #(...) overrides`);
    for (const [k, v] of meta.localparams) {
      L.push(`${ind}localparam ${k} = ${v};`);
    }
  }

  for (const n of internalNets) {
    L.push('');
    if (n.usedBy.length) {
      L.push(`${ind}// ${n.name} (${n.direction === 'output' ? 'internal net' : 'internal'}) - used by ${n.usedBy.join(', ')}`);
    }
    L.push(`${ind}${declText(n)};`);
  }

  for (const inst of instances) {
    L.push('');
    L.push(`${ind}${inst.moduleName} ${inst.paramText ? inst.paramText + ' ' : ''}${inst.ident} ${inst.connText};`);
  }

  for (const a of assigns) {
    L.push('');
    L.push(`${ind}${a}`);
  }

  L.push('');
  L.push('endmodule');
  L.push('');
  return L.join('\n');
}

function declText(p: WrapperPort): string {
  const range = p.select ?? (p.width && p.width > 1 ? `[${p.width - 1}:0]` : '');
  return `${p.netType}${range ? ' ' + range : ''} ${p.name}`;
}
