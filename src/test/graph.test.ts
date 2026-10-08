import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { HdlIndex } from '../core/index';
import { buildHierarchy, findByPath, subtree } from '../core/hierarchy';
import { buildGraph } from '../core/graph';
import { parseSource } from '../core/parser';
import type { GraphEdge, GraphNode } from '../core/graph';

const SRC = `
module leaf #(parameter int W = 8) (
  input  wire [W-1:0] a,
  input  wire [W-1:0] b,
  output wire [W-1:0] s,
  output wire         c
);
  assign s = a + b;
  assign c = 1'b0;
endmodule

module top (input wire [7:0] din, input wire [7:0] other, output wire [7:0] dout, output wire flag);
  wire [7:0] mid_out;
  wire       carry;

  mid #(.W (8)) u_mid (.x (din), .y (mid_out), .cout (carry));

  leaf #(.W (8)) u_leaf (
    .a (mid_out),
    .b (other),
    .s (dout),
    .c ()
  );

  leaf u_dangling (.a (din), .b (din), .s (), .c ());
  leaf #(.W (4)) u_narrow (.a (din), .b (din), .s ());
  missing_mod u_missing ();
endmodule

module mid #(parameter int W = 8) (
  input  wire [W-1:0] x,
  output wire [W-1:0] y,
  output wire         cout
);
  wire [W-1:0] t;
  leaf #(.W (W)) u_inner (.a (x), .b (x), .s (t), .c (cout));
  assign y = t;
endmodule
`;

function graph(opts: Parameters<typeof buildGraph>[2] = {}) {
  const index = new HdlIndex();
  index.addFile('/w/top.v', SRC);
  const h = buildHierarchy(index, 'top', { maxDepth: 8 })!;
  return { index, h, g: buildGraph(index, h.root, { maxDepth: 8, maxNodes: 500, showContainment: true, ...opts }) };
}

const byId = (nodes: GraphNode[], id: string) => nodes.find((n) => n.id === id);
const inst = (g: ReturnType<typeof graph>['g'], path: string) =>
  byId(g.nodes, `i:${path}`);

test('graph contains the root and every expanded instance', () => {
  const { g } = graph();
  const paths = g.nodes.filter((n) => n.kind === 'instance' || n.kind === 'root').map((n) => n.path);
  assert.deepEqual(paths.sort(), [
    'top',
    'top.u_dangling',
    'top.u_leaf',
    'top.u_mid',
    'top.u_mid.u_inner',
    'top.u_missing',
    'top.u_narrow',
  ]);
  assert.equal(g.root, 'top');
  assert.equal(g.rootModule, 'top');
});

test('graph nodes carry the labels and ranges needed by the view', () => {
  const { g } = graph();
  const top = byId(g.nodes, 'i:top')!;
  assert.equal(top.kind, 'root');
  assert.equal(top.moduleName, 'top');
  assert.equal(top.label, 'top');
  const leaf = inst(g, 'top.u_leaf')!;
  assert.equal(leaf.kind, 'instance');
  assert.equal(leaf.moduleName, 'leaf');
  assert.equal(leaf.label, 'u_leaf');
  assert.equal(leaf.depth, 1);
  assert.equal(leaf.file, '/w/top.v', 'instances know their source file');
});

test('graph wires an input port from the parent net into the instance', () => {
  const { g } = graph();
  const edges = g.edges.filter((e) => e.to === 'i:top.u_leaf' && e.port === 'a');
  assert.equal(edges.length, 1);
  const e = edges[0];
  assert.equal(e.from, 'n:top::mid_out', 'the net lives in the scope that declares it');
  assert.equal(e.signal, 'mid_out');
  assert.equal(e.direction, 'input');
  assert.equal(e.width, 8, 'the net width is folded through the parameter override');
  assert.ok(!e.dashed, 'a port connection is a solid edge');
});

