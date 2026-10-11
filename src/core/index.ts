/**
 * Workspace index: the single source of truth for every language feature.
 *
 * Deliberately free of any `vscode` import so it can be unit tested and reused.
 * The index is rebuilt on activation; `addFile` / `removeFile` keep it in sync
 * as documents change.
 */

import { parseSource } from './parser';
import type { ModuleDef, ModuleKind, PortDecl, VarDecl, ParamDecl, FunctionDecl, FileScopeDecls, DataType, InstanceSite, MacroDef } from './ast';
import { MapScope, typeWidth } from './fold';
import { buildFileJumps, lookupInTable, type FileJumps, type JumpEntry } from './jump';
import { unresolvedInstances } from './problems';
import { invalidateScopeIndex, scopeIndexOf } from './scopeIndex';

/**
 * How many files keep their saved relations at once, and how many relations
 * they may hold together.
 *
 * A saved relation is small next to the parse tree it came from, but a large
 * design resolves names in a great many files and the maps would otherwise grow
 * with everything ever queried. Tables are kept least-recently-used-first and
 * the least recently used ones are dropped once either bound is reached; the
 * table being built is never dropped, so a single file bigger than the entry
 * budget still works - it is just the only one kept.
 */
export const MAX_JUMP_TABLES = 128;
export const MAX_JUMP_ENTRIES = 262144;

/** A saved table plus the index epochs it was built at. */
interface StoredJumps {
  table: FileJumps;
  /** `missEpoch` when built: a miss may resolve once a file is added. */
  missEpoch: number;
  /** `preferEpoch` when built: a name changed precedence. */
  preferEpoch: number;
}

export interface IndexStats {
  files: number;
  modules: number;
  unresolvedInstances: number;
  parseMs: number;
}

export interface TopCandidate {
  name: string;
  def: ModuleDef;
  /** Instantiation count across the workspace. */
  instantiatedBy: number;
  reason: 'never-instantiated' | 'explicit' | 'not-a-module';
}

export class HdlIndex {
  /** Module name -> definitions (more than one when a name is defined twice). */
  private byName = new Map<string, ModuleDef[]>();
  /** Absolute file path -> modules found in it. */
  private byFile = new Map<string, ModuleDef[]>();
  /** File paths currently indexed. */
  private files = new Set<string>();
  /**
   * Every file handed to `addFile`, headers included. `files` only holds files
   * that have a module in them - that is what `stats.files` counts - but an
   * `` `include `` has to be able to name a header, which has none.
   */
  private parsed = new Set<string>();
  /**
   * A file that declares something outside any module and holds no module
   * itself - a header. Its declarations have no module to live on, so they are
   * kept here and lent to the modules of the files that `` `include `` it.
   */
  private headerScope = new Map<string, FileScopeDecls>();
  /** File path -> the files it `` `include ``s, as written. */
  private fileIncludes = new Map<string, string[]>();
  /**
   * File path -> the `` `define `` macros declared there, by name. A macro is
   * textual, so a reference (`WIDTH) does not resolve like a symbol in a scope -
   * it lands on the definition that was seen.
   */
  private macrosByFile = new Map<string, Map<string, MacroDef>>();
  /**
   * Saved navigation relations per file: identifier occurrence -> declaration.
   * Insertion order is least-recently-used first, which is what the eviction
   * uses; `lookupJump` re-inserts a table on every hit to keep it fresh.
   */
  private jumpTables = new Map<string, StoredJumps>();
  /** Relations held across every table, the budget the eviction watches. */
  private jumpEntries = 0;
  /** Bumped when a file is (re)indexed, because a miss may now resolve. */
  private missEpoch = 0;
  /**
   * Bumped when a name changes the answer it will get: a duplicate module name
   * appeared, or an included header lent declarations into a module. Only then
   * can a *saved hit* take the user somewhere else, so hits survive every other
   * change and the tables do not have to be rebuilt while typing.
   */
  private preferEpoch = 0;
  /** Tables built so far - read by tests to see the cache at work. */
  private jumpBuilds = 0;

