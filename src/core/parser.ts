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

import { tokenize, type Token, type Range, type Pos, GATE_KEYWORDS, KEYWORDS } from './lexer';
import type {
  AssignSite,
  CallSite,
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
  MacroDef,
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
  'randcase', 'randsequence', 'constraint', 'checker',
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
/** Keywords a call can follow directly without being a declaration header. */
const CALL_PREFIX_KEYWORDS = new Set<string>([
  'return', 'else', 'begin', 'end', 'initial', 'final', 'always', 'always_comb',
  'always_ff', 'always_latch', 'do', 'fork', 'join', 'join_any', 'join_none',
  'forever', 'repeat', 'wait', 'assert', 'assume', 'cover', 'restrict',
]);
/** Statements whose bracket holds a condition that is read, not assigned. */
const WAIT_KEYWORDS = new Set<string>(['wait', 'assert', 'assume', 'cover', 'restrict']);

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

/**
 * Stands for "directly inside a `generate ... endgenerate` region". A region has
 * no name of its own, so it is not a step of any hierarchical path - a
 * testbench writes `dut.wide.u`, not `dut.generate.wide.u` - but the marker is
 * kept so that a declaration in a region without a block label is still known
 * to live in a generate construct, which is what keeps a flattened copy of the
 * module from being written without it.
 */
const GENERATE_REGION = 'generate';

/** The generate path a nested block composes onto, ignoring the region marker. */
function parentGenerate(ctx: ParseContext): string | undefined {
  return ctx.generate && ctx.generate !== GENERATE_REGION ? ctx.generate : undefined;
}

/**
 * The label of a generate block that starts at `i`, as in `begin : wide`.
 *
 * A keyword is accepted as well as an identifier: the label only ever becomes a
 * step of a path, and a name that is a keyword in one tool's table
 * (`small`, `medium`, `strong`) is still the block's name to read. Dropping it
 * instead would leave the branch unlabelled, and the two branches of an if/else
 * holding an instance of the same name would share one path again.
 */
function labelOf(toks: Token[], i: number): string | undefined {
  if (toks[i]?.text === 'begin') {
    i++;
  }
  const label = toks[i]?.text === ':' ? toks[i + 1] : undefined;
  return label && (label.kind === 'ident' || label.kind === 'keyword') ? label.text : undefined;
}

/**
 * The token after a case item label or a statement label at `i`, or -1 when the
 * statement does not start with one.
 *
 * The label is an expression, not only a name: `2'd0:`, `S0:`, `S0, S1:` and
 * `default:` all write one. Reading only a name before the colon left the rest
 * of the label to be taken for a statement, and a branch was then consumed up
 * to its own semicolon - the statement inside it, and any declaration next to
 * it, with it.
 */
function labelEnd(toks: Token[], i: number, end: number): number {
  for (let k = i; k < end; k++) {
    const text = toks[k].text;
    if (text === '(' || text === '[' || text === '{') {
      const close = matchBracket(toks, k, end);
      if (close <= k) {
        return -1;
      }
      k = close;
      continue;
    }
    // A `?` is a ternary in the label, and an `=` or a `;` means this is a
    // statement of its own: no label to skip.
    if (text === '?' || text === '=' || text === ';') {
      return -1;
    }
    if (toks[k].kind === 'keyword' && (text === 'begin' || text === 'end' || text === 'endcase' ||
        text === 'fork' || text === 'join')) {
      return -1;
    }
    if (text === ':') {
      return k + 1;
    }
  }
  return -1;
}

const NO_SPACE_BEFORE = new Set([',', ';', ')', '[', ']', '}', '.', "'"]);
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

/** Index of the token that opens the bracket closed at `i` (toks[i] is the closer). */
function matchOpenBracket(toks: Token[], i: number, lower: number): number {
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const close = toks[i]?.text;
  const open = close ? pairs[close] : undefined;
  if (!open) {
    return -1;
  }
  let depth = 0;
  for (let k = i; k >= lower; k--) {
    const t = toks[k];
    if (t.text === close) {
      depth++;
    } else if (t.text === open) {
      depth--;
      if (depth === 0) {
        return k;
      }
    }
  }
  return -1;
}

/** True when the tokens at `i` are `.name`, a step along a hierarchical path. */
export function memberAccessFollows(toks: Token[], i: number): boolean {
  return toks[i]?.text === '.' && (toks[i + 1]?.kind === 'ident' || toks[i + 1]?.kind === 'keyword');
}

/** The text of the bracket group opened at `open` and closed at `close`. */
export function bracketText(toks: Token[], open: number, close: number): string {
  return `[${toks.slice(open + 1, close).map((t) => t.text).join('')}]`;
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
 * The index of the token that starts at `pos` inside `[from, to)`, or `from`
 * when there is none. A statement inside `if` or `for` starts with the keyword
 * that leads it, so the left-hand side of its assignment does not start where
 * the statement does.
 */
function tokenIndexAt(toks: Token[], from: number, to: number, pos: Pos): number {
  for (let k = from; k < to; k++) {
    if (toks[k].range.start.line === pos.line && toks[k].range.start.character === pos.character) {
      return k;
    }
  }
  return from;
}

/**
 * Split a token range on top-level separators: commas everywhere, semicolons
 * for the parts of a `for` head. A trailing `;` (left behind by
 * `statementEnd`) is trimmed so it never leaks into a value expression.
 */
export function splitTopLevel(toks: Token[], from: number, to: number, sep = ','): Slice[] {
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
    if (t.text === sep && depth === 0 && blockDepth === 0) {
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
/**
 * The references in a token list: every name that is read or written here, with
 * its qualified form kept whole (`pkg::NAME`, `u.g[0].q`) and its index names
 * listed as reads of their own. Pure in the tokens, so the index of a select is
 * read by the same rules as the expression around it.
 */
function collectRefList(toks: Token[], isWrite: boolean): RefSite[] {
  const out: RefSite[] = [];
  let i = 0;
  // `pkg::` in front of the current name: the package is a scope, not a use.
  let qualifier: Token | undefined;
  while (i < toks.length) {
    const t = toks[i];
    // Gate primitives (`and`, `or`, `not`, `buf`, ...) are reserved words to the
    // language but not in the keyword table, so they arrive here as
    // identifiers. A primitive shows itself by what follows: `and (o, a, b);` or
    // `and #(2) (o, a, b);`. Skipping every one of them instead - which is what
    // this used to do - made a signal that happens to be called `buf` a name
    // nobody could use: it was declared, and then every read and write of it
    // vanished, so the netlist called it unused and the graph dropped its edges.
    const isPrimitive = GATE_KEYWORDS.has(t.text) &&
      (toks[i + 1]?.text === '(' || toks[i + 1]?.text === '#');
    const usable =
      (t.kind === 'ident' || (t.kind === 'keyword' && !KEYWORDS.has(t.text))) && !isPrimitive;
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
    // A select that is not part of a path, e.g. the `[2]` of `buf[2]`. It used to
    // be dropped, so every consumer that asks how wide `base[select]` is was
    // handed the width of the whole net: `buf[2]` - one 8-bit row of a
    // `logic [3:0][7:0]` - was reported as the 32 bits of `buf`.
    let select = '';
    let endIdx = i;
    // Dotted suffix.
    let k = i + 1;
    for (;;) {
      if (toks[k]?.text === '[') {
        const close = matchBracket(toks, k, toks.length);
        if (close < 0) {
          break;
        }
        // `u.g_reg[0].regs` reads *through* one element of an array or of a
        // generate block, so the index is part of the path. Dropping it made
        // `g_reg[0].regs` and `g_reg[1].regs` the same reference: one name in
        // the Problems view, and one symbol as far as find-references and
        // rename are concerned, although they are different signals. An index
        // with no member access behind it is a plain select and stays out.
        if (memberAccessFollows(toks, close + 1)) {
          pathParts[pathParts.length - 1] += bracketText(toks, k, close);
        } else {
          // A chain of selects keeps the last one: that is the index whose
          // result the consumer is about.
          select = bracketText(toks, k, close);
        }
        // Whatever the index is written with is read by the reference: the
        // `WIDTH` in `bus[WIDTH].valid` is a real use of the parameter. On
        // the left of an assignment it is left out, because every entry of
        // an LHS is a signal that statement writes - `regs[i] <= d` writes
        // `regs` and only reads `i`, and listing the genvar there would
        // make the second array a written signal in the netlist.
        if (!isWrite) {
          out.push(...indexRefs(toks, k, close));
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
        select: select || undefined,
      });
    }
    i = Math.max(k, i + 1);
  }
  return out;
}

/**
 * References held by the index of an array or generate block, e.g. the `WIDTH`
 * in `bus[WIDTH].valid`. Only used for reads; see the call site for why the
 * index of a written name is left out.
 */
function indexRefs(toks: Token[], open: number, close: number): RefSite[] {
  return collectRefList(toks.slice(open + 1, close), false);
}



export class Parser {
  private toks: Token[] = [];
  private modules: ModuleDef[] = [];
  private includes: string[] = [];
  /** `` `define `` macros of the current file, in source order. */
  private macros: MacroDef[] = [];
  private file = '';
  /** Typedefs declared outside any module scope, in source order. */
  private fileTypedefs: VarDecl[] = [];
  /** Self-references to the file-scope typedefs, one set per file. */
  private fileTypedefRefs: RefSite[] = [];
  /** Members of a file-scope `typedef enum {...}`, shared like the type is. */
  private fileEnumParams: ParamDecl[] = [];
  /** Names of every design scope declared in this file, however late. */
  private scopeNames = new Set<string>();
  /** What kind of scope each of those names opens, from the same pass. */
  private scopeKinds = new Map<string, ModuleKind>();
  /** `import` statements at file scope: what every module in the file borrows. */
  private fileImports: ImportDecl[] = [];

  parse(file: string, source: string): ParseResult {
    const t0 = Date.now();
    this.file = file;
    this.modules = [];
    this.includes = [];
    this.macros = [];
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
      if (t.kind === 'keyword' && (t.text === 'function' || t.text === 'task')) {
        // Skip modifiers
        let k = c.pos;
        while (k < c.end && this.toks[k].kind === 'keyword' && MODIFIERS.has(this.toks[k].text)) k++;
        if (this.toks[k]?.text === 'function' || this.toks[k]?.text === 'task') {
          // Look ahead for qualified name
          let p = k + 1;
          while (p < c.end && (this.toks[p].kind === 'keyword' && (MODIFIERS.has(this.toks[p].text) || this.toks[p].text === 'void'))) p++;
          // skip return type tokens roughly
          // find name
          let found = false;
          for (let x = p; x < Math.min(p + 20, c.end); x++) {
            if (this.toks[x].text === '::' && this.toks[x + 1]?.kind === 'ident') {
              found = true; break;
            }
          }
          if (found) {
            const dummy: ModuleDef = {
              name: '__rtlens_file__',
              kind: 'module',
              file: this.file,
              range: ZERO_RANGE,
              nameRange: ZERO_RANGE,
              portOrder: [],
              ports: [],
              params: [],
              decls: [],
              funcs: [],
              calls: [],
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
            this.parseFunction(c, dummy, ctx, false);
            continue;
          }
        }
      }
      if (t.kind === 'keyword' && (t.text === 'function' || t.text === 'task')) {
        const dummy: ModuleDef = {
          name: '__rtlens_file__',
          kind: 'module',
          file: this.file,
          range: ZERO_RANGE,
          nameRange: ZERO_RANGE,
          portOrder: [],
          ports: [],
          params: [],
          decls: [],
          funcs: [],
          calls: [],
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
        this.parseFunction(c, dummy, ctx, false);
        continue;
      }
      c.pos++;
    }

    this.shareFileTypedefs();
    const timeMs = Date.now() - t0;
    return {
      file,
      modules: this.modules,
      includes: this.includes,
      macros: this.macros,
      // A header has no module to hand its types to, so they travel with the
      // parse result and the index offers them to whoever includes the file.
      fileScoped: { decls: this.fileTypedefs, params: this.fileEnumParams },
      timeMs,
    };
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
      calls: [],
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
        // Remember which file declares it. Inside this file the module is the
        // owner, but a header's typedef stays in the header even after the
        // index lends it to the modules that include it, and a jump has to open
        // the file the `typedef` is written in.
        d.file = this.file;
        this.fileTypedefs.push(d);
      }
    }
    for (const p of sink.params) {
      p.file = this.file;
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
  /**
   * True when `name` opens an interface or class in this file. A header item
   * `my_if b` is a bus only when `my_if` is one of these: `my_t b` starts the
   * same way but is a variable of a user type.
   */
  private opensInterface(name: string): boolean {
    const kind = this.scopeKinds.get(name);
    return kind === 'interface' || kind === 'class';
  }

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
        this.scopeKinds.set(toks[k].text, SCOPE_OPENER_KEYWORD[t.text]);
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
    } else if (name === 'define') {
      // A `define is consumed whole by the lexer, so the macro name is carved
      // out of the directive text. The body is never expanded, but the name and
      // its extent are what a reference (`NAME) jumps to.
      const m = /`define\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(t.text);
      if (m) {
        const startChar = t.range.start.character + (m[0].length - m[1].length);
        this.macros.push({
          name: m[1],
          file: this.file,
          range: t.range,
          // The directive is line-oriented, so the name always sits on the
          // line the backtick starts on.
          nameRange: {
            start: { line: t.range.start.line, character: startChar },
            end: { line: t.range.start.line, character: startChar + m[1].length },
          },
          text: t.text,
        });
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
    let superClass: string | undefined;
    if (kind === 'class') {
      for (let k = headerStart; k < headerEnd; k++) {
        if (this.toks[k].text !== 'extends') {
          continue;
        }
        for (let j = k + 1; j < headerEnd; j++) {
          const n = this.toks[j];
          if (n.text === '#' || n.text === '(' || n.text === ')' || n.text === ',') {
            break;
          }
          if (n.kind === 'ident') {
            superClass = n.text;
          }
        }
        break;
      }
    }
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
      calls: [],
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
    if (superClass) {
      mod.superClass = superClass;
    }

    const headerSlices = this.splitHeader(headerStart, headerEnd);
    const scope = new MapScope();
    for (const ps of headerSlices.params) {
      const p = this.parseParamItem(ps.from, ps.to, mod, scope);
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
    this.dropUndeclaredGateRefs(mod);
    this.collectCalls(mod, bodyStart, bodyEnd);
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
        // The header list may hold parameters as well as ports, or only
        // parameters, with the ports in a second list: both
        // `module m (parameter int W = 8, input wire a, output wire y)` and
        // `module m (parameter int W = 8) (input wire a, output wire y)` are
        // legal, and `module m (a, b)` is a plain non-ANSI list. A parameter
        // item used to fall through to parseAnsiPort, which guessed it a
        // direction: the parameter became a phantom port and a diagnostic on
        // correct code.
        const portItems: Slice[] = [];
        for (const item of splitTopLevel(this.toks, i + 1, close)) {
          if (this.isParamItem(item)) {
            params.push(item);
          } else {
            portItems.push(item);
          }
        }
        if (portItems.length > 0) {
          ports = portItems;
          break;
        }
        i = close + 1;
        continue;
      }
      i++;
    }
    return { params, ports };
  }

  /** `parameter W = 8` / `localparam int W = 8` at the head of a list item. */
  private isParamItem(s: Slice): boolean {
    const t = this.toks[s.from];
    return t?.text === 'parameter' || t?.text === 'localparam';
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
        // An ident followed by `(` is a call, not a name, so `f(x)` in a
        // header is not read as a port called `f`. `.ext(in)` is skipped too:
        // the leading dot makes `ext` the header name, but the form is not
        // SystemVerilog, and guessing a direction for it would be a diagnostic
        // on input this parser cannot read.
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
    // `my_if b` in a header list: remember the type name so that a cross-file
    // interface can still be recognised once the whole index is known.
    let declaredType: string | undefined;
    for (let k = s.from; k < s.to; k++) {
      if (toks[k].kind === 'ident' && toks[k].text !== headerName) {
        declaredType = toks[k].text;
        break;
      }
    }
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
      declaredType,
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
      // `bus_if bus`, with the interface written bare. An interface port carries
      // no direction keyword, so the item gives itself away by starting with
      // the name of an interface or class in this file; anything else starting
      // with a name is a non-ANSI port or a variable of a user type.
      if (k === s.from && t.kind === 'ident' && this.opensInterface(t.text) &&
          (this.toks[k + 1]?.text === '.' || this.toks[k + 1]?.kind === 'ident')) {
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
    let t = c.cur()!;

    // Skip modifiers like static, virtual, automatic, extern, protected, local, pure
    if (t.kind === 'keyword' && (MODIFIERS.has(t.text) || t.text === 'extern' || t.text === 'pure')) {
      const startPos = c.pos;
      let accessQualified = false;
      let memberQualified = false;
      let sawExternOrPure = false;
      while (t && t.kind === 'keyword' && (MODIFIERS.has(t.text) || t.text === 'extern' || t.text === 'pure')) {
        if (t.text === 'local' || t.text === 'protected') {
          accessQualified = true;
        }
        if (mod.kind === 'class' && (t.text === 'rand' || t.text === 'randc')) {
          memberQualified = true;
        }
        if (t.text === 'extern' || t.text === 'pure') {
          sawExternOrPure = true;
        }
        c.pos++;
        t = c.cur()!;
      }
      if (t && t.kind === 'keyword' && (t.text === 'function' || t.text === 'task')) {
        // For class/package methods (especially extern) parse as function/task block
        if (mod.kind === 'class' || mod.kind === 'package' || sawExternOrPure) {
          return this.parseFunction(c, mod, ctx, isPackage);
        }
        return this.parseBlock(c, mod, ctx, isPackage);
      }
      // `local int x;` / `protected foo_t x;` / `rand bit [7:0] x;` are member
      // declarations, not a statement to skip: keep the cursor past the
      // qualifier so the declaration below records the name. Other modifiers
      // (`ref`, `unique`) belong to constructs handled after the reset.
      if (!accessQualified && !memberQualified) {
        c.pos = startPos;
        t = c.cur()!;
      }
    }

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
    let t = c.cur()!;

    if (t.kind === 'keyword' && t.text === 'generate') {
      const close = matchBlock(toks, c.pos, c.end);
      this.parseBody(c.slice(c.pos + 1, close), mod, { ...ctx, generate: ctx.generate ?? GENERATE_REGION }, isPackage);
      c.pos = Math.min(close + 1, c.end);
      return true;
    }

    // Skip modifiers like static, virtual, automatic, extern, protected, local
    if (t.kind === 'keyword' && (MODIFIERS.has(t.text) || t.text === 'extern' || t.text === 'pure')) {
      c.pos++;
      t = c.cur()!;
      // Could be multiple modifiers
      while (t && t.kind === 'keyword' && (MODIFIERS.has(t.text) || t.text === 'extern' || t.text === 'pure')) {
        c.pos++;
        t = c.cur()!;
      }
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
      // `begin : wide` names the block. The name is part of the hierarchical
      // path, so it belongs in the generate path of everything inside: with
      // two branches of a generate if both holding an instance named `u`, the
      // labels are the only thing that tells `wide.u` and `narrow.u` apart.
      // Dropping them put both at `d.u`, one shadowing the other in the
      // hierarchy, and a testbench reading `dut.narrow.u.K` found nothing.
      let bodyFrom = c.pos + 1;
      // The condition of a generate `if`, and the selector of a generate
      // `case`, are expressions over the module's own names: `if (WIDTH > 8)`
      // uses the parameter `WIDTH`. They were skipped with the head of the
      // construct, so the only use of a parameter that gates a variant had no
      // reference, no highlight and nothing for find-references to find.
      if (toks[bodyFrom]?.text === '(') {
        const parenClose = matchBracket(toks, bodyFrom, close);
        if (parenClose > bodyFrom) {
          this.addReads(toks.slice(bodyFrom + 1, parenClose), mod, 'generate');
          bodyFrom = parenClose + 1;
        }
      }
      const label = labelOf(toks, bodyFrom);
      if (label) {
        bodyFrom += 2;
      }
      const branchCtx = this.blockCtx(ctx, label, t.text === 'if' || isCase);
      this.parseGenerateBody(c.slice(bodyFrom, close), mod, branchCtx, isPackage);
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
        // The `begin : name` wrapper is consumed here, label and all: handing
        // the body a `begin` that has already been named would read it as a
        // nested block and name the branch twice, `narrow.narrow`.
        const label = startsBlock ? labelOf(toks, next) : undefined;
        const bodyFrom = label ? next + 3 : next;
        this.parseGenerateBody(c.slice(bodyFrom, branchEnd), mod, this.blockCtx(ctx, label, true), isPackage);
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
  /**
   * The context for the body of a named generate block.
   *
   * The label is part of the hierarchical path, and nested blocks compose:
   * `begin : n` inside `for ... begin : g` is `g[0].n[0]`, which is what a
   * testbench writes to reach it. A loop body used to be named by its own label
   * alone, so the two `n[0]` copies of a nested block shared a name - two
   * different instances at one path, and two different declarations that
   * nothing could tell apart.
   */
  private blockCtx(ctx: ParseContext, label: string | undefined, conditional: boolean): ParseContext {
    const parent = parentGenerate(ctx);
    const named = label
      ? {
        ...ctx,
        generate: parent ? `${parent}.${label}` : label,
        genPrefix: ctx.genPrefix ? `${ctx.genPrefix}.${label}` : label,
      }
      : ctx;
    return { ...named, conditional: ctx.conditional ?? conditional };
  }

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
          // Match the block's `end` from the `begin` itself. `matchBlock` reads
          // the first closer when it starts on a non-opener, so starting after
          // the label (once `bodyStart` has been stepped past it) locked onto
          // the `end` of the first inner `always ... begin ... end` and cut the
          // rest of the loop body - the `assign` that followed a clocked block
          // was dropped whole.
          const innerClose = matchBlock(toks, bodyStart, bodyEnd);
          if (innerClose > bodyStart) {
            bodyEnd = innerClose;
          }
          // The label is consumed here: it names the iteration, and the block
          // itself would otherwise be read again as a nested block and name it
          // a second time, leaving the path as `g[0].g`.
          bodyStart += 3;
        } else if (toks[bodyStart]?.text === 'begin') {
          const innerClose = matchBlock(toks, bodyStart, bodyEnd);
          if (innerClose > bodyStart) {
            bodyEnd = innerClose;
          }
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

    if (loop!.inline && !mod.decls.some((d) => d.name === loop!.varName)) {
      // Nothing else declares it: `for (genvar i = 0; ...)` is the only place
      // the loop variable exists, and every use in the body needs a declaration
      // to resolve against.
      const at = loop!.varAt;
      mod.decls.push({
        name: loop!.varName,
        dataType: { t: 'scalar', kind: 'integer' },
        kind: 'genvar',
        range: rangeOf(toks, at, at + 1),
        nameRange: rangeOf(toks, at, at + 1),
      });
      mod.refs.push({
        name: loop!.varName,
        pathSuffix: '',
        fullPath: loop!.varName,
        range: rangeOf(toks, at, at + 1),
        isWrite: false,
        isDecl: true,
        kind: 'genvar',
      });
    }

    for (const value of iterations) {
      // `g[0]` for a loop at the top of a region, `g[0].n[1]` for one nested in
      // another. An unlabelled body still has to be told apart from its
      // siblings, so it keeps a positional name.
      const own = label ? `${label}[${value}]` : `[${value}]`;
      const named = label ? own : `gen[${value}]`;
      const iterCtx: ParseContext = {
        ...ctx,
        generate: parentGenerate(ctx) ? `${parentGenerate(ctx)}.${named}` : named,
        scope: ctx.scope.clone(),
        genPrefix: ctx.genPrefix ? `${ctx.genPrefix}.${own}` : own,
      };
      iterCtx.scope.set(loop!.varName, value);
      const before = mod.instances.length;
      this.parseGenerateBody(c.slice(bodyStart, bodyEnd), mod, iterCtx, isPackage);
      for (let k = before; k < mod.instances.length; k++) {
        // An instance of a nested block already carries the deeper path it was
        // found at - `g[0].n[0]`. Overwriting it with this loop's own prefix put
        // the two copies of a nested instantiation at one path in the hierarchy,
        // one shadowing the other.
        if (mod.instances[k].genPrefix === undefined) {
          mod.instances[k].genPrefix = iterCtx.genPrefix;
        }
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
  ): { varName: string; from: number; step: number; count: number; inline: boolean; varAt: number } | null {
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

    // `for (genvar i = 0; ...)` declares the loop variable in the header, which
    // is legal SystemVerilog and common in real code. Reading the loop stopped
    // at the keyword, so the body was never unrolled and nothing declared the
    // variable - every use of it inside came up undeclared.
    let varFrom = init.from;
    let inline = false;
    while (toks[varFrom] && (toks[varFrom].text === 'genvar' || toks[varFrom].text === 'int' ||
        toks[varFrom].text === 'integer' || toks[varFrom].text === 'logic')) {
      varFrom++;
      inline = true;
    }
    const varName = toks[varFrom]?.text;
    if (!varName || toks[varFrom]?.kind !== 'ident' || toks[varFrom + 1]?.text !== '=') {
      return null;
    }
    const scope = ctx.scope.clone();
    // A genvar may already be initialised elsewhere; the loop's own init wins.
    const fromExpr = toks[varFrom + 1]?.text === '='
      ? this.evalSimple(toks.slice(varFrom + 2, init.to), scope)
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
    return { varName, from: fromExpr, step: stepSize, count: Math.max(0, count), inline, varAt: varFrom };
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
      if (parsed.packedDims.length) {
        v.packedDims = parsed.packedDims;
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
    if (i < to && toks[i].kind === 'ident' && i + 1 < to) {
      const ifaceName = toks[i].text;
      const hasModport = toks[i + 1].text === '.' && toks[i + 2]?.kind === 'ident';
      // Without a modport the item is only an interface port when the name is
      // one: `my_t data` is a variable of a user type, not a bus.
      if (!hasModport && (toks[i + 1].kind !== 'ident' || !this.opensInterface(ifaceName))) {
        // fall through to the ordinary type-and-name parse
      } else {
      const modportName = hasModport ? toks[i + 2].text : undefined;
      const nameAt = hasModport ? i + 3 : i + 1;
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
    if (parsed.packedDims.length) {
      p.packed = parsed.packedDims;
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
    packedDims: ValueRange[];
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
    packedDims: ValueRange[];
    init?: ConstExpr;
  } | undefined {
    const toks = this.toks;
    let i = from;
    let signed: boolean | undefined;
    let packedRange: ValueRange | undefined;
    let base: DataType = { t: 'unknown' };
    const dims: ValueRange[] = [];
    const packedDims: ValueRange[] = [];
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

    // A range before the name is a packed dimension of the type
    // (`logic [3:0][7:0] w` is one 32-bit packed vector); a range after it is an
    // unpacked one (`wire [7:0] mem [0:3]` is four 8-bit elements). They went
    // into the same list, so the second packed range of a multi-dimensional
    // packed declaration was written out as if it were an array and after the
    // name: `wire [3:0] [7:0] w;` declares a different signal, and the width
    // helpers saw the first range and stopped there.
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
          (nameTok ? dims : packedDims).push(r);
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
      return { dataType: base, dims, packedDims, init };
    }
    void isTypeParam;
    return {
      dataType: base,
      name,
      nameTok,
      nameRange: nameTok.range,
      dims,
      packedDims,
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

  private parseParamItem(from: number, to: number, mod?: ModuleDef, scope?: MapScope): ParamDecl | undefined {
    const toks = this.toks;
    let i = from;
    let isLocal = false;
    while (i < to && toks[i].kind === 'keyword' && (toks[i].text === 'parameter' || toks[i].text === 'localparam')) {
      isLocal = toks[i].text === 'localparam';
      i++;
    }
    // The scope of the parameters seen so far, so a default can be written in
    // terms of an earlier one: `parameter int W = 8, L = W * 2`. Without it
    // `L` had no value, so its width, its hover text and any port range that
    // used it were all unknown.
    const ctx: ParseContext = { file: this.file, scope: scope ?? new MapScope(), inProcedural: false };
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
      const p = this.parseParamItem(it.from, it.to, mod, ctx.scope);
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

  /** A typedef or class visible in `mod`, including one from a package in this file. */
  private isTypedefName(mod: ModuleDef, name: string): boolean {
    if (mod.decls.some((d) => d.name === name && d.kind === 'typedef')) {
      return true;
    }
    if (this.fileTypedefs.some((d) => d.name === name)) {
      return true;
    }
    // A class-typed member (`my_env env;`) is a declaration just like a
    // typedef-typed one; classes are indexed before their members are parsed.
    if (this.scopeKinds.get(name) === 'class' ||
        this.modules.some((m) => m.name === name && m.kind === 'class')) {
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
        underlying: this.typedefUnderlying(start, nameIdx, end, ctx),
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
   * The type a `typedef` renames, so that a signal written with it has a width:
   * `typedef logic [7:0] byte_t;` makes `byte_t data;` 8 bits. The declared
   * name is the last ident, so everything before it describes the type - except
   * for an `enum` or `struct`/`union`, whose body holds commas and braces that
   * are not part of it.
   *
   * An enum with an implementation type keeps that type (`enum logic [1:0]`
   * is 2 bits); a plain `enum` is 32 bits wide because that is the base type the
   * language gives it, not a guess. A struct or union has no answer here: the
   * IR does not hold its members, so it stays undefined and the width falls
   * back to 1 rather than being invented.
   */
  private typedefUnderlying(start: number, nameIdx: number, end: number, ctx: ParseContext): DataType | undefined {
    const toks = this.toks;
    // The cursor may already sit past the `typedef` keyword.
    const from = toks[start]?.text === 'typedef' ? start + 1 : start;
    for (let k = from; k < nameIdx; k++) {
      const t = toks[k];
      if (t.kind === 'keyword' && (t.text === 'struct' || t.text === 'union')) {
        return undefined;
      }
      if (t.kind === 'keyword' && t.text === 'enum') {
        // The base type of the enum, which is what gives a signal written with
        // the enum type its width: `enum logic [1:0]` is 2 bits. The member
        // list is skipped - it holds commas that are not part of the type.
        let depth = 0;
        let bodyEnd = nameIdx;
        for (let j = k + 1; j < nameIdx; j++) {
          if (toks[j].text === '{') {
            depth++;
          } else if (toks[j].text === '}') {
            depth--;
            if (depth === 0) {
              bodyEnd = j;
              break;
            }
          }
        }
        const base = this.parseTypeAndNameInner(k + 1, bodyEnd, ctx);
        // A plain `enum` has no base type written down, and the language gives
        // it an int - 32 bits. That is a fact, not a guess, so it is recorded.
        return base?.dataType.t === 'unknown' ? { t: 'scalar', kind: 'integer' } : base?.dataType;
      }
    }
    // `typedef <type> <name>;` - the whole statement, so that a typedef of a
    // typedef (`typedef byte_t word_t;`) still names a type (the bare-ident
    // rule needs the declared name to follow the type) and so that dimensions
    // written after the name (`typedef logic [15:0] wide_t [0:1];`) are part of
    // the type rather than dropped.
    const parsed = this.parseTypeAndNameInner(from, end, ctx);
    if (!parsed || parsed.dataType.t === 'unknown') {
      return undefined;
    }
    const dims = [...parsed.dims, ...parsed.packedDims];
    if (dims.length > 0) {
      return { t: 'array', elem: parsed.dataType, dims };
    }
    return parsed.dataType;
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
    // `statementEnd` reports a statement that ended in `;` as already past it,
    // and one that ended in `end`/`endcase` as sitting on that keyword. Stepping
    // one token on in both cases ate the token after the body of a
    // single-statement `always`, so a module-level `assign` that followed one
    // lost its keyword and was never read as an assignment: its left-hand side
    // looked undriven and the nets it read looked unused.
    c.pos = Math.min(toks[bodyEnd - 1]?.text === ';' ? bodyEnd : bodyEnd + 1, c.end);
    return true;
  }

  /**
   * Advance past the condition of `if`/`while`/`case`/`wait`, keeping the names
   * in it as reads.
   *
   * A signal that only ever gates a block is read by that block: with the
   * condition dropped on the floor, `if (en) q <= d;` left `en` with no reader
   * at all and the nets view called it unused, which is the mistake this view
   * exists to catch.
   */
  private skipCondition(c: Cursor, mod?: ModuleDef): void {
    if (c.at('(')) {
      const close = matchBracket(this.toks, c.pos, c.end);
      if (mod && close > c.pos) {
        this.addReads(this.toks.slice(c.pos + 1, close), mod, 'condition');
      }
      c.pos = close > 0 ? close + 1 : c.end;
    }
  }

  /** Read every name in `tokens` and record it on `mod` under `context`. */
  private addReads(tokens: Token[], mod: ModuleDef, context: 'event' | 'condition' | 'generate'): void {
    for (const ref of this.collectRefs(tokens, false)) {
      ref.context = context;
      mod.refs.push(ref);
    }
  }

  /**
   * The head of a `for`: `int i = 0` declares the loop variable, every later
   * part is read, and the first part is a write when it is not a declaration.
   */
  private parseForHeader(c: Cursor, mod: ModuleDef, ctx: ParseContext): void {
    if (!c.at('(')) {
      return;
    }
    const toks = this.toks;
    const close = matchBracket(toks, c.pos, c.end);
    const items = splitTopLevel(toks, c.pos + 1, close, ';');
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (i === 0 && it.to > it.from) {
        const kind = this.proceduralDeclKind(mod, new Cursor(toks, it.from, it.to));
        if (kind) {
          this.parseVarDeclaration(new Cursor(toks, it.from, it.to), mod, ctx,
            kind === 'user' ? 'reg' : kind, kind === 'user');
          continue;
        }
      }
      if (i > 0) {
        this.addReads(toks.slice(it.from, it.to), mod, 'condition');
      }
    }
    c.pos = close > 0 ? close + 1 : c.end;
  }

  /**
   * The head of a `foreach`: what stands in front of the first bracket is the
   * array the loop walks, and every name inside the brackets is a variable of
   * the loop, declared by the loop itself.
   *
   * `foreach (mem.bank[i, j])` reads `mem.bank` and declares `i` and `j`, so
   * neither half can be read the way the other one is.
   */
  private parseForeachHeader(c: Cursor, mod: ModuleDef, ctx: ParseContext): void {
    if (!c.at('(')) {
      return;
    }
    const toks = this.toks;
    const close = matchBracket(toks, c.pos, c.end);
    let k = c.pos + 1;
    while (k < close && toks[k].text !== '[') {
      k++;
    }
    this.addReads(toks.slice(c.pos + 1, k), mod, 'condition');
    while (k < close) {
      if (toks[k].text !== '[') {
        k++;
        continue;
      }
      const inner = matchBracket(toks, k, close);
      for (const name of splitTopLevel(toks, k + 1, inner)) {
        if (name.to > name.from && toks[name.from].kind === 'ident') {
          this.parseVarDeclaration(new Cursor(toks, name.from, name.to), mod, ctx, 'integer');
        }
      }
      k = inner > k ? inner : k + 1;
    }
    c.pos = close > 0 ? close + 1 : c.end;
  }

  /**
   * The variable kind of a declaration at the cursor inside a procedural block,
   * or undefined when the statement is not a declaration. A keyword type is
   * unambiguous; `user` is a typedef name, and the caller parses it as a type.
   */
  private proceduralDeclKind(mod: ModuleDef, c: Cursor): VarKind | 'user' | undefined {
    const t = c.cur();
    if (!t) {
      return undefined;
    }
    if (t.kind === 'keyword') {
      if (t.text === 'var' || t.text === 'const') {
        // `var logic t;` / `const int c = 1;`: the real type is the next word.
        const next = c.peek(1);
        return next?.kind === 'keyword' ? this.keywordVarKind(next.text) : 'reg';
      }
      return this.keywordVarKind(t.text);
    }
    // `state_t next;` - only when `state_t` is a type of this module or file.
    if (t.kind === 'ident' && this.isTypedefName(mod, t.text) && this.looksLikeDeclaration(c)) {
      return 'user';
    }
    return undefined;
  }

  private keywordVarKind(text: string): VarKind | undefined {
    switch (text) {
      case 'wire':
      case 'tri':
      case 'wand':
      case 'wor':
        return 'net';
      case 'reg':
      case 'logic':
      case 'bit':
      case 'var':
      case 'real':
      case 'shortreal':
      case 'realtime':
      case 'string':
        return 'reg';
      case 'int':
      case 'integer':
      case 'byte':
      case 'shortint':
      case 'longint':
      case 'time':
      // Only a generate loop may write this, and that is read elsewhere; a
      // procedural one is not legal, so the kind does not matter.
      case 'genvar':
        return 'integer';
      case 'event':
        return 'event';
      default:
        return undefined;
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
      // `begin : name`, and a statement label, name a block: they are not
      // signals. The scan of an `always` body starts right after its `begin`,
      // so the label arrived here as the head of a statement, and both the
      // label and the declaration that followed it were lost - the label was
      // reported as an undeclared name, and the uses of the local variable
      // with it.
      if (t.text === ':' && (c.peek(1)?.kind === 'ident' || c.peek(1)?.kind === 'keyword')) {
        c.pos += 2;
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
        this.skipCondition(sub, mod);
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
        if (t.text === 'for') {
          this.parseForHeader(c, mod, ctx);
        } else if (t.text === 'foreach') {
          this.parseForeachHeader(c, mod, ctx);
        } else if (t.text !== 'do' && t.text !== 'forever' && t.text !== 'else') {
          this.skipCondition(c, mod);
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
      // A case item label or a statement label, in every form the grammar
      // allows: `2'd0:`, `S0:`, `S0, S1:`, `default:`.
      const afterLabel = labelEnd(toks, c.pos, c.end);
      if (afterLabel > c.pos) {
        c.pos = afterLabel;
        continue;
      }
      if (t.kind === 'keyword' && t.text === 'assign') {
        this.parseAssign(c, mod, ctx, false);
        continue;
      }
      if (t.kind === 'keyword' && WAIT_KEYWORDS.has(t.text)) {
        c.pos++;
        this.skipCondition(c, mod);
        continue;
      }
      // `logic t;` inside an `always` block declares a variable of the module:
      // it is not automatic, it can be read hierarchically, and every use of it
      // was reported as an undeclared name. Only a keyword type or a known
      // typedef is taken for a declaration, so `arr[i] = 0;` is not one.
      const declKind = this.proceduralDeclKind(mod, c);
      if (declKind) {
        this.parseVarDeclaration(c, mod, ctx, declKind === 'user' ? 'reg' : declKind, declKind === 'user');
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
        // The text of the sides is written for the generator, so it has to be
        // the assignment and not the statement around it: `q <= d;` after an
        // `if` used to report an empty left-hand side and `[i` for `q[i]`.
        const lhsFrom = site.lhs.length
          ? tokenIndexAt(toks, start, eq, site.lhs[0].range.start)
          : start;
        site.lhsText = prettyJoin(toks.slice(lhsFrom, trimSemi(toks, lhsFrom, eq)));
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
      if ((toks[k].kind === 'ident' || toks[k].text === 'new') && !MODIFIERS.has(toks[k].text)) {
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
    // Detect qualification Class::method
    let targetMod = mod;
    if (toks[nameIdx - 1]?.text === '::' && toks[nameIdx - 2]?.kind === 'ident') {
      const className = toks[nameIdx - 2].text;
      const found = this.modules.find((m) => m.name === className && m.file === this.file);
      if (found) {
        targetMod = found;
      }
    }

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
    // If method already declared in class, merge into existing declaration
    const existing = targetMod.funcs.find((x) => x.name === f.name && x.kind === f.kind);
    const func = existing ?? f;
    if (existing) {
      if (!existing.returnType && f.returnType) existing.returnType = f.returnType;
      if (existing.args.length === 0 && f.args.length > 0) existing.args = f.args;
      existing.range = f.range;
      existing.nameRange = f.nameRange;
    } else {
      targetMod.funcs.push(func);
    }
    targetMod.refs.push({
      name: func.name,
      pathSuffix: '',
      fullPath: func.name,
      range: func.nameRange,
      isWrite: false,
      isDecl: true,
      kind: 'function',
    });

    // Body: non-ANSI argument declarations, locals and the return expression.
    if (close > hdrEnd) {
      this.scanFunctionBody(new Cursor(toks, hdrEnd + 1, close), targetMod, func, localCtx, isPackage);
    }
    c.pos = Math.min(close + 1, c.end);
    return true;
  }

  private scanFunctionBody(c: Cursor, mod: ModuleDef, f: FunctionDecl, ctx: ParseContext, isPackage: boolean): void {
    const toks = this.toks;
    const procCtx: ParseContext = { ...ctx, inProcedural: true };
    // Everything this body adds is automatic, and a subprogram cannot contain
    // another one, so the whole of it is the range this body appends to. Marking
    // it once here beats threading a flag through every statement, loop head and
    // block the body can hold.
    const mark = { assigns: mod.assigns.length, decls: mod.decls.length };
    while (!c.done) {
      const t = c.cur()!;
      if (t.kind === 'attribute' || t.kind === 'directive' || t.text === ';') {
        c.pos++;
        continue;
      }
      if (t.kind === 'keyword' &&
          (DIR_KEYWORDS.has(t.text) || t.text === 'var' || this.keywordVarKind(t.text))) {
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
            // `var` names no type of its own: the word after it does.
            const typeWord =
              toks[it.from].text === 'var' ? toks[it.from + 1]?.text ?? 'logic' : toks[it.from].text;
            const v = this.parseVarDeclaration(c.slice(it.from, it.to), mod, procCtx,
              this.keywordVarKind(typeWord) ?? 'integer');
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
    for (const a of mod.assigns.slice(mark.assigns)) {
      a.local = true;
    }
    for (const d of mod.decls.slice(mark.decls)) {
      d.local = true;
    }
  }

  /**
   * Read a callee path starting at `start`: a name, an optional `#(...)`
   * parameter list, then any number of `::name` steps. The full path is kept
   * as written so call-hierarchy labels and package scoping see the qualifier;
   * the leaf index is where the call itself starts.
   */
  private qualifiedCallee(
    toks: Token[],
    start: number,
    to: number,
  ): { nameIdx: number; fullPath: string } | undefined {
    if (toks[start]?.kind !== 'ident') {
      return undefined;
    }
    let k = start;
    let nameIdx = start;
    let fullPath = toks[k].text;
    k++;
    for (;;) {
      if (toks[k]?.text === '#' && toks[k + 1]?.text === '(') {
        const close = matchBracket(toks, k + 1, to);
        if (close < 0) {
          break;
        }
        fullPath += `#${toks.slice(k + 1, close + 1).map((x) => x.text).join('')}`;
        k = close + 1;
      }
      if (toks[k]?.text !== '::' || toks[k + 1]?.kind !== 'ident') {
        break;
      }
      nameIdx = k + 1;
      fullPath += `::${toks[nameIdx].text}`;
      k = nameIdx + 1;
    }
    return { nameIdx, fullPath };
  }

  private collectCalls(mod: ModuleDef, from: number, to: number): void {
    const toks = this.toks;
    const declRanges = new Set(mod.funcs.map((f) => rangeKey(f.nameRange)));
    const tasks = new Set(mod.funcs.filter((f) => f.kind === 'task').map((f) => f.name));
    const seen = new Set<string>();
    if (!mod.calls) mod.calls = [];
    for (const c of mod.calls) {
      seen.add(`${c.callRange.start.line},${c.callRange.start.character},${c.name}`);
    }
    for (let i = from; i < to; i++) {
      const t = toks[i];
      if (t.kind !== 'ident' || t.text.startsWith('$')) {
        continue;
      }
      let nameIdx = i;
      let fullPath = t.text;
      const qualified = this.qualifiedCallee(toks, i, to);
      if (qualified && qualified.fullPath.includes('::')) {
        nameIdx = qualified.nameIdx;
        fullPath = qualified.fullPath;
      } else if (
        i - 2 >= from &&
        toks[i - 1]?.text === '.' &&
        (toks[i - 2]?.kind === 'ident' ||
          (toks[i - 2]?.kind === 'keyword' &&
            (toks[i - 2].text === 'this' || toks[i - 2].text === 'super')))
      ) {
        fullPath = `${toks[i - 2].text}.${t.text}`;
      }
      const nameTok = toks[nameIdx];
      if (declRanges.has(rangeKey(nameTok.range))) {
        continue;
      }
      const next = toks[nameIdx + 1];
      const bare = next?.text === ';';
      if (next?.text !== '(' && !bare) {
        continue;
      }
      if (this.isCallHeader(toks, i, from) || !this.callPositionAllowed(toks, i, from, bare)) {
        continue;
      }
      if (bare && !tasks.has(nameTok.text)) {
        continue;
      }
      let close = nameIdx;
      let argCount = 0;
      if (!bare) {
        close = matchBracket(toks, nameIdx + 1, to);
        if (close < 0) {
          continue;
        }
        argCount = splitTopLevel(toks, nameIdx + 2, close).length;
      }
      const owner = this.enclosingFunction(mod.funcs, nameTok.range.start);
      const site: CallSite = {
        name: nameTok.text,
        fullPath,
        range: nameTok.range,
        callRange: rangeOf(toks, i, close + 1),
        owner: owner?.name,
        ownerRange: owner?.range,
        argCount,
      };
      const key = `${site.callRange.start.line},${site.callRange.start.character},${site.name}`;
      if (seen.has(key)) {
        if (nameIdx !== i) i = nameIdx;
        continue;
      }
      seen.add(key);
      (mod.calls ??= []).push(site);
      if (owner) {
        (owner.calls ??= []).push(site);
      }
      if (nameIdx !== i) {
        i = nameIdx;
      }
    }
  }

  private isCallHeader(toks: Token[], start: number, lower: number): boolean {
    for (let k = start - 1; k >= lower && start - k <= 60; k--) {
      const t = toks[k];
      if (
        t.text === ';' || t.text === 'begin' || t.text === 'end' || t.text === 'else' ||
        t.text === ')' || t.text === '}' || t.text === ']' || t.text === ':' ||
        t.text === ',' || t.text === '='
      ) {
        return false;
      }
      if (
        t.kind === 'keyword' &&
        (t.text === 'function' || t.text === 'task' || t.text === 'module' ||
          t.text === 'macromodule' || t.text === 'interface' || t.text === 'program' ||
          t.text === 'package' || t.text === 'class' || t.text === 'primitive')
      ) {
        return true;
      }
    }
    return false;
  }

  private callPositionAllowed(toks: Token[], start: number, lower: number, bare: boolean): boolean {
    const prev = start > lower ? toks[start - 1] : undefined;
    if (!prev) {
      return true;
    }
    if (prev.kind === 'ident') {
      return false;
    }
    if (prev.kind === 'keyword') {
      // Allow calls after 'this' and 'super'
      if (prev.text === 'this' || prev.text === 'super') {
        return true;
      }
      return CALL_PREFIX_KEYWORDS.has(prev.text);
    }
    if (prev.text === '.' || prev.text === '.*') {
      // Allow method calls like obj.method() and this.method()
      const p2 = start - 2 >= lower ? toks[start - 2] : undefined;
      if (p2 && p2.kind === 'ident') {
        return true;
      }
      if (p2 && p2.kind === 'keyword' && (p2.text === 'this' || p2.text === 'super')) {
        return true;
      }
      return false;
    }
    if (prev.text === ')') {
      const open = matchOpenBracket(toks, start - 1, lower);
      if (open > lower + 1 && toks[open - 1]?.text === '#' && toks[open - 2]?.kind === 'ident') {
        return false;
      }
    }
    if (!bare) {
      return true;
    }
    return (
      prev.text === ';' || prev.text === 'begin' || prev.text === 'end' ||
      prev.text === 'else' || prev.text === ')' || prev.text === ':' ||
      prev.text === 'fork' || prev.text === 'join' || prev.text === 'join_any' ||
      prev.text === 'join_none'
    );
  }

  private enclosingFunction(funcs: FunctionDecl[], pos: Pos): FunctionDecl | undefined {
    let best: FunctionDecl | undefined;
    for (const f of funcs) {
      if (positionIn(f.range, pos) && (!best || rangeSpan(f.range) < rangeSpan(best.range))) {
        best = f;
      }
    }
    return best;
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
    return toks[k]?.text === ';' &&
      this.scopeNames.has(t0.text) &&
      this.scopeKinds.get(t0.text) !== 'class';
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
    return collectRefList(toks, isWrite);
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
   * Drop the references to a gate word that nothing declares.
   *
   * `and`, `or`, `not`, `buf` and the rest are reserved words that the lexer
   * leaves as identifiers. When one of them is *declared* - `wire buf;` in legacy
   * code, which the tool reads - every use of it is a real reference and has to
   * be recorded, or the netlist calls the signal unused and the graph drops its
   * edges. When it is not declared, the same token is the operator of
   * `assign y = a or b;` or the edge operator of `posedge clk or negedge rst`,
   * and there is no signal to point at.
   *
   * Which is which is only known once the whole module has been read, so this
   * runs at the end: a primitive instantiation (`and g1 (y, a, b);`) is
   * recognised where it is written - by the `(` or `#` that follows - and a bare
   * operator is settled here.
   */
  private dropUndeclaredGateRefs(mod: ModuleDef): void {
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
    const doomed = new Set<RefSite>();
    for (const r of mod.refs) {
      if (GATE_KEYWORDS.has(r.name) && !declared.has(r.name)) {
        doomed.add(r);
      }
    }
    if (!doomed.size) {
      return;
    }
    const keep = (refs: RefSite[]) => refs.filter((r) => !doomed.has(r));
    mod.refs = keep(mod.refs);
    for (const a of mod.assigns) {
      a.lhs = keep(a.lhs);
      a.rhs = keep(a.rhs);
    }
    for (const inst of mod.instances) {
      for (const c of inst.connections) {
        c.refs = keep(c.refs);
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

function positionIn(r: Range, p: Pos): boolean {
  const afterStart = p.line > r.start.line || (p.line === r.start.line && p.character >= r.start.character);
  const beforeEnd = p.line < r.end.line || (p.line === r.end.line && p.character <= r.end.character);
  return afterStart && beforeEnd;
}

function rangeSpan(r: Range): number {
  return (r.end.line - r.start.line) * 1_000_000 + (r.end.character - r.start.character);
}

function rangeKey(r: Range): string {
  return `${r.start.line}:${r.start.character}:${r.end.line}:${r.end.character}`;
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
