import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { HdlIndex } from '../core/index';
import { identifierProblem, validIdentifier } from '../core/naming';
import {
  leafRangeIn,
  refInScope,
  referencesInScope,
  referencesTo,
  renameAllowed,
  resolveAt,
  resolveInScope,
  resolvePath,
  wordAtPosition,
  type RefScope,
} from '../core/resolve';
import { collectProblems } from '../core/problems';

const SRC = `
module leaf (input wire [7:0] data, input wire clk, output wire out);
  wire [7:0] shadow;
  assign shadow = data;
  assign out = shadow[0];
endmodule

package cfg;
  localparam int UNROLL = 2;
endpackage

module middle #(parameter int DEPTH = 2) (input wire [7:0] data, output wire out);
  wire [7:0] shared;
  wire       probe;
  assign shared = data;
  leaf u_leaf (.data(shared), .clk(1'b0), .out(out));
  // Reading a child port through the instance: resolves into the child module.
  assign probe = u_leaf.out;
  // A package constant used by name.
  wire [cfg::UNROLL-1:0] tag;
endmodule

module top (input wire [7:0] data, output wire out);
  wire [7:0] other;
  assign other = data;
  middle #(.DEPTH (3)) u_mid (.data(other), .out(out));
  leaf u_top_leaf (.data(data), .clk(1'b0), .out());
endmodule
`;

function ctx() {
  const index = new HdlIndex();
  index.addFile('/w/top.v', SRC);
  return index;
}

function at(index: HdlIndex, file: string, needle: string, occurrence = 0) {
  const lines = SRC.split('\n');
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    let from = 0;
    for (;;) {
      const col = lines[i].indexOf(needle, from);
      if (col < 0) break;
      if (seen++ === occurrence) {
        return resolveAt(index, file, SRC, i, col + 1);
      }
      from = col + 1;
    }
  }
  throw new Error(`"${needle}" #${occurrence} not found`);
}

test('identifiers: valid names are accepted', () => {
  for (const ok of ['data', '_x', 'a$b', 'A1', '__foo']) {
    assert.equal(validIdentifier(ok), true, ok);
    assert.equal(identifierProblem(ok), undefined, ok);
  }
});

test('identifiers: malformed names are rejected with a reason', () => {
  assert.match(identifierProblem('1bad') ?? '', /not a valid Verilog identifier/);
  assert.match(identifierProblem('has space') ?? '', /not a valid Verilog identifier/);
  assert.match(identifierProblem('') ?? '', /not a valid Verilog identifier/);
});

test('identifiers: keywords are rejected, so a rename cannot break the build', () => {
  for (const kw of ['module', 'wire', 'always', 'input', 'logic', 'generate', 'endmodule', 'ref']) {
    assert.equal(validIdentifier(kw), false, kw);
    assert.match(identifierProblem(kw) ?? '', /keyword/, kw);
  }
  // Words that merely start with a keyword are fine.
  assert.equal(validIdentifier('module_a'), true);
  assert.equal(validIdentifier('wireless'), true);
});

test('references: the workspace-wide search finds every use of a name', () => {
  const index = ctx();
  const all = referencesTo(index, 'data');
  const files = new Set(all.map((r) => r.mod.name));
  assert.deepEqual([...files].sort(), ['leaf', 'middle', 'top']);
  // `shadow` only exists in leaf.
  assert.deepEqual([...new Set(referencesTo(index, 'shadow').map((r) => r.mod.name))], ['leaf']);
});

test('references: a scoped search stays inside the module the cursor was in', () => {
  const index = ctx();
  const scope: RefScope = { file: '/w/top.v', moduleName: 'top' };
  const scoped = referencesInScope(index, 'data', scope);
  assert.ok(scoped.length > 0, 'the uses in top are found');
  for (const r of scoped) {
    assert.equal(r.mod.name, 'top', `no cross-module leak (${r.mod.name})`);
  }
  // Every reference lives in the same file here, so the file check alone would
  // not have been enough.
  assert.ok(
    scoped.length < referencesTo(index, 'data').length,
    'and the result is strictly narrower than the workspace-wide one',
  );
});

test('references: two modules in one file keep separate namespaces', () => {
  const index = ctx();
  const inTop = refInScope(index.resolveModule('top')!, { file: '/w/top.v', moduleName: 'top' });
  const inLeaf = refInScope(index.resolveModule('leaf')!, { file: '/w/top.v', moduleName: 'top' });
  assert.equal(inTop, true);
  assert.equal(inLeaf, false, 'same file, different module, different scope');
});

