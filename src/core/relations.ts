/**
 * Signal ↔ module relation database (pure model).
 *
 * The extension already computes, file by file, two things readers keep asking
 * for: which signals a module reads and drives (see `signalUsage`) and how an
 * instance wires its child's ports to the parent's signals (see `buildGraph`).
 * This module freezes both into a small, deterministic JSON model that can be
 * written under `.vscode/rtlens/` and diffed between refreshes.
 *
 * Nothing here touches `vscode`, `fs` or a clock: the caller supplies the file
 * list, their content hashes and the timestamp, which keeps the whole thing
 * unit-testable and lets `updateDatabase` be a plain function.
 */

import { signalUsage } from './nets';
import type { HdlIndex } from './index';
import type { ModuleDef, ModuleKind, PortDir } from './ast';

/** Which sources read / drive a signal, keyed by the bare name in the module. */
export interface SignalRelation {
  readers: string[];
  writers: string[];
}

/** One port connection of an instance: parent signal(s) → child port. */
export interface ModuleConnection {
  /** Instance name in the parent module. */
  instance: string;
  /** Child module name; empty when it could not be resolved. */
  child: string;
  /** Port on the child. */
  port: string;
  /** Child port direction, when the definition is known. */
  direction?: PortDir;
  /** Parent-side signal names (bare `fullPath`) wired to this port. */
  signals: string[];
  /** Set when the instance sits in a generate construct. */
  generated?: boolean;
}

/** Everything known about one module definition. */
export interface ModuleRelations {
  name: string;
  kind: ModuleKind;
  signals: Record<string, SignalRelation>;
  connections: ModuleConnection[];
}

/** The relations of every module declared in one file. */
export interface FileRelations {
  /** Content hash of the file when these relations were computed. */
  hash: string;
  modules: ModuleRelations[];
}

export const RELATION_DB_VERSION = 1;

/** The on-disk database: file (workspace-relative) → relations. */
export interface RelationDatabase {
  version: number;
  /** ISO timestamp of the last refresh. */
  generatedAt: string;
  files: Record<string, FileRelations>;
}

/** A file to include in a refresh, with the facts the merge needs. */
export interface FileInput {
  /** Absolute path. */
  file: string;
  /** Path relative to the owning workspace folder; the database key. */
  rel: string;
  /** Content hash, see {@link hashText}. */
  hash: string;
}

export interface DatabaseStats {
  files: number;
  modules: number;
  signals: number;
  connections: number;
}

/**
 * A cheap, dependency-free content hash (two independent 32-bit mixers plus the
 * length). It only has to answer "did this file change since the last refresh",
 * not resist an adversary, so `crypto` - and with it a Node builtin - stays out
 * of `core`.
 */
