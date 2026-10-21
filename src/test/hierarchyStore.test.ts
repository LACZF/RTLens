import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import type { Range } from '../core/ast';
import type { HierarchyDatabase, HierarchyEdge, HierarchyModule } from '../core/hierarchyDb';
import {
  CURRENT_MANIFEST_FILE,
  HIERARCHY_DIR,
  HIERARCHY_SHARD_COUNT,
  HIERARCHY_STORE_VERSION,
  edgeChildCount,
  edgeDefFile,
  encodeManifest,
  encodeShard,
  firstParentChain,
  hierarchyHash,
  manifestFor,
  parseManifest,
  parseShard,
  shardFile,
  shardOf,
  splitHierarchyDatabase,
} from '../core/hierarchyStore';

const range: Range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 1 },
};

function edge(instance: string, module: string, extra: Partial<HierarchyEdge> = {}): HierarchyEdge {
  return {
    i: instance,
    m: module,
    g: '',
    f: '/w/top.v',
    nr: range,
    mr: range,
    r: range,
    ok: true,
    ...extra,
  };
}

function module(file: string, children: HierarchyEdge[], firstParent: HierarchyModule['firstParent'] = null): HierarchyModule {
  return {
    kind: 'module',
    file,
    nameRange: range,
    range,
    children,
    parents: [{ p: 'x', i: 'u', g: '', f: file, nr: range, r: range }],
    firstParent,
  };
}

function database(): HierarchyDatabase {
  return {
    version: 2,
    generatedAt: '2026-01-01T00:00:00.000Z',
    source: 'fingerprint',
    tops: ['top'],
    modules: {
      top: module('/w/top.v', [edge('u_mid', 'mid', { df: '/w/mid.v', cc: 1 })]),
      mid: module('/w/mid.v', [edge('u_leaf', 'leaf', { df: '/w/leaf.v', cc: 0 })], {
        p: 'top',
        i: 'u_mid',
        g: '',
      }),
      leaf: module('/w/leaf.v', [], { p: 'mid', i: 'u_leaf', g: '' }),
    },
  };
}

test('hierarchy store: shards are stable, zero-padded and bounded', () => {
  assert.equal(shardOf('top'), shardOf('top'), 'the same name always hashes to the same shard');
  assert.match(shardOf('top'), /^\d{3}$/);
  const index = Number(shardOf('top'));
  assert.ok(index >= 0 && index < HIERARCHY_SHARD_COUNT, 'the shard index is inside the shard count');
  assert.equal(hierarchyHash('top'), hierarchyHash('top'), 'FNV-1a is deterministic');
  assert.notEqual(hierarchyHash('top'), hierarchyHash('Top'), 'module names stay case-sensitive');
  assert.equal(shardFile('007'), 'm/007.json');
  assert.equal(HIERARCHY_DIR, 'hierarchy');
  assert.equal(CURRENT_MANIFEST_FILE, 'current.json');
});

test('hierarchy store: a generation round-trips without reverse edges and keeps the edge hints', () => {
  const db = database();
  const shards = splitHierarchyDatabase(db);
  const topShard = shards.get(shardOf('top'))!;
  assert.ok(topShard.top, 'the top module lands in its hashed shard');

  const parsed = parseShard(encodeShard(topShard))!;
  const top = parsed.top;
  assert.equal(top.file, '/w/top.v');
  assert.equal(top.children[0].m, 'mid');
  assert.equal(top.children[0].df, '/w/mid.v', 'the child definition file survives');
  assert.equal(top.children[0].cc, 1, 'the child count hint survives');
  assert.equal('parents' in top, false, 'reverse edges are not written');
});

test('hierarchy store: the manifest counts the graph and copies the tops', () => {
  const manifest = manifestFor(database(), 'g-abc');
  assert.equal(manifest.version, HIERARCHY_STORE_VERSION);
  assert.equal(manifest.generation, 'g-abc');
  assert.equal(manifest.source, 'fingerprint');
  assert.deepEqual(manifest.tops, ['top']);
  assert.deepEqual(manifest.counts, { modules: 3, instances: 2 });
  manifest.tops.push('mutated');
  assert.deepEqual(database().tops, ['top'], 'the manifest owns its tops array');
});

test('hierarchy store: an unreadable or foreign manifest is rejected', () => {
  const good = encodeManifest(manifestFor(database(), 'g-abc'));
  assert.ok(parseManifest(good), 'a valid manifest parses');

  assert.equal(parseManifest('not json'), undefined);
  assert.equal(parseManifest(JSON.stringify({ ...JSON.parse(good), version: 2 })), undefined);
  assert.equal(parseManifest(JSON.stringify({ ...JSON.parse(good), generation: '../../etc' })), undefined);
  assert.equal(parseManifest(JSON.stringify({ ...JSON.parse(good), generation: '' })), undefined);
  assert.equal(parseManifest(JSON.stringify({ version: HIERARCHY_STORE_VERSION, tops: [] })), undefined);

  const partial = parseManifest(
    JSON.stringify({ version: HIERARCHY_STORE_VERSION, generation: 'g-x', tops: ['top', 7], counts: { modules: 1 } }),
  )!;
  assert.deepEqual(partial.tops, ['top'], 'non-string tops are dropped');
  assert.deepEqual(partial.counts, { modules: 1, instances: 0 }, 'missing counts default to zero');
  assert.equal(partial.generatedAt, '');
  assert.equal(partial.source, '');
});

test('hierarchy store: a shard from another version or with a broken record is rejected', () => {
  const text = encodeShard({ top: splitHierarchyDatabase(database()).get(shardOf('top'))!.top });
  assert.ok(parseShard(text));

  assert.equal(parseShard('not json'), undefined);
  assert.equal(
    parseShard(JSON.stringify({ ...JSON.parse(text), version: 2 })),
    undefined,
    'a v2 shard is not mistaken for the current version',
  );
  assert.equal(parseShard(JSON.stringify({ version: HIERARCHY_STORE_VERSION, modules: [] })), undefined);
  assert.equal(
    parseShard(JSON.stringify({ version: HIERARCHY_STORE_VERSION, modules: { top: { file: '/w/top.v' } } })),
    undefined,
    'a record without children is unusable',
  );
});

test('hierarchy store: the first-parent chain walks to the top, root first', () => {
  const db = database();
  const lookup = (name: string) => splitHierarchyDatabase(db).get(shardOf(name))?.[name];
  assert.deepEqual(firstParentChain(lookup, 'leaf'), {
    top: 'top',
    path: ['top', 'u_mid', 'u_leaf'],
  });
  assert.deepEqual(firstParentChain(lookup, 'top'), { top: 'top', path: ['top'] });
  assert.equal(firstParentChain(lookup, 'missing'), undefined);
  assert.equal(firstParentChain(lookup, ''), undefined);
});

test('hierarchy store: a parent cycle ends the walk instead of looping', () => {
  const db = database();
  db.modules.top.firstParent = { p: 'leaf', i: 'u_back', g: '' };
  const lookup = (name: string) => splitHierarchyDatabase(db).get(shardOf(name))?.[name];
  assert.equal(firstParentChain(lookup, 'leaf'), undefined);
});

test('hierarchy store: edge hints default to zero and an empty path', () => {
  assert.equal(edgeChildCount(edge('u', 'leaf')), 0);
  assert.equal(edgeChildCount(edge('u', 'leaf', { cc: 4 })), 4);
  assert.equal(edgeDefFile(edge('u', 'leaf')), '');
  assert.equal(edgeDefFile(edge('u', 'leaf', { df: '/w/leaf.v' })), '/w/leaf.v');
});
