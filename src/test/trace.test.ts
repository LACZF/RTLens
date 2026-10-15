import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { HdlIndex } from '../core/index';
import { traceAt, traceModule, traceSignal } from '../core/trace';

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'lib');

function indexDir(dir: string): HdlIndex {
  const index = new HdlIndex();
  for (const name of fs.readdirSync(dir)) {
    if (/\.(v|sv|svh|vh)$/.test(name)) {
      index.addFile(path.join(dir, name), fs.readFileSync(path.join(dir, name), 'utf8'));
    }
  }
  return index;
}

// 0: module leaf (input wire i, output wire o);
// 1:   assign o = i;
// 2: endmodule
// 3:
// 4: module top (input wire a, output wire y);
// 5:   wire n;
// 6:   leaf u1 (.i(n), .o(y));
// 7:   assign n = a;
// 8: endmodule
const SRC = `module leaf (input wire i, output wire o);
  assign o = i;
endmodule

module top (input wire a, output wire y);
  wire n;
  leaf u1 (.i(n), .o(y));
  assign n = a;
endmodule`;

/** Column of the start of `needle` on 0-based `line` of `text`. */
function col(line: number, needle: string, text = SRC): number {
  const found = text.split('\n')[line].indexOf(needle);
  assert.notEqual(found, -1, `"${needle}" is on line ${line}`);
  return found;
}

function ctx() {
  const index = new HdlIndex();
  index.addFile('/w/t.v', SRC);
  return { index, src: SRC };
}

/** Line/column index (0-based) of the first occurrence of `needle`. */
function locate(text: string, needle: string): number {
  return text.indexOf(needle);
}

function at(src: string, needle: string, offset = 0): { line: number; character: number } {
  const idx = locate(src, needle);
  assert.notEqual(idx, -1, `"${needle}" is present`);
  const before = src.slice(0, idx + offset);
  const line = before.split('\n').length - 1;
  const character = before.length - (before.lastIndexOf('\n') + 1);
  return { line, character };
}

// ---------------------------------------------------------------------------
// up: a use goes to its declaration, then a port to the parent instance
// ---------------------------------------------------------------------------

test('trace up: a signal use jumps to its declaration in the same module', () => {
  const { index, src } = ctx();
  // `i` is read by `assign o = i;`; its declaration is in the header.
  const p = at(src, 'o = i');
  const res = traceSignal(index, '/w/t.v', src, p.line, p.character + 4, 'up')!;
  assert.equal(res.name, 'i');
  assert.equal(res.module, 'leaf');
  assert.equal(res.targets.length, 1);
  assert.equal(res.targets[0].kind, 'declaration');
  assert.equal(res.targets[0].range.start.line, 0);
});

test('trace up: a port declaration jumps to the parent instance connection', () => {
  const { index, src } = ctx();
  // `i` is leaf's input; its use site is the parent instance `u1.i(n)`.
  const p = at(src, 'wire i');
  const res = traceSignal(index, '/w/t.v', src, p.line, p.character + 5, 'up')!;
  assert.equal(res.name, 'i');
  assert.equal(res.module, 'leaf');
  const net = res.targets.find((t) => t.kind === 'parent-net');
  assert.ok(net, 'i crosses to the parent-side net n');
  assert.equal(net.label, 'u1.i');
  assert.equal(net.range.start.line, 6);
  assert.equal(src.split('\n')[net.range.start.line].slice(net.range.start.character, net.range.end.character), 'n');
});

test('trace up: an output port also crosses to the parent instance', () => {
  const { index, src } = ctx();
  const p = at(src, 'output wire o');
  const res = traceSignal(index, '/w/t.v', src, p.line, p.character + 12, 'up')!;
  assert.equal(res.name, 'o');
  const net = res.targets.find((t) => t.kind === 'parent-net');
  assert.ok(net);
  assert.equal(net.label, 'u1.o');
  assert.equal(src.split('\n')[net.range.start.line].slice(net.range.start.character, net.range.end.character), 'y');
});

test('trace up: a bus port declaration crosses to the parent instance', () => {
  // The packed range before the name must not hide the port: it used to glom
  // the type keyword on (`wire.d`), so up from a bus port found nothing.
  const index = new HdlIndex();
  const src = `module child (input wire [7:0] d, output wire [7:0] q);
endmodule

module top (input wire [7:0] a, output wire [7:0] y);
  child u (.d(a), .q(y));
endmodule`;
  index.addFile('/w/b.v', src);
  const p = at(src, 'output wire [7:0] q');
  const res = traceSignal(index, '/w/b.v', src, p.line, p.character + 18, 'up')!;
  assert.equal(res.name, 'q');
  const net = res.targets.find((t) => t.kind === 'parent-net');
  assert.ok(net, 'the bus output crosses to the parent net');
  assert.equal(net.label, 'u.q');
});

