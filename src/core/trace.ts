import type { InstanceSite, ModuleDef, PortConn, Pos, Range, RefSite } from './ast';
import type { HdlIndex } from './index';
import { generateScopes, generateScopedName } from './index';
import { instancesOf, resolveAt, type ResolvedDecl } from './resolve';

/**
 * Signal tracing through the hierarchy, one hop per invocation.
 *
 * `up` walks toward the top level: from a use of a signal to its declaration in
 * the same module, then from a port declaration to the connection at the parent
 * instance that instantiates the module. `down` walks toward the leaves: from a
 * signal to the child instance connections that touch it (the instantiation
 * positions), then from such a connection into the child module's port
 * declaration. At the bottom - a leaf port, or a signal no child instance
 * touches - the last hop is the use of that signal inside the module body.
 *
 * The trace is deliberately *not* a transitive closure: the caller jumps to the
 * chosen target and the user can trace again from there, so a path is walked a
 * step at a time and every landing is an ordinary source position. The result is
 * plain data; opening editors and asking the user to disambiguate is the host
 * layer's job.
 */
export type TraceDirection = 'up' | 'down';

export type TraceStepKind =
  /** A signal use jumps to its declaration in the same module. */
  | 'declaration'
  /** A port declaration jumps to the connection at the parent instance. */
  | 'parent-net'
  /** A connection jumps to the parent-side net it carries. */
  | 'connection-net'
  /** A signal jumps to the child instance connection that touches it. */
  | 'child-connection'
  /** A connection jumps into the child module's port declaration. */
  | 'child-port'
  /** At the bottom, a signal jumps to where the module body uses it. */
  | 'usage'
  /** A module traces up to the instance that instantiates its parent context? */
  | 'parent-instance'
  /** A module traces down to the place a child module is instantiated. */
  | 'child-instance'
  /** A module traces down to a child module's definition. */
  | 'child-module'
  /** A module trace lands on the module's own definition. */
  | 'module-definition';

export interface TraceStep {
  file: string;
  range: Range;
  kind: TraceStepKind;
  /** Primary label for the quick pick. */
  label: string;
  /** Module / instance note. */
  detail: string;
}

export interface TraceResult {
  /** Signal or port name under the cursor. */
  name: string;
  /** Module the cursor's signal belongs to. */
  module: string;
  direction: TraceDirection;
  /** The declaration or connection the cursor resolved to. */
  file: string;
  range: Range;
  targets: TraceStep[];
}

/**
 * Trace whatever sits under the cursor: a module/instance name follows the
 * module hierarchy, anything else follows the signal web. Resolves the cursor
 * once so a trace costs a single tokenization.
 */
export function traceAt(
  index: HdlIndex,
  file: string,
  source: string,
  line: number,
  character: number,
  direction: TraceDirection,
): TraceResult | undefined {
  const hit = resolveAt(index, file, source, line, character);
  if (!hit) {
    // No symbol under the cursor: an empty line or the space between two
    // tokens names neither a signal nor a module, so the trace follows the
    // module the cursor sits in.
    return blankTrace(index, file, line, character, direction);
  }
  if (!hit.mod) {
    return undefined;
  }
  const kind = hit.resolution.ok ? hit.resolution.decl.kind : undefined;
  if (kind === 'instance' || kind === 'module' || instanceAt(hit.mod, line, character)) {
    return moduleTrace(index, hit.mod, direction, line, character);
  }
  return signalFromHit(index, hit, line, character, direction);
}

export function traceSignal(
  index: HdlIndex,
  file: string,
  source: string,
  line: number,
  character: number,
  direction: TraceDirection,
): TraceResult | undefined {
  const hit = resolveAt(index, file, source, line, character);
  if (!hit) {
    return undefined;
  }
  return signalFromHit(index, hit, line, character, direction);
}

