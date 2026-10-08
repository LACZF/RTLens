import type { HdlIndex } from './index';
import type { ModuleDef } from './ast';
import { resolveInScope, resolvePath } from './resolve';

/**
 * Semantic tokens for a Verilog file.
 *
 * The TextMate grammar only knows about keywords and numbers; this is the part
 * it cannot do: knowing that an identifier is a module type, an instance label,
 * a port of the module being instantiated, a declared signal, a parameter, ...
 *
 * The output is deliberately plain data with no `vscode` types, so the rule can
 * be unit tested and the provider is left with nothing but encoding.
 */

export const TOKEN_TYPES = [
  'hdlModule',
  'hdlInstance',
  'hdlPort',
  'hdlSignal',
  'hdlParameter',
  'hdlFunction',
  'hdlGenvar',
  'hdlType',
  'hdlSystemId',
] as const;

export type TokenType = (typeof TOKEN_TYPES)[number];

export interface HdlToken {
  line: number;
  /** Zero-based character of the first character of the token. */
  character: number;
  length: number;
  type: TokenType;
}

/** System functions and identifiers, which are never declared anywhere. */
const SYSTEM_PREFIX = '$';

export function tokenFor(kind: string): TokenType | undefined {
  switch (kind) {
    case 'module':
    case 'instance':
      return kind === 'module' ? 'hdlModule' : 'hdlInstance';
    case 'port':
      return 'hdlPort';
    case 'signal':
      return 'hdlSignal';
    case 'param':
      return 'hdlParameter';
    case 'function':
      return 'hdlFunction';
    case 'genvar':
      return 'hdlGenvar';
    case 'type':
    case 'interface':
      return 'hdlType';
    default:
      return undefined;
  }
}

/**
 * Tokens for the modules declared in one file.
 *
 * Two rules matter for the result to be usable at all:
 *
 * - **Sorted.** The editor decodes the stream as deltas, so a token that goes
 *   backwards silently corrupts everything after it. Declarations and
 *   references are collected in whatever order they are easiest to find and
 *   sorted here, once.
 * - **One token per position.** A name that is both declared and used (a port
 *   in the header that is also read in the body, a parameter used in its own
 *   default) must not be emitted twice.
 */
export function computeTokens(index: HdlIndex, mods: ModuleDef[]): HdlToken[] {
  const out: HdlToken[] = [];
  const push = (
    line: number,
    character: number,
    length: number,
    type: TokenType,
  ): void => {
    if (length > 0) {
      out.push({ line, character, length, type });
    }
  };

  for (const mod of mods) {
    declarationTokens(mod, push);
    referenceTokens(index, mod, push);
  }

  out.sort((a, b) => (a.line !== b.line ? a.line - b.line : a.character - b.character));
  const seen = new Set<string>();
  const deduped: HdlToken[] = [];
  for (const t of out) {
    const k = `${t.line}:${t.character}:${t.length}`;
    if (!seen.has(k)) {
      seen.add(k);
      deduped.push(t);
    }
  }
  return deduped;
}

type Push = (line: number, character: number, length: number, type: TokenType) => void;

function declarationTokens(mod: ModuleDef, push: Push): void {
  const add = (
    r: { start: { line: number; character: number }; end: { line: number; character: number } },
    t: TokenType,
  ): void => push(r.start.line, r.start.character, r.end.character - r.start.character, t);

  for (const p of mod.ports) {
    add(p.nameRange, 'hdlPort');
  }
  for (const p of mod.params) {
    add(p.nameRange, 'hdlParameter');
  }
  for (const d of mod.decls) {
    if (d.kind === 'genvar') {
      add(d.nameRange, 'hdlGenvar');
    } else if (d.kind === 'typedef') {
      add(d.nameRange, 'hdlType');
    } else {
      add(d.nameRange, 'hdlSignal');
    }
  }
  for (const f of mod.funcs) {
    add(f.nameRange, 'hdlFunction');
  }
  for (const i of mod.instances) {
    // The module type in front of the instance label, and the label itself.
    add(i.moduleNameRange, 'hdlModule');
    add(i.nameRange, 'hdlInstance');
  }
}

function referenceTokens(index: HdlIndex, mod: ModuleDef, push: Push): void {
  for (const ref of mod.refs) {
    if (ref.system) {
      push(ref.range.start.line, ref.range.start.character, ref.name.length, 'hdlSystemId');
      continue;
    }
    if (ref.isDecl) {
      continue;
    }
    // Only the last element of a dotted path is coloured, and it gets the type of
    // what it actually resolves to: in `u_leaf.out`, `out` is a port, not a field
    // of the instance.
    const parts = ref.fullPath.split(/\.|::/);
    const last = parts[parts.length - 1];
    const r = parts.length > 1 ? resolvePath(index, mod, parts) : resolveInScope(index, mod, last);
    if (!r.ok) {
      // A name the parser put in a type position is a type even when no file in
      // the workspace declares it, which is the normal state of a design whose
      // shared types live in a header outside the scan. Colouring it cannot be
      // the wrong guess, so it does not need to resolve first.
      if (ref.kind === 'type') {
        push(
          ref.range.start.line,
          ref.range.start.character + (ref.fullPath.length - last.length),
          last.length,
          'hdlType',
        );
        continue;
      }
      // An unresolved name is left uncoloured rather than guessed at; a system
      // identifier that did not get flagged by the parser is still one.
      if (last.startsWith(SYSTEM_PREFIX)) {
        push(ref.range.start.line, ref.range.start.character, last.length, 'hdlSystemId');
      }
      continue;
    }
    const t = tokenFor(r.decl.kind);
    if (!t) {
      continue;
    }
    // The ref range covers the whole dotted path (or `pkg::NAME`), so the token
    // has to start on the last element.
    push(ref.range.start.line, ref.range.start.character + (ref.fullPath.length - last.length), last.length, t);
  }
}
