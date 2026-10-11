import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { HdlIndex, MAX_JUMP_TABLES } from '../core/index';

const CONTROL = ['module control (input wire clk, output reg [3:0] q);', 'endmodule'].join('\n');

const TOP = [
  'module top (input wire clk);',
  '  wire [3:0] bus;',
  '  control u_ctrl (.clk(clk), .q(bus));',
  "  assign bus = 4'h1;",
  'endmodule',
].join('\n');

const TOP_LINE_INST = 2;
const TOP_LINE_DECL = 1;

/** Character of `word` on a 0-based line. */
function at(src: string, line: number, word: string, from = 0): number {
  const text = src.split('\n')[line];
  const col = text.indexOf(word, from);
  assert.notEqual(col, -1, `"${word}" is not on line ${line}: ${text}`);
  return col;
}

/** An index holding both files, which is the state a workspace is in. */
function workspace(): HdlIndex {
  const index = new HdlIndex();
  index.addFile('/w/control.v', CONTROL);
  index.addFile('/w/top.v', TOP);
  return index;
}

test('jump: a signal occurrence is saved with the declaration it names', () => {
  const index = workspace();

  // The read inside the port connection, on the instantiating line.
  const entry = index.lookupJump('/w/top.v', TOP, TOP_LINE_INST, at(TOP, TOP_LINE_INST, 'bus', at(TOP, TOP_LINE_INST, '.q(')));
  assert.ok(entry, 'the occurrence is saved');
  assert.equal(entry.kind, 'signal');
  assert.equal(entry.target?.file, '/w/top.v');
  assert.equal(entry.target?.range.start.line, TOP_LINE_DECL);
  assert.equal(entry.target?.range.start.character, at(TOP, TOP_LINE_DECL, 'bus'));

  // And the same name as the left-hand side of an assignment.
  const assigned = index.lookupJump('/w/top.v', TOP, 3, at(TOP, 3, 'bus'));
  assert.ok(assigned);
  assert.equal(assigned.kind, 'signal');
  assert.equal(assigned.target?.range.start.line, TOP_LINE_DECL);
});

test('jump: an instance name is saved against the module it instantiates', () => {
  const index = workspace();

  const entry = index.lookupJump('/w/top.v', TOP, TOP_LINE_INST, at(TOP, TOP_LINE_INST, 'u_ctrl'));
  assert.ok(entry, 'the instance occurrence is saved');
  assert.equal(entry.kind, 'instance');
  assert.equal(entry.moduleName, 'control');
  // The declaration of the instance is the word itself, so the saved relation
  // has to point at the module or jumping would land nowhere.
  assert.equal(entry.target?.file, '/w/control.v');
  assert.equal(entry.target?.range.start.line, 0);
  assert.equal(entry.target?.range.start.character, at(CONTROL, 0, 'control'), 'the name of `module control`');
});

test('jump: a module word in an instantiation is saved against its declaration', () => {
  const index = workspace();

  const entry = index.lookupJump('/w/top.v', TOP, TOP_LINE_INST, at(TOP, TOP_LINE_INST, 'control'));
  assert.ok(entry);
  assert.equal(entry.kind, 'module');
  assert.equal(entry.target?.file, '/w/control.v');
  assert.equal(entry.target?.range.start.line, 0);
});

test('jump: an instance gets its target when the module is indexed later', () => {
  const index = new HdlIndex();
  // Only the instantiating file first, so `control` has nothing to point at.
  index.addFile('/w/top.v', TOP);

  const before = index.lookupJump('/w/top.v', TOP, TOP_LINE_INST, at(TOP, TOP_LINE_INST, 'u_ctrl'));
  assert.ok(before);
  assert.equal(before.moduleName, 'control');
  assert.equal(before.target, undefined);

  // Indexing the module has to invalidate the saved relations: a target that
  // was missing one file ago must not stay missing.
  index.addFile('/w/control.v', CONTROL);
  const after = index.lookupJump('/w/top.v', TOP, TOP_LINE_INST, at(TOP, TOP_LINE_INST, 'u_ctrl'));
  assert.ok(after);
  assert.equal(after.target?.file, '/w/control.v');
});

