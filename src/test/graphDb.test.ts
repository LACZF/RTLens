import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { HdlIndex } from '../core/index';
import {
  buildGraphDatabase,
  graphDbStats,
  GRAPH_DB_VERSION,
  parseGraphDatabase,
  serializeGraphDatabase,
} from '../core/graphDb';

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

function libIndex(): HdlIndex {
  const index = new HdlIndex();
  const dir = path.join(FIXTURES, 'lib');
  for (const name of fs.readdirSync(dir)) {
    if (/\.(v|sv|svh|vh)$/.test(name)) {
      const file = path.join(dir, name);
      index.addFile(file, fs.readFileSync(file, 'utf8'));
    }
  }
  return index;
}

const OPTIONS = { hierarchy: {}, graph: {} };

test('graphDb: every top gets a non-empty connectivity graph', () => {
  const db = buildGraphDatabase(libIndex(), ['chip_top'], OPTIONS, '2026-01-01T00:00:00Z', 'fp');
  assert.equal(db.version, GRAPH_DB_VERSION);
  assert.deepEqual(db.tops, ['chip_top']);
  const entry = db.graphs['chip_top'];
  assert.ok(entry, 'the configured top has a graph');
  assert.ok(entry.graph.nodes.length > 0);
  assert.equal(typeof entry.options, 'object');
});

test('graphDb: a top that does not resolve is skipped, not recorded empty', () => {
  const db = buildGraphDatabase(libIndex(), ['chip_top', 'ghost'], OPTIONS, '', '');
  assert.deepEqual(db.tops, ['chip_top'], 'a vanished name is dropped from tops');
  assert.equal(db.graphs['ghost'], undefined);
});

test('graphDb: stats sum nodes and edges across tops', () => {
  const db = buildGraphDatabase(libIndex(), ['chip_top'], OPTIONS, '', '');
  const stats = graphDbStats(db);
  assert.equal(stats.tops, 1);
  assert.equal(stats.nodes, db.graphs['chip_top'].graph.nodes.length);
  assert.equal(stats.edges, db.graphs['chip_top'].graph.edges.length);
  assert.deepEqual(graphDbStats(undefined), { tops: 0, nodes: 0, edges: 0 });
});

test('graphDb: serialize and parse round-trip, parse rejects junk and stale versions', () => {
  const db = buildGraphDatabase(libIndex(), ['chip_top'], OPTIONS, 'now', 'fp');
  const parsed = parseGraphDatabase(serializeGraphDatabase(db));
  assert.ok(parsed);
  assert.equal(parsed!.generatedAt, 'now');
  assert.equal(parsed!.source, 'fp');
  assert.deepEqual(parsed!.tops, db.tops);
  assert.deepEqual(graphDbStats(parsed), graphDbStats(db), 'the round-tripped graphs carry the same shape');
  assert.equal(parseGraphDatabase('{'), undefined);
  assert.equal(parseGraphDatabase(JSON.stringify({ version: 999, tops: [], graphs: {} })), undefined);
  assert.equal(
    parseGraphDatabase(JSON.stringify({ version: GRAPH_DB_VERSION, tops: [], graphs: { x: {} } })),
    undefined,
    'an entry without a graph object is rejected',
  );
});

test('graphDb: tops are stored sorted', () => {
  const db = buildGraphDatabase(libIndex(), ['chip_top'], OPTIONS, '', '');
  const sorted = [...db.tops].sort();
  assert.deepEqual(db.tops, sorted);
});
