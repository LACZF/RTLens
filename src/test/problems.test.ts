import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { HdlIndex } from '../core/index';
import { collectProblems, guessedDirections, undeclaredNames, unresolvedInstances } from '../core/problems';

function ctx(...files: [string, string][]): HdlIndex {
  const index = new HdlIndex();
  for (const [file, src] of files) {
    index.addFile(file, src);
  }
  return index;
}

const CHILD = `module child (input wire i, output wire o);
endmodule`;

test('problems: a missing module is an error on the module type name', () => {
  const index = ctx(['/w/a.v', `${CHILD}\nmodule top (input wire a, output wire y);\n  child u (.i(a), .o(y));\n  ghost u2 (.i(a), .o(y));\nendmodule`]);
  const found = unresolvedInstances(index);
  assert.equal(found.length, 1);
  assert.equal(found[0].label, 'Module "ghost" not found');
  assert.equal(found[0].severity, 'error');
  // The range points at `ghost`, not at the instance label, so revealing the
  // problem lands on the name the user has to fix.
  const line = 4;
  assert.equal(found[0].line, line);
  assert.equal(found[0].character, 2);
  assert.ok(found[0].tooltip.includes('Instantiated as "u2"'));
});

test('problems: one generate loop reports the missing module once', () => {
  const index = ctx(['/w/g.v', 'module top;\ngenvar i;\ngenerate\nfor (i = 0; i < 4; i = i + 1) begin : g\n  ghost u ();\nend\nendgenerate\nendmodule']);
  assert.equal(unresolvedInstances(index).length, 1, 'four instances, one line, one problem');
});

test('problems: a guessed port direction is a warning', () => {
  // A non-ANSI port list only tells the direction if the body declares it.
  const index = ctx(['/w/d.v', 'module top (a, b);\n  input wire a;\n  output wire b;\nendmodule']);
  assert.deepEqual(guessedDirections(index), [], 'the body declares both');

  const half = ctx(['/w/f.v', 'module top (input wire a, b);\n  assign a = b;\nendmodule']);
  const found = guessedDirections(half);
  assert.deepEqual(found.map((p) => p.label), ['Direction of "b" guessed']);
  assert.equal(found[0].severity, 'warning');
  assert.ok(found[0].tooltip.includes('assumed input'));
  assert.equal(found[0].line, 0);

  const ansi = ctx(['/w/e.v', 'module top (input wire a, output wire b);\nendmodule']);
  assert.deepEqual(guessedDirections(ansi), [], 'an ANSI list is unambiguous');
});

test('problems: a bus port is not a guessed direction, even across files', () => {
  // Same file: the parser knows `bus_if` opens an interface, so the port is
  // built without a guess.
  const sameFile = ctx(['/w/a.sv', 'interface bus_if; logic v; endinterface\nmodule top (bus_if b, input wire a);\nendmodule']);
  assert.deepEqual(guessedDirections(sameFile), [], 'the interface is in the same file');

  // Another file: while parsing `b` the interface does not exist yet, so the
  // header item falls back to a placeholder. An interface port has no
  // direction of its own, so the warning would be a false positive.
  const crossFile = ctx(
    ['/w/if.sv', 'interface bus_if; logic v; endinterface'],
    ['/w/m.sv', 'module producer (output bus_if b); endmodule\nmodule top (bus_if b, input wire a);\n  assign a = b.v;\nendmodule'],
  );
  assert.deepEqual(guessedDirections(crossFile), [], 'the interface is found in the index');
  // A type that is not an interface anywhere is still reported - the new
  // exemption is keyed on the type resolving to one.
  const unknown = ctx(
    ['/w/if2.sv', 'interface bus_if; logic v; endinterface'],
    ['/w/u.sv', 'module top (bus_ifx b, input wire a);\nendmodule'],
  );
  assert.deepEqual(guessedDirections(unknown).map((p) => p.label), ['Direction of "b" guessed']);
});

test('problems: a name that is used but not declared is a warning', () => {
  const index = ctx(['/w/u.v', 'module top (input wire [7:0] a);\n  wire y;\n  assign y = widht;\nendmodule']);
  const found = undeclaredNames(index);
  assert.equal(found.length, 1);
  assert.equal(found[0].label, '"widht" is not declared');
  assert.equal(found[0].severity, 'warning');
  assert.equal(found[0].line, 2);
});

