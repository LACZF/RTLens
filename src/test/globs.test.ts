import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { braceGlob, matchesGlob } from '../core/globs';

test('globs: the exclude defaults match what they are meant to', () => {
  // These patterns decide what leaves the index. A pattern that quietly fails to
  // match puts every testbench file into the workspace index.
  const defaults = ['**/tb/**', '**/testbench/**', '**/*_tb.v', '**/*_tb.sv', '**/build/**', '**/output/**'];
  const excluded = [
    'tb/top_tb.v',
    'rtl/tb/deep/nested_tb.v',
    'testbench/bench.sv',
    'a/b/testbench/c.sv',
    'top_tb.v',
    'counter_tb.sv',
    'build/generated.v',
    'rtl/output/rtl.v',
  ];
  const kept = ['rtl/top.v', 'rtl/counter.sv', 'rtl/sub/leaf.svh', 'src/tb_helper.v', 'rtl/table.v'];
  for (const f of excluded) {
    assert.ok(defaults.some((p) => matchesGlob(f, p)), `${f} is excluded`);
  }
  for (const f of kept) {
    assert.ok(!defaults.some((p) => matchesGlob(f, p)), `${f} is kept`);
  }
});

test('globs: a directory pattern does not match the bare name', () => {
  // `**/tb/**` is about what is inside the directory.
  assert.equal(matchesGlob('tb', '**/tb/**'), false);
  assert.equal(matchesGlob('tb/a.v', '**/tb/**'), true);
  assert.equal(matchesGlob('a/tb/a.v', '**/tb/**'), true);
  // A suffix pattern is about the file name.
  assert.equal(matchesGlob('tb/x_tb.v', '**/*_tb.v'), true);
  assert.equal(matchesGlob('x_tb.v', '**/*_tb.v'), true);
  assert.equal(matchesGlob('x_tb.vh', '**/*_tb.v'), false, 'the extension is part of it');
});

test('globs: * stays inside one path segment and ** does not', () => {
  assert.equal(matchesGlob('a/b.v', '*.v'), false, 'a single star does not cross a slash');
  assert.equal(matchesGlob('b.v', '*.v'), true);
  assert.equal(matchesGlob('a/b/c.v', '**/*.v'), true);
  assert.equal(matchesGlob('c.v', '**/*.v'), true, '`**/` may match nothing at all');
  assert.equal(matchesGlob('a/b/c.v', 'a/**'), true);
  assert.equal(matchesGlob('a', 'a/**'), false);
});

test('globs: ? is one character and dots are literal', () => {
  assert.equal(matchesGlob('a1.v', 'a?.v'), true);
  assert.equal(matchesGlob('a12.v', 'a?.v'), false);
  // A dot is a literal character, not a wildcard.
  assert.equal(matchesGlob('a.v', 'a.v'), true);
  assert.equal(matchesGlob('axv', 'a.v'), false);
  assert.equal(matchesGlob('a/v', 'a.v'), false);
});

test('globs: braceGlob produces what findFiles expects', () => {
  assert.equal(braceGlob([]), '**/*');
  assert.equal(braceGlob(['**/*.v']), '**/*.v');
  assert.equal(
    braceGlob(['**/*.{v,sv,svh,vh,vlt}', 'rtl/**/*.v']),
    '{**/*.{v,sv,svh,vh,vlt},rtl/**/*.v}',
  );
});
