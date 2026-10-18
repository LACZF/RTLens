import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { HdlIndex } from '../core/index';
import { parseSource } from '../core/parser';
import { buildHierarchy, findByPath, paramScopeForPath, signalWidth, subtree, pathChain } from '../core/hierarchy';
import { resolveInScope, resolvePath, wordAtPosition, referencesTo, resolveAt, instancesOf } from '../core/resolve';

const SRC = `
\`define ADDER adder

module leaf #(parameter int W = 8) (
  input  wire [W-1:0] a,
  input  wire [W-1:0] b,
  output wire [W-1:0] s
);
  assign s = a + b;
endmodule

module mid #(parameter int W = 8) (
  input  wire [W-1:0] x,
  output wire [W-1:0] y
);
  wire [W-1:0] t;
  leaf #(.W (W)) u_leaf (.a (x), .b (x), .s (t));
  assign y = t;
endmodule

module top (input wire [7:0] din, output wire [7:0] dout);
  wire [7:0] mid_out;
  mid #(.W (8)) u_mid (.x (din), .y (mid_out));
  \`ADDER #(.W (8)) u_macro (.a (din), .b (mid_out), .s (dout));
  leaf u_broken (.a (din), .b (din), .s (dout));
  missing_mod u_missing ();
endmodule
`;

function freshIndex(): HdlIndex {
  const index = new HdlIndex();
  index.addFile('/w/top.v', SRC);
  return index;
}

test('index registers every module of a file', () => {
  const index = freshIndex();
  // `missing_mod` is only instantiated, never defined.
  assert.deepEqual(index.moduleNames().sort(), ['leaf', 'mid', 'top']);
  assert.equal(index.modulesInFile('/w/top.v').length, 3);
});

test('index removes a file and forgets its modules', () => {
  const index = freshIndex();
  index.removeFile('/w/top.v');
  assert.deepEqual(index.moduleNames(), []);
  assert.equal(index.moduleAtLine('/w/top.v', 3), undefined);
});

test('index prefers a definition in the same file as the reference', () => {
  const index = freshIndex();
  index.addFile('/other/local.v', 'module leaf (); endmodule\nmodule other (); leaf u (); endmodule');
  const fromOther = index.resolveModule('leaf', '/other/local.v');
  assert.equal(fromOther?.file, '/other/local.v');
  assert.equal(index.resolveModule('leaf', '/w/top.v')?.file, '/w/top.v');
});

test('moduleAtLine finds the enclosing module and instances', () => {
  const index = freshIndex();
  const src = index.resolveModule('top', '/w/top.v')!;
  const line = src.instances[0].nameRange.start.line;
  const at = index.moduleAtLine('/w/top.v', line);
  assert.equal(at?.name, 'top');
  // Outside any module there is nothing.
  assert.equal(index.moduleAtLine('/w/top.v', -1), undefined);
});

test('index counts unresolved instantiations', () => {
  const index = freshIndex();
  assert.ok(index.stats.unresolvedInstances >= 1, 'missing_mod is unresolved');
});

test('tops prefers configured names, then uninstantiated modules', () => {
  const index = freshIndex();
  const explicit = index.tops(['mid']);
  assert.equal(explicit[0].name, 'mid');
  assert.equal(explicit[0].reason, 'explicit');
  const auto = index.tops();
  assert.deepEqual(auto.map((t) => t.name).sort(), ['top']);
});

test('wordAtPosition finds identifiers and dotted paths', () => {
  const lines = SRC.split('\n');
  const line = lines.findIndex((l) => l.includes('mid #(.W (8))'))!;
  assert.equal(wordAtPosition(SRC, line, lines[line].indexOf('u_mid') + 1)?.name, 'u_mid');
  // A dotted reference resolves to the whole path, not just the last segment.
  const assignLine = lines.findIndex((l) => l.includes('assign s = a + b'))!;
  const ref = wordAtPosition(SRC, assignLine, lines[assignLine].indexOf('a +') + 1);
  assert.equal(ref?.name, 'a');
  // A cursor between the segments of a dotted path still yields the full path.
  const hline = lines.findIndex((l) => l.includes('leaf #(.W (W))'))!;
  assert.equal(wordAtPosition(SRC, hline, lines[hline].indexOf('u_leaf') + 1)?.name, 'u_leaf');
});

test('wordAtPosition ignores whitespace and comments', () => {
  assert.equal(wordAtPosition('  \n\t// nothing', 1, 5), undefined);
});

