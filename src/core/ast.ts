/**
 * Intermediate representation for parsed HDL.
 *
 * Deliberately flat: no AST node objects, no token retention. Everything the
 * editor features need (declarations, references, instances, connections) is
 * stored as compact records keyed by name, which keeps the index small enough
 * to rebuild on every activation.
 */

import type { Range } from './lexer';

export type { Range, Pos } from './lexer';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScalarType = 'scalar' | 'integer' | 'real' | 'time' | 'string' | 'event' | 'chandle';

export type DataType =
  | { t: 'scalar'; kind: ScalarType; signed?: boolean; range?: ValueRange }
  | { t: 'logic'; signed?: boolean; range?: ValueRange }
  | { t: 'nets'; signed?: boolean; range?: ValueRange }
  | { t: 'array'; elem: DataType; dims: ValueRange[] }
  | { t: 'user'; name: string; range?: ValueRange }
  | { t: 'interface'; name: string; modport?: string }
  | { t: 'unknown' };

export interface ValueRange {
  msb: ConstExpr;
  lsb: ConstExpr;
}

export interface ConstExpr {
  /** Source text, whitespace-normalised. */
  raw: string;
  /** Folded integer value when the expression is statically evaluable. */
  value?: number;
  /** Parameter names referenced by the expression. */
  params?: string[];
}

export const UNKNOWN_EXPR: ConstExpr = { raw: '' };

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export type PortDir = 'input' | 'output' | 'inout' | 'ref';

export interface PortDecl {
  /** The name written in the module header / port list. */
  name: string;
  /** The internal net this port connects to (differs for `.ext(internal)`). */
  declName: string;
  direction: PortDir;
  dataType: DataType;
  /** Unpacked array dimensions, e.g. `data [0:3]`. */
  unpacked?: ValueRange[];
  /**
   * Packed dimensions of the type after the first, e.g. the `[7:0]` of
   * `input logic [3:0][7:0] a`. They belong to the type, so they are written out
   * before the name - the opposite of `unpacked`.
   */
  packed?: ValueRange[];
  isInterface?: boolean;
  interfaceName?: string;
  modport?: string;
  /** Declaration site. */
  range: Range;
  /** Identifier site - the jump target. */
  nameRange: Range;
  /** Generate construct this port sits in, if any (illegal, but parsed). */
  generate?: string;
  /** True when declared via the ANSI style `input logic [7:0] a`. */
  ansi: boolean;
  defaultValue?: ConstExpr;
  /** True when the direction could not be found and `input` was assumed. */
  guessDir?: boolean;
  /**
   * The type name written in front of this port in the module header, e.g.
   * `my_if` in `module m (my_if b);`. Only the *placeholder* that the header
   * list starts out with carries it: the parser cannot know whether `my_if`
   * opens an interface in this file, and by the time the index has the whole
   * workspace the answer is the difference between "your direction is a guess"
   * and "an interface port has no direction of its own".
   */
  declaredType?: string;
}

// ---------------------------------------------------------------------------
// Parameters, variables, functions
// ---------------------------------------------------------------------------

export interface ParamDecl {
  name: string;
  dataType: DataType;
  value?: ConstExpr;
  isLocal: boolean;
  /** Generate construct this parameter sits in, if any. */
  generate?: string;
  /** `parameter type T = int;` */
  isType: boolean;
  range: Range;
  nameRange: Range;
  /**
   * The file that declares it, when that is not the module's own file: an enum
   * member of a typedef written in a header the module includes. See
   * `VarDecl.file`.
   */
  file?: string;
}

export type VarKind =
  | 'net'
  | 'reg'
  | 'integer'
  | 'genvar'
  | 'typedef'
  | 'event'
  | 'specparam'
  | 'unknown';

