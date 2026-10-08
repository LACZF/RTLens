import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { tokenize, isSignificant } from '../core/lexer';
import { literalValue } from '../core/fold';
import { parseSource } from '../core/parser';
import { HdlIndex } from '../core/index';
import { collectProblems } from '../core/problems';
import { typeWidth } from '../core/fold';
import { buildHierarchy } from '../core/hierarchy';

/** Significant tokens as `text` strings, for compact structural assertions. */
function sig(src: string): string[] {
  return tokenize(src)
    .filter(isSignificant)
    .map((t) => t.text);
}

test('lexer splits identifiers, numbers and punctuation', () => {
  assert.deepEqual(sig('a = 8\'hFF;'), ['a', '=', "8'hFF", ';']);
  assert.deepEqual(sig('wire [7:0] w;'), ['wire', '[', '7', ':', '0', ']', 'w', ';']);
});

test('lexer keeps $ system identifiers out of user identifiers', () => {
  assert.deepEqual(sig('$clog2(x)'), ['$clog2', '(', 'x', ')']);
});

test('lexer understands based, sized and underscored literals', () => {
  assert.equal(literalValue(tokenize("8'hFF")[0]), 255);
  assert.equal(literalValue(tokenize("4'b10_10")[0]), 10);
  assert.equal(literalValue(tokenize("32'd42")[0]), 42);
  assert.equal(literalValue(tokenize("8'o17")[0]), 15);
  assert.equal(literalValue(tokenize('1_000_000')[0]), 1000000);
  assert.equal(literalValue(tokenize("16'sh8000")[0]), -32768, 'signed literals are sign-extended');
});

test('lexer strips comments but can keep them', () => {
  assert.deepEqual(sig('a; // trailing\nb;'), ['a', ';', 'b', ';']);
  const withComments = tokenize('a; /* x */ b;', { keepComments: true });
  const comment = withComments.find((t) => t.kind === 'comment');
  assert.ok(comment, 'block comment token present');
  assert.ok(!comment!.isLineComment, 'block comment');
  const line = tokenize('// hi', { keepComments: true }).find((t) => t.kind === 'comment');
  assert.equal(line?.isLineComment, true);
});

test('lexer does not end a string at an escaped quote', () => {
  const toks = tokenize('initial $display("a\\"b");');
  const str = toks.find((t) => t.kind === 'string');
  assert.ok(str);
  assert.equal(str!.text, '"a\\"b"');
});

test('parser reads ANSI ports with widths and defaults', () => {
  const { modules } = parseSource('/t.v', `
module top #(
  parameter int WIDTH = 8,
  parameter DEPTH = 4
) (
  input  wire              clk,
  input  wire [WIDTH-1:0]  a,
  output logic [3:0]       q = 4'd0
);
endmodule
`);
  const m = modules[0];
  assert.equal(m.name, 'top');
  assert.deepEqual(m.portOrder, ['clk', 'a', 'q']);
  assert.deepEqual(m.params.map((p) => p.name), ['WIDTH', 'DEPTH']);
  const a = m.ports.find((p) => p.name === 'a')!;
  assert.equal(a.direction, 'input');
  assert.equal(a.ansi, true);
  assert.ok(a.range, 'bus port keeps its packed range');
  const q = m.ports.find((p) => p.name === 'q')!;
  assert.equal(q.direction, 'output');
  assert.equal(q.ansi, true);
  assert.ok(q.dataType, 'data type recorded');
});

test('parser reads non-ANSI ports and maps them to internal decls', () => {
  const { modules } = parseSource('/t.v', `
module legacy (clk, din, dout);
  input clk;
  input [7:0] din;
  output reg dout;
  wire [7:0] din;
endmodule
`);
  const m = modules[0];
  assert.deepEqual(m.portOrder, ['clk', 'din', 'dout']);
  assert.equal(m.ports.find((p) => p.name === 'dout')!.direction, 'output');
  assert.equal(m.ports.find((p) => p.name === 'din')!.ansi, false);
  // The non-ANSI direction declarations become the ports themselves, not decls.
  assert.deepEqual(
    m.decls.map((d) => d.name),
    ['din'],
  );
});

test('parser separates port directions into in/out/inout', () => {
  const { modules } = parseSource(
    '/t.v',
    'module m(input a, output b, inout c, inout wire d); endmodule',
  );
  assert.deepEqual(
    modules[0].ports.map((p) => `${p.name}:${p.direction}`),
    ['a:input', 'b:output', 'c:inout', 'd:inout'],
  );
});

test('parser handles named parameter overrides without whitespace', () => {
  const { modules } = parseSource(
    '/t.v',
    'module top; sub #(.DEPTH(DEPTH), .W(W)) u_sub (); endmodule',
  );
  const u = modules[0].instances[0];
  assert.equal(u.paramOverrides.length, 2);
  assert.equal(u.paramOverrides[0].name, 'DEPTH');
  assert.equal(u.paramOverrides[0].expr.raw, 'DEPTH');
  assert.equal(u.paramOverrides[1].name, 'W');
  // The nested parens of the override expression must not confuse the scanner.
  assert.equal(u.name, 'u_sub');
});

test('parser keeps positional overrides and marks them', () => {
  const { modules } = parseSource('/t.v', 'module top; sub #(4, 8) u_sub (); endmodule');
  const u = modules[0].instances[0];
  assert.equal(u.paramOverrides.length, 2);
  assert.ok(u.paramOverrides.every((p) => p.byPosition));
});

test('parser reads named, positional, implicit, star and empty connections', () => {
  const src = `
module top;
  sub u_named (.a(x), .b(y));
  sub u_pos  (x, y);
  sub u_impl (.a, .b);
  sub u_star (.*);
  sub u_empty (.a(x), .b());
endmodule
`;
  const { modules } = parseSource('/t.v', src);
  const byName = new Map(modules[0].instances.map((i) => [i.name, i]));
  assert.deepEqual(
    byName.get('u_named')!.connections.map((c) => `${c.portName}=${c.rawExpr}`),
    ['a=x', 'b=y'],
  );
  assert.ok(byName.get('u_pos')!.connections.every((c) => c.portName === ''), 'positional ports unnamed');
  // `.a` means "connect to the signal called a", not "leave it unconnected".
  assert.deepEqual(
    byName.get('u_impl')!.connections.map((c) => [c.portName, c.rawExpr, c.shorthand]),
    [
      ['a', 'a', true],
      ['b', 'b', true],
    ],
  );
  const star = byName.get('u_star')!.connections[0];
  assert.deepEqual([star.portName, star.rawExpr, star.shorthand], ['*', '*', true]);
  const empty = byName.get('u_empty')!.connections.find((c) => c.portName === 'b')!;
  assert.ok(empty.empty, 'explicitly unconnected port flagged');
  assert.ok(!empty.shorthand, '`.b()` is not a shorthand');
});

test('parser records a port connected to a different internal net', () => {
  const { modules } = parseSource('/t.v', 'module top; sub u (.ext(internal)); endmodule');
  const c = modules[0].instances[0].connections[0];
  assert.equal(c.portName, 'ext');
  assert.equal(c.rawExpr, 'internal');
});

