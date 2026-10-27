import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { HdlIndex } from '../core/index';
import { calleesOf, callersOf, findFunction } from '../core/calls';
import { traceAt } from '../core/trace';

const ROOT = path.resolve(__dirname, '..', '..');
const DIR = path.join(ROOT, 'test', 'fixtures', 'uvm');
const BASE_FILE = path.join(DIR, 'uvm_base_pkg.sv');
const TEST_FILE = path.join(DIR, 'my_test_pkg.sv');
const BASE_SRC = fs.readFileSync(BASE_FILE, 'utf8');
const TEST_SRC = fs.readFileSync(TEST_FILE, 'utf8');

function setup(): HdlIndex {
  const index = new HdlIndex();
  index.addFile(BASE_FILE, BASE_SRC);
  index.addFile(TEST_FILE, TEST_SRC);
  return index;
}

function at(src: string, needle: string, offset = 0, from = 0): { line: number; character: number } {
  const idx = src.indexOf(needle, from);
  assert.notEqual(idx, -1, `"${needle}" is present`);
  const before = src.slice(0, idx + offset);
  const line = before.split('\n').length - 1;
  return { line, character: before.length - (before.lastIndexOf('\n') + 1) };
}

function lineAt(src: string, needle: string, from = 0): number {
  return at(src, needle, 0, from).line;
}

test('uvm fixture: the UVM test case parses across files', () => {
  const index = setup();
  const myTest = index.resolveModule('my_test');
  const uvmTest = index.resolveModule('uvm_test');
  assert.ok(myTest);
  assert.ok(uvmTest);
  assert.equal(uvmTest.file, BASE_FILE);
  assert.equal(myTest.file, TEST_FILE);
  assert.equal(myTest.kind, 'class');
  assert.equal(myTest.superClass, 'uvm_test');
  assert.equal(myTest.usesUnknownConstruct, false);
  assert.deepEqual(myTest.funcs.map((f) => f.name), ['new', 'build_phase', 'run_phase', 'check_env', 'configure_test', 'finish_test']);
  assert.deepEqual(myTest.decls.map((d) => d.name), ['env', 'errors']);

  const item = index.resolveModule('my_item');
  assert.ok(item);
  assert.equal(item.usesUnknownConstruct, false);
  assert.deepEqual(item.decls.map((d) => d.name), ['payload', 'tag']);

  const driver = index.resolveModule('my_driver');
  assert.ok(driver);
  assert.deepEqual(driver.funcs.map((f) => f.name), ['new', 'run_phase', 'drive_one']);
  assert.deepEqual(driver.decls.map((d) => d.name), ['drives']);

  const rm = index.resolveModule('my_rm');
  assert.ok(rm);
  assert.equal(rm.superClass, 'uvm_component');
  assert.equal(rm.usesUnknownConstruct, false);
  assert.deepEqual(rm.funcs.map((f) => f.name), ['new', 'build_phase', 'write_item', 'predict', 'check', 'reset', 'report_error']);
  assert.deepEqual(rm.decls.map((d) => d.name), ['expected', 'observations']);

  const env = index.resolveModule('my_env');
  assert.ok(env);
  assert.deepEqual(env.funcs.map((f) => f.name), ['new', 'build_phase', 'build_driver', 'build_rm']);
  assert.deepEqual(env.decls.map((d) => d.name), ['drv', 'rm']);

  assert.deepEqual(uvmTest.funcs.map((f) => f.name), ['new', 'build_phase', 'report_summary']);
});

test('uvm fixture: call hierarchy follows super and this calls', () => {
  const index = setup();
  const uvmTest = index.resolveModule('uvm_test')!;
  const myTest = index.resolveModule('my_test')!;
  const uvmTestBuild = findFunction(index, uvmTest, 'build_phase')!;
  const myTestBuild = findFunction(index, myTest, 'build_phase')!;

  assert.deepEqual(
    callersOf(index, uvmTest, uvmTestBuild.fn).map((h) => `${h.owner?.name}:${h.site.fullPath}`),
    ['build_phase:super.build_phase'],
  );
  assert.deepEqual(
    calleesOf(index, myTest, myTestBuild.fn).map((h) => `${h.target.mod.name}.${h.target.fn.name}`),
    ['uvm_test.build_phase', 'my_test.check_env', 'my_test.configure_test'],
  );
  assert.deepEqual(
    calleesOf(index, uvmTest, uvmTestBuild.fn).map((h) => `${h.target.mod.name}.${h.target.fn.name}`).sort(),
    ['uvm_component.build_phase', 'uvm_test.report_summary'].sort(),
  );

  const checkEnv = findFunction(index, myTest, 'check_env')!;
  assert.deepEqual(
    callersOf(index, myTest, checkEnv.fn).map((h) => `${h.owner?.name}:${h.site.fullPath}`),
    ['build_phase:this.check_env', 'run_phase:this.check_env', 'configure_test:this.check_env', 'finish_test:this.check_env'],
  );

  const myTestRun = findFunction(index, myTest, 'run_phase')!;
  assert.deepEqual(
    calleesOf(index, myTest, myTestRun.fn).map((h) => `${h.target.mod.name}.${h.target.fn.name}`),
    ['my_test.check_env', 'my_test.finish_test'],
  );
  const finishTest = findFunction(index, myTest, 'finish_test')!;
  assert.deepEqual(
    calleesOf(index, myTest, finishTest.fn).map((h) => `${h.target.mod.name}.${h.target.fn.name}`),
    ['my_test.check_env'],
  );

  const driver = index.resolveModule('my_driver')!;
  const driverRun = findFunction(index, driver, 'run_phase')!;
  assert.deepEqual(
    calleesOf(index, driver, driverRun.fn).map((h) => `${h.target.mod.name}.${h.target.fn.name}`),
    ['my_driver.drive_one'],
  );
  const driveOne = findFunction(index, driver, 'drive_one')!;
  assert.deepEqual(
    callersOf(index, driver, driveOne.fn).map((h) => `${h.owner?.name}:${h.site.fullPath}`),
    ['run_phase:this.drive_one'],
  );
});

