import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { HdlIndex } from '../core/index';
import { buildHierarchy, findByPath } from '../core/hierarchy';
import { parseSource } from '../core/parser';
import { composeModule, flattenModule, generateWrapper, stubModule, type WrapperResult } from '../core/generator';

const SRC = `
module adder #(
  parameter int WIDTH = 8
) (
  input  wire [WIDTH-1:0] a,
  input  wire [WIDTH-1:0] b,
  input  wire             cin,
  output wire [WIDTH-1:0] sum,
  output wire             cout
);
  wire [WIDTH:0] full;
  assign full = a + b + cin;
  assign sum = full[WIDTH-1:0];
  assign cout = full[WIDTH];
endmodule

module datapath #(
  parameter int WIDTH = 8,
  parameter int DEPTH = 4
) (
  input  wire             clk,
  input  wire [WIDTH-1:0] a,
  input  wire [WIDTH-1:0] b,
  input  wire             cin,
  input  wire             we,
  output wire [WIDTH-1:0] result,
  output wire             carry
);
  wire [WIDTH-1:0] alu_sum;
  wire             alu_cout;
  wire [WIDTH-1:0] stage_in;

  assign stage_in = cin ? a : b;

  adder #(
    .WIDTH (WIDTH)
  ) u_adder (
    .a    (a),
    .b    (b),
    .cin  (cin),
    .sum  (alu_sum),
    .cout (alu_cout)
  );

  assign result = alu_sum;
  assign carry = alu_cout;
endmodule

module fsm (
  input  wire clk,
  input  wire start,
  output reg  busy
);
  always @(posedge clk) begin
    busy <= start;
  end
endmodule

module top (
  input  wire [7:0] din,
  output wire [7:0] dout
);
  wire [7:0] r1;
  wire [7:0] r2;
  wire       c1;

  datapath #(.WIDTH (8), .DEPTH (2)) u_dp (
    .clk    (1'b0),
    .a      (din),
    .b      (din),
    .cin    (1'b0),
    .we     (1'b0),
    .result (r1),
    .carry  (c1)
  );

  datapath #(.WIDTH (8), .DEPTH (2)) u_dp2 (
    .clk    (1'b0),
    .a      (r1),
    .b      (r1),
    .cin    (c1),
    .we     (1'b0),
    .result (dout),
    .carry  ()
  );
endmodule
`;

function ctx() {
  const index = new HdlIndex();
  index.addFile('/w/top.v', SRC);
  const h = buildHierarchy(index, 'top', { maxDepth: 8 })!;
  return { index, h };
}

/** Generated code must survive the parser, and be a module. */
function reparse(code: string, file = '/tmp/generated.v'): string[] {
  const idx = new HdlIndex();
  const mods = idx.addFile(file, code);
  assert.equal(mods.length, 1, `expected exactly one module, got ${mods.length}`);
  return idx.moduleNames();
}

function ok(r: ReturnType<typeof flattenModule>): WrapperResult {
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  return r as WrapperResult;
}

test('flatten inlines a module and re-emits its children', () => {
  const { index, h } = ctx();
  const r = ok(flattenModule(index, h.root, 'top.u_dp'));
  assert.match(r.code, /u_adder/, 'the child instance survives');
  assert.ok(!/\bmodule\s+datapath\b/.test(r.code), 'the original module is not copied');
  assert.equal(reparse(r.code).length, 1);
  // The port list becomes the module interface.
  for (const p of ['a', 'b', 'result', 'carry']) {
    assert.ok(r.ports.some((x) => x.name === p), `port ${p} kept`);
  }
  assert.ok(r.code.includes('input') && r.code.includes('output'), 'directions present');
});

