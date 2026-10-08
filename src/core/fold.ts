/**
 * Constant expression folder.
 *
 * Bit widths and port directions are only knowable if `WIDTH-1`, `$clog2(N)`
 * and friends can be evaluated. This is a small Pratt parser over the lexer
 * token stream; it deliberately stops at the first unknown identifier instead
 * of guessing, so callers can fall back to a conservative default and report
 * what could not be folded.
 */

import { tokenize, type Token, type Range } from './lexer';
import type { ConstExpr, ValueRange, DataType } from './ast';

export interface FoldScope {
  /** Parameter name -> value. */
  get(name: string): number | undefined;
  /**
   * Optional bit width of a named object. Enables `$bits(WIDTH)` and friends;
   * without it those calls simply fail to fold.
   */
  widthOf?(name: string): number | undefined;
  /**
   * The type a user-defined type name resolves to, so `byte_t data;` gets the
   * width of its typedef instead of one bit. Undefined when the name is not a
   * visible typedef, or when the typedef holds something the IR has no width
   * for (a struct) - the caller then falls back to one bit, as before.
   */
  typeOf?(name: string): DataType | undefined;
}

export class MapScope implements FoldScope {
  private m = new Map<string, number>();
  private w = new Map<string, number>();
  private ty = new Map<string, DataType | undefined>();
  private typeResolver: ((name: string) => DataType | undefined) | undefined;
  constructor(initial?: Record<string, number>) {
    if (initial) {
      for (const [k, v] of Object.entries(initial)) {
        this.m.set(k, v);
      }
    }
  }
  set(name: string, value: number): void {
    this.m.set(name, value);
  }
  setWidth(name: string, width: number): void {
    this.w.set(name, width);
  }
  /**
   * Answer `typeOf` from the declarations a module can actually see. Scopes are
   * cloned along the hierarchy, so a child installs its own resolver: the type
   * names in scope for a child's ports are the child's typedefs, not the
   * parent's - two modules may name the same type differently.
   */
  setTypeResolver(fn: (name: string) => DataType | undefined): void {
    this.typeResolver = fn;
    this.ty.clear();
  }
  typeOf(name: string): DataType | undefined {
    if (this.ty.has(name)) {
      return this.ty.get(name);
    }
    // Misses are remembered too: a name that is not a typedef stays not one.
    const t = this.typeResolver?.(name);
    this.ty.set(name, t);
    return t;
  }
  has(name: string): boolean {
    return this.m.has(name);
  }
  get(name: string): number | undefined {
    return this.m.get(name);
  }
  widthOf(name: string): number | undefined {
    return this.w.get(name);
  }
  entries(): IterableIterator<[string, number]> {
    return this.m.entries();
  }
  clone(): MapScope {
    const s = new MapScope();
    s.m = new Map(this.m);
    s.w = new Map(this.w);
    s.ty = new Map(this.ty);
    s.typeResolver = this.typeResolver;
    return s;
  }
}

export const EMPTY_SCOPE: FoldScope = { get: () => undefined };
export interface FoldResult {
  value?: number;
  params: string[];
  /** True when evaluation hit something it could not resolve. */
  partial: boolean;
}

const BINARY_PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '|': 3,
  '^': 4,
  '&': 5,
  '==': 6, '!=': 6, '===': 6, '!==': 6,
  '<': 7, '<=': 7, '>': 7, '>=': 7,
  '<<': 8, '>>': 8, '<<<': 8, '>>>': 8,
  '+': 9, '-': 9,
  '*': 10, '/': 10, '%': 10,
  '**': 11,
};

class ExprParser {
  private i = 0;
  readonly params: string[] = [];
  partial = false;

  constructor(
    private readonly toks: Token[],
    private readonly scope: FoldScope,
  ) {}

  private peek(offset = 0): Token {
    return this.toks[this.i + offset] ?? { kind: 'eof', text: '', range: EMPTY_RANGE };
  }

  private next(): Token {
    return this.toks[this.i++] ?? { kind: 'eof', text: '', range: EMPTY_RANGE };
  }

