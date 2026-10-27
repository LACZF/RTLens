/**
 * Hierarchical name resolution.
 *
 * Answers "where is this identifier declared?" for every shape that appears in
 * RTL: module names, instance names, ports, signals, parameters, functions,
 * interface members and dotted hierarchical references such as `u_alu.result`
 * or `top.u_a.u_b.q`.
 */

import type { HdlIndex } from './index';
import type {
  FunctionDecl,
  ModuleDef,
  ParamDecl,
  PortDecl,
  Range,
  RefSite,
  VarDecl,
} from './ast';
import { tokenize, type Token } from './lexer';
import { generateKey, scopeIndexOf } from './scopeIndex';
import { bracketText, memberAccessFollows } from './parser';
import type { PortDir } from './ast';

export type DeclKind =
  | 'module'
  | 'instance'
  | 'port'
  | 'signal'
  | 'param'
  | 'function'
  | 'interface'
  | 'genvar'
  | 'type'
  /** A `` `define `` macro named by a `` `NAME `` reference. */
  | 'macro'
  /** An argument of a function or task. */
  | 'arg';

export interface ResolvedDecl {
  kind: DeclKind;
  name: string;
  /** File that declares the symbol. */
  file: string;
  /** Full declaration extent. */
  range: Range;
  /** Identifier extent - what the cursor should land on. */
  nameRange: Range;
  moduleName?: string;
  direction?: PortDir;
  /** Instance that led here, when `kind === 'instance'`. */
  viaInstance?: string;
  /** Hierarchy path of the declaring scope, when known. */
  path?: string;
}

export type Resolution =
  | { ok: true; decl: ResolvedDecl }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Word extraction
// ---------------------------------------------------------------------------

export interface WordAtPosition {
  /** Simple name under / immediately before the cursor. */
  name: string;
  /** Dotted chain including `name`, e.g. `u_alu.result`. */
  fullPath: string;
  /** Path minus the final element, e.g. `u_alu`. */
  parentPath: string;
  /** Range of just `name`. */
  nameRange: Range;
  /** Range of the whole dotted chain. */
  fullRange: Range;
  /** Bit/array select text that follows the final element, e.g. `[7:0]`. */
  select: string;
  /** True when the word is written as a `` `NAME `` macro reference. */
  isMacro?: boolean;
}

/**
 * Extract the dotted identifier chain at a cursor position.
 *
 * Tolerates the cursor sitting just past the identifier (the usual case after
 * typing a dot or using F12 on a partially typed name).
 */
/**
 * The identifier chain at a token index.
 *
 * Token-level so that a caller walking a whole file (the navigation table)
 * resolves every occurrence from one tokenisation instead of one per cursor.
 */
