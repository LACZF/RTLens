import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { HdlIndex } from '../core/index';
import { hashText, type FileInput } from '../core/relations';
import {
  buildIndexDatabase,
  indexDbStats,
  INDEX_DB_VERSION,
  parseIndexDatabase,
  serializeIndexDatabase,
} from '../core/indexDb';

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

const TOP = '/ws/top.v';
const LEAF = '/ws/leaf.v';
const TOP_SRC =
  'module top(input wire x, output wire y); leaf u (.a (x), .s (y)); endmodule\n';
const LEAF_SRC = 'module leaf(input wire a, output wire s); assign s = a; endmodule\n';

function sample(): { index: HdlIndex; inputs: FileInput[] } {
  const index = new HdlIndex();
  index.addFile(TOP, TOP_SRC);
  index.addFile(LEAF, LEAF_SRC);
  const inputs: FileInput[] = [
    { file: TOP, rel: 'top.v', hash: hashText(TOP_SRC) },
    { file: LEAF, rel: 'leaf.v', hash: hashText(LEAF_SRC) },
  ];
  return { index, inputs };
}

test('indexDb: the database lists files, modules, ports and instantiation edges', () => {
  const { index, inputs } = sample();
  const db = buildIndexDatabase(index, inputs, '2026-01-01T00:00:00Z', 'fp');
  assert.equal(db.version, INDEX_DB_VERSION);
  assert.equal(db.generatedAt, '2026-01-01T00:00:00Z');
  assert.equal(db.source, 'fp');

  assert.deepEqual(Object.keys(db.files).sort(), ['leaf.v', 'top.v']);
  assert.deepEqual(db.files['top.v'].modules, ['top']);
  assert.equal(db.files['top.v'].hash, hashText(TOP_SRC));

  const top = db.modules['top'];
  assert.deepEqual(top.portOrder, ['x', 'y']);
  assert.deepEqual(top.ports.map((p) => p.direction), ['input', 'output']);
  assert.equal(top.instances.length, 1);
  assert.equal(top.instances[0].m, 'leaf');
  assert.equal(top.instances[0].i, 'u');
  assert.equal(top.instances[0].ok, true, 'the child module resolves');

  assert.equal(db.modules['leaf'].instances.length, 0);
  assert.ok(db.modules['leaf'].refs > 0, 'the assign reads signals');
});

test('indexDb: an unresolved instantiation is still recorded, flagged not ok', () => {
  const index = new HdlIndex();
  index.addFile('/ws/solo.v', 'module solo; missing u (); endmodule\n');
  const db = buildIndexDatabase(index, [{ file: '/ws/solo.v', rel: 'solo.v', hash: 'h' }], '', '');
  assert.equal(db.modules['solo'].instances[0].ok, false);
});

test('indexDb: stats count files, modules, ports and instances', () => {
  const { index, inputs } = sample();
  const db = buildIndexDatabase(index, inputs, '', '');
  assert.deepEqual(indexDbStats(db), { files: 2, modules: 2, ports: 4, instances: 1 });
  assert.deepEqual(indexDbStats(undefined), { files: 0, modules: 0, ports: 0, instances: 0 });
});

test('indexDb: serialize and parse round-trip, parse rejects junk and stale versions', () => {
  const { index, inputs } = sample();
  const db = buildIndexDatabase(index, inputs, 'now', 'fp');
  assert.deepEqual(parseIndexDatabase(serializeIndexDatabase(db)), db);
  assert.equal(parseIndexDatabase('nope'), undefined);
  assert.equal(parseIndexDatabase(JSON.stringify({ version: 999, files: {}, modules: {} })), undefined);
  assert.equal(parseIndexDatabase(JSON.stringify({ version: INDEX_DB_VERSION })), undefined);
});

test('indexDb: the artifact conceals no fixture dependencies', () => {
  // Build over the real fixtures too, so a change to the parser's instance or
  // port shape is caught here and not only in the synthetic cases above.
  const index = new HdlIndex();
  const dir = path.join(FIXTURES, 'lib');
  const inputs: FileInput[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/\.(v|sv|svh|vh)$/.test(name)) {
      continue;
    }
    const file = path.join(dir, name);
    const src = fs.readFileSync(file, 'utf8');
    index.addFile(file, src);
    inputs.push({ file, rel: name, hash: hashText(src) });
  }
  const db = buildIndexDatabase(index, inputs, '', '');
  assert.ok(db.modules['chip_top'], 'the fixture top is present');
  const stats = indexDbStats(db);
  assert.ok(stats.modules > 0 && stats.instances > 0, 'the design has modules and wiring');
});
