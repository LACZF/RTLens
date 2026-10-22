import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { HdlIndex } from '../core/index';
import { buildModuleTopology, buildTopologyTree } from '../core/topology';
import type { ModuleTopology, TopoEdge } from '../core/topology';

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

function indexDir(dir: string): HdlIndex {
  const index = new HdlIndex();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (/\.(v|sv|svh|vh)$/.test(e.name)) {
        index.addFile(p, fs.readFileSync(p, 'utf8'));
      }
    }
  };
  walk(dir);
  return index;
}

/** An index holding one extra in-memory file, for shapes the fixtures lack. */
function indexWith(text: string): HdlIndex {
  const index = indexDir(path.join(FIXTURES, 'lib'));
  index.addFile(path.join(FIXTURES, 'lib', 'zz_inline.v'), text);
  return index;
}

const LIB = indexDir(path.join(FIXTURES, 'lib'));

function topology(name: string, index = LIB, opts?: { filterModules?: string[] }): ModuleTopology {
  const def = index.resolveModule(name);
  assert.ok(def, `${name} should be indexed`);
  return buildModuleTopology(index, def, opts);
}

function edgeText(e: TopoEdge): string {
  const end = (x: TopoEdge['from']) =>
    x.kind === 'signal' ? `signal:${x.name}` : `child:${x.child}.${x.port}`;
  return `${end(e.from)}->${end(e.to)}`;
}

function findEdge(model: ModuleTopology, from: string, to: string): TopoEdge | undefined {
  return model.edges.find((e) => edgeText(e) === `${from}->${to}`);
}

test('topology: chip_top reads as inputs, instances and outputs', () => {
  const m = topology('chip_top');
  assert.equal(m.path, 'chip_top');
  assert.equal(m.top, 'chip_top');
  assert.deepEqual(m.ancestors, []);
  assert.deepEqual(
    m.inputs.map((s) => s.name),
    ['clk', 'rst_n', 'operand_a', 'operand_b', 'cin', 'start'],
  );
  assert.deepEqual(m.outputs.map((s) => s.name), ['result', 'carry', 'busy']);
  assert.deepEqual(m.children.map((c) => c.id), ['u_ctrl', 'u_dpath']);
  assert.deepEqual(m.children.map((c) => c.moduleName), ['control', 'datapath']);
  assert.ok(m.children.every((c) => c.resolved));

  // Port widths are folded, and a `#(...)` override is resolved through the
  // parent, so `WIDTH` shows its value instead of its own name.
  const dpath = m.children.find((c) => c.id === 'u_dpath');
  assert.ok(dpath);
  assert.equal(dpath.params, 'WIDTH=8, DEPTH=4');
  assert.equal(dpath.ports.find((p) => p.name === 'a')?.width, 8);
});

test('topology: a plain alias is one net, not an expression edge', () => {
  // `assign carry = dp_carry;` is a buffer: the picture shows the child's
  // output port reaching the module output directly.
  const m = topology('chip_top');
  const e = findEdge(m, 'child:u_dpath.carry', 'signal:carry');
  assert.ok(e, 'u_dpath.carry -> carry should exist');
  assert.equal(e.kind, 'port');
  assert.equal(e.label, undefined);
});

test('topology: an input port reaches every instance it feeds', () => {
  const m = topology('chip_top');
  for (const child of ['u_ctrl', 'u_dpath']) {
    const e = findEdge(m, 'signal:clk', `child:${child}.clk`);
    assert.ok(e, `clk -> ${child}.clk should exist`);
    assert.equal(e.kind, 'port');
  }
  const rst = findEdge(m, 'signal:rst_n', 'child:u_dpath.rst_n');
  assert.equal(rst?.kind, 'port');
});