  stats: IndexStats = { files: 0, modules: 0, unresolvedInstances: 0, parseMs: 0 };

  /** Parse and register a file. Returns the modules found. */
  addFile(file: string, source: string): ModuleDef[] {
    this.removeFile(file);
    const res = parseSource(file, source);
    const mods = res.modules;
    this.parsed.add(file);
    if (res.includes.length > 0) {
      this.fileIncludes.set(file, res.includes);
    }
    if (res.macros.length > 0) {
      const byName = new Map<string, MacroDef>();
      // A redefinition wins: the compiler sees the last `define. The map is
      // rebuilt per file, so a renamed macro cannot leave a stale target.
      for (const m of res.macros) {
        byName.set(m.name, m);
      }
      this.macrosByFile.set(file, byName);
    } else {
      this.macrosByFile.delete(file);
    }
    if (mods.length === 0) {
      // No module to hang the types on, so this is a header: keep them for the
      // files that include it.
      if (res.fileScoped.decls.length > 0 || res.fileScoped.params.length > 0) {
        this.headerScope.set(file, res.fileScoped);
        // Files added before this header cannot have seen it, so they get
        // another chance now.
        for (const other of [...this.byFile.keys()]) {
          if (other !== file) {
            this.lendHeaderDecls(other);
          }
        }
      }
    }
    if (mods.length > 0) {
      // `moduleAtLine` binary-searches this list, so source order has to be the
      // invariant. The parser already emits modules in that order; sorting here
      // is what keeps the lookup honest if that ever changes.
      mods.sort((a, b) => a.range.start.line - b.range.start.line);
      this.byFile.set(file, mods);
      this.files.add(file);
      for (const m of mods) {
        const list = this.byName.get(m.name);
        if (list) {
          // Another file already defines this name, so which definition a bare
          // name resolves to can now change for saved relations too.
          list.push(m);
          this.preferEpoch++;
        } else {
          this.byName.set(m.name, [m]);
        }
      }
    }
    this.stats.files = this.files.size;
    this.stats.modules = this.countModules();
    this.stats.unresolvedInstances = this.countUnresolvedInstances();
    for (const m of mods) {
      this.classifyImportedRefs(m);
    }
    this.lendHeaderDecls(file);
    // A name that did not resolve before may resolve now, so saved misses are
    // stale even though saved hits are not.
    this.missEpoch++;
    return mods;
  }

  /**
   * Give every module of `file` the declarations of the headers it includes.
   *
   * A `typedef` in a header is visible to every module that includes that
   * header - and to nothing else, which is the rule the language gives and the
   * only one that keeps a shared `bus_t` from leaking into a module that never
   * saw the file. Inside the including module the declaration sits in `decls`
   * like a file-scope typedef of its own file does, so jumps, find-references,
   * hover, the netlist and the generator all pick it up without a second code
   * path. `d.file` stays the header, so a jump opens the header.
   */
  private lendHeaderDecls(file: string): void {
    const mods = this.byFile.get(file);
    if (!mods || mods.length === 0) {
      return;
    }
    const headers = this.includedHeaders(file);
    if (headers.length === 0) {
      return;
    }
    const decls: VarDecl[] = [];
    const params: ParamDecl[] = [];
    for (const h of headers) {
      const scope = this.headerScope.get(h);
      if (scope) {
        decls.push(...scope.decls);
        params.push(...scope.params);
      }
    }
    let lentChanged = false;
    for (const m of mods) {
      // The declarations the header lends are the borrowed ones; if the set of
      // borrowed names is the same before and after, re-adding an unchanged
      // include changed nothing and saved hits stay valid.
      const before = this.borrowedNames(m);
      // Drop the copies from a previous pass first, so adding the same file
      // twice cannot duplicate them, and so a header that stops declaring a
      // name stops lending it.
      m.decls = m.decls.filter((d) => d.file === undefined || d.file === m.file);
      m.params = m.params.filter((p) => p.file === undefined || p.file === m.file);
      const ownDecls = new Set(m.decls.map((d) => d.name));
      const ownParams = new Set(m.params.map((p) => p.name));
      for (const d of decls) {
        if (!ownDecls.has(d.name)) {
          m.decls.unshift(d);
          ownDecls.add(d.name);
        }
      }
      for (const p of params) {
        if (!ownParams.has(p.name)) {
          m.params.unshift(p);
          ownParams.add(p.name);
        }
      }
      // The name tables were built from `decls`/`params` as they were before
      // the header was lent, so they no longer describe this module.
      invalidateScopeIndex(m);
      const after = this.borrowedNames(m);
      if (before.size !== after.size || [...before].some((k) => !after.has(k))) {
        lentChanged = true;
      }
    }
    if (lentChanged) {
      // A borrowed name appeared or vanished: a saved hit may now mean the
      // imported declaration or the header's, so the tables have to be rebuilt
      // rather than only the misses retried.
      this.preferEpoch++;
    }
  }

