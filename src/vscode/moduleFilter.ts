import * as path from 'node:path';
import * as vscode from 'vscode';

import type { HdlIndex } from '../core/index';
import { hashText } from '../core/relations';

/**
 * Resolve configured module-filter entries to module names.
 *
 * An entry may be a module name, a file path (every module defined in that
 * file) or a directory (every module defined under it). Names win over paths,
 * matching the Composition filter's documented behaviour. Paths are relative
 * to every workspace folder, so one configuration covers a multi-root space.
 */
export function resolveModuleFilter(index: HdlIndex, entries: readonly string[]): string[] {
  if (entries.length === 0) {
    return [];
  }
  const known = new Set(index.moduleNames());
  const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
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
    for (const file of index.allFiles()) {
      if (!paths.some((p) => file === p || isUnder(file, p))) {
        continue;
      }
      for (const mod of index.modulesInFile(file)) {
        names.add(mod.name);
      }
    }
  }
  return [...names].sort();
}

/**
 * Stable key for a resolved filter, stored beside a database so a config
 * change makes the old file stale even when the sources did not move.
 */
export function moduleFilterKey(names: readonly string[]): string {
  return names.length === 0 ? '' : hashText([...names].sort().join('\n'));
}

function isUnder(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
