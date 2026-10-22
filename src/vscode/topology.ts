import * as path from 'node:path';
import * as vscode from 'vscode';

import type { ModuleDef, Range } from '../core/ast';
import { buildModuleTopology, buildTopologyTree, type ModuleTopology, type TopologyTree } from '../core/topology';
import {
  renderFrameSvg,
  renderFramesSvg,
  topologyFileNames,
  type Crumb,
  type FrameInput,
  type NavRef,
} from '../core/topologySvg';
import type { IndexService } from './indexService';
import { selectionAt } from './providers';
import { TopologyPanel } from './topologyPanel';

/** One SVG for the module at the cursor, or one per module occurrence below it. */
export type TopologyExportMode = 'module' | 'tree';

export interface TopologyTarget {
  def: ModuleDef;
  file: string;
}

/**
 * The module to draw: whatever the cursor is in, otherwise a top-level module
 * picked from the workspace. Right-clicking an instance still draws the module
 * that *contains* it, because the picture is about a module's own ports and
 * instances - the instance is one box inside it.
 */
async function resolveTarget(svc: IndexService): Promise<TopologyTarget | undefined> {
  await svc.ensureReady();
  const editor = vscode.window.activeTextEditor;
  const sel = editor ? selectionAt(svc, editor.document, editor.selection.active) : undefined;
  if (sel) {
    return { def: sel.mod, file: sel.file };
  }
  const tops = svc.tops();
  if (!tops.length) {
    void vscode.window.showInformationMessage('HDL: no modules found in this workspace.');
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(tops, {
    title: 'HDL: topology for which module?',
    placeHolder: 'Module to draw',
  });
  const def = (pick as (vscode.QuickPickItem & { def?: { def: ModuleDef } }) | undefined)?.def?.def;
  return def ? { def, file: def.file } : undefined;
}

// ---------------------------------------------------------------------------
// Navigation references
//
// A frame links in two flavours. Inside the panel, links carry a `key` and the
// host swaps the frame. In an exported file there is no host, so links become
// `vscode://file/<path>:<line>:<col>` - clicking one in a browser or in VS
// Code's preview opens the definition.
// ---------------------------------------------------------------------------

function sourceHref(file: string, line: number, character: number): string {
  const normalised = file.replace(/\\/g, '/');
  const absolute = normalised.startsWith('/') ? normalised : `/${normalised}`;
  return `vscode://file${encodeURI(absolute)}:${line + 1}:${character + 1}`;
}

function rangeHref(file: string, range: Range): string {
  return sourceHref(file, range.start.line, range.start.character);
}

function defHref(svc: IndexService, moduleName: string, fromFile: string, fallbackFile: string, fallback: Range): string {
  const def = svc.index.resolveModule(moduleName, fromFile);
  return def ? rangeHref(def.file, def.nameRange) : rangeHref(fallbackFile, fallback);
}

function crumbsFor(model: ModuleTopology): Crumb[] {
  return model.ancestors.map((a) => ({ label: a.moduleName, ref: { href: rangeHref(a.file, a.nameRange) } as NavRef }));
}

/** A single-frame file: every box links to a definition, nothing links sideways. */
function moduleInput(svc: IndexService, model: ModuleTopology): FrameInput {
  const children: Record<string, NavRef> = {};
  for (const child of model.children) {
    children[child.id] = {
      href: defHref(svc, child.moduleName, child.file, child.file, child.moduleNameRange),
    };
  }
  return {
    key: model.path,
    model,
    self: { href: rangeHref(model.file, model.nameRange) },
    top: model.ancestors.length ? { href: rangeHref(model.ancestors[0].file, model.ancestors[0].nameRange) } : undefined,
    crumbs: crumbsFor(model),
    children,
  };
}

/**
 * Frame inputs for a generated tree. Child links resolve to the child's own
 * file; a module cut off by `maxDepth` (or by a recursion guard) links to its
 * definition instead, so nothing in the picture is a dead end.
 */
function treeInputs(svc: IndexService, tree: TopologyTree): FrameInput[] {
  const names = topologyFileNames(tree.frames);
  const fileName = new Map(tree.frames.map((f, i) => [f.key, names[i]]));
  const frame = new Map(tree.frames.map((f) => [f.key, f]));
  const hrefOf = (key: string): string | undefined => {
    const name = fileName.get(key);
    return name ? name : undefined;
  };
  const refFor = (key: string): NavRef | undefined => {
    const href = hrefOf(key);
    return href ? { key, href } : undefined;
  };
  return tree.frames.map((f) => {
    const children: Record<string, NavRef> = {};
    for (const child of f.model.children) {
      const childKey = `${f.key}.${child.id}`;
      const linked = refFor(childKey);
      children[child.id] = linked ?? {
        href: defHref(svc, child.moduleName, child.file, child.file, child.moduleNameRange),
      };
    }
    const parent = f.parent ? frame.get(f.parent) : undefined;
    return {
      key: f.key,
      model: f.model,
      self: refFor(f.key) ?? { href: rangeHref(f.model.file, f.model.nameRange) },
      parent: parent ? refFor(parent.key) : undefined,
      top: f.model.ancestors.length ? refFor(f.model.ancestors[0].path) : undefined,
      crumbs: f.model.ancestors.map((a) => ({ label: a.moduleName, ref: refFor(a.path) ?? { href: rangeHref(a.file, a.nameRange) } })),
      children,
    };
  });
}

/**
 * The configured filter, resolved to module names.
 *
 * An entry may be a module name, a file path (every module defined in that
 * file) or a directory (every module defined under it) - the same shapes the
 * composition filter accepts, so one mental model covers both. The core works
 * with names only, so the paths are resolved here, once per configuration.
 */
let filterCache: { key: string; names: string[] } | undefined;

export function topologyFilter(svc: IndexService): string[] {
  const entries = svc.config.topologyFilterModules;
  if (entries.length === 0) {
    return [];
  }
  const key = `${entries.join('\u0000')}\u0001${svc.stats.files}`;
  if (filterCache?.key === key) {
    return filterCache.names;
  }
  const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  const known = new Set(svc.index.moduleNames());
  const names = new Set<string>();
  const paths: string[] = [];
  for (const entry of entries) {
    if (known.has(entry)) {
      names.add(entry);
      continue;
    }
    if (path.isAbsolute(entry)) {
      paths.push(path.resolve(entry));
    } else if (roots.length === 0) {
      paths.push(path.resolve(entry));
    } else {
      for (const root of roots) {
        paths.push(path.resolve(root, entry));
      }
    }
  }
  if (paths.length > 0) {
    for (const file of svc.index.allFiles()) {
      if (!paths.some((p) => file === p || isUnder(file, p))) {
        continue;
      }
      for (const mod of svc.index.modulesInFile(file)) {
        names.add(mod.name);
      }
    }
  }
  const resolved = [...names].sort();
  filterCache = { key, names: resolved };
  return resolved;
}

function isUnder(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export function topologyOptions(svc: IndexService): { filterModules: string[]; topModules: string[] } {
  return {
    filterModules: topologyFilter(svc),
    topModules: svc.config.topModules,
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Open the interactive topology panel for the module at the cursor. */
export async function showTopology(svc: IndexService, extensionUri: vscode.Uri): Promise<void> {
  const target = await resolveTarget(svc);
  if (!target) {
    return;
  }
  TopologyPanel.show(svc, extensionUri, target.def.name, target.def.file);
}

function defaultFolder(svc: IndexService, target: TopologyTarget): vscode.Uri {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && active.scheme === 'file') {
    return vscode.Uri.joinPath(active, '..');
  }
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (ws) {
    return ws;
  }
  const rel = svc.relFile(target.file);
  return vscode.Uri.file(path.dirname(path.isAbsolute(rel) ? rel : target.file));
}

/**
 * Write topology SVG(s) next to the workspace. `module` produces one
 * self-contained picture whose boxes link to definitions; `tree` produces one
 * file per module occurrence below the cursor, cross-linked by relative name so
 * the set can be copied into a wiki as-is.
 */
export async function generateTopologySvg(svc: IndexService, mode: TopologyExportMode): Promise<void> {
  const target = await resolveTarget(svc);
  if (!target) {
    return;
  }
  const cfg = svc.config;
  const opts = topologyOptions(svc);
  const renderOpts = { signalMode: cfg.topologySignalMode };

  if (mode === 'module') {
    const model = buildModuleTopology(svc.index, target.def, opts);
    const suggestion = vscode.Uri.joinPath(defaultFolder(svc, target), `${model.moduleName}-topology.svg`);
    const out = await vscode.window.showSaveDialog({
      title: `HDL: save topology of ${model.moduleName}`,
      defaultUri: suggestion,
      filters: { 'SVG image': ['svg'] },
      saveLabel: 'Save SVG',
    });
    if (!out) {
      return;
    }
    const frame = renderFrameSvg(moduleInput(svc, model), { ...renderOpts, fileName: path.basename(out.fsPath) });
    await vscode.workspace.fs.writeFile(out, Buffer.from(frame.svg, 'utf8'));
    await announce(out, 1, false);
    return;
  }

  const tree = buildTopologyTree(svc.index, target.def.name, target.def.file, {
    ...opts,
    maxDepth: cfg.topologyMaxDepth,
  });
  if (!tree) {
    void vscode.window.showErrorMessage(`HDL: could not build a hierarchy for ${target.def.name}.`);
    return;
  }
  const folder = await vscode.window.showOpenDialog({
    title: `HDL: save ${tree.frames.length} topology SVG(s) of ${tree.top}`,
    defaultUri: defaultFolder(svc, target),
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Save here',
  });
  if (!folder?.length) {
    return;
  }
  const svgs = renderFramesSvg(treeInputs(svc, tree), renderOpts);
  for (const svg of svgs) {
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder[0], svg.fileName), Buffer.from(svg.svg, 'utf8'));
  }
  await announce(folder[0], svgs.length, tree.truncated);
}

async function announce(uri: vscode.Uri, count: number, truncated: boolean): Promise<void> {
  const what = count === 1 ? path.basename(uri.fsPath) : `${count} SVG files`;
  const cut = truncated ? ' Topology is cut short by hdl.connectView.topology.maxDepth.' : '';
  const pick = await vscode.window.showInformationMessage(`HDL: wrote ${what}.${cut}`, 'Open');
  if (pick === 'Open') {
    await vscode.env.openExternal(uri);
  }
}