function signalFromHit(
  index: HdlIndex,
  hit: ReturnType<typeof resolveAt>,
  line: number,
  character: number,
  direction: TraceDirection,
): TraceResult | undefined {
  if (!hit) {
    return undefined;
  }
  const cursorMod = hit.mod;
  if (!cursorMod) {
    return undefined;
  }

  if (hit.resolution.ok) {
    const decl = hit.resolution.decl;
    if (decl.kind === 'port' || decl.kind === 'signal') {
      const owner = decl.moduleName ? index.resolveModule(decl.moduleName, decl.file) : cursorMod;
      if (owner && sameModule(owner, cursorMod)) {
        const onDecl = samePos(hit.word.nameRange, decl.nameRange);
        return signalTrace(index, owner, decl, onDecl, direction);
      }
      if (owner) {
        // A hierarchical reference such as `u_adder.sum`: the cursor is on the
        // connection at the instance, not on a net of the current module.
        const found = hierarchicalConnection(cursorMod, hit.word.fullPath);
        if (found) {
          return connectionTrace(index, cursorMod, found.inst, found.conn, direction);
        }
      }
    }
  }

  const conn = connectionAt(cursorMod, line, character);
  if (conn) {
    return connectionTrace(index, cursorMod, conn.inst, conn.conn, direction);
  }
  return undefined;
}

function signalTrace(
  index: HdlIndex,
  mod: ModuleDef,
  decl: ResolvedDecl,
  onDecl: boolean,
  direction: TraceDirection,
): TraceResult {
  const name = decl.name;
  const targets: TraceStep[] = [];
  if (direction === 'up') {
    if (!onDecl) {
      // ① a use of the signal goes to its declaration in this module.
      add(targets, {
        file: decl.file,
        range: decl.nameRange,
        kind: 'declaration',
        label: name,
        detail: `declared in ${mod.name}`,
      });
    } else if (decl.kind === 'port') {
      // ② a port declaration goes to the parent instance's connection.
      for (const { mod: parent, inst } of instancesOf(index, mod.name)) {
        const portName = mod.ports.find((p) => p.name === name || p.declName === name)?.name ?? name;
        const conn = inst.connections.find((c) => c.portName === portName);
        if (conn && conn.refs.length) {
          for (const r of conn.refs) {
            add(targets, {
              file: parent.file,
              range: r.range,
              kind: 'parent-net',
              label: `${inst.name}.${conn.portName}`,
              detail: parent.name,
            });
          }
        } else {
          add(targets, {
            file: parent.file,
            range: inst.nameRange,
            kind: 'parent-net',
            label: inst.name,
            detail: parent.name,
          });
        }
      }
    }
  } else {
    // ① a signal goes to the child instance connections that touch it.
    const scopes = generateScopes(mod);
    const norm = (full: string) => generateScopedName(full, scopes) ?? full;
    const matches = (ref: RefSite) => norm(ref.fullPath) === name;
    for (const inst of mod.instances) {
      for (const conn of inst.connections) {
        const connected = conn.refs.some(matches) || (conn.shorthand && conn.portName === name);
        if (!connected) {
          continue;
        }
        add(targets, {
          file: mod.file,
          range: conn.nameRange,
          kind: 'child-connection',
          label: `${inst.name}.${conn.portName || '?'}`,
          detail: inst.moduleName,
        });
      }
    }
    // ② the bottom of the hierarchy: nothing below connects the signal, so the
    //    last hop is its use in this module's body. A leaf port is read or
    //    driven here, and that is as deep as the trace goes.
    if (targets.length === 0) {
      addUsages(mod, name, norm, targets);
    }
  }
  return { name, module: mod.name, direction, file: decl.file, range: decl.nameRange, targets };
}

/**
 * The sites inside `mod` that mention `name`: the references of its continuous
 * and procedural assignments (both sides), and the event/condition/generate
 * references that belong to no assignment. Mirrors `signalUsage` in `nets.ts`,
 * but keeps source ranges so a trace can land on the exact position.
 */
