import { generateScopedName, generateScopes } from './index';
import type { HdlIndex } from './index';
import type { ModuleDef } from './ast';

/**
 * Who reads a signal of a module and who drives it.
 *
 * The distinction is what makes the "Nets" view worth looking at, and it is not
 * the same thing as "is the name mentioned somewhere": `assign y = a;` reads
 * `a` and drives `y`, and on a port connection it depends on the direction of
 * the *child* port, because `.out(y)` drives `y` in the parent while `.in(y)`
 * only reads it.
 */
export interface SignalUse {
  /** Sources that read the signal, e.g. `assign`, `always`, `u1.i (input)`. */
  readers: string[];
  /** Sources that drive the signal. */
  writers: string[];
}

export type UsageMap = Map<string, SignalUse>;

function add(map: UsageMap, name: string, role: 'read' | 'write', label: string): void {
  // `$clog2`, `$signed` and friends are functions of the language, not signals
  // of the design: nothing to point at, no width, no driver - they stay out of
  // the net list.
  if (!name || name.startsWith('$')) {
    return;
  }
  const entry = map.get(name) ?? { readers: [], writers: [] };
  const list = role === 'read' ? entry.readers : entry.writers;
  if (!list.includes(label)) {
    list.push(label);
  }
  map.set(name, entry);
}

/**
 * Usage of every signal of `mod`, keyed by the bare name as written in that
 * module: ports, nets, variables and parameters.
 *
 * Hierarchical expressions (`u_leaf.out`) belong to the child and are not
 * counted here - the child's own module has the entry for `out`.
 */
export function signalUsage(index: HdlIndex, mod: ModuleDef): UsageMap {
  const usage: UsageMap = new Map();
  // `g[0].t` is a way of writing the copy of `t` that the generate block
  // declares. The netlist of a module has one `t`, so the reference is filed
  // under the name it has in the module rather than under the path it is
  // written with; a path through a child instance keeps the path.
  const scopes = generateScopes(mod);
  const key = (fullPath: string) => generateScopedName(fullPath, scopes) ?? fullPath;

  // Continuous and procedural assignments. The parser already marks the side
  // each reference is on, so the direction does not have to be guessed.
  for (const a of mod.assigns) {
    // `function`/`task` bodies assign automatic variables, not module signals:
    // `tmp = x[0];` in a function drives nothing anybody else can see.
    if (a.local) {
      continue;
    }
    const how = a.inAlways ? 'always' : 'assign';
    for (const ref of a.lhs) {
      add(usage, key(ref.fullPath), 'write', how);
    }
    for (const ref of a.rhs) {
      add(usage, key(ref.fullPath), 'read', how);
    }
  }

  // The signals of an event control belong to no assignment site:
  // `always_ff @(posedge clk)` reads the clock. A name that only ever gates a
  // block is read the same way: `if (en) q <= d;` is a read of `en`.
  for (const ref of mod.refs) {
    if (ref.isDecl) {
      continue;
    }
    // A generate condition is read while the design is elaborated, not while it
    // runs, and saying so is the difference between a true label and a wrong
    // one.
    if (ref.context === 'generate') {
      add(usage, key(ref.fullPath), 'read', 'generate');
      continue;
    }
    if (ref.context !== 'event' && ref.context !== 'condition') {
      continue;
    }
    add(usage, key(ref.fullPath), 'read', 'always');
  }

  // Port connections: the child's port direction decides which side of the
  // connection the parent-side signal is on.
  for (const inst of mod.instances) {
    const childDef = index.resolveModule(inst.moduleName, mod.file);
    for (const conn of inst.connections) {
      const port = childDef?.ports.find((p) => p.name === conn.portName);
      const dir = port?.direction;
      const label = `${inst.name}.${conn.portName}${dir ? ` (${dir})` : ''}`;
      for (const ref of conn.refs) {
        // Without the child definition the direction is unknown. An output is
        // the common case for the right-hand side of a connection, but guessing
        // would mislabel the net, so it is recorded as a read only.
        if (dir === 'output' || dir === 'inout') {
          add(usage, key(ref.fullPath), 'write', label);
        }
        if (dir === 'input' || dir === 'ref' || dir === undefined) {
          add(usage, key(ref.fullPath), 'read', label);
        }
        if (dir === 'ref') {
          // A `ref` argument is both read and written by the callee.
          add(usage, ref.fullPath, 'write', label);
        }
      }
    }
  }

  return usage;
}

/** The usage part on its own, e.g. `read by assign · driven by u1.o (output)`. */
export function summariseUse(use: SignalUse | undefined): string {
  const bits: string[] = [];
  if (use?.readers.length) {
    bits.push(`read by ${use.readers.join(', ')}`);
  }
  if (use?.writers.length) {
    bits.push(`driven by ${use.writers.join(', ')}`);
  }
  if (!bits.length) {
    bits.push('unused');
  }
  return bits.join(' · ');
}

/**
 * One-line summary of a signal's usage for a tree view, e.g.
 * `wire · read by u1.i (input) · driven by assign`.
 */
export function describeUse(kind: string, use: SignalUse | undefined): string {
  return `${kind} · ${summariseUse(use)}`;
}

/** One row of the Nets view: a port or a net/variable of a module. */
export interface NetRow {
  name: string;
  /** Zero-based line of the name, so a click can open it. */
  line: number;
  /** Right-hand summary, e.g. `input · read by assign`. */
  description: string;
  tooltip: string;
  isPort: boolean;
}

/**
 * The rows the Nets view shows for `mod`: ports first, then nets/variables.
 *
 * The order is fixed so the webview can re-sort for a fuzzy query without
 * losing the ports-before-nets grouping as the ranking. `relFile` is only used
 * in the tooltips.
 */
export function netsRows(index: HdlIndex, mod: ModuleDef, relFile: string): NetRow[] {
  const usage = signalUsage(index, mod);
  const rows: NetRow[] = [];
  for (const p of mod.ports) {
    // A port is unused only when nothing in the module touches it: an output
    // that an `assign` drives is used even though no instance reads it here.
    const summary = summariseUse(usage.get(p.name));
    rows.push({
      name: p.name,
      line: p.nameRange.start.line,
      description: `${p.direction} · ${summary}`,
      tooltip: `port ${p.name}\n${relFile}:${p.nameRange.start.line + 1}`,
      isPort: true,
    });
  }
  for (const d of mod.decls) {
    if (d.kind === 'typedef' || d.kind === 'genvar') {
      continue;
    }
    rows.push({
      name: d.name,
      line: d.nameRange.start.line,
      description: describeUse(d.kind, usage.get(d.name)),
      tooltip: `${d.name} (${d.kind})\n${relFile}:${d.nameRange.start.line + 1}`,
      isPort: false,
    });
  }
  return rows;
}