test('parser expands generate for loops and names the instances', () => {
  const { modules } = parseSource(
    '/t.v',
    `
module top;
  genvar i;
  generate
    for (i = 0; i < 4; i = i + 1) begin : g
      sub u_sub (.idx(i));
    end
  endgenerate
endmodule
`,
  );
  // The loop is unrolled: one instance site per iteration, each tagged with the
  // generate label and the loop index.
  const insts = modules[0].instances;
  assert.equal(insts.length, 4, 'one instance per iteration');
  assert.deepEqual(
    insts.map((i) => i.genPrefix),
    ['g[0]', 'g[1]', 'g[2]', 'g[3]'],
  );
  assert.ok(insts.every((i) => i.inGenerate));
});

test('parser separates always-blocks from continuous assigns', () => {
  const { modules } = parseSource(
    '/t.v',
    `
module top (input a, output y, output reg q);
  assign y = a;
  always @(a) q = a;
endmodule
`,
  );
  const m = modules[0];
  const cont = m.assigns.filter((a) => !a.inAlways);
  assert.equal(cont.length, 1, 'only the continuous assign is a net-level assign');
  assert.equal(cont[0].lhsText, 'y');
  assert.equal(cont[0].rhsText, 'a');
  assert.equal(cont[0].junction, 'y');
  const proc = m.assigns.filter((a) => a.inAlways);
  assert.equal(proc.length, 1, 'the always block assignment is indexed separately');
  assert.equal(proc[0].junction, 'q');
});

test('parser keeps ternary expressions readable when re-emitting', () => {
  const { modules } = parseSource('/t.v', 'module top(input c, input a, input b, output y); assign y = c ? a : b; endmodule');
  const a = modules[0].assigns[0];
  assert.equal(a.rhsText, 'c ? a : b');
  assert.ok(!/;;/.test(`${a.lhsText};`));
});

test('parser records hierarchical references and their full path', () => {
  const { modules } = parseSource(
    '/t.v',
    'module top; sub u_sub(); assign x = u_sub.internal_bus; endmodule',
  );
  const ref = modules[0].refs.find((r) => (r.fullPath ?? '').includes('internal_bus'));
  assert.ok(ref, 'hierarchical ref found');
  assert.equal(ref!.fullPath, 'u_sub.internal_bus');
  // References used only inside assignments are part of the module ref list, so
  // "find references" and semantic tokens see them.
  assert.ok(
    modules[0].refs.some((r) => r.fullPath === 'x'),
    'assignment sides contribute refs',
  );
});

test('parser records `include directives and unknown constructs', () => {
  const { modules, includes } = parseSource('/t.v', '`include "defs.vh"\nmodule top; endmodule');
  assert.deepEqual(includes, ['defs.vh']);
  assert.equal(modules.length, 1);
});

test('parser recovers from a missing endmodule', () => {
  const { modules } = parseSource('/t.v', 'module a; sub u();\nmodule b; endmodule');
  assert.deepEqual(modules.map((m) => m.name), ['a', 'b']);
  assert.equal(modules[0].instances.length, 1);
  // The same recovery has to work inside an unterminated begin/end block.
  const nested = parseSource('/t.v', 'module a; begin sub u(); end\nmodule b; endmodule');
  assert.deepEqual(nested.modules.map((m) => m.name), ['a', 'b']);
});

test('parser reports a defparam target', () => {
  const { modules } = parseSource('/t.v', 'module top; sub u(); defparam u.W = 16; endmodule');
  const d = modules[0].defparams[0];
  assert.equal(d.target, 'u', 'instance path without the keyword or a trailing dot');
  assert.equal(d.param, 'W');
  assert.ok(d.expr, 'defparam value kept');
  // A deep target keeps every path segment.
  const deep = parseSource('/t.v', 'module top; sub u(); defparam u.a.b.W = 8; endmodule');
  assert.equal(deep.modules[0].defparams[0].target, 'u.a.b');
});

test('parser reads function and task declarations', () => {
  const { modules } = parseSource(
    '/t.v',
    `module top;
  function automatic [7:0] add1(input [7:0] x); add1 = x + 1; endfunction
  task t(); begin end endtask
endmodule`,
  );
  const names = modules[0].funcs.map((f) => f.name);
  assert.ok(names.includes('add1'));
  assert.ok(names.includes('t'));
});

test('lexer knows the keywords the parser dispatches on', () => {
  // These used to be lexed as plain identifiers, which meant the parser never
  // saw them: a `typedef` was dropped from the module entirely, because the
  // body dispatcher only switches on keyword tokens.
  for (const kw of ['typedef', 'net', 'property', 'sequence', 'table', 'endtable']) {
    const t = tokenize(kw)[0];
    assert.equal(t.kind, 'keyword', `${kw} is a keyword`);
  }
});

test('parser keeps a typedef declaration', () => {
  const { modules } = parseSource(
    '/t.v',
    `module top;
  typedef logic [7:0] word_t;
  typedef enum {A, B} e_t;
  typedef struct packed {logic a; logic b;} s_t;
  word_t w;
endmodule`,
  );
  const decls = modules[0].decls;
  assert.deepEqual(
    decls.filter((d) => d.kind === 'typedef').map((d) => d.name),
    ['word_t', 'e_t', 's_t'],
    'every typedef shape is indexed',
  );
  // The name in the typedef is a use of the type.
  const wordRef = modules[0].refs.find((r) => r.fullPath === 'word_t');
  assert.ok(wordRef, 'using the typedef is a reference');
  assert.equal(wordRef.kind, 'type');
});

test('parser keeps a typedef in a package', () => {
  const { modules } = parseSource('/t.v', 'package p; typedef logic [3:0] nib_t; endpackage');
  assert.equal(modules[0].kind, 'package');
  assert.equal(modules[0].decls[0].name, 'nib_t');
});

test('parser indexes a variable declared with a typedef name', () => {
  // `my_t data;` is how a variable of a derived type is normally written. With
  // no keyword in front of the type name the statement used to be skipped, so
  // the variable had no declaration, no references and no semantic token.
  const { modules } = parseSource(
    '/t.v',
    `module top;
  typedef logic [7:0] b_t;
  b_t data;
  b_t arr [0:3];
  b_t init = 8'd0;
  b_t from_var = data;
  assign arr[0] = data;
endmodule`,
  );
  const mod = modules[0];
  assert.deepEqual(
    mod.decls.filter((d) => d.kind === 'reg').map((d) => d.name),
    ['data', 'arr', 'init', 'from_var'],
  );
  for (const name of ['data', 'arr', 'init', 'from_var']) {
    const d = mod.decls.find((x) => x.name === name)!;
    assert.equal(d.dataType.t, 'user');
    assert.equal(d.dataType.t === 'user' && d.dataType.name, 'b_t');
  }
  // Each declaration also uses its type, on its own line. The typedef's own
  // name is recorded as a reference to itself as well, so it is excluded here.
  const typedefLine = 1;
  const typeUses = mod.refs.filter(
    (r) => r.fullPath === 'b_t' && r.range.start.line !== typedefLine,
  );
  assert.equal(typeUses.length, 4, 'one type reference per declaration');
  assert.equal(typeUses[0].kind, 'type');
});

test('parser still reads a task call and an instantiation that start with a name', () => {
  // A name-led statement must not be mistaken for a declaration of a type.
  const { modules } = parseSource(
    '/t.v',
    `module top;
  typedef logic [7:0] b_t;
  b_t data;
  sub u (.x(data));
  check_it (data);
endmodule`,
  );
  const mod = modules[0];
  assert.deepEqual(mod.instances.map((i) => `${i.moduleName} ${i.name}`), ['sub u']);
  assert.deepEqual(mod.decls.map((d) => d.name), ['b_t', 'data']);
});