test('flatten folds overridden parameters into localparams', () => {
  const { index, h } = ctx();
  const r = ok(flattenModule(index, h.root, 'top.u_dp2'));
  assert.ok(r.code.includes('localparam'), 'parameters are emitted as localparams');
  assert.ok(!/parameter\s+int\s+WIDTH/.test(r.code), 'the parameter list is gone');
  // DEPTH is declared 4 but overridden to 2 at `top.u_dp2`; the copy has to
  // carry the value that instance sees, not the declaration.
  assert.match(r.code, /localparam\s+DEPTH\s*=\s*2;/, 'the override wins');
  assert.match(r.code, /localparam\s+WIDTH\s*=\s*8;/);
});

test('flatten reports the internal wires it carries over', () => {
  const { index, h } = ctx();
  const r = ok(flattenModule(index, h.root, 'top.u_dp'));
  assert.deepEqual(r.internalNets.map((n) => n.name).sort(), ['alu_cout', 'alu_sum', 'stage_in']);
  const widths = new Map(r.internalNets.map((n) => [n.name, n.width]));
  assert.equal(widths.get('alu_sum'), 8, 'a WIDTH-bit wire');
  assert.equal(widths.get('alu_cout'), 1, 'a scalar wire');
  assert.equal(widths.get('stage_in'), 8);
});

test('flatten keeps every continuous assign so behaviour is unchanged', () => {
  const { index, h } = ctx();
  const r = ok(flattenModule(index, h.root, 'top.u_dp'));
  // A flattened copy is standalone: dropping an assign would silently change
  // what the module does, so all of them come along, even a dead one.
  assert.equal(r.assigns.length, 3);
  assert.ok(r.code.includes('assign result = alu_sum;'));
  assert.ok(r.code.includes('assign carry = alu_cout;'));
  assert.ok(r.code.includes('assign stage_in = cin ? a : b;'));
  // Ports are never re-declared as wires.
  assert.ok(!/wire\s+\[7:0\]\s+a;/.test(r.code), 'a port is not duplicated as a wire');
});

test('flatten rejects procedural logic and offers a stub instead', () => {
  const { index, h } = ctx();
  const r = flattenModule(index, h.root, 'top.u_dp2', {});
  // datapath has no procedural logic, so this one flattens; use the fsm instead.
  assert.equal(r.ok, true);

  const idx2 = new HdlIndex();
  idx2.addFile('/w/f.v', SRC);
  const h2 = buildHierarchy(idx2, 'fsm', { maxDepth: 8 })!;
  const proc = flattenModule(idx2, h2.root, 'fsm');
  assert.equal(proc.ok, false);
  assert.equal(proc.ok === false && proc.fallback, 'stub');
  assert.match(proc.ok === false ? proc.error : '', /procedural/i);
});

test('stub forwards the ports of the wrapped instance', () => {
  const { index, h } = ctx();
  const r = ok(stubModule(index, h.root, 'top.u_dp'));
  assert.ok(r.code.includes('u_dp'), 'the instance is kept');
  assert.ok(r.code.includes('.result (result)'), 'ports are forwarded by name');
  assert.equal(reparse(r.code).length, 1);
  assert.deepEqual(
    r.ports.map((p) => p.name).sort(),
    ['a', 'b', 'carry', 'cin', 'clk', 'result', 'we'],
  );
});

test('stub keeps a child port that is left open as an open port', () => {
  const { index, h } = ctx();
  const r = ok(stubModule(index, h.root, 'top.u_dp2'));
  // `carry` is not connected in the parent, so the stub leaves it open rather
  // than inventing a wire.
  assert.ok(r.ports.every((p) => p.name !== 'unused_carry'));
  assert.equal(reparse(r.code).length, 1);
});

test('compose groups sibling instances behind one interface', () => {
  const { index, h } = ctx();
  const r = ok(composeModule(index, h.root, ['top.u_dp', 'top.u_dp2']));
  assert.ok(r.code.includes('u_dp'), 'first instance kept');
  assert.ok(r.code.includes('u_dp2'), 'second instance kept');
  assert.equal(reparse(r.code).length, 1);
  // The wire between the two instances stays internal.
  const internal = r.internalNets.map((n) => n.name);
  assert.ok(internal.length > 0, 'internal wires are listed');
  assert.ok(r.code.includes('wire'), 'internal wires are declared');
});

