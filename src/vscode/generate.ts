import * as vscode from 'vscode';

import type { IndexService } from './indexService';
import { composeModule, flattenModule, stubModule, type GenerateResult } from '../core/generator';
import { subtree } from '../core/hierarchy';
import type { HierarchyNode } from '../core/ast';
import { selectionAt } from './providers';

export type GenerateMode = 'flatten' | 'compose' | 'stub' | 'auto';

const MODES: { id: GenerateMode; label: string; description: string }[] = [
  {
    id: 'auto',
    label: 'Auto',
    description: 'Flatten the instance, or fall back to a port-forwarding stub when it cannot be inlined',
  },
  { id: 'flatten', label: 'Flatten', description: 'Inline the instance contents into a new standalone module' },
  { id: 'compose', label: 'Compose', description: 'Keep the instances and rebuild the wiring around them' },
  { id: 'stub', label: 'Stub', description: 'Instantiate the instance and re-export its ports verbatim' },
];

/**
 * Wrapper generation entry point.
 *
 * The selection comes from the composition view, or from the instance under the
 * cursor. The result is always previewed first; writing to disk requires an
 * explicit "Save As..." confirmation.
 */
export async function runGenerateWrapper(
  svc: IndexService,
  treeSelection: HierarchyNode[],
  selectionRoot?: HierarchyNode,
): Promise<void> {
  await svc.ensureReady();
  const root = await resolveRoot(svc, treeSelection, selectionRoot);
  if (!root) {
    return;
  }
  const paths = await resolvePaths(svc, root, treeSelection);
  if (!paths.length) {
    return;
  }
  const mode = await vscode.window.showQuickPick(MODES, {
    title: paths.length > 1 ? `HDL: compose ${paths.length} instances` : `HDL: wrap ${paths[0]}`,
    placeHolder: 'How should the wrapper be generated?',
  });
  if (!mode) {
    return;
  }
  const result = generate(svc, root, paths, mode.id);
  if (!result.ok) {
    void vscode.window.showErrorMessage(`HDL: ${result.error}`);
    return;
  }
  await previewAndSave(svc, result, mode.id);
}

function generate(svc: IndexService, root: HierarchyNode, paths: string[], mode: GenerateMode): GenerateResult {
  const opts = { sourceModule: root.moduleName };
  switch (mode) {
    case 'flatten':
      return flattenModule(svc.index, root, paths[0], opts);
    case 'compose':
      return composeModule(svc.index, root, paths, opts);
    case 'stub':
      return stubModule(svc.index, root, paths[0], opts);
    case 'auto':
      return paths.length > 1
        ? composeModule(svc.index, root, paths, opts)
        : auto(svc, root, paths[0], opts);
  }
}

/** `generateWrapper` with the fallback message made explicit in the preview. */
function auto(
  svc: IndexService,
  root: HierarchyNode,
  path: string,
  opts: { sourceModule: string },
): GenerateResult {
  const flat = flattenModule(svc.index, root, path, opts);
  if (flat.ok) {
    return flat;
  }
  const stub = stubModule(svc.index, root, path, opts);
  if (stub.ok) {
    stub.warnings.unshift(`Flattened instead: ${flat.error}`);
    return stub;
  }
  return flat;
}

/**
 * The hierarchy the selection lives in. A node picked in the tree is expanded
 * from its own module, so the node itself becomes the root of the working
 * hierarchy; otherwise the top module under the cursor is used.
 */
async function resolveRoot(
  svc: IndexService,
  selection: HierarchyNode[],
  selectionRoot?: HierarchyNode,
): Promise<HierarchyNode | undefined> {
  const paths = selection.map((n) => n.path);
  if (paths.length) {
    // The hierarchy the picks came from is the right scope by construction, but
    // the paths have to be reachable inside it (a stale tree, say).
    if (selectionRoot && paths.every((p) => svc.findNode(selectionRoot, p))) {
      return selectionRoot;
    }
    // Otherwise re-expand from a design top that contains every selected path,
    // so instances from different branches can still be composed in one scope.
    for (const top of svc.index.tops(svc.config.topModules)) {
      const h = svc.hierarchy(top.name, top.def.file);
      if (h && paths.every((p) => svc.findNode(h.root, p))) {
        return h.root;
      }
    }
  }

  if (paths.length) {
    // There was a selection, but no hierarchy holds it. Falling through to the
    // editor or to a design top would generate a wrapper around something the
    // user never picked, so say so instead.
    void vscode.window.showErrorMessage(
      `HDL: the selected instance(s) are no longer part of an expanded hierarchy (${paths.join(', ')}). Refresh the index and try again.`,
    );
    return undefined;
  }

  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const sel = selectionAt(svc, editor.document, editor.selection.active);
    if (sel) {
      return svc.hierarchy(sel.mod.name, sel.file)?.root;
    }
  }

  const tops = svc.tops();
  if (!tops.length) {
    void vscode.window.showInformationMessage('HDL: no modules found in this workspace.');
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(tops, {
    title: 'HDL: choose the top module of the hierarchy',
    placeHolder: 'Top module',
  });
  if (!pick) {
    return undefined;
  }
  return svc.hierarchy(pick.label, topsItemFile(pick))?.root;
}