test('parser keeps the ref port direction', () => {
  // `ref` is both a direction and a modifier. Reading the modifiers first used
  // to swallow it, so `ref logic [7:0] x` came out as an input and a
  // pass-by-reference port looked like it could only be read.
  const { modules } = parseSource(
    '/t.v',
    `module child (input wire i, output wire o, inout wire io, ref wire r);
endmodule
module p (ref logic [7:0] x, input wire y, output signed [3:0] z);
endmodule`,
  );
  assert.deepEqual(
    modules[0].ports.map((p) => `${p.name}:${p.direction}`),
    ['i:input', 'o:output', 'io:inout', 'r:ref'],
  );
  assert.deepEqual(
    modules[1].ports.map((p) => `${p.name}:${p.direction}`),
    ['x:ref', 'y:input', 'z:output'],
  );
});

test('parser records the signals of an event control as reads', () => {
  // A clock that is only named in `@(posedge clk)` is still used. Without this
  // the nets view reports it as unused, which is the mistake it exists to catch.
  const { modules } = parseSource(
    '/t.v',
    `module seq (input wire clk, input wire rst, output wire q);
  always_ff @(posedge clk or negedge rst) q <= 1'b0;
endmodule`,
  );
  const events = modules[0].refs.filter((r) => r.context === 'event');
  assert.deepEqual(events.map((r) => r.name), ['clk', 'rst']);
  for (const e of events) {
    assert.equal(e.isWrite, false);
    assert.equal(e.kind, 'signal');
  }
});

test('parser does not turn gate operators into references', () => {
  // `or` and `and` are keywords to the language but live in the gate table, so
  // the lexer emits them as identifiers. Every `posedge clk or negedge rst`
  // used to produce a reference named "or".
  const { modules } = parseSource(
    '/t.v',
    `module g (input wire a, input wire b, output wire y);
  assign y = a or b;
  assign y = ~(a & b);
  and g1 (y, a, b);
endmodule`,
  );
  // The primitive name of a gate *instantiation* is a legitimate reference -
  // that is the module type being instantiated - so only the expression uses
  // are checked here.
  const names = modules[0].refs.filter((r) => r.kind !== 'module').map((r) => r.name);
  for (const op of ['and', 'or', 'not', 'xor', 'nand', 'nor', 'xnor']) {
    assert.ok(!names.includes(op), `"${op}" is not a reference`);
  }
  // The gate itself is still an instance of the primitive.
  assert.deepEqual(modules[0].instances.map((i) => `${i.moduleName} ${i.name}`), ['and g1']);
});

test('parser keeps a typedef declared outside any module', () => {
  // Shared types live above the first module in a header-style file. They used
  // to be dropped with the rest of the file-scope text, and then every
  // `byte_t data;` below lost its declaration: no definition, no references, no
  // semantic token, and a "not declared" warning in the Problems view.
  const { modules } = parseSource(
    '/t.v',
    `typedef logic [7:0] byte_t;
typedef enum logic [1:0] {IDLE, RUN} state_e;
module first;
  byte_t data;
  byte_t buf [0:3];
  state_e phase;
endmodule
module second;
  byte_t other;
endmodule`,
  );
  assert.equal(modules.length, 2);
  for (const { mod, names, used } of [
    { mod: modules[0], names: ['data', 'buf', 'phase'], used: ['byte_t', 'state_e'] },
    { mod: modules[1], names: ['other'], used: ['byte_t'] },
  ]) {
    // Every module in the file sees the shared types, each with its own
    // declaration.
    const typedefs = mod.decls.filter((d) => d.kind === 'typedef').map((d) => d.name);
    assert.deepEqual(typedefs, ['byte_t', 'state_e'], `${mod.name} sees the file types`);
    assert.deepEqual(
      mod.decls.filter((d) => d.kind === 'reg').map((d) => d.name),
      names,
      `${mod.name} indexes the variables declared with them`,
    );
    assert.equal(mod.usesUnknownConstruct, false, `${mod.name} understood the statements`);
    for (const d of mod.decls.filter((x) => x.kind === 'reg')) {
      assert.equal(d.dataType.t, 'user', `${d.name} keeps its type name`);
    }
    // A use of a shared type is a type reference, so it is coloured as one and
    // renaming the type finds it. Not every module uses every type.
    for (const type of ['byte_t', 'state_e']) {
      const uses = mod.refs.filter((r) => r.name === type && !r.isDecl);
      assert.ok(
        uses.every((r) => r.kind === 'type'),
        `${mod.name} classifies every use of ${type} as a type`,
      );
      assert.equal(
        uses.length > 0,
        used.includes(type),
        `${mod.name} records a use of ${type} only where it has one`,
      );
    }
  }
  // The declaration sits at its real location, before the first module.
  assert.equal(modules[0].decls[0].range.start.line, 0);
  // The type names are references to themselves, so a shared type is coloured
  // and "find references" reports the declaration like any other.
  for (const mod of modules) {
    const selfRefs = mod.refs.filter((r) => r.isDecl && r.kind === 'type');
    assert.deepEqual(
      selfRefs.map((r) => `${r.name}@${r.range.start.line}`),
      ['byte_t@0', 'state_e@1'],
      `${mod.name} reports both shared types as declared here`,
    );
  }
});

test('parser lets a module scope its own type over a file-scope one', () => {
  // Shadowing: the module's typedef wins, and it is not indexed twice.
  const { modules } = parseSource(
    '/t.v',
    `typedef logic [7:0] word_t;
module m;
  typedef logic [3:0] word_t;
  word_t nib;
endmodule`,
  );
  const typedefs = modules[0].decls.filter((d) => d.kind === 'typedef');
  assert.equal(typedefs.length, 1);
  assert.equal(typedefs[0].range.start.line, 2, "the module's own typedef is the one kept");
  assert.deepEqual(
    modules[0].decls.filter((d) => d.kind === 'reg').map((d) => d.name),
    ['nib'],
  );
});

test('parser keeps a package-qualified type', () => {
  // `p::b_t x;` is how a package type is used without an import. The leading
  // identifier is not a typedef, so the statement used to be skipped entirely.
  const { modules } = parseSource(
    '/t.v',
    `package p;
  typedef logic [7:0] b_t;
endpackage
module m(input p::b_t [3:0] a, output wire y);
  p::b_t data;
  p::b_t buf [0:1];
  p::b_t z = 8'd0;
  assign y = |a;
endmodule`,
  );
  const mod = modules.find((x) => x.name === 'm')!;
  assert.deepEqual(
    mod.decls.filter((d) => d.kind === 'reg').map((d) => d.name),
    ['data', 'buf', 'z'],
  );
  for (const d of mod.decls.filter((x) => x.kind === 'reg')) {
    assert.equal(d.dataType.t, 'user');
    assert.equal(d.dataType.t === 'user' && d.dataType.name, 'p::b_t', 'the qualifier is kept');
  }
  const port = mod.ports.find((p) => p.name === 'a')!;
  assert.equal(port.dataType.t, 'user');
  assert.equal(port.dataType.t === 'user' && port.dataType.name, 'p::b_t');
  // A packed range on a qualified type still belongs to the port.
  assert.equal(port.dataType.t === 'user' && port.dataType.range?.msb.value, 3);
  // The reference is to the type, and the qualifier is not part of the name, so
  // it lines up with the typedef it came from.
  const uses = mod.refs.filter((r) => r.name === 'b_t' && r.kind === 'type');
  assert.equal(uses.length, 4, 'one use per declaration, including the port');
  assert.equal(mod.usesUnknownConstruct, false);
});

