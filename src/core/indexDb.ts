/**
 * Index database (pure model).
 *
 * Persists the structural base the other classified databases derive from:
 * every module definition (kind, location, ports, params, declarations,
 * references) plus its instantiation edges, keyed by workspace-relative file.
 *
 * Per design (§5.6) this database is an **artifact**: it is written for
 * inspection and diffing and is never read back to skip parsing - activation
 * still builds the in-memory index from source. It exists so the vocabulary of
 * a design ("what modules, which files") is a first-class, reviewable file
 * alongside `hierarchy.json` / `relations.json` / `graph.json`.
 */

import type { HdlIndex } from './index';
import type { ModuleKind, PortDir, Range } from './ast';
import type { FileInput } from './relations';

/** One instantiation edge, as `index.json` records it. */
export interface IndexEdge {
  /** Instance name as written, including the generate prefix. */
  i: string;
  /** Instantiated module name. */
  m: string;
  /** Generate prefix, e.g. `g[0]`; empty when not generated. */
  g: string;
  /** Whole instantiation statement range. */
  r: Range;
  /** The child module resolved in the index. */
  ok: boolean;
}

/** One port of a module, with just the facts the index classifies it by. */
export interface IndexPort {
  name: string;
  direction: PortDir;
  /** Interface type name, when the port is an interface. */
  interface?: string;
}

/** Everything `index.json` records for one module definition. */
export interface IndexModule {
  kind: ModuleKind;
  nameRange: Range;
  ports: IndexPort[];
  /** Port name order as written in the header. */
  portOrder: string[];
  params: string[];
  decls: string[];
  /** Number of references (the list itself is too large to carry). */
  refs: number;
  includes: string[];
  instances: IndexEdge[];
}

/** The modules declared in one file, plus the hash they were computed at. */
export interface IndexFile {
  hash: string;
  modules: string[];
}

export const INDEX_DB_VERSION = 1;

/** The on-disk database: module name → definition, file → its modules. */
export interface IndexDatabase {
  version: number;
  generatedAt: string;
  /** Fingerprint of the source files this was built from; empty means unknown. */
  source: string;
  files: Record<string, IndexFile>;
  modules: Record<string, IndexModule>;
}

/**
 * Build the index database from the index and the file set already collected
 * for a refresh. Modules are keyed by name; a name defined twice (an RTL module
 * and a stub) keeps the first definition, matching `resolveModule`.
 */
export function buildIndexDatabase(
  index: HdlIndex,
  inputs: FileInput[],
  generatedAt: string,
  source: string,
): IndexDatabase {
  const files: Record<string, IndexFile> = {};
  const modules: Record<string, IndexModule> = {};
  for (const input of inputs) {
    const defs = index.modulesInFile(input.file).slice().sort((a, b) => a.name.localeCompare(b.name));
    files[input.rel] = { hash: input.hash, modules: defs.map((d) => d.name) };
    for (const def of defs) {
      if (modules[def.name]) {
        continue;
      }
      modules[def.name] = {
        kind: def.kind,
        nameRange: def.nameRange,
        ports: def.ports.map((p) => {
          const port: IndexPort = { name: p.name, direction: p.direction };
          if (p.interfaceName) {
            port.interface = p.interfaceName;
          }
          return port;
        }),
        portOrder: [...def.portOrder],
        params: def.params.map((p) => p.name),
        decls: def.decls.filter((d) => !d.implicit).map((d) => d.name),
        refs: def.refs.length,
        includes: [...def.includes],
        instances: def.instances.map((inst) => {
          const child = index.resolveModule(inst.moduleName, def.file);
          return {
            i: inst.genPrefix ? `${inst.genPrefix}.${inst.name}` : inst.name,
            m: inst.moduleName,
            g: inst.genPrefix ?? '',
            r: inst.range,
            ok: !!child,
          };
        }),
      };
    }
  }
  return { version: INDEX_DB_VERSION, generatedAt, source, files, modules };
}

/** Compact, stable serialisation. Both maps are inserted key-sorted. */
export function serializeIndexDatabase(db: IndexDatabase): string {
  return JSON.stringify(db);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse a database written by an earlier run; `undefined` when unusable. */
export function parseIndexDatabase(text: string): IndexDatabase | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.version !== INDEX_DB_VERSION) {
    return undefined;
  }
  if (!isRecord(value.files) || !isRecord(value.modules)) {
    return undefined;
  }
  return {
    version: INDEX_DB_VERSION,
    generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : '',
    source: typeof value.source === 'string' ? value.source : '',
    files: value.files as Record<string, IndexFile>,
    modules: value.modules as Record<string, IndexModule>,
  };
}

export interface IndexDbStats {
  files: number;
  modules: number;
  ports: number;
  instances: number;
}

export function indexDbStats(db: IndexDatabase | undefined): IndexDbStats {
  const out: IndexDbStats = { files: 0, modules: 0, ports: 0, instances: 0 };
  if (!db) {
    return out;
  }
  out.files = Object.keys(db.files).length;
  for (const mod of Object.values(db.modules)) {
    out.modules++;
    out.ports += mod.ports.length;
    out.instances += mod.instances.length;
  }
  return out;
}
