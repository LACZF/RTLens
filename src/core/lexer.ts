/**
 * Verilog / SystemVerilog lexer.
 *
 * Zero-dependency, single pass, allocation conscious. The lexer never throws:
 * on an unexpected character it emits a `punct` token so that the structural
 * parser can keep going. This is deliberate - the extension runs on
 * half-written files.
 */

export interface Pos {
  /** 0-based line */
  line: number;
  /** 0-based character offset */
  character: number;
}

export interface Range {
  start: Pos;
  end: Pos;
}

export type TokenKind =
  | 'ident'
  | 'keyword'
  | 'number'
  | 'string'
  | 'punct'
  | 'directive'
  | 'macroRef'
  | 'attribute'
  | 'comment'
  | 'eof';

export interface Token {
  kind: TokenKind;
  text: string;
  range: Range;
  /** For `directive`: the directive name without the backtick (`ifdef). */
  name?: string;
  /** For `comment`: true for `//`, false for block comments. */
  isLineComment?: boolean;
  /** For `number`: the base char (b,o,d,h) if it was a based literal. */
  base?: string;
  /** For `number`: the declared width if it was a sized literal. */
  width?: number;
}

export interface LexOptions {
  /** Keep `//` and `/* *\/` tokens in the stream. Default false. */
  keepComments?: boolean;
}

/** Keywords recognised for colouring / structural decisions. */
export const KEYWORDS = new Set<string>([
  // module / compilation unit
  'module', 'macromodule', 'endmodule', 'primitive', 'endprimitive', 'config',
  'endconfig', 'library', 'endlibrary', 'package', 'endpackage', 'import',
  'export', 'timeunit', 'timeprecision', 'extern', 'pure', 'virtual',
  'interface', 'endinterface', 'modport', 'program', 'endprogram', 'class',
  'endclass', 'clocking', 'endclocking', 'checker', 'endchecker', 'covergroup',
  'endgroup', 'coverpoint', 'cross', 'dist', 'constraint', 'endconstraint',
  'bind', 'alias', 'let', 'nettype', 'dpi', 'import', 'context', 'checker',
  // ports / directions
  'input', 'output', 'inout', 'ref',
  // net / variable types
  'wire', 'tri', 'tri0', 'tri1', 'triand', 'trior', 'trireg', 'wand', 'wor',
  'supply0', 'supply1', 'uwire', 'interconnect',
  'reg', 'logic', 'bit', 'byte', 'int', 'longint', 'shortint', 'integer',
  'time', 'real', 'shortreal', 'realtime', 'string', 'chandle', 'event',
  'var', 'const', 'automatic', 'static', 'signed', 'unsigned', 'void',
  'type', 'typedef', 'enum', 'struct', 'union', 'packed', 'tagged', 'rand',
  'randc', 'net', 'property', 'sequence', 'ref', 'inout',
  // parameters
  'parameter', 'localparam', 'defparam', 'specparam',
  // procedural
  'always', 'always_comb', 'always_ff', 'always_latch', 'initial', 'final',
  'begin', 'end', 'fork', 'join', 'join_any', 'join_none', 'case', 'casex',
  'casez', 'endcase', 'default', 'if', 'else', 'for', 'foreach', 'while',
  'do', 'repeat', 'forever', 'break', 'continue', 'return', 'disable',
  'forkjoin', 'wait', 'wait_order', 'until', 'assert', 'assume', 'cover',
  'restrict', 'expect', 'priority', 'unique', 'unique0', 'randcase',
  'randsequence', 'with', 'inside', 'matches', 'iff', 'tagged', 'new', 'super',
  'this', 'null', 'solve', 'before',
  // continuous assignment / net forcing
  'assign', 'deassign', 'force', 'release', 'pull0', 'pull1', 'highz0', 'highz1',
  'strong0', 'strong1', 'weak0', 'weak1', 'small', 'medium', 'large', 'scalared',
  'showcancelled', 'noshowcancelled', 'pulsestyle_ondetect', 'pulsestyle_onevent',
  // functions
  'function', 'endfunction', 'task', 'endtask', 'forkjoin', 'void',
  // generate
  'generate', 'endgenerate', 'genvar',
  // specify / timing
  'specify', 'endspecify', 'specparam', 'table', 'endtable', 'posedge', 'negedge', 'edge',
  // classes / constraints / coverage
  'class', 'endclass', 'extends', 'implements', 'constraint', 'endconstraint',
  // class member access qualifiers. These are reserved words in IEEE 1800, and
  // without them here `protected function` / `local task` lex as identifiers,
  // so the body parser never sees a subroutine header and drops the method.
  'local', 'protected',
  'covergroup', 'endgroup', 'coverpoint', 'cross', 'bins', 'ignore_bins',
  'illegal_bins', 'wildcard', 'binsof', 'intersect', 'within', 'throughout',
  'first_match', 'accept_on', 'reject_on', 'sync_accept_on', 'sync_reject_on',
  'eventually', 's_eventually', 'global',
  // interface
  'modport', 'clocking', 'endclocking', 'defaultclocking', 'input', 'output',
  'inout', 'import', 'export',
  // directives that may appear as keywords
  'timeunit', 'timeprecision', 'small', 'medium', 'large',
]);

