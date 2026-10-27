import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { HdlIndex } from '../core/index';
import { calleesOf, callersOf, callSiteAt, findFunction } from '../core/calls';
import { traceAt } from '../core/trace';

const SRC = `package pkg;
  function automatic int double_it(input int x);
    return x + x;
  endfunction
endpackage

module tb;
  import pkg::*;

  function automatic int add_one(input int x);
    return x + 1;
  endfunction

  function automatic int compute(input int x);
    int y;
    y = add_one(x);
    if (x > 0) begin
      y = double_it(y);
    end
    for (int i = 0; i < 2; i++) begin
      y = add_one(y);
    end
    check(y);
    return y;
  endfunction

  task automatic check(input int v);
    compute(v);
  endtask

  task automatic fire;
    check(1);
  endtask

  initial begin
    check(3);
    fire;
  end
endmodule`;

const FILE = '/w/calls.sv';

function setup() {
  const index = new HdlIndex();
  index.addFile(FILE, SRC);
  const mod = index.resolveModule('tb');
  assert.ok(mod);
  return { index, mod, src: SRC };
}

function at(source: string, needle: string, offset = 0, last = false): { line: number; character: number } {
  const idx = last ? source.lastIndexOf(needle) : source.indexOf(needle);
  assert.notEqual(idx, -1, `"${needle}" is present`);
  const before = source.slice(0, idx + offset);
  const line = before.split('\n').length - 1;
  const character = before.length - (before.lastIndexOf('\n') + 1);
  return { line, character };
}

test('calls: parser records calls in assignments, if/for bodies, returns, and bare tasks', () => {
  const { mod } = setup();
  const compute = mod.funcs.find((f) => f.name === 'compute')!;
  const check = mod.funcs.find((f) => f.name === 'check')!;
  const fire = mod.funcs.find((f) => f.name === 'fire')!;

  assert.deepEqual(compute.calls?.map((c) => c.name), ['add_one', 'double_it', 'add_one', 'check']);
  assert.deepEqual(check.calls?.map((c) => c.name), ['compute']);
  assert.deepEqual(fire.calls?.map((c) => c.name), ['check']);
  assert.equal(check.calls?.[0].owner, 'check');
  assert.equal(mod.calls?.filter((c) => !c.owner).length, 2);
  assert.ok(mod.calls?.some((c) => c.name === 'fire' && c.argCount === 0));
});

test('calls: named connections and instance names are not call sites', () => {
  const src = `module child #(parameter WIDTH = 1) (input wire clk, output wire o);
  assign o = clk;
endmodule

module top;
  function automatic int f(input int x);
    return x;
  endfunction

  wire clk, o;
  child #(.WIDTH(f(1))) u_child (.clk(clk), .o(o));
  initial f(2);
endmodule`;
  const index = new HdlIndex();
  index.addFile('/w/inst.sv', src);
  const mod = index.resolveModule('top');
  assert.ok(mod);
  assert.deepEqual(mod.calls?.map((c) => c.name), ['f', 'f']);
});

test('calls: function arguments and package imports resolve to their declarations', () => {
  const { index, mod } = setup();
  const target = findFunction(index, mod, 'double_it');
  assert.ok(target);
  assert.equal(target.mod.name, 'pkg');
  assert.equal(target.fn.name, 'double_it');
});

test('calls: F3 on a definition lists its call sites', () => {
  const { index } = setup();
  const pos = at(SRC, 'compute(input int x)');
  const res = traceAt(index, FILE, SRC, pos.line, pos.character, 'up');
  assert.ok(res);
  assert.equal(res.name, 'compute');
  assert.equal(res.targets.length, 1);
  assert.equal(res.targets[0].kind, 'call-site');
  assert.equal(res.targets[0].range.start.line, at(SRC, 'compute(v)').line);
});

test('calls: F3 on a call lands on the containing definition', () => {
  const { index } = setup();
  const pos = at(SRC, 'compute(v)');
  const res = traceAt(index, FILE, SRC, pos.line, pos.character, 'up');
  assert.ok(res);
  assert.equal(res.targets[0].kind, 'caller-definition');
  assert.equal(res.targets[0].label, 'check');
});

test('calls: F4 on a call lands on the callee definition', () => {
  const { index } = setup();
  const pos = at(SRC, 'compute(v)');
  const res = traceAt(index, FILE, SRC, pos.line, pos.character, 'down');
  assert.ok(res);
  assert.equal(res.targets[0].kind, 'callee-definition');
  assert.equal(res.targets[0].label, 'compute');
});

test('calls: F4 on a definition lists the calls in its body', () => {
  const { index } = setup();
  const pos = at(SRC, 'compute(input int x)');
  const res = traceAt(index, FILE, SRC, pos.line, pos.character, 'down');
  assert.ok(res);
  assert.deepEqual(res.targets.map((t) => t.label), ['add_one()', 'double_it()', 'add_one()', 'check()']);
  assert.ok(res.targets.every((t) => t.kind === 'call-site'));
});

test('calls: an imported package function is a callee', () => {
  const { index } = setup();
  const pos = at(SRC, 'double_it(y)');
  const res = traceAt(index, FILE, SRC, pos.line, pos.character, 'down');
  assert.ok(res);
  assert.equal(res.targets[0].kind, 'callee-definition');
  assert.match(res.targets[0].detail, /pkg/);
});

test('calls: a module-level call traces up to the module definition', () => {
  const { index } = setup();
  const pos = at(SRC, 'check(3)');
  const res = traceAt(index, FILE, SRC, pos.line, pos.character, 'up');
  assert.ok(res);
  assert.equal(res.targets[0].kind, 'caller-definition');
  assert.equal(res.targets[0].label, 'tb');
});

test('calls: a bare task enable is recorded and traces both ways', () => {
  const { index, mod } = setup();
  const pos = at(SRC, '\n    fire;', 5);
  const site = callSiteAt(mod, pos.line, pos.character);
  assert.ok(site);
  assert.equal(site.name, 'fire');

  const up = traceAt(index, FILE, SRC, pos.line, pos.character, 'up');
  assert.ok(up);
  assert.equal(up.targets[0].label, 'tb');

  const down = traceAt(index, FILE, SRC, pos.line, pos.character, 'down');
  assert.ok(down);
  assert.equal(down.targets[0].label, 'fire');
});

test('calls: callers and callees are grouped one level deep', () => {
  const { index, mod } = setup();
  const check = mod.funcs.find((f) => f.name === 'check')!;
  const callers = callersOf(index, mod, check);
  assert.deepEqual(callers.map((h) => h.owner?.name ?? h.mod.name), ['compute', 'fire', 'tb']);

  const compute = mod.funcs.find((f) => f.name === 'compute')!;
  assert.equal(calleesOf(index, mod, compute).length, 4);
});