test('uvm fixture: the reference model chains function calls', () => {
  const index = setup();
  const rm = index.resolveModule('my_rm')!;
  const env = index.resolveModule('my_env')!;
  const rmBuild = findFunction(index, rm, 'build_phase')!;
  const writeItem = findFunction(index, rm, 'write_item')!;
  const check = findFunction(index, rm, 'check')!;

  assert.deepEqual(
    calleesOf(index, rm, rmBuild.fn).map((h) => `${h.target.mod.name}.${h.target.fn.name}`),
    ['uvm_component.build_phase', 'my_rm.reset'],
  );
  assert.deepEqual(
    calleesOf(index, rm, writeItem.fn).map((h) => `${h.target.mod.name}.${h.target.fn.name}`),
    ['my_rm.predict', 'my_rm.check'],
  );
  assert.deepEqual(
    calleesOf(index, rm, check.fn).map((h) => `${h.target.mod.name}.${h.target.fn.name}`),
    ['my_rm.report_error'],
  );

  const predict = findFunction(index, rm, 'predict')!;
  assert.deepEqual(
    callersOf(index, rm, predict.fn).map((h) => `${h.owner?.name}:${h.site.fullPath}`),
    ['write_item:this.predict'],
  );
  const reportError = findFunction(index, rm, 'report_error')!;
  assert.deepEqual(
    callersOf(index, rm, reportError.fn).map((h) => `${h.owner?.name}:${h.site.fullPath}`),
    ['check:this.report_error'],
  );

  const envBuild = findFunction(index, env, 'build_phase')!;
  assert.deepEqual(
    calleesOf(index, env, envBuild.fn).map((h) => `${h.target.mod.name}.${h.target.fn.name}`),
    ['uvm_env.build_phase', 'my_env.build_driver', 'my_env.build_rm'],
  );
  const envBuildRm = findFunction(index, env, 'build_rm')!;
  assert.deepEqual(
    callersOf(index, env, envBuildRm.fn).map((h) => `${h.owner?.name}:${h.site.fullPath}`),
    ['build_phase:this.build_rm'],
  );
});

test('uvm fixture: reference model calls trace and jump', () => {
  const index = setup();
  const rmStart = TEST_SRC.indexOf('class my_rm');
  const writeItemLine = lineAt(TEST_SRC, 'virtual function void write_item', rmStart);
  const checkLine = lineAt(TEST_SRC, 'function void check(', rmStart);
  const predictLine = lineAt(TEST_SRC, 'function void predict(', rmStart);
  const reportLine = lineAt(TEST_SRC, 'protected function void report_error', rmStart);

  const predictPos = at(TEST_SRC, 'this.predict', 5, rmStart);
  const predictDown = traceAt(index, TEST_FILE, TEST_SRC, predictPos.line, predictPos.character, 'down');
  const predictUp = traceAt(index, TEST_FILE, TEST_SRC, predictPos.line, predictPos.character, 'up');
  assert.ok(predictDown);
  assert.ok(predictUp);
  assert.equal(predictDown.targets[0].kind, 'callee-definition');
  assert.equal(predictDown.targets[0].label, 'predict');
  assert.equal(predictDown.targets[0].range.start.line, predictLine);
  assert.equal(predictUp.targets[0].kind, 'caller-definition');
  assert.equal(predictUp.targets[0].range.start.line, writeItemLine);

  const reportPos = at(TEST_SRC, 'this.report_error', 5, rmStart);
  const reportDown = traceAt(index, TEST_FILE, TEST_SRC, reportPos.line, reportPos.character, 'down');
  const reportUp = traceAt(index, TEST_FILE, TEST_SRC, reportPos.line, reportPos.character, 'up');
  assert.ok(reportDown);
  assert.ok(reportUp);
  assert.equal(reportDown.targets[0].kind, 'callee-definition');
  assert.equal(reportDown.targets[0].label, 'report_error');
  assert.equal(reportDown.targets[0].range.start.line, reportLine);
  assert.equal(reportUp.targets[0].kind, 'caller-definition');
  assert.equal(reportUp.targets[0].range.start.line, checkLine);

  const predictEntry = index.lookupJump(TEST_FILE, TEST_SRC, predictPos.line, predictPos.character);
  assert.ok(predictEntry);
  assert.equal(predictEntry.kind, 'function');
  assert.equal(predictEntry.target?.file, TEST_FILE);
  assert.equal(predictEntry.target?.range.start.line, predictLine);

  const reportEntry = index.lookupJump(TEST_FILE, TEST_SRC, reportPos.line, reportPos.character);
  assert.ok(reportEntry);
  assert.equal(reportEntry.kind, 'function');
  assert.equal(reportEntry.target?.file, TEST_FILE);
  assert.equal(reportEntry.target?.range.start.line, reportLine);
});

