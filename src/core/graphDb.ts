/**
 * Graph database (pure model).
 *
 * Precomputes each top's connectivity graph (`graph.json`) so the vocabulary of
 * a design's wiring is a first-class, reviewable file next to the others.
 *
 * The connectivity view itself is interactive - it re-requests the graph with a
 * different depth, a set of collapsed / expanded scopes and paged signals on
 * almost every click - so this database carries the *default* graph of every
 * top and is, like `index.json`, an artifact rather than the live data source.
 */

import type { HdlIndex } from './index';
import { buildGraph, type Graph, type GraphOptions } from './graph';
import { buildHierarchy, type HierarchyOptions } from './hierarchy';

/** One precomputed graph, with the options it was built under. */
export interface GraphDbEntry {
  options: GraphOptions;
  graph: Graph;
}

export const GRAPH_DB_VERSION = 1;

/** The on-disk database: top module name -> its default connectivity graph. */
export interface GraphDatabase {
  version: number;
  generatedAt: string;
  /** Fingerprint of the source files this was built from; empty means unknown. */
  source: string;
  filterHash?: string;
  /** Top modules that have a graph, sorted by name. */
  tops: string[];
  graphs: Record<string, GraphDbEntry>;
}

export interface GraphDbOptions {
  /** Limits used to build the hierarchy each graph walks. */
  hierarchy: HierarchyOptions;
  /** Options the graph itself is built with. */
  graph: GraphOptions;
}

/**
 * Build a graph for every top. A top whose hierarchy cannot be resolved (a name
 * that vanished between the index and here) is skipped rather than recorded
 * empty, so a reader can trust `tops` to name real graphs.
 */
export function buildGraphDatabase(
  index: HdlIndex,
  tops: string[],
  options: GraphDbOptions,
  generatedAt: string,
  source: string,
  filterModules: readonly string[] = [],
  filterHash = '',
): GraphDatabase {
  const graphs: Record<string, GraphDbEntry> = {};
  const kept: string[] = [];
  for (const top of [...tops].sort()) {
    const hierarchy = buildHierarchy(index, top, { ...options.hierarchy, filterModules });
    if (!hierarchy) {
      continue;
    }
    graphs[top] = { options: options.graph, graph: buildGraph(index, hierarchy.root, options.graph) };
    kept.push(top);
  }
  return {
    version: GRAPH_DB_VERSION,
    generatedAt,
    source,
    ...(filterHash ? { filterHash } : {}),
    tops: kept,
    graphs,
  };
}

/** Compact, stable serialisation. `graphs` is inserted key-sorted. */
export function serializeGraphDatabase(db: GraphDatabase): string {
  return JSON.stringify(db);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse a database written by an earlier run; `undefined` when unusable. */
export function parseGraphDatabase(text: string): GraphDatabase | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.version !== GRAPH_DB_VERSION) {
    return undefined;
  }
  if (!Array.isArray(value.tops) || !isRecord(value.graphs)) {
    return undefined;
  }
  for (const entry of Object.values(value.graphs)) {
    if (!isRecord(entry) || !isRecord(entry.graph)) {
      return undefined;
    }
  }
  return {
    version: GRAPH_DB_VERSION,
    generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : '',
    source: typeof value.source === 'string' ? value.source : '',
    ...(typeof value.filterHash === 'string' && value.filterHash
      ? { filterHash: value.filterHash }
      : {}),
    tops: value.tops as string[],
    graphs: value.graphs as Record<string, GraphDbEntry>,
  };
}

export interface GraphDbStats {
  tops: number;
  nodes: number;
  edges: number;
}

export function graphDbStats(db: GraphDatabase | undefined): GraphDbStats {
  const out: GraphDbStats = { tops: 0, nodes: 0, edges: 0 };
  if (!db) {
    return out;
  }
  out.tops = db.tops.length;
  for (const entry of Object.values(db.graphs)) {
    out.nodes += entry.graph.nodes.length;
    out.edges += entry.graph.edges.length;
  }
  return out;
}