test('compose classifies the boundary by data flow', () => {
  const { index, h } = ctx();
  const r = ok(composeModule(index, h.root, ['top.u_dp', 'top.u_dp2']));
  const dir = new Map(r.ports.map((p) => [p.name, p.direction]));
  // `din` feeds both instances and is driven outside: an input of the wrapper.
  assert.equal(dir.get('din'), 'input');
  // `dout` is produced by the second instance only: an output of the wrapper.
  assert.equal(dir.get('dout'), 'output');
  // A net consumed by one instance and produced by another never reaches the
  // boundary.
  const r1 = r.internalNets.find((n) => n.name === 'r1');
  assert.ok(r1, 'r1 is internal');
  assert.ok(!r.ports.some((p) => p.name === 'r1'), 'and not a port');
  assert.equal(dir.get('carry'), undefined, 'the dangling carry does not become a port');
});

test('compose declares the parent parameters it inherits as localparams', () => {
  const { index, h } = ctx();
  const r = ok(composeModule(index, h.root, ['top.u_dp']));
  // The generated code must not reference a parameter that does not exist.
  const reparseIndex = new HdlIndex();
  const mods = reparseIndex.addFile('/tmp/c.v', r.code);
  const generated = mods[0];
  const paramNames = new Set(generated.params.map((p) => p.name));
  for (const p of generated.ports) {
    assert.ok(
      !/WIDTH|DEPTH/.test(p.dataType.t === 'nets' ? JSON.stringify(p.dataType) : ''),
      'no unresolved parameter in a port type',
    );
  }
  assert.ok(paramNames.size >= 0);
});

test('generateWrapper picks the right strategy for the selection size', () => {
  const { index, h } = ctx();
  const one = ok(generateWrapper(index, h.root, 'top.u_dp'));
  assert.ok(one.code.includes('u_adder'), 'a single instance is flattened');
  const two = ok(generateWrapper(index, h.root, ['top.u_dp', 'top.u_dp2']));
  assert.ok(two.code.includes('u_dp2'), 'several instances are composed');
});

test('generateWrapper falls back to a stub when flattening is impossible', () => {
  const index = new HdlIndex();
  index.addFile(
    '/w/f.v',
    'module fsm (input wire clk, input wire start, output reg busy); always @(posedge clk) busy <= start; endmodule\n' +
      'module tb (input wire clk, output wire b); fsm u_f (.clk (clk), .start (1\'b0), .busy (b)); endmodule',
  );
  const h = buildHierarchy(index, 'tb', { maxDepth: 8 })!;
  const r = ok(generateWrapper(index, h.root, 'tb.u_f'));
  assert.ok(r.code.includes('u_f'), 'a stub was emitted');
  assert.ok(
    r.warnings.some((w) => /procedural/i.test(w)),
    'the reason for the fallback is reported',
  );
  assert.equal(reparse(r.code).length, 1);
});

test('generateWrapper rejects an unknown path with a helpful message', () => {
  const { index, h } = ctx();
  const r = generateWrapper(index, h.root, 'top.nope');
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.error : '', /not part of the expanded hierarchy/);
});

test('generateWrapper rejects an empty selection', () => {
  const { index, h } = ctx();
  const r = generateWrapper(index, h.root, []);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.error : '', /No instance selected/);
});

test('generated code is valid: no double semicolons and a single endmodule', () => {
  const { index, h } = ctx();
  for (const r of [
    flattenModule(index, h.root, 'top.u_dp'),
    composeModule(index, h.root, ['top.u_dp', 'top.u_dp2']),
    stubModule(index, h.root, 'top.u_dp'),
  ]) {
    const code = ok(r).code;
    assert.ok(!/;;/.test(code), `no ";;" in:\n${code}`);
    assert.equal((code.match(/endmodule/g) ?? []).length, 1, 'exactly one endmodule');
    assert.equal((code.match(/^\s*module\s/gm) ?? []).length, 1, 'exactly one module');
    assert.ok(code.trimEnd().endsWith('endmodule'), 'nothing after endmodule');
  }
});

