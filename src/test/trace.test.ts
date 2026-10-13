import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { HdlIndex } from '../core/index';
import { traceSignal } from '../core/trace';

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
// 4: module mid (input wire a, input wire c, output wire y);
// 5:   wire n;
// 6:   wire m;
// 7:   assign n = a;
// 8:   assign m = n;
// 9:   leaf u1 (.i(n), .o(y));
// 10: endmodule
const SRC = `module leaf (input wire i, output wire o);
  assign o = i;
endmodule

module mid (input wire a, input wire c, output wire y);
  wire n;
  wire m;
  assign n = a;
  assign m = n;
  leaf u1 (.i(n), .o(y));
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

test('trace: down follows a net into the assignment it drives', () => {
  const { index, src } = ctx();
  // `n` is read by `assign m = n;`, whose left side is the sink.
  const res = traceSignal(index, '/w/t.v', src, 5, col(5, 'n'), 'down')!;
  assert.equal(res.name, 'n');
  assert.equal(res.module, 'mid');
  const sink = res.targets.find((t) => t.kind === 'sink');
  assert.ok(sink, 'n drives m');
  assert.equal(sink.label, 'm');
  assert.equal(sink.range.start.line, 8);
});

test('trace: down follows a net into a child input port', () => {
  const { index, src } = ctx();
  const res = traceSignal(index, '/w/t.v', src, 5, col(5, 'n'), 'down')!;
  const into = res.targets.find((t) => t.kind === 'into-child');
  assert.ok(into, 'n enters leaf.i');
  assert.equal(into.label, 'u1.i');
  assert.equal(into.file, '/w/t.v');
  assert.equal(into.range.start.line, 0, 'lands on the child port declaration');
});

test('trace: up follows a net back to what drives it', () => {
  const { index, src } = ctx();
  // `assign n = a;` drives n from a.
  const res = traceSignal(index, '/w/t.v', src, 5, col(5, 'n'), 'up')!;
  assert.equal(res.name, 'n');
  const source = res.targets.find((t) => t.kind === 'source');
  assert.ok(source, 'n is driven by a');
  assert.equal(source.label, 'a');
  assert.equal(source.range.start.line, 7);
});

test('trace: up follows a child output port into the child', () => {
  const { index, src } = ctx();
  // y is driven by u1.o, which is leaf's output.
  const res = traceSignal(index, '/w/t.v', src, 4, col(4, 'y)'), 'up')!;
  assert.equal(res.name, 'y');
  const from = res.targets.find((t) => t.kind === 'from-child');
  assert.ok(from, 'y comes out of leaf.o');
  assert.equal(from.label, 'u1.o');
  assert.equal(from.range.start.line, 0);
});

test('trace: an input port fans in from the parent instance connection', () => {
  const index = new HdlIndex();
  const src = `module leaf (input wire i, output wire o);
  assign o = i;
endmodule
module top (input wire a, output wire y);
  leaf u1 (.i(a), .o(y));
endmodule`;
  index.addFile('/w/p.v', src);
  // `i` is leaf's input; up crosses to the parent-side net `a`.
  const res = traceSignal(index, '/w/p.v', src, 0, col(0, 'i,', src), 'up')!;
  assert.equal(res.name, 'i');
  assert.equal(res.module, 'leaf');
  const fromParent = res.targets.find((t) => t.kind === 'from-parent');
  assert.ok(fromParent, 'i comes from the parent net a');
  assert.equal(fromParent.label, 'a');
  assert.equal(fromParent.range.start.line, 4);
});

test('trace: an output port fans out to the parent instance connection', () => {
  const index = new HdlIndex();
  const src = `module leaf (input wire i, output wire o);
  assign o = i;
endmodule
module top (input wire a, output wire y);
  leaf u1 (.i(a), .o(y));
