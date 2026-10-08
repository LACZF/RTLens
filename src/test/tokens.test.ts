import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { HdlIndex } from '../core/index';
import { computeTokens, TOKEN_TYPES, type HdlToken } from '../core/tokens';

const SRC = `
module cell #(parameter int W = 4) (
  input  wire [W-1:0] din,
  output wire [W-1:0] dout
);
  localparam int HALF = W / 2;
  typedef logic [W-1:0] word_t;
  wire [W-1:0] tapped;
  wire       $unused;

  function automatic [W-1:0] invert(input [W-1:0] v);
    invert = ~v;
  endfunction

  assign tapped = din;
  assign dout = invert(tapped);
  assign $unused = 1'b0;
endmodule

module top (input wire clk, output wire q);
  wire [3:0] bus;
  cell #(.W (4)) u_cell (.din(bus), .dout(q));
  assign bus = 4'd0;
endmodule
`;

function tokensOf(src = SRC) {
  const index = new HdlIndex();
  index.addFile('/w/t.v', src);
  return { index, tokens: computeTokens(index, index.modulesInFile('/w/t.v')) };
}

function at(tokens: HdlToken[], line: number, character: number): HdlToken | undefined {
  return tokens.find((t) => t.line === line && t.character === character);
}

test('tokens: the stream is sorted, which the editor requires', () => {
  const { tokens } = tokensOf();
  assert.ok(tokens.length > 10, `expected a busy file, got ${tokens.length}`);
  for (let i = 1; i < tokens.length; i++) {
    const a = tokens[i - 1];
    const b = tokens[i];
    assert.ok(
      a.line < b.line || (a.line === b.line && a.character < b.character),
      `token ${i} (${b.line}:${b.character}) is not after ${i - 1} (${a.line}:${a.character})`,
    );
  }
});