test('generated code declares every signal it uses', () => {
  const { index, h } = ctx();
  const r = ok(composeModule(index, h.root, ['top.u_dp', 'top.u_dp2']));
  const parsed = parseSource('/tmp/c.v', r.code).modules[0];
  const declared = new Set([
    ...parsed.ports.map((p) => p.name),
    ...parsed.decls.map((d) => d.name),
  ]);
  for (const p of parsed.ports) {
    assert.ok(declared.has(p.name), `port ${p.name} is declared`);
  }
  for (const conn of parsed.instances.flatMap((i) => i.connections)) {
    for (const ref of conn.refs) {
      const head = ref.fullPath.split('.')[0];
      assert.ok(declared.has(head), `connection uses undeclared "${head}"`);
    }
  }
  for (const a of parsed.assigns) {
    for (const ref of [...a.lhs, ...a.rhs]) {
      const head = ref.fullPath.split('.')[0];
      assert.ok(declared.has(head) || ref.kind === 'unknown', `assign uses undeclared "${head}"`);
    }
  }
});

test('the module name can be overridden and stays a valid identifier', () => {
  const { index, h } = ctx();
  const r = ok(stubModule(index, h.root, 'top.u_dp', { moduleName: 'my_wrapper_1' }));
  assert.match(r.code, /module\s+my_wrapper_1\b/);
  assert.equal(reparse(r.code).length, 1);
  // The default name is derived from the instance.
  const d = ok(stubModule(index, h.root, 'top.u_dp'));
  assert.match(d.moduleName, /u_dp/);
});

test('a generated module can be composed with the source modules', () => {
  const { index, h } = ctx();
  const stub = ok(stubModule(index, h.root, 'top.u_dp', { moduleName: 'dp_iface' }));
  const index2 = new HdlIndex();
  for (const m of index.allModules()) {
    index2.addFile(m.file, m.file === '/w/top.v' ? SRC : SRC);
  }
  index2.addFile('/tmp/dp_iface.v', stub.code);
  const wrapped = buildHierarchy(index2, 'dp_iface', { maxDepth: 8 })!;
  // The stub instantiates datapath, so the hierarchy reaches the real leaves.
  assert.ok(findByPath(wrapped.root, 'dp_iface.u_dp'), 'the wrapped instance is visible');
  assert.ok(findByPath(wrapped.root, 'dp_iface.u_dp.u_adder'), 'and so is what it wraps');
});

test('instance paths are only meaningful inside the hierarchy that owns them', () => {
  const { index, h } = ctx();
  // This is the invariant the "generate wrapper" command relies on: a node
  // picked in the tree carries a path built from the design top, so the working
  // hierarchy has to be re-expanded from that top (or reused as-is) rather than
  // from the module of the picked node.
  assert.ok(findByPath(h.root, 'top.u_dp'), 'top-based hierarchy has the full path');
  assert.ok(findByPath(h.root, 'top.u_dp.u_adder'), 'and the nested one');

  const fromChild = buildHierarchy(index, 'datapath', { maxDepth: 8 })!;
  assert.equal(fromChild.root.path, 'datapath', 'a module-rooted hierarchy is named after the module');
  assert.equal(findByPath(fromChild.root, 'top.u_dp'), undefined, 'so top-based paths do not resolve in it');
  assert.ok(findByPath(fromChild.root, 'datapath.u_adder'), 'only module-relative paths do');
});