test('references: a workspace-wide scope keeps the broad match', () => {
  const index = ctx();
  // `cfg::UNROLL` is a package constant: it is scoped by name, not by module, so
  // a lookup from anywhere has to find it - both where it is declared in the
  // package and where `middle` uses it as a width.
  const all = referencesTo(index, 'UNROLL');
  assert.deepEqual(
    all.map((r) => `${r.mod.name}:${r.ref.isDecl ? 'decl' : 'use'}`).sort(),
    ['cfg:decl', 'middle:use'],
  );
  const fromTop = referencesInScope(index, 'UNROLL', {
    file: '/w/top.v',
    moduleName: 'top',
    workspaceWide: true,
  });
  assert.equal(fromTop.length, 2, 'and a workspace-wide lookup still finds both');
  const fromLeafModule = referencesInScope(index, 'UNROLL', {
    file: '/w/top.v',
    moduleName: 'leaf',
  });
  assert.equal(fromLeafModule.length, 0, 'a module-local lookup does not');
});

test('references: a parameter override with a literal produces no name reference', () => {
  const index = ctx();
  // `.DEPTH (3)` mentions no identifier, so there is nothing for a rename of
  // DEPTH to rewrite at the override - only the declaration itself.
  const refs = referencesTo(index, 'DEPTH');
  assert.equal(refs.length, 1, 'just the declaration');
  assert.equal(refs[0].ref.isDecl, true);
  assert.equal(refs[0].mod.name, 'middle');
  const overrideLine = SRC.split('\n').findIndex((l) => l.includes('.DEPTH'));
  assert.notEqual(
    refs[0].ref.range.start.line,
    overrideLine,
    'and nothing points at the override line',
  );
});

test('references: a scope-qualified reference is one reference to the name', () => {
  const index = ctx();
  // `wire [cfg::UNROLL-1:0] tag;` is a use of UNROLL in the package cfg. The
  // package is a scope, not a signal, so it must not show up as a reference of
  // its own - and the range has to cover both halves so that clicking either
  // one finds the declaration.
  const all = referencesTo(index, 'UNROLL');
  const use = all.find((r) => !r.ref.isDecl)!;
  assert.equal(use.mod.name, 'middle');
  assert.equal(use.ref.fullPath, 'cfg::UNROLL');
  assert.equal(use.ref.kind, 'param', 'and it is coloured like a parameter');
  assert.equal(referencesTo(index, 'cfg').length, 0, 'the package name is not a use');
  const line = SRC.split('\n')[use.ref.range.start.line];
  const covered = line.slice(use.ref.range.start.character, use.ref.range.end.character);
  assert.equal(covered, 'cfg::UNROLL');
});

test('resolution: a scope-qualified name resolves into its package', () => {
  const index = ctx();
  const hit = at(index, '/w/top.v', 'cfg::UNROLL', 0);
  assert.ok(hit, 'the cursor finds the word');
  assert.equal(hit.resolution.ok, true);
  assert.equal(hit.resolution.ok && hit.resolution.decl.name, 'UNROLL');
  assert.equal(hit.resolution.ok && hit.resolution.decl.kind, 'param');
  assert.equal(
    hit.resolution.ok && hit.resolution.decl.moduleName,
    'cfg',
    'and reports the package it belongs to',
  );
});

test('references: a port connection resolves in the scope that owns the net', () => {
  const index = ctx();
  // The `out` on the right of `.out(out)` is a signal of `middle`, the module
  // being edited - not the child port it is connected to.
  const hit = at(index, '/w/top.v', '.out(out)');
  assert.ok(hit);
  assert.equal(hit.resolution.ok, true);
  assert.equal(hit.resolution.ok && hit.resolution.decl.name, 'out');
  assert.equal(hit.resolution.ok && hit.resolution.decl.moduleName, 'middle');
  assert.equal(hit.resolution.ok && hit.resolution.decl.viaInstance, undefined);
});

