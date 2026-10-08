import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { HdlIndex } from '../core/index';
import { GATE_KEYWORDS } from '../core/lexer';
import { collectProblems } from '../core/problems';
import { describeUse, signalUsage, summariseUse } from '../core/nets';

const SRC = `module child (input wire i, output wire o, inout wire io, ref wire r);
endmodule

module mid (input wire a, output wire y);
  wire n;
  wire d;
  assign d = a;
  assign n = d;
  child u1 (.i(d), .o(n));
  child u2 (.i(n), .o(y), .io(n), .r(n));
endmodule`;

function ctx() {
  const index = new HdlIndex();
  index.addFile('/w/x.v', SRC);
  return { index, mid: index.resolveModule('mid')! };
}

test('nets: an assignment reads the right-hand side and drives the left', () => {
  const { index, mid } = ctx();
  const usage = signalUsage(index, mid);
  assert.deepEqual(usage.get('d')?.writers, ['assign']);
  assert.equal(usage.get('d')?.readers.includes('assign'), true, 'd feeds u1.i');
  // The point of the module: the two sides must not be confused. `a` is only
  // ever read; `n` is driven by its own `assign` and by u1.o, and read by u2.i.
  assert.deepEqual(usage.get('a')?.writers, []);
  assert.deepEqual(usage.get('a')?.readers, ['assign']);
  assert.deepEqual(usage.get('n')?.writers, ['assign', 'u1.o (output)', 'u2.io (inout)', 'u2.r (ref)']);
  assert.deepEqual(usage.get('n')?.readers.sort(), ['u2.i (input)', 'u2.r (ref)']);
});

test('nets: the child port direction decides which side the connection is on', () => {
  const { index, mid } = ctx();
  const usage = signalUsage(index, mid);
  // `.o(n)` drives the parent-side net, `.i(n)` only reads it, and `ref` is
  // both - the callee may assign to it.
  const n = usage.get('n')!;
  assert.ok(n.writers.includes('u1.o (output)'), 'an output connection drives');
  assert.ok(n.readers.includes('u2.i (input)'), 'an input connection reads');
  assert.ok(n.readers.includes('u2.r (ref)') && n.writers.includes('u2.r (ref)'), 'ref is both');
  assert.ok(n.writers.includes('u2.io (inout)'), 'inout drives');
  // `y` is driven by the module itself and by u2.o, never read.
  assert.deepEqual(usage.get('y')?.readers, []);
  assert.deepEqual(usage.get('y')?.writers, ['u2.o (output)']);
});

test('nets: a signal nothing touches is reported as unused', () => {
  const index = new HdlIndex();
  index.addFile(
    '/w/y.v',
    `module lonely (input wire used_in, output wire drv_out, input wire dead);
  wire live;
  assign drv_out = used_in;
  assign live = used_in;
endmodule`,
  );
  const mod = index.resolveModule('lonely')!;
  const usage = signalUsage(index, mod);
  assert.equal(summariseUse(usage.get('used_in')), 'read by assign');
  assert.equal(
    summariseUse(usage.get('drv_out')),
    'driven by assign',
    'a driven output port is not unused',
  );
  assert.equal(summariseUse(usage.get('dead')), 'unused');
  assert.equal(summariseUse(usage.get('live')), 'driven by assign');
  assert.equal(summariseUse(undefined), 'unused', 'an unknown name reads as unused');
  assert.equal(describeUse('wire', usage.get('dead')), 'wire · unused');
});

test('nets: procedural assignments are labelled always', () => {
  const index = new HdlIndex();
  index.addFile(
    '/w/p.v',
    `module seq (input wire clk, input wire rst, input wire d, output wire q);
  always_ff @(posedge clk or negedge rst) q <= d;
endmodule`,
  );
  const usage = signalUsage(index, index.resolveModule('seq')!);
  assert.deepEqual(usage.get('q')?.writers, ['always']);
  assert.deepEqual(usage.get('d')?.readers, ['always']);
  // The clock is only named in the event control. It still has to show up,
  // because "nothing drives this net" is exactly what this view is for.
  assert.deepEqual(usage.get('clk')?.readers, ['always']);
  assert.deepEqual(usage.get('rst')?.readers, ['always'], 'and the reset, after `or`');
});

test('nets: a connection to an unknown module is not counted as a write', () => {
  const index = new HdlIndex();
  index.addFile('/w/u.v', 'module top (output wire w); missing u0 (.o(w)); endmodule');
  const usage = signalUsage(index, index.resolveModule('top')!);
  // The direction is unknown, so claiming `w` is driven would be a guess.
  assert.deepEqual(usage.get('w')?.writers, []);
  assert.deepEqual(usage.get('w')?.readers, ['u0.o']);
});