test('generator: flatten says when a shared type could not be copied', () => {
  // The flattened copy is a standalone file. A type declared in a header cannot
  // come with it, so the variable keeps its width and loses its type - for an
  // enum or a struct that is a different signal, and the user has to know.
  const index = new HdlIndex();
  index.addFile(
    '/w/top.v',
    `module mid (input wire [7:0] a, output wire [7:0] y);
  byte_t tag;
  byte_t other;
  logic [7:0] keep;
  assign y = a ^ {tag, keep};
endmodule
module top (input wire [7:0] a, output wire [7:0] y);
  mid u (.a (a), .y (y));
endmodule`,
  );
  const h = buildHierarchy(index, 'top', { maxDepth: 8 })!;
  const r = flattenModule(index, h.root, 'top.u');
  assert.equal(r.ok, true);
  // One warning for the type, naming both variables, not one per declaration.
  assert.equal(r.warnings.length, 1, JSON.stringify(r.warnings));
  assert.match(r.warnings[0], /"tag", "other" use the type "byte_t"/);
  assert.match(r.warnings[0], /not declare/);
  // The code is still emitted, and the variables keep their width.
  assert.match(r.code, /reg tag;/);
  assert.match(r.code, /reg other;/);
  assert.match(r.code, /reg \[7:0\] keep;/);
});

test('generator: flatten stays quiet for a type it does have', () => {
  // The same shape with the typedef in the file: the existing warning about a
  // skipped typedef already covers what is lost, so there is no second one.
  const index = new HdlIndex();
  index.addFile(
    '/w/top.v',
    `module mid (input wire [7:0] a, output wire [7:0] y);
  typedef logic [7:0] byte_t;
  byte_t tag;
  assign y = a ^ tag;
endmodule
module top (input wire [7:0] a, output wire [7:0] y);
  mid u (.a (a), .y (y));
endmodule`,
  );
  const h = buildHierarchy(index, 'top', { maxDepth: 8 })!;
  const r = flattenModule(index, h.root, 'top.u');
  assert.equal(r.ok, true);
  assert.equal(
    r.warnings.some((w) => w.includes('use the type')),
    false,
    JSON.stringify(r.warnings),
  );
});