/**
 * Gate and UDP primitives. They are intentionally NOT keywords: a gate
 * instantiation looks exactly like a module instantiation, and the structural
 * parser wants to index it as one. The TextMate grammar colours them.
 */
export const GATE_KEYWORDS = new Set<string>([
  'and', 'nand', 'or', 'nor', 'xor', 'xnor', 'buf', 'not', 'bufif0', 'bufif1',
  'notif0', 'notif1', 'nmos', 'pmos', 'cmos', 'rnmos', 'rpmos', 'rcmos', 'tran',
  'rtran', 'tranif0', 'tranif1', 'rtranif0', 'rtranif1', 'pullup', 'pulldown',
]);

/** Keywords that introduce a new module-like scope. */
export const SCOPE_OPENERS = new Set<string>([
  'module', 'macromodule', 'interface', 'program', 'package', 'class', 'primitive',
]);

/** Keywords that close a module-like scope. */
export const SCOPE_CLOSERS = new Set<string>([
  'endmodule', 'endinterface', 'endprogram', 'endpackage', 'endclass',
  'endprimitive', 'endchecker', 'endclocking', 'endgroup',
]);

/** Directives handled specially by the lexer / parser. */
export const DIRECTIVE_KEYWORDS = new Set<string>([
  'define', 'undef', 'undefineall', 'ifdef', 'ifndef', 'else', 'elsif',
  'endif', 'include', 'timescale', 'default_nettype', 'resetall', 'celldefine',
  'endcelldefine', 'line', 'begin_keywords', 'end_keywords', 'pragma',
  'protect', 'endprotect', 'protected', 'endprotected', 'unconnected_drive',
  'nounconnected_drive', 'default_decay_time', 'default_trireg_strength',
  'delay_mode_distributed', 'delay_mode_path', 'delay_mode_unit', 'delay_mode_zero',
  'suppress_faults', 'nosuppress_faults', 'enable_portfaults',
  'disable_portfaults', 'accelerate', 'noaccelerate', 'autoexpand_vectornets',
  'expand_vectornets', 'noexpand_vectornets', 'remove_gatenames',
  'noremove_gatenames', 'remove_netnames', 'noremove_netnames', 'uselib',
  'switch', 'remove', 'noremove', 'timescale',
]);

// Character classification by code point. The hot loops (whitespace, identifier,
// number) used to run a regex test per character and concatenate a string per
// character in `advance`; on a multi-megabyte file that alone was the bulk of
// indexing and of the jump-table build. These compare integer codes instead.
const NL = 10;
function isIdPartCode(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
}
function isIdStartCode(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
}
function isSpaceCode(c: number): boolean {
  return c === 32 || c === 9 || c === 13 || c === 10 || c === 12;
}
function isDigitCode(c: number): boolean {
  return c >= 48 && c <= 57;
}
function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isHexCode(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
}

class Scanner {
  pos = 0;
  line = 0;
  col = 0;
  constructor(readonly src: string) {}

  get eof(): boolean {
    return this.pos >= this.src.length;
  }

  peek(offset = 0): string {
    const i = this.pos + offset;
    return i < this.src.length ? this.src[i] : '';
  }

