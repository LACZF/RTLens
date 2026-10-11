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
 * does not collide. Writing only happens on an explicit refresh: activation
 * just reads whatever is already there.
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

export function readDatabase(folder: vscode.Uri): RelationDatabase | undefined {
  try {
    return parseDatabase(fs.readFileSync(databasePath(folder), 'utf8'));
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
    if (!owner || owner.uri.fsPath !== base) {
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

  constructor(
    private readonly svc: IndexService,
    private readonly log: vscode.OutputChannel,
  ) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.status.name = 'RTLens relation database';
    this.status.command = 'hdl.connectView.refreshDatabase';
    this.render();
  }

  /** Read the databases already on disk. Never writes. */
  load(): void {
    this.databases.clear();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const db = readDatabase(folder.uri);
      if (db) {
        this.databases.set(folder.uri.fsPath, db);
      }
    }
    this.render();
  }

  /** Recompute and write the databases for every workspace folder. */
  async refresh(mode: RefreshMode): Promise<RefreshSummary> {
    await this.svc.ensureReady();
    const folders = vscode.workspace.workspaceFolders ?? [];
    const started = Date.now();
    const summary: RefreshSummary = { folders: folders.length, files: 0, changed: 0, removed: 0, reused: 0, ms: 0 };

    for (const folder of folders) {
      const inputs = collectInputs(this.svc, folder.uri);
      const previous = this.databases.get(folder.uri.fsPath) ?? readDatabase(folder.uri);
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
    }

    summary.ms = Date.now() - started;
    this.render();
    this.log.appendLine(
      `[db] ${mode} refresh: ${summary.files} file(s) over ${summary.folders} folder(s), ` +
        `${summary.changed} recomputed, ${summary.reused} reused, ${summary.removed} removed in ${summary.ms}ms`,
    );
    return summary;
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
    this.status.dispose();
  }
}
