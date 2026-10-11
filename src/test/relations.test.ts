import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { HdlIndex } from '../core/index';
import {
  RELATION_DB_VERSION,
  databaseStats,
  emptyDatabase,
  fileRelations,
  hashText,
  moduleRelations,
  parseDatabase,
  serializeDatabase,
  updateDatabase,
  type FileInput,
  type RelationDatabase,
} from '../core/relations';

const CHILD = `
module leaf (
  input  wire a,
  output wire s
);
  assign s = a;
endmodule
`;

const PARENT = `
module top (input wire x, output wire y);
  leaf u_leaf (.a (x), .s (y));
endmodule
`;

function inputs(index: HdlIndex, texts: Map<string, string>): FileInput[] {
  return index.allFiles().map((file) => ({
    file,
    rel: file.replace('/w/', ''),
    hash: hashText(texts.get(file) ?? ''),
  }));
}

test('hashText is stable and changes with the text', () => {
  assert.equal(hashText('module m; endmodule'), hashText('module m; endmodule'));
  assert.notEqual(hashText('module m; endmodule'), hashText('module m ; endmodule'));
  assert.notEqual(hashText('ab'), hashText('ba'));
});

test('moduleRelations lists signal readers/writers and port connections', () => {
  const index = new HdlIndex();
  index.addFile('/w/child.v', CHILD);
  index.addFile('/w/parent.v', PARENT);

  const top = index.resolveModule('top')!;
  const rel = moduleRelations(index, top);

  // `x` is read by the `.a(x)` connection (input), `y` is driven by `.s(y)`.
  assert.deepEqual(rel.signals.x, { readers: ['u_leaf.a (input)'], writers: [] });
  assert.deepEqual(rel.signals.y, { readers: [], writers: ['u_leaf.s (output)'] });

  assert.deepEqual(rel.connections, [
    { instance: 'u_leaf', child: 'leaf', port: 'a', direction: 'input', signals: ['x'] },
    { instance: 'u_leaf', child: 'leaf', port: 's', direction: 'output', signals: ['y'] },
  ]);
});

test('moduleRelations withholds the direction of an unresolved child', () => {
  const index = new HdlIndex();
  index.addFile('/w/parent.v', 'module top (input wire x); missing u (.a (x)); endmodule');
  const rel = moduleRelations(index, index.resolveModule('top')!);
  assert.deepEqual(rel.connections, [
    { instance: 'u', child: 'missing', port: 'a', signals: ['x'] },
  ]);
});

test('fileRelations covers every module of a file in name order', () => {
  const index = new HdlIndex();
  index.addFile('/w/child.v', CHILD);
  const rel = fileRelations(index, '/w/child.v', hashText(CHILD));
  assert.equal(rel.hash, hashText(CHILD));
  assert.deepEqual(rel.modules.map((m) => m.name), ['leaf']);
});

test('updateDatabase full build records every file', () => {
  const index = new HdlIndex();
  index.addFile('/w/child.v', CHILD);
  index.addFile('/w/parent.v', PARENT);
  const texts = new Map([
    ['/w/child.v', CHILD],
    ['/w/parent.v', PARENT],
  ]);

  const { db, changed, removed, reused } = updateDatabase(
    index,
    undefined,
    inputs(index, texts),
    'full',
    'T0',
  );

  assert.equal(db.version, RELATION_DB_VERSION);
  assert.equal(db.generatedAt, 'T0');
  assert.deepEqual(changed, ['child.v', 'parent.v']);
  assert.deepEqual(removed, []);
  assert.equal(reused, 0);
  assert.deepEqual(Object.keys(db.files), ['child.v', 'parent.v']);
});

test('incremental reuses unchanged files and recomputes changed ones', () => {
  const index = new HdlIndex();
  index.addFile('/w/child.v', CHILD);
  index.addFile('/w/parent.v', PARENT);
  const texts = new Map([
    ['/w/child.v', CHILD],
    ['/w/parent.v', PARENT],
  ]);
  const first = updateDatabase(index, undefined, inputs(index, texts), 'full', 'T0').db;

  // Touch only the parent.
  const nextParent = PARENT.replace('u_leaf', 'u_leaf2');
  index.addFile('/w/parent.v', nextParent);
  texts.set('/w/parent.v', nextParent);

  const second = updateDatabase(index, first, inputs(index, texts), 'incremental', 'T1');
  assert.deepEqual(second.changed, ['parent.v']);
  assert.equal(second.reused, 1);
  assert.equal(second.db.generatedAt, 'T1');
  assert.equal(
    (second.db.files['parent.v'].modules[0].connections[0] as { instance: string }).instance,
    'u_leaf2',
  );
});