test('references: a hierarchical read of a child port resolves into the child', () => {
  const index = ctx();
  // `assign probe = u_leaf.out;` walks the instance, so the declaration found is
  // the port of `leaf` and the instance is reported.
  const hit = at(index, '/w/top.v', 'u_leaf.out;');
  assert.ok(hit);
  assert.equal(hit.resolution.ok, true);
  assert.equal(hit.resolution.ok && hit.resolution.decl.name, 'out');
  assert.equal(hit.resolution.ok && hit.resolution.decl.moduleName, 'leaf');
  // `path` records the hierarchy the lookup walked through; `viaInstance` is
  // only set when the cursor was on an instance name itself.
  assert.equal(hit.resolution.ok && hit.resolution.decl.path, 'u_leaf');
  assert.equal(hit.resolution.ok && hit.resolution.decl.viaInstance, undefined);
  assert.equal(hit.resolution.ok && hit.resolution.decl.direction, 'output');
});

test('references: the scope of a lookup follows the resolved kind', () => {
  const index = ctx();
  const top = index.resolveModule('top')!;
  const leaf = index.resolveModule('leaf')!;
  // A signal is local to its module...
  const signalHit = resolveAt(index, '/w/top.v', SRC, ...locOf('assign other = data;'));
  const signalScope: RefScope = {
    file: top.file,
    moduleName: top.name,
    workspaceWide: signalHit?.resolution.ok && signalHit.resolution.decl.kind === 'param',
  };
  assert.equal(refInScope(leaf, signalScope), false);
  // ...while a parameter is visible everywhere.
  const paramScope: RefScope = { file: leaf.file, moduleName: leaf.name, workspaceWide: true };
  assert.equal(refInScope(top, paramScope), true);
});

test('references: an undeclared signal is reported, not silently dropped', () => {
  const text = 'module x (input wire a, output wire y); assign y = typo; endmodule';
  const index = new HdlIndex();
  index.addFile('/w/x.v', text);
  const col = text.indexOf('typo') + 1;
  const hit = resolveAt(index, '/w/x.v', text, 0, col);
  assert.ok(hit, 'a word is found under the cursor');
  assert.equal(hit.resolution.ok, false);
  assert.match(hit.resolution.ok ? '' : hit.resolution.reason, /typo/);
});

test('references: a dotted path resolves to the leaf declaration', () => {
  const index = ctx();
  const top = index.resolveModule('top')!;
  const r = resolvePath(index, top, ['u_mid', 'u_leaf', 'out']);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.decl.name, 'out');
  assert.equal(r.ok && r.decl.file, '/w/top.v');
  // A path that walks into nothing fails with a reason instead of throwing.
  const bad = resolvePath(index, top, ['u_mid', 'nope', 'out']);
  assert.equal(bad.ok, false);
});

/** line/character of the first character after `needle` on its line. */
function locOf(needle: string): [number, number] {
  const lines = SRC.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const col = lines[i].indexOf(needle);
    if (col >= 0) {
      return [i, col + 1];
    }
  }
  throw new Error(`"${needle}" not found`);
}

test('references: a parameter default and a width use are references', () => {
  // Renaming a parameter has to rewrite the defaults and widths that depend on
  // it; if those identifiers are not in the reference list the rename produces
  // code that no longer elaborates.
  const index = ctx();
  // `#(parameter int DEPTH = 2)` is declared in middle; `wire [7:0] shared`
  // does not use it, so use a purpose-built module here.
  const sized = new HdlIndex();
  sized.addFile(
    '/w/sized.v',
    `module sized #(parameter int W = 4, parameter int D = W * 2) (input wire [W-1:0] a);
  wire [D-1:0] b;
  assign b = a;
endmodule`,
  );
  const sites = (name: string): string[] =>
    referencesTo(sized, name)
      .map((r) => `L${r.ref.range.start.line}:${r.ref.isDecl ? 'decl' : 'use'}`)
      .sort();
  // Line 0 holds the header: the declaration of W, the default of D that uses
  // it, and the port width that uses it.
  assert.deepEqual(sites('W'), ['L0:decl', 'L0:use', 'L0:use'], 'declaration, default, width');
  assert.deepEqual(sites('D'), ['L0:decl', 'L1:use'], 'declaration and net width');
  void index;
});

