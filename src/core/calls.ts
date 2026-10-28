/**
 * Function / task call graph.
 *
 * The parser stores call sites on the module and on the enclosing subroutine;
 * this module turns that IR into the two directions the editor needs: who calls
 * a subroutine (up) and what a subroutine calls (down). Resolution is relative
 * to the module that holds the call, with package imports and `pkg::name`
 * qualifiers, so a package function is reachable from every module that
 * imports it.
 */

import type { CallSite, FunctionDecl, ModuleDef, Range } from './ast';
import type { HdlIndex } from './index';
import { resolveAt } from './resolve';

export interface FunctionRef {
  mod: ModuleDef;
  fn: FunctionDecl;
}

export interface CallHit {
  /** Module whose text holds the call. */
  mod: ModuleDef;
  site: CallSite;
  /** Subroutine that holds the call; absent at module scope. */
  owner?: FunctionDecl;
  target: FunctionRef;
}

export interface FunctionPosition extends FunctionRef {
  /** Set when the cursor is on a call rather than on a definition. */
  site?: CallSite;
  owner?: FunctionDecl;
  onDefinition: boolean;
}

export function findFunction(
  index: HdlIndex,
  mod: ModuleDef,
  name: string,
): FunctionRef | undefined {
  return findFunctionIn(index, mod, name, new Set());
}

function findFunctionIn(
  index: HdlIndex,
  mod: ModuleDef,
  name: string,
  seen: Set<ModuleDef>,
): FunctionRef | undefined {
  const local = mod.funcs.find((f) => f.name === name);
  if (local) {
    return { mod, fn: local };
  }
  if (mod.superClass) {
    const base = index.resolveModule(mod.superClass, mod.file);
    if (base && !seen.has(base)) {
      seen.add(base);
      const hit = findFunctionIn(index, base, name, seen);
      if (hit) {
        return hit;
      }
    }
  }
  for (const imp of mod.imports) {
    if (!imp.wildcard && !imp.names.some((n) => n.name === name)) {
      continue;
    }
    const pkg = index.resolveModule(imp.pkg, mod.file);
    if (!pkg || seen.has(pkg)) {
      continue;
    }
    seen.add(pkg);
    const hit = findFunctionIn(index, pkg, name, seen);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

export function resolveCall(
  index: HdlIndex,
  mod: ModuleDef,
  site: CallSite,
): FunctionRef | undefined {
  if (site.fullPath.startsWith('super.')) {
    const base = mod.superClass ? index.resolveModule(mod.superClass, mod.file) : undefined;
    return findFunctionIn(index, base ?? mod, site.name, new Set());
  }
  if (site.fullPath.includes('::')) {
    return resolveQualifiedCall(index, mod, site.fullPath);
  }
  return findFunction(index, mod, site.name);
}

function resolveQualifiedCall(
  index: HdlIndex,
  mod: ModuleDef,
  fullPath: string,
): FunctionRef | undefined {
  const parts = splitQualifiedPath(fullPath);
  if (parts.length < 2) {
    return undefined;
  }
  let scope: ModuleDef | undefined;
  for (let i = 0; i < parts.length - 1; i++) {
    const name = qualifierName(parts[i]);
    if (!name) {
      return undefined;
    }
    scope = index.resolveModule(name, scope?.file ?? mod.file);
    if (!scope) {
      return undefined;
    }
  }
  const leaf = qualifierName(parts[parts.length - 1]);
  return leaf && scope ? findFunctionIn(index, scope, leaf, new Set([scope])) : undefined;
}

/** Split `pkg::Class#(T)::f` at `::` only outside a parameter list. */
function splitQualifiedPath(path: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < path.length; i++) {
    const ch = path[i];
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
    } else if (ch === ':' && path[i + 1] === ':' && depth === 0) {
      out.push(path.slice(start, i));
      i++;
      start = i + 1;
    }
  }
  out.push(path.slice(start));
  return out;
}

function qualifierName(segment: string): string {
  const at = segment.indexOf('#');
  return at < 0 ? segment : segment.slice(0, at);
}

export function ownerOfCall(
  mod: ModuleDef,
  site: CallSite,
): { mod: ModuleDef; fn?: FunctionDecl } {
  const fn = site.ownerRange
    ? mod.funcs.find((f) => sameRange(f.range, site.ownerRange!))
    : site.owner
      ? mod.funcs.find((f) => f.name === site.owner)
      : undefined;
  return { mod, fn };
}

export function callSiteAt(
  mod: ModuleDef,
  line: number,
  character: number,
): CallSite | undefined {
  for (const site of mod.calls ?? []) {
    if (pointIn(site.range, line, character)) {
      return site;
    }
  }
  return undefined;
}

