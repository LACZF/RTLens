/**
 * Identifier rules shared by rename, generator and the tree views.
 *
 * Verilog is more permissive than most languages (identifiers may contain `$`),
 * but the set of reserved words is large, and letting a rename produce one is a
 * fast way to make a design stop compiling.
 *
 * The list is deliberately a superset of the lexer's keyword table: the lexer
 * leaves the gate primitives out so the parser can tell a gate instantiation
 * from a use, but a rename still has to refuse to produce one. The superset
 * property is asserted in `naming.test.ts` so the two lists cannot drift.
 */

const KEYWORDS = new Set([
  'alias', 'always', 'always_comb', 'always_ff', 'always_latch', 'and', 'assert', 'assign',
  'assume', 'automatic', 'before', 'begin', 'bind', 'bins', 'binsof', 'bit', 'break', 'buf',
  'bufif0', 'bufif1', 'byte', 'case', 'casex', 'casez', 'cell', 'chandle', 'checker', 'class',
  'clocking', 'cmos', 'config', 'const', 'constraint', 'context', 'continue', 'cover',
  'covergroup', 'coverpoint', 'cross', 'deassign', 'default', 'defparam', 'design', 'disable',
  'dist', 'do', 'edge', 'else', 'end', 'endcase', 'endchecker', 'endclass', 'endclocking',
  'endconfig', 'endfunction', 'endgenerate', 'endgroup', 'endinterface', 'endmodule',
  'endpackage', 'endprimitive', 'endprogram', 'endproperty', 'endspecify', 'endsequence',
  'endtable', 'endtask', 'enum', 'event', 'expect', 'export', 'extends', 'extern', 'final',
  'first_match', 'for', 'force', 'foreach', 'forever', 'fork', 'forkjoin', 'function',
  'generate', 'genvar', 'highz0', 'highz1', 'if', 'iff', 'ifnone', 'ignore_bins', 'illegal_bins',
  'implements', 'implies', 'import', 'incdir', 'include', 'initial', 'inout', 'input', 'inside',
  'instance', 'int', 'integer', 'interconnect', 'interface', 'intersect', 'join', 'join_any',
  'join_none', 'large', 'let', 'liblist', 'library', 'local', 'localparam', 'logic', 'longint',
  'macromodule', 'matches', 'medium', 'modport', 'module', 'nand', 'negedge', 'nettype', 'new',
  'nexttime', 'nmos', 'nor', 'noshowcancelled', 'not', 'notif0', 'notif1', 'null', 'or', 'output',
  'package', 'packed', 'parameter', 'pmos', 'posedge', 'primitive', 'priority', 'program',
  'property', 'protected', 'pull0', 'pull1', 'pulldown', 'pullup', 'pulsestyle_ondetect',
  'pulsestyle_onevent', 'pure', 'rand', 'randc', 'randcase', 'randsequence', 'rcmos', 'real',
  'realtime', 'ref', 'reg', 'reject_on', 'release', 'repeat', 'restrict', 'return', 'rnmos',
  'rpmos', 'rtran', 'rtranif0', 'rtranif1', 's_always', 's_eventually', 's_nexttime', 's_until',
  's_until_with', 'scalared', 'sequence', 'shortint', 'shortreal', 'showcancelled', 'signed',
  'small', 'soft', 'solve', 'specify', 'specparam', 'static', 'string', 'strong', 'strong0',
  'strong1', 'struct', 'super', 'supply0', 'supply1', 'sync_accept_on', 'sync_reject_on',
  'table', 'tagged', 'task', 'this', 'throughout', 'time', 'timeprecision', 'timeunit', 'tran',
  'tranif0', 'tranif1', 'tri', 'tri0', 'tri1', 'triand', 'trior', 'trireg', 'type', 'typedef',
  'union', 'unique', 'unique0', 'unsigned', 'until', 'until_with', 'untyped', 'use', 'uwire',
  'var', 'vectored', 'virtual', 'void', 'wait', 'wait_order', 'wand', 'weak', 'weak0', 'weak1',
  'while', 'wildcard', 'wire', 'with', 'within', 'wor', 'xnor', 'xor',
  // In the lexer's keyword table but missing from the list above until now; a
  // rename to one of these would have produced a declaration the parser then
  // reads as a keyword (`net x;` is a net declaration, not a signal named x).
  'accept_on', 'defaultclocking', 'dpi', 'endconstraint', 'endlibrary', 'eventually',
  'global', 'net',
]);

/** True for something that can legally appear as a Verilog identifier. */
export function validIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) && !KEYWORDS.has(name);
}

/** Why `name` must not be used as an identifier, or undefined when it is fine. */
export function identifierProblem(name: string): string | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
    return `"${name}" is not a valid Verilog identifier.`;
  }
  if (KEYWORDS.has(name)) {
    return `"${name}" is a Verilog keyword.`;
  }
  return undefined;
}
