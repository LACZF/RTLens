import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  databaseStats,
  hashText,
  parseDatabase,
  serializeDatabase,
  updateDatabase,
  type DatabaseStats,
  type FileInput,
  type RelationDatabase,
  type UpdateResult,
} from '../core/relations';
import type { IndexService } from './indexService';

/**
 * The signal ↔ module relation database, persisted under each workspace
 * folder's `.vscode` directory.
 *
 * Every folder gets its own file (`<folder>/.vscode/rtlens/relations.json`) so
 * the database travels with the tree it describes and a multi-root workspace
 * does not collide. Activation only reads whatever is already there; the file
 * is written by an explicit refresh or, when `autoUpdateDatabase` is on, by the
 * debounced incremental refresh that follows an index change.
 */
export const DB_DIR = path.join('.vscode', 'rtlens');
export const DB_FILE = 'relations.json';

export type RefreshMode = 'incremental' | 'full';

export interface RefreshSummary {
  folders: number;
  files: number;
  changed: number;
  removed: number;
  reused: number;
  ms: number;
}

export function databasePath(folder: vscode.Uri): string {
  return path.join(folder.fsPath, DB_DIR, DB_FILE);
}

export async function readDatabase(folder: vscode.Uri): Promise<RelationDatabase | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(databasePath(folder)));
    return parseDatabase(Buffer.from(bytes).toString('utf8'));
  } catch {
    return undefined;
  }
}

export function writeDatabase(folder: vscode.Uri, db: RelationDatabase): void {
  const target = databasePath(folder);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, serializeDatabase(db), 'utf8');
}

/** The indexed files that belong to `folder`, with their workspace-relative key. */
export function collectInputs(svc: IndexService, folder: vscode.Uri): FileInput[] {
  const base = folder.fsPath;
  const out: FileInput[] = [];
  for (const file of svc.index.allFiles()) {
    const owner = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
    // Files owned by another folder belong to that folder's database. Unowned
    // files come from `hdl.connectView.databasePaths` (a shared library outside
    // the workspace) and are recorded in every folder that can see them.
    if (owner && owner.uri.fsPath !== base) {
      continue;
    }
    const rel = path.relative(base, file).split(path.sep).join('/');
    out.push({ file, rel, hash: hashText(svc.textSync(file) ?? '') });
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

/** Ask the user whether to refresh incrementally or rebuild from scratch. */
export async function pickRefreshMode(): Promise<RefreshMode | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: '$(sync) Incremental refresh',
        description: 'Recompute only files that changed since the last build',
        mode: 'incremental' as RefreshMode,
      },
      {
        label: '$(database) Full rebuild',
        description: 'Discard the database and rebuild every file',
        mode: 'full' as RefreshMode,
      },
    ],
    { title: 'RTLens: refresh signal/module database', placeHolder: 'Incremental or full?' },
  );
  return pick?.mode;
}

/**
 * Owns the persisted databases and the status-bar button that refreshes them.
 *
 * The button lives in the status bar (the "bottom bar") because a refresh is a
 * workspace-wide maintenance action, not something tied to the current module.
 */
