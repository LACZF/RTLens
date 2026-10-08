/**
 * Structural parser for Verilog / SystemVerilog.
 *
 * This is intentionally *not* a full recursive-descent grammar. It performs a
 * structural scan of module scopes: module headers, port lists, declarations,
 * instantiations, continuous assignments and procedural assignments. That is
 * exactly the set of facts the editor features need (jump, hover, netlist,
 * hierarchy), and it degrades gracefully on syntax errors instead of bailing
 * out - which matters because the extension runs on unfinished files.
 */

import { tokenize, type Token, type Range, GATE_KEYWORDS, KEYWORDS } from './lexer';
import type {
  AssignSite,
  ConstExpr,
  DataType,
  DefParam,
  FunctionDecl,
  ImportDecl,
  ImportedName,
  InstanceSite,
  ModuleDef,
  ModuleKind,
  ParamDecl,
  ParamOverride,
  ParseResult,
  PortConn,
  PortDecl,
  PortDir,
  RefSite,
  ValueRange,
  VarDecl,
  VarKind,
} from './ast';
import { MapScope, exprFromTokens, normalizeExpr, typeWidth, evalTokenExpr } from './fold';

const SCOPE_OPENER_KEYWORD: Record<string, ModuleKind> = {
  module: 'module',
  macromodule: 'module',
  interface: 'interface',
  program: 'program',
  package: 'package',
  primitive: 'primitive',
  class: 'class',
};

const SCOPE_CLOSER: Record<string, string> = {
  module: 'endmodule',
  macromodule: 'endmodule',
  interface: 'endinterface',
  program: 'endprogram',
  package: 'endpackage',
  primitive: 'endprimitive',
  class: 'endclass',
};

/**
 * Keywords that open a nested block inside a module body. `bind` and `let` are
 * statements that end in `;`, not blocks: listing them here sent the whole
 * `bind` statement into the block parser, which skipped it, and the bound
 * instance was lost.
 */
const BLOCK_OPENERS = new Set<string>([
  'begin', 'generate', 'case', 'casex', 'casez', 'fork', 'function', 'task',
  'specify', 'table', 'property', 'sequence', 'covergroup', 'cover', 'clocking',
  'randcase', 'randsequence', 'constraint', 'checker', 'rand',
]);

const BLOCK_CLOSERS = new Set<string>([
  'end', 'endcase', 'endgenerate', 'endfunction', 'endtask', 'endspecify',
  'endtable', 'endproperty', 'endsequence', 'endgroup', 'endcover', 'endclocking',
  'endchecker', 'endconstraint', 'endrandcase', 'endrandsequence',
]);

/** Net types: they carry a range but no `logic`-style sign. */
const NET_KEYWORDS = new Set<string>([
  'wire', 'tri', 'tri0', 'tri1', 'triand', 'trior', 'trireg', 'wand', 'wor',
  'supply0', 'supply1', 'uwire', 'interconnect', 'net', 'var',
]);

const SCALAR_KEYWORDS = new Set<string>(['integer', 'int', 'longint', 'shortint', 'byte', 'time', 'real', 'realtime', 'shortreal', 'string', 'event', 'chandle']);

const MODIFIERS = new Set<string>([
  'signed', 'unsigned', 'packed', 'static', 'automatic', 'const', 'rand', 'randc',
  'unique', 'unique0', 'var', 'ref', 'protected', 'local', 'virtual', 'interconnect',
]);

/**
 * Conditional / repetitive constructs that may appear at module level inside a
 * generate region and may contain instantiations.
 */
const GENERATE_KEYWORDS = new Set<string>(['if', 'else', 'for', 'while', 'foreach', 'repeat']);

/**
 * Blocks that hold procedural statements. `always*` and `initial` have no closing
 * keyword, so they are recognized by name wherever a body may appear.
 */
const PROCEDURAL_KEYWORDS = new Set<string>([
  'always', 'always_comb', 'always_ff', 'always_latch', 'initial', 'final',
]);

/** Cap on generate-loop unrolling, so `for (i=0;i<1_000_000;i++)` cannot hang. */
const MAX_GENERATE_UNROLL = 64;

const ZERO_RANGE: Range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 0 },
};

const DIR_KEYWORDS = new Set<string>(['input', 'output', 'inout', 'ref']);

// ---------------------------------------------------------------------------

interface Slice {
  /** Inclusive token index of the first token. */
  from: number;
  /** Exclusive token index of the last token. */
  to: number;
}

class Cursor {
  constructor(
    readonly toks: Token[],
    public pos: number,
    public readonly end: number,
  ) {}

  get done(): boolean {
    return this.pos >= this.end;
  }

  peek(offset = 0): Token | undefined {
    return this.toks[this.pos + offset];
  }

  cur(): Token | undefined {
    return this.toks[this.pos];
  }

  next(): Token | undefined {
    return this.toks[this.pos++];
  }

  at(text: string): boolean {
    return this.toks[this.pos]?.text === text;
  }

  eat(text: string): boolean {
    if (this.at(text)) {
      this.pos++;
      return true;
    }
    return false;
  }

  slice(from: number, to: number): Cursor {
    return new Cursor(this.toks, from, Math.min(to, this.end));
  }

  /** Tokens from the cursor to `end` as a plain array. */
  rest(): Token[] {
    return this.toks.slice(this.pos, this.end);
  }
}

/** `.` starts a named connection; the lexer keeps `.*` as a single token. */
function isDotToken(text: string | undefined): boolean {
  return text === '.' || text === '.*';
}

function rangeOf(toks: Token[], from: number, to: number): Range {
  const a = toks[from]?.range.start ?? { line: 0, character: 0 };
  const b = toks[Math.max(from, to - 1)]?.range.end ?? a;
  return { start: a, end: b };
}

function joinText(toks: Token[]): string {
  return normalizeExpr(toks.map((t) => t.text).join(''));
}

const NO_SPACE_BEFORE = new Set([',', ';', ')', ']', '}', '.', "'"]);
const NO_SPACE_AFTER = new Set(['(', '[', '.', '#', '{', '@', "'"]);
const NO_SPACE_KEYWORD_CALL = new Set([
  'if', 'for', 'while', 'case', 'casex', 'casez', 'assign', 'return', 'always',
  'always_ff', 'always_comb', 'always_latch', 'assert', 'assume', 'cover', 'wait',
  'repeat', 'foreach', 'unique', 'priority', 'void',
]);

/**
 * Join tokens back into readable source text. Unlike `joinText` this keeps the
 * spacing a human would write, because the result is re-emitted into generated
 * modules where `alu_cout?rf_rdata:alu_sum` would be needlessly hard to read.
 */
function prettyJoin(toks: Token[]): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const prev = i > 0 ? toks[i - 1] : undefined;
    if (prev) {
      let space = true;
      if (NO_SPACE_BEFORE.has(t.text)) {
        space = false;
      } else if (NO_SPACE_AFTER.has(prev.text)) {
        space = false;
      } else if (t.text === '(') {
        space = !(NO_SPACE_KEYWORD_CALL.has(prev.text) || prev.text === '#' || prev.kind === 'number');
      } else if (t.text === ':' || prev.text === ':') {
        // A colon inside brackets is a packed range or a part select; one at
        // depth 0 is the `:` of a ternary operator.
        space = depth > 0 ? (prev.text === ':' ? false : false) : true;
      }
      if (space) {
        out += ' ';
      }
    }
    if (t.text === '(' || t.text === '[' || t.text === '{') {
      depth++;
    } else if (t.text === ')' || t.text === ']' || t.text === '}') {
      depth--;
    }
    out += t.text;
  }
  return out;
}

/**
 * End index (exclusive) of `toks[from..to)` with any trailing statement
 * terminator removed, so re-emitted expressions never carry a `;`.
 */
function trimSemi(toks: Token[], from: number, to: number): number {
  let end = to;
  while (end > from && toks[end - 1]?.text === ';') {
    end--;
  }
  return end;
}

function matchesClose(toks: Token[], i: number): boolean {
  return toks[i]?.kind === 'eof';
}

/** Index of the token that closes a bracket opened at `i` (toks[i] is the opener). */
export function matchBracket(toks: Token[], i: number, limit: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const open = toks[i]?.text;
  if (!open || pairs[open] === undefined) {
    return -1;
  }
  const close = pairs[open];
  let depth = 0;
  for (let k = i; k < limit; k++) {
    const t = toks[k];
    if (t.text === open) {
      depth++;
    } else if (t.text === close) {
      depth--;
      if (depth === 0) {
        return k;
      }
    }
  }
  return -1;
}

/**
 * Index of the token that closes the block opened by the keyword at `i`.
 * Returns `limit` when the block is unterminated.
 */
export function matchBlock(toks: Token[], i: number, limit: number): number {
  let depth = 0;
  for (let k = i; k < limit; k++) {
    const t = toks[k];
    if (t.kind === 'keyword') {
      if (BLOCK_OPENERS.has(t.text)) {
        depth++;
      } else if (BLOCK_CLOSERS.has(t.text)) {
        depth--;
        if (depth <= 0) {
          return k;
        }
      }
    }
  }
  return limit;
}

/**
 * Split a token range on top-level commas. A trailing `;` (left behind by
 * `statementEnd`) is trimmed so it never leaks into a value expression.
 */