function addUsages(
  mod: ModuleDef,
  name: string,
  norm: (full: string) => string,
  targets: TraceStep[],
): void {
  for (const a of mod.assigns) {
    // A name assigned inside a function/task body is an automatic variable of
    // one call, not a signal of this module.
    if (a.local) {
      continue;
    }
    const how = a.inAlways ? 'always' : 'assign';
    for (const ref of [...a.lhs, ...a.rhs]) {
      if (norm(ref.fullPath) !== name) {
        continue;
      }
      add(targets, {
        file: mod.file,
        range: ref.range,
        kind: 'usage',
        label: name,
        detail: `${ref.isWrite ? 'driven' : 'read'} by ${how} · ${mod.name}`,
      });
    }
  }
  for (const ref of mod.refs) {
    if (ref.isDecl || (ref.context !== 'event' && ref.context !== 'condition' && ref.context !== 'generate')) {
      continue;
    }
    if (norm(ref.fullPath) !== name) {
      continue;
    }
    const how = ref.context === 'generate' ? 'generate' : 'always';
    add(targets, {
      file: mod.file,
      range: ref.range,
      kind: 'usage',
      label: name,
      detail: `read by ${how} · ${mod.name}`,
    });
  }
}

function connectionTrace(
  index: HdlIndex,
  mod: ModuleDef,
  inst: InstanceSite,
  conn: PortConn,
  direction: TraceDirection,
): TraceResult {
  const name = conn.portName;
  const targets: TraceStep[] = [];
  if (direction === 'down') {
    // ② the connection goes into the child module's port declaration.
    const child = index.resolveModule(inst.moduleName, mod.file);
    const port = child ? child.ports.find((p) => p.name === name || p.declName === name) : undefined;
    if (child && port) {
      add(targets, {
        file: child.file,
        range: port.nameRange,
        kind: 'child-port',
        label: `${inst.name}.${port.name}`,
        detail: child.name,
      });
    }
  } else {
    for (const r of conn.refs) {
      add(targets, {
        file: mod.file,
        range: r.range,
        kind: 'connection-net',
        label: r.fullPath,
        detail: mod.name,
      });
    }
  }
  return { name, module: mod.name, direction, file: mod.file, range: conn.nameRange, targets };
}

function add(targets: TraceStep[], step: TraceStep): void {
  const key = (s: TraceStep) => `${s.file}:${s.range.start.line}:${s.range.start.character}`;
  if (targets.some((t) => key(t) === key(step))) {
    return;
  }
  targets.push(step);
}

function sameModule(a: ModuleDef | undefined, b: ModuleDef | undefined): boolean {
  return !!a && !!b && a.file === b.file && a.name === b.name;
}

function samePos(a: Range, b: Range): boolean {
  return (
    a.start.line === b.start.line &&
    a.start.character === b.start.character &&
    a.end.line === b.end.line &&
    a.end.character === b.end.character
  );
}

function pointIn(range: Range, line: number, character: number): boolean {
  const afterStart = line > range.start.line || (line === range.start.line && character >= range.start.character);
  const beforeEnd = line < range.end.line || (line === range.end.line && character <= range.end.character);
  return afterStart && beforeEnd;
}

/** The instance connection a point sits in, if any. */
function connectionAt(
  mod: ModuleDef | undefined,
  line: number,
  character: number,
): { inst: InstanceSite; conn: PortConn } | undefined {
  if (!mod) {
    return undefined;
  }
  // The port name is the tightest target; the whole `.port(expr)` is the
  // fallback for a cursor in the expression or on the punctuation.
  for (const inst of mod.instances) {
    const conn = inst.connections.find((c) => pointIn(c.nameRange, line, character));
    if (conn) {
      return { inst, conn };
    }
  }
  for (const inst of mod.instances) {
    const conn = inst.connections.find((c) => pointIn(c.range, line, character));
    if (conn) {
      return { inst, conn };
    }
  }
  return undefined;
}

/** The connection named by a dotted reference such as `u_adder.sum`. */
function hierarchicalConnection(
  mod: ModuleDef | undefined,
  fullPath: string,
): { inst: InstanceSite; conn: PortConn } | undefined {
  if (!mod || !fullPath.includes('.')) {
    return undefined;
  }
  const parts = fullPath.split('.');
  const lastName = parts[parts.length - 1];
  const instanceName = parts[0].replace(/\[.*\]$/, '');
  const inst = mod.instances.find((i) => i.name === instanceName || i.rawName === instanceName);
  if (!inst) {
    return undefined;
  }
  const conn = inst.connections.find((c) => c.portName === lastName);
  return conn ? { inst, conn } : undefined;
}

