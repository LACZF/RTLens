import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { HdlIndex } from '../core/index';
import { signalWidth } from '../core/hierarchy';
import { typeWidth, EMPTY_SCOPE } from '../core/fold';

const FIXTURES = path.resolve(__dirname, '..', '..', 'test', 'fixtures');

const SRC = `
package types_pkg;
  typedef logic [7:0] byte_t;
  typedef enum logic [1:0] { IDLE, RUN, DONE } state_e;
endpackage

// A type written at file scope, shared with every module below the way a
// header's types are shared with the files that include it.
typedef logic [15:0] word16_t;

module holder;
  import types_pkg::*;

  typedef logic [7:0] local_t;
  typedef local_t     alias_t;
  typedef alias_t     deep_t;
  typedef struct { logic a; logic b; } pair_t;
  typedef logic [15:0] mem_t [0:1];

  local_t            q_local;
  alias_t            q_alias;
  deep_t             q_deep;
  state_e            q_state;
  types_pkg::state_e q_qualified;
  byte_t             q_imported;
  word16_t           q_filescope;
  pair_t             q_pair;
  mem_t              q_mem;
endmodule
`;

const NESTED = `
module parent;
  typedef logic [7:0] wide_t;
  wide_t parent_sig;
  child u_child ();
endmodule

module child;
  typedef logic [31:0] wide_t;
  wide_t child_sig;
endmodule
`;

const CYCLE = `
typedef b_t a_t;
typedef a_t b_t;
module m;
  a_t x;
endmodule
`;

function freshIndex(src = SRC): HdlIndex {
  const index = new HdlIndex();
  index.addFile('/w/lib.sv', src);
  return index;
}

/** Width of a module's signal, through the scope the module would get. */
function declWidth(index: HdlIndex, mod: string, name: string): number | undefined {
  const def = index.resolveModule(mod);
  assert.ok(def, `module ${mod} is indexed`);
  const hit = index.findDecl(def, name);
  assert.ok(hit, `${name} is declared in ${mod}`);
  assert.ok(hit.kind === 'var', `${name} is a signal`);
  return typeWidth(hit.decl.dataType, index.scopeFor(def));
}

test('width: a signal typed by a local typedef gets the typedef width', () => {
  assert.equal(declWidth(freshIndex(), 'holder', 'q_local'), 8);
});

test('width: a chain of typedefs resolves to the type that has the width', () => {
  const index = freshIndex();
  assert.equal(declWidth(index, 'holder', 'q_alias'), 8, 'typedef of a typedef');
  assert.equal(declWidth(index, 'holder', 'q_deep'), 8, 'typedef of a typedef of a typedef');
});

test('width: an enum-typed signal is as wide as its base type', () => {
  const index = freshIndex();
  assert.equal(declWidth(index, 'holder', 'q_state'), 2, 'imported from the package');
  assert.equal(declWidth(index, 'holder', 'q_qualified'), 2, 'package-qualified name');
});

test('width: an imported package type and a file-scope type both size signals', () => {
  const index = freshIndex();
  assert.equal(declWidth(index, 'holder', 'q_imported'), 8);
  assert.equal(declWidth(index, 'holder', 'q_filescope'), 16);
});

test('width: an array typedef carries its dimensions into the total', () => {
  assert.equal(declWidth(freshIndex(), 'holder', 'q_mem'), 32);
});

test('width: a struct typedef keeps the old one-bit answer', () => {
  assert.equal(declWidth(freshIndex(), 'holder', 'q_pair'), 1);
});

test('width: a type from an included header sizes the signal', () => {
  const index = new HdlIndex();
  index.addFile('/w/bus.svh', 'typedef logic [11:0] bus_t;\n');
  index.addFile('/w/top.v', '`include "bus.svh"\nmodule top;\n  bus_t q;\nendmodule\n');
  assert.equal(declWidth(index, 'top', 'q'), 12);
});

test('width: a child module resolves type names in its own scope', () => {
  const index = freshIndex(NESTED);
  // Both modules define `wide_t`; each signal must get its own module's type.
  assert.equal(signalWidth(index, 'parent', 'parent_sig'), 8);
  assert.equal(signalWidth(index, 'parent.u_child', 'child_sig'), 32);
});

test('width: mutual typedefs terminate at one bit instead of recursing', () => {
  assert.equal(declWidth(freshIndex(CYCLE), 'm', 'x'), 1);
});

test('width: a scope without a resolver still says one bit', () => {
  const unresolvable = { t: 'user', name: 'nothing_declares_this' };
  assert.equal(typeWidth(unresolvable, EMPTY_SCOPE), 1);
});

test('width: the fixture enum signals carry their base type width', () => {
  const index = new HdlIndex();
  index.addFile('/f/sv.sv', readFileSync(path.join(FIXTURES, 'sv.sv'), 'utf8'));
  assert.equal(signalWidth(index, 'alu', 'op_q'), 2);
  assert.equal(signalWidth(index, 'alu', 'phase'), 2);
});
