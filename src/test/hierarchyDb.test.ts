import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { HdlIndex } from '../core/index';
import { HierarchyBuilder } from '../core/hierarchy';
import type { HierarchyNode } from '../core/ast';
import {
  childrenOf,
  buildHierarchyDatabase,
  firstParentPath,
  HIERARCHY_DB_VERSION,
  HierarchyDbBuilder,
  hierarchyDbStats,
  parseHierarchyDatabase,
  serializeHierarchyDatabase,
} from '../core/hierarchyDb';

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

function indexDir(dir: string): HdlIndex {
  const index = new HdlIndex();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (/\.(v|sv|svh|vh)$/.test(e.name)) {
        index.addFile(p, fs.readFileSync(p, 'utf8'));
      }
    }
  };
  walk(dir);
  return index;
}

function libIndex(): HdlIndex {
  return indexDir(path.join(FIXTURES, 'lib'));
}

/** The row fields both engines must agree on for the Composition view. */
const ROW_FIELDS: (keyof HierarchyNode)[] = [
  'path',
  'instName',
  'moduleName',
  'depth',
  'file',
  'nameRange',
  'moduleNameRange',
  'range',
  'unresolved',
  'cycle',
  'generate',
  'truncated',
];

function row(node: HierarchyNode): unknown[] {
  return ROW_FIELDS.map((f) => node[f]);
}

function compareLevels(indexBuilder: HierarchyBuilder, dbBuilder: HierarchyDbBuilder, a: HierarchyNode, b: HierarchyNode, depth: number): void {
  assert.deepEqual(row(a), row(b), `row ${a.path} differs`);
  indexBuilder.expandLevel(a);
  dbBuilder.expandLevel(b);
  assert.deepEqual(a.children!.map(row), b.children!.map(row), `children of ${a.path} differ`);
  if (depth > 0) {
    for (let i = 0; i < a.children!.length; i++) {
      compareLevels(indexBuilder, dbBuilder, a.children![i], b.children![i], depth - 1);
    }
  }
}

test('hierarchyDb: the database-backed builder emits the same rows as the index builder', () => {
  // The Composition view swaps between the two when the on-disk database goes
  // stale; identical rows are what makes that swap invisible.
  const index = libIndex();
  const db = buildHierarchyDatabase(index, []);
  const indexBuilder = new HierarchyBuilder(index, {});
  const dbBuilder = new HierarchyDbBuilder(db, {});
  compareLevels(indexBuilder, dbBuilder, indexBuilder.root('chip_top')!, dbBuilder.root('chip_top')!, 3);
});

test('hierarchyDb: build merges duplicate names and records reverse edges and tops', () => {
  const index = libIndex();
  const db = buildHierarchyDatabase(index, [], '2026-01-01T00:00:00Z', 'fp1');
  assert.equal(db.version, HIERARCHY_DB_VERSION);
  assert.equal(db.generatedAt, '2026-01-01T00:00:00Z');
  assert.equal(db.source, 'fp1');
  assert.ok(db.tops.includes('chip_top'), 'the never-instantiated top is listed');

  const top = db.modules['chip_top'];
  const datapath = db.modules['datapath'];
  assert.ok(top && datapath);
  assert.ok(top.parents.length === 0, 'nothing instantiates the top');
  assert.equal(datapath.parents[0].p, 'chip_top', 'the parent edge points back at the top');
  assert.equal(datapath.parents[0].i, 'u_dpath');
});

test('hierarchyDb: a configured top is kept even when something instantiates it', () => {
  const db = buildHierarchyDatabase(libIndex(), ['adder']);
  assert.ok(db.tops.includes('adder'));
});

test('hierarchyDb: firstParentPath walks from the nearest top down to a module', () => {
  const db = buildHierarchyDatabase(libIndex(), []);
  assert.deepEqual(firstParentPath(db, 'adder'), ['chip_top', 'u_dpath', 'u_adder']);
  assert.deepEqual(firstParentPath(db, 'chip_top'), ['chip_top']);
  assert.equal(firstParentPath(db, 'nope'), undefined);
});

test('hierarchyDb: childrenOf and stats reflect the graph', () => {
  const db = buildHierarchyDatabase(libIndex(), []);
  assert.ok(childrenOf(db, 'chip_top').length > 0);
  assert.deepEqual(childrenOf(db, 'missing'), []);
  const stats = hierarchyDbStats(db);
  assert.ok(stats.modules > 0);
  assert.equal(stats.tops, db.tops.length);
  assert.ok(stats.instances > 0);
  assert.deepEqual(hierarchyDbStats(undefined), { modules: 0, instances: 0, tops: 0 });
});

test('hierarchyDb: serialize and parse round-trip, parse rejects junk and stale versions', () => {
  const db = buildHierarchyDatabase(libIndex(), [], 'now', 'fp');
  assert.deepEqual(parseHierarchyDatabase(serializeHierarchyDatabase(db)), db);
  assert.equal(parseHierarchyDatabase('{'), undefined);
  assert.equal(parseHierarchyDatabase(JSON.stringify({ version: 999, tops: [], modules: {} })), undefined);
  assert.equal(parseHierarchyDatabase(JSON.stringify({ version: HIERARCHY_DB_VERSION, tops: {}, modules: {} })), undefined);
});

