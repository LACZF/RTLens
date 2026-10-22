/**
 * End-to-end check against the fixture RTL: build the index, expand the
 * hierarchy, resolve hierarchical references and build the connectivity graph.
 * Run with `npm run check`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { HdlIndex, basename } from '../core/index';
import { buildHierarchy, findByPath, subtree } from '../core/hierarchy';
import { wordAtPosition, resolvePath, resolveInScope, resolveAt } from '../core/resolve';
import { buildGraph } from '../core/graph';
import { flattenModule, composeModule, generateWrapper, stubModule } from '../core/generator';
import { collectProblems } from '../core/problems';
import { signalUsage } from '../core/nets';
import { databaseStats, hashText, updateDatabase, type FileInput } from '../core/relations';
import { buildModuleTopology, buildTopologyTree } from '../core/topology';
import { renderFrameSvg, renderFramesSvg, topologyFileNames, type FrameInput } from '../core/topologySvg';

const FIXTURES = path.resolve(__dirname, '../../test/fixtures');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(p, out);
    } else if (/\.(v|sv|svh|vh)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const index = new HdlIndex();
const files = walk(FIXTURES);
const t0 = Date.now();
for (const f of files) {
  index.addFile(f, fs.readFileSync(f, 'utf8'));
}
const elapsed = Date.now() - t0;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok   ${label} = ${a}`);
  } else {
    console.log(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`);
    failures++;
  }
}

function checkTrue(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ok   ${label}${detail ? ' ' + detail : ''}`);
  } else {
    console.log(`  FAIL ${label} ${detail}`);
    failures++;
  }
}

console.log(`indexed ${files.length} files, ${index.stats.modules} modules in ${elapsed}ms`);
console.log(`modules: ${index.moduleNames().sort().join(', ')}`);

console.log('\n[1] top module inference');
// `chip_top` is instantiated by the testbench, so only the never-instantiated
// modules are heuristics candidates; the configuration list always wins.
const tops = index.tops();
check('never-instantiated tops', tops.map((t) => t.name).sort(), ['bus_if', 'fifo', 'soc', 'tb_chip_top']);
const explicit = index.tops(['chip_top']);
check('explicit top first', explicit[0].name, 'chip_top');
check('explicit reason', explicit[0].reason, 'explicit');

console.log('\n[2] hierarchy of chip_top');
const h = buildHierarchy(index, 'chip_top', { maxDepth: 32 });
checkTrue('built', !!h);
if (h) {
  const paths = subtree(h.root).map((n) => n.path);
  check('hierarchy size', paths.length > 0, true);
  console.log('  paths:');
  for (const n of subtree(h.root)) {
    const flags = [n.unresolved ? 'UNRESOLVED' : '', n.cycle ? 'CYCLE' : ''].filter(Boolean).join(' ');
    console.log(`    ${'  '.repeat(n.depth)}${n.path}  (${n.moduleName}) ${flags}`);
  }
  checkTrue('u_dpath present', paths.includes('chip_top.u_dpath'));
  checkTrue('adder under datapath', paths.includes('chip_top.u_dpath.u_adder'));
  checkTrue('regfile under datapath', paths.includes('chip_top.u_dpath.u_regfile'));
  // regfile only instantiates wires inside its generate loop, so it has no
  // child instances; the generate block itself must still be understood.
  const rf = index.resolveModule('regfile')!;
  checkTrue('generate for loop seen', rf.usesUnknownConstruct === false);
  checkTrue('genvar declared', rf.decls.some((d) => d.kind === 'genvar' && d.name === 'i'));
  checkTrue('generate-local nets declared', rf.decls.some((d) => d.name === 'hit_w'));
  checkTrue('no unresolved', h.unresolved === 0, `unresolved=${h.unresolved}`);
}

console.log('\n[3] parameter propagation');
const h2 = buildHierarchy(index, 'chip_top');
if (h2) {
  const regNode = findByPath(h2.root, 'chip_top.u_dpath.u_regfile');
  checkTrue('regfile node found', !!regNode);
  const dp = index.resolveModule('datapath');
  const socParams = index.scopeFor(dp!, new Map([['WIDTH', 8], ['DEPTH', 4]]));
  check('datapath WIDTH', socParams.get('WIDTH'), 8);
  check('datapath AW', socParams.get('AW'), 2);
}

console.log('\n[4] hierarchical reference resolution in the testbench');
const tbFile = path.join(FIXTURES, 'tb/tb_chip_top.v');
const tbSrc = fs.readFileSync(tbFile, 'utf8');
const tbMod = index.resolveModule('tb_chip_top');
const cases: [string, string][] = [
  ['dut.u_dpath.alu_sum', 'alu_sum'],
  ['dut.u_dpath.alu_cout', 'alu_cout'],
  ['dut.u_dpath.rf_rdata', 'rf_rdata'],
  ['dut.u_dpath.u_regfile.rdata', 'rdata'],
  ['dut.u_dpath.u_regfile.regs', 'regs'],
  ['dut.result', 'result'],
  ['operand_a', 'operand_a'],
  ['dut.u_dpath.u_adder.sum', 'sum'],
];
for (const [expr, expectName] of cases) {
  const r = resolvePath(index, tbMod!, expr.split('.'));
  if (r.ok) {
    checkTrue(`resolve ${expr}`, r.decl.name === expectName, `-> ${r.decl.kind} ${r.decl.name} @ ${basename(r.decl.file)}:${r.decl.nameRange.start.line + 1}`);
  } else {
    checkTrue(`resolve ${expr}`, false, r.reason);
  }
}

console.log('\n[5] module-name jump (instance -> definition)');
const chipMod = index.resolveModule('chip_top')!;
const inst = chipMod.instances.find((i) => i.name === 'u_dpath')!;
const modJump = resolveInScope(index, chipMod, inst.moduleName);
checkTrue('u_dpath module type resolves', modJump.ok && modJump.decl.kind === 'module',
  modJump.ok ? `${modJump.decl.moduleName} @ ${basename(modJump.decl.file)}` : modJump.reason);

console.log('\n[6] word extraction at a cursor position');
{
  const line = tbSrc.split('\n').findIndex((l) => l.includes('dut.u_dpath.alu_sum'))!;
  const col = tbSrc.split('\n')[line].indexOf('alu_sum');
  const w = wordAtPosition(tbSrc, line, col + 2);
  checkTrue('word found', !!w, w ? `fullPath=${w.fullPath} name=${w.name}` : '');
  check('fullPath', w?.fullPath, 'dut.u_dpath.alu_sum');
  // The cursor is on the leaf, so `name` is the leaf: find-references and
  // rename work on the name under the cursor, not on the instance it hangs off.
  check('name', w?.name, 'alu_sum');
  check('parentPath', w?.parentPath, 'dut.u_dpath');
}

console.log('\n[7] connectivity graph');
if (h2) {
  const g = buildGraph(index, h2.root, { maxDepth: 6, maxNodes: 200, showContainment: true });
  checkTrue('graph nodes', g.nodes.length > 0, `nodes=${g.nodes.length} edges=${g.edges.length}`);
  const kinds = new Set(g.edges.map((e) => e.kind));
  console.log(`  edge kinds: ${[...kinds].join(', ')}`);
  // A clocked or combinational block is most of a real design, so its
  // assignments have to reach the graph: without them every register of the
  // control unit showed up as a net nothing connects to.
  const procedural = g.edges.filter((e) => e.label === 'always');
  checkTrue(
    'procedural assignments are edges',
    procedural.length > 0,
    `${procedural.length} edges, e.g. ${procedural[0]?.signal} -> ${procedural[0]?.to}`,
  );
  checkTrue(
    'a procedural edge keeps its own label',
    g.edges.filter((e) => e.label === 'assign').length > 0 &&
      procedural.every((e) => e.kind === 'net'),
    'net edges, labelled assign or always',
  );
  const busEdge = g.edges.find((e) => (e.signal ?? '').includes('alu_sum') || e.port === 'sum');
  checkTrue('found an adder sum edge', !!busEdge, busEdge ? `${busEdge.from} -> ${busEdge.to} (${busEdge.port})` : '');
  // Every edge endpoint must be a node in the graph.
  const ids = new Set(g.nodes.map((n) => n.id));
  const dangling = g.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to));
  check('dangling edges', dangling.length, 0);
  // The graph root is a node of its own, and it is the only one flagged "root".
  const roots = g.nodes.filter((n) => n.kind === 'root');
  check('graph root nodes', roots.length, 1);
  check('root is the hierarchy root', roots[0]?.path, h2.root.path);
  // Containment is off by default and forms a tree when enabled.
  const noCont = buildGraph(index, h2.root, { maxDepth: 6, maxNodes: 200 });
  check('containment edges hidden by default', noCont.edges.filter((e) => e.kind === 'containment').length, 0);
  const containments = g.edges.filter((e) => e.kind === 'containment');
  checkTrue('containment edges present', containments.length > 0, `${containments.length} edges`);
  // The instances form a tree, so there is exactly one containment edge per
  // non-root instance.
  const instances = g.nodes.filter((n) => n.kind === 'instance' || n.kind === 'root');
  check('containment edges = instances - 1 (a tree)', containments.length, instances.length - 1);
  // Every containment edge points at a real instance one level up.
  const depthOf = new Map(g.nodes.map((n) => [n.id, n.depth]));
  const badContainment = g.edges.filter(
    (e) => e.kind === 'containment' && (depthOf.get(e.to)! - depthOf.get(e.from)!) !== 1,
  );
  check('containment edges step one level', badContainment.length, 0);
  // includeRoot:false drops exactly the root.
  const noRoot = buildGraph(index, h2.root, { maxDepth: 6, maxNodes: 200, includeRoot: false });
  check('includeRoot=false drops the root node', noRoot.nodes.length, g.nodes.length - 1);
  checkTrue('includeRoot=false keeps the children', noRoot.nodes.length > 0);
  // The node budget is honoured.
  const tiny = buildGraph(index, h2.root, { maxDepth: 6, maxNodes: 5 });
  check('maxNodes respected', tiny.nodes.length <= 5, true);
}

console.log('\n[8] names a module borrows, and wires the language declares');
{
  const regfile = index.resolveModule('regfile')!;
  check('import statement recorded', regfile.imports.map((i) => `${i.pkg}::${i.names.map((n) => n.name).join(',')}`), ['chip_cfg::byte_t']);
  // The package is in another file, so only the index can follow the import.
  const found = index.findDecl(regfile, 'byte_t');
  check('imported type resolves to the package', [found?.kind, found?.owner.name, path.basename(found?.owner.file ?? '')], ['var', 'chip_cfg', 'chip_cfg.sv']);
  const res = resolveInScope(index, regfile, 'byte_t');
  check('imported type resolves for navigation', res.ok ? [res.decl.file.endsWith('chip_cfg.sv'), res.decl.moduleName] : ['unresolved'], [true, 'chip_cfg']);
  // `assign unused_pulse = clk & we;` declares the name it drives: Verilog makes
  // a one-bit wire, so it is a real net, not an undeclared name.
  const implicit = regfile.decls.filter((d) => d.implicit);
  check('implicit wire from a continuous assign', implicit.map((d) => d.name), ['unused_pulse']);
  check('implicit wire is a net', implicit[0]?.kind, 'net');
  // An enum declares constants in the scope it sits in, so the members resolve
  // as parameters - in a package, in the module that declares the enum, and
  // through a wildcard import.
  const members = (m: typeof alu) =>
    m.params.filter((p) => ['IDLE', 'RUN', 'DONE', 'ADD', 'SUB', 'MUL'].includes(p.name)).map((p) => `${p.name}=${p.value?.value}`);
  const pkg = index.resolveModule('types_pkg')!;
  check('enum members of a package', members(pkg), ['IDLE=0', 'RUN=1', 'DONE=2']);
  const alu = index.resolveModule('alu')!;
  check('enum members of a module', members(alu), ['ADD=0', 'SUB=1', 'MUL=2']);
  const member = index.findDecl(alu, 'MUL');
  check('a member jumps into the typedef', member && member.kind === 'param' ? [member.decl.nameRange.start.line + 1] : ['no'], [29]);
  // `import types_pkg::*;` in that same module makes the package's members
  // visible the same way, and a jump still lands in the package.
  const imported = index.findDecl(alu, 'IDLE');
  check('a member arrives through a wildcard import', imported && imported.kind === 'param' ? [imported.owner.name, path.basename(imported.owner.file)] : ['no'], ['types_pkg', 'sv.sv']);
  // `regfile` writes its register array from inside a generate-for. Those writes
  // used to be invisible, so the net list said the array had no driver at all.
  const regs = signalUsage(index, regfile).get('regs');
  check('a driver inside a generate block is a driver', regs?.writers, ['always']);
  // Every iteration of the loop is expanded, and each is a path of its own.
  check('the generate loop is expanded per iteration', [...new Set(regfile.assigns.filter((a) => a.generate).map((a) => a.generate))].sort(), [0, 1, 2, 3].map((i) => `g_reg[${i}]`));
  // Nothing in the fixture tree is undeclared, including the borrowed names.
  const undeclared = collectProblems(index).filter((p) => p.kind === 'undeclared-name');
  check('no undeclared names in the fixtures', undeclared.map((p) => `${path.basename(p.file)}:${p.label}`), []);
}

console.log('\n[9] flatten a subtree into a standalone module');
if (h2) {
  const gen = flattenModule(index, h2.root, 'chip_top.u_dpath');
  checkTrue('flattened', gen.ok, gen.ok ? `${gen.moduleName}: ${gen.ports.length} ports, ${gen.instances} instances` : gen.error);
  if (gen.ok) {
    for (const l of gen.code.split('\n')) {
      console.log('  | ' + l);
    }
    checkTrue('re-instantiates children', gen.code.includes('u_adder') && gen.code.includes('u_regfile'));
    checkTrue('keeps parent wiring', gen.code.includes('assign stage_in') && gen.code.includes('assign result'));
    checkTrue('folds parameters to localparam', gen.code.includes('localparam WIDTH = 8;'));
    checkTrue('no double semicolons', !/;;/.test(gen.code));
    checkTrue('no folded-width leftovers', !/assign stage_in = \$unsigned/.test(gen.code));
  }
  // The flattened module must survive a re-parse.
  const idx2 = new HdlIndex();
  const reMods = idx2.addFile('/tmp/flattened.v', gen.ok ? gen.code : '');
  checkTrue('generated code re-parses', reMods.length === 1, reMods.map((m) => m.name).join(','));
  check('flattened module name', reMods[0]?.name, gen.ok ? gen.moduleName : '');
  if (reMods.length) {
    const re = reMods[0];
    check('child instances kept', re.instances.map((i) => i.name).sort(), ['u_adder', 'u_regfile']);
    // The flattened module turns the original parameters into localparams, so
    // the children are re-instantiated against those localparams.
    check('child param overrides kept', re.instances.find((i) => i.name === 'u_regfile')?.paramOverrides.map((p) => `${p.name}=${p.expr.raw}`).sort(), ['DEPTH=DEPTH', 'WIDTH=WIDTH']);
    check('localparams folded from the instance', re.params.map((p) => `${p.name}=${p.value?.value ?? p.value?.raw}`).sort(), ['AW=2', 'DEPTH=4', 'WIDTH=8']);
    check('continuous assigns kept', re.assigns.filter((a) => !a.inAlways).length, 3);
  }
}

console.log('\n[9b] compose sibling instances');
if (h2) {
  const gen = composeModule(index, h2.root, ['chip_top.u_dpath.u_adder', 'chip_top.u_dpath.u_regfile']);
  checkTrue('composed', gen.ok, gen.ok ? `${gen.moduleName}: ${gen.ports.length} ports, ${gen.instances} instances` : gen.error);
  if (gen.ok) {
    for (const l of gen.code.split('\n')) {
      console.log('  | ' + l);
    }
    const names = gen.ports.map((p) => `${p.direction} ${p.name}`).sort();
    console.log(`  ports: ${names.join(', ')}`);
    console.log(`  internal: ${gen.internalNets.map((n) => n.name).join(', ')}`);
    for (const w of gen.warnings) {
      console.log(`  warn: ${w}`);
    }
    // alu_sum is produced by u_adder and consumed by u_regfile, so it stays
    // inside; alu_cout / rf_rdata leave the selection and become outputs.
    check('input ports are the consumed signals', gen.ports.filter((p) => p.direction === 'input').map((p) => p.name).sort(), ['a', 'b', 'cin', 'clk', 'raddr', 'rst_n', 'waddr', 'we']);
    check('output ports are the produced signals', gen.ports.filter((p) => p.direction === 'output').map((p) => p.name).sort(), ['alu_cout', 'rf_rdata']);
    checkTrue('alu_sum stays internal', gen.internalNets.some((n) => n.name === 'alu_sum'), gen.internalNets.map((n) => n.name).join(','));
    checkTrue('unrelated nets are not pulled in', !gen.internalNets.some((n) => n.name === 'stage_in' || n.name === 'rf_rdata'));
    checkTrue('no double semicolons', !/;;/.test(gen.code));
    // The composed module must survive a re-parse: the port list is rebuilt
    // from scratch here, so a direction or a width can be lost on the way out.
    const cidx = new HdlIndex();
    const cmods = cidx.addFile('/tmp/composed.v', gen.code);
    checkTrue('composed module re-parses', cmods.length === 1, cmods.map((m) => m.name).join(','));
    if (cmods.length === 1) {
      check('composed module name', cmods[0].name, gen.moduleName);
      check('composed instances kept', cmods[0].instances.map((i) => `${i.moduleName} ${i.name}`).sort(), ['adder u_adder', 'regfile u_regfile']);
      check('composed port directions kept', cmods[0].ports.map((p) => `${p.direction} ${p.name}`).sort(), gen.ports.map((p) => `${p.direction} ${p.name}`).sort());
    }
  }
}

console.log('\n[9c] refusal + stub fallback');
if (h2) {
  // `control` has an FSM, so it cannot be inlined.
  const flat = flattenModule(index, h2.root, 'chip_top.u_ctrl');
  checkTrue('procedural module refused', !flat.ok, flat.ok ? '' : flat.error);
  checkTrue('refusal offers a stub', !flat.ok && flat.fallback === 'stub');
  const stub = stubModule(index, h2.root, 'chip_top.u_ctrl');
  checkTrue('stub generated', stub.ok, stub.ok ? `${stub.moduleName}: ${stub.ports.length} ports` : stub.error);
  if (stub.ok) {
    for (const l of stub.code.split('\n')) {
      console.log('  | ' + l);
    }
    const idx3 = new HdlIndex();
    checkTrue('stub re-parses', idx3.addFile('/tmp/stub.v', stub.code).length === 1);
  }
  const auto = generateWrapper(index, h2.root, 'chip_top.u_ctrl');
  checkTrue('auto falls back to stub', auto.ok && auto.warnings.length > 0, auto.ok ? auto.warnings[0] ?? '' : auto.error);
  const bad = generateWrapper(index, h2.root, 'chip_top.nope');
  checkTrue('unknown path rejected', !bad.ok, bad.ok ? '' : bad.error);
}

console.log('\n[10] generate paths, header parameters and hierarchical reads');
{
  const lane = index.resolveModule('gen_lane')!;
  // `module gen_lane (parameter int LANES = 2, input wire clk, ...)`: the
  // parameter is in the header list, so it used to be read as a port with a
  // guessed direction and a diagnostic of its own.
  check('a parameter in the module header', lane.params.map((p) => `${p.name}=${p.value?.value}`), ['LANES=2', 'BITS=4']);
  check('the ports of that module', lane.ports.map((p) => `${p.direction} ${p.name}`), ['input clk', 'input en', 'output hit']);
  // Each iteration of each loop is a path of its own, so the four `pair`
  // signals are four different things.
  check('nested generate blocks are expanded per iteration', lane.decls.filter((d) => d.name === 'pair').map((d) => d.generate).sort(), [
    'ln[0].half[0]',
    'ln[0].half[1]',
    'ln[1].half[0]',
    'ln[1].half[1]',
  ]);
  // The same name in both branches of a generate if.
  check('both branches of a generate if are kept apart', lane.decls.filter((d) => d.name === 'tag').map((d) => d.generate).sort(), ['many', 'one']);
  check('the arrayed instance is filed under its branch', lane.instances.map((i) => `${i.name}@${i.genPrefix}`).sort(), ['u@many', 'u@one']);

  // `soc` reads through the hierarchy, so the paths have to survive parsing.
  const soc = index.resolveModule('soc')!;
  const reads = soc.refs.filter((r) => r.pathSuffix && r.fullPath.startsWith('u_lane'));
  check('a read keeps the index it reads through', reads.map((r) => r.fullPath).sort(), [
    'u_lane.ln[1].half[0].pair',
    'u_lane.many.u[2].dout',
  ]);
  // And it has to reach the declaration it names, through the generate labels
  // and the element of the arrayed instance.
  const socSrc = fs.readFileSync(path.join(FIXTURES, 'sv.sv'), 'utf8');
  for (const [name, decl] of [
    ['u_lane.ln[1].half[0].pair', 'wire [1:0] pair;'],
    ['u_lane.many.u[2].dout', 'output wire dout'],
  ] as const) {
    const line = socSrc.split('\n').findIndex((l) => l.includes(name));
    const col = socSrc.split('\n')[line].indexOf(name) + 1;
    const r = resolveAt(index, path.join(FIXTURES, 'sv.sv'), socSrc, line, col);
    checkTrue(`${name} has a word under the cursor`, !!r);
    if (!r) {
      continue;
    }
    checkTrue(`${name} resolves`, r.resolution.ok, r.resolution.ok ? r.resolution.decl.kind : r.resolution.reason);
    if (r.resolution.ok) {
      const target = fs.readFileSync(r.resolution.decl.file, 'utf8').split('\n')[r.resolution.decl.range.start.line];
      checkTrue(`${name} lands on its own declaration`, target.trim() === decl, target.trim());
    }
  }
  // The instance paths of the hierarchy: the two branches must not collide, and
  // an element of the array has to reach the node of the array.
  const hsoc = buildHierarchy(index, 'soc')!;
  const hpaths = subtree(hsoc.root).map((n) => n.path);
  check('the branches of the hierarchy stay apart', hpaths.filter((p) => p.includes('u_lane')), [
    'soc.u_lane',
    'soc.u_lane.many.u',
    'soc.u_lane.one.u',
  ]);
  checkTrue('an element of the array finds the instance', findByPath(hsoc.root, 'soc.u_lane.many.u[2]')?.path === 'soc.u_lane.many.u');
  checkTrue('the generate block is understood', lane.usesUnknownConstruct === false);
  const laneProblems = collectProblems(index).filter((p) => p.file.endsWith('gen_lane.sv') || (p.file.endsWith('sv.sv') && p.label.includes('lane')));
  check('the generate fixture reports nothing', laneProblems.map((p) => p.label), []);
}

console.log('\n[11] signal/module relation database');
{
  const inputs: FileInput[] = files.map((f) => ({
    file: f,
    rel: path.relative(FIXTURES, f).split(path.sep).join('/'),
    hash: hashText(fs.readFileSync(f, 'utf8')),
  }));
  const first = updateDatabase(index, undefined, inputs, 'full', 'e2e');
  check('db records every file', Object.keys(first.db.files).length, files.length);
  check('db records every module', databaseStats(first.db).modules, index.stats.modules);
  checkTrue(
    'db records module → module connections',
    databaseStats(first.db).connections > 0,
    `${databaseStats(first.db).connections} connections, ${databaseStats(first.db).signals} signals`,
  );
  // datapath instantiates adder and regfile; its child ports carry directions.
  const datapath = first.db.files['lib/datapath.v']?.modules.find((m) => m.name === 'datapath');
  checkTrue('datapath is in the database', !!datapath);
  checkTrue(
    'datapath connections name their child',
    !!datapath?.connections.some((c) => c.child === 'adder' && c.direction),
    datapath?.connections.map((c) => `${c.instance}.${c.port}->${c.child}`).join(' '),
  );
  // A second pass with the same hashes must reuse every file and recompute none.
  const second = updateDatabase(index, first.db, inputs, 'incremental', 'e2e2');
  check('incremental recomputes nothing', second.changed.length, 0);
  check('incremental reuses every file', second.reused, files.length);
}

console.log('\n[12] module topology SVG');
{
  const def = index.resolveModule('chip_top');
  const model = def ? buildModuleTopology(index, def) : undefined;
  checkTrue('chip_top topology builds', !!model);
  if (model) {
    check('topology inputs', model.inputs.map((s) => s.name), ['clk', 'rst_n', 'operand_a', 'operand_b', 'cin', 'start']);
    check('topology outputs', model.outputs.map((s) => s.name), ['result', 'carry', 'busy']);
    check('topology children', model.children.map((c) => c.id), ['u_ctrl', 'u_dpath']);
    // `assign carry = dp_carry;` is a buffer, so the child output reaches the
    // module output as one net instead of through a labelled expression hop.
    const alias = model.edges.find(
      (e) => e.from.kind === 'child' && e.from.port === 'carry' && e.to.kind === 'signal' && e.to.name === 'carry',
    );
    check('an alias assign is a plain wire', alias?.kind, 'port');
    // A parameter passed down as `WIDTH` shows its folded value, not its name.
    check('ported parameter is folded', model.children.find((c) => c.id === 'u_dpath')?.params, 'WIDTH=8, DEPTH=4');

    const filtered = def ? buildModuleTopology(index, def, { filterModules: ['control'] }) : undefined;
    check('filtering drops the instance', filtered?.children.map((c) => c.id), ['u_dpath']);

    const tree = buildTopologyTree(index, 'chip_top', undefined, { maxDepth: 1 });
    // The frames are keyed by the instance path from the design top, so the
    // testbench that wraps chip_top is part of the key, not of the tree.
    check('depth one modules', tree?.frames.map((f) => f.moduleName), ['chip_top', 'control', 'datapath']);
    const keys = tree?.frames.map((f) => f.key) ?? [];
    checkTrue(
      'every frame hangs off the root frame',
      keys.length > 0 && keys.every((k) => k === keys[0] || k.startsWith(`${keys[0]}.`)),
      keys.join(' '),
    );
    checkTrue('depth one is marked truncated', tree?.truncated === true);

    if (tree) {
      const input: FrameInput = {
        key: model.path,
        model,
        self: { href: 'chip_top.html' },
        crumbs: [],
        children: Object.fromEntries(model.children.map((c) => [c.id, { href: `${c.instName}.svg` }])),
      };
      const modes = ['all', 'hidden', 'bundled'] as const;
      for (const mode of modes) {
        const svg = renderFrameSvg(input, { signalMode: mode }).svg;
        checkTrue(`svg ${mode} is a standalone document`, svg.startsWith('<svg') && svg.trimEnd().endsWith('</svg>'));
        checkTrue(`svg ${mode} carries no script or handler`, !/<script/i.test(svg) && !/\son[a-z]+\s*=/i.test(svg));
        checkTrue(`svg ${mode} has finite geometry`, !/\b(NaN|Infinity|undefined)\b/.test(svg));
      }
      const all = renderFrameSvg(input, { signalMode: 'all' }).svg;
      checkTrue('every port is named', [...model.inputs, ...model.outputs].every((s) => all.includes(s.name)));
      const names = topologyFileNames(tree.frames);
      check('one file per frame', names.length, tree.frames.length);
      checkTrue('file names are unique svgs', new Set(names).size === names.length && names.every((n) => n.endsWith('.svg')));
      const rendered = renderFramesSvg(tree.frames.map((f) => ({ ...input, key: f.key, model: f.model })), {});
      check('rendering matches the manifest', rendered.map((s) => s.fileName), names);
    }
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);