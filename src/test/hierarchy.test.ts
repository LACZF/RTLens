import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { HdlIndex } from '../core/index';
import { buildHierarchy, containingDesign, signalWidth, findByPath, pathChain } from '../core/hierarchy';

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

test('containingDesign: a module definition is placed inside the design that instantiates it', () => {
  // A module's own file does not say who instantiates it, so a graph opened from
  // adder's definition used to have an empty containing chain: the left-edge +
  // found nothing. Walking the reverse instances puts chip_top above datapath
  // above adder.
  const index = indexDir(path.join(FIXTURES, 'lib'));
  const adder = containingDesign(index, 'adder');
  assert.ok(adder, 'adder is instantiated somewhere');
  assert.equal(adder!.root.path, 'chip_top', 'the design root is the never-instantiated top');
  assert.equal(adder!.node.path, 'chip_top.u_dpath.u_adder', 'the instance sits on its full path');
  assert.equal(adder!.node.parentPath, 'chip_top.u_dpath', 'and its parent is the datapath instance');

  const datapath = containingDesign(index, 'datapath');
  assert.equal(datapath!.root.path, 'chip_top');
  assert.equal(datapath!.node.path, 'chip_top.u_dpath');

  const control = containingDesign(index, 'control');
  assert.equal(control!.node.path, 'chip_top.u_ctrl', 'a sibling instance is found just as well');
});

test('containingDesign: a configured top wins even when a testbench instantiates it', () => {
  // With the testbench in the index, plain never-instantiated inference would
  // root the chain at tb_chip_top. A configured top module is a stop point, so
  // "chip_top -> datapath -> adder" is what comes back.
  const index = indexDir(FIXTURES);
  const without = containingDesign(index, 'adder');
  assert.equal(without!.root.path, 'tb_chip_top', 'the closest design root is the testbench');
  const withTop = containingDesign(index, 'adder', undefined, ['chip_top']);
  assert.equal(withTop!.root.path, 'chip_top', 'naming the top stops the walk there');
  assert.equal(withTop!.node.path, 'chip_top.u_dpath.u_adder');
});

test('containingDesign: a real top is its own root, so its chain stays empty', () => {
  const index = indexDir(path.join(FIXTURES, 'lib'));
  const top = containingDesign(index, 'chip_top');
  assert.equal(top!.root.path, 'chip_top');
  assert.equal(top!.node.path, 'chip_top', 'nothing is above a top, so the node is the root');
});

test('containingDesign forwards its depth/budget options into the built tree', () => {
  const index = new HdlIndex();
  index.addFile(
    '/w/chain.v',
    [
      'module m3 (); endmodule',
      'module m2 (); m3 u (); endmodule',
      'module m1 (); m2 u (); endmodule',
      'module m0 (); m1 u (); endmodule',
    ].join('\n'),
  );
  const full = containingDesign(index, 'm3', undefined, [], { maxDepth: 0 });
  assert.equal(full!.root.path, 'm0');
  assert.ok(findByPath(full!.root, 'm0.u.u.u'), 'with no depth limit the deep node is built');
  assert.equal(full!.node.path, 'm0.u.u.u', 'so the containing node is found');
  const shallow = containingDesign(index, 'm3', undefined, [], { maxDepth: 1 });
  assert.equal(shallow, undefined, 'a shallow limit cannot reach the module, so there is no chain to return');
});

test('hierarchy: a wide module lists every instance when the budget is unlimited', () => {
  // The Composition tree lifts both caps, so a module with tens of thousands of
  // instances must expand in full, not stop at the historic 20000 budget.
  const n = 30000;
  let src = 'module leaf (); endmodule\nmodule wide ();\n';
  for (let i = 0; i < n; i++) {
    src += `  leaf u${i} ();\n`;
  }
  src += 'endmodule\n';
  const index = new HdlIndex();
  index.addFile('/w/wide.v', src);
  const res = buildHierarchy(index, 'wide', { maxDepth: 0, maxInstances: 0 })!;
  assert.equal(res.totalNodes, n, 'every instance is a node');
  assert.equal(res.truncated, false, 'nothing is cut off');
  assert.equal(res.root.children!.length, n, 'and they all hang off the root');
  assert.equal(findByPath(res.root, `wide.u${n - 1}`)?.moduleName, 'leaf', 'the last one is reachable');
});