endmodule`;
  index.addFile('/w/p.v', src);
  // `o` is leaf's output; down crosses to the parent-side net `y`.
  const res = traceSignal(index, '/w/p.v', src, 0, col(0, 'o)', src), 'down')!;
  assert.equal(res.name, 'o');
  const toParent = res.targets.find((t) => t.kind === 'to-parent');
  assert.ok(toParent, 'o reaches the parent net y');
  assert.equal(toParent.label, 'y');
  assert.equal(toParent.range.start.line, 4);
});

test('trace: a top-level input has nowhere to fan in from', () => {
  const { index, src } = ctx();
  const res = traceSignal(index, '/w/t.v', src, 4, col(4, 'a,'), 'up')!;
  assert.equal(res.name, 'a');
  assert.deepEqual(res.targets, [], 'mid is never instantiated');
});

test('trace: an unresolved cursor is not traceable', () => {
  const { index, src } = ctx();
  // A blank line has no identifier, and a module name has no fan-in/fan-out.
  assert.equal(traceSignal(index, '/w/t.v', src, 3, 0, 'down'), undefined);
  assert.equal(traceSignal(index, '/w/t.v', src, 4, col(4, 'mid'), 'down'), undefined);
});

test('trace: the same signal reached two ways is reported once', () => {
  const { index, src } = ctx();
  const res = traceSignal(index, '/w/t.v', src, 5, col(5, 'n'), 'down')!;
  const keys = res.targets.map((t) => `${t.range.start.line}:${t.range.start.character}`);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate jump targets');
});

test('trace: an unrolled generate copy does not duplicate a target', () => {
  // Both copies of `assign t = a;` carry the same source range (line 5), so the
  // driver `a` would be offered twice if the steps were not collapsed.
  const index = new HdlIndex();
  const src = `module m (input wire a, output wire y);
  wire t;
  genvar i;
  generate
    for (i = 0; i < 2; i = i + 1) begin : g
      assign t = a;
    end
  endgenerate
  assign y = g[0].t | g[1].t;
endmodule`;
  index.addFile('/w/g.v', src);
  const res = traceSignal(index, '/w/g.v', src, 5, col(5, 't', src), 'up')!;
  assert.equal(res.name, 't');
  const sources = res.targets.filter((t) => t.kind === 'source');
  assert.equal(sources.length, 1, 'the two generate copies collapse to one hop');
  assert.equal(sources[0].label, 'a');

  // `g[0].t` and `g[1].t` are the same net as `t`, so tracing down from `t`
  // still reaches `y` - without the scope normalisation neither reference is a
  // match and the net looks as if nothing reads it.
  const down = traceSignal(index, '/w/g.v', src, 5, col(5, 't', src), 'down')!;
  const sink = down.targets.find((t) => t.kind === 'sink');
  assert.ok(sink, 'the generate-path spelling of the same net is followed');
  assert.equal(sink.label, 'y');
});

/** Line/column of the first occurrence of `needle` in `text`. */
function locate(text: string, needle: string): { line: number; character: number } {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const character = lines[i].indexOf(needle);
    if (character !== -1) {
      return { line: i, character };
    }
  }
  throw new Error(`not found: ${needle}`);
}

test('trace: a fixture net fans in from the child that produces it', () => {
  // datapath's `alu_sum` comes out of u_adder.sum and runs on to the regfile's
  // write data - a real multi-file trace, not a single module.
  const index = indexDir(FIXTURES);
  const file = path.join(FIXTURES, 'datapath.v');
  const src = fs.readFileSync(file, 'utf8');
  const cursor = locate(src, ': alu_sum;');

  const up = traceSignal(index, file, src, cursor.line, cursor.character + 2, 'up')!;
  assert.equal(up.name, 'alu_sum');
  assert.equal(up.module, 'datapath');
  const from = up.targets.find((t) => t.kind === 'from-child');
  assert.ok(from, 'alu_sum is driven by u_adder.sum');
  assert.equal(from.label, 'u_adder.sum');
  assert.equal(path.basename(from.file), 'adder.v', 'the jump crosses into the child file');

  const down = traceSignal(index, file, src, cursor.line, cursor.character + 2, 'down')!;
  assert.ok(down.targets.some((t) => t.kind === 'sink' && t.label === 'stage_in'), 'alu_sum feeds stage_in');
  const into = down.targets.find((t) => t.kind === 'into-child');
  assert.ok(into, 'alu_sum enters u_regfile.wdata');
  assert.equal(into.label, 'u_regfile.wdata');
  assert.equal(path.basename(into.file), 'regfile.v');
});

test('trace: a fixture output port fans out to the parent connection', () => {
  // datapath.carry is an output; going down crosses to the chip_top net that
  // catches it in `.carry(dp_carry)`.
  const index = indexDir(FIXTURES);
  const file = path.join(FIXTURES, 'datapath.v');
  const src = fs.readFileSync(file, 'utf8');
  const cursor = locate(src, 'carry');

  const down = traceSignal(index, file, src, cursor.line, cursor.character + 1, 'down')!;
  assert.equal(down.name, 'carry');
  const toParent = down.targets.find((t) => t.kind === 'to-parent');
  assert.ok(toParent, 'carry reaches the parent net');
  assert.equal(toParent.label, 'dp_carry');
  assert.equal(path.basename(toParent.file), 'chip_top.v');
});