test('wordAtPosition: the name is the token under the cursor, not the chain root', () => {
  // `name` is what find-references and rename operate on, so it has to be the
  // leaf the cursor is on. Taking the first element of the chain would make a
  // rename of a hierarchical signal rename the instance instead.
  const src = [
    'module top;',
    '  leaf u_alu ();',
    '  assign out = u_alu.result;',
    'endmodule',
  ].join('\n');
  const line = 2;
  const at = (word: string) => wordAtPosition(src, line, src.split('\n')[line].indexOf(word) + 1)!;

  const onInstance = at('u_alu');
  assert.equal(onInstance.name, 'u_alu');
  assert.equal(onInstance.fullPath, 'u_alu.result');
  assert.equal(onInstance.parentPath, 'u_alu');

  const onLeaf = at('result');
  assert.equal(onLeaf.name, 'result');
  assert.equal(onLeaf.fullPath, 'u_alu.result', 'the whole chain is still resolved');
  assert.equal(onLeaf.parentPath, 'u_alu');
  assert.equal(onLeaf.nameRange.start.character, src.split('\n')[line].indexOf('result'));
  assert.equal(onLeaf.nameRange.end.character, src.split('\n')[line].indexOf('result') + 'result'.length);
});

test('wordAtPosition: a package-qualified name resolves to the leaf', () => {
  const src = ['module top;', '  assign a = cfg::WIDTH + 1;', 'endmodule'].join('\n');
  const line = 1;
  const start = src.split('\n')[line].indexOf('WIDTH');
  // The cursor may sit anywhere inside the token; the range is the token's own.
  const w = wordAtPosition(src, line, start + 1)!;
  assert.equal(w.name, 'WIDTH');
  // The chain is normalised to dots for resolution; the raw extent keeps the
  // `::` so a rename can tell a qualifier from a plain prefix.
  assert.equal(w.fullPath, 'cfg.WIDTH');
  assert.equal(w.parentPath, 'cfg');
  assert.equal(w.nameRange.start.character, start);
  assert.equal(w.nameRange.end.character, start + 'WIDTH'.length);
  const l = src.split('\n')[line];
  assert.equal(l.slice(w.fullRange.start.character, w.fullRange.end.character), 'cfg::WIDTH');
});

test('wordAtPosition: a packed dimension in a declaration is not part of the name', () => {
  // `wire [7:0] name` is one atom: walking left over the packed dimension used
  // to glom the type keyword on, turning the name into `wire.name` so it no
  // longer resolved to the signal and definition/tracing on a bus port failed.
  const src = [
    'module top (input wire [7:0] a, output wire [WIDTH-1:0] result);',
    '  wire [7:0] bus;',
    'endmodule',
  ].join('\n');
  const on = (line: number, word: string) => wordAtPosition(src, line, src.split('\n')[line].indexOf(word) + 1)!;
  assert.equal(on(0, 'a')!.fullPath, 'a');
  assert.equal(on(0, 'result')!.fullPath, 'result');
  assert.equal(on(1, 'bus')!.fullPath, 'bus');
});

test('leafRangeIn: narrows a qualified reference to the renamed leaf', () => {
  // The reference is one range covering `cfg::WIDTH`; the rename must replace
  // only `WIDTH` or the qualifier is lost.
  const text = ['module top;', '  assign a = cfg::WIDTH + 1;', '  assign b = u_alu.result;'].join('\n');
  const line = text.split('\n')[1];
  const qualified = {
    start: { line: 1, character: line.indexOf('cfg::WIDTH') },
    end: { line: 1, character: line.indexOf('cfg::WIDTH') + 'cfg::WIDTH'.length },
  };
  assert.deepEqual(leafRangeIn(qualified, text, 'WIDTH'), {
    start: { line: 1, character: line.indexOf('WIDTH') },
    end: { line: 1, character: line.indexOf('WIDTH') + 'WIDTH'.length },
  });

  // An unqualified reference is already the leaf and comes back untouched.
  const l2 = text.split('\n')[2];
  const plain = {
    start: { line: 2, character: l2.indexOf('result') },
    end: { line: 2, character: l2.indexOf('result') + 'result'.length },
  };
  assert.deepEqual(leafRangeIn(plain, text, 'result'), plain);

  // Anything that does not line up is left to the caller rather than guessed at.
  assert.equal(leafRangeIn(qualified, text, 'DEPTH'), undefined, 'name is not in the range');
  assert.equal(
    leafRangeIn({ start: { line: 1, character: 0 }, end: { line: 2, character: 4 } }, text, 'x'),
    undefined,
    'a multi-line range is not a qualified path',
  );
  assert.equal(
    leafRangeIn({ start: { line: 1, character: 0 }, end: { line: 1, character: 6 } }, text, 'assign'),
    undefined,
    'a prefix that is not a qualifier is not narrowed',
  );
});