  /** Names a module holds that its own file did not declare: its headers'. */
  private borrowedNames(mod: ModuleDef): Set<string> {
    const out = new Set<string>();
    for (const d of mod.decls) {
      if (d.file !== undefined && d.file !== mod.file) {
        out.add(`d:${d.name}`);
      }
    }
    for (const p of mod.params) {
      if (p.file !== undefined && p.file !== mod.file) {
        out.add(`p:${p.name}`);
      }
    }
    return out;
  }

  /**
   * The indexed files `file` reaches through `` `include ``, nearest first.
   * An include is written the way the compiler sees it, so an exact path is
   * tried first, then the same directory, then any file with that name; a
   * header that includes another header is followed, with a guard against a
   * cycle.
   */
  private includedHeaders(file: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>([file]);
    const queue = [...(this.fileIncludes.get(file) ?? [])];
    while (queue.length > 0) {
      const inc = queue.shift() as string;
      const hit = this.resolveIncludeFile(inc, file);
      if (!hit || seen.has(hit)) {
        continue;
      }
      seen.add(hit);
      out.push(hit);
      queue.push(...(this.fileIncludes.get(hit) ?? []));
    }
    return out;
  }

  private resolveIncludeFile(include: string, fromFile: string): string | undefined {
    if (this.parsed.has(include)) {
      return include;
    }
    const dir = dirname(fromFile);
    const sameDir = `${dir}/${include}`;
    if (this.parsed.has(sameDir)) {
      return sameDir;
    }
    const want = basename(include);
    for (const f of this.parsed) {
      if (basename(f) === want) {
        return f;
      }
    }
    return undefined;
  }

  /**
   * The parser can only read the packages in the file it is walking, so a name
   * imported from another file is still `unknown` by the time it finishes. The
   * index sees every file, so it settles those kinds here: a constant borrowed
   * from a package is a parameter wherever the package lives.
   */
  private classifyImportedRefs(mod: ModuleDef): void {
    if (mod.imports.length === 0) {
      return;
    }
    for (const r of mod.refs) {
      if (r.kind !== 'unknown') {
        continue;
      }
      const hit = this.findDecl(mod, r.name);
      if (!hit) {
        continue;
      }
      if (hit.kind === 'param') {
        r.kind = 'param';
      } else if (hit.kind === 'function') {
        r.kind = 'function';
      } else {
        r.kind = hit.kind === 'var' && hit.decl.kind === 'typedef' ? 'type' : 'signal';
      }
    }
  }

  removeFile(file: string): void {
    // Saved relations are dropped granularly: the file's own table, and every
    // table whose targets live in the file - their ranges just moved or went
    // away. A table that only points elsewhere stays valid, which is what keeps
    // one edited file from invalidating the whole workspace.
    this.dropJumpTable(file);
    for (const [other, stored] of this.jumpTables) {
      if (stored.table.targetFiles.has(file)) {
        this.dropJumpTable(other);
      }
    }
    // A header is in the index without holding a module, so the bookkeeping
    // below has to happen before the early return.
    const wasHeader = this.headerScope.delete(file);
    this.fileIncludes.delete(file);
    this.macrosByFile.delete(file);
    this.parsed.delete(file);
    const mods = this.byFile.get(file);
    if (!mods) {
      if (wasHeader) {
        for (const other of [...this.byFile.keys()]) {
          this.lendHeaderDecls(other);
        }
      }
      return;
    }
    for (const m of mods) {
      const list = this.byName.get(m.name);
      if (!list) {
        continue;
      }
      const kept = list.filter((x) => x.file !== file);
      if (kept.length) {
        this.byName.set(m.name, kept);
      } else {
        this.byName.delete(m.name);
      }
    }
    this.byFile.delete(file);
    this.files.delete(file);
    this.stats.files = this.files.size;
    this.stats.modules = this.countModules();
  }