test('parser keeps a declaration whose type is not visible in this file', () => {
  // A design keeps its shared types in a header, so nothing in this file
  // declares `byte_t`. The statement is still a declaration: reading it as
  // anything else leaves the variable undeclared, and the Problems view then
  // warns about correct code.
  const { modules } = parseSource(
    '/t.v',
    `module sub; endmodule
module m;
  byte_t data;
  byte_t buf [0:3];
  byte_t z = 8'd0;
  unknown_pkg::type_t w;
  x.y v;
  sub u();
  check_it (data);
endmodule`,
  );
  const mod = modules[1];
  assert.deepEqual(
    mod.decls.map((d) => d.name),
    ['data', 'buf', 'z', 'w'],
    'every declaration is indexed, including the one with a qualified type',
  );
  for (const d of mod.decls) {
    assert.equal(d.dataType.t, 'user');
  }
  assert.equal(mod.decls[3].dataType.t === 'user' && mod.decls[3].dataType.name, 'unknown_pkg::type_t');
  // A dotted path is not a type, and the statements that merely start with a
  // name keep their meaning.
  assert.deepEqual(
    mod.instances.map((i) => `${i.moduleName} ${i.name}`),
    ['sub u'],
  );
});

test('parser reads an instantiation written without a port list', () => {
  // `sub u;` has the same shape as `byte_t data;`, so the two are told apart by
  // the name: only a scope this file declares can be instantiated. The module
  // may also be defined after the use, which is why the names are collected
  // before anything is parsed.
  const { modules } = parseSource(
    '/t.v',
    `module top;
  sub u;
  other #(.W(4)) v;
  sub arr [3:0] ();
  not_a_module x;
endmodule
module sub (input wire a); endmodule
module other; parameter W = 1; endmodule`,
  );
  assert.deepEqual(
    modules[0].instances.map((i) => `${i.moduleName} ${i.name}`),
    ['sub u', 'other v', 'sub arr'],
  );
  // The instance array keeps its range, so the hierarchy can show `arr[3]`.
  assert.equal(modules[0].instances[2].arrayCount?.msb.value, 3);
  assert.deepEqual(
    modules[0].decls.map((d) => d.name),
    ['x'],
    'a name that is not a scope of this file is a variable of an unknown type',
  );
});

test('parser: a bind statement records the instance it binds in', () => {
  // `bind` and `let` are statements that end in `;`, but they used to be
  // treated as blocks: the whole statement went to the block parser and was
  // skipped, so a bound instance was invisible to the hierarchy and the graph.
  const r = parseSource(
    '/w/t.sv',
    `module dut (input wire a, output wire b);
  wire probe;
  assign b = a | probe;
endmodule
module tb (input wire a, output wire y);
  wire w;
  bind dut dut u_checker (.a (a), .b (probe));
  let z = 1;
  assign y = w;
endmodule`,
  );
  const tb = r.modules[1];
  assert.deepEqual(
    tb.instances.map((i) => `${i.moduleName} ${i.name}`),
    ['dut u_checker'],
  );
  assert.deepEqual(
    tb.instances[0].connections.map((c) => c.portName),
    ['a', 'b'],
  );
  // The connection names live in the module being bound into, so they are not
  // undeclared here even though this module declares no `a` or `w` of its own.
  const bindRefs = tb.refs.filter((r2) => r2.bind);
  assert.deepEqual(
    bindRefs.map((r2) => `${r2.name}:${r2.kind}`),
    // `probe` is a wire inside the module being bound into, and `tb` declares
    // no such signal, so only the bind rule can keep it out of the
    // undeclared-name report.
    ['dut:module', 'a:signal', 'probe:signal'],
  );
  // The statement is understood, so nothing is reported as an unknown construct.
  assert.equal(tb.usesUnknownConstruct, false);
  // The `let` statement is a statement, not a block: it must not swallow the
  // rest of the body.
  assert.equal(tb.assigns.length, 1, 'the assign after the let is still seen');
});

test('parser: an enum member is a constant of the enclosing scope', () => {
  // `typedef enum {A, B = 2, C} e_t;` used to record the type and nothing else,
  // so the three names were invisible: no declaration to jump to, no hover, and
  // a flattened copy referred to constants nobody had defined.
  const r = parseSource(
    '/w/t.sv',
    `module dut (input wire [1:0] a, output wire [1:0] y);
  typedef enum logic [1:0] { RED = 2'b00, GREEN, BLUE = 2'b10 } e_t;
  e_t q;
  assign y = (a == 0) ? RED : BLUE;
endmodule`,
  );
  const dut = r.modules[0];
  const members = dut.params.filter((p) => ['RED', 'GREEN', 'BLUE'].includes(p.name));
  assert.deepEqual(
    members.map((p) => `${p.name}=${p.value?.value}`),
    // GREEN is not given a value of its own, so it counts on from RED.
    ['RED=0', 'GREEN=1', 'BLUE=2'],
  );
  assert.ok(members.every((p) => p.isLocal && !p.isType), 'a member is a localparam, not a type');
  // Every member is a declaration reference, and every use of one is classified
  // as a parameter, so both the declaration and its uses get highlighted.
  assert.deepEqual(
    dut.refs.filter((x) => ['RED', 'GREEN', 'BLUE'].includes(x.name)).map((x) => `${x.name}:${x.kind}${x.isDecl ? ':decl' : ''}`),
    ['RED:param:decl', 'GREEN:param:decl', 'BLUE:param:decl', 'RED:param', 'BLUE:param'],
  );
  // The type of a member is the enum it belongs to, which is what hover shows.
  assert.deepEqual(members.map((p) => (p.dataType.t === 'user' ? p.dataType.name : p.dataType.t)), ['e_t', 'e_t', 'e_t']);
});

test('parser: a member value that names another member is a reference', () => {
  const r = parseSource(
    '/w/t.sv',
    `module dut ();
  typedef enum logic [1:0] { A = 0, B = 1, C = A + B } e_t;
endmodule`,
  );
  const dut = r.modules[0];
  assert.equal(dut.params.find((p) => p.name === 'C')?.value?.value, 1);
  assert.deepEqual(
    dut.refs.filter((x) => (x.name === 'A' || x.name === 'B') && !x.isDecl).map((x) => `${x.name}:${x.kind}`),
    ['A:param', 'B:param'],
  );
});

test('parser: a file-scope enum reaches the modules below it', () => {
  // The type is shared into every module; the members have to follow it, or
  // `phase == IDLE` inside the module is an undeclared name.
  const r = parseSource(
    '/w/t.sv',
    `typedef enum logic [1:0] { IDLE, RUN, DONE } state_e;
module dut (input wire clk, output reg [1:0] phase);
  always @(posedge clk) phase <= RUN;
endmodule`,
  );
  const dut = r.modules[0];
  assert.deepEqual(
    dut.params.map((p) => `${p.name}=${p.value?.value}`),
    ['IDLE=0', 'RUN=1', 'DONE=2'],
  );
  assert.deepEqual(
    dut.refs
      .filter((x) => x.name === 'RUN')
      .map((x) => `${x.name}:${x.kind}${x.isDecl ? ':decl' : ''}`),
    ['RUN:param:decl', 'RUN:param'],
  );
});