/**
 * The subroutine under the cursor: a definition name or a call site. A call
 * whose target cannot be resolved is not a position, because there is nothing
 * to prepare a call hierarchy for.
 */
export function functionPositionAt(
  index: HdlIndex,
  file: string,
  source: string,
  line: number,
  character: number,
): FunctionPosition | undefined {
  let mod = index.moduleAtLine(file, line);
  if (!mod) {
    for (const m of index.allModules()) {
      if (m.file === file && m.range.start.line <= line && m.range.end.line >= line) {
        mod = m;
        break;
      }
    }
  }
  if (!mod) {
    return undefined;
  }
  let site = callSiteAt(mod, line, character);
  if (!site) {
    for (const m of index.allModules()) {
      if (m.file !== file) continue;
      const s2 = callSiteAt(m, line, character);
      if (s2) { mod = m; site = s2; break; }
    }
  }
  if (site) {
    const target = resolveCall(index, mod, site);
    if (!target) {
      return undefined;
    }
    return { ...target, site, owner: ownerOfCall(mod, site).fn, onDefinition: false };
  }

  const hit = resolveAt(index, file, source, line, character);
  if (!hit?.resolution.ok || hit.resolution.decl.kind !== 'function') {
    return undefined;
  }
  const decl = hit.resolution.decl;
  if (!samePos(hit.word.nameRange, decl.nameRange)) {
    return undefined;
  }
  const owner = index.moduleAtLine(decl.file, decl.nameRange.start.line) ?? mod;
  const fn = owner.funcs.find((f) => samePos(f.nameRange, decl.nameRange));
  return fn ? { mod: owner, fn, onDefinition: true } : undefined;
}

export function callersOf(
  index: HdlIndex,
  targetMod: ModuleDef,
  targetFn: FunctionDecl,
): CallHit[] {
  const out: CallHit[] = [];
  const seen = new Set<string>();
  for (const mod of index.allModules()) {
    for (const site of mod.calls ?? []) {
      const target = resolveCall(index, mod, site);
      if (!target || !sameFunction(target, targetMod, targetFn)) {
        continue;
      }
      const key = `${mod.file}:${site.range.start.line}:${site.range.start.character}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push({ mod, site, owner: ownerOfCall(mod, site).fn, target: { mod: targetMod, fn: targetFn } });
    }
  }
  return out.sort(compareHits);
}

export function calleesOf(
  index: HdlIndex,
  mod: ModuleDef,
  fn: FunctionDecl,
): CallHit[] {
  const sites =
    fn.calls ??
    (mod.calls ?? []).filter((s) => s.ownerRange !== undefined && sameRange(s.ownerRange, fn.range));
  const out: CallHit[] = [];
  const seen = new Set<string>();
  for (const site of sites) {
    const target = resolveCall(index, mod, site);
    if (!target) {
      continue;
    }
    const key = `${mod.file}:${site.range.start.line}:${site.range.start.character}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ mod, site, owner: fn, target });
  }
  return out.sort(compareHits);
}

export function moduleCalls(index: HdlIndex, mod: ModuleDef): CallHit[] {
  const out: CallHit[] = [];
  const seen = new Set<string>();
  for (const site of mod.calls ?? []) {
    if (site.ownerRange) {
      continue;
    }
    const target = resolveCall(index, mod, site);
    if (!target) {
      continue;
    }
    const key = `${mod.file}:${site.range.start.line}:${site.range.start.character}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ mod, site, target });
  }
  return out.sort(compareHits);
}

function sameFunction(a: FunctionRef, mod: ModuleDef, fn: FunctionDecl): boolean {
  return a.mod.file === mod.file && sameRange(a.fn.nameRange, fn.nameRange);
}

function compareHits(a: CallHit, b: CallHit): number {
  return (
    a.mod.file.localeCompare(b.mod.file) ||
    a.site.range.start.line - b.site.range.start.line ||
    a.site.range.start.character - b.site.range.start.character ||
    a.site.name.localeCompare(b.site.name)
  );
}

function pointIn(range: Range, line: number, character: number): boolean {
  const afterStart = line > range.start.line || (line === range.start.line && character >= range.start.character);
  const beforeEnd = line < range.end.line || (line === range.end.line && character <= range.end.character);
  return afterStart && beforeEnd;
}

function samePos(a: Range, b: Range): boolean {
  return (
    a.start.line === b.start.line &&
    a.start.character === b.start.character &&
    a.end.line === b.end.line &&
    a.end.character === b.end.character
  );
}

function sameRange(a: Range, b: Range): boolean {
  return samePos(a, b);
}
