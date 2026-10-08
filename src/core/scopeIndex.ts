/**
 * Name lookup for one module.
 *
 * Resolution used to scan `ports` / `params` / `decls` / ... linearly for every
 * name it was asked about, so a module with tens of thousands of signals
 * multiplied that scan by every identifier in the file. The maps here answer
 * the same questions in one lookup. They are built on first use and dropped
 * when the module's declaration arrays are rewritten (`invalidateScopeIndex`).
 *
 * Each map keeps the *first* declaration of a name, exactly like the linear
 * scan it replaces; the caller keeps the lookup order (ports, then params, then
 * decls, ...), which is what decides between two kinds that share a name.
 */

import type {
  FunctionDecl,
  InstanceSite,
  ModuleDef,
  ParamDecl,
  PortDecl,
  VarDecl,
} from './ast';

/** A module's name tables, plus the generate paths it declares things in. */
export interface ScopeIndex {
  /** Port name (or `declName`) -> port, first wins. */
  ports: Map<string, PortDecl>;
  /** Parameter name -> parameter, first wins. */
  params: Map<string, ParamDecl>;
  /** Declaration name -> declaration (signal, typedef, ...), first wins. */
  decls: Map<string, VarDecl>;
  /** Function/task name -> function, first wins. */
  funcs: Map<string, FunctionDecl>;
  /** Argument name -> the argument of the first function that declares it. */
  args: Map<string, PortDecl>;
  /** Instance name or `genPrefix.name` -> instance and its position. */
  instances: Map<string, { inst: InstanceSite; idx: number }>;
  /** `name\0generate` -> port declared in that generate block. */
  genPorts: Map<string, PortDecl>;
  genParams: Map<string, ParamDecl>;
  genVars: Map<string, VarDecl>;
  /** Distinct generate block paths, in first-seen order. */
  generates: string[];
}

/** The name of an instance inside its generate block: `g_par[2].u_alu`. */
export function withGenPrefix(i: { name: string; genPrefix?: string }): string {
  return i.genPrefix ? `${i.genPrefix}.${i.name}` : i.name;
}

export function generateKey(name: string, generate: string): string {
  return `${name}\u0000${generate}`;
}

function setIfAbsent<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (!map.has(key)) {
    map.set(key, value);
  }
}

const cache = new WeakMap<ModuleDef, ScopeIndex>();

/** Build (or reuse) the name tables of `mod`. */
export function scopeIndexOf(mod: ModuleDef): ScopeIndex {
  const cached = cache.get(mod);
  if (cached) {
    return cached;
  }
  const index: ScopeIndex = {
    ports: new Map(),
    params: new Map(),
    decls: new Map(),
    funcs: new Map(),
    args: new Map(),
    instances: new Map(),
    genPorts: new Map(),
    genParams: new Map(),
    genVars: new Map(),
    generates: [],
  };
  const generates = new Set<string>();
  const seeGenerate = (generate: string | undefined): void => {
    if (generate && !generates.has(generate)) {
      generates.add(generate);
      index.generates.push(generate);
    }
  };

  for (const p of mod.ports) {
    setIfAbsent(index.ports, p.name, p);
    setIfAbsent(index.ports, p.declName, p);
    if (p.generate) {
      setIfAbsent(index.genPorts, generateKey(p.name, p.generate), p);
      setIfAbsent(index.genPorts, generateKey(p.declName, p.generate), p);
      seeGenerate(p.generate);
    }
  }
  for (const p of mod.params) {
    setIfAbsent(index.params, p.name, p);
    if (p.generate) {
      setIfAbsent(index.genParams, generateKey(p.name, p.generate), p);
      seeGenerate(p.generate);
    }
  }
  for (const d of mod.decls) {
    setIfAbsent(index.decls, d.name, d);
    if (d.generate) {
      setIfAbsent(index.genVars, generateKey(d.name, d.generate), d);
      seeGenerate(d.generate);
    }
  }
  for (const f of mod.funcs) {
    setIfAbsent(index.funcs, f.name, f);
    for (const a of f.args) {
      setIfAbsent(index.args, a.name, a);
    }
  }
  mod.instances.forEach((inst, idx) => {
    setIfAbsent(index.instances, inst.name, { inst, idx });
    setIfAbsent(index.instances, withGenPrefix(inst), { inst, idx });
    seeGenerate(inst.genPrefix);
  });

  cache.set(mod, index);
  return index;
}

/**
 * Drop the tables after `mod`'s declaration arrays are rewritten.
 *
 * The only place that happens is `HdlIndex.lendHeaderDecls`; a path that starts
 * mutating `decls`/`ports`/... somewhere else has to call this too, or a stale
 * name would keep resolving.
 */
export function invalidateScopeIndex(mod: ModuleDef): void {
  cache.delete(mod);
}