export function hashText(text: string): string {
  let a = 0x811c9dc5 >>> 0;
  let b = 0x9e3779b1 >>> 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b + c, 0x85ebca6b) >>> 0;
    b = (b ^ (b >>> 13)) >>> 0;
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}${text.length.toString(16)}`;
}

function compareConnection(x: ModuleConnection, y: ModuleConnection): number {
  return (
    x.instance.localeCompare(y.instance) ||
    x.port.localeCompare(y.port) ||
    x.child.localeCompare(y.child)
  );
}

/** The relations of one module definition. */
export function moduleRelations(index: HdlIndex, mod: ModuleDef): ModuleRelations {
  const usage = signalUsage(index, mod);
  const signals: Record<string, SignalRelation> = {};
  for (const name of [...usage.keys()].sort()) {
    const use = usage.get(name)!;
    signals[name] = { readers: [...use.readers], writers: [...use.writers] };
  }

  const connections: ModuleConnection[] = [];
  for (const inst of mod.instances) {
    const childDef = index.resolveModule(inst.moduleName, mod.file);
    for (const conn of inst.connections) {
      const port = childDef?.ports.find((p) => p.name === conn.portName);
      const signals = [...new Set(conn.refs.map((r) => r.fullPath))].sort();
      const entry: ModuleConnection = {
        instance: inst.name,
        child: inst.moduleName,
        port: conn.portName,
        signals,
      };
      if (port?.direction) {
        entry.direction = port.direction;
      }
      if (inst.inGenerate || inst.genPrefix) {
        entry.generated = true;
      }
      connections.push(entry);
    }
  }
  connections.sort(compareConnection);

  return { name: mod.name, kind: mod.kind, signals, connections };
}

/** The relations of every module of one file, in a stable order. */
export function fileRelations(index: HdlIndex, file: string, hash: string): FileRelations {
  const modules = index
    .modulesInFile(file)
    .map((m) => moduleRelations(index, m))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { hash, modules };
}

export function emptyDatabase(generatedAt: string): RelationDatabase {
  return { version: RELATION_DB_VERSION, generatedAt, files: {} };
}

export interface UpdateResult {
  db: RelationDatabase;
  /** Workspace-relative paths whose relations were recomputed. */
  changed: string[];
  /** Workspace-relative paths dropped because they are no longer indexed. */
  removed: string[];
  /** How many files were reused unchanged (incremental only). */
  reused: number;
}

/**
 * Build the next database from `existing` and the current file list.
 *
 * `full` recomputes every file and ignores `existing` entirely. `incremental`
 * keeps the stored relations of every file whose hash still matches, recomputes
 * the rest, drops files that vanished, and - because a parent's port-direction
 * labels come from the *child's* definition - also recomputes every file that
 * instantiates a module declared in a changed file.
 */
export function updateDatabase(
  index: HdlIndex,
  existing: RelationDatabase | undefined,
  inputs: FileInput[],
  mode: 'incremental' | 'full',
  generatedAt: string,
): UpdateResult {
  const reusable = mode === 'incremental' ? existing : undefined;
  const files: Record<string, FileRelations> = {};
  const seen = new Set<string>();
  const dirty = new Set<string>();
  const reuse = new Set<string>();

  if (reusable) {
    const changedModules = new Set<string>();
    for (const input of inputs) {
      const prev = reusable.files[input.rel];
      if (!prev || prev.hash !== input.hash) {
        dirty.add(input.rel);
        for (const mod of index.modulesInFile(input.file)) {
          changedModules.add(mod.name);
        }
      }
    }
    if (changedModules.size) {
      for (const input of inputs) {
        if (dirty.has(input.rel)) {
          continue;
        }
        const touches = index
          .modulesInFile(input.file)
          .some((m) => m.instances.some((inst) => changedModules.has(inst.moduleName)));
        if (touches) {
          dirty.add(input.rel);
        }
      }
    }
  } else {
    for (const input of inputs) {
      dirty.add(input.rel);
    }
  }

  for (const input of inputs) {
    seen.add(input.rel);
    const prev = reusable?.files[input.rel];
    if (prev && !dirty.has(input.rel) && prev.hash === input.hash) {
      files[input.rel] = prev;
      reuse.add(input.rel);
    } else {
      files[input.rel] = fileRelations(index, input.file, input.hash);
    }
  }

  const removed: string[] = [];
  if (existing) {
    for (const rel of Object.keys(existing.files)) {
      if (!seen.has(rel)) {
        removed.push(rel);
      }
    }
  }
  removed.sort();

  // Deterministic key order so an unchanged refresh rewrites the same bytes.
  const sorted: Record<string, FileRelations> = {};
  for (const rel of Object.keys(files).sort()) {
    sorted[rel] = files[rel];
  }

  const changed = [...dirty]
    .filter((rel) => seen.has(rel))
    .sort();
  return {
    db: { version: RELATION_DB_VERSION, generatedAt, files: sorted },
    changed,
    removed,
    reused: reuse.size,
  };
}

export function databaseStats(db: RelationDatabase | undefined): DatabaseStats {
  const stats: DatabaseStats = { files: 0, modules: 0, signals: 0, connections: 0 };
  if (!db) {
    return stats;
  }
  for (const entry of Object.values(db.files)) {
    stats.files++;
    for (const mod of entry.modules) {
      stats.modules++;
      stats.signals += Object.keys(mod.signals).length;
      stats.connections += mod.connections.length;
    }
  }
  return stats;
}

/** Compact, stable serialisation. `files` is already key-sorted. */
export function serializeDatabase(db: RelationDatabase): string {
  return JSON.stringify(db);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse a database written by an earlier run; `undefined` when unusable. */
export function parseDatabase(text: string): RelationDatabase | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.version !== RELATION_DB_VERSION || !isRecord(value.files)) {
    return undefined;
  }
  const files: Record<string, FileRelations> = {};
  for (const [rel, entry] of Object.entries(value.files)) {
    if (!isRecord(entry) || typeof entry.hash !== 'string' || !Array.isArray(entry.modules)) {
      return undefined;
    }
    files[rel] = entry as unknown as FileRelations;
  }
  return {
    version: RELATION_DB_VERSION,
    generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : '',
    files,
  };
}