  private eat(text: string): boolean {
    if (this.peek().text === text) {
      this.i++;
      return true;
    }
    return false;
  }

  parse(): number | undefined {
    const v = this.parseTernary();
    if (v === undefined) {
      this.partial = true;
    }
    return v;
  }

  private parseTernary(): number | undefined {
    const cond = this.parseBinary(0);
    if (cond === undefined) {
      return undefined;
    }
    if (this.eat('?')) {
      const a = this.parseTernary();
      if (!this.eat(':')) {
        this.partial = true;
        return undefined;
      }
      const b = this.parseTernary();
      if (a === undefined || b === undefined) {
        this.partial = true;
        return undefined;
      }
      return cond ? a : b;
    }
    return cond;
  }

  private parseBinary(minPrec: number): number | undefined {
    let lhs = this.parseUnary();
    if (lhs === undefined) {
      return undefined;
    }
    for (;;) {
      const op = this.peek();
      if (op.kind === 'eof') {
        return lhs;
      }
      const prec = BINARY_PRECEDENCE[op.text];
      if (prec === undefined || prec < minPrec) {
        return lhs;
      }
      this.next();
      const rhs = this.parseBinary(prec + 1);
      if (rhs === undefined) {
        this.partial = true;
        return undefined;
      }
      lhs = this.applyBinary(op.text, lhs, rhs);
      if (lhs === undefined) {
        this.partial = true;
        return undefined;
      }
    }
  }

  private applyBinary(op: string, a: number, b: number): number | undefined {
    switch (op) {
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': return b === 0 ? undefined : Math.trunc(a / b);
      case '%': return b === 0 ? undefined : a % b;
      case '**': return a ** b;
      case '<<': return a << b;
      case '<<<': return a << b;
      case '>>': return a >> b;
      case '>>>': return a >> b;
      case '&': return a & b;
      case '|': return a | b;
      case '^': return a ^ b;
      case '~^':
      case '^~': return ~(a ^ b);
      case '&&': return (a !== 0 && b !== 0) ? 1 : 0;
      case '||': return (a !== 0 || b !== 0) ? 1 : 0;
      case '==': return a === b ? 1 : 0;
      case '!=': return a !== b ? 1 : 0;
      case '===': return a === b ? 1 : 0;
      case '!==': return a !== b ? 1 : 0;
      case '<': return a < b ? 1 : 0;
      case '<=': return a <= b ? 1 : 0;
      case '>': return a > b ? 1 : 0;
      case '>=': return a >= b ? 1 : 0;
      default:
        this.partial = true;
        return undefined;
    }
  }

  private parseUnary(): number | undefined {
    const t = this.peek();
    switch (t.text) {
      case '+':
        this.next();
        return this.parseUnary();
      case '-':
        this.next();
        {
          const v = this.parseUnary();
          return v === undefined ? undefined : -v;
        }
      case '!':
      case '~':
        this.next();
        {
          const v = this.parseUnary();
          if (v === undefined) {
            return undefined;
          }
          return t.text === '!' ? (v === 0 ? 1 : 0) : ~v;
        }
      case '&':
      case '~&':
      case '|':
      case '~|':
      case '^':
      case '~^':
      case '^~':
        this.next();
        {
          // Reduction operators.
          if (this.eat('{')) {
            let acc: number | undefined = undefined;
            let first = true;
            while (this.peek().kind !== 'eof' && !this.eat('}')) {
              if (this.eat(',')) {
                continue;
              }
              const v = this.parseTernary();
              if (v === undefined) {
                this.partial = true;
                return undefined;
              }
              if (first) {
                acc = v;
                first = false;
              } else {
                acc = this.applyBinary(t.text[0] === '~' ? t.text[1] : t.text, acc as number, v);
                if (acc === undefined) {
                  return undefined;
                }
              }
              if (this.peek().kind === 'eof') {
                break;
              }
            }
            if (acc === undefined) {
              this.partial = true;
              return undefined;
            }
            if (t.text[0] === '~') {
              return ~acc;
            }
            return acc;
          }
          const v = this.parseUnary();
          if (v === undefined) {
            return undefined;
          }
          if (t.text === '~&') { return v === 0 ? 1 : 0; }
          if (t.text === '~|') { return v !== 0 ? 1 : 0; }
          if (t.text === '~^' || t.text === '^~') { return ~v; }
          return v;
        }
      default:
        return this.parsePrimary();
    }
  }

