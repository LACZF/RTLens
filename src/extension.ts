import * as vscode from 'vscode';

import { IndexService } from './vscode/indexService';
import { SECTION } from './vscode/config';
import {
  HdlDefinitionProvider,
  HdlDocumentSymbolProvider,
  HdlHoverProvider,
  HdlReferenceProvider,
  HdlRenameProvider,
  range,
  selectionAt,
} from './vscode/providers';
import { HdlSemanticTokensProvider } from './vscode/semantic';
import {
  CompositionTreeProvider,
  ProblemsTreeProvider,
  type CompositionItem,
  type ProblemsItem,
} from './vscode/views';
import { NetsViewProvider } from './vscode/netsView';
import { CompositionViewProvider } from './vscode/compView';
import { GraphPanel } from './vscode/graphPanel';
import { runGenerateWrapper } from './vscode/generate';
import { DatabaseService, pickRefreshMode } from './vscode/database';
import type { HierarchyNode, Range } from './core/ast';
import { findByPath } from './core/hierarchy';
import { basename } from './core/index';
import { traceAt, type TraceDirection, type TraceStep } from './core/trace';
import { WordHighlighter } from './vscode/wordHighlight';

const LANGUAGES = ['verilog', 'systemverilog'];

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('RTLens');
  context.subscriptions.push(log);
  log.appendLine('RTLens activating');

  const svc = new IndexService(log);
  context.subscriptions.push(svc);

  // The signal/module relation database and its status-bar refresh button.
  const database = new DatabaseService(svc, log);
  const wordHighlighter = new WordHighlighter();
  context.subscriptions.push(database, wordHighlighter);

  // --- views -------------------------------------------------------------
  const compositionTree = new CompositionTreeProvider(svc);
  const composition = new CompositionViewProvider(svc);
  const nets = new NetsViewProvider(svc);
  const problems = new ProblemsTreeProvider(svc);

  const problemsView = vscode.window.createTreeView('hdl.problems', { treeDataProvider: problems });
  context.subscriptions.push(
    problemsView,
    vscode.window.registerWebviewViewProvider('hdl.composition', composition, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider('hdl.nets', nets, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Nodes selected in the composition (webview view) - kept empty for generate wrapper usage.
  let selected: HierarchyNode[] = [];


  // --- language features -------------------------------------------------
  const selector: vscode.DocumentSelector = LANGUAGES.map((language) => ({ language, scheme: 'file' }));
  const legend = HdlSemanticTokensProvider.legend;
  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider(selector, new HdlSemanticTokensProvider(svc), legend),
    vscode.languages.registerDefinitionProvider(selector, new HdlDefinitionProvider(svc)),
    vscode.languages.registerHoverProvider(selector, new HdlHoverProvider(svc)),
    vscode.languages.registerReferenceProvider(selector, new HdlReferenceProvider(svc)),
    vscode.languages.registerRenameProvider(selector, new HdlRenameProvider(svc)),
    vscode.languages.registerDocumentSymbolProvider(selector, new HdlDocumentSymbolProvider(svc)),
  );

  // --- editor tracking ---------------------------------------------------
  const syncEditor = (editor: vscode.TextEditor | undefined) => {
    if (!editor || !LANGUAGES.includes(editor.document.languageId)) {
      nets.setContext(undefined, undefined);
      // Without a configured top this is a no-op; with one it still roots the
      // composition tree even when the active editor is not HDL.
      composition.setContext(undefined, undefined);
      return;
    }
    // The nets view resolves the module around the line itself, so it does not
    // need the cursor to be on an instance.
    nets.setContext(editor.document.fileName, editor.selection.active.line);
    // The composition tree follows the active module unless a top is configured.
    composition.setContext(editor.document.fileName, editor.selection.active.line);
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(syncEditor),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor === vscode.window.activeTextEditor) {
        syncEditor(e.textEditor);
      }
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => context.subscriptions.push(svc.watchDocument(doc))),
    // Closing a document discards its unsaved edits; the index still holds the
    // buffer text, so the file has to be re-read from disk.
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme === 'file') {
        svc.revertToDisk(doc.fileName);
      }
    }),
  );

  // --- index lifecycle ---------------------------------------------------
  void svc.ensureReady().then(() => {
    syncEditor(vscode.window.activeTextEditor);
    database.load();
    const stats = svc.stats;
    log.appendLine(
      `indexed ${stats.modules} module(s) in ${stats.files} file(s) in ${stats.parseMs} ms` +
        (stats.unresolved ? `, ${stats.unresolved} unresolved instance(s)` : ''),
    );
    // Missing modules are reported by the Problems view, which refreshes on the
    // same event - a toast on every activation only repeated (and disagreed
    // with) what the tree already shows.
  });

  // --- commands ----------------------------------------------------------
  // Commands receive their arguments from the manifest, so the handlers take
  // `any` and narrow themselves.
  const reg = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('hdl.connectView.refreshIndex', async () => {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'HDL: reindexing workspace' },
      () => svc.refresh(),
    );
    composition.refresh();
    problems.refresh();
    syncEditor(vscode.window.activeTextEditor);
  });

  reg('hdl.connectView.refreshDatabase', async () => {
    const mode = await pickRefreshMode();
    if (!mode) {
      return;
    }
    const summary = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `HDL: ${mode} database refresh` },
      () => database.refresh(mode),
    );
    void vscode.window.setStatusBarMessage(
      `HDL: ${mode} database refresh · ${summary.changed} recomputed, ${summary.reused} reused, ${summary.removed} removed`,
      4000,
    );
  });

  reg('hdl.connectView.showGraph', async (item?: CompositionItem) => {
    const node = item ? item.node : await pickRoot(svc);
    if (node) {
      GraphPanel.show(
        svc,
        context.extensionUri,
        node,
        node.path,
        item ? composition.hierarchyRoot ?? node : node,
      );
    }
  });

  reg('hdl.connectView.showGraphForSelection', async () => {
    const sel = editorSelection(svc);
    const node = sel ? sel.node : await pickRoot(svc);
    if (node) {
      GraphPanel.show(svc, context.extensionUri, node, node.path, sel ? sel.root : node);
    }
  });

  reg('hdl.connectView.setGraphRoot', async (item: CompositionItem) => {
    // Focus the existing graph panel on this subtree, or open one.
    GraphPanel.show(
      svc,
      context.extensionUri,
      item.node,
      composition.root ?? item.node.path,
      composition.hierarchyRoot ?? item.node,
    );
  });

  reg('hdl.connectView.generateWrapper', async (item?: CompositionItem) => {
    const selection = item ? [item.node] : selected;
    await runGenerateWrapper(svc, selection.length ? selection : editorNodes(svc), composition.hierarchyRoot);
  });

  reg('hdl.connectView.revealInComposition', async (uri?: vscode.Uri) => {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target) {
      return;
    }
    const item = expandTo(target.fsPath, svc, compositionTree);
    if (item) {
      // Webview view cannot be revealed via TreeView.reveal; re-root it at the
      // module and scroll to the row.
      composition.setRoot(compositionTree.hierarchyRoot, compositionTree.root);
      composition.reveal(item.node.path);
    }
  });

  reg('hdl.connectView.copyInstancePath', async (item?: CompositionItem) => {
    const node = item?.node ?? editorNode(svc);
    if (!node) {
      return;
    }
    await vscode.env.clipboard.writeText(node.path);
    void vscode.window.setStatusBarMessage(`HDL: copied ${node.path}`, 3000);
  });

  // Hierarchy tracing: up walks a signal to its declaration and a port to the
  // parent instance that drives it; down walks a signal to the child instances
  // connected to it and then into their port. One hop per press, then jump. The
  // hop logic is pure (`core/trace`); this is only the editor glue, so the
  // command stays a shortcut and not a panel.
  const trace = async (direction: TraceDirection) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !LANGUAGES.includes(editor.document.languageId)) {
      return;
    }
    await svc.ensureReady();
    svc.syncOpenDocuments();
    const pos = editor.selection.active;
    const res = traceAt(
      svc.index,
      editor.document.fileName,
      editor.document.getText(),
      pos.line,
      pos.character,
      direction,
    );
    if (!res) {
      void vscode.window.showInformationMessage('HDL: put the cursor on a signal, port, module, or instance to trace it.');
      return;
    }
    if (!res.targets.length) {
      const what = direction === 'up' ? `nothing above ${res.name}` : `nothing below ${res.name}`;
      void vscode.window.showInformationMessage(`HDL: ${what}.`);
      return;
    }
    const target = await pickTraceTarget(res.name, direction, res.targets);
    if (target) {
      await revealLocation(target.file, target.range);
    }
  };
  reg('hdl.connectView.traceUp', () => trace('up'));
  reg('hdl.connectView.traceDown', () => trace('down'));

  reg('hdl.connectView.toggleWordHighlight', () => {
    if (!svc.config.wordHighlight) {
      void vscode.commands.executeCommand('editor.action.marker.nextInFiles');
      return;
    }
    wordHighlighter.toggle();
  });

  // `revealInstance` is the click target of the composition rows and (via webview)
  // the nets rows. Both shapes are handled instead of assuming the node is there.
  reg(
    'hdl.connectView.revealInstance',
    async (item: CompositionItem | { file?: string; line?: number; node?: HierarchyNode }) => {
      if (!item?.file) {
        return;
      }
      const node = 'node' in item ? item.node : undefined;
      const target = node ? node.moduleNameRange ?? node.nameRange : undefined;
      const line = target?.start.line ?? ('line' in item ? item.line : 0) ?? 0;
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(item.file));
      const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: true });
      const position = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(
        target ? range(target) : new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenter,
      );
    },
  );

  // Problems rows open the offending name.
  reg('hdl.connectView.openProblem', async (item: ProblemsItem) => {
    if (!item?.file) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(item.file));
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    const position = new vscode.Position(item.line, item.character);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  });

  reg('hdl.connectView.showLog', () => log.show(true));

  // `IndexService` does not watch the configuration itself: rescanning from two
  // places at once would index the workspace twice per change. This is the only
  // path, and it re-indexes, refreshes the views and shows progress.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) {
        void vscode.commands.executeCommand('hdl.connectView.refreshIndex');
      }
    }),
    { dispose: () => GraphPanel.disposeAll() },
  );
}