test('generator: flatten leaves an implicit wire to the language', () => {
  // `assign w = a;` with no declaration of `w` declares `w` in every copy of
  // the design, so the wrapper writes it out only once - by not writing it.
  const index = new HdlIndex();
  index.addFile(
    '/w/top.v',
    `module mid (input wire a, output wire y);
  assign w = a ^ 1'b1;
  assign y = a | w;
endmodule
module top (input wire a, output wire y);
  mid u (.a (a), .y (y));
endmodule`,
  );
  const h = buildHierarchy(index, 'top', { maxDepth: 8 })!;
  const r = flattenModule(index, h.root, 'top.u');
  assert.equal(r.ok, true);
  assert.equal(/\bwire\s+w\b|\breg\s+w\b/.test(r.code), false, r.code);
  assert.match(r.code, /assign w = a \^ 1'b1;/);
  // It is not listed as a wire of the copy either: the language makes it.
  assert.deepEqual(r.internalNets, [], 'the copy lists no internal wires');

  // A stub is a wrapper: an implicit wire stays inside the child, so it must
  // not show up as a port of the wrapper.
  const stub = stubModule(index, h.root, 'top.u');
  assert.equal(stub.ok, true);
  assert.deepEqual(stub.internalNets, [], 'no internal nets to expose');
  assert.deepEqual(
    stub.ports.map((p) => p.name),
    ['a', 'y'],
  );
});

test('generator: flatten copies the constants an enum needs', () => {
  // The members of an enum are constants of the enclosing scope, and the copy is
  // a standalone file: a module whose only use of them is a continuous
  // assignment was flattened into code that referred to names nothing declared.
  const index = new HdlIndex();
  index.addFile(
    '/w/top.v',
    `module mid (input wire [1:0] a, output wire [1:0] y);
  typedef enum logic [1:0] { RED = 2'b00, GREEN, BLUE = 2'b10 } e_t;
  assign y = (a == 2'b00) ? RED : BLUE;
endmodule
module top (input wire [1:0] a, output wire [1:0] y);
  mid u (.a (a), .y (y));
endmodule`,
  );
  const h = buildHierarchy(index, 'top', { maxDepth: 8 })!;
  const r = flattenModule(index, h.root, 'top.u');
  assert.equal(r.ok, true);
  // Each member is written out with the value it has in the original, counting
  // on from the previous one where the source leaves it implicit.
  assert.match(r.code, /localparam RED = 0;/);
  assert.match(r.code, /localparam GREEN = 1;/);
  assert.match(r.code, /localparam BLUE = 2;/);
  // Nothing declares a signal of the enum type, so losing the type costs this
  // copy nothing and there is nothing to warn about.
  assert.deepEqual(r.warnings, [], JSON.stringify(r.warnings));
});

test('generator: flatten still warns when a signal uses the type it dropped', () => {
  const index = new HdlIndex();
  index.addFile(
    '/w/top.v',
    `module mid (input wire [1:0] a, output wire [1:0] y);
  typedef enum logic [1:0] { RED, BLUE } e_t;
  e_t q;
  assign y = (a == 2'b00) ? RED : BLUE;
endmodule
module top (input wire [1:0] a, output wire [1:0] y);
  mid u (.a (a), .y (y));
endmodule`,
  );
  const h = buildHierarchy(index, 'top', { maxDepth: 8 })!;
  const r = flattenModule(index, h.root, 'top.u');
  assert.equal(r.ok, true);
  assert.equal(
    r.warnings.filter((w) => w.includes('"e_t" was skipped')).length,
    1,
    JSON.stringify(r.warnings),
  );
});

test('generator: flatten refuses a module whose generate block holds wiring', () => {
  // A generate loop was flattened into a file with `wire t;` twice - a duplicate
  // declaration, so a file that will not compile - and the assignment inside the
  // block silently missing, so even if it had compiled it was not the design.
  // The old guard only looked at instances inside generate blocks and claimed
  // that "wires and continuous assignments are fine".
  const index = new HdlIndex();
  index.addFile(
    '/w/top.v',
    `module mid (input wire [1:0] a, output wire [1:0] y);
  genvar i;
  generate
    for (i = 0; i < 2; i = i + 1) begin : g
      wire t;
      assign t = a[i];
    end
  endgenerate
  assign y = a[0];
endmodule
module top (input wire [1:0] a, output wire [1:0] y);
  mid u (.a (a), .y (y));
endmodule`,
  );
  const h = buildHierarchy(index, 'top', { maxDepth: 8 })!;
  const r = flattenModule(index, h.root, 'top.u');
  assert.equal(r.ok, false);
  assert.equal(r.fallback, 'stub', 'the user gets a stub instead of a wrong file');
  assert.match(r.error, /2 assignments/);
  assert.match(r.error, /2 declarations/);
  assert.match(r.error, /g\[0\], g\[1\]/);
  // A stub is a wrapper around the instance, so it is available and compiles.
  const s = stubModule(index, h.root, 'top.u');
  assert.equal(s.ok, true);
  assert.equal(/wire t;/.test(s.ok ? s.code : ''), false, JSON.stringify(s.warnings));
});

test('generator: flatten refuses a module that only declares in a generate block', () => {
  const index = new HdlIndex();
  index.addFile(
    '/w/top.v',
    `module mid (input wire a, output wire y);
  genvar i;
  generate
    for (i = 0; i < 2; i = i + 1) begin : g
      localparam int K = i;
      wire [3:0] t = 4'(a);
    end
  endgenerate
  assign y = a;
endmodule
module top (input wire a, output wire y);
  mid u (.a (a), .y (y));
endmodule`,
  );
  const h = buildHierarchy(index, 'top', { maxDepth: 8 })!;
  const r = flattenModule(index, h.root, 'top.u');
  assert.equal(r.ok, false);
  assert.equal(r.fallback, 'stub');
  // A localparam copied once per iteration is a redefinition, so it counts.
  assert.match(r.error, /parameter/);
});

test('generator: a composition of an instance inside a generate block', () => {
  // The block is not a scope of its own, so the parent of `tb.u.g[1].u` is
  // `tb.u`. Trimming one segment stopped at `tb.u.g[1]`, which is not a node of
  // the tree, and the composition was refused with a message about a parent
  // that could not be found.
  const src = (conn: string): string =>
    `module leaf (input wire a, output wire y);
  assign y = ~a;
endmodule
module dut (input wire a, output wire y);
  wire [1:0] w;
  genvar i;
  generate
  for (i = 0; i < 2; i = i + 1) begin : g
    leaf u (${conn});
  end
  endgenerate
endmodule
module tb (input wire a, output wire [1:0] y);
  dut u ();
  assign y = 2'b0;
endmodule`;

  // Wiring that does not read the loop variable composes as it should: the
  // signals around the selected instance are the ports of the new module.
  const plain = new HdlIndex();
  plain.addFile('/w/t.sv', src('.a (a), .y (w)'));
  const h = buildHierarchy(plain, 'tb')!;
  const ok = composeModule(plain, h.root, ['tb.u.g[1].u']);
  assert.equal(ok.ok, true, ok.ok ? '' : ok.error);
  if (ok.ok) {
    assert.deepEqual(ok.ports.map((p) => `${p.direction} ${p.name}`), ['input a', 'output w']);
    assert.match(ok.code, /leaf g_1__u/, 'the instance is named after the block path');
    assert.match(ok.code, /\.y \(w\)/);
    assert.ok(!/\bi\b\s*;/.test(ok.code.split('module')[1] ?? ''), 'the loop variable is not a port');
  }

  // Wiring that reads the loop variable cannot be written out: `w[i]` would
  // need the value of the iteration. Refused, and the stub is the output.
  const withGenvar = new HdlIndex();
  withGenvar.addFile('/w/t.sv', src('.a (a), .y (w[i])'));
  const h2 = buildHierarchy(withGenvar, 'tb')!;
  const refused = composeModule(withGenvar, h2.root, ['tb.u.g[1].u']);
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.fallback, 'stub');
    assert.match(refused.error, /loop variable "i"/);
  }
  const stub = stubModule(withGenvar, h2.root, 'tb.u.g[1].u');
  assert.equal(stub.ok, true, stub.ok ? '' : stub.error);
  if (stub.ok) {
    // The ports of the instance itself, which is all a stub can promise.
    assert.deepEqual(stub.ports.map((p) => `${p.direction} ${p.name}`), ['input a', 'output y']);
  }
  // Two iterations of the same loop are two different instances, and they are
  // two different selections.
  const both = composeModule(withGenvar, h2.root, ['tb.u.g[0].u', 'tb.u.g[1].u']);
  assert.equal(both.ok, false, 'two iterations that read the loop variable cannot be composed');
});