  clear(): void {
    this.byName.clear();
    this.byFile.clear();
    this.files.clear();
    this.headerScope.clear();
    this.fileIncludes.clear();
    this.macrosByFile.clear();
    this.parsed.clear();
    this.jumpTables.clear();
    this.jumpEntries = 0;
    this.stats = { files: 0, modules: 0, unresolvedInstances: 0, parseMs: 0 };
  }

  /**
   * Where the identifier under the cursor lands, from the relations saved for
   * `file`.
   *
   * The table is built on the first query and kept until something invalidates
   * it: the file changed, a target inside it changed, or a name it resolved
   * appears somewhere new. A saved hit keeps pointing at a file that did not
   * change, so typing in one file does not force every other open file to be
   * rebuilt on its next jump. Everything after the build is a per-line lookup.
   */
  lookupJump(file: string, source: string, line: number, character: number): JumpEntry | undefined {
    if (!this.byFile.has(file)) {
      // No module of this file is in the index, so there is no scope to resolve
      // names against - a file the scan excluded, for instance.
      return undefined;
    }
    const stored = this.jumpTables.get(file);
    if (stored) {
      const entry = lookupInTable(stored.table, line, character);
      const missStale = stored.missEpoch !== this.missEpoch;
      const preferStale = stored.preferEpoch !== this.preferEpoch;
      if (!preferStale && (!missStale || (entry && entry.target))) {
        // Nothing a later file could change: a hit keeps its target (a changed
        // target file would have dropped the table), a miss with no file added
        // since is still a miss, and only a targetless instance or a miss has
        // to be retried after a file was added.
        this.touchJumpTable(file, stored);
        return entry;
      }
    }
    const table = buildFileJumps(this, file, source);
    this.jumpBuilds++;
    this.insertJumpTable(file, { table, missEpoch: this.missEpoch, preferEpoch: this.preferEpoch });
    return lookupInTable(table, line, character);
  }

  /** The freshly built table goes in as most-recently-used, evicting the rest. */
  private insertJumpTable(file: string, stored: StoredJumps): void {
    this.dropJumpTable(file);
    this.jumpTables.set(file, stored);
    this.jumpEntries += stored.table.count;
    while (
      (this.jumpEntries > MAX_JUMP_ENTRIES || this.jumpTables.size > MAX_JUMP_TABLES) &&
      this.jumpTables.size > 1
    ) {
      const lru = this.jumpTables.keys().next();
      if (lru.done) {
        break;
      }
      // The table just inserted is the last, so the first is never it while
      // more than one is held - a single table may exceed the budget.
      this.dropJumpTable(lru.value);
    }
  }

  /** A lookup that hit marks the table as recently used, so it is evicted last. */
  private touchJumpTable(file: string, stored: StoredJumps): void {
    this.jumpTables.delete(file);
    this.jumpTables.set(file, stored);
  }

  private dropJumpTable(file: string): void {
    const stored = this.jumpTables.get(file);
    if (stored) {
      this.jumpEntries -= stored.table.count;
      this.jumpTables.delete(file);
    }
  }

  /** Tables currently held, for the index log and the tests. */
  get jumpTableCount(): number {
    return this.jumpTables.size;
  }

  /** Relations currently held across all tables. */
  get jumpEntryCount(): number {
    return this.jumpEntries;
  }

  /** How many tables were built, which is the cache's own hit counter. */
  get jumpBuildCount(): number {
    return this.jumpBuilds;
  }

