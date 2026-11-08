import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

interface Grammar {
  repository: {
    'module-instantiation': {
      patterns: Array<{ match: string }>;
    };
  };
}

function moduleInstantiationPatterns(): RegExp[] {
  const file = path.join(__dirname, '..', '..', 'syntaxes', 'verilog.tmLanguage.json');
  const grammar = JSON.parse(fs.readFileSync(file, 'utf8')) as Grammar;
  return grammar.repository['module-instantiation'].patterns.map((p) => new RegExp(p.match));
}

test('grammar: module instantiation does not swallow keyword-led statements', () => {
  const patterns = moduleInstantiationPatterns();
  const lines = [
    '    else if (en) begin',
    '    end else if (en) begin',
    '    unique casez (state)',
    '    priority if (a)',
    '    task automatic drive(input logic [7:0] v);',
    '    function new();',
    '    assert property (@(posedge clk) a);',
    '    modport master (input a, output b);',
    '    module top #(parameter W = 8) ();',
    '    class foo #(type T = int);',
    '    virtual class foo #(type T = int);',
    '    generate if (W > 0) begin',
    '    return foo(1);',
  ];
  for (const line of lines) {
    for (const pattern of patterns) {
      assert.equal(pattern.test(line), false, `${JSON.stringify(line)} must not match ${pattern}`);
    }
  }
});

test('grammar: real module instantiations keep their captures', () => {
  const patterns = moduleInstantiationPatterns();

  const plain = patterns.map((p) => p.exec('    leaf u_leaf (a, b);')).find((m) => m !== null);
  assert.ok(plain, 'plain instantiation matches');
  assert.equal(plain[3], 'leaf');
  assert.equal(plain[4], 'u_leaf');
  assert.equal(plain[5], '(');

  const parameterized = patterns.map((p) => p.exec('    mymod #(8) u0 (a, b);')).find((m) => m !== null);
  assert.ok(parameterized, 'parameterized instantiation matches');
  assert.equal(parameterized[1], 'mymod');
  assert.equal(parameterized[2], '#(');
});