test('resolve: an imported name resolves to the declaration in its package', () => {
  const index = new HdlIndex();
  index.addFile('/w/cfg.sv', 'package cfg; parameter int K = 4; endpackage');
  const file = ['import cfg::K;', 'module top (input wire [K-1:0] a, output wire y);', '  assign y = a[K-1];', 'endmodule'].join('\n');
  index.addFile('/w/top.sv', file);
  const hit = resolveAt(index, '/w/top.sv', file, 2, file.split('\n')[2].indexOf('K'))!;
  assert.equal(hit.resolution.ok, true);
  if (hit.resolution.ok) {
    const decl = hit.resolution.decl;
    assert.equal(decl.kind, 'param');
    // The declaration lives in the package, so both the file and the scope named
    // for a jump have to be the package's.
    assert.equal(decl.file, '/w/cfg.sv');
    assert.equal(decl.moduleName, 'cfg');
  }
  // A local declaration of the same name still wins over the import.
  const src2 = ['import cfg::K;', 'module top2;', '  localparam int K = 2;', '  localparam int L = K;', 'endmodule'].join('\n');
  index.addFile('/w/local.sv', src2);
  const hit2 = resolveAt(index, '/w/local.sv', src2, 3, src2.split('\n')[3].indexOf('K'))!;
  assert.equal(hit2.resolution.ok, true);
  if (hit2.resolution.ok) {
    assert.equal(hit2.resolution.decl.file, '/w/local.sv');
    assert.equal(hit2.resolution.decl.moduleName, 'top2');
  }
});

test('renameAllowed: a name imported from another file is not renameable here', () => {
  const index = new HdlIndex();
  index.addFile('/w/cfg.sv', 'package cfg; parameter int K = 4; endpackage');
  const file = ['import cfg::K;', 'module top;', '  localparam int L = K;', 'endmodule'].join('\n');
  index.addFile('/w/top.sv', file);
  const at = (f: string, line: number, character: number) => resolveAt(index, f, f === '/w/top.sv' ? file : 'package cfg; parameter int K = 4; endpackage', line, character);
  const use = at('/w/top.sv', 2, file.split('\n')[2].indexOf('K'))!;
  assert.equal(use.resolution.ok, true);
  // The declaration is in the package, so a rename here would leave the import
  // and every other importing module behind.
  assert.equal(renameAllowed(use.resolution, '/w/top.sv'), false);
  // Renaming the declaration itself is fine.
  const decl = at('/w/cfg.sv', 0, 'package cfg; parameter int K = 4;'.indexOf('K'))!;
  assert.equal(decl.resolution.ok, true);
  assert.equal(renameAllowed(decl.resolution, '/w/cfg.sv'), true);
});

test('resolve: a function or task argument resolves to the header that declares it', () => {
  const index = new HdlIndex();
  const file = [
    'module m (input wire a, output reg y);',
    '  int acc;',
    '  task automatic bump(input int n, input int w);',
    '    acc = acc + n + w;',
    '    y = acc[0];',
    '  endtask',
    'endmodule',
  ].join('\n');
  index.addFile('/w/t.sv', file);
  const mod = index.moduleAtLine('/w/t.sv', 3)!;
  const at = (name: string) => {
    const line = 3;
    return resolveAt(index, '/w/t.sv', file, line, file.split('\n')[line].indexOf(name))!;
  };
  const n = at('n');
  assert.equal(n.resolution.ok, true);
  if (n.resolution.ok) {
    assert.equal(n.resolution.decl.kind, 'arg');
    // The declaration is in the task header, so a jump lands there.
    assert.equal(n.resolution.decl.nameRange.start.line, 2);
    assert.equal(n.resolution.decl.moduleName, 'm');
  }
  // Renaming is refused: the header is not a reference, so a rename would leave
  // the declaration behind.
  assert.equal(renameAllowed(n.resolution, '/w/t.sv'), false);
  // An argument is not a signal of the module: it must not show up in the
  // declarations the netlist and graph read.
  assert.equal(mod.decls.some((d) => d.name === 'n'), false);
  // A signal of the same name in the module still wins over an argument.
  const shadowed = resolveInScope(index, mod, 'acc');
  assert.equal(shadowed.ok, true);
  if (shadowed.ok) {
    assert.equal(shadowed.decl.kind, 'signal');
  }
});