test('resolveInScope classifies ports, signals, params and functions', () => {
  const index = freshIndex();
  const top = index.resolveModule('top', '/w/top.v')!;
  const port = resolveInScope(index, top, 'din');
  assert.equal(port.ok && port.decl.kind, 'port');
  const net = resolveInScope(index, top, 'mid_out');
  assert.equal(net.ok && net.decl.kind, 'signal');
  const inst = resolveInScope(index, top, 'u_mid');
  assert.equal(inst.ok && inst.decl.kind, 'instance');
  const mod = resolveInScope(index, top, 'mid');
  assert.equal(mod.ok && mod.decl.kind, 'module');
  const missing = resolveInScope(index, top, 'nope');
  assert.equal(missing.ok, false);
});

test('resolvePath walks into an instance', () => {
  const index = freshIndex();
  const top = index.resolveModule('top', '/w/top.v')!;
  const r = resolvePath(index, top, ['u_mid', 'y']);
  assert.ok(r.ok, r.ok ? '' : r.reason);
  assert.equal(r.ok && r.decl.kind, 'port');
  // An unresolved instance degrades to the instance itself: the rest of the
  // path cannot be followed, but the jump target is still useful.
  const m = resolvePath(index, top, ['u_missing', 'anything']);
  assert.equal(m.ok, true);
  assert.equal(m.ok && m.decl.kind, 'instance');
});

test('resolveAt ties a cursor position to a declaration', () => {
  const index = freshIndex();
  const lines = SRC.split('\n');
  const line = lines.findIndex((l) => l.includes('mid #(.W (8))'))!;
  const r = resolveAt(index, '/w/top.v', SRC, line, lines[line].indexOf('u_mid') + 1);
  assert.equal(r?.word.name, 'u_mid');
  assert.equal(r?.resolution.ok, true);
});

test('referencesTo finds a signal across declaration and uses', () => {
  const index = freshIndex();
  const refs = referencesTo(index, 'mid_out');
  assert.ok(refs.length >= 2, `expected the net and its uses, got ${refs.length}`);
  assert.ok(refs.every((r) => r.mod.name === 'top'));
});

test('hierarchy expands instances and names their paths', () => {
  const index = freshIndex();
  const h = buildHierarchy(index, 'top', { maxDepth: 8 })!;
  assert.equal(h.root.path, 'top');
  assert.deepEqual(subtree(h.root).map((n) => n.path).sort(), [
    'top',
    'top.u_broken',
    'top.u_macro',
    'top.u_mid',
    'top.u_mid.u_leaf',
    'top.u_missing',
  ]);
});

test('hierarchy stops on recursive instantiation', () => {
  const index = new HdlIndex();
  index.addFile('/w/rec.v', 'module rec (); rec u_self (); endmodule');
  const h = buildHierarchy(index, 'rec', { maxDepth: 4 })!;
  const child = findByPath(h.root, 'rec.u_self')!;
  assert.ok(child.cycle, 'recursive instantiation flagged');
  assert.deepEqual(child.children, [], 'expansion stopped');
});

test('hierarchy respects the depth limit', () => {
  const index = freshIndex();
  const shallow = buildHierarchy(index, 'top', { maxDepth: 1 })!;
  assert.ok(shallow.truncated, 'a depth cut is reported on the result');
  // The direct children exist but are not expanded any further.
  assert.equal(findByPath(shallow.root, 'top.u_mid')?.children?.length, 0);
  assert.ok(findByPath(shallow.root, 'top.u_mid')?.truncated, 'unexpanded node says so');
});

test('hierarchy respects the instance budget', () => {
  const index = freshIndex();
  const budgeted = buildHierarchy(index, 'top', { maxDepth: 8, maxInstances: 2 })!;
  assert.ok(budgeted.truncated);
  assert.ok(budgeted.totalNodes <= 2, `budget honoured, got ${budgeted.totalNodes}`);
});

test('hierarchy treats an explicit zero depth/budget as no limit', () => {
  const index = new HdlIndex();
  index.addFile(
    '/w/chain.v',
    [
      'module m0 (); m1 u (); endmodule',
      'module m1 (); m2 u (); endmodule',
      'module m2 (); m3 u (); endmodule',
      'module m3 (); endmodule',
    ].join('\n'),
  );
  // A positive cap still stops early...
  const limited = buildHierarchy(index, 'm0', { maxDepth: 1 })!;
  assert.equal(findByPath(limited.root, 'm0.u')?.children?.length, 0, 'maxDepth 1 keeps only the first level');
  const capped = buildHierarchy(index, 'm0', { maxDepth: 0, maxInstances: 1 })!;
  assert.ok(capped.truncated, 'a positive budget still truncates');
  // ...but 0 lifts both caps, and the whole chain materialises.
  const unlimited = buildHierarchy(index, 'm0', { maxDepth: 0, maxInstances: 0 })!;
  assert.ok(findByPath(unlimited.root, 'm0.u.u.u'), 'maxDepth 0 expands the whole chain');
  assert.equal(unlimited.truncated, false, 'no truncation without a limit');
  assert.ok(unlimited.totalNodes >= 3, 'every instance is materialised');
});