test('trace up: a top-level port has no parent to cross to', () => {
  const { index, src } = ctx();
  const p = at(src, 'wire a');
  const res = traceSignal(index, '/w/t.v', src, p.line, p.character + 5, 'up')!;
  assert.equal(res.name, 'a');
  assert.deepEqual(res.targets, [], 'top is never instantiated');
});

test('trace up: a non-port declaration has nowhere to go', () => {
  const { index, src } = ctx();
  const p = at(src, 'wire n');
  const res = traceSignal(index, '/w/t.v', src, p.line, p.character + 5, 'up')!;
  assert.equal(res.name, 'n');
  assert.deepEqual(res.targets, []);
});

// ---------------------------------------------------------------------------
// down: a signal to the child connection, then into the child port
// ---------------------------------------------------------------------------

test('trace down: a signal jumps to the child connection that touches it', () => {
  const { index, src } = ctx();
  // `n` feeds `u1.i`; the first hop is the connection itself, still in top.
  const p = at(src, 'wire n');
  const res = traceSignal(index, '/w/t.v', src, p.line, p.character + 5, 'down')!;
  assert.equal(res.name, 'n');
  const conn = res.targets.find((t) => t.kind === 'child-connection');
  assert.ok(conn, 'n is connected to u1.i');
  assert.equal(conn.label, 'u1.i');
  assert.equal(conn.file, '/w/t.v', 'the connection is in the current module');
  assert.equal(conn.range.start.line, 6);
});

test('trace down: a connection enters the child port declaration', () => {
  const { index, src } = ctx();
  const p = at(src, '.i(n)');
  const res = traceSignal(index, '/w/t.v', src, p.line, p.character + 1, 'down')!;
  assert.equal(res.name, 'i');
  const port = res.targets.find((t) => t.kind === 'child-port');
  assert.ok(port, 'the connection opens the child port');
  assert.equal(port.label, 'u1.i');
  assert.equal(port.range.start.line, 0);
});

test('trace down: the net in a connection is reported, and going up returns there', () => {
  const { index, src } = ctx();
  const p = at(src, '.i(n)');
  const res = traceSignal(index, '/w/t.v', src, p.line, p.character + 1, 'up')!;
  const net = res.targets.find((t) => t.kind === 'connection-net');
  assert.ok(net, 'up from a connection lands on the parent-side net');
  assert.equal(net.label, 'n');
  assert.equal(net.range.start.line, 6);
});

test('trace down: at the bottom a signal falls to its use in the module body', () => {
  const { index, src } = ctx();
  // `a` is a top-level input no child instance connects, so the deepest hop is
  // its use in `assign n = a;`.
  const p = at(src, 'wire a');
  const res = traceSignal(index, '/w/t.v', src, p.line, p.character + 5, 'down')!;
  assert.equal(res.name, 'a');
  const use = res.targets.find((t) => t.kind === 'usage');
  assert.ok(use, 'a is read in the assign');
  assert.equal(use.range.start.line, 7);
  assert.equal(src.split('\n')[7].slice(use.range.start.character, use.range.end.character), 'a');
});

test('trace down: a signal used only to gate a block falls to that use', () => {
  const index = new HdlIndex();
  const src = `module m (input wire clk, input wire en, input wire d, output reg q);
  always_ff @(posedge clk) if (en) q <= d;
endmodule`;
  index.addFile('/w/e.v', src);
  const p = at(src, 'wire en');
  const res = traceSignal(index, '/w/e.v', src, p.line, p.character + 5, 'down')!;
  const use = res.targets.find((t) => t.kind === 'usage');
  assert.ok(use, 'en gates the block');
  assert.equal(src.split('\n')[use.range.start.line].slice(use.range.start.character, use.range.end.character), 'en');
});

test('trace down: a leaf port falls to where the body drives it', () => {
  // The user's case: down reaches the leaf module's port, and the next press
  // must show where that port is used inside the leaf, not stop dead.
  const index = indexDir(FIXTURES);
  const file = path.join(FIXTURES, 'adder.v');
  const src = fs.readFileSync(file, 'utf8');
  const p = at(src, 'sum,');
  const res = traceSignal(index, file, src, p.line, p.character + 1, 'down')!;
  assert.equal(res.name, 'sum');
  const use = res.targets.find((t) => t.kind === 'usage');
  assert.ok(use, 'sum is driven inside the leaf');
  assert.match(src.split('\n')[use.range.start.line], /assign sum\b/, 'the driver of the port');
});

// ---------------------------------------------------------------------------
// hierarchical references and non-signals
// ---------------------------------------------------------------------------