test('problems: names that are fine are not reported', () => {
  const index = ctx(
    ['/w/c.v', 'package cfg;\n  localparam int K = 2;\nendpackage'],
    [
      '/w/m.v',
      `package cfg;
  localparam int K = 2;
endpackage
module child (input wire i);
endmodule
module top (input wire a);
  typedef logic [7:0] byte_t;
  byte_t data;
  wire [cfg::K-1:0] tag;
  wire [7:0] w;
  assign w = a[0] + $clog2(8);
  child u (.i(data));
endmodule`,
    ],
  );
  assert.deepEqual(undeclaredNames(index), [], 'nothing to report in valid code');
  assert.deepEqual(unresolvedInstances(index), []);
  assert.deepEqual(guessedDirections(index), []);
});

test('problems: one message per unresolved module, not one per connected name', () => {
  // The names reach into a module that is not in the index. Listing them as
  // undeclared as well would bury the one message that explains why.
  const index = ctx(['/w/v.v', 'module top (input wire a);\n  wire x;\n  assign x = a;\n  ghost u (.i(x), .o(nowhere));\nendmodule']);
  const found = collectProblems(index);
  assert.deepEqual(found.map((p) => p.kind), ['unresolved-module']);
});

test('problems: a declaration in another module does not make a name visible', () => {
  const index = ctx(
    ['/w/a.v', 'module other;\n  wire hidden;\nendmodule'],
    ['/w/b.v', 'module top (input wire a);\n  wire y;\n  assign y = hidden;\n  assign y = a;\nendmodule'],
  );
  const found = undeclaredNames(index);
  assert.deepEqual(found.map((p) => p.label), ['"hidden" is not declared']);
  assert.ok(found[0].tooltip.includes('declared in another module'));
});

test('problems: the list is ordered by file and line', () => {
  const index = ctx(
    ['/w/b.v', 'module two (a);\n  input wire a;\n  assign a = missing_b;\nendmodule'],
    ['/w/a.v', 'module one (a);\n  input wire a;\n  assign a = missing_a;\nendmodule'],
  );
  const found = collectProblems(index);
  assert.deepEqual(
    found.map((p) => `${p.file}:${p.line}`),
    ['/w/a.v:2', '/w/b.v:2'],
  );
});

test('problems: a design that keeps its types in a header is not reported', () => {
  // Every variable of a shared type used to be reported as undeclared, once per
  // use: the declaration lives in a file the parser of this one cannot see. A
  // warning on correct code is worse than no warning, so a name that is in a
  // type position is left alone.
  const index = ctx(
    ['/w/types.svh', 'typedef logic [7:0] byte_t;\n'],
    [
      '/w/t.v',
      `module top (input wire clk, output wire [7:0] o);
  byte_t data;
  byte_t buf [0:3];
  sub u;
  always_ff @(posedge clk) begin
    data <= data + 1;
    o <= data[3:0];
  end
endmodule
module sub (input wire a); endmodule`,
    ],
  );
  assert.deepEqual(collectProblems(index), [], 'nothing to report');
});

test('problems: a name that is neither declared nor used as a type is still reported', () => {
  // The suppression above is narrow: it applies to names in a type position, and
  // to the implicit wire a continuous assignment creates. A procedural
  // assignment to an undeclared name is a real mistake, and stays reported.
  const index = ctx(
    ['/w/types.svh', 'typedef logic [7:0] byte_t;\n'],
    [
      '/w/t.v',
      `module top (input wire clk, output wire o);
  byte_t data;
  always_comb oops = data;
endmodule`,
    ],
  );
  const found = undeclaredNames(index);
  assert.deepEqual(
    found.map((p) => p.label),
    ['"oops" is not declared'],
  );
});

test('problems: an implicit wire from a continuous assignment is not reported', () => {
  // `assign w = a & b;` with no declaration of `w` is legal Verilog: the
  // language declares a one-bit wire. Reporting it was a warning on valid code.
  const index = ctx([
    '/w/t.v',
    `module sub (input wire i, output wire o); endmodule
module top (input wire a, input wire b);
  sub u (.i(a), .o(b));
  assign y = a & b;
  assign z [0] = a;
  assign u.o = a;
endmodule`,
  ]);
  assert.deepEqual(collectProblems(index), [], 'nothing to report');
  const def = index.modulesInFile('/w/t.v').find((m) => m.name === 'top')!;
  // The net exists, with the range of the name that used it, so hover, the
  // netlist and rename all see it.
  const implicit = def.decls.filter((d) => d.implicit);
  // `u.o` is a hierarchical write, not a declaration of `o`, so it does not
  // produce a net named `o` here.
  assert.deepEqual(implicit.map((d) => d.name), ['y', 'z']);
  assert.equal(implicit[0].kind, 'net');
  for (const d of implicit) {
    assert.equal(d.range.start.line, d.nameRange.start.line);
  }
});