test('parser: a string is its character codes, but a string concat is not a number', () => {
  const r = parseSource(
    '/w/s.sv',
    `module dut #(parameter string NAME = "abc") (input wire a);
  localparam string MSG = {NAME, "-v"};
  localparam int MIXED = {1'b0, 4'h2};
  localparam int LEAD = {"ab", 4'h1};
endmodule`,
  );
  const dut = r.modules[0];
  // "abc" -> 0x616263: a string literal in an expression is its bytes.
  assert.equal(dut.params.find((p) => p.name === 'NAME')?.value?.value, 0x616263);
  // `{NAME, "-v"}` used to shift the first value by 32 and add the second,
  // which is a number no expression ever had. Not folding is honest.
  assert.equal(dut.params.find((p) => p.name === 'MSG')?.value?.value, undefined);
  assert.equal(dut.params.find((p) => p.name === 'MSG')?.value?.raw, '{NAME,"-v"}');
  // A concat of plain numbers still folds, with the documented 32-bit shift.
  assert.equal(dut.params.find((p) => p.name === 'MIXED')?.value?.value, 2);
  // The same for a string in the first slot of the concat.
  assert.equal(dut.params.find((p) => p.name === 'LEAD')?.value?.value, undefined);
});

test('parser: a module scopes its own member over a file-scope one', () => {
  const r = parseSource(
    '/w/t.sv',
    `typedef enum logic [1:0] { IDLE = 5 } state_e;
module dut ();
  localparam int IDLE = 7;
endmodule`,
  );
  const dut = r.modules[0];
  // The module's own parameter wins, so the shared one is not duplicated.
  assert.deepEqual(
    dut.params.map((p) => `${p.name}=${p.value?.value}`),
    ['IDLE=7'],
  );
});

test('parser: enum members of a package are visible through an import', () => {
  const r = parseSource(
    '/w/t.sv',
    `package types_pkg;
  typedef enum logic [1:0] { ADD, SUB, MUL } op_e;
endpackage
import types_pkg::*;
module alu (input wire [1:0] a, output reg [1:0] y);
  localparam int K = MUL;
endmodule`,
  );
  const pkg = r.modules[0];
  assert.deepEqual(
    pkg.params.map((p) => `${p.name}=${p.value?.value}`),
    ['ADD=0', 'SUB=1', 'MUL=2'],
  );
  assert.deepEqual(
    r.modules[1].imports.map((i) => `${i.pkg}${i.wildcard ? '::*' : ''}`),
    ['types_pkg::*'],
  );
});

test('parser: a generate block holds the statements a module body holds', () => {
  // The generate loop understood declarations, parameters, types and
  // instantiations, and nothing else: an `assign`, an `always` or a `defparam`
  // inside one was skipped a token at a time. The net then claimed a signal had
  // no driver, the graph missed the connection, and a flattened copy lost the
  // wiring - all without a word of warning.
  const r = parseSource(
    '/w/t.sv',
    `module dut (input wire [1:0] a, output wire [1:0] y);
  genvar i;
  generate
    for (i = 0; i < 2; i = i + 1) begin : g
      wire t;
      assign t = a[i];
      always_comb y = t;
    end
  endgenerate
  assign y = a[0] ? y : 2'b00;
endmodule`,
  );
  const dut = r.modules[0];
  // One copy of the loop body per iteration, each tagged with the construct it
  // came from - that is what the generator needs in order to refuse.
  assert.deepEqual(
    dut.assigns.map((a) => `${a.lhs.map((x) => x.fullPath).join('&')}@${a.generate ?? '-'}:${a.inAlways ? 'always' : 'cont'}`),
    ['t@g[0]:cont', 'y@g[0]:always', 't@g[1]:cont', 'y@g[1]:always', 'y@-:cont'],
  );
  assert.deepEqual(
    dut.decls.map((d) => `${d.name}@${d.generate ?? '-'}`),
    ['i@-', 't@g[0]', 't@g[1]'],
  );
});

test('parser: a generate if and a generate case keep their branch contents', () => {
  const r = parseSource(
    '/w/t.sv',
    `module dut (input wire a, input wire [1:0] s, output wire y);
  generate
    if (1) begin : big
      wire t;
      assign t = a;
    end else begin : narrow
      wire u;
      assign u = ~a;
    end
    case (s)
      2'b00: begin : zero wire q; assign q = a; end
      default: begin : other wire r; assign r = a; end
    endcase
  endgenerate
  assign y = a;
endmodule`,
  );
  const dut = r.modules[0];
  assert.deepEqual(
    dut.assigns.map((a) => a.lhs.map((x) => x.fullPath).join('&')),
    ['t', 'u', 'q', 'r', 'y'],
  );
  // Every branch of a generate construct is a construct of its own, so a copy
  // cannot pick one and call it the design. The label of the branch is part of
  // it: it is how a testbench names the branch, `dut.small.t`.
  assert.deepEqual(
    dut.assigns.map((a) => a.generate),
    ['big', 'narrow', 'zero', 'other', undefined],
  );
  assert.deepEqual(dut.assigns.map((a) => a.lhs[0].name), ['t', 'u', 'q', 'r', 'y']);
});

test('parser: a defparam and a bind inside a generate block are not lost', () => {
  const r = parseSource(
    '/w/t.sv',
    `module leaf (); parameter int K = 1; endmodule
module dut ();
  genvar i;
  generate
    for (i = 0; i < 2; i = i + 1) begin : g
      defparam u.K = 4;
      leaf u ();
    end
  endgenerate
endmodule`,
  );
  const dut = r.modules[1];
  assert.deepEqual(
    dut.instances.map((x) => `${x.moduleName} ${x.name}@${x.genPrefix}`),
    ['leaf u@g[0]', 'leaf u@g[1]'],
  );
  assert.equal(dut.usesUnknownConstruct, false);
});

test('parser: a nested generate loop keeps the whole block path', () => {
  // A loop inside a loop used to be named by its own label alone, so the two
  // `n[0]` copies of the inner block shared one name: four different
  // declarations that nothing could tell apart, and instance paths that
  // collided in the hierarchy.
  const r = parseSource(
    '/w/t.sv',
    `module dut (input wire a, output wire y);
  genvar i, j;
  generate
    for (i = 0; i < 2; i = i + 1) begin : g
      for (j = 0; j < 2; j = j + 1) begin : n
        wire [1:0] w;
        assign w = i + j;
      end
    end
  endgenerate
  assign y = a;
endmodule`,
  );
  const dut = r.modules[0];
  assert.deepEqual(
    dut.decls.filter((d) => d.name === 'w').map((d) => d.generate),
    ['g[0].n[0]', 'g[0].n[1]', 'g[1].n[0]', 'g[1].n[1]'],
  );
  assert.deepEqual(
    dut.assigns.filter((a) => a.lhs[0].name === 'w').map((a) => a.generate),
    ['g[0].n[0]', 'g[0].n[1]', 'g[1].n[0]', 'g[1].n[1]'],
  );
  // The loop variable is declared once, not once per iteration.
  assert.deepEqual(dut.decls.filter((d) => d.name === 'i').length, 1);
  assert.deepEqual(dut.decls.filter((d) => d.name === 'j').length, 1);

  // The same holds for an instance inside the inner loop: the prefix of the
  // enclosing block was overwritten by the inner one, so all four copies were
  // filed under `n[0]` and their paths collided.
  const nested = parseSource(
    '/w/t.sv',
    `module dut (input wire a, output wire y);
  genvar i, j;
  generate
    for (i = 0; i < 2; i = i + 1) begin : g
      for (j = 0; j < 2; j = j + 1) begin : n
        leaf e (.a (a), .b (w));
      end
      wire [1:0] w;
    end
  endgenerate
  assign y = a;
endmodule`,
  ).modules[0];
  assert.deepEqual(
    nested.instances.map((x) => x.genPrefix),
    ['g[0].n[0]', 'g[0].n[1]', 'g[1].n[0]', 'g[1].n[1]'],
  );
});