export function wordAtToken(toks: Token[], idx: number): WordAtPosition | undefined {
  const ident = toks[idx];
  if (
    !ident ||
    (ident.kind !== 'ident' &&
      ident.kind !== 'macroRef' &&
      !(ident.kind === 'keyword' && ident.text.startsWith('$')) &&
      !(ident.kind === 'keyword' && (ident.text === 'this' || ident.text === 'super')))
  ) {
    return undefined;
  }
  // A macro reference carries the backtick in its text; the name a jump resolves
  // (and lands on) is the identifier after it.
  const identName = ident.kind === 'macroRef' ? (ident.name ?? ident.text.replace(/^`/, '')) : ident.text;
  const backtick = ident.kind === 'macroRef' && ident.text.startsWith('`') ? 1 : 0;
  const chain = expandChain(toks, idx);
  const last = chain.toks[chain.toks.length - 1];
  // The name is the token under the cursor, which for `u_alu.result` is
  // `result`. Taking the first element of the chain instead would make
  // find-references and rename on a hierarchical signal operate on the
  // instance name, silently returning the wrong symbol's locations.
  const name = identName;
  const parts = chain.parts;
  return {
    name,
    fullPath: parts.join('.'),
    parentPath: parts.slice(0, -1).join('.'),
    nameRange: backtick
      ? {
          start: { line: ident.range.start.line, character: ident.range.start.character + backtick },
          end: ident.range.end,
        }
      : chain.focus ?? ident.range,
    fullRange: { start: chain.toks[0].range.start, end: last.range.end },
    select: chain.select,
    isMacro: ident.kind === 'macroRef',
  };
}

export function wordAtPosition(source: string, line: number, character: number): WordAtPosition | undefined {
  const toks = tokenize(source).filter((t) => t.kind !== 'comment' && t.kind !== 'eof');
  const idx = toks.findIndex(
    (t) => t.range.start.line === line && t.range.start.character <= character && character <= t.range.end.character &&
      (t.kind === 'ident' || t.kind === 'macroRef' || (t.kind === 'keyword' && t.text.startsWith('$'))),
  );
  if (idx < 0) {
    return undefined;
  }
  return wordAtToken(toks, idx);
}

/** Extend a token index left and right over `.name` and `[...]`. */
function expandChain(toks: Token[], idx: number): { toks: Token[]; parts: string[]; focus?: Range; select: string } {
  let start = idx;
  let end = idx;
  let select = '';

  for (;;) {
    const next = toks[end + 1];
    if (next?.text === '::') {
      // Scope qualification: `cfg::UNROLL` is walked as `cfg` then `UNROLL`.
      if (toks[end + 2] && (toks[end + 2].kind === 'ident' || toks[end + 2].kind === 'keyword')) {
        end += 2;
        continue;
      }
      break;
    }
    if (next?.text === '.') {
      const after = toks[end + 2];
      if (after && (after.kind === 'ident' || (after.kind === 'keyword' && (!isHardKeyword(after.text) || after.text === 'this' || after.text === 'super')))) {
        end += 2;
        continue;
      }
      break;
    }
    if (next?.text === '[') {
      const close = findClose(toks, end + 1);
      if (close < 0) {
        break;
      }
      // The index is walked over here; which of them it is - part of the path
      // or a select - is decided when the components are collected below.
      end = close;
      continue;
    }
    break;
  }
  for (;;) {
    const prev = toks[start - 1];
    const prev2 = toks[start - 2];
    if (prev?.text === ']') {
      // Walked left out of a chain: `...u.g_reg[0].regs` starts at the `u`.
      // Stepping over the index group alone would leave the path at
      // `g_reg[0].regs`, which no longer names a signal of the module. Only a
      // real chain step is walked: a packed dimension in a declaration
      // (`wire [7:0] name`) is preceded by a type keyword or nothing, and
      // glomming it would turn the name into `wire.name` and lose the signal.
      const open = findOpen(toks, start - 1);
      const step = open > 0 ? toks[open - 1] : undefined;
      if (step && (step.kind === 'ident' || step.kind === 'macroRef')) {
        start = open - 1;
        continue;
      }
      break;
    }
    if (prev?.text === '.' && prev2?.text === ']') {
      // `u.g_reg[0].regs` with the cursor on `regs`: the step to the left runs
      // into the index group, so the whole `.g_reg[0]` part is walked at once.
      const open = findOpen(toks, start - 2);
      if (open > 0) {
        start = open - 1;
        continue;
      }
      break;
    }
    if (prev?.text === '::' && prev2 && (prev2.kind === 'ident' || prev2.kind === 'keyword')) {
      start -= 2;
      continue;
    }
    if (prev?.text === '.' && prev2 && (prev2.kind === 'ident' || (prev2.kind === 'keyword' && (!isHardKeyword(prev2.text) || prev2.text === 'this' || prev2.text === 'super')))) {
      start -= 2;
      continue;
    }
    break;
  }

  // Only keep the dotted components; skips were already walked past.
  const parts: string[] = [];
  const kept: Token[] = [];
  for (let k = start; k <= end; k++) {
    const t = toks[k];
    if (t.text === '.') {
      continue;
    }
    if (t.text === '[') {
      const close = findClose(toks, k);
      if (close >= 0) {
        // `[...]` between two names of the chain - `u.g_reg[0].regs` - is how
        // the path picks one element of an array or of a generate block, so it
        // belongs to the name in front of it. Only a trailing index is a
        // select, and only that one is reported as one: taking the last index
        // seen anywhere in the chain made the select of `u.g[0].q` read `0`,
        // as if the `u` were a bit-selected signal.
        if (memberAccessFollows(toks, close + 1)) {
          const last = parts[parts.length - 1];
          if (last !== undefined) {
            parts[parts.length - 1] = last + bracketText(toks, k, close);
          }
        } else {
          select = toks.slice(k + 1, close).map((x) => x.text).join('');
        }
        k = close;
        continue;
      }
    }
    if (t.kind === 'ident' || t.kind === 'number' || t.kind === 'keyword' || t.kind === 'macroRef') {
      parts.push(t.kind === 'macroRef' ? (t.name ?? t.text.replace(/^`/, '')) : t.text);
      kept.push(t);
    }
  }
  return { toks: kept, parts, select };
}

function findClose(toks: Token[], open: number): number {
  let depth = 0;
  for (let k = open; k < toks.length; k++) {
    if (toks[k].text === '[') {
      depth++;
    } else if (toks[k].text === ']') {
      depth--;
      if (depth === 0) {
        return k;
      }
    }
  }
  return -1;
}

/** The index of the `[` that the `]` at `close` belongs to. */
function findOpen(toks: Token[], close: number): number {
  let depth = 0;
  for (let k = close; k >= 0; k--) {
    if (toks[k].text === ']') {
      depth++;
    } else if (toks[k].text === '[') {
      depth--;
      if (depth === 0) {
        return k;
      }
    }
  }
  return -1;
}

const HARD_KEYWORDS = new Set([
  'begin', 'end', 'module', 'endmodule', 'if', 'else', 'case', 'endcase', 'always',
  'assign', 'posedge', 'negedge', 'or', 'and', 'not', 'integer', 'logic', 'wire',
  'reg', 'bit', 'signed', 'parameter', 'localparam', 'function', 'task', 'generate',
  'endgenerate', 'default', 'for', 'while', 'return',
]);

function isHardKeyword(t: string): boolean {
  return HARD_KEYWORDS.has(t);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  /**
   * Hierarchy path of `mod` (e.g. `top.u_alu`) when known, so the resolution can
   * report the declaring scope path.
   */
  path?: string;
  /** Guard against pathological hierarchies. */
  maxDepth?: number;
}

const MAX_DESCENT = 32;

/**
 * Resolve a dotted path starting in `mod`.
 *
 * `path[0]` is looked up in the scope of `mod`; if it names a submodule instance
 * (or an interface, or a top-level module name) the remaining elements are
 * resolved inside that module.
 */
export function resolvePath(
  index: HdlIndex,
  mod: ModuleDef | undefined,
  path: string[],
  opts: ResolveOptions = {},
): Resolution {
  if (!mod || path.length === 0) {
    return { ok: false, reason: 'no module scope' };
  }
  // `this.` names the current class; `super.` names its superclass when the
  // parent is in the index, and falls back to the current class when it is not.
  if (path.length > 1 && (path[0] === 'this' || path[0] === 'super')) {
    const scope =
      path[0] === 'super' && mod.superClass
        ? index.resolveModule(mod.superClass, mod.file) ?? mod
        : mod;
    return descend(index, scope, path.slice(1), opts.path ? [opts.path] : [], 0);
  }
  const maxDepth = opts.maxDepth ?? MAX_DESCENT;
  if (path.length > maxDepth) {
    return { ok: false, reason: 'reference too deep' };
  }
  return descend(index, mod, path, opts.path ? [opts.path] : [], 0);
}

function descend(
  index: HdlIndex,
  mod: ModuleDef,
  path: string[],
  scopePath: string[],
  depth: number,
  genPath: string[] = [],
): Resolution {
  if (depth > MAX_DESCENT) {
    return { ok: false, reason: 'hierarchy too deep' };
  }
  const head = path[0];

  if (path.length === 1) {
    return resolveInScope(index, mod, head, scopePath, genPath.join('.'));
  }

  // 1. A submodule instance in the current scope. `u[0]` is one element of an
  //    arrayed instantiation, which the index holds as a single instance. The
  //    saved table answers all three spellings; when two instances could match,
  //    the one written first wins, which is what the linear scan did.
  const ix = scopeIndexOf(mod);
  const base = baseName(head);
  const byHead = ix.instances.get(head);
  const byBase = base === head ? undefined : ix.instances.get(base);
  const pick = byHead && byBase ? (byHead.idx <= byBase.idx ? byHead : byBase) : (byHead ?? byBase);
  const inst = pick?.inst;
  if (inst) {
    const child = index.resolveModule(inst.moduleName, mod.file);
    if (child) {
      return descend(index, child, path.slice(1), [...scopePath, head], depth + 1);
    }
    return {
      ok: true,
      decl: {
        kind: 'instance',
        name: head,
        file: mod.file,
        range: inst.range,
        nameRange: inst.nameRange,
        moduleName: inst.moduleName,
        path: scopePath.concat(head).join('.'),
      },
    };
  }

  // 2. An interface port: `bus.data` resolves inside the interface.
  const port = ix.ports.get(head);
  if (port) {
    const ifaceName = port.interfaceName ?? (port.dataType.t === 'interface' ? port.dataType.name : undefined);
    if (ifaceName) {
      const iface = index.resolveInterface(ifaceName);
      if (iface) {
        return descend(index, iface, path.slice(1), [...scopePath, head], depth + 1);
      }
    }
  }

  // 3. A module name used as a scope root (`top.u_a.u_b.sig` from anywhere).
  const asModule = index.resolveModule(head, mod.file);
  if (asModule) {
    return descend(index, asModule, path.slice(1), [head], depth + 1);
  }

  // 4. A generate block. The block has no module of its own - everything in it
  //    lives in the enclosing module - so the label is stepped over and the
  //    rest is looked up in the same scope, remembering which block it came
  //    from. `u.g_reg[0].regs` is how a testbench reads a signal that a
  //    generate loop declares, and it used to resolve to nothing at all.
  if (isGenerateLabel(mod, genPath, head)) {
    return descend(index, mod, path.slice(1), scopePath, depth + 1, [...genPath, head]);
  }

  // 5. A whole dotted remainder, e.g. `g_par[0].u_par.sig` in one step.
  const dotted = path.join('.');
  // Try to resolve as method in current module/class
  if (path.length === 2) {
    const fn = resolveInScope(index, mod, path[1], scopePath);
    if (fn.ok && fn.decl.kind === 'function') {
      return fn;
    }
  }
  return resolveInScope(index, mod, dotted, scopePath);
}

/** The name in front of a trailing index: `u[0]` -> `u`. */
function baseName(segment: string): string {
  const at = segment.lastIndexOf('[');
  return at < 0 ? segment : segment.slice(0, at);
}

/**
 * Whether `segment` names a generate block that holds something in this module.
 * `genPath` is the part of the block path already consumed, so `n[0]` is only a
 * label of its own when it follows `o[1]`.
 */
function isGenerateLabel(mod: ModuleDef, genPath: string[], segment: string): boolean {
  const here = [...genPath, segment].join('.');
  return scopeIndexOf(mod).generates.some((g) => g === here || g.startsWith(`${here}.`));
}

/** Resolve a single name inside one module scope. */
export function resolveInScope(
  index: HdlIndex,
  mod: ModuleDef,
  name: string,
  scopePath: string[] = [],
  genPath?: string,
): Resolution {
  // The declaration the path came out of a generate block, e.g. the second
  // `wire q;` of a generate loop. Every iteration declares its own copy under
  // the same name, so the block path is what tells them apart.
  if (genPath) {
    const ix0 = scopeIndexOf(mod);
    const port = ix0.genPorts.get(generateKey(name, genPath));
    if (port) {
      return declResolution(name, { kind: 'port', decl: port, owner: mod }, scopePath);
    }
    const param = ix0.genParams.get(generateKey(name, genPath));
    if (param) {
      return declResolution(name, { kind: 'param', decl: param, owner: mod }, scopePath);
    }
    const genVar = ix0.genVars.get(generateKey(name, genPath));
    if (genVar) {
      return declResolution(name, { kind: 'var', decl: genVar, owner: mod }, scopePath);
    }
  }
  // Module name (a definition, or a reference to a black box).
  const modDef = index.resolveModule(name, mod.file);
  if (modDef && name === mod.name) {
    return {
      ok: true,
      decl: {
        kind: 'module',
        name,
        file: modDef.file,
        range: modDef.range,
        nameRange: modDef.nameRange,
        moduleName: modDef.name,
        path: scopePath.join('.'),
      },
    };
  }

  // Declaration tables take precedence over a same-named module elsewhere.
  const decl = index.findDecl(mod, name);
  if (decl) {
    return declResolution(name, decl, scopePath);
  }

  // An instance of a module defined in this workspace.
  const inst = scopeIndexOf(mod).instances.get(name)?.inst;
  if (inst) {
    return {
      ok: true,
      decl: {
        kind: 'instance',
        name,
        file: mod.file,
        range: inst.range,
        nameRange: inst.nameRange,
        moduleName: inst.moduleName,
        path: scopePath.concat(name).join('.'),
      },
    };
  }

  if (modDef) {
    return {
      ok: true,
      decl: {
        kind: 'module',
        name,
        file: modDef.file,
        range: modDef.range,
        nameRange: modDef.nameRange,
        moduleName: modDef.name,
        path: scopePath.join('.'),
      },
    };
  }

  return { ok: false, reason: `"${name}" not found in ${mod.name}` };
}

function declResolution(
  name: string,
  decl:
    | { kind: 'port'; decl: PortDecl; owner: ModuleDef }
    | { kind: 'param'; decl: ParamDecl; owner: ModuleDef }
    | { kind: 'var'; decl: VarDecl; owner: ModuleDef }
    | { kind: 'function'; decl: FunctionDecl; owner: ModuleDef }
    | { kind: 'arg'; decl: PortDecl; owner: ModuleDef },
  scopePath: string[],
): Resolution {
  const path = scopePath.join('.');
  // The declaration can live in another scope: a name borrowed from a package
  // belongs to that package, so a jump to its definition has to open the
  // package's file and name that package as the scope.
  const owner = decl.owner;
  switch (decl.kind) {
    case 'port':
      return {
        ok: true,
        decl: {
          kind: 'port',
          name,
          file: owner.file,
          range: decl.decl.range,
          nameRange: decl.decl.nameRange,
          moduleName: owner.name,
          direction: decl.decl.direction,
          path,
        },
      };
    case 'param':
      return {
        ok: true,
        decl: {
          kind: 'param',
          name,
          // An enum member of a header typedef: same as above.
          file: decl.decl.file ?? owner.file,
          range: decl.decl.range,
          nameRange: decl.decl.nameRange,
          moduleName: owner.name,
          path,
        },
      };
    case 'function':
      return {
        ok: true,
        decl: {
          kind: 'function',
          name,
          file: owner.file,
          range: decl.decl.range,
          nameRange: decl.decl.nameRange,
          moduleName: owner.name,
          path,
        },
      };
    case 'arg':
      // An argument belongs to the function or task that declares it, so the
      // file and scope reported are the module that holds it, not a port list.
      return {
        ok: true,
        decl: {
          kind: 'arg',
          name,
          file: owner.file,
          range: decl.decl.range,
          nameRange: decl.decl.nameRange,
          moduleName: owner.name,
          direction: decl.decl.direction,
          path,
        },
      };
    case 'var':
      return {
        ok: true,
        decl: {
          kind: decl.decl.kind === 'genvar' ? 'genvar' : decl.decl.kind === 'typedef' ? 'type' : 'signal',
          name,
          // A typedef the module borrows from an included header is declared in
          // that header, so the jump has to open it.
          file: decl.decl.file ?? owner.file,
          range: decl.decl.range,
          nameRange: decl.decl.nameRange,
          moduleName: owner.name,
          path,
        },
      };
  }
}

/**
 * Whether a rename here would be complete.
 *
 * Two cases would leave the design broken, so both are refused:
 *
 * - A name a module borrows with `import` is declared in the package, and the
 *   module names it in the `import` statement as well. Neither the import line
 *   nor a use in another importing module is a reference the rename can see.
 * - A function or task argument is declared in the header, which is not a
 *   reference, and a non-ANSI argument is declared a second time in the body.
 *   Renaming only the uses would leave both declarations with the old name.
 */
export function renameAllowed(resolution: Resolution, file: string): boolean {
  if (!resolution.ok) {
    return true;
  }
  return resolution.decl.file === file && resolution.decl.kind !== 'arg' && resolution.decl.kind !== 'macro';
}

/**
 * Resolve a `` `NAME `` macro reference to its `` `define ``. Macros are
 * textual: there is no scope to walk, so the index picks the definition (same
 * file first, then same directory, then any) and this wraps it as a resolution.
 */
export function resolveMacro(index: HdlIndex, name: string, fromFile?: string): Resolution {
  const def = index.resolveMacro(name, fromFile);
  if (!def) {
    return { ok: false, reason: `macro "${name}" not found` };
  }
  return {
    ok: true,
    decl: {
      kind: 'macro',
      name,
      file: def.file,
      range: def.range,
      nameRange: def.nameRange,
    },
  };
}

/** Resolve a reference site collected by the parser. */
export function resolveRef(
  index: HdlIndex,
  mod: ModuleDef,
  ref: RefSite,
  opts: ResolveOptions = {},
): Resolution {
  const parts = ref.fullPath ? ref.fullPath.split('.') : [ref.name];
  return resolvePath(index, mod, parts, opts);
}

/**
 * Given a cursor position, resolve the identifier under it. This is the entry
 * point used by the definition / hover / rename providers.
 */
export function resolveAt(
  index: HdlIndex,
  file: string,
  source: string,
  line: number,
  character: number,
): { word: WordAtPosition; mod: ModuleDef | undefined; resolution: Resolution } | undefined {
  const word = wordAtPosition(source, line, character);
  if (!word) {
    return undefined;
  }
  const mod = index.moduleAtLine(file, line);
  const parts = word.fullPath.split('.');
  // A `NAME reference names a macro, not a scope symbol; only fall back to the
  // ordinary walk when no `define declares it (a macro used as a module name,
  // for instance).
  const macro = word.isMacro ? resolveMacro(index, word.name, file) : undefined;
  const resolution = macro && macro.ok ? macro : resolvePath(index, mod, parts);
  return { word, mod, resolution };
}

/**
 * Narrow a reference range to the leaf name inside it.
 *
 * A package-qualified reference is one reference that spans both halves -
 * `cfg::WIDTH` - so that hovering and highlighting cover the whole qualified
 * name. Renaming has to replace the leaf only, otherwise the qualifier is
 * destroyed along with it. Pure so the rename path can be tested.
 */
export function leafRangeIn(
  refRange: Range,
  text: string,
  name: string,
): Range | undefined {
  // A multi-line reference cannot hold a qualified path, so there is nothing to
  // narrow to.
  if (refRange.start.line !== refRange.end.line) {
    return undefined;
  }
  const line = text.split('\n')[refRange.start.line] ?? '';
  const slice = line.slice(refRange.start.character, refRange.end.character);
  if (slice === name) {
    return refRange;
  }
  if (!slice.endsWith(name)) {
    return undefined;
  }
  // A prefix means a qualifier or a hierarchy step: only the trailing name is
  // the thing being renamed.
  const prefix = slice.slice(0, slice.length - name.length);
  if (prefix && !/[.:]\s*$/.test(prefix)) {
    return undefined;
  }
  return {
    start: { line: refRange.end.line, character: refRange.end.character - name.length },
    end: { line: refRange.end.line, character: refRange.end.character },
  };
}

/** All instantiation sites of a module, via the index's reverse edges (O(parents)). */
export function instancesOf(
  index: HdlIndex,
  name: string,
): { mod: ModuleDef; inst: ModuleDef['instances'][number] }[] {
  return index.parentsOf(name).map((p) => ({ mod: p.parent, inst: p.inst }));
}

/** All reference sites to `name` across the workspace. */
export function referencesTo(index: HdlIndex, name: string): { mod: ModuleDef; ref: RefSite }[] {
  const out: { mod: ModuleDef; ref: RefSite }[] = [];
  for (const m of index.allModules()) {
    for (const ref of m.refs) {
      if (ref.name === name || ref.fullPath === name || ref.fullPath.endsWith(`.${name}`)) {
        out.push({ mod: m, ref });
      }
    }
  }
  return out;
}

/**
 * The scope a lookup was made in.
 *
 * `referencesTo` matches by name over the whole workspace, which is right for
 * the things Verilog scopes by name alone (modules, parameters, functions,
 * interfaces, typedefs) and far too broad for a plain signal: `data` in one
 * module has nothing to do with `data` in another. Passing the scope keeps
 * find-references and rename from touching unrelated modules.
 */
export interface RefScope {
  /** File of the module the lookup started in. */
  file: string;
  /** Name of that module; two modules in one file still have separate names. */
  moduleName: string;
  /** True for symbol kinds that are visible from every module. */
  workspaceWide?: boolean;
}

/** A reference belongs to the same symbol when it sits in the same module. */
export function refInScope(mod: ModuleDef, scope: RefScope): boolean {
  return !!scope.workspaceWide || (mod.file === scope.file && mod.name === scope.moduleName);
}

/**
 * References to `name`, restricted to `scope` when one is given. The declaration
 * itself is not part of the result: callers add it from the resolution, because
 * only they know whether the cursor was on the definition or on a use.
 */
export function referencesInScope(
  index: HdlIndex,
  name: string,
  scope?: RefScope,
): { mod: ModuleDef; ref: RefSite }[] {
  const all = referencesTo(index, name);
  return scope ? all.filter((r) => refInScope(r.mod, scope)) : all;
}