test('hierarchy: a deep chain builds and navigates without exhausting the stack', () => {
  // Depth 0 means no limit; the builder walks this iteratively so a chain of
  // distinct modules far past the call-stack size still comes out whole.
  const n = 20000;
  let src = '';
  for (let i = 0; i < n; i++) {
    src += i < n - 1 ? `module m${i} (); m${i + 1} u (); endmodule\n` : `module m${i} (); endmodule\n`;
  }
  const index = new HdlIndex();
  index.addFile('/w/chain.v', src);
  const res = buildHierarchy(index, 'm0', { maxDepth: 0, maxInstances: 0 })!;
  assert.equal(res.totalNodes, n - 1, 'every link is a node');
  assert.equal(res.truncated, false, 'the depth cap is lifted');

  // Both navigation helpers descend the whole chain (segment-wise, so they stay
  // linear instead of rescanning the path at every level).
  const deepest = 'm0' + '.u'.repeat(n - 1);
  assert.equal(findByPath(res.root, deepest)?.moduleName, `m${n - 1}`, 'findByPath reaches the bottom');
  assert.equal(pathChain(res.root, deepest).length, n, 'pathChain walks the whole chain');
  assert.equal(findByPath(res.root, 'm0.u.nope'), undefined, 'a path that veers off is not found');
});

test('hierarchy: a depth cap does not mistake a later same-named sibling for a cycle', () => {
  // The iterative builder must drop a frame's name from the active-path set on
  // every exit, including the depth-cap exit - otherwise the second `mid` here
  // would be read as a recursive instantiation.
  const index = new HdlIndex();
  index.addFile(
    '/w/s.v',
    [
      'module leaf (); endmodule',
      'module mid (); leaf x (); endmodule',
      'module top (); mid a (); mid b (); endmodule',
    ].join('\n'),
  );
  const res = buildHierarchy(index, 'top', { maxDepth: 1 })!;
  assert.equal(res.totalNodes, 2, 'both mid instances are created');
  const a = findByPath(res.root, 'top.a')!;
  const b = findByPath(res.root, 'top.b')!;
  assert.equal(a.cycle, false, 'the first mid is not a cycle');
  assert.equal(b.cycle, false, 'nor is the second');
  assert.equal(a.truncated, true, 'the depth cap cut both subtrees');
  assert.equal(b.truncated, true);
});

test('findByPath: a sibling whose name merely prefixes the target is not mistaken for it', () => {
  // The descent matches one whole instance segment at a time; a naive prefix
  // match would stop at `top.u` for `top.u_extra`.
  const index = new HdlIndex();
  index.addFile(
    '/w/p.v',
    'module leaf (); endmodule\nmodule top (); leaf u (); leaf u_extra (); endmodule\n',
  );
  const root = buildHierarchy(index, 'top')!.root;
  assert.equal(findByPath(root, 'top.u_extra')?.path, 'top.u_extra', 'the longer sibling wins');
  assert.equal(findByPath(root, 'top.u')?.path, 'top.u', 'and the short one still resolves');
  assert.deepEqual(
    pathChain(root, 'top.u_extra').map((n) => n.path),
    ['top', 'top.u_extra'],
    'the chain follows the exact segment',
  );
});

test('hierarchy: the width of a signal is every dimension it was declared with', () => {
  // The tree view shows this number. It used to be the first packed range and
  // nothing else, so a 32-bit `logic [3:0][7:0]` signal was shown as 4 bits
  // while the generator, which multiplies the rest in, said 32 - and the code
  // lens on an index of it agreed with neither.
  const index = new HdlIndex();
  index.addFile(
    '/w/m.sv',
    `module m (input wire [3:0][7:0] din, input wire [3:0] bus [0:1], input wire [7:0] flat);
  logic [3:0][7:0] buf;
  wire [7:0] mem [0:3];
  wire [3:0][7:0] both [0:1];
  int i;
  wire [W-1:0] folded;
  parameter int W = 4;
  assign buf = din;
  assign mem[1] = din[1];
  assign both[0] = din;
  assign flat = buf[2];
  assign i = 0;
  assign folded = flat;
endmodule`,
  );
  assert.equal(signalWidth(index, 'm', 'din'), 32, 'four times eight');
  assert.equal(signalWidth(index, 'm', 'buf'), 32);
  assert.equal(signalWidth(index, 'm', 'bus'), 8, 'two elements of four');
  assert.equal(signalWidth(index, 'm', 'mem'), 32, 'four elements of eight');
  assert.equal(signalWidth(index, 'm', 'both'), 64, 'and both kinds together');
  assert.equal(signalWidth(index, 'm', 'flat'), 8, 'a single range is unchanged');
  assert.equal(signalWidth(index, 'm', 'i'), 32, 'an integer is 32 bits');
  assert.equal(signalWidth(index, 'm', 'folded'), 4, 'a range written in terms of a parameter');
  assert.equal(signalWidth(index, 'm', 'nope'), undefined, 'an unknown name has no width');
});
