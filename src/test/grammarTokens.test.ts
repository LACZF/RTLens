import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import * as oniguruma from 'vscode-oniguruma';
import * as vsctm from 'vscode-textmate';

const ROOT = path.join(__dirname, '..', '..');
const SYNTAXES = path.join(ROOT, 'syntaxes');

interface ScopedToken {
  text: string;
  scopes: string[];
}

let registryPromise: Promise<vsctm.Registry> | undefined;

function registry(): Promise<vsctm.Registry> {
  if (!registryPromise) {
    const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
    const ready = oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer);
    registryPromise = ready.then(
      () =>
        new vsctm.Registry({
          onigLib: Promise.resolve({
            createOnigScanner: (patterns: string[]) => new oniguruma.OnigScanner(patterns),
            createOnigString: (str: string) => new oniguruma.OnigString(str),
          }),
          loadGrammar: async (scopeName) => {
            const file = scopeName === 'source.systemverilog' ? 'systemverilog.tmLanguage.json' : 'verilog.tmLanguage.json';
            const full = path.join(SYNTAXES, file);
            return vsctm.parseRawGrammar(await fs.promises.readFile(full, 'utf8'), full);
          },
        }),
    );
  }
  return registryPromise;
}

async function grammar(scopeName: string): Promise<vsctm.IGrammar> {
  const loaded = await (await registry()).loadGrammar(scopeName);
  assert.ok(loaded, `grammar ${scopeName} loads`);
  return loaded;
}

function tokenize(grammar: vsctm.IGrammar, text: string): ScopedToken[][] {
  const lines = text.split('\n');
  const result: ScopedToken[][] = [];
  let stack: vsctm.StateStack = vsctm.INITIAL;
  for (const line of lines) {
    const tokenized = grammar.tokenizeLine(line, stack);
    stack = tokenized.ruleStack;
    result.push(tokenized.tokens.map((t) => ({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes })));
  }
  return result;
}

/** A token is unstyled only when its scopes are all roots/regions with no colour rule. */
function hasOwnScope(token: ScopedToken): boolean {
  return token.scopes.slice(1).some((scope) => !/^(source|meta)\./.test(scope));
}

function scopesOf(lines: ScopedToken[][], line: number, text: string): string[][] {
  return lines[line].filter((t) => t.text === text).map((t) => t.scopes);
}

function expectScope(lines: ScopedToken[][], line: number, text: string, scope: RegExp): void {
  const found = scopesOf(lines, line, text);
  assert.ok(found.length > 0, `line ${line + 1}: token ${JSON.stringify(text)} exists`);
  assert.ok(
    found.some((scopes) => scopes.some((s) => scope.test(s))),
    `line ${line + 1}: ${JSON.stringify(text)} has a ${scope} scope, got ${JSON.stringify(found)}`,
  );
}

function fixtureFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(v|sv|svh|vh|vlt)$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(path.join(ROOT, 'test', 'fixtures'));
  return files.sort();
}

test('grammar: every non-whitespace token in the fixture corpus has a colour scope', async () => {
  const files = fixtureFiles();
  assert.ok(files.length >= 12, 'fixture corpus is present');
  for (const file of files) {
    const scopeName = file.endsWith('.v') ? 'source.verilog' : 'source.systemverilog';
    const tokenized = tokenize(await grammar(scopeName), fs.readFileSync(file, 'utf8'));
    const relative = path.relative(ROOT, file);
    tokenized.forEach((tokens, line) => {
      for (const token of tokens) {
        if (!token.text.trim()) {
          continue;
        }
        assert.ok(
          hasOwnScope(token),
          `${relative}:${line + 1} ${JSON.stringify(token.text)} renders in the default foreground (${token.scopes.join(' > ')})`,
        );
      }
    });
  }
});

test('grammar: @(*) stays a sensitivity list instead of swallowing the rest of the file', async () => {
  const lines = tokenize(await grammar('source.verilog'), 'always @(*) begin\n  q = d;\nend\nmodule top;\nendmodule\n');
  for (let line = 1; line < lines.length; line++) {
    for (const token of lines[line]) {
      assert.ok(
        !token.scopes.some((scope) => scope.startsWith('meta.attribute')),
        `line ${line + 1}: ${JSON.stringify(token.text)} is still inside meta.attribute`,
      );
    }
  }
  expectScope(lines, 0, '@', /^keyword\.operator\.event\./);
  expectScope(lines, 2, 'end', /^keyword\.control\.flow\./);
  expectScope(lines, 3, 'module', /^keyword\.control\.module\./);
});