test('nets: a driver inside a generate block is a driver', () => {
  // The register file in the fixtures is a generate-for array: every register is
  // written from inside the block. The generate loop only knew about
  // declarations and instantiations, so those writes were invisible and the net
  // list claimed the array had no driver at all.
  const index = new HdlIndex();
  index.addFile(
    '/w/regf.v',
    `module regfile (input wire clk, input wire we, input wire [1:0] addr, output reg [7:0] regs);
  genvar i;
  generate
    for (i = 0; i < 4; i = i + 1) begin : g_reg
      wire hit = we && (addr == i);
      always @(posedge clk) if (hit) regs[i] <= 8'(we);
    end
  endgenerate
endmodule`,
  );
  const mod = index.resolveModule('regfile')!;
  // One copy of the block per iteration, each tagged with its generate path.
  assert.deepEqual(
    mod.assigns.map((a) => `${a.lhs.map((r) => r.fullPath).join('&')}@${a.generate}`),
    ['regs@g_reg[0]', 'regs@g_reg[1]', 'regs@g_reg[2]', 'regs@g_reg[3]'],
  );
  const use = signalUsage(index, mod).get('regs');
  assert.ok(use, 'the array is in the usage map');
  assert.deepEqual(use.writers, ['always']);
  assert.deepEqual(summariseUse(use), 'driven by always');
  // The wire declared inside the block is a real net of the module, and it reads
  // the signals its own expression names.
  assert.equal(mod.decls.filter((d) => d.generate?.startsWith('g_reg')).length, 4);
  assert.equal(signalUsage(index, mod).get('we')?.readers.length, 1);
});

test('nets: a name that only gates a block is read by it', () => {
  // `if (hit) regs[i] <= ...` names `hit` in a condition, and the condition
  // belongs to no assignment site - the same as the event control of the block.
  // With it dropped, `hit` had no reader and the nets view said it was unused.
  const index = new HdlIndex();
  index.addFile(
    '/w/t.sv',
    `module m (input wire clk, input wire hit, input wire [1:0] s, input wire d, output reg q);
  always @(posedge clk) begin : b
    if (hit) q <= d;
    case (s)
      2'd0: q <= d;
      default: q <= hit;
    endcase
  end
endmodule`,
  );
  const mod = index.resolveModule('m')!;
  const use = signalUsage(index, mod);
  assert.deepEqual(use.get('hit')?.readers, ['always'], 'the condition reads');
  assert.deepEqual(use.get('s')?.readers, ['always']);
  assert.deepEqual(use.get('d')?.readers, ['always']);
  // A condition is not a write: `hit` gates the block, it does not drive it.
  assert.deepEqual(use.get('hit')?.writers, []);
  assert.deepEqual(use.get('q')?.writers, ['always']);
  assert.deepEqual(summariseUse(use.get('hit')!), 'read by always');
});

test('nets: a system function is not a net', () => {
  // `$clog2(DEPTH)` is read like any other name in the expression, but it is a
  // function of the language: there is no signal to point at and no width, so
  // it has no place in the net list. The names it is applied to do.
  const index = new HdlIndex();
  index.addFile(
    '/w/t.sv',
    `module m (input wire [3:0] d, input wire [1:0] i, output wire o);
  parameter int DEPTH = 8;
  logic [DEPTH-1:0] q;
  assign q = d;
  assign o = q[$clog2(DEPTH)] | i[$clog2(DEPTH)-1];
endmodule`,
  );
  const mod = index.resolveModule('m')!;
  const use = signalUsage(index, mod);
  assert.deepEqual([...use.keys()].filter((k) => k.startsWith('$')), [], 'no system names');
  // Both selects read DEPTH, and the view lists a label once.
  assert.deepEqual(use.get('DEPTH')?.readers, ['assign'], 'the parameter is still read');
  assert.deepEqual(use.get('q')?.writers, ['assign']);
  assert.deepEqual(use.get('d')?.readers, ['assign']);
});

test('nets: the body of a function or task is not a net of the module', () => {
  // `tmp`, `shadow` and the arguments `x`/`acc` are automatic: they live for
  // one call and nobody outside can name them. They are kept in the IR so the
  // names in the body can be classified, but a netlist that listed them would
  // show wires with no driver and no reader that no design has.
  const index = new HdlIndex();
  index.addFile(
    '/w/t.sv',
    `module m (input wire clk, input wire [7:0] d, output reg [7:0] q);
  function automatic [7:0] rev (input [7:0] x);
    byte tmp;
    int i;
    tmp = x[0];
    for (i = 0; i < 8; i = i + 1) tmp = tmp | (x[i] << i);
    rev = tmp;
  endfunction
  task automatic accumulate (input [7:0] x, inout [7:0] acc);
    logic [7:0] shadow;
    shadow = x;
    acc = acc + shadow;
  endtask
  always_comb begin : b
    if (clk) q = rev(d);
  end
endmodule`,
  );
  const mod = index.resolveModule('m')!;
  const use = signalUsage(index, mod);
  assert.deepEqual([...use.keys()].sort(), ['clk', 'd', 'q', 'rev']);
  // A subprogram holds no instantiation, however its body is written: a
  // procedural body is not module scope, so nothing in it is an instance.
  const withInst = new HdlIndex();
  withInst.addFile(
    '/w/i.sv',
    `module m (input wire [7:0] d, output reg [7:0] q);
  function automatic [7:0] rev (input [7:0] x);
    mid u (.a (x), .b (x));
    rev = x[0];
  endfunction
  always_comb q = rev(d);
endmodule`,
  );
  assert.deepEqual(withInst.resolveModule('m')!.instances, [], 'nothing is instantiated in a body');
  // The declaration is still in the module, marked as automatic, so that the
  // names in the body classify instead of being reported undeclared.
  assert.deepEqual(
    mod.decls.filter((d) => d.name === 'tmp' || d.name === 'shadow').map((d) => [d.name, d.local]),
    [['tmp', true], ['shadow', true]],
  );
});

