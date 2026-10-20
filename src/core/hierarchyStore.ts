/**
 * Read-optimised hierarchy store (v3).
 *
 * The Composition view only ever needs one module record at a time: a root, a
 * level the reader opened, or the modules on a first-branch path. The v2
 * `hierarchy.json` forces a full parse before any of that is possible, so v3
 * splits the same model into fixed shards:
 *
 * ```
 * hierarchy/
 *   current.json          manifest + generation pointer (tiny, written last)
 *   g-<stamp>/m/000.json  module records, hash(name) % 256
 * ```
 *
 * A record is a {@link HierarchyModule} without the reverse `parents` edges
 * (Composition never reads them) plus two hints that let the view answer
 * display questions without the index:
 *
 * - `children[].df` - the child module's definition file (filter by path)
 * - `children[].cc` - the child's own child count (disclosure triangle)
 *
 * Nothing here touches `vscode`, `fs` or a clock, so encoding stays testable.
 */

import type { HierarchyDatabase, HierarchyEdge, HierarchyModule } from './hierarchyDb';

export const HIERARCHY_STORE_VERSION = 3;
/** Folder under `.vscode/rtlens/` that holds the manifest and generations. */
export const HIERARCHY_DIR = 'hierarchy';
/** Manifest name; it also names the generation the reader must use. */
export const CURRENT_MANIFEST_FILE = 'current.json';
/** Fixed number of shards; module names are case-sensitive, shard names are not. */
export const HIERARCHY_SHARD_COUNT = 256;

/** A module record as written to a shard (no reverse edges). */
export type StoredModule = Omit<HierarchyModule, 'parents'>;

/** `current.json`: enough to pick a root and distrust a foreign database. */
export interface HierarchyManifest {
  version: number;
  /** Directory name under `hierarchy/` that holds the shards. */
  generation: string;
  generatedAt: string;
  /** Source fingerprint recorded at build time (see `core/relations`). */
  source: string;
  /** Top modules, sorted; configured tops are kept even when instantiated. */
  tops: string[];
  counts: { modules: number; instances: number };
}

/** Module records of one shard, keyed by exact module name. */
export type ShardModules = Record<string, StoredModule>;

/** FNV-1a over UTF-16 code units: stable across runs and platforms. */
export function hierarchyHash(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** `000` … `255`. */
export function shardOf(name: string): string {
  return String(hierarchyHash(name) % HIERARCHY_SHARD_COUNT).padStart(3, '0');
}

/** Relative path of a shard inside a generation directory. */
export function shardFile(shard: string): string {
  return `m/${shard}.json`;
}

export function manifestFor(db: HierarchyDatabase, generation: string): HierarchyManifest {
  let instances = 0;
  for (const entry of Object.values(db.modules)) {
    instances += entry.children.length;
  }
  return {
    version: HIERARCHY_STORE_VERSION,
    generation,
    generatedAt: db.generatedAt,
    source: db.source,
    tops: db.tops.slice(),
    counts: { modules: Object.keys(db.modules).length, instances },
  };
}

/** Split a built database into shards; names are sorted for stable output. */
export function splitHierarchyDatabase(db: HierarchyDatabase): Map<string, ShardModules> {
  const shards = new Map<string, ShardModules>();
  for (const name of Object.keys(db.modules).sort()) {
    const entry = db.modules[name];
    const shard = shardOf(name);
    let bucket = shards.get(shard);
    if (!bucket) {
      bucket = {};
      shards.set(shard, bucket);
    }
    bucket[name] = {
      kind: entry.kind,
      file: entry.file,
      nameRange: entry.nameRange,
      range: entry.range,
      firstParent: entry.firstParent,
      children: entry.children,
    };
  }
  return shards;
}

export function encodeManifest(manifest: HierarchyManifest): string {
  return JSON.stringify(manifest);
}

export function encodeShard(modules: ShardModules): string {
  return JSON.stringify({ version: HIERARCHY_STORE_VERSION, modules });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseManifest(text: string): HierarchyManifest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.version !== HIERARCHY_STORE_VERSION) {
    return undefined;
  }
  if (typeof value.generation !== 'string' || !value.generation || !Array.isArray(value.tops)) {
    return undefined;
  }
  if (!/^g-[A-Za-z0-9-]+$/.test(value.generation)) {
    return undefined;
  }
  const counts = isRecord(value.counts) ? value.counts : {};
  return {
    version: HIERARCHY_STORE_VERSION,
    generation: value.generation,
    generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : '',
    source: typeof value.source === 'string' ? value.source : '',
    tops: value.tops.filter((t): t is string => typeof t === 'string'),
    counts: {
      modules: typeof counts.modules === 'number' ? counts.modules : 0,
      instances: typeof counts.instances === 'number' ? counts.instances : 0,
    },
  };
}

/** Parse one shard; `undefined` on anything unusable (the record is then unknown). */
export function parseShard(text: string): ShardModules | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.version !== HIERARCHY_STORE_VERSION || !isRecord(value.modules)) {
    return undefined;
  }
  const out: ShardModules = {};
  for (const [name, raw] of Object.entries(value.modules)) {
    if (!isRecord(raw) || !Array.isArray(raw.children)) {
      return undefined;
    }
    out[name] = raw as unknown as StoredModule;
  }
  return out;
}

/** The first-parent chain from `name` up to its top, root first. */
export function firstParentChain(
  modules: (name: string) => StoredModule | undefined,
  name: string,
): { top: string; path: string[] } | undefined {
  if (!name) {
    return undefined;
  }
  const instances: string[] = [];
  const seen = new Set<string>();
  let cur = name;
  while (true) {
    if (seen.has(cur)) {
      return undefined;
    }
    seen.add(cur);
    const entry = modules(cur);
    if (!entry) {
      return undefined;
    }
    if (!entry.firstParent) {
      return { top: cur, path: [cur, ...instances] };
    }
    instances.unshift(entry.firstParent.i);
    cur = entry.firstParent.p;
  }
}

/** Child count hint recorded on an edge (0 for unresolved modules). */
export function edgeChildCount(edge: HierarchyEdge): number {
  return typeof edge.cc === 'number' ? edge.cc : 0;
}

/** Definition file hint recorded on an edge ('' when unresolved). */
export function edgeDefFile(edge: HierarchyEdge): string {
  return typeof edge.df === 'string' ? edge.df : '';
}