export interface VarDecl {
  name: string;
  dataType: DataType;
  kind: VarKind;
  range: Range;
  nameRange: Range;
  /**
   * The file that declares it, for a declaration the file does not own: a
   * `typedef` at file scope belongs to that file even once the index has lent
   * it to every module that `` `include ``s it. Undefined for a declaration
   * written inside the module, which then is the file.
   */
  file?: string;
  /**
   * For a typedef, the type it renames: `logic [7:0]` in
   * `typedef logic [7:0] byte_t;`. `dataType` of a typedef names the typedef
   * itself, so without this `byte_t data;` has no width to compute. Undefined
   * when the underlying type is not something the IR holds - a struct's
   * members, a plain `enum` (whose base is 32 bits is recorded instead).
   */
  underlying?: DataType;
  init?: ConstExpr;
  /** Unpacked array dimensions, e.g. `mem [0:3]`. */
  dims?: ValueRange[];
  /**
   * Packed dimensions of the type after the first, e.g. the `[7:0]` of
   * `logic [3:0][7:0] buf`. They belong to the type and are written out before
   * the name, unlike `dims`.
   */
  packedDims?: ValueRange[];
  /**
   * Set for a net the parser created instead of reading: an implicit wire from a
   * continuous assignment, or a constant-width alias for an undeclared port. The
   * language gives the copy of a design the same declaration on its own, so the
   * generator leaves these out instead of writing them twice.
   */
  implicit?: boolean;
  /** Generate construct this declaration sits in, if any. */
  generate?: string;
  /**
   * Declared inside a function or task body. Such a variable is automatic: it
   * exists for the duration of one call, nobody outside can name it, and it is
   * not a signal of the module. It is kept here so that the names in the body
   * can be classified, and marked so that the netlist, the graph and the
   * generator leave it alone.
   */
  local?: boolean;
}

