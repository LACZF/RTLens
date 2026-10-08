import * as vscode from 'vscode';

import { braceGlob, matchesGlob } from '../core/globs';

export { matchesGlob };

/** Typed view of the `hdl.connectView.*` settings. */
export interface HdlConfig {
  files: string[];
  includeDirs: string[];
  exclude: string[];
  topModules: string[];
  maxDepth: number;
  maxInstances: number;
  graphMaxNodes: number;
  graphShowContainment: boolean;
  followDefinition: boolean;
  semanticHighlighting: boolean;
}

export const SECTION = 'hdl.connectView';

function strArray(cfg: vscode.WorkspaceConfiguration, key: string, fallback: string[]): string[] {
  const v = cfg.get<unknown>(key);
  if (!Array.isArray(v)) {
    return fallback;
  }
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

export function readConfig(scope?: vscode.Uri): HdlConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION, scope ?? null);
  return {
    files: strArray(cfg, 'files', ['**/*.{v,sv,svh,vh,vlt}']),
    includeDirs: strArray(cfg, 'includeDirs', ['include', 'inc', '../include', '../inc']),
    exclude: strArray(cfg, 'exclude', ['**/tb/**', '**/testbench/**', '**/*_tb.v', '**/*_tb.sv']),
    topModules: strArray(cfg, 'topModules', []),
    maxDepth: cfg.get<number>('maxDepth') ?? 32,
    maxInstances: cfg.get<number>('maxInstances') ?? 20000,
    graphMaxNodes: cfg.get<number>('graph.maxNodes') ?? 800,
    graphShowContainment: cfg.get<boolean>('graph.showContainment') ?? false,
    followDefinition: cfg.get<boolean>('followDefinition') ?? true,
    semanticHighlighting: cfg.get<boolean>('enableSemanticHighlighting') ?? true,
  };
}

/**
 * Glob for the initial workspace scan.
 *
 * A plain string, not a `RelativePattern`: a relative pattern is matched
 * against its base, and a pattern without a real base - `**` is not a folder -
 * matches nothing at all, which would leave the index empty.
 */
export function scanGlob(cfg: HdlConfig): string {
  return braceGlob(cfg.files.length ? cfg.files : ['**/*.{v,sv,svh,vh,vlt}']);
}

export function isExcluded(file: string, cfg: HdlConfig): boolean {
  if (cfg.exclude.length === 0) {
    return false;
  }
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
  const normalized = file.replace(/\\/g, '/');
  const root = (folder?.uri.fsPath ?? '').replace(/\\/g, '/');
  const rel = root && normalized.startsWith(root) ? normalized.slice(root.length).replace(/^\/+/, '') : normalized;
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  return cfg.exclude.some((pat) => matchesGlob(rel, pat) || matchesGlob(base, pat));
}