test('trace: a hierarchical reference enters the child and tracks its net', () => {
  const index = new HdlIndex();
  const src = `module leaf (input wire i, output wire o);
  assign o = i;
endmodule

module top (input wire a, output wire y, output wire z);
  wire n;
  leaf u1 (.i(n), .o(y));
  assign n = a;
  assign z = u1.o;
endmodule`;
  index.addFile('/w/h.v', src);
  const p = at(src, 'u1.o');

  const down = traceSignal(index, '/w/h.v', src, p.line, p.character + 3, 'down')!;
  assert.equal(down.name, 'o');
  const port = down.targets.find((t) => t.kind === 'child-port');
  assert.ok(port);
  assert.equal(port.label, 'u1.o');
  assert.equal(port.range.start.line, 0);

  const up = traceSignal(index, '/w/h.v', src, p.line, p.character + 3, 'up')!;
  const net = up.targets.find((t) => t.kind === 'connection-net');
  assert.ok(net);
  assert.equal(net.label, 'y');
});

test('trace: an unresolved cursor is not traceable', () => {
  const { index, src } = ctx();
  assert.equal(traceSignal(index, '/w/t.v', src, 3, 0, 'down'), undefined);
  assert.equal(traceSignal(index, '/w/t.v', src, 4, col(4, 'top'), 'down'), undefined);
});

// ---------------------------------------------------------------------------
// a generate loop collapses copies that share a source range
// ---------------------------------------------------------------------------

test('trace down: an unrolled instance connection is reported once', () => {
  const index = new HdlIndex();
  const src = `module leaf (input wire i);
endmodule
module m (input wire a);
  genvar g;
  generate
    for (g = 0; g < 2; g = g + 1) begin : blk
      leaf u (.i(a));
    end
  endgenerate
endmodule`;
  index.addFile('/w/g.v', src);
  const p = at(src, 'wire a');
  const res = traceSignal(index, '/w/g.v', src, p.line, p.character + 5, 'down')!;
  const conns = res.targets.filter((t) => t.kind === 'child-connection');
  assert.equal(conns.length, 1, 'the two unrolled copies collapse to one hop');
  assert.equal(conns[0].label, 'u.i');
});

// ---------------------------------------------------------------------------
// a real multi-file design
// ---------------------------------------------------------------------------

test('trace: a fixture net fans out to the child instances that connect it', () => {
  const index = indexDir(FIXTURES);
  const file = path.join(FIXTURES, 'datapath.v');
  const src = fs.readFileSync(file, 'utf8');
  // A use of alu_sum in the ternary, not its declaration.
  const p = at(src, ': alu_sum;');

  const down = traceSignal(index, file, src, p.line, p.character + 2, 'down')!;
  assert.equal(down.name, 'alu_sum');
  assert.equal(down.module, 'datapath');
  const labels = down.targets.filter((t) => t.kind === 'child-connection').map((t) => t.label).sort();
  assert.deepEqual(labels, ['u_adder.sum', 'u_regfile.wdata']);
  assert.ok(down.targets.every((t) => t.file === file), 'every first hop stays in datapath');

  // The first hop from a child connection opens the child port in another file.
  const wdata = down.targets.find((t) => t.label === 'u_regfile.wdata')!;
  const into = traceSignal(index, file, src, wdata.range.start.line, wdata.range.start.character, 'down')!;
  const port = into.targets.find((t) => t.kind === 'child-port');
  assert.ok(port, 'the connection opens regfile.wdata');
  assert.equal(port.label, 'u_regfile.wdata');
  assert.equal(path.basename(port.file), 'regfile.v');
});

test('trace: a fixture output port crosses up to the parent instance', () => {
  // datapath.carry is an output; up crosses to the chip_top net that catches it
  // in `.carry(dp_carry)`.
  const index = indexDir(FIXTURES);
  const file = path.join(FIXTURES, 'datapath.v');
  const src = fs.readFileSync(file, 'utf8');
  const p = at(src, 'carry');

  const up = traceSignal(index, file, src, p.line, p.character, 'up')!;
  assert.equal(up.name, 'carry');
  const net = up.targets.find((t) => t.kind === 'parent-net');
  assert.ok(net, 'carry crosses to the parent instance');
  assert.equal(net.label, 'u_dpath.carry');
  assert.equal(path.basename(net.file), 'chip_top.v');
});

// ---------------------------------------------------------------------------
// module tracing: up to the parent instance, down to the child implementation
// ---------------------------------------------------------------------------