  /** Advance `n` characters, tracking line/column. Allocates nothing. */
  advance(n = 1): void {
    const src = this.src;
    let end = this.pos + n;
    if (end > src.length) {
      end = src.length;
    }
    let line = this.line;
    let col = this.col;
    for (let i = this.pos; i < end; i++) {
      if (src.charCodeAt(i) === NL) {
        line++;
        col = 0;
      } else {
        col++;
      }
    }
    this.pos = end;
    this.line = line;
    this.col = col;
  }

  /** Advance one character and return it ('' at EOF). */
  eat(): string {
    const i = this.pos;
    if (i >= this.src.length) {
      return '';
    }
    const ch = this.src[i];
    this.pos = i + 1;
    if (ch === '\n') {
      this.line++;
      this.col = 0;
    } else {
      this.col++;
    }
    return ch;
  }

  /**
   * Consume while the code-point predicate holds. The text is recovered with a
   * single `slice` by `takeWhile`, so the discarded-result loops here allocate
   * nothing at all.
   */
  skipWhile(pred: (code: number) => boolean): void {
    const src = this.src;
    let pos = this.pos;
    let line = this.line;
    let col = this.col;
    while (pos < src.length) {
      const code = src.charCodeAt(pos);
      if (!pred(code)) {
        break;
      }
      if (code === NL) {
        line++;
        col = 0;
      } else {
        col++;
      }
      pos++;
    }
    this.pos = pos;
    this.line = line;
    this.col = col;
  }

  /** Consume while the predicate holds and return the consumed text. */
  takeWhile(pred: (code: number) => boolean): string {
    const start = this.pos;
    this.skipWhile(pred);
    return this.src.slice(start, this.pos);
  }
}

/**
 * Try to lex a number literal starting at the scanner position.
 * Returns the token text (caller must advance) or null if this is not a number.
 *
 * Handles:
 *   1234  1_000  1.5  1.5e-3  1e10
 *   4'b1010  8'hFF  'h1F  32'sd5  'b1  'sh1F
 *   '0 '1 'x 'z  10ns  1step
 */
function readNumber(s: Scanner): { text: string; base?: string; width?: number } | null {
  const start = s.pos;
  let width: number | undefined;
  let base: string | undefined;

  // Optional size: decimal digits (allow _ separators) followed by `'` or whitespace-then-'
  const sizeStart = s.pos;
  let sizeText = s.takeWhile((c) => isDigitCode(c) || c === 95);
  let sawSize = sizeText.length > 0;

  if (s.peek() === "'") {
    // Verilog-2001: size must be a plain decimal literal immediately before the tick.
    if (sawSize && /^_+$/.test(sizeText)) {
      s.pos = sizeStart;
      s.col -= sizeText.length;
      sizeText = '';
      sawSize = false;
    }
    s.advance();
    // Signedness marker.
    if (s.peek() === 's' || s.peek() === 'S') {
      s.advance();
    }
    // Optional whitespace between tick and base is illegal but tolerated.
    const b = s.peek().toLowerCase();
    if (b === 'b' || b === 'o' || b === 'd' || b === 'h') {
      s.advance();
      base = b;
      // Digits, possibly separated by whitespace (tolerated).
      const valid =
        b === 'b'
          ? (c: number) => c === 48 || c === 49 || c === 120 || c === 88 || c === 122 || c === 90 || c === 63 || c === 95
          : b === 'o'
            ? (c: number) => (c >= 48 && c <= 55) || c === 120 || c === 88 || c === 122 || c === 90 || c === 63 || c === 95
            : b === 'd'
              ? (c: number) => isDigitCode(c) || c === 120 || c === 88 || c === 122 || c === 90 || c === 63 || c === 95
              : (c: number) => isHexCode(c) || c === 120 || c === 88 || c === 122 || c === 90 || c === 63 || c === 95;
      s.skipWhile((c) => valid(c) || c === 95 || c === 63);
    } else {
      // Unbased unsized literal: '0 '1 'x 'z 'X 'Z
      s.skipWhile((c) => c === 48 || c === 49 || c === 120 || c === 88 || c === 122 || c === 90 || c === 95);
      base = 'u';
    }
    if (sawSize) {
      const n = parseInt(sizeText.replace(/_/g, ''), 10);
      if (Number.isFinite(n)) {
        width = n;
      }
    }
    return { text: s.src.slice(start, s.pos), base, width };
  }

  if (!sawSize) {
    s.pos = start;
    s.col -= sizeText.length;
    return null;
  }

  // Plain decimal / real / time literal.
  if (s.peek() === '.' && isDigit(s.peek(1))) {
    s.advance();
    s.skipWhile((c) => isDigitCode(c) || c === 95);
  }
  if (s.peek() === 'e' || s.peek() === 'E') {
    const save = { pos: s.pos, col: s.col };
    s.advance();
    if (s.peek() === '+' || s.peek() === '-') {
      s.advance();
    }
    if (isDigit(s.peek())) {
      s.skipWhile((c) => isDigitCode(c) || c === 95);
    } else {
      // Not an exponent after all (e.g. `4e` identifier-ish garbage).
      s.pos = save.pos;
      s.col = save.col;
    }
  }
  // Time units / strength suffixes: 10ns, 1step
  const unitMatch = /^(step|fs|ps|ns|us|ms|s)$/.exec(s.peek(3) + s.peek(2) + s.peek(1));
  if (unitMatch) {
    // Only treat as a time literal when the source cannot continue as an identifier.
    const nxt = s.peek(1 + unitMatch[0].length);
    if (!isIdPartCode(nxt.charCodeAt(0))) {
      s.advance(unitMatch[0].length);
    }
  }
  return { text: s.src.slice(start, s.pos) };
}

