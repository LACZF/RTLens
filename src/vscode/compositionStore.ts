import * as fs from 'fs';
import * as path from 'path';

import {
  CURRENT_MANIFEST_FILE,
  HIERARCHY_DIR,
  parseManifest,
  parseShard,
  shardFile,
  shardOf,
  type HierarchyManifest,
  type ShardModules,
  type StoredModule,
} from '../core/hierarchyStore';
import { DB_DIR } from './database';

/** Parsed shards kept warm; the working set is depth + expanded levels. */
const SHARD_CACHE_LIMIT = 64;

/**
 * Read-only view of one folder's v4 hierarchy.
 *
 * Opening the store touches only `current.json`; each module is fetched from
 * its shard on demand. A store is pinned to the generation it opened with, so a
 * concurrent rebuild can swap `current.json` without corrupting in-flight reads
 * (the previous generation is retained for exactly this reason).
 */
export class CompositionStore {
  private readonly shards = new Map<string, Promise<ShardModules | undefined>>();

  private constructor(
    readonly folder: string,
    readonly manifest: HierarchyManifest,
  ) {}

  static open(folder: string): CompositionStore | undefined {
    let manifest: HierarchyManifest | undefined;
    try {
      const text = fs.readFileSync(
        path.join(folder, DB_DIR, HIERARCHY_DIR, CURRENT_MANIFEST_FILE),
        'utf8',
      );
      manifest = parseManifest(text);
    } catch {
      return undefined;
    }
    return manifest ? new CompositionStore(folder, manifest) : undefined;
  }

  get generation(): string {
    return this.manifest.generation;
  }

  async module(name: string): Promise<StoredModule | undefined> {
    const shard = shardOf(name);
    const modules = await this.shard(shard);
    return modules?.[name];
  }

  async hasModule(name: string): Promise<boolean> {
    return (await this.module(name)) !== undefined;
  }

  async modulesAmong(names: readonly string[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (const name of names) {
      if (await this.hasModule(name)) {
        out.add(name);
      }
    }
    return out;
  }

  async topFile(name: string): Promise<string | undefined> {
    return (await this.module(name))?.file;
  }

  /** `[top, instance…]` for `name`, following the precomputed first parent. */
  async firstParentPath(name: string): Promise<string[] | undefined> {
    return (await this.firstParentChain(name))?.path;
  }

  async firstParentChain(name: string): Promise<{ top: string; path: string[] } | undefined> {
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
      const entry = await this.module(cur);
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

  private shard(shard: string): Promise<ShardModules | undefined> {
    const cached = this.shards.get(shard);
    if (cached) {
      this.shards.delete(shard);
      this.shards.set(shard, cached);
      return cached;
    }
    const file = path.join(
      this.folder,
      DB_DIR,
      HIERARCHY_DIR,
      this.manifest.generation,
      shardFile(shard),
    );
    const loading = fs.promises
      .readFile(file, 'utf8')
      .then((text) => parseShard(text))
      .catch(() => undefined);
    this.shards.set(shard, loading);
    if (this.shards.size > SHARD_CACHE_LIMIT) {
      const oldest = this.shards.keys().next().value;
      if (oldest !== undefined) {
        this.shards.delete(oldest);
      }
    }
    return loading;
  }
}