test('problems: a name imported from a package in another file is not reported', () => {
  // `import cfg::K;` declares nothing here, but it makes K visible. Reporting it
  // was a warning on a design that compiles.
  const index = ctx(
    ['/w/cfg.sv', 'package cfg; parameter int K = 4; typedef logic [7:0] b_t; endpackage\n'],
    [
      '/w/top.sv',
      `import cfg::K;
import cfg::*;
module top (input wire [K-1:0] a, output wire y);
  assign y = a[K-1];
endmodule`,
    ],
  );
  assert.deepEqual(collectProblems(index), [], 'nothing to report');

  // The kind is settled too, so the name is coloured as the parameter it is and
  // hovering it reaches the package.
  const mod = index.modulesInFile('/w/top.sv')[0];
  const refs = new Map(mod.refs.map((r) => [r.name, r.kind]));
  assert.equal(refs.get('K'), 'param');
  const hit = index.findDecl(mod, 'K');
  assert.equal(hit?.kind, 'param');
  assert.equal(hit?.owner.name, 'cfg', 'the package declares it');
  assert.equal(hit?.owner.file, '/w/cfg.sv');
});

test('problems: an import statement inside a module body still counts', () => {
  const index = ctx(
    ['/w/cfg.sv', 'package cfg; parameter int K = 4; endpackage\n'],
    [
      '/w/top.sv',
      `module top;
  import cfg::K;
  localparam int L = K;
endmodule`,
    ],
  );
  assert.deepEqual(collectProblems(index), []);
  const mod = index.modulesInFile('/w/top.sv')[0];
  assert.deepEqual(
    mod.imports.map((i) => `${i.pkg}::${i.wildcard ? '*' : i.names.map((n) => n.name)}`),
    ['cfg::K'],
  );
});

test('problems: an import that names no package is ignored', () => {
  // A DPI import names an external function, not a package, so it declares
  // nothing to look up.
  const index = ctx([
    '/w/top.sv',
    `import "DPI-C" function int c_add(input int a);
module top; endmodule`,
  ]);
  const mod = index.modulesInFile('/w/top.sv')[0];
  assert.deepEqual(mod.imports, []);
});

test('problems: an imported name the package does not declare is still reported', () => {
  const index = ctx(
    ['/w/cfg.sv', 'package cfg; parameter int K = 4; endpackage\n'],
    ['/w/top.sv', 'import cfg::MISSING;\nmodule top; localparam int L = MISSING; endmodule'],
  );
  assert.deepEqual(
    undeclaredNames(index).map((p) => p.label),
    ['"MISSING" is not declared'],
  );
});

test('problems: a name imported from a package in this file takes the kind it has there', () => {
  // The parser can see this package, so it settles the kind itself; the index
  // fixup in `addFile` is only needed for a package in another file.
  const index = ctx([
    '/w/local.sv',
      `package cfg;
  parameter int K = 4;
  typedef logic [7:0] b_t;
  function int twice(input int x);
    return x * 2;
  endfunction
endpackage
import cfg::*;
module child (input wire i, output wire o);
  assign o = i;
endmodule
module top (output wire y);
  localparam int L = K;
  localparam int K = 2;
  localparam int b = 1;
  b_t data;
  child c (.i(K), .o(y));
  assign y = data[K-1] + twice(K) + c.b;
endmodule
module w (input wire i, output wire o);
  assign o = i;
endmodule
module shadowed (output wire y);
  wire w;
  w inst (.i (1'b0), .o (y));
endmodule`,
  ]);
  assert.deepEqual(collectProblems(index), []);
  const mod = index.modulesInFile('/w/local.sv').find((m) => m.name === 'top')!;
  const kinds = new Map(mod.refs.map((r) => [r.name, r.kind]));
  assert.equal(kinds.get('K'), 'param');
  assert.equal(kinds.get('b_t'), 'type');
  assert.equal(kinds.get('twice'), 'function');
  // A hierarchical reference is left as it was: its root resolves through the
  // instance table, not through the package import, so the fixup does not touch
  // it.
  const childStep = mod.refs.find((r) => r.fullPath === 'c.b');
  assert.equal(childStep?.kind, 'signal');
  // A name the module declares and a module of the same name: the instance type
  // is a module reference and the wire is a signal. The fixup only touches names
  // the parser left unknown, so the instance type keeps its own kind.
  const shadow = index.modulesInFile('/w/local.sv').find((m) => m.name === 'shadowed')!;
  const byName = shadow.refs.filter((r) => r.name === 'w');
  assert.deepEqual(
    byName.map((r) => r.kind),
    ['signal', 'module'],
    'the wire and the instance type of the same name keep their kinds',
  );
  // A local parameter of the same name keeps the module's own declaration, so
  // the import does not take it over.
  assert.equal(index.findDecl(mod, 'K')?.owner.name, 'top');
  assert.equal(index.findDecl(mod, 'twice')?.owner.name, 'cfg');
});

