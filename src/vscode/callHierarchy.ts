import * as vscode from 'vscode';

import type { FunctionDecl, ModuleDef, Range as HdlRange } from '../core/ast';
import type { HdlIndex } from '../core/index';
import { basename } from '../core/index';
import {
  calleesOf,
  callersOf,
  functionPositionAt,
  moduleCalls,
  type CallHit,
  type FunctionRef,
} from '../core/calls';

export class HdlCallHierarchyProvider implements vscode.CallHierarchyProvider {
  constructor(private readonly getIndex: () => Promise<HdlIndex>) {}

  async prepareCallHierarchy(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): Promise<vscode.CallHierarchyItem[] | undefined> {
    const index = await this.getIndex();
    const found = functionPositionAt(
      index,
      document.fileName,
      document.getText(),
      position.line,
      position.character,
    );
    return found ? [functionItem(found.mod, found.fn)] : undefined;
  }

  async provideCallHierarchyIncomingCalls(
    item: vscode.CallHierarchyItem,
    _token: vscode.CancellationToken,
  ): Promise<vscode.CallHierarchyIncomingCall[]> {
    const index = await this.getIndex();
    const def = definitionFor(index, item);
    if (!def) {
      return [];
    }
    const groups = new Map<string, { item: vscode.CallHierarchyItem; ranges: vscode.Range[] }>();
    for (const hit of callersOf(index, def.mod, def.fn)) {
      const from = hit.owner ? functionItem(hit.mod, hit.owner) : moduleItem(hit.mod);
      addGroup(groups, from, hit);
    }
    return [...groups.values()].map(
      (group) => new vscode.CallHierarchyIncomingCall(group.item, group.ranges),
    );
  }

  async provideCallHierarchyOutgoingCalls(
    item: vscode.CallHierarchyItem,
    _token: vscode.CancellationToken,
  ): Promise<vscode.CallHierarchyOutgoingCall[]> {
    const index = await this.getIndex();
    const mod = moduleFor(index, item);
    if (!mod) {
      return [];
    }
    let hits: CallHit[];
    if (isModuleItem(item)) {
      hits = moduleCalls(index, mod);
    } else {
      const def = definitionFor(index, item);
      hits = def ? calleesOf(index, def.mod, def.fn) : [];
    }
    const groups = new Map<string, { item: vscode.CallHierarchyItem; ranges: vscode.Range[] }>();
    for (const hit of hits) {
      addGroup(groups, functionItem(hit.target.mod, hit.target.fn), hit);
    }
    return [...groups.values()].map(
      (group) => new vscode.CallHierarchyOutgoingCall(group.item, group.ranges),
    );
  }
}

function definitionFor(index: HdlIndex, item: vscode.CallHierarchyItem): FunctionRef | undefined {
  if (isModuleItem(item)) {
    return undefined;
  }
  const mod = moduleFor(index, item);
  const fn = mod?.funcs.find((f) => samePos(f.nameRange, item.selectionRange));
  return mod && fn ? { mod, fn } : undefined;
}

function moduleFor(index: HdlIndex, item: vscode.CallHierarchyItem): ModuleDef | undefined {
  return index.moduleAtLine(item.uri.fsPath, item.selectionRange.start.line);
}

function isModuleItem(item: vscode.CallHierarchyItem): boolean {
  return item.kind === vscode.SymbolKind.Module;
}

function functionItem(mod: ModuleDef, fn: FunctionDecl): vscode.CallHierarchyItem {
  return new vscode.CallHierarchyItem(
    fn.kind === 'task' ? vscode.SymbolKind.Method : vscode.SymbolKind.Function,
    fn.name,
    `${fn.kind} · ${mod.name}`,
    vscode.Uri.file(mod.file),
    toRange(fn.range),
    toRange(fn.nameRange),
  );
}

function moduleItem(mod: ModuleDef): vscode.CallHierarchyItem {
  return new vscode.CallHierarchyItem(
    vscode.SymbolKind.Module,
    mod.name,
    `${mod.kind} · ${basename(mod.file)}`,
    vscode.Uri.file(mod.file),
    toRange(mod.range),
    toRange(mod.nameRange),
  );
}

function addGroup(
  groups: Map<string, { item: vscode.CallHierarchyItem; ranges: vscode.Range[] }>,
  item: vscode.CallHierarchyItem,
  hit: CallHit,
): void {
  const key = `${item.uri.toString()}:${item.selectionRange.start.line}:${item.selectionRange.start.character}`;
  const range = toRange(hit.site.range);
  const group = groups.get(key);
  if (!group) {
    groups.set(key, { item, ranges: [range] });
    return;
  }
  if (!group.ranges.some((r) => sameVscodeRange(r, range))) {
    group.ranges.push(range);
  }
}

function toRange(r: HdlRange): vscode.Range {
  return new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
}

function samePos(a: HdlRange, b: vscode.Range): boolean {
  return (
    a.start.line === b.start.line &&
    a.start.character === b.start.character &&
    a.end.line === b.end.line &&
    a.end.character === b.end.character
  );
}

function sameVscodeRange(a: vscode.Range, b: vscode.Range): boolean {
  return (
    a.start.line === b.start.line &&
    a.start.character === b.start.character &&
    a.end.line === b.end.line &&
    a.end.character === b.end.character
  );
}