test('nets: a read written through a generate block is the net of the module', () => {
  // `g[0].t` and `g[1].t` are two ways of writing the copies of one `t`, and the
  // block itself is what declares it. Filing the reads under the path as written
  // gave the module three nets for one signal, two of them with no writer and no
  // width. A path through a child instance keeps the path: that net belongs to
  // the child, and the parent only ever mentions it.
  const index = new HdlIndex();
  index.addFile(
    '/w/t.sv',
    `module m (input wire [1:0] a, output wire y);
  genvar i;
  generate
    for (i = 0; i < 2; i = i + 1) begin : g
      wire t;
      assign t = a[i];
    end
  endgenerate
  assign y = g[0].t | g[1].t;
endmodule
module child (input wire i, output wire o);
endmodule
module p (input wire a, output wire y);
  wire w;
  child u (.i (a), .o (w));
  assign y = w;
endmodule`,
  );
  const mod = index.resolveModule('m')!;
  const use = signalUsage(index, mod);
  assert.deepEqual(use.get('t')?.writers, ['assign'], 'the block writes the net it declares');
  assert.equal(use.get('t')?.readers.includes('assign'), true, 'and the parent reads it');
  assert.deepEqual([...use.keys()].filter((k) => k.includes('.')), [], 'no net named after a path');

  // The child instance is not a generate scope, so `u.i` stays a path.
  const parent = index.resolveModule('p')!;
  const puse = signalUsage(index, parent);
  // The connection is filed under the parent-side signal, with the child's port
  // as its label - the child's own nets are not the parent's to list.
  assert.deepEqual(puse.get('w')?.writers, ['u.o (output)'], [...puse.keys()].join(' '));
});

test('nets: a generate block that only declares is still a scope', () => {
  // A block whose only content is a declaration marks no assignment, so the
  // scope is known from the declaration alone. The read outside the block is
  // still a read of the net that block declares.
  const index = new HdlIndex();
  index.addFile(
    '/w/g.sv',
    `module m (input wire a, output wire y);
  generate if (1) begin : g
    wire t;
  end endgenerate
  assign y = g.t | a;
endmodule`,
  );
  const mod = index.resolveModule('m')!;
  const use = signalUsage(index, mod);
  assert.deepEqual([...use.keys()].sort(), ['a', 't', 'y'], 'one net per name');
  assert.equal(use.get('t')?.readers.includes('assign'), true, 'read through the block');
});

test('nets: a generate condition is read by generate', () => {
  // The parameter is read while the design is elaborated, so calling it a read
  // by `always` would be a label about the wrong moment.
  const index = new HdlIndex();
  index.addFile(
    '/w/g.sv',
    `module leaf #(parameter int W = 4) (input wire a, output wire y);
  assign y = a;
endmodule
module m #(parameter int WIDTH = 8) (input wire [WIDTH-1:0] a, output wire y);
  generate
    if (WIDTH > 4) begin : wide
      leaf #(.W (WIDTH)) u (.a (a[0]), .y (y));
    end
  endgenerate
endmodule`,
  );
  const mod = index.resolveModule('m')!;
  const use = signalUsage(index, mod);
  assert.deepEqual(use.get('WIDTH')?.readers, ['generate']);
  assert.equal(summariseUse(use.get('WIDTH')!), 'read by generate');
});

test('nets: a signal named after a gate primitive is a signal', () => {
  // `buf` is a reserved word to the language, but the lexer leaves it as an
  // identifier and legacy code declares it. Skipping every gate word where a
  // reference is collected made the declaration look like the only mention of
  // it: no readers, no writers, and a netlist that called it unused. The same
  // token in `a or b` is the operator, and stays no reference at all.
  const index = new HdlIndex();
  index.addFile(
    '/w/g.sv',
    `module g (input wire a, input wire b, output wire y);
  wire buf;
  and g1 (y, a, b);
  and #(2) g2 (y, b, a);
  assign buf = a or b;
  assign y = buf;
endmodule`,
  );
  const mod = index.resolveModule('g')!;
  const use = signalUsage(index, mod);
  assert.deepEqual(use.get('buf')?.readers, ['assign'], 'read by the assignment that drives it');
  assert.deepEqual(use.get('buf')?.writers, ['assign']);
  assert.equal(use.get('or'), undefined, 'a gate word nobody declared is an operator');
  assert.deepEqual(
    [...use.keys()].filter((k) => GATE_KEYWORDS.has(k) && k !== 'buf'),
    [],
    'and no net is named after a primitive',
  );
  assert.equal(collectProblems(index).length, 0, 'and no problem either');
});