test('problems: a name the import does not list is still reported', () => {
  // The import is a list, not a shortcut: importing one name from a package
  // makes only that name visible.
  const index = ctx(
    ['/w/cfg.sv', 'package cfg; parameter int K = 4; parameter int J = 8; endpackage'],
    ['/w/top.sv', 'import cfg::J;\nmodule top; localparam int L = K; endmodule'],
  );
  assert.deepEqual(
    undeclaredNames(index).map((p) => p.label),
    ['"K" is not declared'],
  );
});

test('problems: a class imported from a package is not reported', () => {
  const index = ctx(
    [
      '/w/cfg.sv',
      `class Packet;
  int id;
endclass
package cfg;
  parameter int K = 4;
endpackage`,
    ],
    ['/w/top.sv', `import cfg::K;
import cfg::Packet;
module top;
  localparam int L = K;
  Packet p;
endmodule`],
  );
  assert.deepEqual(collectProblems(index), []);
  // A class is a scope of its own, so it resolves as a module reference.
  const mod = index.modulesInFile('/w/top.sv')[0];
  assert.equal(index.findDecl(mod, 'Packet'), undefined, 'not a package member');
  assert.equal(index.resolveModule('Packet', mod.file)?.kind, 'class');
});

test('problems: a parameter in the module header is not a port', () => {
  // `module m (parameter int W = 8, input wire [W-1:0] a, output wire y)` and
  // the split form `module m (parameter int W = 8) (input ..., output ...)` are
  // both legal. The header item went to the ANSI port parser, which guessed it
  // a direction: correct code reported "Direction of W guessed", W was missing
  // as a parameter, and in the split form the real ports were never read, so
  // `a` was reported as not declared too.
  for (const header of [
    'module m (parameter int W = 8, input wire [W-1:0] a, output wire [W-1:0] y);',
    'module m (parameter int W = 8) (input wire [W-1:0] a, output wire [W-1:0] y);',
  ]) {
    const index = new HdlIndex();
    index.addFile('/w/t.sv', `${header}\n  assign y = a;\nendmodule`);
    assert.deepEqual(collectProblems(index), [], header);
    const m = index.resolveModule('m')!;
    assert.deepEqual(m.params.map((p) => `${p.name}=${p.value?.value}`), ['W=8'], header);
    assert.deepEqual(m.ports.map((p) => p.name), ['a', 'y'], header);
  }
});

test('problems: a named procedural block and its local variables are quiet', () => {
  // The block label and the local declaration both used to be reported:
  // `begin : b` gave "b is not declared", and a `logic t;` in the block left
  // every use of `t` with nothing to resolve to.
  for (const body of [
    'always @(posedge a) begin : b\n    y = a;\n  end',
    'always @(posedge a) begin : b\n    logic t;\n    t = a;\n    y = t;\n  end',
    'always @(posedge a) begin : outer\n    begin : inner\n      int i;\n      i = a;\n      y = i != 0;\n    end\n  end',
    'always @(posedge a) fork : f\n    y = a;\n  join',
    'initial begin : i\n    logic [3:0] c;\n    c = 4\'d0;\n    y = c != 0;\n  end',
    'always_comb case (a) 2\'d0: begin : zero\n    logic t;\n    t = 1;\n    y = t;\n  end default: y = 0; endcase',
    'always @(posedge a) begin : b\n    string s;\n    s = "x";\n    y = a;\n  end',
  ]) {
    const index = new HdlIndex();
    const head = body.includes("case (a)") ? 'input wire [1:0] a' : 'input wire a';
    index.addFile('/w/t.sv', `module m (${head}, output wire y);\n  ${body}\nendmodule`);
    assert.deepEqual(collectProblems(index), [], body);
  }
});