export function deactivate(): void {
  GraphPanel.disposeAll();
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Ask for a top module and expand it. */
async function pickRoot(svc: IndexService): Promise<HierarchyNode | undefined> {
  await svc.ensureReady();
  const tops = svc.tops();
  if (!tops.length) {
    void vscode.window.showInformationMessage('HDL: no modules found in this workspace.');
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(tops, {
    title: 'HDL: choose the top module',
    placeHolder: 'Top module',
  });
  if (!pick) {
    return undefined;
  }
  const def = (pick as vscode.QuickPickItem & { def?: { def: { file: string } } }).def;
  return svc.hierarchy(pick.label, def?.def.file)?.root;
}

/** Hierarchy root containing the module under the cursor, plus the cursor instance. */
function editorNode(svc: IndexService): HierarchyNode | undefined {
  return editorSelection(svc)?.node;
}

/**
 * The cursor's instance (or the module under it) together with the hierarchy
 * root it was expanded from. The root lets the graph command walk up: a module
 * is shown with the instances that contain it, not just its own signals.
 */
function editorSelection(svc: IndexService): { node: HierarchyNode; root: HierarchyNode } | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }
  const sel = selectionAt(svc, editor.document, editor.selection.active);
  if (!sel) {
    return undefined;
  }
  const result = svc.hierarchy(sel.mod.name, sel.file);
  if (!result) {
    return undefined;
  }
  const node = sel.instancePath
    ? findByPath(result.root, sel.instancePath) ?? result.root
    : result.root;
  return { node, root: result.root };
}

