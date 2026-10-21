import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  buildHierarchyDatabase,
  hierarchyDbStats,
  type HierarchyDatabase,
  type HierarchyStats,
} from '../core/hierarchyDb';
import {
  CURRENT_MANIFEST_FILE,
  HIERARCHY_DIR,
  encodeManifest,
  encodeShard,
  manifestFor,
  parseManifest,
  shardFile,
  splitHierarchyDatabase,
  type HierarchyManifest,
} from '../core/hierarchyStore';
import {
  buildIndexDatabase,
  indexDbStats,
  parseIndexDatabase,
  serializeIndexDatabase,
  type IndexDatabase,
  type IndexDbStats,
} from '../core/indexDb';
import {
  GRAPH_DB_VERSION,
  buildGraphDatabase,
  graphDbStats,
  parseGraphDatabase,
  serializeGraphDatabase,
  type GraphDatabase,
  type GraphDbStats,
} from '../core/graphDb';
import { sourceFingerprint } from '../core/relations';
import { DB_DIR, collectInputs, type RefreshMode } from './database';
import type { IndexService } from './indexService';

/**
 * The classified catalog: the databases the §5.6 design splits out besides the
 * signal/module `relations.json` (which `DatabaseService` owns).
 *
 * - `index.json`     - module definitions + instantiation edges (structural base; artifact)
 * - `hierarchy/`     - v4 sharded hierarchy; Composition reads one module at a time
 * - `graph.json`     - default connectivity graph per top (artifact)
 *
 * Every folder gets its own copy under `<folder>/.vscode/rtlens/` so a
 * multi-root workspace does not collide. Each database records a fingerprint of
 * the sources it was built from: a feature uses it only while that fingerprint
 * still matches the workspace, and falls back to the in-memory index otherwise.
 */
export const INDEX_DB_FILE = 'index.json';
export const GRAPH_DB_FILE = 'graph.json';

export interface CatalogStats {
  folders: number;
  index: IndexDbStats;
  hierarchy: HierarchyStats;
  graph: GraphDbStats;
}

/** The databases loaded for one workspace folder plus their freshness. */
interface FolderDbs {
  index?: IndexDatabase;
  hierarchy?: HierarchyManifest;
  graph?: GraphDatabase;
  /** Fingerprint of the sources when loaded/built. */
  fingerprint: string;
  /** True while the on-disk databases match the current sources. */
  fresh: boolean;
}

function dbPath(folder: vscode.Uri, name: string): string {
  return path.join(folder.fsPath, DB_DIR, name);
}

async function readJson<T>(folder: vscode.Uri, name: string, parse: (text: string) => T | undefined): Promise<T | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(dbPath(folder, name)));
    return parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return undefined;
  }
}

function writeJson(folder: vscode.Uri, name: string, text: string): void {
  const target = dbPath(folder, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, 'utf8');
}