/** Lex the whole source into a token stream. Never throws. */
export function tokenize(src: string, opts: LexOptions = {}): Token[] {
  const s = new Scanner(src);
  const tokens: Token[] = [];
  const keepComments = opts.keepComments === true;

  const push = (kind: TokenKind, startPos: number, startLine: number, startCol: number, extra?: Partial<Token>) => {
    const text = src.slice(startPos, s.pos);
    const start: Pos = { line: startLine, character: startCol };
    const end: Pos = { line: s.line, character: s.col };
    if (extra === undefined) {
      // The common case (ident / keyword / punct): skip the object spread.
      tokens.push({ kind, text, range: { start, end } });
    } else {
      tokens.push({ kind, text, range: { start, end }, ...extra });
    }
  };

  while (!s.eof) {
    const startPos = s.pos;
    const startLine = s.line;
    const startCol = s.col;
    const ch = s.peek();

    // --- whitespace ---
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f') {
      s.skipWhile(isSpaceCode);
      continue;
    }

    // --- comments ---
    if (ch === '/' && s.peek(1) === '/') {
      s.skipWhile((c) => c !== NL);
      if (keepComments) {
        push('comment', startPos, startLine, startCol, { isLineComment: true });
      }
      continue;
    }
    if (ch === '/' && s.peek(1) === '*') {
      s.advance(2);
      while (!s.eof && !(s.peek() === '*' && s.peek(1) === '/')) {
        s.advance();
      }
      if (!s.eof) {
        s.advance(2);
      }
      push('comment', startPos, startLine, startCol, { isLineComment: false });
      continue;
    }

    // --- escaped identifier: \foo.bar  (terminated by whitespace) ---
    if (ch === '\\') {
      s.advance();
      s.skipWhile((c) => !isSpaceCode(c));
      push('ident', startPos, startLine, startCol);
      continue;
    }

    // --- compiler directives & macro references ---
    if (ch === '`') {
      s.advance();
      // `" `\`" : macro-expanded string
      if (s.peek() === '"') {
        s.advance();
        while (!s.eof && s.peek() !== '"' && s.peek() !== '\n') {
          if (s.peek() === '\\') {
            s.advance();
          }
          s.advance();
        }
        if (s.peek() === '"') {
          s.advance();
        }
        push('macroRef', startPos, startLine, startCol);
        continue;
      }
      if (s.peek() === '`' && s.peek(1) === '"') {
        s.advance(3);
        while (!s.eof && s.peek() !== '"' && s.peek() !== '\n') {
          if (s.peek() === '\\') {
            s.advance();
          }
          s.advance();
        }
        if (s.peek() === '"') {
          s.advance();
        }
        push('macroRef', startPos, startLine, startCol);
        continue;
      }
      if (s.peek() === '\\' || s.peek() === '"') {
        // Unterminated / unusual directive: skip the line.
        s.skipWhile((c) => c !== NL);
        push('directive', startPos, startLine, startCol, { name: 'unknown' });
        continue;
      }
      const name = s.takeWhile(isIdPartCode);
      if (name.length === 0) {
        // Lone backtick.
        push('punct', startPos, startLine, startCol);
        continue;
      }
      const lower = name.toLowerCase();
      if (DIRECTIVE_KEYWORDS.has(lower)) {
        // Directives are line oriented; `` `define `` bodies run to end of line.
        s.skipWhile((c) => c !== NL);
        push('directive', startPos, startLine, startCol, { name: lower });
      } else {
        // Macro reference such as `WIDTH or `ARGS(...)
        if (s.peek() === '(') {
          let depth = 0;
          do {
            const c = s.eat();
            if (c === '(') {
              depth++;
            } else if (c === ')') {
              depth--;
            } else if (c === '\n') {
              break;
            }
          } while (!s.eof && depth > 0);
        }
        push('macroRef', startPos, startLine, startCol, { name });
      }
      continue;
    }

    // --- attribute (* ... *) ---
    if (ch === '(' && s.peek(1) === '*' && s.peek(2) !== ')') {
      s.advance(2);
      while (!s.eof && !(s.peek() === '*' && s.peek(1) === ')')) {
        if (s.peek() === '\n') {
          break; // unterminated attribute
        }
        s.advance();
      }
      if (!s.eof && s.peek() === '*' && s.peek(1) === ')') {
        s.advance(2);
      }
      push('attribute', startPos, startLine, startCol);
      continue;
    }

    // --- string literal ---
    if (ch === '"') {
      s.advance();
      while (!s.eof && s.peek() !== '"') {
        if (s.peek() === '\n') {
          break; // unterminated
        }
        if (s.peek() === '\\') {
          s.advance();
        }
        s.advance();
      }
      if (s.peek() === '"') {
        s.advance();
      }
      push('string', startPos, startLine, startCol);
      continue;
    }

    // --- number literal ---
    if (isDigit(ch) || (ch === '\'' && /[bodhBODHsS01xXzZ]/.test(s.peek(1)))) {
      const num = readNumber(s);
      if (num) {
        push('number', startPos, startLine, startCol, { base: num.base, width: num.width });
        continue;
      }
    }

    // --- identifier / keyword ---
    if (isIdStartCode(ch.charCodeAt(0))) {
      const text = s.takeWhile(isIdPartCode);
      push(KEYWORDS.has(text) ? 'keyword' : 'ident', startPos, startLine, startCol);
      continue;
    }

    // --- operators / punctuation (3/2/1 char, longest match) ---
    const three = s.peek() + s.peek(1) + s.peek(2);
    const two = s.peek() + s.peek(1);
    const threeOps = ['===', '!==', '<<<', '>>>', '->>', '<<=', '>>=', '&&&'];
    const twoOps = ['==', '!=', '<=', '>=', '&&', '||', '<<', '>>', '**', '+=', '-=',
      '*=', '/=', '%=', '&=', '|=', '^=', '~^', '^~', '->', '=>', '::', '+:',
      '-:', '.*', '|->', '|=>'];
    if (threeOps.includes(three)) {
      s.advance(3);
      push('punct', startPos, startLine, startCol);
      continue;
    }
    if (twoOps.includes(two)) {
      s.advance(2);
      push('punct', startPos, startLine, startCol);
      continue;
    }
    s.advance();
    push('punct', startPos, startLine, startCol);
  }

  const endPos: Pos = { line: s.line, character: s.col };
  tokens.push({
    kind: 'eof',
    text: '',
    range: { start: endPos, end: { line: s.line, character: s.col } },
  });
  return tokens;
}

/** Token kinds that carry structural meaning (everything but trivia). */
export function isSignificant(t: Token): boolean {
  return t.kind !== 'comment' && t.kind !== 'eof';
}