test('parser: `for (genvar i = 0; ...)` declares and unrolls the loop variable', () => {
  // The loop header may declare its own variable, which is legal
  // SystemVerilog. Reading the loop stopped at the keyword: the body was never
  // unrolled, nothing declared the variable, and every use of it in the body
  // came up undeclared.
  const index = new HdlIndex();
  index.addFile(
    '/w/t.sv',
    `module dut (input wire [3:0] a, output wire [3:0] y);
  generate
    for (genvar i = 0; i < 4; i = i + 1) begin : g
      assign y[i] = a[i];
    end
  endgenerate
endmodule`,
  );
  const dut = index.resolveModule('dut')!;
  assert.deepEqual(
    dut.assigns.map((a) => a.generate),
    ['g[0]', 'g[1]', 'g[2]', 'g[3]'],
  );
  assert.deepEqual(
    dut.assigns.map((a) => a.lhs.map((x) => x.fullPath).join('&')),
    ['y', 'y', 'y', 'y'],
  );
  const genvarDecl = dut.decls.find((d) => d.name === 'i');
  assert.ok(genvarDecl, 'the loop variable is declared');
  assert.equal(genvarDecl.kind, 'genvar');
  // Its range points at the name in the header, so F12 on it lands there.
  assert.equal(genvarDecl.nameRange.start.line, 2);
  assert.deepEqual(collectProblems(index), []);
});

test('parser: the label of a generate branch is part of the path', () => {
  // Two branches of a generate if that both hold an instance named `u` are
  // `wide.u` and `narrow.u` in the design. With the labels dropped they were
  // both at `d.u`, one shadowing the other in the hierarchy.
  const index = new HdlIndex();
  index.addFile(
    '/w/t.sv',
    `module leaf (input wire a, output wire b);
endmodule
module dut #(parameter int W = 8) (input wire a, output wire y);
  generate
    if (W > 16) begin : wide
      wire t;
      leaf u (.a (a), .b (t));
    end
    else begin : narrow
      wire s;
      leaf u (.a (a), .b (s));
    end
  endgenerate
  assign y = a;
endmodule`,
  );
  const dut = index.resolveModule('dut')!;
  assert.deepEqual(dut.decls.map((d) => `${d.name}@${d.generate}`), ['t@wide', 's@narrow']);
  assert.deepEqual(dut.instances.map((i) => `${i.name}@${i.genPrefix}`), ['u@wide', 'u@narrow']);
  assert.ok(dut.instances.every((i) => i.conditional), 'both are conditional');
  const h = buildHierarchy(index, 'dut', { maxDepth: 4 })!;
  assert.deepEqual(
    (h.root.children ?? []).map((c) => c.path),
    ['dut.wide.u', 'dut.narrow.u'],
  );
  assert.deepEqual(collectProblems(index), []);
});

test('parser: a hierarchical reference keeps the index it reads through', () => {
  // `u.g_reg[0].regs` and `u.g_reg[1].regs` are two different signals. The
  // index was dropped from the path, so both came out as `u.g_reg.regs`: one
  // name in the Problems view, and one symbol to find-references and rename.
  const r = parseSource(
    '/w/t.sv',
    `module tb (input wire [7:0] a, output wire [7:0] o);
  d u ();
  assign o = u.g_reg[0].regs;
  assign o[0] = u.g_reg[1].regs[3];
  assign o[1] = u.plain;
endmodule`,
  );
  const tb = r.modules[0];
  assert.deepEqual(
    tb.refs.filter((x) => !x.isDecl).map((x) => x.fullPath),
    ['d', 'o', 'u.g_reg[0].regs', 'o', 'u.g_reg[1].regs', 'o', 'u.plain'],
  );
  // The name stays the first step of the path, which is what a hierarchical
  // rename would have to keep.
  const hierarchical = tb.refs.filter((x) => x.pathSuffix !== '');
  assert.deepEqual(hierarchical.map((x) => `${x.name}${x.pathSuffix}`), [
    'u.g_reg[0].regs',
    'u.g_reg[1].regs',
    'u.plain',
  ]);
});

test('parser: a name written in an index is a reference', () => {
  // The `WIDTH` in `bus[WIDTH].valid` is a use of the parameter, and nothing
  // declared it as far as the index was concerned: it was stepped over with the
  // brackets and never read.
  const r = parseSource(
    '/w/t.sv',
    `module tb (parameter int WIDTH = 8, input wire [WIDTH-1:0] a, output wire y);
  assign y = a[WIDTH-1];
  assign y = a[genvar_i];
endmodule`,
  );
  const tb = r.modules[0];
  assert.deepEqual(
    tb.refs.filter((x) => x.name === 'WIDTH' && !x.isDecl).map((x) => x.kind),
    ['param', 'param'],
  );
  // An index on the left of an assignment is not listed as a second written
  // signal: `regs[i] <= d` writes `regs` and only reads `i`.
  const assigns = parseSource(
    '/w/t.sv',
    `module dut (input wire d, output reg [3:0] regs);
  genvar i;
  always @(posedge d) regs[i] <= d;
endmodule`,
  ).modules[0].assigns;
  assert.deepEqual(assigns.map((a) => a.lhs.map((x) => x.fullPath)), [['regs']]);
});

test('parser: a parameter may be declared in the module header', () => {
  // `module m (parameter int W = 8, input wire [W-1:0] a, output wire y)` and
  // the split form `module m (parameter int W = 8) (input ..., output ...)`
  // are both legal. The header item was handed to parseAnsiPort, which guessed
  // it a direction: `W` became a phantom port, a "Direction of W guessed"
  // diagnostic on correct code, no parameter to find-references or rename, and
  // in the split form the port list was never read at all.
  const both = parseSource(
    '/w/t.sv',
    `module m (parameter int W = 8, localparam int L = W * 2, input wire [W-1:0] a, output wire [L-1:0] y);
  assign y = a[W-1];
endmodule`,
  ).modules[0];
  assert.deepEqual(both.params.map((p) => `${p.name}=${p.value?.value}`), ['W=8', 'L=16']);
  assert.deepEqual(both.ports.map((p) => `${p.name}:${p.direction}`), ['a:input', 'y:output']);
  assert.deepEqual(
    both.refs.filter((x) => x.name === 'W' && !x.isDecl).map((x) => x.kind),
    ['param', 'param', 'param'],
    'the declaration, the use in the port width, and the use in the localparam',
  );

  const split = parseSource(
    '/w/t.sv',
    `module m (parameter int W = 8) (input wire [W-1:0] a, output wire y);
  assign y = a[0];
endmodule`,
  ).modules[0];
  assert.deepEqual(split.params.map((p) => `${p.name}=${p.value?.value}`), ['W=8']);
  assert.deepEqual(split.ports.map((p) => `${p.name}:${p.direction}`), ['a:input', 'y:output']);
});

