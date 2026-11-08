import * as fs from 'fs';
import * as path from 'path';
import * as v8 from 'v8';
import * as vscode from 'vscode';

import { HdlIndex, basename, dirname } from '../core/index';
import {
  buildHierarchy,
  containingDesign as containingDesignOf,
  containingPath,
  findByPath,
  subtree,
} from '../core/hierarchy';
import { buildGraph, type Graph, type GraphOptions } from '../core/graph';
import type { HierarchyNode, ModuleDef } from '../core/ast';
import type { HierarchyResult } from '../core/hierarchy';
import { hashText } from '../core/relations';
import { isExcluded, readConfig, scanGlob, type HdlConfig } from './config';
import { SAFE_MODE_MAX_FILES, ScanGuard, overHeapBudget } from './safeMode';

export type IndexState = 'idle' | 'indexing' | 'ready' | 'error';

const INCLUDE_EXT = /\.(v|sv|svh|vh|vlt)$/i;

/** A single file above this many UTF-16 units is not parsed. */
export const MAX_FILE_CHARS = 8 * 1024 * 1024;

/** Total source text a single scan may keep in the index. */
export const MAX_SOURCE_CHARS = 256 * 1024 * 1024;

/**
 * Owns the workspace-wide {@link HdlIndex}.
 *
 * Parsing is synchronous and fast enough for typical RTL folders (a few
 * thousand files well under a second), so there is no worker: the index lives
 * in the extension host and is updated in place. Every parse of an already
 * known file replaces its previous modules, which keeps definition lookups
 * consistent with unsaved edits.
 */
export class IndexService implements vscode.Disposable {
  readonly index = new HdlIndex();

  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires after the index contents changed. */
  readonly onDidChange = this.changeEmitter.event;

  private readonly stateEmitter = new vscode.EventEmitter<IndexState>();
  readonly onDidChangeState = this.stateEmitter.event;

  private stateValue: IndexState = 'idle';
  private readyPromise: Promise<void> | undefined;
  private watchers: vscode.Disposable[] = [];
  private configValue: HdlConfig;
  private readonly saveTimers = new Map<string, NodeJS.Timeout>();
  /** Hash of the text last handed to the index per file, so an unchanged buffer is not re-parsed. */
  private readonly hashes = new Map<string, string>();
  /** Files whose text is currently in the index (as opposed to merely opened once). */
  private readonly ingested = new Set<string>();
  private readonly includedFiles = new Set<string>();
  /** Files named directly by `hdl.connectView.databasePaths`; exclude rules do not apply. */
  private explicitFiles = new Set<string>();
  private lastError: string | undefined;
  /** Source characters ingested since the current scan started. */
  private sourceChars = 0;

  constructor(
    private readonly log: vscode.OutputChannel,
    private readonly guard?: ScanGuard,
  ) {
    this.configValue = readConfig();
  }

  get state(): IndexState {
    return this.stateValue;
  }

  get config(): HdlConfig {
    return this.configValue;
  }

  get error(): string | undefined {
    return this.lastError;
  }

  get safeMode(): boolean {
    return this.guard?.safeMode === true;
  }

  get stats(): { files: number; modules: number; parseMs: number; unresolved: number } {
    const s = this.index.stats;
    return {
      files: s.files,
      modules: s.modules,
      parseMs: Math.round(s.parseMs),
      unresolved: s.unresolvedInstances,
    };
  }