test('jump: a `NAME macro reference is saved against its `define', () => {
  const index = new HdlIndex();
  const src = [
    '`define DEFAULT_VALUE 5',
    'module top;',
    '  localparam int X = `DEFAULT_VALUE;',
    'endmodule',
  ].join('\n');
  index.addFile('/w/m.v', src);

  const line = 2;
  const nameCol = at(src, line, 'DEFAULT_VALUE');
  const entry = index.lookupJump('/w/m.v', src, line, nameCol);
  assert.ok(entry, 'the macro reference resolves');
  assert.equal(entry.kind, 'macro');
  assert.equal(entry.target?.file, '/w/m.v');
  assert.equal(entry.target?.range.start.line, 0);
  assert.equal(entry.target?.range.start.character, at(src, 0, 'DEFAULT_VALUE'));
  // The saved occurrence starts on the name, not the backtick before it.
  assert.equal(entry.start, nameCol);
});

test('jump: a macro reference resolves to a `define in another file', () => {
  const index = new HdlIndex();
  index.addFile('/w/defs.vh', '`define WIDTH 8\n');
  const src = ['module top;', '  wire [`WIDTH-1:0] w;', 'endmodule'].join('\n');
  index.addFile('/w/top.v', src);

  const line = 1;
  const entry = index.lookupJump('/w/top.v', src, line, at(src, line, 'WIDTH'));
  assert.ok(entry, 'a macro defined elsewhere still resolves');
  assert.equal(entry.kind, 'macro');
  assert.equal(entry.target?.file, '/w/defs.vh');
  assert.equal(entry.target?.range.start.line, 0);
});

test('jump: nothing is saved for text that is not a resolvable name', () => {
  const index = workspace();

  // Keywords and numbers are not occurrences: no relation, so no jump.
  assert.equal(index.lookupJump('/w/top.v', TOP, 3, at(TOP, 3, 'assign')), undefined);
  assert.equal(index.lookupJump('/w/top.v', TOP, 3, at(TOP, 3, '1') + 1), undefined);

  // A name that is not declared anywhere.
  const src = ['module b;', '  assign y = no_such_name;', 'endmodule'].join('\n');
  index.addFile('/w/b.v', src);
  assert.equal(index.lookupJump('/w/b.v', src, 1, at(src, 1, 'no_such_name')), undefined);
});

test('jump: a file the index never saw has no relations', () => {
  const index = workspace();

  assert.equal(index.lookupJump('/w/never.v', TOP, TOP_LINE_INST, at(TOP, TOP_LINE_INST, 'u_ctrl')), undefined);
});

test('jump: the cursor at the very start of a name still finds it', () => {
  const index = workspace();

  // `bus` in the port connection is preceded by `(` which ends where the name
  // begins, so a cursor exactly on the first character sits in both ranges.
  const start = at(TOP, TOP_LINE_INST, 'bus', at(TOP, TOP_LINE_INST, '.q('));
  const entry = index.lookupJump('/w/top.v', TOP, TOP_LINE_INST, start);
  assert.ok(entry);
  assert.equal(entry.kind, 'signal');

  // Inside the name, and just past it - the position a user gets after typing.
  assert.ok(index.lookupJump('/w/top.v', TOP, TOP_LINE_INST, start + 3));
  assert.equal(index.lookupJump('/w/top.v', TOP, TOP_LINE_INST, start + 4), undefined);
});

test('jump: removing a file drops the relations that pointed into it', () => {
  const index = workspace();
  assert.ok(index.lookupJump('/w/top.v', TOP, TOP_LINE_INST, at(TOP, TOP_LINE_INST, 'u_ctrl'))?.target);

  index.removeFile('/w/control.v');
  const after = index.lookupJump('/w/top.v', TOP, TOP_LINE_INST, at(TOP, TOP_LINE_INST, 'u_ctrl'));
  assert.ok(after, 'the occurrence itself still exists');
  assert.equal(after.target, undefined, 'the target it pointed at is gone');
});

const PEER = ['module peer (input wire clk);', '  wire p;', '  assign p = clk;', 'endmodule'].join('\n');

test('jump: a file added elsewhere does not rebuild a saved hit', () => {
  const index = workspace();
  index.lookupJump('/w/top.v', TOP, TOP_LINE_INST, at(TOP, TOP_LINE_INST, 'u_ctrl'));
  const built = index.jumpBuildCount;

  // A brand-new module name cannot change where `control` lives, so the hit is
  // still in the saved table - no rebuild while the user keeps working.
  index.addFile('/w/spare.v', 'module spare (input wire clk);\nendmodule');
  const again = index.lookupJump('/w/top.v', TOP, TOP_LINE_INST, at(TOP, TOP_LINE_INST, 'u_ctrl'));
  assert.equal(again?.target?.file, '/w/control.v');
  assert.equal(index.jumpBuildCount, built, 'the hit came from the table, not a rebuild');
});