  private parsePrimary(): number | undefined {
    const t = this.next();
    switch (t.kind) {
      case 'number':
        return literalValue(t);
      case 'string': {
        // Concatenation of byte values, e.g. "ab" -> 0x6162
        const inner = t.text.slice(1, -1);
        let acc = 0;
        for (const ch of inner) {
          acc = (acc << 8) | (ch.charCodeAt(0) & 0xff);
        }
        return acc;
      }
      case 'ident': {
        if (t.text.startsWith('$')) {
          return this.parseSystemCall(t.text);
        }
        const v = this.scope.get(t.text);
        if (v === undefined) {
          this.partial = true;
          return undefined;
        }
        this.params.push(t.text);
        return v;
      }
      case 'punct':
        if (t.text === '(') {
          const v = this.parseTernary();
          this.eat(')');
          return v;
        }
        if (t.text === '{') {
          return this.parseConcatOrRepl();
        }
        this.partial = true;
        return undefined;
      default:
        this.partial = true;
        return undefined;
    }
  }

  /** `$clog2(8)`, `$bits(WIDTH)`, ... */
  private parseSystemCall(name: string): number | undefined {
    if (!this.eat('(')) {
      this.partial = true;
      return undefined;
    }
    // `$bits(name)` is answerable from the type table.
    if (name === '$bits' || name === '$size' || name === '$left' || name === '$right' ||
        name === '$high' || name === '$low' || name === '$dimensions') {
      const argTok = this.peek();
      const width = this.scope.widthOf?.(argTok.text);
      if (width !== undefined && argTok.kind === 'ident' && this.peek(1)?.text === ')') {
        this.next();
        this.next();
        switch (name) {
          case '$bits': return width;
          case '$size': return width;
          case '$left': return width - 1;
          case '$right': return 0;
          case '$high': return width - 1;
          case '$low': return 0;
          case '$dimensions': return 1;
        }
      }
    }
    const args: number[] = [];
    if (this.peek().text !== ')') {
      for (;;) {
        const v = this.parseTernary();
        if (v === undefined) {
          this.partial = true;
          this.skipToCloseParen();
          return undefined;
        }
        args.push(v);
        if (this.eat(',')) {
          continue;
        }
        break;
      }
    }
    this.eat(')');
    const fn = SYSTEM_CONST_FNS[name];
    if (!fn) {
      this.partial = true;
      return undefined;
    }
    const v = fn(args);
    if (v === undefined) {
      this.partial = true;
    }
    return v;
  }

  private skipToCloseParen(): void {
    let depth = 0;
    while (this.peek().kind !== 'eof') {
      const t = this.next();
      if (t.text === '(') {
        depth++;
      } else if (t.text === ')') {
        if (depth === 0) {
          return;
        }
        depth--;
      }
    }
  }