test('hierarchy propagates parameter overrides into child scopes', () => {
  const index = freshIndex();
  const scope = paramScopeForPath(index, 'top.u_mid.u_leaf');
  assert.equal(scope.get('W'), 8, 'the override reached the grandchild scope');
  assert.equal(scope.get('WIDTH'), undefined, 'unrelated names are absent');
  // A parameter that is not overridden keeps its default.
  assert.equal(paramScopeForPath(index, 'top').get('W'), undefined);
});

test('hierarchy marks instances whose module is missing', () => {
  const index = freshIndex();
  const h = buildHierarchy(index, 'top', { maxDepth: 8 })!;
  const missing = findByPath(h.root, 'top.u_missing')!;
  assert.equal(missing.unresolved, true);
  assert.equal(missing.moduleName, 'missing_mod');
  assert.ok(h.unresolved >= 1);
});

test('hierarchy keeps a macro-based instantiation', () => {
  const index = freshIndex();
  const h = buildHierarchy(index, 'top', { maxDepth: 8 })!;
  // Macros are not expanded, but the instance must not disappear from the tree.
  const macro = findByPath(h.root, 'top.u_macro')!;
  assert.equal(macro.moduleName, '`ADDER', 'the macro name is kept verbatim');
  assert.equal(macro.unresolved, true);
});

test('findByPath and pathChain navigate the tree', () => {
  const index = freshIndex();
  const h = buildHierarchy(index, 'top', { maxDepth: 8 })!;
  assert.equal(findByPath(h.root, 'top.u_mid.u_leaf')?.moduleName, 'leaf');
  assert.equal(findByPath(h.root, 'top.nope'), undefined);
  assert.deepEqual(pathChain(h.root, 'top.u_mid.u_leaf').map((n) => n.path), [
    'top',
    'top.u_mid',
    'top.u_mid.u_leaf',
  ]);
});

test('signalWidth folds ranges through the parameter scope', () => {
  const index = freshIndex();
  // `W` is overridden to 8 at the instantiation, so `[W-1:0]` folds to 8 bits.
  assert.equal(signalWidth(index, 'top.u_mid.u_leaf', 'a'), 8);
  assert.equal(signalWidth(index, 'top.u_mid.u_leaf', 's'), 8);
  assert.equal(signalWidth(index, 'top.u_mid', 'x'), 8);
  assert.equal(signalWidth(index, 'top', 'din'), 8);
  // A different override must give a different width - an override must not be
  // overwritten by the module default.
  const wide = new HdlIndex();
  wide.addFile(
    '/w/wide.v',
    'module l #(parameter int W = 8)(input wire [W-1:0] a); endmodule\n' +
      'module t(); l #(.W(32)) u(); endmodule',
  );
  assert.equal(signalWidth(wide, 't.u', 'a'), 32);
  // Positional overrides bind by position.
  const pos = new HdlIndex();
  pos.addFile(
    '/w/pos.v',
    'module l #(parameter int W = 8, parameter int D = 2)(input wire [W-1:0] a); endmodule\n' +
      'module t(); l #(32) u(); endmodule',
  );
  assert.equal(signalWidth(pos, 't.u', 'a'), 32);
  // Unknown names have no width rather than a wrong one.
  assert.equal(signalWidth(index, 'top.u_mid.u_leaf', 'nope'), undefined);
  assert.equal(signalWidth(index, 'top.nope.nope', 'a'), undefined);
});

test('an include-only file contributes no modules but is still indexed', () => {
  const index = new HdlIndex();
  const defs = index.addFile('/w/defs.vh', '`define W 8\n`define MAX(a,b) ((a)>(b)?(a):(b))\n');
  assert.deepEqual(defs, []);
  const parsed = parseSource('/w/top.v', '`include "defs.vh"\nmodule t (); endmodule');
  assert.deepEqual(parsed.includes, ['defs.vh'], 'includes are reported per file');
  assert.equal(parsed.modules.length, 1);
});

