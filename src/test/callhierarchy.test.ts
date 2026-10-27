import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Module } from 'node:module';

import { vscode, documentFor } from './vscodeStub';
import { HdlIndex } from '../core/index';

const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = loader._load;
loader._load = function (request: string, ...rest: unknown[]) {
  return request === 'vscode' ? vscode : originalLoad(request, ...rest);
};

const SRC = `package pkg;
  function automatic int double_it(input int x);
    return x + x;
  endfunction
endpackage

module tb;
  import pkg::*;

  function automatic int add_one(input int x);
    return x + 1;
  endfunction

  function automatic int compute(input int x);
    int y;
    y = add_one(x);
    if (x > 0) begin
      y = double_it(y);
    end
    for (int i = 0; i < 2; i++) begin
      y = add_one(y);
    end
    check(y);
    return y;
  endfunction

  task automatic check(input int v);
    compute(v);
  endtask

  task automatic fire;
    check(1);
  endtask

  initial begin
    check(3);
    fire;
  end
endmodule`;

const FILE = '/w/callhierarchy.sv';
const token = { isCancellationRequested: false };

function at(source: string, needle: string, offset = 0): { line: number; character: number } {
  const idx = source.indexOf(needle);
  assert.notEqual(idx, -1, `"${needle}" is present`);
  const before = source.slice(0, idx + offset);
  const line = before.split('\n').length - 1;
  const character = before.length - (before.lastIndexOf('\n') + 1);
  return { line, character };
}

async function make() {
  const index = new HdlIndex();
  index.addFile(FILE, SRC);
  const { HdlCallHierarchyProvider } = await import('../vscode/callHierarchy');
  const provider = new HdlCallHierarchyProvider(async () => index);
  const document = documentFor(FILE, SRC);
  return { index, provider, document };
}

test('call hierarchy: prepare on a function definition returns that function', async () => {
  const { provider, document } = await make();
  const pos = at(SRC, 'compute(input int x)');
  const items = await provider.prepareCallHierarchy(
    document as never,
    new vscode.Position(pos.line, pos.character),
    token as never,
  );
  assert.ok(items);
  assert.equal(items[0].name, 'compute');
  assert.equal(items[0].kind, vscode.SymbolKind.Function);
});

test('call hierarchy: incoming calls are the callers, one level deep', async () => {
  const { provider, document } = await make();
  const pos = at(SRC, 'compute(input int x)');
  const items = await provider.prepareCallHierarchy(
    document as never,
    new vscode.Position(pos.line, pos.character),
    token as never,
  );
  assert.ok(items);
  const incoming = await provider.provideCallHierarchyIncomingCalls(items[0], token as never);
  assert.deepEqual(incoming.map((i) => i.from.name), ['check']);
  assert.equal(incoming[0].fromRanges.length, 1);
});

test('call hierarchy: outgoing calls group repeated callees', async () => {
  const { provider, document } = await make();
  const pos = at(SRC, 'compute(input int x)');
  const items = await provider.prepareCallHierarchy(
    document as never,
    new vscode.Position(pos.line, pos.character),
    token as never,
  );
  assert.ok(items);
  const outgoing = await provider.provideCallHierarchyOutgoingCalls(items[0], token as never);
  assert.deepEqual(outgoing.map((o) => o.to.name), ['add_one', 'double_it', 'check']);
  assert.equal(outgoing.find((o) => o.to.name === 'add_one')!.fromRanges.length, 2);
});

test('call hierarchy: a call site and a bare task enable prepare their callee', async () => {
  const { provider, document } = await make();

  const callPos = at(SRC, 'compute(v)');
  const callItems = await provider.prepareCallHierarchy(
    document as never,
    new vscode.Position(callPos.line, callPos.character),
    token as never,
  );
  assert.ok(callItems);
  assert.equal(callItems[0].name, 'compute');

  const barePos = at(SRC, '\n    fire;', 5);
  const bareItems = await provider.prepareCallHierarchy(
    document as never,
    new vscode.Position(barePos.line, barePos.character),
    token as never,
  );
  assert.ok(bareItems);
  assert.equal(bareItems[0].name, 'fire');
});

test('call hierarchy: module-scope calls appear as a module caller', async () => {
  const { provider, document } = await make();
  const pos = at(SRC, 'check(input int v)');
  const items = await provider.prepareCallHierarchy(
    document as never,
    new vscode.Position(pos.line, pos.character),
    token as never,
  );
  assert.ok(items);
  const incoming = await provider.provideCallHierarchyIncomingCalls(items[0], token as never);
  assert.deepEqual(incoming.map((i) => i.from.name), ['compute', 'fire', 'tb']);

  const moduleItem = incoming.find((i) => i.from.name === 'tb')!.from;
  assert.equal(moduleItem.kind, vscode.SymbolKind.Module);
  assert.equal((await provider.provideCallHierarchyIncomingCalls(moduleItem, token as never)).length, 0);
  const outgoing = await provider.provideCallHierarchyOutgoingCalls(moduleItem, token as never);
  assert.deepEqual(outgoing.map((o) => o.to.name), ['check', 'fire']);
});

test('call hierarchy: a task definition exposes its own callees', async () => {
  const { provider, document } = await make();
  const pos = at(SRC, 'task automatic fire', 15);
  const items = await provider.prepareCallHierarchy(
    document as never,
    new vscode.Position(pos.line, pos.character),
    token as never,
  );
  assert.ok(items);
  const outgoing = await provider.provideCallHierarchyOutgoingCalls(items[0], token as never);
  assert.deepEqual(outgoing.map((o) => o.to.name), ['check']);
});
