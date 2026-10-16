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
  /** Composition-tree depth cap; 0 means no limit. */
  compositionMaxDepth: number;
  /** Composition-tree node budget; 0 means no limit. */
  compositionMaxInstances: number;
  /** Module names the Composition tree hides. */
  compositionFilterModules: string[];
  /** 1 = keep filtered instances but hide their submodules; 2 = hide them too. */
  compositionFilterMode: 1 | 2;
  /** Enable F8 word highlight (false lets F8 fall back to default). */
  wordHighlight: boolean;
  graphMaxNodes: number;
  graphShowContainment: boolean;
  graphMaxSignalsPerGroup: number;
  defaultChildLimit: number;
  followDefinition: boolean;
  semanticHighlighting: boolean;
  databasePaths: string[];
  databasePathsOnly: boolean;
  /** Keep the relation database in sync as indexed files change. */
  autoUpdateDatabase: boolean;
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
    compositionMaxDepth: cfg.get<number>('composition.maxDepth') ?? 0,
    compositionMaxInstances: cfg.get<number>('composition.maxInstances') ?? 0,
    compositionFilterModules: strArray(cfg, 'composition.filterModules', []),
    compositionFilterMode: cfg.get<number>('composition.filterMode') === 2 ? 2 : 1,
    wordHighlight: cfg.get<boolean>('wordHighlight') ?? true,
    graphMaxNodes: cfg.get<number>('graph.maxNodes') ?? 800,
    graphShowContainment: cfg.get<boolean>('graph.showContainment') ?? false,
    graphMaxSignalsPerGroup: cfg.get<number>('graph.maxSignalsPerGroup') ?? 40,
    defaultChildLimit: cfg.get<number>('defaultChildLimit') ?? 40,
    followDefinition: cfg.get<boolean>('followDefinition') ?? true,
    semanticHighlighting: cfg.get<boolean>('enableSemanticHighlighting') ?? true,
    databasePaths: strArray(cfg, 'databasePaths', []),
    databasePathsOnly: cfg.get<boolean>('databasePathsOnly') ?? false,
    autoUpdateDatabase: cfg.get<boolean>('autoUpdateDatabase') ?? true,
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