function topsItemFile(item: vscode.QuickPickItem): string | undefined {
  const def = (item as vscode.QuickPickItem & { def?: { def: { file: string } } }).def;
  return def?.def.file;
}

async function resolvePaths(
  svc: IndexService,
  root: HierarchyNode,
  selection: HierarchyNode[],
): Promise<string[]> {
  if (selection.length) {
    return selection.map((n) => n.path);
  }
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const sel = selectionAt(svc, editor.document, editor.selection.active);
    if (sel?.instancePath) {
      return [sel.instancePath];
    }
    if (sel) {
      const all = subtree(root).filter((n) => n.depth > root.depth);
      if (all.length === 1) {
        return [all[0].path];
      }
    }
  }
  const items = subtree(root)
    .filter((n) => n.depth > root.depth)
    .map((n) => ({
      label: n.path,
      description: n.unresolved ? `${n.moduleName} (not found)` : n.moduleName,
      detail: n.file ? svc.relFile(n.file) : '',
    }));
  if (!items.length) {
    void vscode.window.showInformationMessage('HDL: the hierarchy has no instances to wrap.');
    return [];
  }
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'HDL: select the instances to wrap',
    placeHolder: 'One instance to flatten, several to compose',
  });
  return picked ? picked.map((p) => p.label) : [];
}

// ---------------------------------------------------------------------------
// Preview + save
// ---------------------------------------------------------------------------

async function previewAndSave(
  svc: IndexService,
  result: Extract<GenerateResult, { ok: true }>,
  mode: GenerateMode,
): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: 'HDL: name of the generated module',
    value: result.moduleName,
    validateInput: (v) =>
      /^[A-Za-z_][A-Za-z0-9_$]*$/.test(v) ? undefined : 'Not a valid Verilog identifier.',
  });
  if (!name) {
    return;
  }
  const code = name === result.moduleName ? result.code : renameModule(result.code, result.moduleName, name);
  const renamed = name === result.moduleName ? result : { ...result, moduleName: name, fileName: `${name}.v` };

  const doc = await vscode.workspace.openTextDocument({ language: 'verilog', content: code });
  // A preview tab, so the next generation replaces it instead of piling up
  // untitled buffers behind the user's real files.
  await vscode.window.showTextDocument(doc, { preview: true });
  void vscode.window.setStatusBarMessage(
    `HDL: ${mode} -> ${name} · ${renamed.ports.length} port(s) · ${renamed.instances} instance(s)` +
      ` · ${renamed.internalNets.length} internal net(s)`,
    6000,
  );

  const collides = svc.index.has(name);
  if (collides) {
    void vscode.window.showWarningMessage(`HDL: a module named "${name}" is already in the index.`);
  }
  for (const w of renamed.warnings) {
    void vscode.window.showWarningMessage(`HDL: ${w}`);
  }

  // The collision and the warning count go into the modal itself: a toast can be
  // missed, and this is the one prompt the user has to answer anyway.
  const notes: string[] = [];
  if (collides) {
    notes.push(`"${renamed.moduleName}" already exists in the workspace`);
  }
  if (renamed.warnings.length) {
    notes.push(`${renamed.warnings.length} warning(s), see the preview`);
  }
  const choice = await vscode.window.showInformationMessage(
    `Generate "${renamed.moduleName}"? ${renamed.ports.length} ports, ${renamed.instances} instance(s)` +
      (notes.length ? ` - ${notes.join('; ')}` : ''),
    { modal: true },
    'Save As...',
    'Copy',
    'Discard',
  );
  if (choice === 'Save As...') {
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultTarget(renamed.fileName)),
      filters: { 'Verilog source': ['v', 'sv'] },
      saveLabel: 'Save wrapper',
    });
    if (!target) {
      return;
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(code, 'utf8'));
    await svc.upsertPublic(target.fsPath);
    void vscode.window.showInformationMessage(`HDL: wrote ${svc.relFile(target.fsPath)}`);
  } else if (choice === 'Copy') {
    await vscode.env.clipboard.writeText(code);
    void vscode.window.showInformationMessage(`HDL: ${renamed.moduleName} copied to the clipboard.`);
  } else {
    // Discarding means discarding: close the untitled preview instead of leaving
    // an unsaved buffer the user has to clean up by hand. The close is guarded
    // so it can only ever touch this document, and only while it is still the
    // active tab.
    if (vscode.window.activeTextEditor?.document.uri.toString() === doc.uri.toString()) {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  }
}

function renameModule(code: string, from: string, to: string): string {
  return code.replace(new RegExp(`\\bmodule\\s+(${from})\\b`), `module ${to}`);
}

/** Where the save dialog opens: the first workspace folder, or the cwd. */
function defaultTarget(fileName: string): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? vscode.Uri.joinPath(folder.uri, fileName).fsPath : fileName;
}
