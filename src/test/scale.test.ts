import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { HdlIndex } from '../core/index';
import type { ModuleDef } from '../core/ast';

/** 200 back-to-back modules, 10 signals each, separated by blank lines. */
const MODULES = 200;
const DECLS = 10;
const FILE = '/w/big.v';

function bigFile(): string {
  const lines: string[] = [];
  for (let i = 0; i < MODULES; i++) {
    lines.push(`module mod${i} (input wire clk);`);
    for (let d = 0; d < DECLS; d++) {
      lines.push(`  wire sig${i}_${d};`);
    }
    lines.push('endmodule');
    lines.push('');
  }
  return lines.join('\n');
}

/** The scan `moduleAtLine` replaced, kept as the definition of what it answers. */
function scan(mods: ModuleDef[], line: number): ModuleDef | undefined {
  let best: ModuleDef | undefined;
  for (const m of mods) {
    if (line >= m.range.start.line && line <= m.range.end.line) {
      if (!best || m.range.start.line >= best.range.start.line) {
        best = m;
      }
    }
  }
  return best;
}

function built(): { index: HdlIndex; src: string; mods: ModuleDef[] } {
  const src = bigFile();
  const index = new HdlIndex();
  index.addFile(FILE, src);
  const mods = index.allModules().filter((m) => m.file === FILE);
  assert.equal(mods.length, MODULES, 'every module is indexed');
  return { index, src, mods };
}

test('scale: the module under a line matches a scan over every line', () => {
  const { index, src, mods } = built();

  const lines = src.split('\n');
  for (let line = 0; line <= lines.length; line++) {
    assert.equal(index.moduleAtLine(FILE, line), scan(mods, line), `line ${line}`);
  }

  // One file of the size itself: an unknown file has no modules to offer.
  assert.equal(index.moduleAtLine('/w/nothing.v', 3), undefined);
});

test('scale: one module among hundreds sees only its own declarations', () => {
  const { index, mods } = built();

  const mod = mods.find((m) => m.name === 'mod137');
  assert.ok(mod, 'the module exists');

  const own = index.findDecl(mod, 'sig137_5');
  assert.ok(own, 'its own signal resolves');
  assert.equal(own.kind, 'var');
  assert.equal(own.decl.name, 'sig137_5');
  assert.equal(own.decl.range.start.line, mod.range.start.line + 6, 'the sixth wire line');

  // A name with the same shape in another module is not in scope here, which is
  // what a shared or bleeding name table would get wrong.
  assert.equal(index.findDecl(mod, 'sig000_0'), undefined, 'module scope does not leak');

  // And a fresh scope built for the same module agrees with the cached one.
  assert.equal(index.findDecl(mod, 'sig137_5')?.decl, own.decl, 'the cached table is stable');
});

test('scale: saved relations are counted once and never left behind', () => {
  const { index, src } = built();

  // Several queries in one file build the table exactly once and reuse it.
  index.lookupJump(FILE, src, 1, src.split('\n')[1].indexOf('sig0_0'));
  const builds = index.jumpBuildCount;
  const entries = index.jumpEntryCount;
  assert.ok(entries > MODULES, 'every signal relation was saved');
  for (const mod of [0, 1, 50, 199]) {
    const line = mod * (DECLS + 3);
    index.lookupJump(FILE, src, line, src.split('\n')[line].indexOf('mod'));
  }
  assert.equal(index.jumpBuildCount, builds, 'the table was reused');

  index.removeFile(FILE);
  assert.equal(index.jumpTableCount, 0, 'the table was dropped');
  assert.equal(index.jumpEntryCount, 0, 'and its relations were released');

  index.clear();
  assert.equal(index.jumpEntryCount, 0, 'clearing leaves no relations behind');
});