/** Nodes to generate for: the one under the cursor, or the whole design. */
function editorNodes(svc: IndexService): HierarchyNode[] {
  const node = editorNode(svc);
  return node ? [node] : [];
}

/** Expand the composition view around the module that owns `file`. */
function expandTo(
  file: string,
  svc: IndexService,
  composition: CompositionTreeProvider,
): CompositionItem | undefined {
  const def = svc.index.allModules().find((m) => m.file === file);
  if (!def) {
    return;
  }
  const result = svc.compositionHierarchy(def.name, def.file);
  if (!result) {
    return;
  }
  composition.setRoot(result.root, def.name);
  return composition.modelFor(result.root.path);
}

/**
 * A single trace target jumps straight there; several are ranked by the core and
 * offered in a quick pick, so an ambiguous net does not silently pick one.
 */
async function pickTraceTarget(
  name: string,
  direction: TraceDirection,
  targets: TraceStep[],
): Promise<TraceStep | undefined> {
  if (targets.length === 1) {
    return targets[0];
  }
  const pick = await vscode.window.showQuickPick(
    targets.map((step) => ({
      label: step.label,
      description: step.detail,
      detail: `${basename(step.file)}:${step.range.start.line + 1}`,
      step,
    })),
    {
      title: `HDL: ${direction === 'up' ? 'up from' : 'down from'} ${name}`,
      placeHolder: 'Choose where to trace',
    },
  );
  return pick?.step;
}

/** Open `file` with the cursor on `target` and the range in view. */
async function revealLocation(file: string, target: Range): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: true });
  const position = new vscode.Position(target.start.line, target.start.character);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(range(target), vscode.TextEditorRevealType.InCenter);
}