test('topology: two instances sharing a net are wired to each other', () => {
  const m = topology('chip_top');
  const e = findEdge(m, 'child:u_ctrl.op_we', 'child:u_dpath.we');
  assert.ok(e, 'u_ctrl.op_we -> u_dpath.we should exist');
  assert.equal(e.kind, 'port');
  assert.ok(findEdge(m, 'child:u_ctrl.op_wad', 'child:u_dpath.waddr'));
  assert.ok(findEdge(m, 'child:u_ctrl.op_rad', 'child:u_dpath.raddr'));
});

test('topology: a non-alias assignment becomes a labelled expression edge', () => {
  // `assign result = stage_in;` is identity, but `stage_in` itself is driven by
  // a ternary, so everything that feeds the ternary reaches `result` across an
  // expression edge.
  const m = topology('datapath');
  const e = findEdge(m, 'child:u_adder.sum', 'signal:result');
  assert.ok(e, 'u_adder.sum -> result should exist');
  assert.equal(e.kind, 'expression');
  assert.equal(e.label, 'alu_cout ? rf_rdata : alu_sum');
  assert.ok(findEdge(m, 'child:u_regfile.rdata', 'signal:result'));
});

test('topology: a child output can pass straight through to a module output', () => {
  const m = topology('datapath');
  const e = findEdge(m, 'child:u_adder.cout', 'signal:carry');
  assert.equal(e?.kind, 'port');
  // And the same child output also drives the multiplexer behind `result`.
  assert.ok(findEdge(m, 'child:u_adder.cout', 'signal:result'));
});

test('topology: filtering a module drops its box and its wires', () => {
  const all = topology('chip_top');
  const filtered = topology('chip_top', LIB, { filterModules: ['control'] });
  assert.ok(all.children.some((c) => c.moduleName === 'control'));
  assert.ok(!filtered.children.some((c) => c.moduleName === 'control'));
  assert.ok(
    !filtered.edges.some((e) => edgeText(e).includes('u_ctrl')),
    'no edge may mention the filtered instance',
  );
  for (const e of filtered.edges) {
    assert.ok(
      all.edges.some((x) => edgeText(x) === edgeText(e)),
      'every surviving edge must also exist unfiltered',
    );
  }
});

test('topology: ancestors and path come from the design that instantiates the module', () => {
  const m = topology('adder');
  assert.equal(m.top, 'chip_top');
  assert.equal(m.path, 'chip_top.u_dpath.u_adder');
  assert.deepEqual(m.ancestors.map((a) => a.path), ['chip_top', 'chip_top.u_dpath']);
  assert.deepEqual(m.ancestors.map((a) => a.moduleName), ['chip_top', 'datapath']);
  assert.ok(m.ancestors.every((a) => a.instRange !== undefined));
});

test('topology: an unresolved instance keeps its box but draws no wire', () => {
  const index = indexWith(`module uses_missing(input logic a, output logic y);
  missing_leaf u (?);
  assign y = a;
endmodule
`);
  const m = topology('uses_missing', index);
  assert.equal(m.children.length, 1);
  assert.equal(m.children[0].resolved, false);
  assert.deepEqual(m.children[0].ports, []);
  assert.ok(m.warnings.some((w) => w.message.includes('missing_leaf')));
});

test('topology: positional connections map onto the child port order', () => {
  const index = indexWith(`module pos_leaf(input logic a, input logic b, output logic y);
  assign y = a & b;
endmodule
module pos_top(input logic i, input logic j, output logic o);
  pos_leaf u (i, j, o);
endmodule
`);
  const m = topology('pos_top', index);
  const child = m.children[0];
  assert.deepEqual(child.ports.map((p) => p.name), ['a', 'b', 'y']);
  assert.ok(child.ports.every((p) => p.connected));
  assert.equal(findEdge(m, 'signal:i', 'child:u.a')?.kind, 'port');
  assert.equal(findEdge(m, 'signal:j', 'child:u.b')?.kind, 'port');
  assert.equal(findEdge(m, 'child:u.y', 'signal:o')?.kind, 'port');
});