test('incremental is a no-op when nothing changed', () => {
  const index = new HdlIndex();
  index.addFile('/w/child.v', CHILD);
  index.addFile('/w/parent.v', PARENT);
  const texts = new Map([
    ['/w/child.v', CHILD],
    ['/w/parent.v', PARENT],
  ]);
  const first = updateDatabase(index, undefined, inputs(index, texts), 'full', 'T0').db;
  const second = updateDatabase(index, first, inputs(index, texts), 'incremental', 'T1');
  assert.deepEqual(second.changed, []);
  assert.equal(second.reused, 2);
  assert.equal(serializeDatabase(second.db).replace('"T1"', '"T0"'), serializeDatabase(first));
});

test('incremental recomputes a parent when the child module changes', () => {
  const index = new HdlIndex();
  index.addFile('/w/child.v', CHILD);
  index.addFile('/w/parent.v', PARENT);
  const texts = new Map([
    ['/w/child.v', CHILD],
    ['/w/parent.v', PARENT],
  ]);
  const first = updateDatabase(index, undefined, inputs(index, texts), 'full', 'T0').db;
  assert.equal(first.files['parent.v'].modules[0].connections[0].direction, 'input');

  // The child's port flips direction; the parent file itself is untouched.
  const newChild = CHILD.replace('input  wire a', 'inout  wire a');
  index.addFile('/w/child.v', newChild);
  texts.set('/w/child.v', newChild);

  const second = updateDatabase(index, first, inputs(index, texts), 'incremental', 'T1');
  assert.deepEqual(second.changed, ['child.v', 'parent.v']);
  assert.equal(second.db.files['parent.v'].modules[0].connections[0].direction, 'inout');
});

test('incremental drops files that are no longer indexed', () => {
  const index = new HdlIndex();
  index.addFile('/w/child.v', CHILD);
  index.addFile('/w/parent.v', PARENT);
  const texts = new Map([
    ['/w/child.v', CHILD],
    ['/w/parent.v', PARENT],
  ]);
  const first = updateDatabase(index, undefined, inputs(index, texts), 'full', 'T0').db;

  index.removeFile('/w/child.v');
  const second = updateDatabase(index, first, inputs(index, texts), 'incremental', 'T1');
  assert.deepEqual(second.removed, ['child.v']);
  assert.deepEqual(Object.keys(second.db.files), ['parent.v']);
});

test('serializeDatabase round-trips through parseDatabase', () => {
  const index = new HdlIndex();
  index.addFile('/w/child.v', CHILD);
  const db = updateDatabase(index, undefined, inputs(index, new Map([['/w/child.v', CHILD]])), 'full', 'T0').db;
  const parsed = parseDatabase(serializeDatabase(db));
  assert.deepEqual(parsed, db);
});

test('parseDatabase rejects foreign or malformed payloads', () => {
  assert.equal(parseDatabase('not json'), undefined);
  assert.equal(parseDatabase('null'), undefined);
  assert.equal(parseDatabase(JSON.stringify({ version: 999, files: {} })), undefined);
  assert.equal(parseDatabase(JSON.stringify({ version: 1, files: { 'a.v': { hash: 1 } } })), undefined);
});

test('databaseStats counts files, modules, signals and connections', () => {
  const index = new HdlIndex();
  index.addFile('/w/child.v', CHILD);
  index.addFile('/w/parent.v', PARENT);
  const texts = new Map([
    ['/w/child.v', CHILD],
    ['/w/parent.v', PARENT],
  ]);
  const db = updateDatabase(index, undefined, inputs(index, texts), 'full', 'T0').db;
  // leaf: a, s. top: x, y. Two connections in top.
  assert.deepEqual(databaseStats(db), { files: 2, modules: 2, signals: 4, connections: 2 });
  assert.deepEqual(databaseStats(undefined), { files: 0, modules: 0, signals: 0, connections: 0 });
});

test('emptyDatabase is versioned and empty', () => {
  const db: RelationDatabase = emptyDatabase('T0');
  assert.equal(db.version, RELATION_DB_VERSION);
  assert.deepEqual(db.files, {});
  assert.equal(db.generatedAt, 'T0');
});