test('problems: a local variable of a module is not an undeclared name', () => {
  // A variable declared in a procedural block belongs to the module, so it
  // resolves like any other signal: a use of it before the block, and a read
  // of a port that the block writes, both stay quiet.
  const index = new HdlIndex();
  index.addFile(
    '/w/t.sv',
    `module m (input wire a, output wire y);
  assign y = tmp;
  always @(posedge a) begin : b
    logic tmp;
    tmp = a;
  end
endmodule`,
  );
  assert.deepEqual(collectProblems(index), []);
  const m = index.resolveModule('m')!;
  assert.ok(m.decls.some((d) => d.name === 'tmp'), 'the local is a declaration of the module');
});

test('problems: loop heads declare what the language declares', () => {
  // `for (int i = 0; ...)` and `foreach (arr[i, j])` declare their loop
  // variables. Reading the head as a condition without reading the declaration
  // in it would report every one of them as undeclared.
  for (const body of [
    'always @(a) for (int i = 0; i < 4; i = i + 1) q[i] = a;',
    'always @(a) for (integer i = 0; i < 4; i++) q[i] = a;',
    'always @(a) for (var logic [1:0] i = 0; i < 2; i = i + 1) q[i] = a;',
    'always @(a) for (genvar i = 0; i < 4; i = i + 1) begin : l\n    q[i] = a;\n  end',
    'always_comb begin : b\n  foreach (arr[i, j]) q[i] = arr[j];\nend',
    'always_comb begin : b\n  foreach (arr[i][j]) q[i] = arr[i][j];\nend',
    'always_comb begin : b\n  foreach (u_sub.mem[i]) q[i] = u_sub.mem[i];\nend',
    'always_comb begin : b\n  foreach (tb::arr[i]) q[i] = tb::arr[i];\nend',
    'always @(a) begin : b\n  for (int i = 0; i < 2; i = i + 1)\n    for (int j = 0; j < 2; j = j + 1) q[i * 2 + j] = a;\nend',
  ]) {
    const index = new HdlIndex();
    index.addFile(
      '/w/t.sv',
      `module sub; logic [3:0] mem; endmodule
module m (input wire a, output reg [3:0] q);
  logic [3:0][1:0] arr;
  sub u_sub ();
  ${body}
  assign q = a;
endmodule`,
    );
    assert.deepEqual(collectProblems(index), [], body);
  }
});

test('problems: a name inside a select is read the way the name around it is', () => {
  // The index of a select is part of the expression, so it is read with the
  // same rules: `bus_if.W` is one use of an interface parameter, `cfg::N` one
  // use of a package parameter, and `$clog2` a system call. Splitting them into
  // loose names reports the last part of a qualified path as undeclared.
  const index = ctx([
    '/w/t.sv',
    `interface bus_if #(parameter int W = 8);
logic [W-1:0] data;
endinterface
package cfg;
parameter int N = 4;
endpackage
module m (bus_if b, output wire dout);
parameter int DEPTH = 8;
logic [DEPTH-1:0] q;
  assign dout = b.data[bus_if.W-1] | b.data[$clog2(DEPTH)-1] | q[cfg::N];
endmodule`,
  ]);
  assert.deepEqual(collectProblems(index), []);
  const refs = index.resolveModule('m')!.refs;
  const fullPaths = refs.filter((r) => !r.isDecl).map((r) => r.fullPath);
  for (const path of ['bus_if.W', 'cfg::N', '$clog2', 'DEPTH']) {
    assert.ok(fullPaths.includes(path), `${path} is one reference, got ${fullPaths.join(' ')}`);
  }
  // A qualified name has no bare head to be missing: nothing in it is reported.
  assert.deepEqual(
    refs.filter((r) => r.fullPath === 'W'),
    [],
    'the W of bus_if.W is part of the path, not a name of its own',
  );
});

test('problems: an interface port is a port, not a guessed direction', () => {
  // `module v (bus_if b)` writes no direction keyword: the direction of an
  // interface port comes from its modport, not from the port list, so there is
  // nothing to guess and nothing to warn about. A name that is not an interface
  // still has no direction and is reported.
  const cases: [string, string[]][] = [
    ['interface bus_if;\n  logic d;\nendinterface\nmodule v (bus_if b, input wire c);\n  assign c = b.d;\nendmodule', []],
    ['module v (bus_if.slave b, input wire c);\n  assign c = b.d;\nendmodule\ninterface bus_if;\n  logic d;\nendinterface', []],
    [
      'typedef struct packed { logic a; } pkt_t;\nmodule v (pkt_t b, input wire c);\n  assign c = b.a;\nendmodule',
      ['Direction of "b" guessed'],
    ],
  ];
  for (const [src, expected] of cases) {
    const index = ctx(['/w/t.sv', src]);
    assert.deepEqual(guessedDirections(index).map((p) => p.label), expected, src);
  }
});