  /** `{a, b, c}` concat or `{n{a}}` replication. */
  private parseConcatOrRepl(): number | undefined {
    // `{A, B}` is packed left to right, so shifting the accumulated value by 32
    // per element is an approximation - fine for `ADDR[15:0], 8'hff`. A string
    // literal is already the character codes of its bytes, and shifting those
    // by 32 invents a number no expression ever had (`{NAME, "-v"}` folded to
    // 2.7e16). Not a number is the honest answer.
    if (this.peek().kind === 'string') {
      this.partial = true;
      return undefined;
    }
    const first = this.parseTernary();
    if (first === undefined) {
      this.partial = true;
      return undefined;
    }
    if (this.peek().text === '{') {
      // replication { count { ... } }
      this.next();
      const inner = this.parseTernary();
      if (!this.eat('}')) {
        this.partial = true;
        return undefined;
      }
      while (!this.eat('}')) {
        if (this.peek().kind === 'eof') {
          this.partial = true;
          return undefined;
        }
        this.next();
      }
      if (inner === undefined) {
        return undefined;
      }
      let acc = 0;
      const n = Math.max(0, Math.min(first, 4096));
      for (let k = 0; k < n; k++) {
        acc = acc * 2 ** 32 + inner;
      }
      return acc;
    }
    let acc = first;
    while (this.eat(',')) {
      if (this.peek().kind === 'string') {
        this.partial = true;
        return undefined;
      }
      const v = this.parseTernary();
      if (v === undefined) {
        this.partial = true;
        return undefined;
      }
      acc = acc * 2 ** 32 + v;
    }
    this.eat('}');
    return acc;
  }
}

const EMPTY_RANGE: Range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 0 },
};

const SYSTEM_CONST_FNS: Record<string, (args: number[]) => number | undefined> = {
  $clog2: (a) => (a[0] <= 1 ? 0 : Math.ceil(Math.log2(a[0]))),
  $bits: (a) => (a.length === 1 ? 32 : undefined),
  $unsigned: (a) => a[0] >>> 0,
  $signed: (a) => a[0],
  $floor: (a) => Math.floor(a[0]),
  $ceil: (a) => Math.ceil(a[0]),
  $rtoi: (a) => Math.trunc(a[0]),
  $itor: (a) => a[0],
  $sqrt: (a) => Math.sqrt(a[0]),
  $ln: (a) => Math.log(a[0]),
  $log10: (a) => Math.log10(a[0]),
  $exp: (a) => Math.exp(a[0]),
  $pow: (a) => a[0] ** a[1],
  $countones: (a) => {
    let c = 0;
    let v = a[0] >>> 0;
    while (v) {
      c += v & 1;
      v >>>= 1;
    }
    return c;
  },
  $size: (a) => a[0],
  $left: (a) => a[0],
  $right: (a) => a[0],
  $high: (a) => a[0],
  $low: () => 0,
  $increment: (a) => a[0] + 1,
  $dimensions: () => 0,
  $unpacked_dimensions: () => 0,
};

/**
 * Evaluate a raw expression. Returns undefined when the value cannot be
 * determined. `params` lists the parameter names that were referenced.
 */
export function evalExpression(raw: string, scope: FoldScope = EMPTY_SCOPE): FoldResult {
  if (!raw || !raw.trim()) {
    return { params: [], partial: false };
  }
  const toks = tokenize(raw);
  if (toks.length <= 1) {
    return { params: [], partial: true };
  }
  const p = new ExprParser(toks, scope);
  const value = p.parse();
  return { value, params: [...new Set(p.params)], partial: p.partial || value === undefined };
}

/** Numeric literal value, honouring signedness of based literals. */
export function literalValue(t: Token): number | undefined {
  if (t.kind !== 'number') {
    return undefined;
  }
  const text = t.text.replace(/_/g, '');
  if (t.base === undefined) {
    const n = Number(text);
    return Number.isFinite(n) ? n : undefined;
  }
  if (t.base === 'u') {
    // '0 '1 'x 'z
    return text[0] === '1' ? 1 : 0;
  }
  const m = /^(?:\d+)?'?([sS])?([bodhBODH])([0-9a-fA-FxXzZ?]+)$/.exec(text);
  if (!m) {
    return undefined;
  }
  const signed = m[1] !== undefined;
  const base = m[2].toLowerCase();
  const digits = m[3];
  if (/[xXzZ?]/.test(digits)) {
    return undefined;
  }
  const radix = base === 'b' ? 2 : base === 'o' ? 8 : base === 'd' ? 10 : 16;
  let v = parseInt(digits, radix);
  if (!Number.isFinite(v)) {
    return undefined;
  }
  const width = t.width;
  if (width !== undefined && width > 0 && width < 32) {
    // Truncate to width, then sign extend if the literal is signed.
    const mask = (1 << width) - 1;
    v &= mask;
    if (signed && (v & (1 << (width - 1))) !== 0) {
      v -= 1 << width;
    }
  } else if (signed && width === undefined) {
    v = v | 0;
  }
  return v;
}