export class DatabaseService implements vscode.Disposable {
  private readonly status: vscode.StatusBarItem;
  /** Latest known database per workspace folder, keyed by folder path. */
  private readonly databases = new Map<string, RelationDatabase>();
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
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.status.name = 'RTLens relation database';
    this.status.command = 'hdl.connectView.refreshDatabase';
    this.autoSub = svc.onDidChange(() => this.onIndexChange());
    this.render();
  }

  /** Read the databases already on disk. Never writes. */
  async load(): Promise<void> {
    this.databases.clear();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const db = await readDatabase(folder.uri);
      if (db) {
        this.databases.set(folder.uri.fsPath, db);
      }
    }
    this.autoStarted = true;
    this.render();
  }

  /** A file edit (or reindex) landed: keep the database current if asked to. */
  private onIndexChange(): void {
    if (this.autoStarted && this.svc.config.autoUpdateDatabase) {
      this.scheduleAutoRefresh();
    }
  }

  /**
   * Queue a debounced incremental refresh.
   *
   * The caller decides *whether* to refresh (this does not consult the setting):
   * the index subscription gates on `autoUpdateDatabase`, while a change to the
   * file set forces a refresh regardless. Debouncing coalesces the burst of
   * index events a single save produces into one write.
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

  /** Run a queued refresh, never overlapping itself or a manual one. */
  private async runAutoRefresh(): Promise<void> {
    if (this.autoRunning) {
      this.autoPending = true;
      return;
    }
    this.autoRunning = true;
    try {
      await this.refresh('incremental');
    } catch (e) {
      this.log.appendLine(`[db] auto refresh failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.autoRunning = false;
      if (this.autoPending) {
        this.autoPending = false;
        this.scheduleAutoRefresh(0);
      }
    }
  }

  /** Recompute and write the databases for every workspace folder. */
  async refresh(mode: RefreshMode): Promise<RefreshSummary> {
    // Synchronous on entry: the click has to be acknowledged before the first
    // await, or a fast refresh flashes nothing and a slow one shows a dead
    // button. `finally` restores the resting label even when a folder throws.
    this.status.text = '$(sync~spin) RTLens: refreshing database…';
    try {
      await this.svc.ensureReady();
      const folders = vscode.workspace.workspaceFolders ?? [];
      const started = Date.now();
      const summary: RefreshSummary = { folders: folders.length, files: 0, changed: 0, removed: 0, reused: 0, ms: 0 };

      for (const folder of folders) {
        const inputs = collectInputs(this.svc, folder.uri);
        const previous = this.databases.get(folder.uri.fsPath) ?? (await readDatabase(folder.uri));
        const result = updateDatabase(
          this.svc.index,
          previous,
          inputs,
          mode,
          new Date().toISOString(),
        );
        writeDatabase(folder.uri, result.db);
        this.databases.set(folder.uri.fsPath, result.db);
        this.addTo(summary, result, inputs.length);
        // A per-folder turn: `collectInputs` and `updateDatabase` are
        // synchronous, so without a yield a multi-folder refresh blocks the
        // host message loop - the spinner cannot repaint and the refresh
        // command's follow-up RPCs queue behind the whole run.
        await new Promise((r) => setImmediate(r));
      }

      summary.ms = Date.now() - started;
      this.log.appendLine(
        `[db] ${mode} refresh: ${summary.files} file(s) over ${summary.folders} folder(s), ` +
          `${summary.changed} recomputed, ${summary.reused} reused, ${summary.removed} removed in ${summary.ms}ms`,
      );
      return summary;
    } finally {
      this.render();
    }
  }

  private addTo(target: RefreshSummary, result: UpdateResult, files: number): void {
    target.files += files;
    target.changed += result.changed.length;
    target.removed += result.removed.length;
    target.reused += result.reused;
  }

  stats(): DatabaseStats {
    const total: DatabaseStats = { files: 0, modules: 0, signals: 0, connections: 0 };
    for (const db of this.databases.values()) {
      const s = databaseStats(db);
      total.files += s.files;
      total.modules += s.modules;
      total.signals += s.signals;
      total.connections += s.connections;
    }
    return total;
  }

  private render(): void {
    if (!(vscode.workspace.workspaceFolders ?? []).length) {
      this.status.hide();
      return;
    }
    const s = this.stats();
    const built = this.databases.size > 0;
    this.status.text = built ? '$(database) RTLens DB' : '$(database) RTLens: build DB';
    this.status.tooltip = built
      ? `Signal/module database: ${s.files} files, ${s.modules} modules, ${s.signals} signals, ` +
        `${s.connections} connections\nStored under .vscode/rtlens/relations.json\nClick to refresh`
      : 'No relation database yet. Click to build it under .vscode/rtlens/.';
    this.status.show();
  }

  dispose(): void {
    if (this.autoTimer) {
      clearTimeout(this.autoTimer);
    }
    this.autoSub.dispose();
    this.status.dispose();
  }
}