test('parser: a header list that is not ANSI is still a list of port names', () => {
  // The parameter split must not change what a non-ANSI list means: the names
  // come from the body, and the header only fixes their order.
  const r = parseSource(
    '/w/t.sv',
    `module m #(parameter int W = 4) (a, b);
  input [W-1:0] a;
  output b;
  assign b = a[0];
endmodule`,
  ).modules[0];
  assert.deepEqual(r.ports.map((p) => `${p.name}:${p.direction}:${p.ansi}`), ['a:input:false', 'b:output:false']);
  assert.deepEqual(r.params.map((p) => `${p.name}=${p.value?.value}`), ['W=4']);
  // A header with only a parameter list and no port list at all.
  const none = parseSource(
    '/w/t.sv',
    `module m (parameter int W = 8);
  localparam int Z = W;
endmodule`,
  ).modules[0];
  assert.deepEqual(none.ports, []);
  assert.deepEqual(none.params.map((p) => `${p.name}=${p.value?.value}`), ['W=8', 'Z=8']);
});

test('parser: a named procedural block and the variables it declares', () => {
  // `begin : name` names a block, and `logic t;` inside an `always` block
  // declares a variable of the module. Both were read as statements: the label
  // became the first name of the assignment that followed it, and the
  // declaration was swallowed with it, so every use of the local was reported
  // as an undeclared name.
  const m = parseSource(
    '/w/t.sv',
    `module m (input wire clk, input wire [1:0] d, output reg [1:0] q);
  always @(posedge clk) begin : up
    logic [1:0] tmp;
    int i;
    tmp = d;
    for (i = 0; i < 2; i = i + 1) q[i] = tmp[i];
  end
endmodule`,
  ).modules[0];
  assert.deepEqual(m.decls.map((d) => `${d.name}:${d.kind}`), ['tmp:reg', 'i:integer']);
  assert.deepEqual(m.decls.map((d) => typeWidth(d.dataType)), [2, 32]);
  // The label is not a signal, and the assignments inside the block are found.
  // The `for` head is a condition, not an assignment.
  assert.deepEqual(m.assigns.map((a) => a.lhs.map((r) => r.fullPath)), [['tmp'], ['q']]);
  assert.ok(m.assigns.every((a) => a.inAlways));
  assert.ok(!m.refs.some((r) => r.fullPath === 'up'), 'the block label is not a reference');
});

test('parser: a procedural block label after a case item or a fork', () => {
  // The same block label can follow `fork`, or a case item, and neither
  // changes what it is.
  const m = parseSource(
    '/w/t.sv',
    `module m (input wire [1:0] a, output reg y);
  always_comb begin
    case (a)
      2'd0: begin : zero
        logic t;
        t = 1;
        y = t;
      end
      default: y = 0;
    endcase
  end
  final begin : done
    fork : f
      y = 1;
    join
  end
endmodule`,
  ).modules[0];
  assert.deepEqual(m.decls.map((d) => d.name), ['t']);
  assert.ok(!m.refs.some((r) => ['zero', 'done', 'f'].includes(r.fullPath)), 'labels stay labels');
  // Every branch of the case is a statement of its own again: the local, the
  // assignment that follows it, the default branch and the fork body.
  assert.deepEqual(
    m.assigns.map((a) => a.lhs.map((r) => r.fullPath)),
    [['t'], ['y'], ['y'], ['y']],
  );
});

test('parser: a local of a user type in a procedural block', () => {
  // Only a keyword type or a typedef name is taken for a declaration, so
  // `arr[i] = 0;` - an assignment to an element - is still an assignment.
  const m = parseSource(
    '/w/t.sv',
    `typedef enum logic [1:0] { S0, S1 } state_t;
module m (input wire a, output reg y, output reg [1:0] arr);
  always @(posedge a) begin
    state_t next;
    var logic other;
    next = a ? S1 : S0;
    other = a;
    arr[a] = {1'b0, 1'b1};
    y = (next == S1) & other;
  end
endmodule`,
  ).modules[0];
  // `state_t` is the file's own typedef, which the module shares.
  assert.deepEqual(m.decls.map((d) => `${d.name}:${d.kind}`), [
    'state_t:typedef',
    'next:reg',
    'other:reg',
  ]);
  // The element assignment is still an assignment: the write is to `arr`, and
  // the index that selects it is a write, not a read of `a`.
  const indexed = m.assigns.find((a) => a.lhs.some((r) => r.fullPath === 'arr'))!;
  assert.deepEqual(indexed.lhs.map((r) => r.fullPath), ['arr']);
  assert.equal(indexed.lhs[0].isWrite, true);
  assert.deepEqual(indexed.rhs, []);
});

test('parser: what follows the body of a single-statement always is read', () => {
  // `always ... q <= d;` without a `begin` ends at its own semicolon. Stepping
  // one token past that ate the next one, so an `assign` written on the
  // following line lost its keyword: the nets view showed its left-hand side
  // undriven and the names it read as unused.
  const m = parseSource(
    '/w/t.sv',
    `module m (input wire clk, input wire en, input wire d, output reg q, output wire y);
  always @(posedge clk) if (en) q <= d;
  assign y = en & d;
endmodule`,
  ).modules[0];
  assert.deepEqual(
    m.assigns.map((a) => [a.inAlways, a.lhs.map((r) => r.fullPath), a.rhs.map((r) => r.fullPath)]),
    [
      [true, ['q'], ['d']],
      [false, ['y'], ['en', 'd']],
    ],
  );
  // The same after a bare `for`, a `case` and a block that ends in `end`.
  for (const [body, lines] of [
    ['always @(a) for (int i = 0; i < 4; i = i + 1) q[i] = a;', 2],
    ['always @(a) case (a) 1\'b0: q = 1; default: q = 2; endcase', 2],
    ['always @(a) if (a) begin\n    q = 1;\n  end else begin\n    q = 2;\n  end', 6],
  ] as const) {
    const r = parseSource(
      '/w/t.sv',
      `module m (input wire a, output reg [3:0] q);\n  ${body}\n  assign q[0] = 1'b0;\nendmodule`,
    ).modules[0];
    const last = r.assigns[r.assigns.length - 1];
    assert.equal(last.inAlways, false, body);
    assert.equal(last.range.start.line, lines, body);
  }
});