/** Fold an already-tokenised expression. */
export function evalTokenExpr(toks: Token[], scope: FoldScope = EMPTY_SCOPE): number | undefined {
  if (toks.length === 0) {
    return undefined;
  }
  const p = new ExprParser(toks, scope);
  return p.parse();
}

/** Normalise whitespace in a source expression for storage / display. */
export function normalizeExpr(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** Build a `ConstExpr` from a token range. */
export function exprFromTokens(toks: Token[], scope: FoldScope = EMPTY_SCOPE): ConstExpr {
  const raw = normalizeExpr(toks.map((t) => t.text).join(''));
  if (!raw) {
    return { raw: '' };
  }
  const r = evalExpression(raw, scope);
  const e: ConstExpr = { raw };
  if (r.value !== undefined) {
    e.value = r.value;
  }
  if (r.params.length) {
    e.params = r.params;
  }
  return e;
}

/** Number of bits represented by a value range such as `[7:0]` or `[15]`. */
export function rangeWidth(r: ValueRange | undefined, scope: FoldScope = EMPTY_SCOPE): number | undefined {
  if (!r) {
    return undefined;
  }
  // A bound is folded at parse time when the declaring scope was known. When it
  // was not (a port range referring to a module parameter, say), fold it here
  // against the scope the caller has.
  const msb = r.msb.value ?? evalExpression(r.msb.raw, scope).value;
  const lsb = r.lsb.value ?? evalExpression(r.lsb.raw, scope).value;
  if (msb === undefined || lsb === undefined) {
    return undefined;
  }
  return Math.abs(msb - lsb) + 1;
}

/** Bit width of a data type; `undefined` when not statically known. */
export function typeWidth(dt: { t: string } | undefined, scope: FoldScope = EMPTY_SCOPE): number | undefined {
  return foldTypeWidth(dt, scope, new Set());
}

function foldTypeWidth(
  dt: { t: string } | undefined,
  scope: FoldScope,
  seen: Set<string>,
): number | undefined {
  if (!dt) {
    return undefined;
  }
  const anyDt = dt as {
    range?: ValueRange;
    elem?: { t: string; range?: ValueRange };
    dims?: ValueRange[];
    name?: string;
  };
  switch (dt.t) {
    case 'scalar':
      if ((anyDt as { kind?: string }).kind === 'real' || (anyDt as { kind?: string }).kind === 'shortreal') {
        return 64;
      }
      if ((anyDt as { kind?: string }).kind === 'time') {
        return 64;
      }
      return 32;
    case 'logic':
    case 'nets': {
      const w = rangeWidth(anyDt.range, scope);
      return w ?? 1;
    }
    case 'user': {
      // A range written next to the type name still wins: `byte_t [3:0] x`.
      const w = rangeWidth(anyDt.range, scope);
      if (w !== undefined) {
        return w;
      }
      // Follow the typedef chain to the type that carries the width. `seen`
      // stops two typedefs naming each other (which the parser records happily
      // when neither name is visible where the other is declared) from
      // recursing forever; an unresolved or widthless type keeps the old
      // answer of one bit.
      const name = anyDt.name;
      if (name && !seen.has(name)) {
        seen.add(name);
        const target = scope.typeOf?.(name);
        if (target) {
          const inner = foldTypeWidth(target, scope, seen);
          if (inner !== undefined) {
            return inner;
          }
        }
      }
      return 1;
    }
    case 'array': {
      const inner = foldTypeWidth(anyDt.elem, scope, seen);
      let total = inner ?? 1;
      for (const d of anyDt.dims ?? []) {
        const n = rangeWidth(d, scope);
        if (n === undefined) {
          return undefined;
        }
        total *= n;
      }
      return total;
    }
    default:
      return undefined;
  }
}