test('trace module up: a module jumps to the instance that instantiates it', () => {
  const index = indexDir(FIXTURES);
  const file = path.join(FIXTURES, 'datapath.v');
  const src = fs.readFileSync(file, 'utf8');
  // Cursor on the module definition name at the top of the file.
  const p = at(src, 'module datapath', 'module '.length);

  const up = traceModule(index, file, src, p.line, p.character, 'up')!;
  assert.equal(up.name, 'datapath');
  assert.equal(up.targets.length, 1);
  const step = up.targets[0];
  assert.equal(step.kind, 'parent-instance');
  assert.equal(step.label, 'u_dpath : datapath');
  assert.equal(path.basename(step.file), 'chip_top.v');
  assert.equal(srcFileLine(step.file, step.range.start.line), '  ) u_dpath (');
});

test('trace module up: an instance name ascends from the module it sits in', () => {
  const index = indexDir(FIXTURES);
  const file = path.join(FIXTURES, 'datapath.v');
  const src = fs.readFileSync(file, 'utf8');
  // Cursor on `u_adder`; the containing module is datapath, so up is its parent.
  const p = at(src, 'u_adder (');

  const up = traceModule(index, file, src, p.line, p.character, 'up')!;
  assert.equal(up.name, 'datapath');
  assert.equal(up.targets[0].label, 'u_dpath : datapath');
});

test('trace module down: a module jumps to its children implementations', () => {
  const index = indexDir(FIXTURES);
  const file = path.join(FIXTURES, 'datapath.v');
  const src = fs.readFileSync(file, 'utf8');
  const p = at(src, 'module datapath', 'module '.length);

  const down = traceModule(index, file, src, p.line, p.character, 'down')!;
  assert.equal(down.name, 'datapath');
  const byLabel = Object.fromEntries(down.targets.map((t) => [t.label, t]));
  assert.ok(byLabel['u_adder : adder'], 'adder is a child');
  assert.ok(byLabel['u_regfile : regfile'], 'regfile is a child');
  assert.equal(path.basename(byLabel['u_adder : adder'].file), 'adder.v');
  assert.equal(path.basename(byLabel['u_regfile : regfile'].file), 'regfile.v');
  assert.ok(down.targets.every((t) => t.kind === 'child-module'));
});

test('trace module up: a top-level module has no parent', () => {
  const index = indexDir(FIXTURES);
  const file = path.join(FIXTURES, 'chip_top.v');
  const src = fs.readFileSync(file, 'utf8');
  const p = at(src, 'module chip_top', 'module '.length);

  const up = traceModule(index, file, src, p.line, p.character, 'up')!;
  assert.equal(up.name, 'chip_top');
  assert.deepEqual(up.targets, [], 'the top is never instantiated');
});

test('trace module down: the top fans out to every child implementation', () => {
  const index = indexDir(FIXTURES);
  const file = path.join(FIXTURES, 'chip_top.v');
  const src = fs.readFileSync(file, 'utf8');
  const p = at(src, 'module chip_top', 'module '.length);

  const down = traceModule(index, file, src, p.line, p.character, 'down')!;
  const files = down.targets.map((t) => path.basename(t.file)).sort();
  assert.deepEqual(files, ['control.v', 'datapath.v']);
});

test('trace at: dispatches a module cursor to the module trace and a signal cursor to the signal trace', () => {
  const index = indexDir(FIXTURES);
  const file = path.join(FIXTURES, 'datapath.v');
  const src = fs.readFileSync(file, 'utf8');

  // On the module name: the hierarchy, so a child implementation comes back.
  const mod = at(src, 'module datapath', 'module '.length);
  const down = traceAt(index, file, src, mod.line, mod.character, 'down')!;
  assert.ok(down.targets.some((t) => t.kind === 'child-module'), 'module cursor traces the module');

  // On a net: the signal web, so the child connection comes back.
  const net = at(src, 'wire [WIDTH-1:0] alu_sum', 'wire [WIDTH-1:0] '.length);
  const sig = traceAt(index, file, src, net.line, net.character, 'down')!;
  assert.equal(sig.name, 'alu_sum');
  assert.ok(sig.targets.some((t) => t.kind === 'child-connection'), 'signal cursor traces the signal');
});

test('trace module: a cursor on a signal is not a module trace', () => {
  const index = indexDir(FIXTURES);
  const file = path.join(FIXTURES, 'datapath.v');
  const src = fs.readFileSync(file, 'utf8');
  const p = at(src, 'wire [WIDTH-1:0] alu_sum', 'wire [WIDTH-1:0] '.length);
  assert.equal(traceModule(index, file, src, p.line, p.character, 'up'), undefined);
  assert.equal(traceModule(index, file, src, p.line, p.character, 'down'), undefined);
});

/** The text of a 0-based line in a file under the fixture directory. */
function srcFileLine(file: string, line: number): string {
  return fs.readFileSync(file, 'utf8').split('\n')[line];
}
