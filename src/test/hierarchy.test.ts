import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { HdlIndex } from '../core/index';
import { containingDesign, signalWidth } from '../core/hierarchy';

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