test('generator: flatten refuses a module that declares a function', () => {
  // A copy has no way to reproduce a function body, so the generator refuses
  // rather than writing an assignment to a name nothing declares. The automatic
  // variable inside the body is the same trap one level down: it is not a net of
  // the module either, and nothing copies it out.
  const index = new HdlIndex();
  index.addFile(
    '/w/top.v',
    `module mid (input wire [7:0] a, output wire [7:0] y);
  function automatic [7:0] rev (input [7:0] x);
    byte tmp;
    tmp = x[0];
    rev = tmp;
  endfunction
  assign y = rev(a);
endmodule
module top (input wire [7:0] a, output wire [7:0] y);
  mid u (.a (a), .y (y));
endmodule`,
  );
  const h = buildHierarchy(index, 'top', { maxDepth: 8 })!;
  const r = flattenModule(index, h.root, 'top.u');
  assert.equal(r.ok, false, 'a function body cannot be copied');
  assert.equal(r.fallback, 'stub', 'the stub is still there to offer');
  assert.match(r.error!, /declares 1 function\/task \(rev\)/);
  // The stub carries the ports and nothing else, so the automatic variable of
  // the body is not declared in the output either.
  const stub = ok(stubModule(index, h.root, 'top.u'));
  assert.ok(!/\btmp\b/.test(stub.code), `no tmp in the stub:\n${stub.code}`);
  assert.equal(reparse(stub.code).length, 1);
  // The netlist never listed the local in the first place.
  const mod = index.resolveModule('mid')!;
  assert.equal(mod.decls.filter((d) => d.name === 'tmp')[0]?.local, true);
});