test('graph reports a port connected to an undeclared signal', () => {
  const index = new HdlIndex();
  index.addFile(
    '/w/bad.v',
    'module leaf (input wire a); endmodule\nmodule top (input wire d); leaf u (.a (typo)); endmodule',
  );
  const h = buildHierarchy(index, 'top', { maxDepth: 8 })!;
  const g = buildGraph(index, h.root, { maxDepth: 8, showContainment: true });
  const issues = g.issues.filter((i) => i.kind === 'unresolved-signal');
  assert.ok(issues.length > 0, 'the typo is reported');
  assert.ok(issues.some((i) => i.message.includes('typo')));
});

test('graph edges report the width of the net they come from', () => {
  const { g } = graph();
  // `u_narrow` overrides W to 4 but is connected to an 8-bit net, so the edge
  // carries the width that was actually seen in the parent scope.
  const e = g.edges.find((x) => x.to === 'i:top.u_narrow' && x.port === 'a')!;
  assert.equal(e.width, 8);
  const port = g.nodes.find((n) => n.id === 'n:top::din')!;
  assert.equal(port.width, 8);
});

test('graph records an unconnected port', () => {
  const { g } = graph();
  const e = g.edges.find((x) => x.to === 'i:top.u_leaf' && x.port === 'c')!;
  assert.ok(!e, 'a left-open port produces no edge');
  const issues = g.issues.filter((i) => i.kind === 'empty-connection');
  assert.ok(issues.some((i) => i.message.includes('c')), 'reported as an issue');
});

test('graph flags an instance whose module is missing', () => {
  const { g } = graph();
  const missing = inst(g, 'top.u_missing')!;
  assert.equal(missing.unresolved, true);
  assert.ok(g.issues.some((i) => i.kind === 'unresolved-module'), 'issue raised');
  // An unresolved instance has no known ports, so nothing can be wired to it;
  // only the containment edge from its parent exists.
  const toMissing = g.edges.filter((e) => e.to === missing.id);
  assert.deepEqual([...new Set(toMissing.map((e) => e.kind))], ['containment']);
});

test('containment edges form a tree of the instances', () => {
  const { g } = graph();
  const cont = g.edges.filter((e) => e.kind === 'containment');
  const instances = g.nodes.filter((n) => n.kind === 'instance' || n.kind === 'root');
  assert.equal(cont.length, instances.length - 1);
  const depth = new Map(g.nodes.map((n) => [n.id, n.depth]));
  for (const e of cont) {
    assert.equal(depth.get(e.to)! - depth.get(e.from)!, 1, `${e.from} -> ${e.to} steps one level`);
    assert.ok(e.dashed, 'containment edges are dashed');
  }
});

test('containment is off unless requested', () => {
  const { g } = graph({ showContainment: false });
  assert.equal(g.edges.filter((e) => e.kind === 'containment').length, 0);
  assert.ok(g.edges.some((e) => e.kind === 'port'), 'port edges remain');
});

test('graph nets are namespaced by their scope', () => {
  const { g } = graph();
  const nets = g.nodes.filter((n) => n.kind === 'net');
  assert.ok(nets.length > 0);
  assert.ok(nets.every((n) => n.path.includes('::')), 'net id embeds the scope');
  // `mid_out` is driven by `u_mid.y` and consumed by `u_leaf.a`, so within the
  // scope of `top` it is read and written: both ways.
  const midOut = byId(g.nodes, 'n:top::mid_out')!;
  assert.equal(midOut.width, 8);
  assert.equal(midOut.direction, 'inout');
  // `din` is an input port of `top` itself, so inside its own scope it flows in.
  assert.equal(byId(g.nodes, 'n:top::din')!.direction, 'input');
  assert.equal(byId(g.nodes, 'n:top::dout')!.direction, 'output');
  const carry = byId(g.nodes, 'n:top::carry')!;
  assert.equal(carry.width, 1, 'a scalar net is one bit wide');
  assert.equal(carry.direction, 'input', 'driven by a child output port');
});