test('resolve: an enum member jumps to its declaration in the typedef', () => {
  // The members live inside the braces of the typedef, which used to be the only
  // place the name appeared - with no declaration of its own.
  const file = [
    'module m (input wire [1:0] a, output wire [1:0] y);',
    "  typedef enum logic [1:0] { RED = 2'b00, GREEN, BLUE } e_t;",
    '  assign y = (a == 2\'b01) ? GREEN : RED;',
    'endmodule',
  ].join('\n');
  const index = new HdlIndex();
  index.addFile('/w/t.sv', file);
  const mod = index.moduleAtLine('/w/t.sv', 3)!;
  const r = resolveAt(index, '/w/t.sv', file, 2, file.split('\n')[2].indexOf('GREEN') + 1)!;
  assert.equal(r.resolution.ok, true);
  if (r.resolution.ok) {
    assert.equal(r.resolution.decl.name, 'GREEN');
    assert.equal(r.resolution.decl.kind, 'param');
    // Line 1 is the typedef, and the jump lands on the member inside it.
    assert.equal(r.resolution.decl.nameRange.start.line, 1);
    assert.equal(file.split('\n')[1].slice(r.resolution.decl.nameRange.start.character).startsWith('GREEN'), true);
  }
  // The declaration and the use are both reference sites, so a find-references
  // and a rename reach both - which is what makes the member a real symbol
  // rather than a name that happens to be spelled the same twice.
  assert.deepEqual(
    referencesTo(index, 'RED').map((x) => `${x.ref.name}@${x.ref.range.start.line}`),
    ['RED@1', 'RED@2'],
  );
  assert.equal(renameAllowed(r.resolution, '/w/t.sv'), true);
  // An enum member reads as a parameter everywhere else too, so highlighting and
  // hover treat it like one.
  assert.equal(mod.refs.some((x) => x.name === 'BLUE' && x.kind === 'param' && x.isDecl), true);
});

test('resolve: an index in a hierarchical path stays in the path', () => {
  // `u.g_reg[0].regs` reads *through* one iteration of a generate loop. The
  // index used to be dropped, so `g_reg[0].regs` and `g_reg[1].regs` were one
  // reference: one name in the Problems view, and one symbol as far as
  // find-references and rename were concerned, though they are two signals.
  const src = [
    'module tb;',
    '  wire [7:0] o;',
    '  d u ();',
    '  assign o = u.g_reg[0].regs[3];',
    'endmodule',
  ].join('\n');
  // `u`, `g_reg` and `regs` are each found by their own first character
  // offset, so a needle that also occurs in `assign` cannot be mistaken.
  const at = (needle: string, from = 0): ReturnType<typeof wordAtPosition> =>
    wordAtPosition(src, 3, src.split('\n')[3].indexOf(needle, from) + 1);
  const chain = 'u.g_reg[0].regs';
  assert.equal(at('u.')!.fullPath, chain, 'the whole chain, index included');
  assert.equal(at('g_reg', 12)!.fullPath, chain);
  assert.equal(at('regs', 20)!.fullPath, chain);
  // The select belongs to the last name of the chain, wherever the cursor is,
  // and the index in the middle of the chain is not one: it used to report the
  // iteration number as a part select of the instance `u`.
  assert.equal(at('u.')!.select, '3');
  assert.equal(at('regs', 20)!.select, '3');
  const noSelect = [
    'module tb;',
    '  wire [7:0] o;',
    '  d u ();',
    '  assign o = u.g_reg[0].regs;',
    'endmodule',
  ].join('\n');
  assert.equal(wordAtPosition(noSelect, 3, noSelect.split('\n')[3].indexOf('u.') + 1)!.select, '');
  assert.equal(at('u.')!.name, 'u');
  assert.equal(at('regs', 20)!.name, 'regs');
  // A trailing index on the name itself stays out of the path.
  const plain = '  assign o = a[3];';
  assert.equal(wordAtPosition(plain, 0, 13)!.fullPath, 'a');
  assert.equal(wordAtPosition(plain, 0, 13)!.select, '3');
});