test('the editor-selection path form is the one the hierarchy uses', () => {
  // `selectionAt` in the VS Code layer composes the instance path by hand, from
  // the module name plus the (possibly generate-prefixed) instance name. This
  // pins that composition to what `buildHierarchy` actually produces, because a
  // mismatch silently degrades every editor command to "hierarchy root".
  const src = [
    'module cell (input wire clk, output wire q); assign q = clk; endmodule',
    'module mid (input wire clk, output wire q);',
    '  wire [3:0] taps;',
    '  cell u_plain (.clk (clk), .q (taps[0]));',
    '  genvar gi;',
    '  generate for (gi = 0; gi < 2; gi = gi + 1) begin : g_loop',
    '    cell u_gen (.clk (clk), .q (taps[gi + 1]));',
    '  end endgenerate',
    '  assign q = taps[3];',
    'endmodule',
  ].join('\n');
  const index = new HdlIndex();
  index.addFile('/w/sel.v', src);
  const h = buildHierarchy(index, 'mid', { maxDepth: 8 })!;
  assert.equal(h.root.path, 'mid', 'a module-rooted hierarchy is named after the module');

  // Plain instance: <module>.<name>
  const plain = findByPath(h.root, 'mid.u_plain');
  assert.ok(plain, 'the plain instance resolves');
  assert.equal(plain!.moduleName, 'cell');

  // Generate instance: the loop is unrolled in the parser, so the prefix already
  // carries the index and the path is <module>.<genPrefix>.<name>.
  const gen = findByPath(h.root, 'mid.g_loop[0].u_gen');
  assert.ok(gen, 'the first generate instance resolves');
  assert.equal(gen!.generate, 'g_loop[0]');
  assert.equal(gen!.instName, 'g_loop[0].u_gen', 'instance name carries the generate prefix');
  assert.ok(findByPath(h.root, 'mid.g_loop[1].u_gen'), 'and so does the second');

  const site = index.resolveModule('mid')!.instances.find((i) => i.name === 'u_gen')!;
  assert.equal(site.genPrefix, 'g_loop[0]');
  assert.equal(`${h.root.path}.${site.genPrefix}.${site.name}`, 'mid.g_loop[0].u_gen');
});

test('index: re-parsing a file replaces it instead of accumulating', () => {
  // The extension re-parses on every debounced keystroke, so `addFile` has to
  // be idempotent: without the leading removeFile the ports, instances and
  // refs of every earlier version of the buffer would stay in the index.
  const index = new HdlIndex();
  const file = '/w/a.v';
  const v1 = 'module a (input wire x, output wire y); wire w; assign y = x; endmodule\n';
  const v2 = 'module a (input wire x); wire w; endmodule\n';

  index.addFile(file, v1);
  const first = index.resolveModule('a')!;
  assert.equal(first.ports.length, 2);
  assert.equal(index.stats.modules, 1);

  index.addFile(file, v1);
  const again = index.resolveModule('a')!;
  assert.equal(again.ports.length, 2, 'ports must not double');
  assert.equal(index.stats.modules, 1, 'the module must not be listed twice');
  assert.equal(index.stats.files, 1);
  assert.deepEqual(again.ports.map((p: { name: string }) => p.name), ['x', 'y']);

  // An edit that removes a port has to remove it from the index too.
  index.addFile(file, v2);
  const edited = index.resolveModule('a')!;
  assert.equal(edited.ports.length, 1, 'the removed port is still indexed');
  assert.equal(edited.ports[0].name, 'x');
  assert.equal(index.stats.modules, 1);
  assert.equal(index.stats.files, 1);
});

test('index: a header lent after a lookup is visible through the name tables', () => {
  const index = new HdlIndex();
  index.addFile('/w/f.v', '`include "hdr.vh"\nmodule m (input wire clk);\nendmodule');
  const mod = index.modulesInFile('/w/f.v')[0];

  // The first lookup builds the module's name tables, while the header is not
  // in the workspace yet, so the name cannot be found.
  assert.equal(index.findDecl(mod, 'T'), undefined);

  index.addFile('/w/hdr.vh', 'typedef logic [3:0] T;');
  const lent = index.findDecl(mod, 'T');
  assert.ok(lent && lent.kind === 'var', 'the header lent its typedef to the module');
  assert.equal(lent.decl.kind, 'typedef');
  assert.equal(lent.decl.file, '/w/hdr.vh', 'a jump opens the header');
});