test('graph edges never dangle', () => {
  const { g } = graph();
  const ids = new Set(g.nodes.map((n) => n.id));
  assert.equal(g.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to)).length, 0);
  assert.equal(g.edges.filter((e) => e.from === e.to).length, 0, 'no self loops');
});

test('graph edge ids are unique', () => {
  const { g } = graph();
  assert.equal(new Set(g.edges.map((e) => e.id)).size, g.edges.length);
});

test('graph respects the depth limit', () => {
  const { g } = graph({ maxDepth: 1 });
  assert.equal(byId(g.nodes, 'i:top.u_mid.u_inner'), undefined, 'grandchild not expanded');
  // The level-1 node has children in the index but they were not expanded, so
  // the graph has to say that it stopped rather than looking like a leaf.
  assert.ok(inst(g, 'top.u_mid')?.truncated, 'the cut node is marked truncated');
  assert.ok(g.truncated, 'truncation reported');
  const issue = g.issues.find((i) => i.kind === 'truncated');
  assert.ok(issue, 'a truncation issue explains why');
  // At full depth nothing is truncated.
  assert.equal(graph().g.truncated, false);
});

test('graph respects the node budget and keeps the shallow nodes', () => {
  const { g } = graph({ maxNodes: 4 });
  assert.ok(g.nodes.length <= 4, `got ${g.nodes.length}`);
  assert.ok(g.truncated);
  assert.ok(byId(g.nodes, 'i:top'), 'the root survives the cut');
});

test('includeRoot=false omits the root but keeps its children', () => {
  const { g } = graph({ includeRoot: false });
  assert.equal(byId(g.nodes, 'i:top'), undefined);
  assert.ok(inst(g, 'top.u_leaf'), 'children remain');
});

test('graph of an unexpanded subtree is rooted at that node', () => {
  const { index, h } = graph();
  const mid = findByPath(h.root, 'top.u_mid')!;
  const sub = buildGraph(index, mid, { maxDepth: 8, showContainment: true });
  assert.equal(sub.root, 'top.u_mid');
  assert.equal(sub.rootModule, 'mid');
  assert.deepEqual(
    sub.nodes.filter((n) => n.kind === 'instance').map((n) => n.path),
    ['top.u_mid.u_inner'],
  );
});

test('graph edges point back at the source text', () => {
  const { g } = graph();
  const withSource = g.edges.filter((e) => e.file);
  assert.ok(withSource.length > 0, 'edges carry a file');
  for (const e of withSource as GraphEdge[]) {
    assert.ok(e.range, 'and a range to jump to');
  }
  // A port edge of an instantiation points at the port name in the parent file.
  const portEdge = g.edges.find((e) => e.kind === 'port' && e.port === 'a')!;
  assert.equal(portEdge.file, '/w/top.v');
  const line = SRC.split('\n')[portEdge.range!.start.line];
  assert.ok(line.includes('.a ('), `line ${portEdge.range!.start.line} is the connection: ${line}`);
});

test('graph stats match the model', () => {
  const { g } = graph();
  assert.equal(g.stats.instances, g.nodes.filter((n) => n.kind === 'instance' || n.kind === 'root').length);
  assert.equal(g.stats.nets, g.nodes.filter((n) => n.kind === 'net').length);
  assert.equal(g.stats.edges, g.edges.length);
  assert.equal(g.truncated, false);
});

test('graph of a module with no instances still shows its own wiring', () => {
  const index = new HdlIndex();
  index.addFile(
    '/w/flat.v',
    'module flat (input wire a, output wire y); wire t; assign t = a; assign y = t; endmodule',
  );
  const h = buildHierarchy(index, 'flat', {})!;
  const g = buildGraph(index, h.root, { showContainment: true });
  assert.equal(g.nodes.filter((n) => n.kind === 'instance').length, 0);
  // Ports and the internal net are present even though nothing instantiates it.
  assert.deepEqual(
    g.nodes.filter((n) => n.kind === 'net').map((n) => n.id).sort(),
    ['n:flat::a', 'n:flat::t', 'n:flat::y'],
  );
  assert.deepEqual(
    g.edges.map((e) => `${e.from}->${e.to}`),
    ['n:flat::a->n:flat::t', 'n:flat::t->n:flat::y'],
    'the assignments became net edges',
  );
});

