import type { PortDecl, Range, RefSite } from './ast';
import type { HdlIndex } from './index';
import { generateScopes, generateScopedName } from './index';
import { instancesOf, resolveAt } from './resolve';

/**
 * Signal tracing: from a name under the cursor, follow one hop of the design
 * across module boundaries.
 *
 * `down` follows fan-out - what the signal drives (a load): the left side of an
 * assignment that reads it, and the input port of a child it feeds. `up`
 * follows fan-in - what drives it: the right side of an assignment that writes
 * it, and the output port of a child that produces it. A port additionally
 * crosses to its containing instance: an `input` comes from the parent-side
 * net, an `output` goes to it.
 *
 * Each direction is one hop, not a transitive closure: the caller jumps to a
 * target and can trace again from there, so paths are walked a step at a time
 * and the user stays in control. The result is plain data; opening editors and
 * asking the user to disambiguate is the host layer's job.
 */
export type TraceDirection = 'up' | 'down';

export type TraceStepKind =
  /** A source feeding the signal, from an assignment's right-hand side. */
  | 'source'
  /** A sink the signal drives, from an assignment's left-hand side. */
  | 'sink'
  /** The signal runs into a child input. */
  | 'into-child'
  /** The signal comes out of a child output. */
  | 'from-child'
  /** A port is driven by its parent instance's connection. */
  | 'from-parent'
  /** A port drives its parent instance's connection. */
  | 'to-parent'
  /** An assignment drives the signal from a constant. */
  | 'constant';

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
  /** Signal name under the cursor. */
  name: string;
  /** Module the signal belongs to. */
  module: string;
  direction: TraceDirection;
  /** The declaration the cursor resolved to. */
  file: string;
  range: Range;
  targets: TraceStep[];
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
  if (!hit || !hit.resolution.ok) {
    return undefined;
  }
  const decl = hit.resolution.decl;
  // Only signals and ports are traceable; a module, parameter or macro has no
  // fan-in/fan-out to follow.
  if (decl.kind !== 'port' && decl.kind !== 'signal') {
    return undefined;
  }
  const mod = decl.moduleName ? index.resolveModule(decl.moduleName, decl.file) : hit.mod;
  if (!mod) {
    return undefined;
  }
  const name = decl.name;
  // The same net is written once bare and once as a generate scope path, e.g.
  // `t` and `g[0].t`. Normalise both spellings to the name the net list uses.
  const scopes = generateScopes(mod);
  const norm = (full: string) => generateScopedName(full, scopes) ?? full;
  const matches = (ref: RefSite) => norm(ref.fullPath) === name;

  const ports = new Map<string, PortDecl>(mod.ports.map((p) => [p.name, p]));
  const steps: TraceStep[] = [];
  const seen = new Set<string>();
  const keyOf = (f: string, r: Range) => `${f}:${r.start.line}:${r.start.character}`;
  const add = (s: TraceStep) => {
    // Never point at the signal's own declaration - that is where the cursor
    // already is.
    if (s.file === decl.file && keyOf(s.file, s.range) === keyOf(decl.file, decl.nameRange)) {
      return;
    }
    const key = keyOf(s.file, s.range);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    steps.push(s);
  };

  for (const a of mod.assigns) {
    if (a.local) {
      continue;
    }
    // A signal on the left side is driven; on the right side it is read.
    if (direction === 'up' && a.lhs.some(matches)) {
      if (a.rhs.length === 0) {
        add({ file: mod.file, range: a.range, kind: 'constant', label: 'constant', detail: `assign in ${mod.name}` });
      }
      for (const r of a.rhs) {
        add({ file: mod.file, range: r.range, kind: 'source', label: r.fullPath, detail: `assign in ${mod.name}` });
      }
    }
    if (direction === 'down' && a.rhs.some(matches)) {
      for (const r of a.lhs) {
        add({ file: mod.file, range: r.range, kind: 'sink', label: r.fullPath, detail: `assign in ${mod.name}` });
      }
    }
  }

  for (const inst of mod.instances) {
    const child = index.resolveModule(inst.moduleName, mod.file);
    for (const conn of inst.connections) {
      // `.name` shorthand names the parent net only in the port name.
      const connected = conn.refs.some(matches) || (conn.shorthand && conn.portName === name);
      if (!connected) {
        continue;
      }
      const port = child?.ports.find((p) => p.name === conn.portName);
      const dir = port?.direction;
      if (!child || !port) {
        // The child is missing or the port unknown: the direction that says
        // which side of the connection the signal is on is not known, and
        // guessing would send the trace the wrong way.
        continue;
      }
      if (direction === 'up' && (dir === 'output' || dir === 'inout')) {
        add({
          file: child.file,
          range: port.nameRange,
          kind: 'from-child',
          label: `${inst.name}.${port.name}`,
          detail: `${inst.moduleName} ${dir}`,
        });
      }
      if (direction === 'down' && (dir === 'input' || dir === 'ref' || dir === 'inout')) {
        add({
          file: child.file,
          range: port.nameRange,
          kind: 'into-child',
          label: `${inst.name}.${port.name}`,
          detail: `${inst.moduleName} ${dir}`,
        });
      }
    }
  }

  if (decl.kind === 'port') {
    const dir = decl.direction ?? ports.get(name)?.direction;
    // A port continues into the instances that contain the module: fan-in
    // arrives through the parent-side net of an input, fan-out leaves through
    // the parent-side net of an output.
    const wantUp = direction === 'up' && (dir === 'input' || dir === 'inout');
    const wantDown = direction === 'down' && (dir === 'output' || dir === 'inout');
    if (wantUp || wantDown) {
      for (const { mod: parent, inst } of instancesOf(index, mod.name)) {
        for (const conn of inst.connections) {
          if (conn.portName !== name) {
            continue;
          }
          for (const r of conn.refs) {
            add({
              file: parent.file,
              range: r.range,
              kind: wantUp ? 'from-parent' : 'to-parent',
              label: r.fullPath,
              detail: `parent ${parent.name}`,
            });
          }
        }
      }
    }
  }

  return { name, module: mod.name, direction, file: decl.file, range: decl.nameRange, targets: steps };
}
