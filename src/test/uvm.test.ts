import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { HdlIndex } from '../core/index';
import { calleesOf, callersOf, findFunction } from '../core/calls';
import { traceAt } from '../core/trace';

const SRC = `package uvm_pkg;
  class uvm_object;
    virtual function void build_phase(int phase);
    endfunction
    virtual task run_phase(int phase);
    endtask
  endclass

  class my_driver extends uvm_object;
    protected function void build_phase(int phase);
      super.build_phase(phase);
    endfunction
    local task run_phase(int phase);
      this.helper();
    endtask
    local task helper();
    endtask
    function void drive(my_driver other);
      other.build_phase(1);
      this.build_phase(2);
    endfunction
  endclass
endpackage
`;

const FILE = '/w/uvm.sv';

function setup(): HdlIndex {
  const index = new HdlIndex();
  index.addFile(FILE, SRC);
  return index;
}

function at(needle: string, offset = 0): { line: number; character: number } {
  const idx = SRC.indexOf(needle);
  assert.notEqual(idx, -1, `"${needle}" is present`);
  const before = SRC.slice(0, idx + offset);
  const line = before.split('\n').length - 1;
  return { line, character: before.length - (before.lastIndexOf('\n') + 1) };
}

function lineOf(needle: string): number {
  return at(needle).line;
}

test('uvm: protected and local class methods parse and the superclass is recorded', () => {
  const index = setup();
  const driver = index.resolveModule('my_driver');
  const base = index.resolveModule('uvm_object');
  assert.ok(driver);
  assert.ok(base);
  assert.equal(driver.kind, 'class');
  assert.equal(driver.superClass, 'uvm_object');
  assert.equal(driver.usesUnknownConstruct, false);
  assert.deepEqual(driver.funcs.map((f) => f.name), ['build_phase', 'run_phase', 'helper', 'drive']);
  assert.deepEqual(base.funcs.map((f) => f.name), ['build_phase', 'run_phase']);
});

test('uvm: pure virtual, extern and multi-modifier methods parse', () => {
  const src = `class base_c;
    pure virtual function void pure_fn();
    endfunction
    extern function void ext_fn();
    endfunction
    protected static function void both();
    endfunction
    local virtual task staged();
    endtask
  endclass`;
  const index = new HdlIndex();
  index.addFile('/w/mods.sv', src);
  const mod = index.resolveModule('base_c');
  assert.ok(mod);
  assert.equal(mod.usesUnknownConstruct, false);
  assert.deepEqual(mod.funcs.map((f) => f.name), ['pure_fn', 'ext_fn', 'both', 'staged']);
});

test('uvm: call hierarchy follows super, this and receiver method calls', () => {
  const index = setup();
  const driver = index.resolveModule('my_driver')!;
  const base = index.resolveModule('uvm_object')!;
  const baseBuild = findFunction(index, base, 'build_phase')!;
  const driverBuild = findFunction(index, driver, 'build_phase')!;
  const drive = findFunction(index, driver, 'drive')!;
  const runPhase = findFunction(index, driver, 'run_phase')!;

  assert.deepEqual(
    callersOf(index, base, baseBuild.fn).map((h) => `${h.owner?.name}:${h.site.fullPath}`),
    ['build_phase:super.build_phase'],
  );
  assert.deepEqual(
    callersOf(index, driver, driverBuild.fn).map((h) => `${h.owner?.name}:${h.site.fullPath}`),
    ['drive:other.build_phase', 'drive:this.build_phase'],
  );
  assert.deepEqual(
    calleesOf(index, driver, driverBuild.fn).map((h) => `${h.target.mod.name}.${h.target.fn.name}`),
    ['uvm_object.build_phase'],
  );
  assert.deepEqual(
    calleesOf(index, driver, drive.fn).map((h) => `${h.target.mod.name}.${h.target.fn.name}`),
    ['my_driver.build_phase', 'my_driver.build_phase'],
  );
  assert.deepEqual(
    calleesOf(index, driver, runPhase.fn).map((h) => `${h.target.mod.name}.${h.target.fn.name}`),
    ['my_driver.helper'],
  );
});

test('uvm: trace up and down on super, this and receiver calls', () => {
  const index = setup();

  const superPos = at('super.build_phase', 6);
  const superDown = traceAt(index, FILE, SRC, superPos.line, superPos.character, 'down');
  const superUp = traceAt(index, FILE, SRC, superPos.line, superPos.character, 'up');
  assert.ok(superDown);
  assert.ok(superUp);
  assert.equal(superDown.targets[0].kind, 'callee-definition');
  assert.equal(superDown.targets[0].label, 'build_phase');
  assert.equal(superDown.targets[0].range.start.line, lineOf('virtual function void build_phase'));
  assert.equal(superUp.targets[0].kind, 'caller-definition');
  assert.equal(superUp.targets[0].label, 'build_phase');
  assert.equal(superUp.targets[0].range.start.line, lineOf('protected function void build_phase'));

  const thisPos = at('this.helper', 5);
  const thisDown = traceAt(index, FILE, SRC, thisPos.line, thisPos.character, 'down');
  const thisUp = traceAt(index, FILE, SRC, thisPos.line, thisPos.character, 'up');
  assert.ok(thisDown);
  assert.ok(thisUp);
  assert.equal(thisDown.targets[0].kind, 'callee-definition');
  assert.equal(thisDown.targets[0].label, 'helper');
  assert.equal(thisDown.targets[0].range.start.line, lineOf('local task helper'));
  assert.equal(thisUp.targets[0].label, 'run_phase');

  const otherPos = at('other.build_phase', 6);
  const otherDown = traceAt(index, FILE, SRC, otherPos.line, otherPos.character, 'down');
  const otherUp = traceAt(index, FILE, SRC, otherPos.line, otherPos.character, 'up');
  assert.ok(otherDown);
  assert.ok(otherUp);
  assert.equal(otherDown.targets[0].label, 'build_phase');
  assert.equal(otherDown.targets[0].range.start.line, lineOf('protected function void build_phase'));
  assert.equal(otherUp.targets[0].label, 'drive');
});

test('uvm: go-to-definition lands on the method each call names', () => {
  const index = setup();

  const superPos = at('super.build_phase', 6);
  const superEntry = index.lookupJump(FILE, SRC, superPos.line, superPos.character);
  assert.ok(superEntry);
  assert.equal(superEntry.kind, 'function');
  assert.equal(superEntry.target?.file, FILE);
  assert.equal(superEntry.target?.range.start.line, lineOf('virtual function void build_phase'));

  const thisPos = at('this.helper', 5);
  const thisEntry = index.lookupJump(FILE, SRC, thisPos.line, thisPos.character);
  assert.ok(thisEntry);
  assert.equal(thisEntry.kind, 'function');
  assert.equal(thisEntry.target?.range.start.line, lineOf('local task helper'));

  const otherPos = at('other.build_phase', 6);
  const otherEntry = index.lookupJump(FILE, SRC, otherPos.line, otherPos.character);
  assert.ok(otherEntry);
  assert.equal(otherEntry.kind, 'function');
  assert.equal(otherEntry.target?.range.start.line, lineOf('protected function void build_phase'));
});