  /** Resolve when the first full scan has finished. */
  ensureReady(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.scan();
    }
    return this.readyPromise;
  }

  reloadConfig(): void {
    this.configValue = readConfig();
  }

  /** Full rescan, e.g. after a configuration change. */
  async refresh(): Promise<void> {
    // The state has to move before the index is torn down: views rebuild on
    // `onDidChange`, and they only rebuild while they read `ready`. Announcing
    // afterwards would let every subscriber rebuild from a half-cleared index -
    // the composition tree would lose its root and, with it, the expanded
    // frontier it captured from that root.
    this.setState('indexing');
    this.readyPromise = undefined;
    this.stopWatchers();
    this.includedFiles.clear();
    this.explicitFiles.clear();
    this.hashes.clear();
    this.ingested.clear();
    this.index.clear();
    this.changeEmitter.fire();
    await this.ensureReady();
  }

  private setState(s: IndexState): void {
    if (this.stateValue !== s) {
      this.stateValue = s;
      this.stateEmitter.fire(s);
    }
  }

  private async scan(): Promise<void> {
    this.setState('indexing');
    this.lastError = undefined;
    this.sourceChars = 0;
    await this.guard?.begin();
    const started = Date.now();
    const heapLimit = v8.getHeapStatistics().heap_size_limit;
    try {
      this.configValue = readConfig();
      const targets = this.scanTargets();
      this.explicitFiles = new Set(targets.files);
      if (targets.dirs.length === 0 && targets.files.length === 0) {
        this.finishScan(started, 0);
        return;
      }
      const configured = Math.max(1, this.configValue.maxFiles);
      const budget = this.safeMode ? Math.min(configured, SAFE_MODE_MAX_FILES) : configured;
      const uris: vscode.Uri[] = [];
      let truncated = false;
      for (const dir of targets.dirs) {
        const remaining = budget - uris.length;
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        // Ask for one more than the budget: a list that long proves the
        // directory holds more matches, so the log can say the scan was cut
        // instead of pretending the workspace ends there.
        const found = await vscode.workspace.findFiles(
          new vscode.RelativePattern(vscode.Uri.file(dir), scanGlob(this.configValue)),
          this.configValue.exclude.length ? `{${this.configValue.exclude.join(',')}}` : null,
          remaining + 1,
        );
        if (found.length > remaining) {
          truncated = true;
          uris.push(...found.slice(0, remaining));
          break;
        }
        uris.push(...found);
      }
      for (const file of targets.files) {
        if (uris.length >= budget) {
          truncated = true;
          break;
        }
        uris.push(vscode.Uri.file(file));
      }
      const seen = new Set<string>();
      let parsed = 0;
      let memoryTruncated = false;
      let lastYield = Date.now();
      for (const uri of uris) {
        const file = uri.fsPath;
        if (seen.has(file)) {
          continue;
        }
        seen.add(file);
        if (!this.explicitFiles.has(file) && isExcluded(file, this.configValue)) {
          continue;
        }
        if (this.sourceChars > MAX_SOURCE_CHARS || overHeapBudget(process.memoryUsage().heapUsed, heapLimit)) {
          memoryTruncated = true;
          break;
        }
        try {
          this.ingestFile(file);
          parsed++;
        } catch (e) {
          // One pathological file (a stack overflow in the parser, an
          // unreadable directory entry) must not abort the whole workspace
          // scan: the rest of the index is still useful.
          this.log.appendLine(`[index] skipped ${file}: ${e instanceof Error ? e.message : String(e)}`);
        }
        // Yield by elapsed time, not every N files: a few large files can hold
        // the host for seconds while thousands of small ones need no pause.
        if (Date.now() - lastYield >= 12) {
          await new Promise((r) => setImmediate(r));
          lastYield = Date.now();
        }
      }
      if (truncated) {
        if (this.safeMode) {
          this.log.appendLine(`[index] safe mode budget reached (${budget} file(s)); scan truncated`);
          void vscode.window.setStatusBarMessage(
            `RTLens: safe mode indexed the first ${budget} file(s); run "HDL: Retry Full Index" to scan the whole workspace.`,
            8000,
          );
        } else {
          this.log.appendLine(`[index] file budget reached (maxFiles = ${budget}); scan truncated`);
          void vscode.window.setStatusBarMessage(
            `RTLens: indexed the first ${budget} file(s) (hdl.connectView.maxFiles); raise it to index more.`,
            8000,
          );
        }
      }
      if (memoryTruncated) {
        this.log.appendLine(`[index] memory budget reached after ${parsed} file(s); scan truncated to protect the extension host`);
        void vscode.window.setStatusBarMessage(
          'RTLens: stopped indexing to protect the extension host; narrow hdl.connectView.files or databasePaths.',
          8000,
        );
      }
      this.syncOpenDocuments();
      this.startWatchers();
      this.finishScan(started, parsed);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.log.appendLine(`[index] scan failed: ${this.lastError}`);
      this.setState('error');
      await this.guard?.finish();
    }
  }

  private finishScan(started: number, count: number): void {
    const ms = Date.now() - started;
    const s = this.stats;
    this.log.appendLine(
      `[index] ${count} file(s) -> ${s.modules} module(s) in ${ms}ms ` +
        `(${s.parseMs}ms parsing, ${s.unresolved} unresolved instance(s), ${this.includedFiles.size} include(s))`,
    );
    this.setState('ready');
    this.changeEmitter.fire();
  }

  // ------------------------------------------------------------------ updates

  private ingestFile(file: string): void {
    const text = this.textSync(file);
    if (text === undefined) {
      return;
    }
    if (text.length > MAX_FILE_CHARS) {
      this.log.appendLine(
        `[index] skipped ${file}: ${text.length} characters exceeds the per-file limit (${MAX_FILE_CHARS})`,
      );
      return;
    }
    this.sourceChars += text.length;
    this.index.addFile(file, text);
    this.hashes.set(file, hashText(text));
    this.ingested.add(file);
    this.followIncludes(file);
  }

  /** `\`include` targets are indexed as separate files so their modules resolve. */
  private followIncludes(file: string): void {
    for (const mod of this.index.modulesInFile(file)) {
      for (const inc of mod.includes) {
        const target = this.resolveInclude(file, inc);
        if (target && this.index.modulesInFile(target).length === 0) {
          this.includedFiles.add(target);
          this.ingestFile(target);
        }
      }
    }
  }

  private resolveInclude(fromFile: string, inc: string): string | undefined {
    const dir = dirname(fromFile);
    const direct = path.resolve(dir, inc);
    if (isReadable(direct)) {
      return direct;
    }
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fromFile));
    const roots = folder ? [folder.uri.fsPath] : [];
    roots.push(dir);
    for (const root of roots) {
      for (const sub of this.configValue.includeDirs) {
        const p = path.resolve(root, sub, inc);
        if (isReadable(p)) {
          return p;
        }
      }
    }
    return undefined;
  }

  /**
   * Resolve the directories and files that make up a scan.
   *
   * Without `databasePathsOnly` every workspace folder is scanned, as before.
   * `databasePaths` adds extra roots: a directory is scanned recursively with
   * the `files` globs, a single HDL file is indexed directly. Relative entries
   * resolve against each workspace folder, absolute ones are used verbatim, so
   * a shared RTL library outside the workspace can be pulled in. Explicitly
   * listed files bypass the exclude rules, which are about the bulk scan.
   */
  private scanTargets(): { dirs: string[]; files: string[] } {
    const cfg = this.configValue;
    const bases = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const dirs: string[] = [];
    const files: string[] = [];
    const add = (p: string): void => {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(p);
      } catch {
        return;
      }
      if (stat.isDirectory()) {
        if (!dirs.includes(p)) {
          dirs.push(p);
        }
      } else if (stat.isFile() && INCLUDE_EXT.test(p) && !files.includes(p) && !dirs.some((d) => isUnder(p, d))) {
        files.push(p);
      }
    };
    if (!cfg.databasePathsOnly) {
      for (const base of bases) {
        add(base);
      }
    }
    for (const entry of cfg.databasePaths) {
      if (path.isAbsolute(entry)) {
        add(entry);
      } else {
        for (const base of bases) {
          add(path.resolve(base, entry));
        }
      }
    }
    return { dirs, files };
  }

  private startWatchers(): void {
    const { dirs, files } = this.scanTargets();
    for (const dir of dirs) {
      // One watcher per scanned root, each anchored to that root, so a
      // multi-root workspace is watched exactly once per file.
      const w = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dir), scanGlob(this.configValue)),
      );
      w.onDidCreate((uri) => this.upsert(uri.fsPath));
      w.onDidChange((uri) => this.upsert(uri.fsPath));
      w.onDidDelete((uri) => this.remove(uri.fsPath));
      this.watchers.push(w);
    }
    for (const file of files) {
      // A single file outside any scanned directory: watch just its basename.
      const w = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dirname(file)), basename(file)),
      );
      w.onDidCreate((uri) => this.upsert(uri.fsPath));
      w.onDidChange((uri) => this.upsert(uri.fsPath));
      w.onDidDelete((uri) => this.remove(uri.fsPath));
      this.watchers.push(w);
    }
  }

  private stopWatchers(): void {
    for (const d of this.watchers) {
      d.dispose();
    }
    this.watchers = [];
  }

  /** Index a file that was just written by the extension itself. */
  async upsertPublic(file: string): Promise<void> {
    const text = await this.text(file);
    if (text !== undefined) {
      this.upsert(file);
    }
  }

  private upsert(file: string): void {
    if (!INCLUDE_EXT.test(file) || (!this.explicitFiles.has(file) && isExcluded(file, this.configValue))) {
      return;
    }
    this.ingestFile(file);
    this.changeEmitter.fire();
  }

  private remove(file: string): void {
    this.index.removeFile(file);
    this.includedFiles.delete(file);
    this.hashes.delete(file);
    this.ingested.delete(file);
    this.changeEmitter.fire();
  }

  /** Track unsaved edits: re-parse the document after a short debounce. */
  watchDocument(doc: vscode.TextDocument): vscode.Disposable {
    if (doc.uri.scheme !== 'file' || !INCLUDE_EXT.test(doc.fileName)) {
      return new vscode.Disposable(() => undefined);
    }
    const file = doc.fileName;
    // The bulk scan honours the exclude patterns, but a file you have opened
    // has to be resolvable all the same: without its modules in the index,
    // nothing inside it can be jumped to, hovered or listed in Nets. Exclusion
    // stays a decision about the workspace scan, not about this file.
    if (!this.ingested.has(file)) {
      this.ingestFile(file);
      this.changeEmitter.fire();
    }
    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document !== doc || e.contentChanges.length === 0) {
        return;
      }
      const existing = this.saveTimers.get(file);
      if (existing) {
        clearTimeout(existing);
      }
      this.saveTimers.set(
        file,
        setTimeout(() => {
          this.saveTimers.delete(file);
          if (!doc.isDirty) {
            return;
          }
          const text = doc.getText();
          this.index.addFile(file, text);
          this.hashes.set(file, hashText(text));
          this.ingested.add(file);
          this.changeEmitter.fire();
        }, 400),
      );
    });
    return new vscode.Disposable(() => {
      const t = this.saveTimers.get(file);
      if (t) {
        clearTimeout(t);
        this.saveTimers.delete(file);
      }
      sub.dispose();
    });
  }

  /**
   * Put a file back to what is on disk, ignoring any editor buffer for it.
   * Used when a document is closed and its unsaved edits are discarded.
   */
  revertToDisk(file: string): void {
    if (!INCLUDE_EXT.test(file)) {
      return;
    }
    if (!this.explicitFiles.has(file) && isExcluded(file, this.configValue)) {
      // Only indexed because it was open: closing it puts the workspace back
      // to what the exclude patterns asked for.
      if (this.ingested.has(file)) {
        this.remove(file);
      }
      return;
    }
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      // The file is gone; a watcher event will report the deletion.
      this.remove(file);
      return;
    }
    this.index.addFile(file, text);
    this.hashes.set(file, hashText(text));
    this.ingested.add(file);
    this.followIncludes(file);
    this.changeEmitter.fire();
  }

  /**
   * Re-parse every dirty HDL document so lookups match unsaved text.
   *
   * The hash of the last synced text is remembered per file: this runs on every
   * hover and every cursor movement, and re-parsing a file that has not changed
   * since the last sync is the most expensive thing in the extension's hot path.
   */
  syncOpenDocuments(): void {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== 'file' || !INCLUDE_EXT.test(doc.fileName) || !doc.isDirty) {
        continue;
      }
      const text = doc.getText();
      const hash = hashText(text);
      if (this.hashes.get(doc.fileName) === hash) {
        continue;
      }
      this.index.addFile(doc.fileName, text);
      this.hashes.set(doc.fileName, hash);
      this.ingested.add(doc.fileName);
    }
  }

  // ------------------------------------------------------------------ queries

  /**
   * Content hash as the index holds it, so consumers fingerprint the very
   * bytes the index was built from instead of re-reading the file. Falls back
   * to disk only for a file that was indexed without passing through this
   * service (added directly to the index, or dropped by a refresh).
   */
  indexedHash(file: string): string {
    const known = this.hashes.get(file);
    if (known !== undefined) {
      return known;
    }
    return hashText(this.textSync(file) ?? '');
  }

  /** Current text of a file: the editor buffer when open, else disk. */
  textSync(file: string): string | undefined {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.fileName === file);
    if (open) {
      return open.getText();
    }
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  }

  async text(file: string): Promise<string | undefined> {
    const uri = vscode.Uri.file(file);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) {
      return open.getText();
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(bytes).toString('utf8');
    } catch {
      return undefined;
    }
  }

  moduleAt(file: string, line: number): ModuleDef | undefined {
    return this.index.moduleAtLine(file, line);
  }

  tops(): vscode.QuickPickItem[] {
    return this.index
      .tops(this.configValue.topModules)
      .map((t) => ({
        label: t.name,
        description: `${t.reason === 'explicit' ? 'configured top' : 'never instantiated'}`,
        detail: `${t.def.kind} in ${vscode.workspace.asRelativePath(vscode.Uri.file(t.def.file))}`,
        def: t,
      }));
  }

  hierarchy(moduleName: string, fromFile?: string): HierarchyResult | undefined {
    return buildHierarchy(
      this.index,
      moduleName,
      {
        maxDepth: this.configValue.maxDepth,
        maxInstances: this.configValue.maxInstances,
      },
      fromFile,
    );
  }

  hierarchyFor(node: HierarchyNode): HierarchyResult | undefined {
    const def = this.index.resolveModule(node.moduleName, node.file);
    if (!def) {
      return undefined;
    }
    return buildHierarchy(
      this.index,
      node.moduleName,
      {
        maxDepth: this.configValue.maxDepth,
        maxInstances: this.configValue.maxInstances,
      },
      def.file,
    );
  }

  /**
   * Hierarchy for the Composition view. The tree has its own depth / node
   * budget (`hdl.connectView.composition.*`), independent of the global
   * `maxDepth` / `maxInstances`, and both default to no limit.
   */
  compositionHierarchy(moduleName: string, fromFile?: string): HierarchyResult | undefined {
    return buildHierarchy(
      this.index,
      moduleName,
      {
        maxDepth: this.configValue.compositionMaxDepth,
        maxInstances: this.configValue.compositionMaxInstances,
      },
      fromFile,
    );
  }

  /** Nearest design top for `moduleName` and the path down to it, no tree built. */
  containingPath(moduleName: string, fromFile?: string): { top: string; path: string } | undefined {
    return containingPath(this.index, moduleName, fromFile, this.configValue.topModules);
  }

  /** Design containing `moduleName`, bounded by the Composition limits. */
  containingDesign(moduleName: string, fromFile?: string): { root: HierarchyNode; node: HierarchyNode } | undefined {
    return containingDesignOf(
      this.index,
      moduleName,
      fromFile,
      this.configValue.topModules,
      {
        maxDepth: this.configValue.compositionMaxDepth,
        maxInstances: this.configValue.compositionMaxInstances,
      },
    );
  }

  graphFor(node: HierarchyNode, opts: GraphOptions = {}): Graph {
    return buildGraph(this.index, node, {
      maxNodes: opts.maxNodes ?? this.configValue.graphMaxNodes,
      showContainment: this.configValue.graphShowContainment,
      maxDepth: opts.maxDepth ?? 8,
      ancestors: opts.ancestors,
      collapsed: opts.collapsed,
      expanded: opts.expanded,
      maxSignalsPerScope: this.configValue.graphMaxSignalsPerGroup,
      signalLimits: opts.signalLimits,
      includeSignals: opts.includeSignals,
      childLimits: opts.childLimits,
      defaultChildLimit: this.configValue.defaultChildLimit,
    });
  }

  /** Node lookup that tolerates a root path that is itself a module name. */
  findNode(root: HierarchyNode, path: string): HierarchyNode | undefined {
    return findByPath(root, path) ?? (root.path === path ? root : undefined);
  }

  listSubtree(node: HierarchyNode): HierarchyNode[] {
    return subtree(node);
  }

  /** Short label for a file in status messages. */
  relFile(file: string): string {
    const rel = vscode.workspace.asRelativePath(vscode.Uri.file(file), false);
    return rel === file ? basename(file) : rel;
  }

  dispose(): void {
    this.stopWatchers();
    for (const t of this.saveTimers.values()) {
      clearTimeout(t);
    }
    this.saveTimers.clear();
    this.changeEmitter.dispose();
    this.stateEmitter.dispose();
  }
}

function isReadable(p: string): boolean {
  if (!INCLUDE_EXT.test(p)) {
    return false;
  }
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Whether `file` lives under directory `dir`. */
function isUnder(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