test('parser: a name that only gates a block is read by it', () => {
  // The conditions of `if`, `case`, `while`, `repeat`, `wait` and the
  // assertions were dropped on the floor, so `en` in `if (en) q <= d;` had no
  // reader anywhere and the nets view called it unused.
  const m = parseSource(
    '/w/t.sv',
    `module m (input wire clk, input wire en, input wire [1:0] s, input wire d, output reg q);
  always @(posedge clk) begin : b
    if (en) q <= d;
    while (en && !q) q <= d;
    repeat (2) q <= d;
    case (s)
      2'd0: q <= d;
      default: q <= en;
    endcase
    wait (en);
    assert (en) else $error("no");
  end
endmodule`,
  ).modules[0];
  const conditions = m.refs.filter((r) => r.context === 'condition');
  assert.deepEqual([...new Set(conditions.map((r) => r.fullPath))].sort(), ['en', 'q', 's']);
  assert.ok(conditions.every((r) => !r.isWrite), 'a condition reads');
  // They are reads, and the writes are still the ones the statements make.
  assert.deepEqual(m.assigns.filter((a) => a.inAlways).map((a) => a.lhs[0].fullPath), ['q', 'q', 'q', 'q', 'q']);
});

test('parser: the head of a for declares its loop variable', () => {
  // `for (int i = 0; i < 4; i = i + 1)` declares `i`; a loop over a variable
  // declared elsewhere only assigns it. Both are read in the condition, so the
  // first form needs the declaration to be there.
  const m = parseSource(
    '/w/t.sv',
    `module m (input wire a, output reg [3:0] q);
  integer j;
  always @(a) begin : b
    for (int i = 0; i < 4; i = i + 1) q[i] = a;
    for (j = 0; j < 4; j = j + 1) q[j] = a;
  end
endmodule`,
  ).modules[0];
  assert.deepEqual(m.decls.filter((d) => d.kind === 'integer').map((d) => d.name), ['j', 'i']);
  const conditions = m.refs.filter((r) => r.context === 'condition').map((r) => r.fullPath);
  assert.ok(conditions.includes('i') && conditions.includes('j'), conditions.join(','));
});

test('parser: foreach reads the array and declares the loop variables', () => {
  // The two halves of `foreach (mem.bank[i, j])` are opposite: the array is
  // read, and `i` and `j` are variables the loop declares.
  const m = parseSource(
    '/w/t.sv',
    `module m (input wire a, output reg [3:0] q, output wire y);
  logic [3:0][1:0] arr;
  always_comb begin : b
    foreach (arr[i, j]) q[i] = arr[i][j];
    y = a;
  end
endmodule`,
  ).modules[0];
  assert.deepEqual(m.decls.filter((d) => d.kind === 'integer').map((d) => d.name), ['i', 'j']);
  const conditions = m.refs.filter((r) => r.context === 'condition').map((r) => r.fullPath);
  assert.deepEqual(conditions, ['arr'], 'only the array is read');
  assert.deepEqual(m.assigns.map((a) => a.lhs[0].fullPath), ['q', 'y']);
});

test('parser: the text of a procedural assignment is the assignment', () => {
  // The text of the two sides is what the generator writes, and a statement
  // inside `if` or `for` does not start at its left-hand side: `q <= d;` after
  // an `if` reported an empty left-hand side, and `q[i] <= d` reported `[i`.
  const m = parseSource(
    '/w/t.sv',
    `module m (input wire clk, input wire d, input wire [3:0] a, output reg [3:0] q);
  always @(posedge clk) begin : b
    if (a[0]) q[1] <= d;
    else q <= {a[2], 1'b0};
    for (int i = 0; i < 4; i = i + 1) q[i] = a[i];
    if (a[1]) q[3] <= a[2] ? 1'b1 : 1'b0;
  end
endmodule`,
  ).modules[0];
  assert.deepEqual(
    m.assigns.map((a) => [a.lhsText, a.rhsText]),
    [
      ['q[1]', 'd'],
      ['q', "{a[2], 1'b0}"],
      ['q[i]', 'a[i]'],
      ['q[3]', "a[2] ? 1'b1 : 1'b0"],
    ],
  );
  // Every one of them is text the parser can write back out unchanged.
  for (const a of m.assigns) {
    assert.doesNotMatch(`${a.lhsText};`, /;;|\s;/);
  }
});

test('parser: the condition of a generate if is a read of the module', () => {
  // `if (WIDTH > 4)` picks a variant, and the only use of `WIDTH` in the module
  // may be that condition. It used to be skipped with the head of the construct:
  // no reference, no highlight, nothing for find-references. A macro in the same
  // position is not a name, so it produces nothing.
  const m = parseSource(
    '/w/g.sv',
    `module m #(parameter int WIDTH = 8, parameter int MODE = 2) (input wire [WIDTH-1:0] a, output wire y);
  generate
    if (WIDTH > 4) begin : wide
      assign y = a[0];
    end else begin : narrow
      assign y = a[1];
    end
    if (\`SYNTHESIS) begin : syn
      wire keep;
    end
    case (MODE)
      2'd0: begin : m0 wire z; end
      default: begin : md wire z; end
    endcase
  endgenerate
endmodule`,
  ).modules[0];
  const gen = m.refs.filter((r) => r.context === 'generate').map((r) => r.fullPath).sort();
  assert.deepEqual(gen, ['MODE', 'WIDTH'], 'the if condition and the case selector');
  assert.equal(m.refs.some((r) => r.fullPath.startsWith('`')), false, 'a macro is not a name');
  // Both branches are still parsed, and the labels still name them.
  assert.deepEqual(
    m.assigns.map((a) => a.generate),
    ['wide', 'narrow'],
  );
});

test('parser: a range before the name is packed, one after it is not', () => {
  // The two used to land in the same list, so the second range of a packed
  // declaration was written out as an array after the name
  // (`wire [3:0] [7:0] w;`) and the first was the only one counted as a width.
  const m = parseSource(
    '/w/p.sv',
    `module m (input logic [3:0][7:0] a, input wire [3:0] b [0:1], input wire [3:0][7:0] c [0:1]);
  logic [3:0][7:0] buf;
  wire [7:0] mem [0:3];
  logic [7:0] flat;
  assign a = b;
endmodule`,
  ).modules[0];
  const rng = (r: { msb: { raw: string }; lsb: { raw: string } } | undefined) =>
    r ? r.msb.raw + ':' + r.lsb.raw : '-';
  const packed = m.decls.find((d) => d.name === 'buf')!;
  const packedFirst = packed.dataType as { range: { msb: { raw: string }; lsb: { raw: string } } };
  assert.equal(rng(packedFirst.range), '3:0', 'the first packed range is the type');
  assert.deepEqual(packed.packedDims?.map(rng), ['7:0'], 'the rest is packed too');
  assert.equal(packed.dims, undefined, 'and nothing is an array');
  const mem = m.decls.find((d) => d.name === 'mem')!;
  const memFirst = mem.dataType as { range: { msb: { raw: string }; lsb: { raw: string } } };
  assert.equal(rng(memFirst.range), '7:0');
  assert.deepEqual(mem.dims?.map(rng), ['0:3'], 'an unpacked dimension');
  assert.equal(mem.packedDims, undefined);
  const port = (n: string) => m.ports.find((p) => p.name === n)!;
  assert.deepEqual(port('a').packed?.map(rng), ['7:0'], 'a packed port');
  assert.equal(port('a').unpacked, undefined);
  assert.deepEqual(port('b').unpacked?.map(rng), ['0:1']);
  assert.equal(port('b').packed, undefined);
  assert.deepEqual(port('c').packed?.map(rng), ['7:0'], 'both, in that order');
  assert.deepEqual(port('c').unpacked?.map(rng), ['0:1']);
  assert.equal(port('flat')?.name, undefined, 'no such port');
});