export function splitTopLevel(toks: Token[], from: number, to: number): Slice[] {
  const out: Slice[] = [];
  while (to > from && toks[to - 1]?.text === ';') {
    to--;
  }
  let depth = 0;
  let blockDepth = 0;
  let start = from;
  for (let k = from; k < to; k++) {
    const t = toks[k];
    if (t.text === '(' || t.text === '[' || t.text === '{') {
      depth++;
    } else if (t.text === ')' || t.text === ']' || t.text === '}') {
      depth--;
    } else if (t.kind === 'keyword') {
      if (BLOCK_OPENERS.has(t.text)) {
        blockDepth++;
      } else if (BLOCK_CLOSERS.has(t.text)) {
        blockDepth--;
      }
    }
    if (t.text === ',' && depth === 0 && blockDepth === 0) {
      if (k > start) {
        out.push({ from: start, to: k });
      }
      start = k + 1;
    }
  }
  if (to > start) {
    out.push({ from: start, to });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

interface ParseContext {
  file: string;
  /** Parameters visible at the current scope, for constant folding. */
  scope: MapScope;
  /** True while inside always/initial/final - suppresses instantiation detection. */
  inProcedural: boolean;
  /** Nearest enclosing generate construct label, if any. */
  generate?: string;
  /** True when the enclosing generate is a conditional branch. */
  conditional?: boolean;
  /** Generate block path, e.g. `g_par[2]`, prepended to instance names. */
  genPrefix?: string;
}

export class Parser {
  private toks: Token[] = [];
  private modules: ModuleDef[] = [];
  private includes: string[] = [];
  private file = '';
  /** Typedefs declared outside any module scope, in source order. */
  private fileTypedefs: VarDecl[] = [];
  /** Self-references to the file-scope typedefs, one set per file. */
  private fileTypedefRefs: RefSite[] = [];
  /** Members of a file-scope `typedef enum {...}`, shared like the type is. */
  private fileEnumParams: ParamDecl[] = [];
  /** Names of every design scope declared in this file, however late. */
  private scopeNames = new Set<string>();
  /** `import` statements at file scope: what every module in the file borrows. */
  private fileImports: ImportDecl[] = [];

  parse(file: string, source: string): ParseResult {
    const t0 = Date.now();
    this.file = file;
    this.modules = [];
    this.includes = [];
    this.fileTypedefs = [];
    this.fileTypedefRefs = [];
    this.fileImports = [];
    this.scopeNames = new Set();
    this.toks = tokenize(source).filter((t) => t.kind !== 'comment');
    this.collectScopeNames();

    const c = new Cursor(this.toks, 0, this.toks.length);
    while (!c.done) {
      const t = c.cur()!;
      if (t.kind === 'directive') {
        this.handleDirective(t);
        c.pos++;
        continue;
      }
      if (t.kind === 'keyword' && t.text === 'typedef') {
        this.parseFileScopeTypedef(c);
        continue;
      }
      if (t.kind === 'keyword' && t.text === 'import') {
        // A file-scope import applies to every module below it, so it is
        // collected here and copied into each of them. A form that names no
        // package - `import "DPI-C" function ...;` - records nothing.
        this.parseImport(c, this.fileImports);
        continue;
      }
      if (t.kind === 'keyword' && SCOPE_OPENER_KEYWORD[t.text] !== undefined) {
        const m = this.parseModule(c);
        if (m) {
          this.modules.push(m);
        }
        continue;
      }
      c.pos++;
    }

    this.shareFileTypedefs();
    const timeMs = Date.now() - t0;
    return { file, modules: this.modules, includes: this.includes, timeMs };
  }

  /**
   * A `typedef` outside any module scope: the shared types at the top of a file
   * or in an include guard. Dropping them means every `my_t data;` below loses
   * its declaration - the name is not a keyword, so nothing declares it and the
   * variable ends up invisible to the netlist, hover, rename and tokens.
   *
   * The declaration itself goes to a scratch module, which lets the existing
   * typedef parser handle every shape (packed ranges, enum/struct/union bodies,
   * arrays) without a second implementation to keep in sync.
   */
  private parseFileScopeTypedef(c: Cursor): void {
    const at = c.pos;
    const sink: ModuleDef = {
      name: '',
      kind: 'module',
      file: this.file,
      range: ZERO_RANGE,
      nameRange: ZERO_RANGE,
      portOrder: [],
      ports: [],
      params: [],
      decls: [],
      funcs: [],
      instances: [],
      assigns: [],
      refs: [],
      includes: [],
      imports: [],
      directives: [],
      defparams: [],
      conditionalRegions: 0,
      usesUnknownConstruct: false,
      timeMs: 0,
      startLine: 0,
    };
    const ctx: ParseContext = { file: this.file, scope: new MapScope(), inProcedural: false };
    if (!this.parseTypedef(c, sink, ctx)) {
      c.pos = at + 1;
      return;
    }
    for (const d of sink.decls) {
      if (d.kind === 'typedef') {
        this.fileTypedefs.push(d);
      }
    }
    this.fileEnumParams.push(...sink.params);
    this.fileTypedefRefs.push(...sink.refs);
  }

  /**
   * Make the file-scope typedefs visible to every module in this file. They come
   * before the module's own text, so they go at the front of the declaration
   * list, and a module that redefines the name keeps its own version.
   *
   * No second classification pass is needed: `classifyRefs` matches a
   * reference against every typedef in the file, not just the module's own.
   */
  private shareFileTypedefs(): void {
    if (this.fileTypedefs.length === 0 && this.fileImports.length === 0 && this.fileEnumParams.length === 0) {
      return;
    }
    if (this.fileImports.length > 0) {
      // File-scope imports are the ones written before any module; an import
      // inside a module body is already on that module.
      for (const m of this.modules) {
        const own = new Set(
          m.imports.flatMap((i) => (i.wildcard ? [] : i.names.map((n) => n.name))),
        );
        const shared = this.fileImports.filter(
          (i) => i.wildcard || !i.names.some((n) => own.has(n.name)),
        );
        if (shared.length > 0) {
          m.imports.unshift(...shared);
        }
      }
    }
    if (this.fileTypedefs.length === 0 && this.fileEnumParams.length === 0) {
      return;
    }
    for (const m of this.modules) {
      const own = new Set(m.decls.map((d) => d.name));
      const shared = this.fileTypedefs.filter((d) => !own.has(d.name));
      if (shared.length > 0) {
        m.decls.unshift(...shared);
      }
      // An enum member is a constant of the enclosing scope, so it has to
      // follow the type out here as well; a module that has its own parameter of
      // that name shadows it, exactly as it shadows the type.
      const ownNames = new Set(m.params.map((p) => p.name));
      const sharedParams = this.fileEnumParams.filter((p) => !ownNames.has(p.name));
      if (sharedParams.length > 0) {
        m.params.unshift(...sharedParams);
        // References were classified before the members were visible. A port or
        // a local of the same name was already settled by that pass, so only the
        // still-unknown ones can be these constants.
        const names = new Set(sharedParams.map((p) => p.name));
        for (const r of m.refs) {
          if (r.kind === 'unknown' && !r.isDecl && names.has(r.name)) {
            r.kind = 'param';
          }
        }
      }
      m.refs.unshift(...this.fileTypedefRefs);
    }
  }

  /**
   * The names of every module-like scope this file declares, collected before
   * anything is parsed. Verilog lets a module be instantiated before it is
   * defined, so `sub u();` in the first module can name a module at the bottom
   * of the file; deciding that while parsing module one is not possible without
   * this pass. It is what separates `sub u;` - an instantiation written without
   * a port list - from `byte_t data;`, a variable of a type.
   */
  private collectScopeNames(): void {
    const toks = this.toks;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.kind !== 'keyword' || !SCOPE_OPENER_KEYWORD[t.text]) {
        continue;
      }
      // `module automatic name`, `package p;`, `class c extends base;`
      let k = i + 1;
      while (k < toks.length && MODIFIERS.has(toks[k].text)) {
        k++;
      }
      if (toks[k]?.kind === 'ident') {
        this.scopeNames.add(toks[k].text);
      }
    }
  }

  private handleDirective(t: Token): void {    const name = t.name ?? '';
    if (name === 'include') {
      const m = /"([^"]*)"|<([^>]*)>/.exec(t.text);
      const p = m ? (m[1] ?? m[2]) : '';
      if (p) {
        this.includes.push(p);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Module
  // -------------------------------------------------------------------------

  private parseModule(c: Cursor): ModuleDef | undefined {
    const openerTok = c.next()!;
    const kind = SCOPE_OPENER_KEYWORD[openerTok.text];

    // Skip modifiers: virtual / automatic / static class qualifiers.
    let nameTok = c.cur();
    while (nameTok && nameTok.kind === 'keyword' && MODIFIERS.has(nameTok.text)) {
      c.pos++;
      nameTok = c.cur();
    }
    if (!nameTok || (nameTok.kind !== 'ident' && nameTok.kind !== 'keyword')) {
      // Not a module after all - bail out by skipping the keyword.
      return undefined;
    }
    c.pos++;
    const name = nameTok.text;
    const moduleRange: Range = { start: openerTok.range.start, end: openerTok.range.end };

    // Header: everything up to the first `;` at bracket depth 0.
    const headerStart = c.pos;
    let headerEnd = headerStart;
    let depth = 0;
    while (!c.done) {
      const t = c.cur()!;
      if (t.text === '(' || t.text === '[') {
        depth++;
      } else if (t.text === ')' || t.text === ']') {
        depth--;
      } else if (t.text === ';' && depth <= 0) {
        break;
      }
      c.pos++;
    }
    headerEnd = c.pos;
    if (c.at(';')) {
      c.pos++;
    }
    const bodyStart = c.pos;

    // Body: up to the matching closer keyword.
    const closer = SCOPE_CLOSER[openerTok.text];
    let bodyEnd = c.end;
    let blockDepth = 0;
    let closed = false;
    for (let k = c.pos; k < c.end; k++) {
      const t = this.toks[k];
      if (t.kind === 'keyword') {
        if (BLOCK_OPENERS.has(t.text)) {
          blockDepth++;
        } else if (BLOCK_CLOSERS.has(t.text)) {
          blockDepth--;
        } else if (t.text === closer && blockDepth <= 0) {
          bodyEnd = k;
          closed = true;
          break;
        } else if (blockDepth <= 0 && SCOPE_OPENER_KEYWORD[t.text] !== undefined) {
          // Missing `end...`: close the module here so the rest of the file -
          // including the next module - is still parsed.
          bodyEnd = k;
          break;
        }
      }
    }
    const endTok = this.toks[bodyEnd] ?? this.toks[this.toks.length - 1];
    moduleRange.end = endTok?.range.end ?? moduleRange.end;
    c.pos = Math.min(bodyEnd + (closed ? 1 : 0), c.end);

    const mod: ModuleDef = {
      name,
      kind,
      file: this.file,
      range: moduleRange,
      nameRange: nameTok.range,
      portOrder: [],
      ports: [],
      params: [],
      decls: [],
      funcs: [],
      instances: [],
      assigns: [],
      refs: [],
      includes: [],
      imports: [],
      directives: [],
      defparams: [],
      conditionalRegions: 0,
      usesUnknownConstruct: false,
      timeMs: 0,
      startLine: openerTok.range.start.line + 1,
    };

    const headerSlices = this.splitHeader(headerStart, headerEnd);
    const scope = new MapScope();
    for (const ps of headerSlices.params) {
      const p = this.parseParamItem(ps.from, ps.to, mod);
      if (p) {
        mod.params.push(p);
        this.collectDefaultRefs(mod, ps.from, ps.to);
        mod.refs.push({
          name: p.name,
          pathSuffix: '',
          fullPath: p.name,
          range: p.nameRange,
          isWrite: false,
          isDecl: true,
          kind: 'param',
        });
        if (p.value?.value !== undefined) {
          scope.set(p.name, p.value.value);
          const w = typeWidth(p.dataType, scope);
          if (w !== undefined) {
            scope.setWidth(p.name, w);
          }
        }
      }
    }
    mod.portOrder = headerSlices.ports.map((s) => this.portNameFromSlice(s));

    // Body first: non-ANSI port directions live here.
    const bodyCtx: ParseContext = { file: this.file, scope, inProcedural: false };
    if (kind === 'package' || kind === 'class') {
      this.parseBody(new Cursor(this.toks, bodyStart, bodyEnd), mod, bodyCtx, true);
    } else {
      this.parseBody(new Cursor(this.toks, bodyStart, bodyEnd), mod, bodyCtx, false);
    }

    // Merge the header port list with the body declarations.
    this.reconcilePorts(mod, headerSlices.ports);

    mod.instances.forEach((inst) => this.classifyInstanceRefs(inst, mod));
    this.declareImplicitNets(mod);
    this.classifyRefs(mod);
    mod.timeMs = 0;
    return mod;
  }

  private splitHeader(from: number, to: number): { params: Slice[]; ports: Slice[] } {
    const params: Slice[] = [];
    let ports: Slice[] = [];
    let i = from;
    while (i < to) {
      const t = this.toks[i];
      if (t.text === '#' && this.toks[i + 1]?.text === '(') {
        const close = matchBracket(this.toks, i + 1, to);
        if (close < 0 || close >= to) {
          break;
        }
        params.push(...splitTopLevel(this.toks, i + 2, close));
        i = close + 1;
        continue;
      }
      if (t.text === '(') {
        const close = matchBracket(this.toks, i, to);
        if (close < 0 || close >= to) {
          break;
        }
        ports = splitTopLevel(this.toks, i + 1, close);
        break;
      }
      i++;
    }
    return { params, ports };
  }

  /** For a non-ANSI header, the port name is the last ident in the slice. */
  private portNameFromSlice(s: Slice): string {
    const toks = this.toks;
    for (let k = s.to - 1; k >= s.from; k--) {
      const t = toks[k];
      if (t.kind === 'ident') {
        // `.ext(internal)` -> the header name is `ext`.
        if (k > s.from && toks[k - 1]?.text === '(') {
          continue;
        }
        if (k + 1 < s.to && toks[k + 1]?.text === '(') {
          continue;
        }
        return t.text;
      }
    }
    return '';
  }

  /**
   * Build the port list. ANSI ports are parsed from the header; non-ANSI ports
   * are merged with the direction/type found in the body.
   */
  private reconcilePorts(mod: ModuleDef, portSlices: Slice[]): void {
    // `mod.ports` currently holds the ports discovered in the body (non-ANSI
    // style). The header list is authoritative for order and for names.
    const bodyPorts = mod.ports;
    mod.ports = [];

    const ansiSlices = portSlices.filter((s) => this.isAnsiSlice(s));
    for (const s of portSlices) {
      const isAnsi = ansiSlices.includes(s);
      const headerName = this.portNameFromSlice(s);
      const bodyPort = bodyPorts.find((p) => p.name === headerName || p.declName === headerName);
      if (isAnsi) {
        this.pendingTypeRefs = [];
        const p = this.parseAnsiPort(s.from, s.to);
        if (p) {
          mod.ports.push(p);
          // `[cfg::UNROLL-1:0]` in an ANSI port type uses parameters like any
          // other expression, so those names are references too.
          mod.refs.push(...this.pendingTypeRefs);
          // The body already records a declaration for a non-ANSI port.
          if (!bodyPort) {
            mod.refs.push({
              name: p.name,
              pathSuffix: '',
              fullPath: p.name,
              range: p.nameRange,
              isWrite: p.direction === 'output' || p.direction === 'inout' || p.direction === 'ref',
              isDecl: true,
              kind: 'signal',
            });
          }
          continue;
        }
      }
      if (bodyPort) {
        mod.ports.push({ ...bodyPort, name: headerName || bodyPort.name, ansi: false });
        continue;
      }
      if (headerName) {
        mod.ports.push(this.makePlaceholderPort(headerName, s));
      }
    }

    // Keep the header order authoritative.
    const byName = new Map<string, PortDecl>();
    for (const p of mod.ports) {
      byName.set(p.name, p);
    }
    const ordered: PortDecl[] = [];
    for (const name of mod.portOrder) {
      const p = byName.get(name);
      if (p) {
        ordered.push(p);
        byName.delete(name);
      }
    }
    // Append body declarations that the header did not mention.
    for (const p of bodyPorts) {
      if (byName.has(p.name)) {
        byName.delete(p.name);
        ordered.push(p);
      }
    }
    mod.ports = ordered;
  }

  private makePlaceholderPort(headerName: string, s: Slice): PortDecl {
    const toks = this.toks;
    let nameRange: Range = rangeOf(toks, s.from, s.to);
    for (let k = s.from; k < s.to; k++) {
      if (toks[k].text === headerName) {
        nameRange = toks[k].range;
        break;
      }
    }
    return {
      name: headerName,
      declName: headerName,
      direction: 'input',
      dataType: { t: 'unknown' },
      range: rangeOf(toks, s.from, s.to),
      nameRange,
      ansi: false,
      guessDir: true,
    };
  }

  private isAnsiSlice(s: Slice): boolean {
    for (let k = s.from; k < s.to; k++) {
      const t = this.toks[k];
      if (t.kind === 'keyword' && (DIR_KEYWORDS.has(t.text) || t.text === 'interface' || t.text === 'enum' || t.text === 'struct' || t.text === 'virtual' || t.text === 'genvar' || t.text === 'typedef')) {
        return true;
      }
      // `bus_if.slave bus` / `some_if.smp bus`: a dotted interface type reference.
      if (t.kind === 'ident' && this.toks[k + 1]?.text === '.' &&
          this.toks[k + 2]?.kind === 'ident' && k + 3 < s.to) {
        return true;
      }
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Body
  // -------------------------------------------------------------------------

  private parseBody(c: Cursor, mod: ModuleDef, ctx: ParseContext, isPackage: boolean): void {
    while (!c.done) {
      const startPos = c.pos;
      const t = c.cur()!;

      if (t.kind === 'attribute' || t.kind === 'directive' || t.kind === 'string') {
        if (t.kind === 'directive') {
          this.handleDirective(t);
          mod.directives.push({ name: t.name ?? '', range: t.range });
          if (t.name === 'ifdef' || t.name === 'ifndef') {
            mod.conditionalRegions++;
          }
        }
        c.pos++;
        continue;
      }

      if (t.text === ';' || t.text === ',') {
        c.pos++;
        continue;
      }

      const handled = this.parseBodyItem(c, mod, ctx, isPackage);
      if (!handled || c.pos === startPos) {
        c.pos++;
      }
    }
  }

  private parseBodyItem(c: Cursor, mod: ModuleDef, ctx: ParseContext, isPackage: boolean): boolean {
    const t = c.cur()!;

    // --- nested block constructs: recurse into them ---
    if (t.kind === 'keyword' && (BLOCK_OPENERS.has(t.text) || GENERATE_KEYWORDS.has(t.text))) {
      return this.parseBlock(c, mod, ctx, isPackage);
    }

    if (t.kind === 'keyword') {
      switch (t.text) {
        case 'assign':
          return this.parseAssign(c, mod, ctx, false);
        case 'defparam':
          return this.parseDefparam(c, mod, ctx);
        case 'typedef':
          return this.parseTypedef(c, mod, ctx);
        case 'parameter':
        case 'localparam':
          return this.parseParamStatement(c, mod, ctx);
        case 'specparam':
          return this.parseParamStatement(c, mod, ctx);
        case 'import':
          return this.parseImport(c, mod.imports);
        case 'export':
          return this.skipStatement(c);
        case 'bind':
          return this.parseBind(c, mod, ctx);
        case 'alias':
          return this.skipStatement(c);
        case 'always':
        case 'always_comb':
        case 'always_ff':
        case 'always_latch':
        case 'initial':
        case 'final':
          return this.parseProcedural(c, mod, ctx);
        case 'input':
        case 'output':
        case 'inout':
        case 'ref':
          return this.parsePortDeclaration(c, mod, ctx);
        case 'wire':
        case 'tri':
        case 'tri0':
        case 'tri1':
        case 'triand':
        case 'trior':
        case 'trireg':
        case 'wand':
        case 'wor':
        case 'supply0':
        case 'supply1':
        case 'uwire':
        case 'interconnect':
        case 'net':
          return this.parseVarDeclaration(c, mod, ctx, 'net');
        case 'reg':
        case 'logic':
        case 'bit':
        case 'byte':
        case 'int':
        case 'integer':
        case 'longint':
        case 'shortint':
        case 'time':
        case 'real':
        case 'realtime':
        case 'shortreal':
        case 'string':
        case 'event':
        case 'chandle':
        case 'var':
          return this.parseVarDeclaration(c, mod, ctx, this.varKindOf(t.text));
        case 'genvar':
          return this.parseVarDeclaration(c, mod, ctx, 'genvar');
        case 'end':
        case 'endcase':
        case 'endgenerate':
        case 'endfunction':
        case 'endtask':
        case 'endspecify':
        case 'endtable':
        case 'endmodule':
        case 'endinterface':
        case 'endprogram':
        case 'endpackage':
        case 'endclass':
          c.pos++;
          return true;
        default:
          break;
      }
      // Unknown keyword-led statement.
      return this.skipStatement(c);
    }

    // --- identifier-led statement: instantiation, genvar loop var, or junk ---
    if (t.kind === 'ident' || t.kind === 'macroRef') {
      if (this.looksLikeInstantiation(c)) {
        return this.parseInstantiation(c, mod, ctx);
      }
      // `my_type_t data;` - a variable of a type declared by a typedef. This is
      // the usual way to write one, and without it the variable is invisible:
      // it gets no definition, no references and no semantic token. The type
      // name may be qualified: `pkg::my_type_t data;`.
      //
      // The type does not have to be visible in this file either. A design keeps
      // its shared types in a header, so `byte_t data;` in another file is a
      // declaration even though nothing here declares `byte_t`. Dropping it
      // leaves the variable undeclared, which the Problems view then reports -
      // a warning on correct code, on every variable of a shared type.
      if (t.kind === 'ident' && this.looksLikeDeclOf(this.toks, c) &&
          (this.isTypedefName(mod, qualifiedNameAt(this.toks, c.pos, c.end).text) ||
            !this.scopeNames.has(t.text))) {
        // The real cursor, not a slice of it: `parseVarDeclaration` ends the
        // statement by moving the cursor past the `;`, and on a slice that
        // advance was thrown away. The declared name was then read again as a
        // statement of its own, which set `usesUnknownConstruct` and made the
        // module look like it held something the parser did not understand.
        return this.parseVarDeclaration(c, mod, ctx, 'reg', true);
      }
      // `genvar i;` handled above; an unknown ident-led statement.
      mod.usesUnknownConstruct = true;
      return this.skipStatement(c);
    }

    return this.skipStatement(c);
  }

  private varKindOf(kw: string): VarKind {
    if (kw === 'reg' || kw === 'logic' || kw === 'bit') {
      return 'reg';
    }
    if (kw === 'event') {
      return 'event';
    }
    return 'integer';
  }

  /**
   * `begin`, `generate`, `if`/`for`/`case` at module level, `function`, `task`,
   * `always`, `specify` ... Each is handled according to what it can contain.
   */
  private parseBlock(c: Cursor, mod: ModuleDef, ctx: ParseContext, isPackage: boolean): boolean {
    const toks = this.toks;
    const t = c.cur()!;

    if (t.kind === 'keyword' && t.text === 'generate') {
      const close = matchBlock(toks, c.pos, c.end);
      this.parseBody(c.slice(c.pos + 1, close), mod, { ...ctx, generate: ctx.generate ?? 'generate' }, isPackage);
      c.pos = Math.min(close + 1, c.end);
      return true;
    }

    if (t.kind === 'keyword' && (t.text === 'function' || t.text === 'task')) {
      return this.parseFunction(c, mod, ctx, isPackage);
    }

    if (t.kind === 'keyword' && PROCEDURAL_KEYWORDS.has(t.text)) {
      return this.parseProcedural(c, mod, ctx);
    }

    if (t.kind === 'keyword' && (t.text === 'specify' || t.text === 'table' ||
        t.text === 'property' || t.text === 'sequence' || t.text === 'covergroup' ||
        t.text === 'clocking' || t.text === 'checker' || t.text === 'constraint')) {
      const close = matchBlock(toks, c.pos, c.end);
      c.pos = Math.min(close + 1, c.end);
      return true;
    }

    if (t.kind === 'keyword' && (t.text === 'cover' || t.text === 'randcase' ||
        t.text === 'randsequence' || t.text === 'let')) {
      c.pos = Math.min(matchBlock(toks, c.pos, c.end) + 1, c.end);
      return true;
    }

    if (t.kind === 'keyword' && (t.text === 'if' || t.text === 'for' || t.text === 'case' ||
        t.text === 'casex' || t.text === 'casez' || t.text === 'begin' || t.text === 'fork')) {
      // Module-level generate constructs (SV allows a bare if/for at module level).
      if (t.text === 'for') {
        return this.parseGenerateFor(c, mod, ctx, isPackage);
      }
      const close = matchBlock(toks, c.pos, c.end);
      const isCase = t.text === 'case' || t.text === 'casex' || t.text === 'casez';
      const branchCtx: ParseContext = {
        ...ctx,
        conditional: ctx.conditional ?? (t.text === 'if' || isCase),
      };
      this.parseGenerateBody(c.slice(c.pos + 1, close), mod, branchCtx, isPackage);
      let pos = Math.min(close + 1, c.end);
      // An `else` is part of the same construct. `matchBlock` stops at the `end`
      // of the first branch, so reading only that left every else branch of a
      // generate if/else - the standard way to write a width-dependent variant
      // - completely unparsed.
      while (toks[pos]?.kind === 'keyword' && toks[pos].text === 'else') {
        const next = pos + 1;
        const head = toks[next];
        const startsBlock = head?.kind === 'keyword' &&
          (BLOCK_OPENERS.has(head.text) || GENERATE_KEYWORDS.has(head.text));
        const branchEnd = startsBlock
          ? matchBlock(toks, next, c.end)
          : this.statementEnd(c.slice(next, c.end));
        if (branchEnd <= next) {
          break;
        }
        this.parseGenerateBody(c.slice(next, branchEnd), mod, branchCtx, isPackage);
        pos = Math.min(branchEnd + 1, c.end);
      }
      c.pos = pos;
      return true;
    }

    const close = matchBlock(toks, c.pos, c.end);
    c.pos = Math.min(close + 1, c.end);
    return true;
  }

  /**
   * Inside a generate region: `for` loops and if/case branches may contain
   * instantiations, so we scan for `begin`/`end` pairs and declarations.
   */
  /**
   * `for (gi = 0; gi < N; gi = gi + 1) begin : label ... end`
   *
   * When the bounds fold to constants the loop is unrolled, and every instance
   * inside gets a `genPrefix` of `label[i]`, which is what the real hierarchical
   * path looks like. Otherwise the body is parsed once, unexpanded.
   */
  private parseGenerateFor(c: Cursor, mod: ModuleDef, ctx: ParseContext, isPackage: boolean): boolean {
    const toks = this.toks;
    const close = matchBlock(toks, c.pos, c.end);
    let bodyEnd = close > c.pos ? close : c.end;

    // Locate the loop body: `begin ... end` (or a single statement) and its label.
    let bodyStart = c.pos + 1;
    let label: string | undefined;
    if (toks[c.pos + 1]?.text === '(') {
      const parenClose = matchBracket(toks, c.pos + 1, bodyEnd);
      if (parenClose > 0) {
        bodyStart = parenClose + 1;
        // `begin : label`
        if (toks[bodyStart]?.text === 'begin' && toks[bodyStart + 1]?.text === ':' &&
            toks[bodyStart + 2] !== undefined) {
          label = toks[bodyStart + 2].text;
        }
        const innerClose = matchBlock(toks, bodyStart, bodyEnd);
        if (innerClose > bodyStart) {
          bodyEnd = innerClose;
        }
      }
    }

    const loop = this.readForLoop(toks, c.pos + 1, bodyStart, ctx);
    const iterations: number[] = [];
    if (loop) {
      const count = Math.max(0, Math.min(loop.count, MAX_GENERATE_UNROLL));
      for (let i = 0; i < count; i++) {
        iterations.push(loop.from + i * loop.step);
      }
    }

    if (iterations.length === 0) {
      // Unresolvable bounds: parse the body once, unexpanded.
      this.parseGenerateBody(c.slice(bodyStart, bodyEnd), mod, ctx, isPackage);
      c.pos = Math.min(close + 1, c.end);
      return true;
    }

    for (const value of iterations) {
      const iterCtx: ParseContext = {
        ...ctx,
        generate: label ? `${label}[${value}]` : `${ctx.generate ?? 'gen'}[${value}]`,
        scope: ctx.scope.clone(),
        genPrefix: label ? `${label}[${value}]` : `[${value}]`,
      };
      iterCtx.scope.set(loop!.varName, value);
      const before = mod.instances.length;
      this.parseGenerateBody(c.slice(bodyStart, bodyEnd), mod, iterCtx, isPackage);
      for (let k = before; k < mod.instances.length; k++) {
        mod.instances[k].genPrefix = iterCtx.genPrefix;
        mod.instances[k].inGenerate = true;
      }
    }
    c.pos = Math.min(close + 1, c.end);
    return true;
  }

  /**
   * Recover `for (i = A; i < B; i = i + C)` as a constant iteration count.
   * Returns null when any part does not fold.
   */
  private readForLoop(
    toks: Token[],
    parenOpen: number,
    limit: number,
    ctx: ParseContext,
  ): { varName: string; from: number; step: number; count: number } | null {
    if (toks[parenOpen]?.text !== '(') {
      return null;
    }
    const close = matchBracket(toks, parenOpen, limit);
    if (close < 0) {
      return null;
    }
    const parts = this.splitSemicolons(toks, parenOpen + 1, close);
    if (parts.length < 3) {
      return null;
    }
    const init = parts[0];
    const cond = parts[1];
    const step = parts[2];

    const varName = toks[init.from]?.text;
    if (!varName || toks[init.from]?.kind !== 'ident' || toks[init.from + 1]?.text !== '=') {
      return null;
    }
    const scope = ctx.scope.clone();
    // A genvar may already be initialised elsewhere; the loop's own init wins.
    const fromExpr = toks[init.from + 1]?.text === '='
      ? this.evalSimple(toks.slice(init.from + 2, init.to), scope)
      : this.parseInitExpr(toks, init, scope);
    if (fromExpr === undefined) {
      return null;
    }

    const condTok = toks[cond.from];
    const cmp = toks[cond.from + 1]?.text;
    const boundToks = toks.slice(cond.from + 2, cond.to);
    if (!cmp || (cmp !== '<' && cmp !== '<=')) {
      return null;
    }
    let bound: number | undefined;
    if (boundToks.length === 1 && boundToks[0].kind === 'ident') {
      bound = scope.get(boundToks[0].text);
    } else {
      bound = this.evalSimple(boundToks, scope);
    }
    if (bound === undefined) {
      return null;
    }
    if (condTok.text !== varName) {
      return null;
    }

    let stepSize = 1;
    if (toks[step.from]?.text === varName && toks[step.from + 1]?.text === '=') {
      const rhs = toks.slice(step.from + 2, step.to);
      if (rhs.length === 2 && rhs[0].text === varName && rhs[1].text === '+') {
        stepSize = 1;
      } else if (rhs.length === 2 && rhs[0].text === varName && rhs[1].text === '-') {
        stepSize = -1;
      } else if (rhs.length === 3 && rhs[0].text === varName && rhs[1].text === '+' && rhs[2].text === '1') {
        stepSize = 1;
      } else {
        const v = this.evalSimple(rhs, scope);
        if (v !== undefined && v !== 0) {
          stepSize = v;
        }
      }
    }
    if (stepSize === 0) {
      return null;
    }

    const count = stepSize > 0
      ? (cmp === '<' ? bound - fromExpr : bound - fromExpr + 1)
      : (cmp === '<' ? fromExpr - bound - 1 : fromExpr - bound);
    return { varName, from: fromExpr, step: stepSize, count: Math.max(0, count) };
  }

  private parseInitExpr(toks: Token[], s: Slice, scope: MapScope): number | undefined {
    if (s.to - s.from === 1) {
      return scope.get(toks[s.from].text);
    }
    return this.evalSimple(toks.slice(s.from, s.to), scope);
  }

  private evalSimple(toks: Token[], scope: MapScope): number | undefined {
    if (toks.length === 0) {
      return undefined;
    }
    return evalTokenExpr(toks, scope);
  }

  private splitSemicolons(toks: Token[], from: number, to: number): Slice[] {
    const out: Slice[] = [];
    let depth = 0;
    let start = from;
    for (let k = from; k < to; k++) {
      const t = toks[k];
      if (t.text === '(' || t.text === '[' || t.text === '{') {
        depth++;
      } else if (t.text === ')' || t.text === ']' || t.text === '}') {
        depth--;
      } else if (t.text === ';' && depth === 0) {
        out.push({ from: start, to: k });
        start = k + 1;
      }
    }
    if (to > start) {
      out.push({ from: start, to });
    }
    return out;
  }

  private parseGenerateBody(c: Cursor, mod: ModuleDef, ctx: ParseContext, isPackage: boolean): void {
    while (!c.done) {
      const t = c.cur()!;
      if (t.kind === 'keyword' && (BLOCK_OPENERS.has(t.text) || GENERATE_KEYWORDS.has(t.text))) {
        this.parseBlock(c, mod, ctx, isPackage);
        continue;
      }
      if (t.kind === 'keyword' && DIR_KEYWORDS.has(t.text)) {
        this.parsePortDeclaration(c, mod, ctx);
        continue;
      }
      if (t.kind === 'keyword' && (t.text === 'assign' || t.text === 'defparam' ||
          t.text === 'bind' || PROCEDURAL_KEYWORDS.has(t.text))) {
        // A generate block holds the same statements a module body does. This
        // loop used to know about declarations, parameters, types and
        // instantiations only, so an `assign` or an `always` inside one was
        // skipped a token at a time: the net said a signal had no driver, the
        // graph missed the connection, and a flattened copy lost the wiring.
        this.parseBodyItem(c, mod, ctx, isPackage);
        continue;
      }
      if (t.kind === 'keyword' && (t.text === 'wire' || t.text === 'logic' || t.text === 'reg' ||
          t.text === 'integer' || t.text === 'bit' || t.text === 'var' || t.text === 'localparam' ||
          t.text === 'parameter' || t.text === 'typedef' || t.text === 'genvar' || t.text === 'int')) {
        this.parseBodyItem(c, mod, ctx, isPackage);
        continue;
      }
      if (t.kind === 'ident' && this.looksLikeInstantiation(c)) {
        this.parseInstantiation(c, mod, ctx);
        continue;
      }
      if (t.text === ';') {
        c.pos++;
        continue;
      }
      c.pos++;
    }
  }

  // -------------------------------------------------------------------------
  // Declarations
  // -------------------------------------------------------------------------

  private parseVarDeclaration(
    c: Cursor,
    mod: ModuleDef,
    ctx: ParseContext,
    kind: VarKind,
    userType = false,
  ): boolean {
    const toks = this.toks;
    const start = c.pos;
    let end = this.statementEnd(c);
    const items = splitTopLevel(toks, start, end);
    if (items.length === 0) {
      c.pos = end;
      return true;
    }
    for (const it of items) {
      // The type keyword lives in the first item; later items reuse it. A
      // typedef name is a type too, and it is not in the keyword table.
      const typeFrom =
        kind === 'net' || userType || isTypeStart(toks, it.from) ? it.from : items[0].from;
      const parsed = this.parseTypeAndName(typeFrom, it.to, ctx, true);
      if (!parsed || !parsed.name) {
        mod.usesUnknownConstruct = true;
        continue;
      }
      mod.refs.push(...parsed.typeRefs);
      const v: VarDecl = {
        name: parsed.name,
        dataType: parsed.dataType,
        kind,
        range: rangeOf(toks, typeFrom, it.to),
        nameRange: parsed.nameRange!,
        generate: ctx.generate,
      };
      if (parsed.dims.length) {
        v.dims = parsed.dims;
      }
      if (parsed.init) {
        v.init = parsed.init;
        if (parsed.init.value !== undefined) {
          ctx.scope.set(parsed.name, parsed.init.value);
        }
      }
      mod.decls.push(v);
      mod.refs.push({
        name: v.name,
        pathSuffix: '',
        fullPath: v.name,
        range: v.nameRange,
        isWrite: false,
        isDecl: true,
        kind: 'signal',
      });
    }
    c.pos = end;
    return true;
  }

  /**
   * Type references of the port most recently returned by `parsePortDecl`; the
   * port is built by a helper that does not see the module, so they are handed
   * over and drained by the caller.
   */
  private pendingTypeRefs: RefSite[] = [];

  private parsePortDeclaration(c: Cursor, mod: ModuleDef, ctx: ParseContext): boolean {
    const toks = this.toks;
    const start = c.pos;
    const end = this.statementEnd(c);
    const items = splitTopLevel(toks, start, end);
    for (const it of items) {
      this.pendingTypeRefs = [];
      const p = this.parseAnsiPort(it.from, it.to, ctx);
      if (!p) {
        mod.usesUnknownConstruct = true;
        continue;
      }
      // `[W-1:0]` in the port type uses a parameter like any other expression.
      mod.refs.push(...this.pendingTypeRefs);
      p.generate = ctx.generate;
      const existing = mod.ports.findIndex((x) => x.name === p.name);
      if (existing >= 0) {
        mod.ports[existing] = p;
      } else {
        mod.ports.push(p);
      }
      mod.refs.push({
        name: p.name,
        pathSuffix: '',
        fullPath: p.name,
        range: p.nameRange,
        isWrite: p.direction === 'output' || p.direction === 'inout' || p.direction === 'ref',
        isDecl: true,
        kind: 'signal',
      });
    }
    c.pos = end;
    return true;
  }

  /** Parse a single port item: `input wire [7:0] a` / `output reg b` / `input logic a, b`. */
  private parseAnsiPort(from: number, to: number, ctx?: ParseContext): PortDecl | undefined {
    const toks = this.toks;
    let i = from;
    let direction: PortDir = 'input';
    let interfaceName: string | undefined;
    let modport: string | undefined;

    // The direction comes first: `ref` is both a direction and a modifier, and
    // checking the modifiers first would swallow it and turn `ref logic x` into
    // an input.
    if (i < to && toks[i].kind === 'keyword' && DIR_KEYWORDS.has(toks[i].text)) {
      direction = toks[i].text as PortDir;
      i++;
    }
    while (i < to && toks[i].kind === 'keyword' && MODIFIERS.has(toks[i].text)) {
      i++;
    }
    // `input interface X bus` / `input .modport(a,b) bus`
    if (i < to && toks[i].text === 'interface' && toks[i].kind === 'keyword') {
      i++;
      if (i < to && toks[i].text === '.') {
        i++;
        if (i < to && toks[i].kind === 'ident') {
          modport = toks[i].text;
          i++;
          const close = matchBracket(toks, i, to);
          if (close > 0) {
            i = close + 1;
          }
        }
      } else if (i < to && toks[i].kind === 'ident') {
        interfaceName = toks[i].text;
        i++;
        if (i < to && toks[i].text === '.') {
          i++;
          if (i < to && toks[i].kind === 'ident') {
            modport = toks[i].text;
            i++;
          }
        }
      }
      // Skip the bus signal name; it is still recorded as the port name.
      const nameIdx = this.findPortNameIndex(i, to, interfaceName);
      if (nameIdx < 0) {
        return undefined;
      }
      const nameTok = toks[nameIdx];
      return {
        name: nameTok.text,
        declName: nameTok.text,
        direction,
        dataType: { t: 'interface', name: interfaceName ?? nameTok.text, modport },
        isInterface: true,
        interfaceName,
        modport,
        range: rangeOf(toks, from, to),
        nameRange: nameTok.range,
        ansi: true,
      };
    }

    // `.ext(internal)` explicit port name mapping.
    let explicitPortName: string | undefined;
    if (i < to && toks[i].text === '.') {
      i++;
      if (i < to && toks[i].kind === 'ident') {
        explicitPortName = toks[i].text;
        i++;
      }
      const close = matchBracket(toks, i, to);
      if (close > 0) {
        i = close + 1;
      }
    }

    // `bus_if.slave bus` / `my_if bus` - an interface port with an optional
    // modport. Non-ANSI interface ports have no direction keyword; they are
    // inherently bidirectional, so they become `inout`.
    if (i < to && toks[i].kind === 'ident' && i + 1 < to && toks[i + 1].text === '.' &&
        toks[i + 2]?.kind === 'ident') {
      const ifaceName = toks[i].text;
      const modportName = toks[i + 2].text;
      const nameAt = i + 3;
      if (nameAt < to && toks[nameAt]?.kind === 'ident') {
        const nameTok = toks[nameAt];
        return {
          name: nameTok.text,
          declName: nameTok.text,
          direction,
          dataType: { t: 'interface', name: ifaceName, modport: modportName },
          isInterface: true,
          interfaceName: ifaceName,
          modport: modportName,
          range: rangeOf(toks, from, to),
          nameRange: nameTok.range,
          ansi: true,
        };
      }
    }

    const parsed = this.parseTypeAndName(i, to, ctx ?? { file: this.file, scope: new MapScope(), inProcedural: false });
    if (!parsed) {
      return undefined;
    }
    if (!parsed.name) {
      return undefined;
    }
    this.pendingTypeRefs = parsed.typeRefs;
    const nameTok = parsed.nameTok!;
    const p: PortDecl = {
      name: explicitPortName ?? parsed.name,
      declName: parsed.name,
      direction,
      dataType: parsed.dataType,
      range: rangeOf(toks, from, to),
      nameRange: nameTok.range,
      ansi: true,
    };
    if (parsed.dims.length) {
      p.unpacked = parsed.dims;
    }
    if (parsed.init) {
      p.defaultValue = parsed.init;
    }
    if (explicitPortName) {
      p.name = explicitPortName;
    }
    if (parsed.dataType.t === 'interface') {
      p.isInterface = true;
    }
    return p;
  }

  /** Find the port's signal name: last ident before `=`, `[`, or `,`. */
  private findPortNameIndex(from: number, to: number, skip?: string): number {
    const toks = this.toks;
    for (let k = to - 1; k >= from; k--) {
      if (toks[k].text === ']' && matchBracket(toks, k, to) > k) {
        // Skip a trailing packed/unpacked range.
        const open = this.findMatchingOpen(toks, k, from);
        if (open >= 0) {
          k = open - 1;
          continue;
        }
      }
      if (toks[k].kind === 'ident' && toks[k].text !== skip) {
        return k;
      }
    }
    return -1;
  }

  /** Index of the bracket-opening token that pairs with the closer at `closeIdx`. */
  private findMatchingOpen(toks: Token[], closeIdx: number, limit: number): number {
    const close = toks[closeIdx]?.text;
    const open = close === ')' ? '(' : close === ']' ? '[' : close === '}' ? '{' : undefined;
    if (!open) {
      return -1;
    }
    let depth = 0;
    for (let k = closeIdx; k >= limit; k--) {
      if (toks[k].text === close) {
        depth++;
      } else if (toks[k].text === open) {
        depth--;
        if (depth === 0) {
          return k;
        }
      }
    }
    return -1;
  }

  /**
   * Parse a declaration prefix: net/var type keywords, signedness, packed
   * ranges, and the declared name.
   */
  /**
   * Names that appear inside a type - packed ranges (`[W-1:0]`), enum bases,
   * user type names. They are ordinary uses of those parameters, so renaming a
   * parameter has to rewrite them as well.
   */
  private typeRefs(from: number, to: number, nameRange: Range | undefined): RefSite[] {
    if (!nameRange) {
      return [];
    }
    let end = to;
    for (let k = from; k < to; k++) {
      const t = this.toks[k];
      const after =
        t.range.start.line > nameRange.start.line ||
        (t.range.start.line === nameRange.start.line &&
          t.range.start.character >= nameRange.start.character);
      if (after) {
        end = k;
        break;
      }
    }
    return end > from ? this.collectRefs(this.toks.slice(from, end), false) : [];
  }

  private parseTypeAndName(from: number, to: number, ctx: ParseContext, allowInit = false): {
    dataType: DataType;
    name?: string;
    nameTok?: Token;
    nameRange?: Range;
    dims: ValueRange[];
    init?: ConstExpr;
    typeRefs: RefSite[];
  } | undefined {
    const parsed = this.parseTypeAndNameInner(from, to, ctx, allowInit);
    if (!parsed) {
      return undefined;
    }
    return { ...parsed, typeRefs: this.typeRefs(from, to, parsed.nameRange) };
  }

  private parseTypeAndNameInner(from: number, to: number, ctx: ParseContext, allowInit = false): {
    dataType: DataType;
    name?: string;
    nameTok?: Token;
    nameRange?: Range;
    dims: ValueRange[];
    init?: ConstExpr;
  } | undefined {
    const toks = this.toks;
    let i = from;
    let signed: boolean | undefined;
    let packedRange: ValueRange | undefined;
    let base: DataType = { t: 'unknown' };
    const dims: ValueRange[] = [];
    let userTypeName: string | undefined;
    let isTypeParam = false;

    if (i < to && toks[i].text === 'type' && toks[i].kind === 'keyword') {
      isTypeParam = true;
      i++;
    }

    // Leading modifiers.
    while (i < to && toks[i].kind === 'keyword' && MODIFIERS.has(toks[i].text)) {
      if (toks[i].text === 'signed') {
        signed = true;
      }
      if (toks[i].text === 'unsigned') {
        signed = false;
      }
      i++;
    }

    // A declaration may open with just a packed range - `input [7:0] a`,
    // `[WIDTH-1:0] q;` - in which case the type is implicit (net by default).
    if (i < to && toks[i].text === '[') {
      const close = matchBracket(toks, i, to);
      if (close > 0) {
        const r = this.parseValueRange(i + 1, close, ctx);
        if (r) {
          packedRange = r;
        }
        i = close + 1;
        base = { t: 'nets', signed, range: packedRange };
      }
    }

    // User-defined type: `enum`, `struct`, `union`, `interface`, or a bare capitalised ident.
    if (i < to && toks[i].kind === 'keyword' && (toks[i].text === 'enum' || toks[i].text === 'struct' || toks[i].text === 'union')) {
      const kw = toks[i].text;
      i++;
      if (i < to && toks[i].text === '[') {
        const close = matchBracket(toks, i, to);
        if (close > 0) {
          const r = this.parseValueRange(i + 1, close, ctx);
          if (r) {
            packedRange = r;
          }
          i = close + 1;
        }
      }
      if (i < to && toks[i].text === '{') {
        const close = matchBracket(toks, i, to);
        i = close > 0 ? close + 1 : to;
      }
      if (i < to && toks[i].kind === 'ident') {
        userTypeName = toks[i].text;
        i++;
      }
      base = { t: 'user', name: userTypeName ?? kw };
      if (signed !== undefined) {
        base = { t: 'user', name: userTypeName ?? kw, range: packedRange };
      }
      // Ignore signed for user types but keep the range.
      if (packedRange) {
        base = { ...base, range: packedRange } as DataType;
      }
    } else if (i < to && toks[i].kind === 'keyword' && SCALAR_KEYWORDS.has(toks[i].text)) {
      const kw = toks[i].text;
      i++;
      if (i < to && toks[i].text === '[') {
        const close = matchBracket(toks, i, to);
        if (close > 0) {
          const r = this.parseValueRange(i + 1, close, ctx);
          if (r) {
            packedRange = r;
          }
          i = close + 1;
        }
      }
      base = { t: 'scalar', kind: kw as 'integer', signed, range: packedRange };
    } else if (i < to && toks[i].kind === 'keyword' && (toks[i].text === 'reg' || toks[i].text === 'logic' || toks[i].text === 'bit')) {
      const kw = toks[i].text;
      i++;
      if (i < to && toks[i].text === '[') {
        const close = matchBracket(toks, i, to);
        if (close > 0) {
          const r = this.parseValueRange(i + 1, close, ctx);
          if (r) {
            packedRange = r;
          }
          i = close + 1;
        }
      }
      base = { t: 'logic', signed, range: packedRange };
      void kw;
    } else if (i < to && toks[i].kind === 'keyword' && NET_KEYWORDS.has(toks[i].text)) {
      i++;
      if (i < to && toks[i].text === '[') {
        const close = matchBracket(toks, i, to);
        if (close > 0) {
          const r = this.parseValueRange(i + 1, close, ctx);
          if (r) {
            packedRange = r;
          }
          i = close + 1;
        }
      }
      base = { t: 'nets', signed, range: packedRange };
    } else if (i < to && toks[i].kind === 'ident' && !userTypeName) {
      // A bare identifier is only a user type when another identifier follows it
      // (`state_e phase;`, `T a`). In `WIDTH = 8` the ident *is* the declared
      // name, so require a following ident (optionally across a packed range).
      // A package qualifier is part of the type name: `pkg::state_e phase;`.
      const qualified = qualifiedNameAt(toks, i, to);
      let probe = i + qualified.tokens;
      if (toks[probe]?.text === '[') {
        const close = matchBracket(toks, probe, to);
        probe = close > 0 ? close + 1 : -1;
      }
      if (probe > 0 && probe < to && (toks[probe].kind === 'ident' ||
          (toks[probe].kind === 'keyword' && !SCALAR_KEYWORDS.has(toks[probe].text) &&
            !NET_KEYWORDS.has(toks[probe].text) && !DIR_KEYWORDS.has(toks[probe].text)))) {
        userTypeName = qualified.text;
        i += qualified.tokens;
        if (i < to && toks[i].text === '[') {
          const close = matchBracket(toks, i, to);
          if (close > 0) {
            const r = this.parseValueRange(i + 1, close, ctx);
            if (r) {
              packedRange = r;
            }
            i = close + 1;
          }
        }
        base = { t: 'user', name: userTypeName, range: packedRange };
      }
    }

    // Unpacked dimensions follow the name.
    let name = '';
    let nameTok: Token | undefined;
    for (; i < to; i++) {
      const t = toks[i];
      if (t.text === '[') {
        const close = matchBracket(toks, i, to);
        if (close < 0) {
          break;
        }
        const r = this.parseValueRange(i + 1, close, ctx);
        if (r) {
          dims.push(r);
        }
        i = close;
        continue;
      }
      if (t.text === '=') {
        break;
      }
      if (t.kind === 'ident' || (t.kind === 'keyword' && !SCALAR_KEYWORDS.has(t.text) && !NET_KEYWORDS.has(t.text) && !DIR_KEYWORDS.has(t.text))) {
        name = t.text;
        nameTok = t;
      }
    }

    let init: ConstExpr | undefined;
    if (allowInit && nameTok) {
      const eq = toks.indexOf === undefined ? -1 : this.findTopLevel(from, to, '=');
      if (eq >= 0) {
        init = exprFromTokens(toks.slice(eq + 1, to), ctx.scope);
      }
    }

    if (!nameTok) {
      return { dataType: base, dims, init };
    }
    void isTypeParam;
    return {
      dataType: base,
      name,
      nameTok,
      nameRange: nameTok.range,
      dims,
      init,
    };
  }

  private findTopLevel(from: number, to: number, text: string): number {
    const toks = this.toks;
    let depth = 0;
    for (let k = from; k < to; k++) {
      const t = toks[k];
      // The target is tested before the bracket bookkeeping so that searching
      // for an opening bracket finds it at depth 0 (`.P(V)` parameter
      // overrides) instead of being swallowed by the depth counter.
      if (t.text === text && depth === 0) {
        return k;
      }
      if (t.text === '(' || t.text === '[' || t.text === '{') {
        depth++;
      } else if (t.text === ')' || t.text === ']' || t.text === '}') {
        depth--;
      }
    }
    return -1;
  }

  private parseValueRange(from: number, to: number, ctx: ParseContext): ValueRange | undefined {
    if (from >= to) {
      return undefined;
    }
    const toks = this.toks;
    const colon = this.findTopLevel(from, to, ':');
    if (colon < 0) {
      const e = exprFromTokens(toks.slice(from, to), ctx.scope);
      return { msb: e, lsb: { raw: '0', value: 0 } };
    }
    return {
      msb: exprFromTokens(toks.slice(from, colon), ctx.scope),
      lsb: exprFromTokens(toks.slice(colon + 1, to), ctx.scope),
    };
  }

  private parseParamItem(from: number, to: number, mod?: ModuleDef): ParamDecl | undefined {
    const toks = this.toks;
    let i = from;
    let isLocal = false;
    while (i < to && toks[i].kind === 'keyword' && (toks[i].text === 'parameter' || toks[i].text === 'localparam')) {
      isLocal = toks[i].text === 'localparam';
      i++;
    }
    const ctx: ParseContext = { file: this.file, scope: new MapScope(), inProcedural: false };
    const parsed = this.parseTypeAndName(i, to, ctx, true);
    if (!parsed || !parsed.name || !parsed.nameTok) {
      return undefined;
    }
    if (mod) {
      mod.refs.push(...parsed.typeRefs);
    }
    return {
      name: parsed.name,
      dataType: parsed.dataType,
      value: parsed.init,
      isLocal,
      isType: parsed.dataType.t === 'user',
      range: rangeOf(toks, from, to),
      nameRange: parsed.nameTok.range,
    };
  }

  private parseParamStatement(c: Cursor, mod: ModuleDef, ctx: ParseContext): boolean {
    const toks = this.toks;
    const start = c.pos;
    const end = this.statementEnd(c);
    const items = splitTopLevel(toks, start, end);
    for (const it of items) {
      const p = this.parseParamItem(it.from, it.to, mod);
      if (!p) {
        continue;
      }
      p.generate = ctx.generate;
      mod.params.push(p);
      this.collectDefaultRefs(mod, it.from, it.to);
      if (p.value?.value !== undefined) {
        ctx.scope.set(p.name, p.value.value);
        const w = typeWidth(p.dataType, ctx.scope);
        if (w !== undefined) {
          ctx.scope.setWidth(p.name, w);
        }
      }
      mod.refs.push({
        name: p.name,
        pathSuffix: '',
        fullPath: p.name,
        range: p.nameRange,
        isWrite: false,
        isDecl: true,
        kind: 'param',
      });
    }
    c.pos = end;
    return true;
  }

  /**
   * Names a parameter default refers to, so that renaming a parameter also
   * rewrites the defaults that depend on it and hovering highlights them.
   * The declaration itself is not included - that is added by the caller.
   */
  private collectDefaultRefs(mod: ModuleDef, from: number, to: number): void {
    const eq = this.findTopLevel(from, to, '=');
    if (eq < 0) {
      return;
    }
    for (const ref of this.collectRefs(this.toks.slice(eq + 1, to), false)) {
      mod.refs.push(ref);
    }
  }

  /** A typedef visible in `mod`, including one from a package in this file. */
  private isTypedefName(mod: ModuleDef, name: string): boolean {
    if (mod.decls.some((d) => d.name === name && d.kind === 'typedef')) {
      return true;
    }
    if (this.fileTypedefs.some((d) => d.name === name)) {
      return true;
    }
    // `pkg::type` - the qualified name names a package and one of its typedefs.
    const sep = name.indexOf('::');
    if (sep > 0) {
      const pkg = name.slice(0, sep);
      const type = name.slice(sep + 2);
      return this.modules.some(
        (m) => m.name === pkg && m.decls.some((d) => d.name === type && d.kind === 'typedef'),
      );
    }
    return this.modules.some(
      (m) => m.name !== mod.name && m.decls.some((d) => d.name === name && d.kind === 'typedef'),
    );
  }

  /**
   * `<type> name` or `<type> name, name2 = init;` - the shape of a declaration
   * whose type is a typedef name. Deliberately narrow: the next token has to be
   * an identifier, so `foo.bar(1);` and `foo(x);` are not mistaken for one.
   */
  private looksLikeDeclOf(toks: Token[], c: Cursor): boolean {
    // The declared name follows the type name, which may carry a package
    // qualifier: `pkg::state_e phase;`.
    const nameLen = qualifiedNameAt(toks, c.pos, c.end).tokens;
    const nameTok = toks[c.pos + nameLen];
    if (nameTok?.kind !== 'ident') {
      return false;
    }
    let depth = 0;
    for (let k = c.pos + nameLen + 1; k < c.end; k++) {
      const t = toks[k];
      if (t.text === '[') {
        depth++;
        continue;
      }
      if (t.text === ']') {
        depth--;
        continue;
      }
      if (depth > 0) {
        continue;
      }
      if (t.text === ';') {
        return true;
      }
      // An initializer may be a literal: `my_t x = 8'd0;`.
      if (t.kind === 'ident' || t.kind === 'number' || t.text === ',' || t.text === '=') {
        continue;
      }
      return false;
    }
    return false;
  }

  private parseDefparam(c: Cursor, mod: ModuleDef, _ctx: ParseContext): boolean {
    const toks = this.toks;
    // `c.pos` is the `defparam` keyword itself; the items start after it.
    const start = c.pos + 1;
    const end = this.statementEnd(c);
    const ctx: ParseContext = { file: this.file, scope: new MapScope(), inProcedural: false };
    for (const it of splitTopLevel(toks, start, end)) {
      const eq = this.findTopLevel(it.from, it.to, '=');
      if (eq < 0) {
        continue;
      }
      const lhs = toks.slice(it.from, eq);
      const paramTok = lhs[lhs.length - 1];
      if (!paramTok || paramTok.kind !== 'ident') {
        continue;
      }
      // `u.a.b.W` -> instance path `u.a.b`, parameter `W`.
      const target = lhs
        .slice(0, lhs.length - 1)
        .filter((t) => t.kind === 'ident')
        .map((t) => t.text)
        .join('.');
      if (!target) {
        continue;
      }
      const firstTok = lhs.find((t) => t.kind === 'ident')!;
      const d: DefParam = {
        target,
        targetRange: firstTok.range,
        param: paramTok.text,
        paramRange: paramTok.range,
        expr: exprFromTokens(toks.slice(eq + 1, it.to), ctx.scope),
      };
      mod.defparams.push(d);
    }
    c.pos = end;
    return true;
  }

  private parseTypedef(c: Cursor, mod: ModuleDef, ctx: ParseContext): boolean {
    const toks = this.toks;
    const start = c.pos;
    // `typedef enum {...} name;` - the enum braces contain commas at depth 0 of
    // the item split, so find the terminator manually.
    let end = start;
    let depth = 0;
    for (let k = start; k < c.end; k++) {
      const t = toks[k];
      if (t.text === '{' || t.text === '(' || t.text === '[') {
        depth++;
      } else if (t.text === '}' || t.text === ')' || t.text === ']') {
        depth--;
      } else if (t.text === ';' && depth <= 0) {
        end = k;
        break;
      }
    }
    if (end === start) {
      end = c.end;
    }
    // The declared name is the last ident after the closing brace.
    let nameIdx = -1;
    for (let k = end - 1; k > start; k--) {
      if (toks[k].kind === 'ident') {
        nameIdx = k;
        break;
      }
    }
    if (nameIdx > 0) {
      const name = toks[nameIdx].text;
      mod.decls.push({
        name,
        dataType: { t: 'user', name },
        kind: 'typedef',
        range: rangeOf(toks, start, end),
        nameRange: toks[nameIdx].range,
      });
      mod.refs.push({
        name,
        pathSuffix: '',
        fullPath: name,
        range: toks[nameIdx].range,
        isWrite: false,
        isDecl: true,
        kind: 'type',
      });
      this.parseEnumMembers(mod, ctx, start, end, name);
    }
    void ctx;
    c.pos = Math.min(end + 1, c.end);
    return true;
  }

  /**
   * The names inside `typedef enum { A, B = 2, C } e_t;` are declarations of
   * the enclosing scope - LRM calls them localparam-like - and they are used
   * bare (`if (state == IDLE)`) far more often than through the type name. The
   * typedef path records only the type, so those names used to be invisible:
   * no declaration to jump to, no hover, and a flattened copy referenced a
   * constant nobody had defined. Each member therefore becomes a localparam of
   * the module (or of the package, when the typedef sits in one) carrying the
   * value the member has, which is `previous + 1` unless it says otherwise.
   */
  private parseEnumMembers(mod: ModuleDef, ctx: ParseContext, from: number, to: number, typeName: string): void {
    const toks = this.toks;
    let enumIdx = -1;
    for (let k = from; k < to; k++) {
      if (toks[k].kind === 'keyword' && toks[k].text === 'enum') {
        enumIdx = k;
        break;
      }
    }
    if (enumIdx < 0) {
      return;
    }
    // The member list is the first brace group after `enum`; anything between
    // is the base type (`logic [1:0]`, `bit`, or a previously declared enum).
    let open = -1;
    for (let k = enumIdx + 1; k < to; k++) {
      if (toks[k].text === '{') {
        open = k;
        break;
      }
    }
    if (open < 0) {
      return;
    }
    const close = matchBracket(toks, open, to);
    if (close < 0) {
      return;
    }
    let previous: number | undefined;
    for (const it of splitTopLevel(toks, open + 1, close)) {
      if (it.to <= it.from || toks[it.from].kind !== 'ident') {
        continue;
      }
      const name = toks[it.from].text;
      const eq = this.findTopLevel(it.from, it.to, '=');
      let value: ConstExpr;
      if (eq >= 0) {
        const exprToks = toks.slice(eq + 1, it.to);
        value = exprFromTokens(exprToks, ctx.scope);
        mod.refs.push(...this.collectRefs(exprToks, false));
      } else if (previous !== undefined) {
        value = { raw: String(previous + 1), value: previous + 1 };
      } else {
        // The first member of an enum counts from zero unless it says otherwise.
        value = { raw: '0', value: 0 };
      }
      if (value.value !== undefined) {
        previous = value.value;
        ctx.scope.set(name, value.value);
      }
      const nameRange = toks[it.from].range;
      mod.params.push({
        name,
        dataType: { t: 'user', name: typeName },
        value,
        isLocal: true,
        isType: false,
        range: rangeOf(toks, it.from, it.to),
        nameRange,
      });
      mod.refs.push({
        name,
        pathSuffix: '',
        fullPath: name,
        range: nameRange,
        isWrite: false,
        isDecl: true,
        kind: 'param',
      });
    }
  }

  // -------------------------------------------------------------------------
  // Assignments
  // -------------------------------------------------------------------------

  /**
   * Record an assignment and fold its references into the module-wide list, so
   * that "find references", hover and semantic tokens see signals that are only
   * used inside assignments.
   */
  private addAssign(mod: ModuleDef, site: AssignSite, generate?: string): void {
    if (generate !== undefined) {
      site.generate = generate;
    }
    mod.assigns.push(site);
    mod.refs.push(...site.lhs, ...site.rhs);
  }

  private parseAssign(c: Cursor, mod: ModuleDef, ctx: ParseContext, inAlways: boolean): boolean {
    const toks = this.toks;
    const start = c.pos;
    const end = this.statementEnd(c);
    const eq = this.findTopLevel(start, end, '=');
    if (eq >= 0) {
      const lhsToks = toks.slice(start + 1, trimSemi(toks, start + 1, eq));
      const rhsToks = toks.slice(eq + 1, trimSemi(toks, eq + 1, end));
      const site: AssignSite = {
        lhs: this.collectRefs(lhsToks, true),
        rhs: this.collectRefs(rhsToks, false),
        lhsText: prettyJoin(lhsToks),
        rhsText: prettyJoin(rhsToks),
        range: rangeOf(toks, start, end),
        isAlias: false,
        inAlways,
      };
      if (site.lhs.length === 1 && site.lhs[0].pathSuffix === '') {
        site.junction = site.lhs[0].name;
      }
      this.addAssign(mod, site, ctx.generate);
    }
    void ctx;
    c.pos = end;
    return true;
  }

  /**
   * `always @(posedge clk) ...` / `initial begin ... end` / `final if (...) x = 1;`
   *
   * `always*` has no closing keyword, so the body extent has to be derived from
   * the optional sensitivity list plus the single statement that follows.
   */
  private parseProcedural(c: Cursor, mod: ModuleDef, ctx: ParseContext): boolean {
    const toks = this.toks;
    let k = c.pos + 1;
    // `always @ (posedge clk or negedge rst)` / `always @*` / `always_comb`
    if (toks[k]?.text === '@') {
      k++;
      if (toks[k]?.text === '(') {
        const close = matchBracket(toks, k, c.end);
        // The signals in the event control are read by the block. Without them
        // a clock that nothing drives looks unused, which is exactly the mistake
        // this view is meant to catch.
        if (close > k) {
          for (const ref of this.collectRefs(toks.slice(k + 1, close), false)) {
            ref.context = 'event';
            mod.refs.push(ref);
          }
        }
        k = close > 0 ? close + 1 : c.end;
      } else if (toks[k]?.text === '*') {
        k++;
      }
    }
    let bodyEnd: number;
    if (toks[k]?.text === 'begin' || toks[k]?.text === 'fork') {
      const close = matchBlock(toks, k, c.end);
      this.scanProcedural(new Cursor(toks, k + 1, close > k ? close : c.end), mod,
        { ...ctx, inProcedural: true });
      bodyEnd = Math.max(close, k);
    } else {
      // A single statement (or a bare `if`/`for` chain).
      const probe = new Cursor(toks, k, c.end);
      bodyEnd = this.statementEnd(probe);
      this.scanProcedural(new Cursor(toks, k, Math.max(bodyEnd, k + 1)), mod,
        { ...ctx, inProcedural: true });
      bodyEnd = Math.max(bodyEnd, k);
    }
    c.pos = Math.min(bodyEnd + 1, c.end);
    return true;
  }

  /** Advance past the condition of `if`/`for`/`while`/`case`, if present. */
  private skipCondition(c: Cursor): void {
    if (c.at('(')) {
      const close = matchBracket(this.toks, c.pos, c.end);
      c.pos = close > 0 ? close + 1 : c.end;
    }
  }

  /** Collect assignments inside always/initial/final bodies. */
  private scanProcedural(c: Cursor, mod: ModuleDef, ctx: ParseContext): void {
    const toks = this.toks;
    while (!c.done) {
      const t = c.cur()!;
      if (t.kind === 'attribute' || t.kind === 'directive') {
        c.pos++;
        continue;
      }
      if (t.kind === 'keyword' && BLOCK_OPENERS.has(t.text) &&
          t.text !== 'begin' && t.text !== 'fork' && t.text !== 'case' &&
          t.text !== 'casex' && t.text !== 'casez') {
        this.parseBlock(c, mod, { ...ctx, inProcedural: false }, false);
        continue;
      }
      if (t.kind === 'keyword' && (t.text === 'begin' || t.text === 'fork')) {
        const close = matchBlock(toks, c.pos, c.end);
        this.scanProcedural(c.slice(c.pos + 1, close), mod, ctx);
        c.pos = Math.min(close + 1, c.end);
        continue;
      }
      if (t.kind === 'keyword' && (t.text === 'case' || t.text === 'casex' || t.text === 'casez')) {
        const close = matchBlock(toks, c.pos, c.end);
        // Skip `case (sel)` so the branches start at their labels.
        const sub = new Cursor(toks, c.pos + 1, close);
        this.skipCondition(sub);
        // `endcase` follows the last branch; assignments live in the branches.
        this.scanProcedural(sub, mod, ctx);
        c.pos = Math.min(close + 1, c.end);
        continue;
      }
      if (t.kind === 'keyword' && (t.text === 'if' || t.text === 'else' || t.text === 'for' ||
          t.text === 'while' || t.text === 'foreach' || t.text === 'repeat' ||
          t.text === 'forever' || t.text === 'do')) {
        // Recurse into the controlled statement so its assignments are found and
        // the loop condition is never mistaken for an assignment LHS.
        c.pos++;
        if (t.text !== 'do' && t.text !== 'forever' && t.text !== 'else') {
          this.skipCondition(c);
        }
        if (!c.done) {
          // The child cursor is mutated in place, so afterwards the parent knows
          // exactly where the controlled statement ended and can keep scanning.
          const sub = new Cursor(toks, c.pos, c.end);
          this.scanProcedural(sub, mod, ctx);
          c.pos = Math.max(sub.pos, c.pos);
        }
        continue;
      }
      if (t.text === ';' || t.text === ',') {
        c.pos++;
        continue;
      }
      // Case item label: `LOGIC_VAL: y = ...;`
      if ((t.kind === 'ident' || (t.kind === 'number' && false)) && c.peek(1)?.text === ':') {
        c.pos += 2;
        continue;
      }
      if (t.kind === 'keyword' && (t.text === 'default') && c.peek(1)?.text === ':') {
        c.pos += 2;
        continue;
      }
      if (t.kind === 'keyword' && t.text === 'assign') {
        this.parseAssign(c, mod, ctx, false);
        continue;
      }
      const start = c.pos;
      let end = this.statementEnd(c);
      const eq = this.findFirstAssignOp(start, end);
      if (eq >= 0) {
        const site: AssignSite = {
          lhs: this.collectRefs(toks.slice(start, eq), true),
          rhs: this.collectRefs(toks.slice(eq + 1, end), false),
          lhsText: prettyJoin(toks.slice(start + 1, trimSemi(toks, start + 1, eq))),
          rhsText: prettyJoin(toks.slice(eq + 1, trimSemi(toks, eq + 1, end))),
          range: rangeOf(toks, start, end),
          isAlias: false,
          inAlways: true,
        };
        if (site.lhs.length === 1 && site.lhs[0].pathSuffix === '') {
          site.junction = site.lhs[0].name;
        }
        this.addAssign(mod, site, ctx.generate);
      }
      if (end === start) {
        end = start + 1;
      }
      c.pos = Math.max(end, start + 1);
    }
  }

  /**
   * Index of the first assignment operator at bracket depth 0. The lexer emits
   * `==`/`<=` as single combined tokens, so a bare `=` is unambiguously an
   * assignment; compound forms (`+=`) are also single tokens.
   */
  private findFirstAssignOp(from: number, to: number): number {
    const toks = this.toks;
    // `<=` is the non-blocking assignment; `==`/`<=`-as-comparison never appear
    // as a separate token because the lexer emits them combined.
    const compound = new Set(['<=', '+=', '-=', '*=', '/=', '%=', '|=', '&=', '^=', '<<=', '>>=']);
    let depth = 0;
    for (let k = from; k < to; k++) {
      const txt = toks[k].text;
      if (txt === '(' || txt === '[' || txt === '{') {
        depth++;
      } else if (txt === ')' || txt === ']' || txt === '}') {
        depth--;
      } else if (depth === 0 && (txt === '=' || compound.has(txt))) {
        return k;
      }
    }
    return -1;
  }

  private findAssignmentAt(from: number, to: number, op: string): number {
    const toks = this.toks;
    let depth = 0;
    for (let k = from; k < to; k++) {
      const t = toks[k];
      if (t.text === '(' || t.text === '[' || t.text === '{') {
        depth++;
      } else if (t.text === ')' || t.text === ']' || t.text === '}') {
        depth--;
      } else if (t.text === op && depth === 0) {
        return k;
      }
    }
    return -1;
  }

  // -------------------------------------------------------------------------
  // Functions / tasks
  // -------------------------------------------------------------------------

  /**
   * Parse `function [automatic] [rettype] name(args); body endfunction`.
   *
   * The name is the last identifier before the argument list, which is the only
   * shape that survives multi-line headers and return types such as
   * `logic [WIDTH-1:0]`.
   */
  private parseFunction(c: Cursor, mod: ModuleDef, ctx: ParseContext, isPackage: boolean): boolean {
    const toks = this.toks;
    const kind = c.cur()!.text === 'task' ? 'task' : 'function';
    const close = matchBlock(toks, c.pos, c.end);
    const slice: Slice = { from: c.pos + 1, to: close > c.pos ? close : c.end };
    const localCtx: ParseContext = { ...ctx, inProcedural: false };

    let stmtEnd = this.statementEnd(new Cursor(toks, slice.from, slice.to));
    if (stmtEnd > slice.from && toks[stmtEnd - 1]?.text === ';') {
      stmtEnd--;
    }
    const hdrEnd = Math.min(Math.max(stmtEnd, slice.from + 1), slice.to);

    // The argument list, when present, is the trailing `( ... )` of the header.
    let argOpen = -1;
    let argClose = -1;
    if (toks[hdrEnd - 1]?.text === ')') {
      argClose = hdrEnd - 1;
      argOpen = this.findMatchingOpen(toks, argClose, slice.from);
    }
    const nameLimit = argOpen >= 0 ? argOpen : hdrEnd;

    // Name = last identifier before the argument list.
    let nameIdx = -1;
    for (let k = nameLimit - 1; k >= slice.from; k--) {
      if (toks[k].kind === 'ident' && !MODIFIERS.has(toks[k].text)) {
        nameIdx = k;
        break;
      }
    }
    if (nameIdx < 0) {
      mod.usesUnknownConstruct = true;
      c.pos = Math.min(close + 1, c.end);
      return true;
    }
    const nameTok = toks[nameIdx];

    // Return type = everything between the qualifiers and the name.
    let typeStart = slice.from;
    while (typeStart < nameIdx && toks[typeStart].kind === 'keyword' &&
           (MODIFIERS.has(toks[typeStart].text) || toks[typeStart].text === 'void')) {
      typeStart++;
    }
    let returnType: DataType | undefined;
    if (typeStart < nameIdx) {
      const t = this.parseTypeAndName(typeStart, nameIdx, localCtx, false);
      returnType = t?.dataType;
    }

    const args: PortDecl[] = [];
    if (argOpen >= 0 && argClose > argOpen) {
      for (const s of splitTopLevel(toks, argOpen + 1, argClose)) {
        const p = this.parseAnsiPort(s.from, s.to, localCtx);
        if (p) {
          args.push(p);
        }
      }
    }

    const f: FunctionDecl = {
      name: nameTok.text,
      kind,
      returnType,
      args,
      range: rangeOf(toks, c.pos, close > 0 ? close : c.end),
      nameRange: nameTok.range,
    };
    mod.funcs.push(f);
    mod.refs.push({
      name: f.name,
      pathSuffix: '',
      fullPath: f.name,
      range: f.nameRange,
      isWrite: false,
      isDecl: true,
      kind: 'function',
    });

    // Body: non-ANSI argument declarations, locals and the return expression.
    if (close > hdrEnd) {
      this.scanFunctionBody(new Cursor(toks, hdrEnd + 1, close), mod, f, localCtx, isPackage);
    }
    c.pos = Math.min(close + 1, c.end);
    return true;
  }

  private scanFunctionBody(c: Cursor, mod: ModuleDef, f: FunctionDecl, ctx: ParseContext, isPackage: boolean): void {
    const toks = this.toks;
    const procCtx: ParseContext = { ...ctx, inProcedural: true };
    while (!c.done) {
      const t = c.cur()!;
      if (t.kind === 'attribute' || t.kind === 'directive' || t.text === ';') {
        c.pos++;
        continue;
      }
      if (t.kind === 'keyword' && (DIR_KEYWORDS.has(t.text) || t.text === 'var' || t.text === 'logic' || t.text === 'reg' || t.text === 'int' || t.text === 'integer' || t.text === 'bit' || t.text === 'wire')) {
        const start = c.pos;
        const end = this.statementEnd(c);
        const items = splitTopLevel(toks, start, end);
        for (const it of items) {
          if (toks[it.from].kind === 'keyword' && DIR_KEYWORDS.has(toks[it.from].text)) {
            const p = this.parseAnsiPort(it.from, it.to, ctx);
            if (p) {
              f.args.push(p);
            }
          } else {
            const v = this.parseVarDeclaration(c.slice(it.from, it.to), mod, procCtx,
              toks[it.from].text === 'logic' || toks[it.from].text === 'reg' || toks[it.from].text === 'bit' ? 'reg' : 'integer');
            void v;
          }
        }
        c.pos = end;
        continue;
      }
      if (t.kind === 'keyword' && BLOCK_OPENERS.has(t.text)) {
        this.parseBlock(c, mod, procCtx, isPackage);
        continue;
      }
      if (t.kind === 'keyword' && (t.text === 'typedef' || t.text === 'localparam' || t.text === 'parameter' || t.text === 'genvar')) {
        this.parseBodyItem(c, mod, ctx, isPackage);
        continue;
      }
      // `return expr;`
      if (t.kind === 'keyword' && t.text === 'return') {
        const end = this.statementEnd(c);
        f.returnExpr = exprFromTokens(toks.slice(c.pos + 1, end), ctx.scope);
        c.pos = end;
        continue;
      }
      // Local variable declaration in a function body.
      if (t.kind === 'ident' && this.looksLikeDeclaration(c)) {
        this.parseVarDeclaration(c, mod, procCtx, 'reg');
        continue;
      }
      const start = c.pos;
      const end = this.statementEnd(c);
      if (end === start) {
        c.pos = start + 1;
        continue;
      }
      // `name = expr;` local assignment
      const eq = this.findAssignmentAt(start, end, '=');
      if (eq > start && eq - start === 1) {
        this.addAssign(mod, {
          lhs: this.collectRefs(toks.slice(start, eq), true),
          rhs: this.collectRefs(toks.slice(eq + 1, end), false),
          lhsText: prettyJoin(toks.slice(start, trimSemi(toks, start, eq))),
          rhsText: prettyJoin(toks.slice(eq + 1, trimSemi(toks, eq + 1, end))),
          range: rangeOf(toks, start, end),
          isAlias: false,
          inAlways: true,
          generate: ctx.generate,
        });
      }
      c.pos = end;
    }
  }

  private looksLikeDeclaration(c: Cursor): boolean {
    const t = c.cur()!;
    if (t.kind !== 'ident') {
      return false;
    }
    const n = c.peek(1);
    if (!n) {
      return false;
    }
    // `=` means an assignment, not a declaration.
    if (n.text === '[' || n.text === ';' || n.text === ',') {
      return true;
    }
    if (n.text === '=') {
      return false;
    }
    // `int q;` style with a user type: `state_t q;`
    return n.kind === 'ident' && (c.peek(2)?.text === ';' || c.peek(2)?.text === '=');
  }

  // -------------------------------------------------------------------------
  // Instantiations
  // -------------------------------------------------------------------------

  /**
   * Detect `modname [#(...)] instname [dims] (conns);`
   * Requires an ident, an optional parameter override, an ident, then `(`.
   */
  private looksLikeInstantiation(c: Cursor): boolean {
    const t0 = c.cur();
    // The module name may be a macro reference (`` `CELL #(...) u_x ()``).
    // Macros are not expanded, but the instance must still be recorded so the
    // hierarchy and the graph stay complete.
    if (!t0 || (t0.kind !== 'ident' && t0.kind !== 'macroRef')) {
      return false;
    }
    let k = c.pos + 1;
    const toks = this.toks;
    const end = Math.min(c.end, k + 200);
    // `#(...)` parameter overrides
    if (toks[k]?.text === '#') {
      k++;
      if (toks[k]?.text !== '(') {
        return false;
      }
      const close = matchBracket(toks, k, end);
      if (close < 0) {
        return false;
      }
      k = close + 1;
    }
    const nameTok = toks[k];
    if (!nameTok || nameTok.kind !== 'ident') {
      return false;
    }
    k++;
    // Instance array dims
    while (toks[k]?.text === '[') {
      const close = matchBracket(toks, k, end);
      if (close < 0) {
        return false;
      }
      k = close + 1;
    }
    if (toks[k]?.text === '(') {
      return true;
    }
    // `sub u;` - an instantiation with no port list at all, which generated RTL
    // uses a lot. It is only read as one when the name really is a scope of this
    // file; `byte_t data;` has the same shape and is a declaration.
    return toks[k]?.text === ';' && this.scopeNames.has(t0.text);
  }

  private parseInstantiation(c: Cursor, mod: ModuleDef, ctx: ParseContext): boolean {
    const toks = this.toks;
    const start = c.pos;
    const end = this.statementEnd(c);
    const moduleTok = toks[start];
    const limit = end;

    let k = start + 1;
    const paramOverrides: ParamOverride[] = [];
    if (toks[k]?.text === '#') {
      k++;
      if (toks[k]?.text === '(') {
        const close = matchBracket(toks, k, limit);
        if (close > 0) {
          const items = splitTopLevel(toks, k + 1, close);
          items.forEach((s) => {
            const dot = toks[s.from]?.text === '.' ? this.findTopLevel(s.from, s.to, '(') : -1;
            if (dot >= 0) {
              const nameTok = toks[s.from + 1];
              const pClose = matchBracket(toks, dot, s.to);
              paramOverrides.push({
                name: nameTok?.text,
                expr: exprFromTokens(toks.slice(dot + 1, pClose > 0 ? pClose : s.to), ctx.scope),
                byPosition: false,
                range: rangeOf(toks, s.from, s.to),
              });
            } else {
              paramOverrides.push({
                expr: exprFromTokens(toks.slice(s.from, s.to), ctx.scope),
                byPosition: true,
                range: rangeOf(toks, s.from, s.to),
              });
            }
          });
          k = close + 1;
        }
      }
    }

    // `modname u1 (...), u2 (...), u3 (...);` declares several instances.
    let produced = 0;
    for (;;) {
      const nameTok = toks[k];
      if (!nameTok || nameTok.kind !== 'ident') {
        break;
      }
      let kk = k + 1;
      let arrayCount: ValueRange | undefined;
      while (toks[kk]?.text === '[') {
        const close = matchBracket(toks, kk, limit);
        if (close < 0) {
          break;
        }
        const r = this.parseValueRange(kk + 1, close, ctx);
        if (r) {
          arrayCount = r;
        }
        kk = close + 1;
      }

      const connections: PortConn[] = [];
      let positional = false;
      if (toks[kk]?.text === '(') {
        const close = matchBracket(toks, kk, limit);
        if (close > 0) {
          const items = splitTopLevel(toks, kk + 1, close);
          const hasNamed = items.some((s) => isDotToken(toks[s.from]?.text));
          positional = !hasNamed;
          for (const s of items) {
            connections.push(this.parsePortConn(s, hasNamed));
          }
          kk = close + 1;
        }
      }

      const inst: InstanceSite = {
        name: nameTok.text,
        rawName: nameTok.text,
        moduleName: moduleTok.text,
        moduleNameRange: moduleTok.range,
        nameRange: nameTok.range,
        range: rangeOf(toks, start, end),
        connections,
        parent: mod.name,
        paramOverrides,
        inGenerate: ctx.generate !== undefined,
        conditional: ctx.conditional === true,
      };
      if (ctx.genPrefix) {
        inst.genPrefix = ctx.genPrefix;
      }
      if (arrayCount) {
        inst.arrayCount = arrayCount;
      }
      if (positional) {
        inst.positional = true;
      }
      mod.instances.push(inst);
      mod.refs.push({
        name: moduleTok.text,
        pathSuffix: '',
        fullPath: moduleTok.text,
        range: moduleTok.range,
        isWrite: false,
        isDecl: false,
        kind: 'module',
      });
      for (const conn of connections) {
        for (const r of conn.refs) {
          mod.refs.push(r);
        }
      }
      produced++;
      k = kk;

      // Continue only for a real `, instanceName` continuation.
      if (toks[k]?.text === ',' && toks[k + 1]?.kind === 'ident') {
        k++;
        continue;
      }
      break;
    }

    if (produced === 0) {
      mod.usesUnknownConstruct = true;
    }
    c.pos = end;
    return true;
  }

  private parsePortConn(s: Slice, hasNamed: boolean): PortConn {
    const toks = this.toks;
    if (isDotToken(toks[s.from]?.text)) {
      // `.*` connects every port to the signal of the same name. The lexer keeps
      // it as a single token.
      if (toks[s.from]?.text === '.*') {
        return {
          portName: '*',
          refs: [],
          rawExpr: '*',
          range: rangeOf(toks, s.from, s.to),
          nameRange: toks[s.from].range,
          empty: false,
          shorthand: true,
        };
      }
      // A lone `.` without a port name is a syntax error; keep it as an empty
      // connection so the rest of the instance still parses.
      if (hasNamed && (s.from + 1 >= s.to || toks[s.from + 1]?.kind !== 'ident')) {
        return {
          portName: '',
          refs: [],
          rawExpr: '',
          range: rangeOf(toks, s.from, s.to),
          nameRange: toks[s.from].range,
          empty: true,
          shorthand: false,
        };
      }
      // Named connection: `.port(expr)`.
      const nameTok = toks[s.from + 1];
      const openIdx = s.from + 2;
      if (toks[openIdx]?.text !== '(') {
        // SystemVerilog implicit connection `.name` written without parentheses:
        // it connects to the signal of the same name in this scope.
        const name = nameTok?.text ?? '';
        return {
          portName: name,
          refs: [
            {
              name,
              pathSuffix: '',
              fullPath: name,
              range: nameTok?.range ?? rangeOf(toks, s.from, s.to),
              isWrite: false,
              isDecl: false,
              kind: 'unknown',
            },
          ],
          rawExpr: name,
          range: rangeOf(toks, s.from, s.to),
          nameRange: nameTok?.range ?? toks[s.from].range,
          empty: false,
          shorthand: true,
        };
      }
      let closeIdx = s.to - 1;
      {
        const m = matchBracket(toks, openIdx, s.to);
        if (m > 0) {
          closeIdx = m;
        }
      }
      const exprToks = openIdx <= closeIdx ? toks.slice(openIdx + (toks[openIdx]?.text === '(' ? 1 : 0), closeIdx) : [];
      const empty = exprToks.length === 0;
      return {
        portName: nameTok?.text ?? '',
        refs: empty ? [] : this.collectRefs(exprToks, false),
        rawExpr: joinText(exprToks),
        range: rangeOf(toks, s.from, s.to),
        nameRange: nameTok?.range ?? toks[s.from].range,
        empty,
        shorthand: false,
      };
    }
    if (hasNamed) {
      // SystemVerilog implicit connection `.name` written without parentheses.
      const nameTok = toks[s.from];
      return {
        portName: nameTok?.text ?? '',
        refs: [{ name: nameTok?.text ?? '', pathSuffix: '', fullPath: nameTok?.text ?? '', range: nameTok?.range ?? rangeOf(toks, s.from, s.to), isWrite: false, isDecl: false, kind: 'unknown' }],
        rawExpr: nameTok?.text ?? '',
        range: rangeOf(toks, s.from, s.to),
        nameRange: nameTok?.range ?? rangeOf(toks, s.from, s.to),
        empty: false,
        shorthand: true,
      };
    }
    // Positional connection.
    const exprToks = toks.slice(s.from, s.to);
    return {
      portName: '',
      refs: this.collectRefs(exprToks, false),
      rawExpr: joinText(exprToks),
      range: rangeOf(toks, s.from, s.to),
      nameRange: toks[s.from]?.range ?? rangeOf(toks, s.from, s.to),
      empty: exprToks.length === 0,
      shorthand: false,
    };
  }

  /** `bind target modname inst (conns);` - index the inner instantiation. */
  /**
   * `import pkg::a, pkg::b;` and `import pkg::*;` list what the module borrows.
   * The names are declared in the package, so the module has nothing of its own
   * to point at - without this, every use of an imported constant was reported as
   * an undeclared name.
   */
  private parseImport(c: Cursor, imports: ImportDecl[]): boolean {
    const toks = this.toks;
    const end = this.statementEnd(c);
    // `import "DPI-C" function ...;` names no package: the string is not an
    // identifier, so the walk below finds no `pkg::name` and records nothing.
    let k = c.pos + 1;
    let pkg = '';
    let names: ImportedName[] = [];
    let wildcard = false;
    while (k < end) {
      const t = toks[k];
      if (t.kind !== 'ident') {
        k++;
        continue;
      }
      pkg = t.text;
      k++;
      if (toks[k]?.text === '::') {
        k++;
      } else {
        // Not a package import; leave it to the skip below.
        pkg = '';
        break;
      }
      // One or more names, or `*`.
      for (;;) {
        const n = toks[k];
        if (!n) {
          break;
        }
        if (n.text === '*') {
          wildcard = true;
          k++;
          break;
        }
        if (n.kind !== 'ident') {
          break;
        }
        names.push({ name: n.text, range: n.range });
        k++;
        if (toks[k]?.text === '::') {
          // A later item names the same package again: `import p::a, p::b;`.
          k++;
          continue;
        }
        break;
      }
      if (toks[k]?.text === ',') {
        k++;
        continue;
      }
      break;
    }
    if (pkg && (names.length > 0 || wildcard)) {
      imports.push({ pkg, names, wildcard, range: toks[c.pos].range });
    }
    c.pos = end;
    return true;
  }

  /**
   * `bind <target> <type> <instance> (ports);` binds an instance of `<type>`
   * into every `<target>`, so the instance is recorded where the statement is
   * written. The two names before the port list are the target scope and the
   * type, so the slice has to start one identifier earlier than the instance
   * name - slicing at the instance name gave the parser a module with no
   * instance name at all, and the bound instance was dropped.
   */
  private parseBind(c: Cursor, mod: ModuleDef, ctx: ParseContext): boolean {
    const toks = this.toks;
    const end = this.statementEnd(c);
    let instStart = -1;
    for (let k = c.pos + 1; k < end; k++) {
      if (toks[k].text === '(') {
        instStart = k - 1;
        break;
      }
    }
    if (instStart > c.pos + 2) {
      const sub = c.slice(instStart - 1, end);
      const before = mod.refs.length;
      this.parseInstantiation(sub, mod, ctx);
      // The connections name signals of the target module, so nothing in this
      // module declares them. Marking them keeps the undeclared-name check quiet
      // on a statement that is perfectly legal.
      for (const r of mod.refs.slice(before)) {
        r.bind = true;
        if (r.kind === 'unknown') {
          r.kind = 'signal';
        }
      }
    }
    c.pos = end;
    return true;
  }

  // -------------------------------------------------------------------------
  // References
  // -------------------------------------------------------------------------

  /**
   * Collect identifier references from an expression token list, merging dotted
   * chains (`a.b.c` -> one ref with `name='a'`, `pathSuffix='.b.c'`).
   */
  private collectRefs(toks: Token[], isWrite: boolean): RefSite[] {
    const out: RefSite[] = [];
    let i = 0;
    // `pkg::` in front of the current name: the package is a scope, not a use.
    let qualifier: Token | undefined;
    while (i < toks.length) {
      const t = toks[i];
      // Gate primitives and operators (`and`, `or`, `not`, ...) are keywords to
      // the language but not in the keyword table, so they arrive here as
      // identifiers. Treating them as uses would invent references named "or"
      // for every `posedge clk or negedge rst`.
      const usable =
        (t.kind === 'ident' || (t.kind === 'keyword' && !KEYWORDS.has(t.text))) &&
        !GATE_KEYWORDS.has(t.text);
      if (!usable) {
        i++;
        continue;
      }
      if (toks[i + 1]?.text === '::') {
        qualifier = t;
        i += 2;
        continue;
      }
      if (t.text.startsWith('$')) {
        // System identifiers are not declared anywhere, so they never resolve.
        // They are kept (flagged) rather than dropped: the Problems view should
        // not call `$clog2` a typo, and semantic highlighting wants to colour it.
        out.push({
          name: t.text,
          pathSuffix: '',
          fullPath: t.text,
          range: { start: t.range.start, end: t.range.end },
          isWrite,
          isDecl: false,
          kind: 'unknown',
          system: true,
        });
        i++;
        continue;
      }
      const name = t.text;
      const pathParts: string[] = [name];
      let endIdx = i;
      // Dotted suffix.
      let k = i + 1;
      for (;;) {
        if (toks[k]?.text === '[') {
          const close = matchBracket(toks, k, toks.length);
          if (close < 0) {
            break;
          }
          k = close + 1;
          continue;
        }
        if (toks[k]?.text === '.' && (toks[k + 1]?.kind === 'ident' || toks[k + 1]?.kind === 'keyword')) {
          pathParts.push(toks[k + 1].text);
          k += 2;
          endIdx = k - 1;
          continue;
        }
        break;
      }
      const lastTok = toks[endIdx] ?? t;
      const path = pathParts.join('.');
      if (qualifier) {
        // `cfg::UNROLL` is one reference to UNROLL in the package cfg. The
        // range covers both halves so that clicking either one finds it, while
        // the name stays the element after `::` - the part being used.
        out.push({
          name,
          pathSuffix: '',
          fullPath: `${qualifier.text}::${path}`,
          range: { start: qualifier.range.start, end: lastTok.range.end },
          isWrite,
          isDecl: false,
          kind: 'unknown',
        });
        qualifier = undefined;
      } else {
        out.push({
          name,
          pathSuffix: pathParts.length > 1 ? '.' + pathParts.slice(1).join('.') : '',
          fullPath: path,
          range: { start: t.range.start, end: lastTok.range.end },
          isWrite,
          isDecl: false,
          kind: 'unknown',
        });
      }
      i = Math.max(k, i + 1);
    }
    return out;
  }

  private classifyInstanceRefs(inst: InstanceSite, mod: ModuleDef): void {
    void mod;
    for (const conn of inst.connections) {
      for (const r of conn.refs) {
        r.isWrite = false;
      }
    }
  }

  /**
   * Post-pass: give every collected reference a kind by matching it against the
   * module's declaration tables. Bare names that match nothing become
   * `unknown`, which the Problems view surfaces.
   */
  private classifyRefs(mod: ModuleDef): void {
    const ports = new Set(mod.ports.map((p) => p.name));
    const params = new Set(mod.params.map((p) => p.name));
    const decls = new Map<string, VarKind>();
    for (const d of mod.decls) {
      decls.set(d.name, d.kind);
    }
    const funcs = new Set(mod.funcs.map((f) => f.name));
    const instNames = new Set(mod.instances.map((i) => i.name));

    for (const r of mod.refs) {
      if (r.kind === 'module' || r.bind) {
        // A `bind` connection is classified where the statement stands, because
        // its names belong to the module it binds into.
        continue;
      }
      if (r.isDecl) {
        continue;
      }
      if (ports.has(r.name)) {
        r.kind = 'signal';
      } else if (params.has(r.name)) {
        r.kind = 'param';
      } else if (decls.has(r.name)) {
        const k = decls.get(r.name);
        if (k === 'typedef') {
          r.kind = 'type';
        } else if (k === 'genvar') {
          r.kind = 'genvar';
        } else {
          r.kind = 'signal';
        }
      } else if (funcs.has(r.name)) {
        r.kind = 'function';
      } else if (instNames.has(r.name)) {
        r.kind = 'signal';
      } else if (this.isTypeNameInFile(r.name)) {
        // A typedef declared in a package (or at file scope) but used in this
        // module. A port or a local signal of the same name is classified above,
        // so the shadowing rule still holds.
        r.kind = 'type';
      } else {
        r.kind = this.classifyScopeQualified(r) ?? 'unknown';
      }
    }
    this.classifyTypeUses(mod);
  }

  /**
   * A name used as the type of a declaration in this module is a type, even when
   * nothing here declares it: a design keeps its shared types in a header, and
   * the type name has to be coloured as a type rather than reported as an
   * unknown signal. Only names left `unknown` are touched, so a signal that
   * shadows a type name keeps its own kind.
   */
  private classifyTypeUses(mod: ModuleDef): void {
    const typeNames = new Set<string>();
    const add = (dt: DataType): void => {
      if (dt.t !== 'user' || !dt.name) {
        return;
      }
      const i = dt.name.indexOf('::');
      typeNames.add(i < 0 ? dt.name : dt.name.slice(i + 2));
    };
    for (const d of mod.decls) {
      add(d.dataType);
    }
    for (const p of mod.ports) {
      add(p.dataType);
    }
    if (typeNames.size === 0) {
      return;
    }
    for (const r of mod.refs) {
      if (r.kind === 'unknown' && typeNames.has(r.name)) {
        r.kind = 'type';
      }
    }
  }

  /**
   * A continuous assignment to a name nothing declares creates that name: in
   * Verilog it is an implicit one-bit wire. Leaving it undeclared made every
   * such signal a "not declared" warning, on code that is perfectly legal and
   * common in small modules. A procedural assignment is different - there an
   * undeclared name really is a mistake - so `inAlways` sites are left alone.
   */
  private declareImplicitNets(mod: ModuleDef): void {
    const declared = new Set<string>();
    for (const p of mod.ports) {
      declared.add(p.name);
    }
    for (const d of mod.decls) {
      declared.add(d.name);
    }
    for (const f of mod.funcs) {
      declared.add(f.name);
    }
    for (const p of mod.params) {
      declared.add(p.name);
    }
    for (const site of mod.assigns) {
      if (site.inAlways) {
        continue;
      }
      for (const lhs of site.lhs) {
        // A bare name, or a bit or part select of one: `w[0] = 1'b0`.
        if (lhs.fullPath !== lhs.name || !lhs.name || declared.has(lhs.name)) {
          continue;
        }
        declared.add(lhs.name);
        mod.decls.push({
          name: lhs.name,
          dataType: { t: 'nets' },
          kind: 'net',
          range: lhs.range,
          nameRange: lhs.range,
          implicit: true,
        });
      }
    }
  }

  /**
   * True when `name` is a typedef declared anywhere in this file - the shape of
   * `pkg::b_t x;`, where the reference collected for the type is the bare name.
   */
  private isTypeNameInFile(name: string): boolean {
    if (this.fileTypedefs.some((d) => d.name === name)) {
      return true;
    }
    return this.modules.some((m) => m.decls.some((d) => d.name === name && d.kind === 'typedef'));
  }

  /**
   * Kind of a `pkg::NAME` reference, taken from the package of this file. Names
   * Verilog scopes by name alone (parameters, typedefs, functions) are the ones
   * that can appear in a scope-qualified reference, so those are all that is
   * needed to colour a package constant like the rest of the file.
   */
  private classifyScopeQualified(r: RefSite): RefSite['kind'] | undefined {
    const i = r.fullPath.indexOf('::');
    if (i < 0) {
      return undefined;
    }
    const pkg = r.fullPath.slice(0, i);
    const name = r.fullPath.slice(i + 2);
    for (const m of this.modules) {
      if (m.name !== pkg) {
        continue;
      }
      if (m.params.some((p) => p.name === name)) {
        return 'param';
      }
      const d = m.decls.find((x) => x.name === name);
      if (d) {
        return d.kind === 'typedef' ? 'type' : 'signal';
      }
      if (m.funcs.some((f) => f.name === name)) {
        return 'function';
      }
      return undefined;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Index just past the end of the current statement: the next `;` at bracket
   * depth 0, or a block closer at depth 0, or the cursor end.
   */
  private statementEnd(c: Cursor): number {
    const toks = this.toks;
    let depth = 0;
    for (let k = c.pos; k < c.end; k++) {
      const t = toks[k];
      if (t.text === '(' || t.text === '[' || t.text === '{') {
        depth++;
        continue;
      }
      if (t.text === ')' || t.text === ']' || t.text === '}') {
        if (depth === 0) {
          return k;
        }
        depth--;
        continue;
      }
      if (t.kind === 'keyword' && BLOCK_CLOSERS.has(t.text) && depth === 0) {
        return k;
      }
      if (t.kind === 'keyword' && (t.text === 'endmodule' || t.text === 'endinterface' || t.text === 'endprogram' || t.text === 'endpackage' || t.text === 'endclass') && depth === 0) {
        return k;
      }
      if (t.text === ';' && depth === 0) {
        return k + 1;
      }
    }
    return c.end;
  }

  private skipStatement(c: Cursor): boolean {
    c.pos = this.statementEnd(c);
    return true;
  }
}

/**
 * The name a statement starts with, keeping a package qualifier: `p::b_t`
 * instead of `p`. `tokens` is how many tokens the name spans, which is what a
 * caller walking the token stream needs; `text` is undefined when the token at
 * `i` is not a plain name, the caller's signal to leave the construct alone.
 */
function qualifiedNameAt(toks: Token[], i: number, to: number): { text: string; tokens: number } {
  if (toks[i]?.kind !== 'ident') {
    return { text: '', tokens: 0 };
  }
  if (i + 2 < to && toks[i + 1]?.text === '::' && toks[i + 2]?.kind === 'ident') {
    return { text: `${toks[i].text}::${toks[i + 2].text}`, tokens: 3 };
  }
  return { text: toks[i].text, tokens: 1 };
}

function isTypeStart(toks: Token[], i: number): boolean {
  const t = toks[i];
  if (!t || t.kind !== 'keyword') {
    return false;
  }
  return SCALAR_KEYWORDS.has(t.text) || NET_KEYWORDS.has(t.text) ||
    t.text === 'reg' || t.text === 'logic' || t.text === 'bit' || t.text === 'type';
}

export function parseSource(file: string, source: string): ParseResult {
  return new Parser().parse(file, source);
}

export { matchesClose };