test('graph tolerates a module that is not in the index', () => {
  const index = new HdlIndex();
  const { modules } = parseSource('/w/x.v', 'module gone (); endmodule');
  assert.equal(modules.length, 1);
  index.addFile('/w/x.v', 'module gone (); endmodule');
  index.removeFile('/w/x.v');
  assert.equal(buildHierarchy(index, 'gone'), undefined);
  assert.equal(index.resolveModule('gone'), undefined);
});

test('hierarchy: an element of an arrayed instance finds the instance node', () => {
  // An arrayed instantiation is one node, so the path a reference reads -
  // `u_lane.many.u[2]` - names an element of an array that the tree does not
  // have a node for. It has to reach the instance, or jumping from the
  // reference to the hierarchy and back would come up empty.
  const index = new HdlIndex();
  index.addFile(
    '/w/t.sv',
    `module leaf (input wire a, output wire y);
  assign y = a;
endmodule

module top (input wire clk, output wire [1:0] y);
  wire [1:0] w;
  generate
    if (1) begin : many
      leaf u [3:0] (.a (clk), .y (w));
    end else begin : one
      leaf u (.a (clk), .y (w));
    end
  endgenerate
  assign y = w;
endmodule`,
  );
  const h = buildHierarchy(index, 'top')!;
  const paths = subtree(h.root).map((n) => n.path);
  assert.deepEqual(paths, ['top', 'top.many.u', 'top.one.u']);
  // Both elements of the array, and a path that carries on past the instance,
  // reach the same node; a name that is not there reaches nothing.
  assert.equal(findByPath(h.root, 'top.many.u[2]')?.path, 'top.many.u');
  assert.equal(findByPath(h.root, 'top.many.u[0]')?.path, 'top.many.u');
  assert.equal(findByPath(h.root, 'top.one.u[3]')?.path, 'top.one.u');
  assert.equal(findByPath(h.root, 'top.many.u[2].y'), undefined);
  assert.equal(findByPath(h.root, 'top.many'), undefined);
});

test('graph: a procedural block connects what it writes', () => {
  // Only `assign` used to make an edge, so for a clocked design the graph was a
  // row of unconnected nets: every register and every comb block was invisible.
  const index = new HdlIndex();
  index.addFile(
    '/w/t.sv',
    `module m (input wire clk, input wire [1:0] d, output reg [1:0] q);
  always @(posedge clk) begin : up
    logic [1:0] tmp;
    tmp = d;
    q <= tmp;
  end
endmodule`,
  );
  const g = buildGraph(index, buildHierarchy(index, 'm')!.root);
  const edge = (from: string, to: string) =>
    g.edges.find((e) => e.signal === from && e.to.endsWith(`:${to}`));
  // The variable of the block is a net of the module, and the two assignments
  // that matter - the load of `d` and the store into `q` - are edges.
  assert.ok(g.nodes.some((n) => n.label === 'tmp'), 'the local is a node');
  assert.equal(edge('d', 'tmp')?.label, 'always');
  assert.equal(edge('tmp', 'q')?.label, 'always');
  assert.equal(edge('d', 'tmp')?.width, 2);
  assert.equal(edge('tmp', 'q')?.width, 2);
  // A continuous assign keeps its own label, so the two can be told apart.
  const cont = new HdlIndex();
  cont.addFile('/w/t.sv', 'module m2 (input wire a, output wire y);\n  assign y = a;\nendmodule');
  const cg = buildGraph(cont, buildHierarchy(cont, 'm2')!.root);
  assert.equal(cg.edges[0].label, 'assign');
  assert.equal(cg.edges[0].kind, 'net');
});