test('index: the first declaration of a name wins in the name tables', () => {
  const index = new HdlIndex();
  index.addFile(
    '/w/args.v',
    [
      'module m;',
      '  function int fa(input int i);',
      '    return i;',
      '  endfunction',
      '  function int fb(input int i);',
      '    return i;',
      '  endfunction',
      'endmodule',
    ].join('\n'),
  );
  const mod = index.modulesInFile('/w/args.v')[0];
  const hit = index.findDecl(mod, 'i');
  assert.ok(hit, 'an argument is a declaration');
  assert.equal(hit.kind, 'arg');
  // The tables read functions in source order exactly like the linear scan
  // they replaced, so the first function's argument is the one that answers.
  assert.equal(hit.decl.range.start.line, 1, 'fa declares `i` first');
});

test('index: a file that loses its last module leaves nothing behind', () => {
  const index = new HdlIndex();
  const file = '/w/a.v';
  index.addFile(file, 'module a (); endmodule\nmodule b (); endmodule\n');
  assert.equal(index.stats.modules, 2);
  assert.equal(index.stats.files, 1);

  index.addFile(file, 'module a (); endmodule\n');
  assert.equal(index.stats.modules, 1, 'module b survived its file edit');
  assert.equal(index.resolveModule('b'), undefined, 'b is still resolvable by name');
  assert.deepEqual(
    index.allModules().map((m) => m.name),
    ['a'],
  );

  index.addFile(file, '// only a comment now\n');
  assert.equal(index.stats.modules, 0);
  assert.equal(index.stats.files, 0, 'an empty file is still counted as a file');
  assert.equal(index.resolveModule('a'), undefined);
  assert.deepEqual(index.allModules(), []);
  assert.deepEqual(index.modulesInFile(file), []);
  assert.equal(index.indexedFiles.length, 0);
});

test('index: removing a file twice is a no-op and frees the name', () => {
  const index = new HdlIndex();
  const file = '/w/a.v';
  index.addFile(file, 'module a (); a u (); endmodule\n');
  assert.equal(index.stats.unresolvedInstances, 0);

  index.removeFile(file);
  index.removeFile(file);
  assert.equal(index.stats.modules, 0);
  assert.equal(index.stats.files, 0);
  assert.equal(index.resolveModule('a'), undefined);
  // A later add of the same name must not resurrect the old definition.
  index.addFile('/w/other.v', 'module a (); endmodule\n');
  assert.equal(index.stats.modules, 1);
  assert.equal(index.resolveModule('a')!.file, '/w/other.v');
});

test('parentsOf: reverse edges list every instantiation site of a module', () => {
  const index = new HdlIndex();
  index.addFile('/w/a.v', 'module leaf (); endmodule\nmodule top (); leaf u0 (); leaf u1 (); endmodule\n');
  const edges = index.parentsOf('leaf');
  assert.deepEqual(edges.map((e) => e.parentModule), ['top', 'top'], 'both sites of the same parent');
  assert.deepEqual(edges.map((e) => e.inst.name), ['u0', 'u1']);
  assert.equal(edges[0].file, '/w/a.v');
  assert.deepEqual(index.parentsOf('top'), [], 'a never-instantiated module has no parent');
});

test('parentsOf: reindexing a file replaces its edges; removal drops them', () => {
  const index = new HdlIndex();
  const src = 'module leaf (); endmodule\nmodule top (); leaf u (); endmodule\n';
  index.addFile('/w/a.v', src);
  assert.equal(index.parentsOf('leaf').length, 1);
  index.addFile('/w/a.v', src);
  assert.equal(index.parentsOf('leaf').length, 1, 'no duplicated edge after a reindex');
  index.removeFile('/w/a.v');
  assert.deepEqual(index.parentsOf('leaf'), [], 'removal takes the edge back');
});

test('edgeEpoch: bumps on every change to the instance edges', () => {
  const index = new HdlIndex();
  const start = index.edgeEpoch;
  index.addFile('/w/a.v', 'module leaf (); endmodule\nmodule top (); leaf u (); endmodule\n');
  const added = index.edgeEpoch;
  assert.ok(added > start, 'an edge was added');
  index.removeFile('/w/a.v');
  assert.ok(index.edgeEpoch > added, 'the edge was removed');
});

test('instancesOf: resolves each reverse edge back to its definition and site', () => {
  const index = new HdlIndex();
  index.addFile('/w/a.v', 'module leaf (); endmodule\nmodule top (); leaf u (); endmodule\n');
  const insts = instancesOf(index, 'leaf');
  assert.equal(insts.length, 1);
  assert.equal(insts[0].mod.name, 'top');
  assert.equal(insts[0].inst.name, 'u');
});