export interface FunctionDecl {
  name: string;
  kind: 'function' | 'task';
  returnType?: DataType;
  args: PortDecl[];
  range: Range;
  nameRange: Range;
  /** Set when the body was a simple `return expr;` we could fold. */
  returnExpr?: ConstExpr;
  /**
   * Calls written in this subroutine's body (and, for a function, its header),
   * in source order. Kept on the declaration as well as on the module so a
   * caller/callee walk never has to re-scan tokens.
   */
  calls?: CallSite[];
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

export type RefKind = 'signal' | 'module' | 'param' | 'function' | 'genvar' | 'type' | 'interface' | 'unknown';

export interface RefSite {
  /** Simple identifier, without array/bit selects. */
  name: string;
  /**
   * Dotted suffix as written in the source, e.g. `u_alu.result` for the
   * reference `u_alu.result`. Empty when the reference is a bare name.
   */
  pathSuffix: string;
  /** Full dotted text including `name`, used for hierarchical matching. */
  fullPath: string;
  range: Range;
  /** Inside an assignment LHS or an output-port connection. */
  isWrite: boolean;
  isDecl: boolean;
  /** Array/bit select text that followed the name, e.g. `[3:0]`, `[7]`. */
  select?: string;
  kind: RefKind;
  /**
   * Inside a `bind` statement, where the names are written in the target
   * module's scope rather than the one the statement sits in, so they must not
   * be reported as undeclared here.
   */
  bind?: boolean;
  /**
   * A system identifier (`$clog2`, `$signed`, ...). Never declared anywhere, but
   * still worth a token and worth distinguishing from a plain unresolved name.
   */
  system?: boolean;
  /**
   * Set when the surrounding construct is not visible from the reference
   * itself: the signals of `@(posedge clk)` are read by the block, not assigned
   * by it, and there is no assignment site to attribute them to. The same holds
   * for a condition: a name that only ever gates a block is read by it. A
   * generate `if`/`case` is its own case, because the name is read while the
   * design is elaborated rather than while it runs.
   */
  context?: 'event' | 'condition' | 'generate';
  /** Inside a function or task body: an automatic variable, not a signal. */
  local?: boolean;
}

/**
 * A call to a function or task. `range` covers the callee name, so a trace and
 * a call-hierarchy item land on the name rather than on the whole argument
 * list; `callRange` keeps the full expression for displays.
 */
export interface CallSite {
  /** Callee leaf name, e.g. `check`. */
  name: string;
  /** Callee as written, including a package qualifier: `pkg::check`. */
  fullPath: string;
  /** Range of the callee name. */
  range: Range;
  /** Whole call, arguments included. */
  callRange: Range;
  /** Enclosing subroutine, absent when the call sits at module scope. */
  owner?: string;
  /** Declaration range of `owner`, to disambiguate same-named subroutines. */
  ownerRange?: Range;
  /** Top-level argument count. */
  argCount: number;
}

// ---------------------------------------------------------------------------
// Instances & connectivity
// ---------------------------------------------------------------------------

export interface PortConn {
  /** Port being connected (named connection `.port(expr)`). */
  portName: string;
  /** The connection expression, tokenised into references. */
  refs: RefSite[];
  rawExpr: string;
  range: Range;
  nameRange: Range;
  /** True for `.p()` - declared but left unconnected. */
  empty: boolean;
  /** True for implicit `.name` shorthand (SystemVerilog). */
  shorthand: boolean;
}

export interface InstanceSite {
  name: string;
  /** Instance name as written, including any `[i]` generate select. */
  rawName: string;
  moduleName: string;
  /** The `moduleName` identifier range. */
  moduleNameRange: Range;
  /** The instance name identifier range. */
  nameRange: Range;
  /** Whole instantiation statement. */
  range: Range;
  connections: PortConn[];
  /** Enclosing module name. */
  parent: string;
  /** Parameter overrides from `#(...)`. */
  paramOverrides: ParamOverride[];
  /** Arrayed instance (`foo u[3:0](...)`): count of parallel instances. */
  arrayCount?: ValueRange;
  /** Generate construct that produced this instance, if any. */
  inGenerate?: boolean;
  /** Set when the instance is inside `if`/`case` generate branches. */
  conditional?: boolean;
  /** Positional (non-named) port connections, ordered. */
  positional?: boolean;
  /** Enclosing generate block path, e.g. `g_par[2]`. Empty when not generated. */
  genPrefix?: string;
}

export interface ParamOverride {
  name?: string;
  expr: ConstExpr;
  byPosition: boolean;
  range: Range;
}

// ---------------------------------------------------------------------------
// Continuous assignments
// ---------------------------------------------------------------------------

export interface AssignSite {
  lhs: RefSite[];
  rhs: RefSite[];
  /**
   * Generate construct this assignment sits in, if any. The structural IR has no
   * generate block, so a copy cannot reproduce one: the marker is what lets the
   * generator refuse instead of writing something that is not the design.
   */
  generate?: string;
  /** Source text of the left-hand side, whitespace-normalised. */
  lhsText: string;
  /** Source text of the right-hand side, whitespace-normalised. */
  rhsText: string;
  range: Range;
  /** Left-hand side of the assign (junction). */
  junction?: string;
  isAlias: boolean;
  inAlways: boolean;
  /**
   * Inside a function or task body, where every name is an automatic variable
   * of one call rather than a signal of the module. No net, no graph edge.
   */
  local?: boolean;
}

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

export type ModuleKind = 'module' | 'interface' | 'program' | 'package' | 'class' | 'primitive';

export interface ModuleDef {
  name: string;
  kind: ModuleKind;
  /** Absolute file path. */
  file: string;
  range: Range;
  nameRange: Range;
  /** Port name order as written in the header. */
  portOrder: string[];
  ports: PortDecl[];
  params: ParamDecl[];
  decls: VarDecl[];
  funcs: FunctionDecl[];
  /** Every call in this module, including those inside subroutine bodies. */
  calls?: CallSite[];
  instances: InstanceSite[];
  assigns: AssignSite[];
  refs: RefSite[];
  includes: string[];
  /** `import` statements seen in the body: what this module borrows. */
  imports: ImportDecl[];
  directives: DirectiveUse[];
  defparams: DefParam[];
  /** `ifdef` branches seen, for the "unresolved module" heuristic. */
  conditionalRegions: number;
  usesUnknownConstruct: boolean;
  /** Wall-clock parse time in ms. */
  timeMs: number;
  /** One-based line of the `module` keyword. */
  startLine: number;
}

/**
 * One `import` statement. The names it lists are declared in the package, so a
 * module that borrows them has no local declaration of its own.
 */
export interface ImportDecl {
  /** Package the names come from. */
  pkg: string;
  /** Names written in the statement; empty for `import pkg::*`. */
  names: ImportedName[];
  /** True for `import pkg::*`, where the statement lists no name. */
  wildcard: boolean;
  range: Range;
}

export interface ImportedName {
  name: string;
  /** Range of the name, so a rename could rewrite the import. */
  range: Range;
}

export interface DirectiveUse {
  name: string;
  range: Range;
}

/**
 * A `` `define `` seen in the source. The macro body is not expanded, but the
 * name and where it sits are kept so a reference (a `` `NAME `` token) can jump
 * to its definition.
 */
export interface MacroDef {
  name: string;
  file: string;
  /** Full extent of the whole directive line, backtick included. */
  range: Range;
  /** Just the macro identifier - what a jump lands on. */
  nameRange: Range;
  /** The full directive text (e.g. "`define WIDTH 8"), line-oriented. */
  text?: string;
}

/** `defparam u1.W = 8;` */
export interface DefParam {
  /** Instance path relative to the enclosing module, e.g. `u1.u2`. */
  target: string;
  targetRange: Range;
  param: string;
  paramRange: Range;
  expr: ConstExpr;
}

/**
 * Declarations a file makes *outside* any module: a `typedef`, an enum's
 * members, a file-scope `parameter`. Inside the file that declares them the
 * parser hands them to every module (`shareFileTypedefs`); a header that has no
 * module of its own has nowhere to put them, so they are carried here and the
 * index offers them to the files that `` `include `` it.
 */
export interface FileScopeDecls {
  decls: VarDecl[];
  params: ParamDecl[];
}

export interface ParseResult {
  file: string;
  modules: ModuleDef[];
  includes: string[];
  /** `` `define `` macros declared anywhere in the file, in source order. */
  macros: MacroDef[];
  fileScoped: FileScopeDecls;
  timeMs: number;
}

// ---------------------------------------------------------------------------
// Hierarchy
// ---------------------------------------------------------------------------

export interface HierarchyNode {
  /** Dotted instance path, e.g. `top.u_alu.u_add`. Root is the module name. */
  path: string;
  instName: string;
  moduleName: string;
  depth: number;
  file?: string;
  nameRange?: Range;
  moduleNameRange?: Range;
  /** Instance statement range in the parent file. */
  range?: Range;
  /** File that defines `moduleName` (not the instantiation site). */
  defFile?: string;
  /** Direct child count known without materialising the level. */
  childCountHint?: number;
  /** Port connections of this instance (present when the node came from an InstanceSite). */
  connections?: PortDecl[];
  parentPath?: string;
  children?: HierarchyNode[];
  /** Children were not materialised (depth / budget limit). */
  truncated?: boolean;
  /** Module name could not be resolved in the index. */
  unresolved?: boolean;
  /** Recursive instantiation - expansion stopped here. */
  cycle?: boolean;
  /** Count of instances under this node (lazy, filled on demand). */
  instanceCount?: number;
  /** Parameter bindings in effect for this node. */
  params?: Map<string, number>;
  /** Generate block that this instance lives in. */
  generate?: string;
}

export function makeNode(p: Partial<HierarchyNode> & { path: string; instName: string; moduleName: string; depth: number }): HierarchyNode {
  return { children: [], ...p };
}

/** Depth-first walk over a hierarchy, including the root. */
export function walkHierarchy(
  root: HierarchyNode,
  visit: (n: HierarchyNode, parent?: HierarchyNode) => void | boolean,
  parent?: HierarchyNode,
): void {
  const cont = visit(root, parent);
  if (cont === false) {
    return;
  }
  for (const c of root.children ?? []) {
    walkHierarchy(c, visit, root);
  }
}

/** Count nodes under a hierarchy (lazy expansion aware). */
export function countNodes(n: HierarchyNode): number {
  if (n.instanceCount !== undefined) {
    return n.instanceCount;
  }
  let total = 1;
  for (const c of n.children ?? []) {
    total += countNodes(c);
  }
  n.instanceCount = total;
  return total;
}
