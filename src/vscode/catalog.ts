import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  buildHierarchyDatabase,
  hierarchyDbStats,
  parseHierarchyDatabase,
  serializeHierarchyDatabase,
  type HierarchyDatabase,
  type HierarchyStats,
} from '../core/hierarchyDb';
import {
  buildIndexDatabase,
  indexDbStats,
  parseIndexDatabase,
  serializeIndexDatabase,
  type IndexDatabase,
  type IndexDbStats,
} from '../core/indexDb';
import {
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
 * - `hierarchy.json` - instantiation graph + display metadata (Composition reads it when fresh)
 * - `graph.json`     - default connectivity graph per top (artifact)
 *
 * Every folder gets its own copy under `<folder>/.vscode/rtlens/` so a
 * multi-root workspace does not collide. Each file records a fingerprint of the
 * sources it was built from: a feature uses the file only while that fingerprint
 * still matches the workspace, and falls back to the in-memory index otherwise.
 */
export const INDEX_DB_FILE = 'index.json';
export const HIERARCHY_DB_FILE = 'hierarchy.json';
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
  hierarchy?: HierarchyDatabase;
  graph?: GraphDatabase;
  /** Fingerprint of the sources when loaded/built. */
  fingerprint: string;
  /** True while the on-disk databases match the current sources. */
  fresh: boolean;
}

function dbPath(folder: vscode.Uri, name: string): string {
  return path.join(folder.fsPath, DB_DIR, name);
}

function readJson<T>(folder: vscode.Uri, name: string, parse: (text: string) => T | undefined): T | undefined {
  try {
    return parse(fs.readFileSync(dbPath(folder, name), 'utf8'));
  } catch {
    return undefined;
  }
}

function writeJson(folder: vscode.Uri, name: string, text: string): void {
  const target = dbPath(folder, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, 'utf8');
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
  private autoTimer: ReturnType<typeof setTimeout> | undefined;
  private autoRunning = false;
  private autoPending = false;
  /**
   * Auto-update starts only after `load()`, so the activation scan - which
   * fires the same index event as an edit - does not rewrite the databases.
   */
  private autoStarted = false;

  constructor(
    private readonly svc: IndexService,
    private readonly log: vscode.OutputChannel,
  ) {
    this.autoSub = svc.onDidChange(() => this.onIndexChange());
    // Composition asks for a fresh hierarchy database by file; when none is
    // fresh (or none was ever written) it gets `undefined` and builds in memory.
    this.svc.hierarchyDatabase = (file?: string) => this.freshHierarchy(file);
  }

  /** Read the databases already on disk and check them against the sources. */
  load(): void {
    this.dbs.clear();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const fingerprint = sourceFingerprint(collectInputs(this.svc, folder.uri));
      const index = readJson(folder.uri, INDEX_DB_FILE, parseIndexDatabase);
      const hierarchy = readJson(folder.uri, HIERARCHY_DB_FILE, parseHierarchyDatabase);
      const graph = readJson(folder.uri, GRAPH_DB_FILE, parseGraphDatabase);
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

      const index = buildIndexDatabase(this.svc.index, inputs, generatedAt, fingerprint);
      const hierarchy = buildHierarchyDatabase(this.svc.index, cfg.topModules, generatedAt, fingerprint);
      const graph = buildGraphDatabase(
        this.svc.index,
        tops,
        {
          hierarchy: { maxDepth: cfg.maxDepth, maxInstances: cfg.maxInstances },
          graph: {
            maxDepth: 8,
            maxNodes: cfg.graphMaxNodes,
            showContainment: cfg.graphShowContainment,
            maxSignalsPerScope: cfg.graphMaxSignalsPerGroup,
            defaultChildLimit: cfg.defaultChildLimit,
          },
        },
        generatedAt,
        fingerprint,
      );

      writeJson(folder.uri, INDEX_DB_FILE, serializeIndexDatabase(index));
      writeJson(folder.uri, HIERARCHY_DB_FILE, serializeHierarchyDatabase(hierarchy));
      writeJson(folder.uri, GRAPH_DB_FILE, serializeGraphDatabase(graph));
      this.dbs.set(folder.uri.fsPath, { index, hierarchy, graph, fingerprint, fresh: true });

      summary.files += inputs.length;
      summary.modules += hierarchyDbStats(hierarchy).modules;
      summary.instances += hierarchyDbStats(hierarchy).instances;
      summary.tops += graph.tops.length;
    }

    summary.ms = Date.now() - started;
    this.log.appendLine(
      `[catalog] refresh: ${summary.files} file(s) over ${summary.folders} folder(s), ` +
        `${summary.modules} module(s), ${summary.instances} instance(s), ${summary.tops} top graph(s) in ${summary.ms}ms`,
    );
    return summary;
  }

  /** A fresh hierarchy database for `file`'s folder, or `undefined`. */
  private freshHierarchy(file?: string): HierarchyDatabase | undefined {
    const dbs = this.folderFor(file);
    return dbs?.fresh ? dbs.hierarchy : undefined;
  }

  private folderFor(file?: string): FolderDbs | undefined {
    if (file) {
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
      if (folder) {
        const found = this.dbs.get(folder.uri.fsPath);
        if (found) {
          return found;
        }
      }
    }
    return this.dbs.values().next().value;
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
      const h = hierarchyDbStats(dbs.hierarchy);
      const g = graphDbStats(dbs.graph);
      total.index.files += i.files;
      total.index.modules += i.modules;
      total.index.ports += i.ports;
      total.index.instances += i.instances;
      total.hierarchy.modules += h.modules;
      total.hierarchy.instances += h.instances;
      total.hierarchy.tops += h.tops;
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
    if (this.svc.hierarchyDatabase) {
      this.svc.hierarchyDatabase = undefined;
    }
  }
}
