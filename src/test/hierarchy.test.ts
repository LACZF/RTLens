import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { HdlIndex } from '../core/index';
import { signalWidth } from '../core/hierarchy';

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