test('hierarchyDb: the database-backed builder enforces the depth cap and root lookup', () => {
  const index = new HdlIndex();
  index.addFile(
    '/ws/chain.v',
    'module leaf; endmodule\n' +
      'module mid; leaf u (); endmodule\n' +
      'module top; mid u (); endmodule\n',
  );
  const db = buildHierarchyDatabase(index, []);

  const capped = new HierarchyDbBuilder(db, { maxDepth: 1 });
  const root = capped.root('top')!;
  capped.expandLevel(root);
  const mid = root.children![0];
  assert.equal(mid.moduleName, 'mid');
  capped.expandLevel(mid);
  assert.equal(mid.truncated, true, 'a node at the cap with children is marked truncated');
  assert.deepEqual(mid.children, [], 'and nothing below the cap is materialised');

  const open = new HierarchyDbBuilder(db, {});
  const openRoot = open.root('top')!;
  open.expandLevel(openRoot);
  open.expandLevel(openRoot.children![0]);
  assert.equal(openRoot.children![0].children![0].moduleName, 'leaf', 'no cap materialises the next level');

  assert.equal(capped.root('missing'), undefined);
});

test('hierarchyDb: a generated instance keeps the generate prefix on the row', () => {
  const index = new HdlIndex();
  index.addFile(
    '/ws/top.v',
    'module leaf(input wire a); endmodule\n' +
      'module top(input wire a); genvar g; generate for (g = 0; g < 2; g = g + 1) begin : blk leaf u (.a (a)); end endgenerate endmodule\n',
  );
  const db = buildHierarchyDatabase(index, []);
  const builder = new HierarchyDbBuilder(db, {});
  const root = builder.root('top')!;
  builder.expandLevel(root);
  const child = root.children!.find((c) => c.instName === 'blk[0].u');
  assert.ok(child, 'the generate prefix is part of the instance name');
  assert.equal(child!.generate, 'blk[0]');
});

test('hierarchyDb: ifdef alternatives sharing one instance name collapse to a single edge', () => {
  // The parser keeps both `ifdef branches for navigation, so one def can hold
  // two InstanceSites with the same name. The database edge list and the
  // index builder's level template must agree on one child per path, or the
  // composed tree shows the row twice when the view swaps engines.
  const index = new HdlIndex();
  index.addFile(
    '/w/ifdef.v',
    [
      'module leaf (); endmodule',
      'module other (); endmodule',
      'module top ();',
      '`ifdef SYNTH',
      '  leaf u_x ();',
      '`else',
      '  other u_x ();',
      '`endif',
      'endmodule',
    ].join('\n'),
  );
  const def = index.resolveModule('top')!;
  assert.equal(def.instances.length, 2, 'the parser keeps both ifdef branches');

  const db = buildHierarchyDatabase(index, []);
  const edges = db.modules['top'].children;
  assert.deepEqual(edges.map((e) => e.i), ['u_x'], 'one edge per path');
  assert.equal(edges[0].m, 'leaf', 'the first branch wins');

  const builder = new HierarchyDbBuilder(db, {});
  const root = builder.root('top')!;
  assert.equal(builder.childCount(root), 1, 'the count matches the single edge');
  builder.expandLevel(root);
  assert.deepEqual(root.children!.map((c) => c.path), ['top.u_x']);

  const indexBuilder = new HierarchyBuilder(index, {});
  compareLevels(indexBuilder, builder, indexBuilder.root('top')!, root, 1);
});

test('hierarchyDb: duplicate module definitions merge without duplicating sibling edges', () => {
  // Two files defining the same module with the same instance name (RTL +
  // stub, or a copied file) used to concatenate into two edges at `i: u_l`,
  // so every path under the merged module drew its children twice. Distinct
  // sibling names still union, which is what the merge is for.
  const index = new HdlIndex();
  index.addFile('/w/rtl.v', 'module leaf (); endmodule\nmodule mid (); leaf u_l (); endmodule\n');
  index.addFile('/w/stub.v', 'module mid (); leaf u_l (); endmodule\n');
  index.addFile('/w/top.v', 'module top (); mid u_mid (); endmodule\n');

  const db = buildHierarchyDatabase(index, []);
  const mids = db.modules['mid'].children;
  assert.deepEqual(mids.map((e) => e.i), ['u_l'], 'the shared instance name collapses to one edge');

  const index2 = new HdlIndex();
  index2.addFile('/w/rtl.v', 'module leaf (); endmodule\nmodule mid (); leaf a (); leaf b (); endmodule\n');
  index2.addFile('/w/other.v', 'module mid (); leaf c (); endmodule\n');
  const db2 = buildHierarchyDatabase(index2, []);
  assert.deepEqual(
    db2.modules['mid'].children.map((e) => e.i),
    ['a', 'b', 'c'],
    'distinct sibling names from both definitions are still kept',
  );
});