function yieldToHost(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function hierarchyBase(folder: vscode.Uri): string {
  return path.join(folder.fsPath, DB_DIR, HIERARCHY_DIR);
}

function readHierarchyManifest(folder: vscode.Uri): HierarchyManifest | undefined {
  try {
    return parseManifest(fs.readFileSync(path.join(hierarchyBase(folder), CURRENT_MANIFEST_FILE), 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Write a complete generation first, then atomically point `current.json` at
 * it. A reader either sees the old manifest or the new one, never a half-built
 * shard set.
 */
function writeHierarchyStore(folder: vscode.Uri, db: HierarchyDatabase, generation: string): HierarchyManifest {
  const base = hierarchyBase(folder);
  const genDir = path.join(base, generation);
  fs.rmSync(genDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(genDir, 'm'), { recursive: true });
  for (const [shard, modules] of splitHierarchyDatabase(db)) {
    fs.writeFileSync(path.join(genDir, shardFile(shard)), encodeShard(modules), 'utf8');
  }
  const manifest = manifestFor(db, generation);
  const current = path.join(base, CURRENT_MANIFEST_FILE);
  const tmp = `${current}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, encodeManifest(manifest), 'utf8');
  fs.renameSync(tmp, current);
  pruneGenerations(base);
  return manifest;
}

/** Keep the generation just replaced so an in-flight reader can finish. */
function pruneGenerations(base: string): void {
  try {
    const generations = fs
      .readdirSync(base)
      .filter((name) => name.startsWith('g-'))
      .sort()
      .reverse();
    for (const name of generations.slice(2)) {
      fs.rmSync(path.join(base, name), { recursive: true, force: true });
    }
  } catch {
    // Pruning is housekeeping; a locked directory must not fail the build.
  }
}

export interface CatalogRefreshSummary {
  folders: number;
  files: number;
  modules: number;
  instances: number;
  tops: number;
  ms: number;
}

export class CatalogService implements vscode.Disposable {
  private readonly dbs = new Map<string, FolderDbs>();
  private readonly autoSub: vscode.Disposable;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fired after a refresh replaced the on-disk hierarchy generation. */
  readonly onDidChangeDatabase = this.changeEmitter.event;
  private autoTimer: ReturnType<typeof setTimeout> | undefined;
  private autoRunning = false;
  private autoPending = false;
  /**
   * Auto-update starts only after `load()`, so activation - which does not
   * scan at all - cannot rewrite the databases before the first index exists.
   */
  private autoStarted = false;

  constructor(
    private readonly svc: IndexService,
    private readonly log: vscode.OutputChannel,
  ) {
    this.autoSub = svc.onDidChange(() => this.onIndexChange());
  }

  /** Read the databases already on disk and check them against the sources. */
  async load(): Promise<void> {
    this.dbs.clear();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const fingerprint = sourceFingerprint(collectInputs(this.svc, folder.uri));
      const index = await readJson(folder.uri, INDEX_DB_FILE, parseIndexDatabase);
      const hierarchy = readHierarchyManifest(folder.uri);
      const graph = await readJson(folder.uri, GRAPH_DB_FILE, parseGraphDatabase);
      const fresh =
        !!index && index.source === fingerprint &&
        !!hierarchy && hierarchy.source === fingerprint &&
        !!graph && graph.source === fingerprint;
      this.dbs.set(folder.uri.fsPath, { index, hierarchy, graph, fingerprint, fresh });
    }
    this.autoStarted = true;
  }

  /** A file edit (or reindex) landed: the databases no longer match the sources. */
  private onIndexChange(): void {
    for (const dbs of this.dbs.values()) {
      dbs.fresh = false;
    }
    if (this.autoStarted && this.svc.config.autoUpdateDatabase) {
      this.scheduleAutoRefresh();
    }
  }

  /**
   * Queue a debounced refresh. The caller decides *whether* to refresh (this
   * does not consult the setting): the index subscription gates on
   * `autoUpdateDatabase`, while a change to the file set forces a refresh
   * regardless.
   */
  scheduleAutoRefresh(delay = 500): void {
    if (this.autoTimer) {
      clearTimeout(this.autoTimer);
    }
    this.autoTimer = setTimeout(() => {
      this.autoTimer = undefined;
      void this.runAutoRefresh();
    }, delay);
  }

  private async runAutoRefresh(): Promise<void> {
    if (this.autoRunning) {
      this.autoPending = true;
      return;
    }
    this.autoRunning = true;
    try {
      await this.refresh('incremental');
    } catch (e) {
      this.log.appendLine(`[catalog] auto refresh failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.autoRunning = false;
      if (this.autoPending) {
        this.autoPending = false;
        this.scheduleAutoRefresh(0);
      }
    }
  }

  /** Rebuild and write every classified database for every workspace folder. */
  async refresh(_mode: RefreshMode): Promise<CatalogRefreshSummary> {
    await this.svc.ensureReady();
    const folders = vscode.workspace.workspaceFolders ?? [];
    const started = Date.now();
    const summary: CatalogRefreshSummary = {
      folders: folders.length,
      files: 0,
      modules: 0,
      instances: 0,
      tops: 0,
      ms: 0,
    };
    const cfg = this.svc.config;
    const tops = this.svc.index.tops(cfg.topModules).map((t) => t.name);

    for (const folder of folders) {
      const inputs = collectInputs(this.svc, folder.uri);
      const fingerprint = sourceFingerprint(inputs);
      const generatedAt = new Date().toISOString();
      const generation = `g-${Date.now().toString(36).padStart(9, '0')}`;
      const graphOptions = {
        hierarchy: { maxDepth: cfg.maxDepth, maxInstances: cfg.maxInstances },
        graph: {
          maxDepth: 8,
          maxNodes: cfg.graphMaxNodes,
          showContainment: cfg.graphShowContainment,
          maxSignalsPerScope: cfg.graphMaxSignalsPerGroup,
          defaultChildLimit: cfg.defaultChildLimit,
        },
      };

      const index = buildIndexDatabase(this.svc.index, inputs, generatedAt, fingerprint);
      await yieldToHost();
      const hierarchy = buildHierarchyDatabase(this.svc.index, cfg.topModules, generatedAt, fingerprint);
      await yieldToHost();

      // Build one top at a time so a workspace with many/large graphs yields
      // between them instead of holding the extension host for the whole set.
      let graph: GraphDatabase | undefined;
      for (const top of [...tops].sort()) {
        const part = buildGraphDatabase(this.svc.index, [top], graphOptions, generatedAt, fingerprint);
        if (!graph) {
          graph = part;
        } else {
          graph.tops.push(...part.tops);
          Object.assign(graph.graphs, part.graphs);
        }
        await yieldToHost();
      }
      graph ??= { version: GRAPH_DB_VERSION, generatedAt, source: fingerprint, tops: [], graphs: {} };

      writeJson(folder.uri, INDEX_DB_FILE, serializeIndexDatabase(index));
      await yieldToHost();
      const manifest = writeHierarchyStore(folder.uri, hierarchy, generation);
      await yieldToHost();
      writeJson(folder.uri, GRAPH_DB_FILE, serializeGraphDatabase(graph));
      this.dbs.set(folder.uri.fsPath, { index, hierarchy: manifest, graph, fingerprint, fresh: true });

      summary.files += inputs.length;
      summary.modules += hierarchyDbStats(hierarchy).modules;
      summary.instances += hierarchyDbStats(hierarchy).instances;
      summary.tops += graph.tops.length;
    }

    summary.ms = Date.now() - started;
    this.changeEmitter.fire();
    this.log.appendLine(
      `[catalog] refresh: ${summary.files} file(s) over ${summary.folders} folder(s), ` +
        `${summary.modules} module(s), ${summary.instances} instance(s), ${summary.tops} top graph(s) in ${summary.ms}ms`,
    );
    return summary;
  }

  stats(): CatalogStats {
    const total: CatalogStats = {
      folders: this.dbs.size,
      index: { files: 0, modules: 0, ports: 0, instances: 0 },
      hierarchy: { modules: 0, instances: 0, tops: 0 },
      graph: { tops: 0, nodes: 0, edges: 0 },
    };
    for (const dbs of this.dbs.values()) {
      const i = indexDbStats(dbs.index);
      const g = graphDbStats(dbs.graph);
      total.index.files += i.files;
      total.index.modules += i.modules;
      total.index.ports += i.ports;
      total.index.instances += i.instances;
      if (dbs.hierarchy) {
        total.hierarchy.modules += dbs.hierarchy.counts.modules;
        total.hierarchy.instances += dbs.hierarchy.counts.instances;
        total.hierarchy.tops += dbs.hierarchy.tops.length;
      }
      total.graph.tops += g.tops;
      total.graph.nodes += g.nodes;
      total.graph.edges += g.edges;
    }
    return total;
  }

  dispose(): void {
    if (this.autoTimer) {
      clearTimeout(this.autoTimer);
    }
    this.autoSub.dispose();
    this.changeEmitter.dispose();
  }
}