  get indexedFiles(): string[] {
    return [...this.files];
  }

  private countModules(): number {
    let n = 0;
    for (const list of this.byName.values()) {
      n += list.length;
    }
    return n;
  }

  private countUnresolvedInstances(): number {
    // The same rule the Problems view shows - gate primitives are built in and
    // several instances sharing one line are one missing module - so the count
    // in the log can never disagree with the rows the user reads.
    return unresolvedInstances(this).length;
  }

  /** All definitions of a module name. */
  allDefs(name: string): ModuleDef[] {
    return this.byName.get(name) ?? [];
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** All indexed module names. */
  moduleNames(): string[] {
    return [...this.byName.keys()];
  }

  /** Every indexed module definition. */
  allModules(): ModuleDef[] {
    const out: ModuleDef[] = [];
    for (const list of this.byName.values()) {
      out.push(...list);
    }
    return out;
  }

  /**
   * Every place `moduleName` is instantiated: the instantiating module's name
   * together with the instance, wherever it sits. The graph uses this to walk
   * upward from a module's own definition to the design root that contains it
   * (`containingDesign` in `hierarchy.ts`); plain top inference knows only the
   * reverse direction.
   */
  instantiatorsOf(moduleName: string): { parent: string; inst: InstanceSite }[] {
    const out: { parent: string; inst: InstanceSite }[] = [];
    for (const mods of this.byFile.values()) {
      for (const m of mods) {
        for (const inst of m.instances) {
          if (inst.moduleName === moduleName) {
            out.push({ parent: m.name, inst });
          }
        }
      }
    }
    return out;
  }

  /** Every indexed file path. */
  allFiles(): string[] {
    return [...this.files];
  }

  /** Modules declared in a file. */
  modulesInFile(file: string): ModuleDef[] {
    return this.byFile.get(file) ?? [];
  }

  /**
   * The module enclosing a 0-based line, or undefined when the line is outside
   * every module of the file. `addFile` keeps the list sorted by start line, so
   * the module that could contain the line is found by binary search instead of
   * by walking: the last one starting at or before the line. Modules cannot
   * nest, so that single candidate is the answer - a line in the gap between
   * two modules belongs to neither, and the walk stops there.
   */
  moduleAtLine(file: string, line0: number): ModuleDef | undefined {
    const mods = this.byFile.get(file);
    if (!mods || mods.length === 0) {
      return undefined;
    }
    let lo = 0;
    let hi = mods.length - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (mods[mid].range.start.line <= line0) {
        at = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (at < 0) {
      return undefined;
    }
    const candidate = mods[at];
    return candidate.range.end.line >= line0 ? candidate : undefined;
  }

  /**
   * Best definition of a module name. Prefers a definition in the same
   * directory as `fromFile` (RTL and its testbench are often both in scope and
   * a module may legitimately be defined twice, e.g. a black-box stub).
   */
  resolveModule(name: string, fromFile?: string): ModuleDef | undefined {
    const list = this.byName.get(name);
    if (!list || list.length === 0) {
      return undefined;
    }
    if (list.length === 1) {
      return list[0];
    }
    if (fromFile) {
      const dir = dirname(fromFile);
      const same = list.find((m) => dirname(m.file) === dir);
      if (same) {
        return same;
      }
    }
    return list[0];
  }

  /** Resolve an interface / modport definition. */
  resolveInterface(name: string): ModuleDef | undefined {
    const def = this.resolveModule(name);
    return def && (def.kind === 'interface' || def.kind === 'class') ? def : undefined;
  }

  /**
   * The `` `define `` a reference names. A macro is textual, so there is no
   * scope to search: a definition in the same file wins (a macro is usually
   * used right below its `define), then one in the same directory, then any.
   * The last `define of a file wins, matching what the compiler sees.
   */
  resolveMacro(name: string, fromFile?: string): MacroDef | undefined {
    let first: MacroDef | undefined;
    let sameDir: MacroDef | undefined;
    const from = fromFile ? dirname(fromFile) : undefined;
    for (const defs of this.macrosByFile.values()) {
      const def = defs.get(name);
      if (!def) {
        continue;
      }
      if (fromFile && def.file === fromFile) {
        return def;
      }
      if (!first) {
        first = def;
      }
      if (from !== undefined && dirname(def.file) === from) {
        sameDir = def;
      }
    }
    return sameDir ?? first;
  }

  /** Find a signal / port / parameter / function declaration by name in a module. */
  /**
   * The declaration of `name` visible in `mod`, with the scope that declares it.
   * `owner` is normally `mod` itself; it differs when the name was borrowed with
   * `import`, because then the package holds the declaration, and a caller that
   * wants to navigate there has to know that.
   */
  findDecl(mod: ModuleDef, name: string):
    | { kind: 'port'; decl: PortDecl; owner: ModuleDef }
    | { kind: 'param'; decl: ParamDecl; owner: ModuleDef }
    | { kind: 'var'; decl: VarDecl; owner: ModuleDef }
    | { kind: 'function'; decl: FunctionDecl; owner: ModuleDef }
    | { kind: 'arg'; decl: PortDecl; owner: ModuleDef }
    | undefined {
    return this.findDeclIn(mod, name, new Set([mod]));
  }

  /**
   * `import pkg::name;` makes the package's declaration this module's own, in
   * every file the index holds - not only the ones the parser could read while
   * it walked the module. `seen` stops two packages importing each other from
   * looping.
   */
  private findDeclIn(
    mod: ModuleDef,
    name: string,
    seen: Set<ModuleDef>,
  ): ReturnType<HdlIndex['findDecl']> {
    const ix = scopeIndexOf(mod);
    const port = ix.ports.get(name);
    if (port) {
      return { kind: 'port', decl: port, owner: mod };
    }
    const param = ix.params.get(name);
    if (param) {
      return { kind: 'param', decl: param, owner: mod };
    }
    const v = ix.decls.get(name);
    if (v) {
      return { kind: 'var', decl: v, owner: mod };
    }
    const f = ix.funcs.get(name);
    if (f) {
      return { kind: 'function', decl: f, owner: mod };
    }
    // An argument of a function or task is a declaration too: a reference in the
    // body has nothing else to resolve against.
    const arg = ix.args.get(name);
    if (arg) {
      return { kind: 'arg', decl: arg, owner: mod };
    }
    for (const imp of mod.imports) {
      if (!imp.wildcard && !imp.names.some((n) => n.name === name)) {
        continue;
      }
      const pkg = this.resolveModule(imp.pkg, mod.file);
      if (!pkg || seen.has(pkg)) {
        continue;
      }
      seen.add(pkg);
      const hit = this.findDeclIn(pkg, name, seen);
      if (hit) {
        return hit;
      }
    }
    return undefined;
  }

  /** Ports of a module by name, for connection lookups. */
  portMap(mod: ModuleDef | undefined): Map<string, PortDecl> {
    const m = new Map<string, PortDecl>();
    if (!mod) {
      return m;
    }
    for (const p of mod.ports) {
      m.set(p.name, p);
    }
    return m;
  }

  /**
   * Top module candidates. A module is a top when nothing instantiates it.
   * `explicit` names from configuration always win.
   */
  tops(explicit: string[] = []): TopCandidate[] {
    const instantiated = new Map<string, number>();
    for (const mods of this.byFile.values()) {
      for (const m of mods) {
        for (const inst of m.instances) {
          instantiated.set(inst.moduleName, (instantiated.get(inst.moduleName) ?? 0) + 1);
        }
      }
    }
    const out: TopCandidate[] = [];
    const seen = new Set<string>();
    for (const name of explicit) {
      const def = this.resolveModule(name);
      if (def) {
        out.push({ name, def, instantiatedBy: instantiated.get(name) ?? 0, reason: 'explicit' });
        seen.add(name);
      }
    }
    for (const [name, list] of this.byName) {
      if (seen.has(name)) {
        continue;
      }
      const def = list[0];
      if (def.kind !== 'module' && def.kind !== 'interface') {
        continue;
      }
      const count = instantiated.get(name) ?? 0;
      if (count === 0) {
        out.push({ name, def, instantiatedBy: 0, reason: 'never-instantiated' });
      }
    }
    return out;
  }

  /**
   * A scope in which a module's constant expressions can be folded. Module
   * parameters are seeded with their defaults (or an override when supplied).
   */
  scopeFor(mod: ModuleDef, overrides?: Map<string, number>): MapScope {
    const scope = new MapScope();
    // Typedef names fold through the same visibility a declaration has: the
    // module's own types, headers lent into it, `import`ed package members.
    scope.setTypeResolver((name) => this.underlyingType(mod, name));
    if (overrides) {
      for (const [k, v] of overrides) {
        scope.set(k, v);
      }
    }
    for (const p of mod.params) {
      if (overrides?.has(p.name)) {
        continue;
      }
      const v = p.value?.value;
      if (v !== undefined) {
        scope.set(p.name, v);
      }
    }
    // Seed widths so that `$bits(WIDTH)` style calls fold.
    for (const p of mod.params) {
      const w = typeWidth(p.dataType, scope);
      if (w !== undefined) {
        scope.setWidth(p.name, w);
      }
    }
    return scope;
  }

  /**
   * The type a `typedef` renames, so a signal written with it has a width:
   * `typedef logic [7:0] byte_t; byte_t data;` is 8 bits and not 1. An
   * unqualified name is looked up exactly where a declaration would be - the
   * module's own scope, a header lent into it, `import`ed package members -
   * while `pkg::type` goes straight to the package, the way the parser wrote
   * the name into the declaration. `undefined` means "not a typedef the IR can
   * size" (no such name, or a struct/union), and the width stays unknown.
   */
  underlyingType(mod: ModuleDef, name: string): DataType | undefined {
    const sep = name.lastIndexOf('::');
    if (sep >= 0) {
      const pkg = this.resolveModule(name.slice(0, sep), mod.file);
      const hit = pkg?.decls.find((d) => d.name === name.slice(sep + 2) && d.kind === 'typedef');
      return hit?.underlying;
    }
    const hit = this.findDecl(mod, name);
    return hit && hit.kind === 'var' && hit.decl.kind === 'typedef' ? hit.decl.underlying : undefined;
  }
}

export function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? '' : p.slice(0, i);
}

export function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? p : p.slice(i + 1);
}