/** Trace module hierarchy: up = parent instances that instantiate the module; down = children implementations. */
export function traceModule(
  index: HdlIndex,
  file: string,
  source: string,
  line: number,
  character: number,
  direction: TraceDirection,
): TraceResult | undefined {
  const hit = resolveAt(index, file, source, line, character);
  if (!hit) {
    return blankTrace(index, file, line, character, direction);
  }
  if (!hit.mod) {
    return undefined;
  }
  const kind = hit.resolution.ok ? hit.resolution.decl.kind : undefined;
  if (kind !== 'instance' && kind !== 'module' && !instanceAt(hit.mod, line, character)) {
    return undefined;
  }
  return moduleTrace(index, hit.mod, direction, line, character);
}

/**
 * The trace of the module a cursor with no symbol under it sits in.
 *
 * An empty line, or the space between two tokens, names no signal and no
 * module, so the trace falls back to the module the cursor is in: up reaches
 * the instances that instantiate it, down the modules it instantiates.
 */
function blankTrace(
  index: HdlIndex,
  file: string,
  line: number,
  character: number,
  direction: TraceDirection,
): TraceResult | undefined {
  const mod = index.moduleAtLine(file, line);
  if (!mod) {
    return undefined;
  }
  return moduleTrace(index, mod, direction, line, character);
}

/** Up = the level above the cursor; down = the modules below the cursor. */
function moduleTrace(
  index: HdlIndex,
  mod: ModuleDef,
  direction: TraceDirection,
  line: number,
  character: number,
): TraceResult {
  return direction === 'up'
    ? moduleTraceUp(index, mod, line, character)
    : moduleTraceDown(index, mod, line, character);
}

/**
 * Up: the level above the cursor.
 *
 * The climb visits both positions of every level it passes: the module's
 * implementation and the place where the module is instantiated. A cursor on a
 * module header goes to the place that module is instantiated; a cursor on an
 * instantiation goes to the implementation of the module that holds it, and
 * the hop from there reaches the place that module is instantiated.
 *
 * A cursor inside an instantiation belongs to the instantiated module, so the
 * trace is named after that module even though the hop lands on the level that
 * holds the instantiation.
 */
function moduleTraceUp(
  index: HdlIndex,
  mod: ModuleDef,
  line: number,
  character: number,
): TraceResult {
  const targets: TraceStep[] = [];
  const held = instanceAt(mod, line, character);
  if (held) {
    add(targets, {
      file: mod.file,
      range: mod.nameRange,
      kind: 'module-definition',
      label: mod.name,
      detail: `implemented in ${mod.file.split('/').pop() ?? mod.file}`,
    });
    const child = index.resolveModule(held.moduleName, mod.file);
    const name = child?.name ?? held.moduleName;
    return {
      name,
      module: name,
      direction: 'up',
      file: mod.file,
      range: mod.nameRange,
      targets,
    };
  }
  for (const { mod: parent, inst } of instancesOf(index, mod.name)) {
    add(targets, {
      file: parent.file,
      range: inst.nameRange,
      kind: 'parent-instance',
      label: `${inst.name} : ${mod.name}`,
      detail: `instantiated in ${parent.name}`,
    });
  }
  return {
    name: mod.name,
    module: mod.name,
    direction: 'up',
    file: mod.file,
    range: mod.nameRange,
    targets,
  };
}

/**
 * Down: the modules below the cursor.
 *
 * The descent visits both positions of every level it passes, the way the climb
 * does: the place where a child module is instantiated and the implementation
 * of that child. A cursor on a module header goes to the instantiation of one
 * of its children; a cursor on an instantiation goes to the implementation of
 * the module that is instantiated there. Every hop is one position, so tracing
 * down walks the hierarchy the same way tracing up walks it.
 *
 * The children of the module the cursor is in are the candidates and the caller
 * picks one; a module without children sends the trace back to its own
 * definition.
 */