test('jump: removing a file drops the tables that pointed into it, not every table', () => {
  const index = workspace();
  index.addFile('/w/peer.v', PEER);
  index.lookupJump('/w/top.v', TOP, TOP_LINE_INST, at(TOP, TOP_LINE_INST, 'u_ctrl'));
  index.lookupJump('/w/peer.v', PEER, 2, at(PEER, 2, 'p'));
  const built = index.jumpBuildCount;

  index.removeFile('/w/control.v');
  assert.equal(index.jumpTableCount, 1, 'only top.v pointed into control.v');

  const peer = index.lookupJump('/w/peer.v', PEER, 2, at(PEER, 2, 'p'));
  assert.ok(peer?.target, 'peer.v still resolves');
  assert.equal(index.jumpBuildCount, built, 'peer.v was not rebuilt');

  const top = index.lookupJump('/w/top.v', TOP, TOP_LINE_INST, at(TOP, TOP_LINE_INST, 'u_ctrl'));
  assert.equal(top?.target, undefined, 'the removed target is gone');
});

test('jump: the saved tables are evicted least-recently-used, not first-in-first-out', () => {
  const index = new HdlIndex();
  const count = MAX_JUMP_TABLES + 1;
  const src: string[] = [];
  for (let i = 0; i < count; i++) {
    src.push([`module m${i} (input wire clk);`, `  wire s${i};`, `  assign s${i} = clk;`, 'endmodule'].join('\n'));
    index.addFile(`/w/f${i}.v`, src[i]);
  }
  const hit = (i: number) => index.lookupJump(`/w/f${i}.v`, src[i], 1, at(src[i], 1, `s${i}`));

  // Fill the cache exactly, then use the oldest table so it is the newest again.
  for (let i = 0; i < MAX_JUMP_TABLES; i++) {
    assert.ok(hit(i)?.target, `f${i} resolves`);
  }
  assert.ok(hit(0)?.target);
  const built = index.jumpBuildCount;
  assert.equal(built, MAX_JUMP_TABLES, 'every table was built once');

  // One more table tips over the cap and evicts the least recently used one.
  assert.ok(hit(MAX_JUMP_TABLES)?.target);
  assert.equal(index.jumpBuildCount, built + 1, 'only the new file was built');
  assert.equal(index.jumpTableCount, MAX_JUMP_TABLES, 'the cap holds');

  // f0 was used a moment ago, so it survived; a first-in-first-out cache would
  // have dropped it and had to rebuild here.
  assert.ok(hit(0)?.target);
  assert.equal(index.jumpBuildCount, built + 1, 'f0 was still cached');
});

test('jump: a module defined beside the user becomes the target once it exists', () => {
  const index = new HdlIndex();
  index.addFile('/w/a/only.v', 'module dup;\nendmodule');
  const USER = ['module user;', '  dup u1();', 'endmodule'].join('\n');
  index.addFile('/w/b/user.v', USER);

  const first = index.lookupJump('/w/b/user.v', USER, 1, at(USER, 1, 'u1'));
  assert.equal(first?.target?.file, '/w/a/only.v', 'the sole definition so far');

  // The rival lives in the user's directory, and `resolveModule` prefers a
  // definition beside the reference. user.v's table did not point at the rival,
  // so it was kept - the table has to notice that the preferred definition
  // changed rather than trust its saved target.
  index.addFile('/w/b/rival.v', 'module dup;\nendmodule');
  const second = index.lookupJump('/w/b/user.v', USER, 1, at(USER, 1, 'u1'));
  assert.equal(second?.target?.file, '/w/b/rival.v', 'now the same directory wins');
});

test('jump: a header that lends a name re-aims the saved hits', () => {
  const index = new HdlIndex();
  index.addFile('/w/pkg.sv', 'package pkg;\n  typedef logic [3:0] T;\nendpackage');
  const SRC = [
    '`include "hdr.vh"',
    'import pkg::*;',
    'module m (input wire clk);',
    '  T q;',
    '  assign q = 0;',
    'endmodule',
  ].join('\n');
  index.addFile('/w/f.sv', SRC);

  const first = index.lookupJump('/w/f.sv', SRC, 3, at(SRC, 3, 'T'));
  assert.equal(first?.kind, 'type');
  assert.equal(first?.target?.file, '/w/pkg.sv', 'the package holds the type');

  // Declarations are read before the imports, so once the header lends the
  // same name the hit has to move to the header - the saved relation from
  // before is no longer where a jump should land.
  index.addFile('/w/hdr.vh', 'typedef logic [3:0] T;');
  const second = index.lookupJump('/w/f.sv', SRC, 3, at(SRC, 3, 'T'));
  assert.equal(second?.target?.file, '/w/hdr.vh', 'the header wins the name now');
});