export function isModuleLike(kind: ModuleKind): boolean {
  return kind === 'module' || kind === 'interface' || kind === 'primitive';
}

/**
 * The generate scopes a module declares, by label: `g[0]`, `g[1][2]` and `g`
 * are all the scope `g`, since the copies differ only in the index.
 */
export function generateScopes(mod: ModuleDef): Set<string> {
  const out = new Set<string>();
  const add = (path: string | undefined) => {
    if (path) {
      out.add(path.replace(/\[[^\]]*\]/g, ''));
    }
  };
  for (const d of mod.decls) {
    add(d.generate);
  }
  for (const a of mod.assigns) {
    add(a.generate);
  }
  for (const p of mod.params) {
    add(p.generate);
  }
  for (const i of mod.instances) {
    if (i.inGenerate) {
      add(i.genPrefix);
    }
  }
  return out;
}

/**
 * The name a reference has inside its own module, when it is written through a
 * generate block of that module (`scopes` from {@link generateScopes}): `g[0].t` is one way of writing the copy of `t`
 * that the block declares, and a netlist of the module has one `t` rather than
 * one per copy. A path whose head is a child instance is left alone - that net
 * belongs to the child, and the parent lists it under the path as written.
 *
 * Returns undefined when the path is not written through a generate scope, so
 * the caller keeps the text as it stands.
 */
export function generateScopedName(name: string, scopes: Set<string>): string | undefined {
  const dot = name.indexOf('.');
  if (dot < 0) {
    return undefined;
  }
  const head = name.slice(0, dot);
  if (!scopes.has(head.replace(/\[[^\]]*\]/g, ''))) {
    return undefined;
  }
  return name.slice(dot + 1).split('.')[0];
}