test('uvm fixture: trace walks the super and this calls', () => {
  const index = setup();
  const myTestStart = TEST_SRC.indexOf('class my_test');
  const myTestBuildLine = lineAt(TEST_SRC, 'virtual function void build_phase', myTestStart);
  const checkEnvLine = lineAt(TEST_SRC, 'local function void check_env', myTestStart);
  const uvmTestBuildLine = lineAt(BASE_SRC, 'virtual function void build_phase', BASE_SRC.indexOf('class uvm_test'));

  const superPos = at(TEST_SRC, 'super.build_phase', 6, myTestStart);
  const superDown = traceAt(index, TEST_FILE, TEST_SRC, superPos.line, superPos.character, 'down');
  const superUp = traceAt(index, TEST_FILE, TEST_SRC, superPos.line, superPos.character, 'up');
  assert.ok(superDown);
  assert.ok(superUp);
  assert.equal(superDown.targets[0].kind, 'callee-definition');
  assert.equal(superDown.targets[0].label, 'build_phase');
  assert.equal(superDown.targets[0].range.start.line, uvmTestBuildLine);
  assert.equal(superUp.targets[0].kind, 'caller-definition');
  assert.equal(superUp.targets[0].range.start.line, myTestBuildLine);

  const thisPos = at(TEST_SRC, 'this.check_env', 5, myTestStart);
  const thisDown = traceAt(index, TEST_FILE, TEST_SRC, thisPos.line, thisPos.character, 'down');
  const thisUp = traceAt(index, TEST_FILE, TEST_SRC, thisPos.line, thisPos.character, 'up');
  assert.ok(thisDown);
  assert.ok(thisUp);
  assert.equal(thisDown.targets[0].kind, 'callee-definition');
  assert.equal(thisDown.targets[0].label, 'check_env');
  assert.equal(thisDown.targets[0].range.start.line, checkEnvLine);
  assert.equal(thisUp.targets[0].kind, 'caller-definition');
  assert.equal(thisUp.targets[0].range.start.line, myTestBuildLine);
});

test('uvm fixture: go-to-definition lands on the named method', () => {
  const index = setup();
  const myTestStart = TEST_SRC.indexOf('class my_test');
  const checkEnvLine = lineAt(TEST_SRC, 'local function void check_env', myTestStart);
  const uvmTestBuildLine = lineAt(BASE_SRC, 'virtual function void build_phase', BASE_SRC.indexOf('class uvm_test'));

  const superPos = at(TEST_SRC, 'super.build_phase', 6, myTestStart);
  const superEntry = index.lookupJump(TEST_FILE, TEST_SRC, superPos.line, superPos.character);
  assert.ok(superEntry);
  assert.equal(superEntry.kind, 'function');
  assert.equal(superEntry.target?.file, BASE_FILE);
  assert.equal(superEntry.target?.range.start.line, uvmTestBuildLine);

  const thisPos = at(TEST_SRC, 'this.check_env', 5, myTestStart);
  const thisEntry = index.lookupJump(TEST_FILE, TEST_SRC, thisPos.line, thisPos.character);
  assert.ok(thisEntry);
  assert.equal(thisEntry.kind, 'function');
  assert.equal(thisEntry.target?.file, TEST_FILE);
  assert.equal(thisEntry.target?.range.start.line, checkEnvLine);

  const driverStart = TEST_SRC.indexOf('class my_driver');
  const drivePos = at(TEST_SRC, 'this.drive_one', 5, driverStart);
  const driveEntry = index.lookupJump(TEST_FILE, TEST_SRC, drivePos.line, drivePos.character);
  assert.ok(driveEntry);
  assert.equal(driveEntry.kind, 'function');
  assert.equal(driveEntry.target?.range.start.line, lineAt(TEST_SRC, 'local task drive_one', driverStart));
});
