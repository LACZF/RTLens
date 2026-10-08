import { GATE_KEYWORDS } from './lexer';
import type { HdlIndex } from './index';
import type { Range } from './ast';

/**
 * Everything the Problems view reports.
 *
 * The rules live here rather than in the tree provider so they can be tested
 * without an extension host. All of them are deliberately conservative: a false
 * positive in a diagnostics list is worse than a missed one, because the user
 * cannot tell which is which.
 */

export type ProblemSeverity = 'error' | 'warning';

export type ProblemKind = 'unresolved-module' | 'guessed-direction' | 'undeclared-name';

export interface Problem {
  kind: ProblemKind;
  severity: ProblemSeverity;
  /** First line of the message, shown as the tree label. */
  label: string;
  /** Explanation shown on hover. */
  tooltip: string;
  file: string;
  /** Zero-based line of the range to reveal. */
  line: number;
  /** Zero-based character of the range to reveal. */
  character: number;
  range: Range;
  moduleName: string;
}

/** A module type that is instantiated but not in the index. */
export function unresolvedInstances(index: HdlIndex): Problem[] {
  const out: Problem[] = [];
  const seen = new Set<string>();
  for (const m of index.allModules()) {
    for (const i of m.instances) {
      if (index.resolveModule(i.moduleName, m.file)) {
        continue;
      }
      // A gate primitive is a built-in, not a module the workspace is missing:
      // `and g1 (y, a, b);` is legal Verilog and there is nothing to resolve.
      if (GATE_KEYWORDS.has(i.moduleName)) {
        continue;
      }
      // One generate iteration per line would otherwise report the same missing
      // module once per unrolled instance.
      const key = `${m.file}:${i.moduleNameRange.start.line}:${i.moduleName}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push({
        kind: 'unresolved-module',
        severity: 'error',
        label: `Module "${i.moduleName}" not found`,
        tooltip:
          `Instantiated as "${i.name}" in ${m.name}.\n` +
          'It may be in an unindexed file, a macro, or an inactive `ifdef` branch.',
        file: m.file,
        line: i.moduleNameRange.start.line,
        character: i.moduleNameRange.start.character,
        range: i.moduleNameRange,
        moduleName: m.name,
      });
    }
  }
  return out;
}

/**
 * A port whose direction could not be determined. Reported as a warning
 * because the parser has to assume one to build a connection list, and for a
 * non-ANSI port list that assumption is often wrong.
 */
export function guessedDirections(index: HdlIndex): Problem[] {
  const out: Problem[] = [];
  for (const m of index.allModules()) {
    for (const p of m.ports) {
      if (!p.guessDir) {
        continue;
      }
      // `module m (bus_if b);` with the interface in another file: the parser
      // had to assume a direction, but an interface port has no direction of
      // its own - the modport and the connection decide. Warning here would be
      // a false positive on correct code, and the answer is only knowable once
      // every file is in the index.
      if (p.declaredType && index.resolveInterface(p.declaredType)) {
        continue;
      }
      out.push({
        kind: 'guessed-direction',
        severity: 'warning',
        label: `Direction of "${p.name}" guessed`,
        tooltip:
          `Could not determine whether "${p.name}" of ${m.name} is an input or an output; ` +
          `assumed ${p.direction}.`,
        file: m.file,
        line: p.nameRange.start.line,
        character: p.nameRange.start.character,
        range: p.nameRange,
        moduleName: m.name,
      });
    }
  }
  return out;
}

/**
 * A name that is read or written but not visible where it is used.
 *
 * The rule is narrow on purpose. A dotted or scope-qualified path may belong to
 * a module that is not indexed, and so may anything connected to an unresolved
 * instance - both are already reported by {@link unresolvedInstances}, and
 * listing every name involved would bury that one message. System identifiers
 * and declarations are not uses.
 */
export function undeclaredNames(index: HdlIndex): Problem[] {
  const out: Problem[] = [];
  const seen = new Set<string>();
  for (const m of index.allModules()) {
    // Names that reach into a module the workspace does not have.
    const foreign = new Set<string>();
    for (const inst of m.instances) {
      if (index.resolveModule(inst.moduleName, m.file)) {
        continue;
      }
      for (const conn of inst.connections) {
        for (const ref of conn.refs) {
          foreign.add(ref.fullPath);
        }
      }
    }
    for (const r of m.refs) {
      if (r.isDecl || r.system || r.kind !== 'unknown') {
        continue;
      }
      const name = r.fullPath;
      if (name.includes('.') || name.includes('::') || foreign.has(name)) {
        continue;
      }
      // A module, interface or package name is visible without a declaration.
      if (index.resolveModule(name, m.file) || index.findDecl(m, name)) {
        continue;
      }
      const key = `${m.file}:${r.range.start.line}:${r.range.start.character}:${name}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push({
        kind: 'undeclared-name',
        severity: 'warning',
        label: `"${name}" is not declared`,
        tooltip:
          `${name} is used in ${m.name} but nothing declares it there.\n` +
          'It may be declared in another module (which does not make it visible here), ' +
          'come from a macro, an inactive `ifdef` branch, or a missing include.',
        file: m.file,
        line: r.range.start.line,
        character: r.range.start.character,
        range: r.range,
        moduleName: m.name,
      });
    }
  }
  return out;
}

/** Every problem, most severe first. */
export function collectProblems(index: HdlIndex): Problem[] {
  return [...unresolvedInstances(index), ...guessedDirections(index), ...undeclaredNames(index)].sort(
    (a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1),
  );
}