test('tokens: no position is emitted twice', () => {
  const { tokens } = tokensOf();
  const keys = tokens.map((t) => `${t.line}:${t.character}:${t.length}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('tokens: declarations get their own type', () => {
  const { tokens } = tokensOf();
  const line = (needle: string) => SRC.split('\n').findIndex((l) => l.includes(needle));
  const col = (needle: string, sub: string) => {
    const l = SRC.split('\n')[line(needle)];
    return l.indexOf(sub, l.indexOf(needle));
  };
  assert.equal(at(tokens, line('din,'), col('din,', 'din'))?.type, 'hdlPort');
  assert.equal(at(tokens, line('localparam int HALF'), col('localparam int HALF', 'HALF'))?.type, 'hdlParameter');
  assert.equal(at(tokens, line('wire [W-1:0] tapped'), col('wire [W-1:0] tapped', 'tapped'))?.type, 'hdlSignal');
  assert.equal(at(tokens, line('word_t;'), col('word_t;', 'word_t'))?.type, 'hdlType');
  assert.equal(at(tokens, line('function automatic'), col('function automatic', 'invert'))?.type, 'hdlFunction');
  // The module type of an instantiation, and the label.
  const instLine = line('u_cell (');
  const instText = SRC.split('\n')[instLine];
  assert.equal(at(tokens, instLine, instText.indexOf('cell #'))?.type, 'hdlModule');
  assert.equal(at(tokens, instLine, instText.indexOf('u_cell'))?.type, 'hdlInstance');
});

test('tokens: a use in the body is coloured like its declaration', () => {
  const { tokens } = tokensOf();
  const lines = SRC.split('\n');
  const line = lines.findIndex((l) => l.includes('assign dout = invert'));
  assert.ok(line >= 0);
  const dout = lines[line].indexOf('dout');
  assert.equal(at(tokens, line, dout)?.type, 'hdlPort', 'an output port read in the body');
  const tapped = lines[line].indexOf('tapped');
  assert.equal(at(tokens, line, tapped)?.type, 'hdlSignal');
  const fn = lines[line].indexOf('invert');
  assert.equal(at(tokens, line, fn)?.type, 'hdlFunction');
});

test('tokens: a parameter use in an expression is coloured', () => {
  const { tokens } = tokensOf();
  const lines = SRC.split('\n');
  const line = lines.findIndex((l) => l.includes('localparam int HALF'));
  const text = lines[line];
  assert.equal(at(tokens, line, text.indexOf('HALF = W'))?.type, 'hdlParameter');
  assert.equal(at(tokens, line, text.indexOf('= W /') + 2)?.type, 'hdlParameter', 'the W in the value');
});

test('tokens: only the last element of a dotted path is coloured, with the right type', () => {
  const src = [
    'module leaf (output wire q); assign q = 1\'b0; endmodule',
    'module mid (output wire out);',
    '  leaf u_leaf (.q(out));',
    '  wire probe;',
    '  assign probe = u_leaf.q;',
    'endmodule',
  ].join('\n');
  const { tokens } = tokensOf(src);
  const lines = src.split('\n');
  const line = lines.findIndex((l) => l.includes('assign probe = u_leaf.q'));
  const q = lines[line].indexOf('u_leaf.q') + 'u_leaf.'.length;
  const token = at(tokens, line, q);
  assert.equal(token?.type, 'hdlPort', 'the leaf is a port, not a member of the instance');
  assert.equal(at(tokens, line, lines[line].indexOf('u_leaf.q')), undefined, 'the instance part is left alone');
});

test('tokens: system identifiers are coloured as such', () => {
  const src = 'module s (input wire a, output wire y); assign y = $clog2(a) + 1; endmodule';
  const { tokens } = tokensOf(src);
  const col = src.indexOf('$clog2');
  assert.equal(at(tokens, 0, col)?.type, 'hdlSystemId');
});

test('tokens: an unresolved name gets no token instead of a wrong one', () => {
  const src = 'module u (output wire y); assign y = never_declared; endmodule';
  const { tokens } = tokensOf(src);
  const col = src.indexOf('never_declared');
  assert.equal(at(tokens, 0, col), undefined);
  // The port is still coloured, so the file is not left half-coloured.
  assert.equal(at(tokens, 0, src.indexOf('wire y') + 'wire '.length)?.type, 'hdlPort');
});

test('tokens: a name that is both declared and used appears once', () => {
  // `q` is a port declared in the header and assigned in the body.
  const src = 'module d (output wire q, input wire d); assign q = d; endmodule';
  const { tokens } = tokensOf(src);
  const atQ = tokens.filter((t) => t.character === src.indexOf('output wire q') + 12);
  assert.equal(atQ.length, 1, 'no duplicate at the declaration');
  const useCol = src.lastIndexOf('q');
  assert.equal(tokens.filter((t) => t.character === useCol).length, 1, 'and one at the use');
});

test('tokens: two modules in one file stay ordered across the boundary', () => {
  const { index, tokens } = tokensOf();
  const mods = index.modulesInFile('/w/t.v');
  assert.equal(mods.length, 2, 'the fixture has two modules');
  for (let i = 1; i < tokens.length; i++) {
    assert.ok(tokens[i].line >= tokens[i - 1].line);
  }
  // The first token of the second module comes after the last token of the first.
  const lastOfFirst = Math.max(...tokens.filter((t) => t.line < 24).map((t) => t.line));
  const firstOfSecond = Math.min(...tokens.filter((t) => t.line >= 24).map((t) => t.line));
  assert.ok(firstOfSecond > lastOfFirst);
});

test('tokens: order does not depend on the order of the modules', () => {
  const { index, tokens } = tokensOf();
  const mods = index.modulesInFile('/w/t.v');
  // The provider hands over every module of the file in one call. The result has
  // to be the ascending sequence the delta encoding needs whatever order the
  // modules arrive in, so that a file with several modules cannot corrupt the
  // stream halfway through.
  const reversed = computeTokens(index, [...mods].reverse());
  assert.deepEqual(reversed, tokens);
  for (let i = 1; i < tokens.length; i++) {
    const a = tokens[i - 1];
    const b = tokens[i];
    assert.ok(
      b.line > a.line || (b.line === a.line && b.character >= a.character),
      `token ${i} is out of order: L${a.line}:${a.character} then L${b.line}:${b.character}`,
    );
  }
});

test('tokens: every emitted type exists in the legend', () => {
  const { tokens } = tokensOf();
  const legend = new Set(TOKEN_TYPES);
  for (const t of tokens) {
    assert.ok(legend.has(t.type), `${t.type} is not in the legend`);
    assert.ok(t.length > 0, 'no zero length token');
  }
});

test('tokens: a type from another file is coloured like a type', () => {
  // The shared types of a design live in a header, so the type of a declaration
  // often resolves to nothing. The parser knows the name is in a type position,
  // and that cannot be wrong, so it is coloured instead of left plain.
  const index = new HdlIndex();
  index.addFile('/w/types.svh', 'typedef logic [7:0] byte_t;\n');
  index.addFile(
    '/w/t.v',
    `module top (input wire clk);
  byte_t data;
  assign data = 8'd0;
endmodule`,
  );
  const tokens = computeTokens(index, index.modulesInFile('/w/t.v'));
  const at2 = tokens.filter((t) => t.line === 1);
  assert.deepEqual(
    at2.map((t) => [t.type, t.length]),
    [
      ['hdlType', 6],
      ['hdlSignal', 4],
    ],
    'the type and the signal it declares are both coloured',
  );
  // A use of the variable in the body is coloured like its declaration.
  assert.equal(at(tokens, 2, 9)?.type, 'hdlSignal');
});

test('tokens: an enum member is coloured as the parameter it is', () => {
  // A member of an enum is a constant of the enclosing scope. Colouring the
  // declaration but not the uses - or neither - would make the file look as if
  // the name were free text in one half of its own definition.
  const index = new HdlIndex();
  index.addFile(
    '/w/t.sv',
    `module m (input wire [1:0] a, output wire [1:0] y);
  typedef enum logic [1:0] { RED = 2'b00, GREEN, BLUE = 2'b10 } e_t;
  localparam logic [1:0] NEXT = BLUE;
  assign y = (a == 2'b00) ? RED : NEXT;
endmodule`,
  );
  const tokens = computeTokens(index, index.modulesInFile('/w/t.sv'));
  // The member names inside the braces, and the use on the last line.
  assert.deepEqual(
    tokens.filter((t) => t.line === 1 && t.type === 'hdlParameter').map((t) => [t.line, t.length]),
    [[1, 3], [1, 5], [1, 4]],
    'all three members are coloured as parameters',
  );
  assert.equal(at(tokens, 2, 32)?.type, 'hdlParameter', 'the use in a default is coloured');
  assert.equal(at(tokens, 3, 34)?.type, 'hdlParameter', 'the use in an expression is coloured');
  // The signals around it are untouched: `y` is a port, so it keeps the colour a
  // port has everywhere else.
  assert.equal(at(tokens, 3, 9)?.type, 'hdlPort');
});