test('topology: .* connects every unnamed port to the signal of its name', () => {
  const index = indexWith(`module star_leaf(input logic a, output logic y);
  assign y = a;
endmodule
module star_top(input logic a, output logic y);
  star_leaf u (.*);
endmodule
`);
  const m = topology('star_top', index);
  assert.ok(findEdge(m, 'signal:a', 'child:u.a'));
  assert.ok(findEdge(m, 'child:u.y', 'signal:y'));
});

test('topology: an empty named connection is listed but not connected', () => {
  const index = indexWith(`module nc_leaf(input logic a, output logic y);
  assign y = a;
endmodule
module nc_top(input logic a);
  nc_leaf u (.a(a), .y());
endmodule
`);
  const m = topology('nc_top', index);
  const port = m.children[0].ports.find((p) => p.name === 'y');
  assert.ok(port);
  assert.equal(port.connected, false);
  assert.equal(m.edges.filter((e) => edgeText(e).includes('u.y')).length, 0);
});

test('topology tree: depth one keeps the root and its direct instances', () => {
  const tree = buildTopologyTree(LIB, 'chip_top', undefined, { maxDepth: 1 });
  assert.ok(tree);
  assert.equal(tree.top, 'chip_top');
  assert.equal(tree.rootKey, 'chip_top');
  assert.deepEqual(
    tree.frames.map((f) => f.key),
    ['chip_top', 'chip_top.u_ctrl', 'chip_top.u_dpath'],
  );
  assert.equal(tree.truncated, true);
  assert.deepEqual(tree.frames[0].children, ['chip_top.u_ctrl', 'chip_top.u_dpath']);
  assert.equal(tree.frames[1].parent, 'chip_top');
});

test('topology tree: frames are keyed by instance path, not by module definition', () => {
  const index = indexWith(`module twin(input logic a, output logic y);
  assign y = a;
endmodule
module twin_top(input logic a, output logic y, output logic z);
  twin left (a, y);
  twin right (a, z);
endmodule
`);
  const tree = buildTopologyTree(index, 'twin_top');
  assert.ok(tree);
  assert.deepEqual(
    tree.frames.map((f) => f.key),
    ['twin_top', 'twin_top.left', 'twin_top.right'],
  );
  // Same definition, two independent frames with their own ancestor chain.
  assert.deepEqual(tree.frames[1].model.ancestors.map((a) => a.path), ['twin_top']);
  assert.deepEqual(tree.frames[2].model.ancestors.map((a) => a.path), ['twin_top']);
  assert.equal(tree.truncated, false);
});

test('topology tree: the root may be a mid-hierarchy module', () => {
  const tree = buildTopologyTree(LIB, 'datapath');
  assert.ok(tree);
  assert.equal(tree.top, 'chip_top');
  assert.equal(tree.rootKey, 'chip_top.u_dpath');
  // The design ancestors are carried on the root frame, so the view can still
  // go up to the top even though generation started here.
  assert.deepEqual(tree.frames[0].model.ancestors.map((a) => a.path), ['chip_top']);
  assert.deepEqual(
    tree.frames.map((f) => f.key),
    ['chip_top.u_dpath', 'chip_top.u_dpath.u_adder', 'chip_top.u_dpath.u_regfile'],
  );
});

test('topology tree: filterModules removes the subtree and maxFrames reports truncation', () => {
  const filtered = buildTopologyTree(LIB, 'chip_top', undefined, { filterModules: ['adder'] });
  assert.ok(filtered);
  assert.ok(!filtered.frames.some((f) => f.moduleName === 'adder'));
  assert.ok(!filtered.frames.some((f) => f.key.includes('u_adder')));

  const capped = buildTopologyTree(LIB, 'chip_top', undefined, { maxFrames: 2 });
  assert.ok(capped);
  assert.equal(capped.frames.length, 2);
  assert.equal(capped.truncated, true);
});
