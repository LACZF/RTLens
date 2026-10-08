import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { GATE_KEYWORDS, KEYWORDS } from '../core/lexer';
import { identifierProblem, validIdentifier } from '../core/naming';

/**
 * Rename validation.
 *
 * A rename that produces a keyword is the fastest way to make a design stop
 * compiling, and the failure is silent until the next build: the parser reads
 * `net x;` as a net declaration, so the renamed signal simply disappears from
 * the index. The reserved word list therefore has to cover every keyword the
 * lexer knows, plus the gate primitives it deliberately leaves out.
 */

test('naming: every lexer keyword is rejected as a rename target', () => {
  for (const word of KEYWORDS) {
    assert.ok(
      identifierProblem(word),
      `rename allows \`${word}\`, but the lexer treats it as a keyword`,
    );
    assert.equal(validIdentifier(word), false, `${word} must not count as an identifier`);
  }
});

test('naming: gate primitives are rejected even though they are not keywords', () => {
  // The lexer leaves these out so the parser can tell `and (o, a, b);` from a
  // use of a signal called `and`. Renaming has to be stricter than the lexer.
  for (const word of GATE_KEYWORDS) {
    assert.ok(identifierProblem(word), `rename allows the gate primitive \`${word}\``);
  }
  assert.equal(identifierProblem('and')!.includes('keyword'), true);
});

test('naming: the reserved word list covers the keywords that break declarations', () => {
  // Each of these is dispatched by the parser, so a declaration using the name
  // would be read as something else entirely.
  const dangerous = [
    'net', 'wire', 'reg', 'logic', 'bit', 'int', 'integer', 'real', 'time', 'event',
    'signed', 'unsigned', 'string', 'chandle', 'struct', 'union', 'enum', 'var', 'const',
    'input', 'output', 'inout', 'ref', 'typedef', 'parameter', 'localparam', 'genvar',
    'module', 'endmodule', 'interface', 'package', 'program', 'class', 'function', 'task',
    'generate', 'assign', 'always', 'initial', 'defparam', 'specify', 'table', 'property',
    'sequence', 'dpi', 'import', 'export', 'bind', 'clocking', 'defaultclocking',
  ];
  for (const word of dangerous) {
    assert.equal(identifierProblem(word) !== undefined, true, `${word} is accepted`);
  }
});

test('naming: ordinary identifiers are accepted', () => {
  for (const name of ['clk', 'rst_n', 'data_valid', '_internal', 'a$1', 'X', 'v_', 'my__name']) {
    assert.equal(identifierProblem(name), undefined, `${name} should be fine`);
    assert.equal(validIdentifier(name), true);
  }
});

test('naming: malformed names are rejected with a reason', () => {
  for (const name of ['', '1clk', 'a b', 'a-b', 'clk!', 'clk.n', 'a#b', 'ä']) {
    assert.ok(identifierProblem(name), `${JSON.stringify(name)} should be rejected`);
    assert.equal(validIdentifier(name), false);
  }
  // The message has to say why, since it is shown to the user by the rename
  // provider as an error.
  assert.match(identifierProblem('1clk')!, /not a valid/);
  assert.match(identifierProblem('module')!, /keyword/);
});