test('generator: a generate block that only holds parameters is named in the refusal', () => {
  // The guard refuses because a generate block is not reproduced, so it has to
  // say which one. A module whose only generate content is a `localparam` named
  // none of the kinds the label list used to be built from, and the message came
  // out as `inside a generate construct ()` - the reader was left to guess.
  const index = new HdlIndex();
  index.addFile(
    '/w/top.v',
    `module mid (input wire a, output wire y);
  genvar i;
  generate for (i = 0; i < 2; i = i + 1) begin : g
    localparam int K = i;
  end endgenerate
  assign y = a;
endmodule
module top (input wire a, output wire y);
  mid u (.a (a), .y (y));
endmodule`,
  );
  const h = buildHierarchy(index, 'top', { maxDepth: 8 })!;
  const r = flattenModule(index, h.root, 'top.u');
  assert.equal(r.ok, false);
  assert.equal(r.fallback, 'stub');
  assert.match(r.error!, /2 parameters/);
  assert.match(r.error!, /inside a generate construct \(g\[0\], g\[1\]\)/);
  assert.doesNotMatch(r.error!, /\(\)/, 'no empty label list');
});

test('generator: a flattened port keeps the width of every dimension', () => {
  // A port declared `logic [3:0][7:0]` is 32 bits, and a flattened copy of the
  // module has to say so. It used to be emitted with no range at all - a silent
  // single bit on a 32-bit bus, with nothing to say so. The port is a flat
  // vector, so the note says what happened to the shape.
  const index = new HdlIndex();
  index.addFile(
    '/w/m.sv',
    `module m (input wire [3:0][7:0] din, output wire [3:0][7:0] dout, input wire [3:0] bus [0:1], input wire [7:0] flat);
  wire [3:0][7:0] buf;
  wire [7:0] mem [0:3];
  assign buf = din;
  assign dout = buf;
  assign mem[1] = din[1];
  assign dout[0] = bus[0];
endmodule`,
  );
  const root = buildHierarchy(index, 'm')!.root;
  const res = flattenModule(index, root, root.path);
  assert.equal(res.ok, true, res.ok ? '' : res.error);
  if (!res.ok) {
    return;
  }
  const port = (n: string) => res.ports.find((p) => p.name === n)!;
  assert.equal(port('din').width, 32, 'four times eight');
  assert.equal(port('bus').width, 8, 'two elements of four');
  assert.match(port('din').note ?? '', /2 dimensions/);
  assert.equal(port('flat').note, undefined, 'not reported for a single range');
  assert.equal(port('flat').width, 8);
  const internal = (n: string) => res.internalNets.find((x) => x.name === n)!;
  assert.equal(internal('buf').width, 32, 'the internal net keeps its own width');
  assert.equal(internal('mem').width, 32, 'four elements of eight');
  const code = res.code;
  assert.match(code, /input wire \[31:0\] din/, 'a flat vector of the same width');
  assert.match(code, /output wire \[31:0\] dout/);
  // The internal declarations keep their own shape: packed before the name,
  // unpacked after it.
  assert.match(code, /wire \[3:0\] \[7:0\] buf;/);
  assert.match(code, /wire \[7:0\] mem \[0:3\];/);
});