test('graph: a function body contributes no edges and no nodes', () => {
  // `tmp` in a function is automatic, so `tmp = x[0]` is not a net of the
  // module and `rev = tmp` is not an edge: the graph would otherwise show a net
  // that no design has, driven by nothing.
  const index = new HdlIndex();
  index.addFile(
    '/w/t.sv',
    `module m (input wire [7:0] d, output reg [7:0] q);
  function automatic [7:0] rev (input [7:0] x);
    byte tmp;
    tmp = x[0];
    tmp = tmp | (x[7] << 7);
    rev = tmp;
  endfunction
  always_comb q = rev(d);
endmodule`,
  );
  const g = buildGraph(index, buildHierarchy(index, 'm')!.root);
  assert.deepEqual(g.nodes.map((n) => n.label).filter((l) => l === 'tmp' || l === 'x'), []);
  assert.deepEqual(
    g.edges.filter((e) => e.signal === 'tmp' || e.signal === 'x'),
    [],
    'no edge leaves an automatic variable',
  );
  // The call itself is still an edge from the argument to the result.
  assert.ok(
    g.edges.some((e) => e.signal === 'd' && e.to.endsWith(':q')),
    `d feeds q through the function, got ${g.edges.map((e) => e.signal + '->' + e.to).join(' ')}`,
  );
});

test('graph: a reference through a generate block is a net of the module', () => {
  // The declaration side of `t` is inside the block, the read side is written as
  // `g[0].t`. The head `g[0]` is not a name, so the node came back unresolved,
  // the edge was dropped, and `y` had no driver in the graph at all.
  const index = new HdlIndex();
  index.addFile(
    '/w/t.sv',
    `module m (input wire [1:0] a, output wire y);
  genvar i;
  generate
    for (i = 0; i < 2; i = i + 1) begin : g
      wire t;
      assign t = a[i];
    end
  endgenerate
  assign y = g[0].t | g[1].t;
endmodule`,
  );
  const g = buildGraph(index, buildHierarchy(index, 'm')!.root);
  const into = (name: string) => g.edges.filter((e) => e.to.endsWith(`:${name}`)).map((e) => e.signal).sort();
  assert.deepEqual(into('y'), ['g[0].t', 'g[1].t'], 'both copies drive y');
  assert.deepEqual(into('t'), ['a', 'i'], 'the block still writes its own net');
  assert.equal(g.stats.unresolvedSignals, 0, 'nothing unresolved');
});

test('graph: a packed multi-dimensional net is as wide as all of its dimensions', () => {
  // `logic [3:0][7:0] buf` is one 32-bit packed vector, `wire [7:0] mem [0:3]`
  // four of them. Only the first range was counted, so the tree view said 4 bits
  // for a 32-bit bus - and the generator, which multiplies the rest in, said 32.
  const index = new HdlIndex();
  index.addFile(
    '/w/m.sv',
    `module m (input wire [3:0][7:0] din, output wire [3:0][7:0] dout, output wire [7:0] sel);
  logic [3:0][7:0] buf;
  wire [7:0] mem [0:3];
  assign buf = din;
  assign dout = buf;
  assign mem[1] = din[1];
  assign sel = buf[2];
endmodule`,
  );
  const g = buildGraph(index, buildHierarchy(index, 'm')!.root);
  const width = (label: string) => g.nodes.find((n) => n.label === label)?.width;
  assert.equal(width('buf'), 32, 'four times eight');
  assert.equal(width('mem'), 32, 'four elements of eight bits');
  assert.equal(width('din'), 32, 'a port declared the same way');
  assert.equal(width('sel'), 8, 'a select of the first dimension is one element');
  // `buf[2]` is a whole 8-bit row, not a bit, and `mem[1]` a whole element.
  assert.equal(g.edges.find((e) => e.to.endsWith(':sel'))?.width, 8);
  assert.equal(g.edges.find((e) => e.to.endsWith(':mem'))?.width, 8);
  assert.equal(g.edges.find((e) => e.to.endsWith(':buf'))?.width, 32, 'no select, the whole net');
});