test('grammar: attributes still highlight their own contents', async () => {
  const lines = tokenize(
    await grammar('source.verilog'),
    '(* multstyle = "logic" *) logic signed [DW-1:0] z_ln2;\nmodule top;\nendmodule\n',
  );
  expectScope(lines, 0, '(*', /^punctuation\.definition\.attribute\.begin\./);
  expectScope(lines, 0, '*)', /^punctuation\.definition\.attribute\.end\./);
  expectScope(lines, 0, 'multstyle', /^entity\.other\.attribute-name\./);
  expectScope(lines, 0, 'logic', /^support\.type\./);
  expectScope(lines, 0, 'signed', /^keyword\.declaration\./);
  for (const token of lines[0]) {
    if (token.text.trim()) {
      assert.ok(hasOwnScope(token), `line 1: ${JSON.stringify(token.text)} has no colour scope`);
    }
  }
  expectScope(lines, 1, 'module', /^keyword\.control\.module\./);
});

test('grammar: directive bodies keep comments, macros and names coloured', async () => {
  const lines = tokenize(
    await grammar('source.verilog'),
    '`define ADD(a, b) ((a) + (b)) // inline comment\n`ifdef SIM // simulation only\n`MY_MACRO(1, 2)\n',
  );
  expectScope(lines, 0, 'ADD', /^entity\.name\.function\.preprocessor\./);
  expectScope(lines, 0, '// inline comment', /^comment\.line\./);
  expectScope(lines, 1, '// simulation only', /^comment\.line\./);
  expectScope(lines, 2, '`MY_MACRO', /^entity\.name\.function\.preprocessor\./);
  for (let line = 0; line < lines.length; line++) {
    for (const token of lines[line]) {
      if (token.text.trim()) {
        assert.ok(hasOwnScope(token), `line ${line + 1}: ${JSON.stringify(token.text)} has no scope`);
      }
    }
  }
});

test('grammar: declarations, typedef names and labels are coloured', async () => {
  const lines = tokenize(
    await grammar('source.systemverilog'),
    [
      'module top #(parameter int W = 8) (',
      '  input  logic [W-1:0] a,',
      '  output logic [W-1:0] y',
      ');',
      '  typedef enum logic [1:0] { IDLE, RUN } state_t;',
      '  state_t state;',
      '  always_ff @(posedge clk) begin : blk',
      '    state <= IDLE;',
      '  end',
      'endmodule : top',
    ].join('\n'),
  );
  expectScope(lines, 0, 'top', /^entity\.name\.type\.module\./);
  expectScope(lines, 1, 'a', /^variable\.other\./);
  expectScope(lines, 2, 'y', /^variable\.other\./);
  expectScope(lines, 4, 'state_t', /^entity\.name\.type\./);
  expectScope(lines, 4, 'IDLE', /^constant\.other\.enum-member\./);
  expectScope(lines, 5, 'state', /^variable\.other\./);
  expectScope(lines, 6, 'blk', /^entity\.name\.label\./);
  expectScope(lines, 9, 'endmodule', /^keyword\.control\.module\./);
  expectScope(lines, 9, 'top', /^entity\.name\.type\.module\./);
});

test('grammar: comment forms keep their own scopes and never swallow later code', async () => {
  const lines = tokenize(
    await grammar('source.verilog'),
    [
      'module forms;',
      '  // line',
      '  /* one */',
      '  /* two',
      '     lines */',
      '  /** doc */',
      '  /**/ wire a;',
      '  /* has // inside */ wire b;',
      '  wire c = "http://x/*y";',
      'endmodule',
    ].join('\n'),
  );
  expectScope(lines, 1, '// line', /^comment\.line\./);
  expectScope(lines, 2, ' one ', /^comment\.block\.verilog$/);
  expectScope(lines, 4, '     lines ', /^comment\.block\.verilog$/);
  expectScope(lines, 5, ' doc ', /^comment\.block\.documentation\.verilog$/);
  // `/**/` is an empty block comment. The documentation rule needs `/**` followed by more than `/`,
  // otherwise it opens a doc comment that never closes and the rest of the file turns comment-green.
  expectScope(lines, 6, '*/', /^comment\.block\.verilog$/);
  expectScope(lines, 6, 'wire', /^support\.type\./);
  expectScope(lines, 7, ' has // inside ', /^comment\.block\.verilog$/);
  expectScope(lines, 8, 'http://x/*y', /^string\.quoted\./);
  for (const line of [6, 7, 8]) {
    for (const token of lines[line]) {
      if (token.text === 'wire' || /^[abc]$/.test(token.text)) {
        assert.ok(
          !token.scopes.some((scope) => scope.startsWith('comment.')),
          `line ${line + 1}: ${JSON.stringify(token.text)} is comment-coloured`,
        );
      }
    }
  }
  expectScope(lines, 9, 'endmodule', /^keyword\.control\.module\./);
});

test('grammar: an unterminated string does not swallow the next line', async () => {
  const lines = tokenize(await grammar('source.verilog'), '"unterminated\nmodule top;\nendmodule\n');
  expectScope(lines, 1, 'module', /^keyword\.control\.module\./);
  expectScope(lines, 1, 'top', /^entity\.name\.type\.module\./);
  expectScope(lines, 2, 'endmodule', /^keyword\.control\.module\./);
});