test('resolve: a read of a signal inside a generate block finds that block', () => {
  // This is how a testbench reaches a signal that only exists inside a
  // generate loop, and it resolved to nothing at all.
  const index = new HdlIndex();
  const src = [
    'module d (input wire a, output wire y);',
    '  genvar i;',
    '  generate',
    '  for (i = 0; i < 2; i = i + 1) begin : g',
    '    wire [7:0] q;',
    '    assign q = 8\'(i);',
    '  end',
    '  endgenerate',
    '  assign y = a;',
    'endmodule',
    'module tb;',
    '  wire [7:0] o;',
    '  d u ();',
    '  assign o = u.g[1].q;',
    'endmodule',
  ].join('\n');
  index.addFile('/w/t.sv', src);
  const at = (line: number, needle: string) =>
    resolveAt(index, '/w/t.sv', src, line, src.split('\n')[line].indexOf(needle) + 1)!;
  const q = at(13, '.q;');
  assert.equal(q.word.fullPath, 'u.g[1].q');
  assert.equal(q.resolution.ok, true, q.resolution.ok ? '' : q.resolution.reason);
  assert.equal(q.resolution.decl.kind, 'signal');
  assert.equal(q.resolution.decl.name, 'q');
  assert.equal(q.resolution.decl.moduleName, 'd');
  // The declaration is the one inside the loop, not a signal of the
  // testbench that happens to have the same name.
  assert.equal(q.resolution.decl.range.start.line, 4);
  assert.deepEqual(collectProblems(index), []);
});

test('resolve: a hierarchical read through nested generate blocks and a branch label', () => {
  const index = new HdlIndex();
  const src = [
    'module leaf (input wire a, output wire b);',
    'endmodule',
    'module d (input wire a, output wire y);',
    '  generate',
    '  if (1) begin : wide',
    '    wire t;',
    '  end',
    '  else begin : narrow',
    '    wire s;',
    '  end',
    '  for (genvar i = 0; i < 2; i = i + 1) begin : g',
    '    for (genvar j = 0; j < 2; j = j + 1) begin : n',
    '      wire [1:0] w;',
    '      leaf e (.a (a), .b ());',
    '    end',
    '  end',
    '  endgenerate',
    '  assign y = a;',
    'endmodule',
    'module tb;',
    '  wire [1:0] o;',
    '  d u ();',
    '  assign o = u.g[1].n[0].w;',
    '  assign o[0] = u.g[0].n[1].e.b;',
    '  assign o[1] = u.wide.t;',
    'endmodule',
  ].join('\n');
  index.addFile('/w/t.sv', src);
  const lines = src.split('\n');
  /** The cursor on the name of `needle` (`u.g[1].n[0].w` -> `w`). */
  const at = (needle: string) => {
    const line = lines.findIndex((l) => l.includes(needle));
    assert.ok(line >= 0, `no line holds ${needle}`);
    return resolveAt(index, '/w/t.sv', src, line, lines[line].indexOf(needle) + needle.length)!;
  };
  const cases: [string, string, string, string][] = [
    // the written path, the name under the cursor, the kind, the source of the declaration
    ['u.g[1].n[0].w', 'w', 'signal', 'wire [1:0] w;'],
    ['u.g[0].n[1].e.b', 'b', 'port', 'module leaf'],
    ['u.wide.t', 't', 'signal', 'wire t;'],
  ];
  for (const [path, name, kind, declaration] of cases) {
    const r = at(path);
    assert.equal(r.word.fullPath, path);
    assert.equal(r.word.name, name);
    assert.equal(r.resolution.ok, true, `${path}: ${r.resolution.ok ? '' : r.resolution.reason}`);
    assert.equal(r.resolution.decl.kind, kind, path);
    assert.equal(r.resolution.decl.name, name, path);
    // It lands on its own declaration, not on a same-named one in another block.
    assert.ok(
      lines[r.resolution.decl.range.start.line].includes(declaration),
      `${path} lands on line ${r.resolution.decl.range.start.line}: ${lines[r.resolution.decl.range.start.line]}`,
    );
  }
  assert.deepEqual(collectProblems(index), []);
});