function moduleTraceDown(
  index: HdlIndex,
  mod: ModuleDef,
  line: number,
  character: number,
): TraceResult {
  const inst = instanceAt(mod, line, character);
  if (inst) {
    const child = index.resolveModule(inst.moduleName, mod.file);
    const targets: TraceStep[] = [];
    if (child) {
      add(targets, {
        file: child.file,
        range: child.nameRange,
        kind: 'child-module',
        label: `${inst.name} : ${child.name}`,
        detail: `${child.name} defined in ${child.file.split('/').pop() ?? child.file}`,
      });
    }
    return {
      name: child?.name ?? inst.moduleName,
      module: child?.name ?? inst.moduleName,
      direction: 'down',
      file: child?.file ?? mod.file,
      range: child?.nameRange ?? mod.nameRange,
      targets,
    };
  }
  const targets: TraceStep[] = [];
  for (const child of mod.instances) {
    const impl = index.resolveModule(child.moduleName, mod.file);
    if (!impl) {
      continue;
    }
    add(targets, {
      file: mod.file,
      range: child.nameRange,
      kind: 'child-instance',
      label: `${child.name} : ${impl.name}`,
      detail: `instantiated in ${mod.name}`,
    });
  }
  if (targets.length === 0) {
    add(targets, {
      file: mod.file,
      range: mod.nameRange,
      kind: 'module-definition',
      label: mod.name,
      detail: 'no child module',
    });
  }
  return {
    name: mod.name,
    module: mod.name,
    direction: 'down',
    file: mod.file,
    range: mod.nameRange,
    targets,
  };
}

/**
 * The instantiation the cursor points at, if any.
 *
 * Four positions belong to an instantiation: the instance name, the module type
 * it instantiates, a signal the instance connects, and the rest of the
 * statement - the parameter overrides and the text behind a connection. All of
 * them count as the instantiated module rather than as the module that holds
 * the instantiation.
 */
function instanceAt(
  mod: ModuleDef,
  line: number,
  character: number,
): InstanceSite | undefined {
  for (const inst of mod.instances) {
    if (pointIn(inst.nameRange, line, character) || pointIn(inst.moduleNameRange, line, character)) {
      return inst;
    }
  }
  for (const inst of mod.instances) {
    for (const conn of inst.connections) {
      if (connectedSignalAt(conn, line, character)) {
        return inst;
      }
    }
  }
  const owners = mod.instances.filter((inst) => statementPositionAt(inst, line, character));
  if (owners.length === 0) {
    return undefined;
  }
  // One statement can hold several instances (`mod u1 (...), u2 (...)`), so the
  // cursor belongs to the last one that starts before it.
  let owner = owners[0];
  for (const inst of owners) {
    if (positionBefore(inst.nameRange.start, line, character)) {
      owner = inst;
    }
  }
  return owner;
}

/**
 * A position inside the instantiation statement that names no signal.
 *
 * The parameter overrides and the connections belong to the instantiated
 * module, so a cursor that sits behind them - on a parameter name, on a value,
 * on a comma - traces that module and not the module that holds the
 * instantiation. A port name and a hierarchical path are left out: the first
 * names a port of the child module, the second a net of another instance, and
 * both keep the signal trace.
 */
function statementPositionAt(inst: InstanceSite, line: number, character: number): boolean {
  if (!pointIn(inst.range, line, character)) {
    return false;
  }
  for (const conn of inst.connections) {
    if (pointIn(conn.nameRange, line, character)) {
      return false;
    }
    for (const ref of conn.refs) {
      if (ref.fullPath.includes('.') && pointIn(ref.range, line, character)) {
        return false;
      }
    }
  }
  return true;
}

function positionBefore(pos: Pos, line: number, character: number): boolean {
  return pos.line < line || (pos.line === line && pos.character < character);
}

/**
 * The connected signal of a port connection the cursor points at.
 *
 * The reference has to name a net of the module that holds the instantiation:
 * a hierarchical path reaches into another instance and stays with the signal
 * trace. The implicit connection `.name` writes the port name over the net, so
 * there the cursor is on a port name and not on a connected signal.
 */
function connectedSignalAt(conn: PortConn, line: number, character: number): boolean {
  return conn.refs.some(
    (r) =>
      !r.fullPath.includes('.') &&
      !samePos(r.range, conn.nameRange) &&
      pointIn(r.range, line, character),
  );
}