test('resolve: an element of an arrayed instantiation is the instantiation', () => {
  const index = new HdlIndex();
  const src = [
    'module leaf (input wire a, output wire b);',
    '  assign b = a;',
    'endmodule',
    'module tb (input wire a, output wire y);',
    '  leaf u [3:0] (.a (a), .b (y));',
    'endmodule',
    'module mon;',
    '  wire y;',
    '  tb dut (.a (1\'b0), .y (y));',
    '  wire b;',
    '  assign b = dut.u[2].b;',
    'endmodule',
  ].join('\n');
  index.addFile('/w/t.sv', src);
  const lines = src.split('\n');
  const read = resolveAt(index, '/w/t.sv', src, 10, lines[10].indexOf('dut.u') + 1)!;
  assert.equal(read.word.fullPath, 'dut.u[2].b');
  assert.equal(read.resolution.ok, true, read.resolution.ok ? '' : read.resolution.reason);
  assert.equal(read.resolution.decl.kind, 'port');
  assert.equal(read.resolution.decl.name, 'b');
  // The instance itself is still reachable, arrayed or not.
  const inst = resolveAt(index, '/w/t.sv', src, 4, lines[4].indexOf('u [3:0]') + 1)!;
  assert.equal(inst.resolution.ok, true);
  assert.equal(inst.resolution.decl.kind, 'instance');
  assert.deepEqual(collectProblems(index), []);
});

test('resolve: the same name in two generate branches resolves to its own branch', () => {
  // `if (...) begin : fast wire t; end else begin : slow wire t; end` declares
  // `t` twice, on two different lines. Picking the first declaration would land
  // on the wrong branch, so F12 from a read of the slow copy jumped into the
  // fast one and a rename hit both.
  const src = [
    'module d (output wire [1:0] y);',
    '  generate',
    '  if (1) begin : fast',
    '    wire t;',
    '  end else begin : slow',
    '    wire t;',
    '  end',
    '  endgenerate',
    '  assign y = 2\'b00;',
    'endmodule',
    'module tb (output wire [1:0] y);',
    '  d u ();',
    '  assign y = {u.slow.t, u.fast.t};',
    'endmodule',
  ].join('\n');
  const index = new HdlIndex();
  index.addFile('/w/t.sv', src);
  const lines = src.split('\n');
  const at = (needle: string) => {
    const line = lines.findIndex((l) => l.includes(needle));
    return resolveAt(index, '/w/t.sv', src, line, lines[line].indexOf(needle) + 1)!;
  };
  for (const [name, other] of [
    ['u.fast.t', 'u.slow.t'],
    ['u.slow.t', 'u.fast.t'],
  ] as const) {
    const r = at(name);
    assert.equal(r.word.fullPath, name);
    assert.equal(r.resolution.ok, true, r.resolution.ok ? '' : r.resolution.reason);
    const line = r.resolution.decl.range.start.line;
    assert.equal(lines[line].trim(), 'wire t;', `${name} lands on a branch`);
    const otherRes = at(other).resolution;
    assert.ok(otherRes.ok, otherRes.ok ? '' : otherRes.reason);
    assert.notEqual(line, otherRes.decl.range.start.line, `${name} is not the other branch`);
  }
  assert.deepEqual(collectProblems(index), []);
});

test('resolve: a reserved word ends a path at the cursor', () => {
  // `bit`, `logic`, `wire`, `reg` and `signed` are reserved words, so a
  // hierarchical path cannot step over one: `u.g[1].bit[0].pair` is not
  // SystemVerilog. The chain stops at the last name that is, rather than
  // reading `bit` as a signal of the module.
  const src = [
    'module d;',
    '  genvar i;',
    '  generate',
    '  for (i = 0; i < 2; i = i + 1) begin : g',
    '    wire [1:0] pair;',
    '  end',
    '  endgenerate',
    'endmodule',
    'module tb;',
    '  d u ();',
    '  wire w;',
    '  assign w = u.g[1].pair[0];',
    'endmodule',
  ].join('\n');
  const lines = src.split('\n');
  const on = (line: number, needle: string) =>
    wordAtPosition(src, line, lines[line].indexOf(needle) + 1)!;
  assert.equal(on(11, 'u.').fullPath, 'u.g[1].pair');
  assert.equal(on(11, 'g[').fullPath, 'u.g[1].pair');
  assert.equal(on(11, 'pair').fullPath, 'u.g[1].pair');
  assert.equal(on(11, 'pair').select, '0');
  // The same path over a reserved word is cut short, and the part that is left
  // is a path of its own.
  const cut = src.replace('u.g[1].pair[0]', 'u.g[1].logic[0].pair');
  const cutLines = cut.split('\n');
  assert.equal(wordAtPosition(cut, 11, cutLines[11].indexOf('u.') + 1)!.fullPath, 'u.g[1]');
});
