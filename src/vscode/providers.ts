import * as vscode from 'vscode';

import type { IndexService } from './indexService';
import {
  resolveAt,
  resolvePath,
  resolveInScope,
  referencesInScope,
  instancesOf,
  leafRangeIn,
  wordAtPosition,
  renameAllowed,
} from '../core/resolve';
import type { RefScope, ResolvedDecl, Resolution } from '../core/resolve';
import type { JumpEntry } from '../core/jump';
import { identifierProblem } from '../core/naming';
import type { ModuleDef, PortDecl, VarDecl, ParamDecl, InstanceSite, AssignSite } from '../core/ast';
import { typeWidth, rangeWidth } from '../core/fold';
import { basename } from '../core/index';

export function pos(line: number, character: number): vscode.Position {
  return new vscode.Position(line, character);
}

export function range(r: { start: { line: number; character: number }; end: { line: number; character: number } }): vscode.Range {
  return new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
}

export function locationOf(file: string, nameRange: { start: { line: number; character: number }; end: { line: number; character: number } }): vscode.Location {
  return new vscode.Location(vscode.Uri.file(file), range(nameRange));
}

export const DECL_KIND_LABEL: Record<ResolvedDecl['kind'], string> = {
  module: 'module',
  instance: 'instance',
  port: 'port',
  signal: 'signal',
  param: 'parameter',
  function: 'function/task',
  interface: 'interface',
  genvar: 'genvar',
  type: 'type',
  macro: 'macro',
  arg: 'function argument',
};

/** Why a rename is refused, in the user's terms. */
function renameRefusal(resolution: Resolution): string {
  if (resolution.ok && resolution.decl.kind === 'arg') {
    return 'HDL: a function or task argument is declared in its header, which this rename cannot rewrite.';
  }
  if (resolution.ok && resolution.decl.kind === 'macro') {
    return 'HDL: a `define macro is expanded by the preprocessor; renaming it here would miss every `NAME use.';
  }
  return 'HDL: this name is imported from another file, so renaming it here would leave the import behind.';
}

// ---------------------------------------------------------------------------
// Go to definition
// ---------------------------------------------------------------------------

export class HdlDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly svc: IndexService) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Definition | undefined> {
    // Activation returns before the scan finishes, so the first jump can arrive
    // while the index is still empty; waiting costs nothing once it is ready.
    await this.svc.ensureReady();
    const file = document.fileName;
    this.svc.syncOpenDocuments();
    const source = document.getText();

    // The relation is saved when the file is indexed, so this is a lookup: no
    // re-tokenisation of the buffer, and no resolution work repeated per press.
    const jump = this.svc.index.lookupJump(file, source, position.line, position.character);
    if (jump) {
      return this.fromJump(document, jump);
    }

    // Nothing saved for this cursor - a file the scan has not seen, or a name
    // that does not resolve - so resolve it now, which is the same answer the
    // table would have held.
    const hit = resolveAt(this.svc.index, file, source, position.line, position.character);
    if (!hit || !hit.resolution.ok) {
      return undefined;
    }
    const d = hit.resolution.decl;
    if (d.kind === 'instance') {
      const def = this.svc.index.resolveModule(d.moduleName ?? d.name, d.file);
      return def ? locationOf(def.file, def.nameRange) : undefined;
    }
    return locationOf(d.file, d.nameRange);
  }

  /** Turn a saved relation into a location, honouring `followDefinition`. */
  private fromJump(document: vscode.TextDocument, jump: JumpEntry): vscode.Definition | undefined {
    if (jump.kind === 'instance') {
      // The declaration of an instance is the very name under the cursor, so
      // jumping to it does nothing. The useful target is the module it
      // instantiates - or, with `followDefinition` off, the instance in the
      // composition tree, which is where a user goes to see its context.
      if (!this.svc.config.followDefinition) {
        void vscode.commands.executeCommand('hdl.connectView.revealInComposition', document.uri);
        return undefined;
      }
    }
    return jump.target ? locationOf(jump.target.file, jump.target.range) : undefined;
  }
}

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

export class HdlHoverProvider implements vscode.HoverProvider {
  constructor(private readonly svc: IndexService) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | undefined> {
    await this.svc.ensureReady();
    this.svc.syncOpenDocuments();
    const hit = resolveAt(
      this.svc.index,
      document.fileName,
      document.getText(),
      position.line,
      position.character,
    );
    if (!hit) {
      return undefined;
    }
    if (!hit.resolution.ok) {
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**${hit.word.fullPath}** — not resolved\n\n`);
      md.appendMarkdown(`\`${hit.resolution.reason}\``);
      md.isTrusted = false;
      return new vscode.Hover(md, range(hit.word.nameRange));
    }
    const d = hit.resolution.decl;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`\`${DECL_KIND_LABEL[d.kind]}\` **${d.name}**\n\n`);
    md.appendMarkdown(`${this.details(d)}\n\n`);
    md.appendMarkdown(`${basename(d.file)}:${d.nameRange.start.line + 1}`);
    if (d.path) {
      md.appendMarkdown(` · scope \`${d.path}\``);
    }
    md.isTrusted = false;
    return new vscode.Hover(md, range(hit.word.nameRange));
  }

  /** Width, direction and driver information for a resolved declaration. */
  private details(d: ResolvedDecl): string {
    const parts: string[] = [];
    const index = this.svc.index;
    const mod = d.moduleName ? index.resolveModule(d.moduleName, d.file) : undefined;
    if (mod) {
      const decl = index.findDecl(mod, d.name);
      if (decl) {
        if (decl.kind === 'port') {
          parts.push(`\`${decl.decl.direction} ${typeText(decl.decl.dataType.t)}\``);
          const w = this.widthOfPort(mod, decl.decl);
          if (w !== undefined) {
            parts.push(`\`${w} bit${w === 1 ? '' : 's'}\``);
          }
          if (decl.decl.ansi) {
            parts.push('ANSI port');
          }
        } else if (decl.kind === 'var') {
          parts.push(`\`${decl.decl.kind} ${typeText(decl.decl.dataType.t)}\``);
        } else if (decl.kind === 'param') {
          // A member of an enum is a localparam of that type, and the type is
          // the one thing that says what the number means.
          if (decl.decl.dataType.t === 'user' && decl.decl.dataType.name) {
            parts.push(`\`${decl.decl.dataType.name}\``);
          }
          const v = decl.decl.value?.value ?? decl.decl.value?.raw;
          if (v !== undefined) {
            parts.push(`= \`${v}\``);
          }
          if (decl.decl.isLocal) {
            parts.push('`localparam`');
          }
        } else if (decl.kind === 'function') {
          parts.push(`\`${decl.decl.kind}\``);
        }
      }
    }
    if (d.kind === 'module') {
      const def = index.resolveModule(d.name);
      if (def) {
        const insts = instancesOf(index, d.name);
        parts.push(`${insts.length} instantiation${insts.length === 1 ? '' : 's'}`);
        parts.push(`${def.ports.length} port${def.ports.length === 1 ? '' : 's'}`);
      } else {
        parts.push('not found in the index (black box?)');
      }
    }
    if (d.kind === 'macro') {
      const def = index.resolveMacro(d.name, d.file);
      if (def && def.text) {
        const body = def.text.replace(/^`define\s+[A-Za-z_$][A-Za-z0-9_$]*/, '').trim();
        if (body.length > 0) {
          parts.push('`' + body);
        }
      }
    }
    if (d.kind === 'instance' && d.viaInstance) {
      parts.push(`instance of \`${d.name}\``);
    }
    return parts.join(' · ');
  }

  private widthOfPort(mod: ModuleDef, p: PortDecl): number | undefined {
    const scope = this.svc.index.scopeFor(mod);
    let w = typeWidth(p.dataType, scope);
    if (p.unpacked?.length) {
      let total = w ?? 1;
      for (const d of p.unpacked) {
        const n = rangeWidth(d, scope);
        if (n === undefined) {
          return undefined;
        }
        total *= n;
      }
      w = total;
    }
    return w;
  }
}

// ---------------------------------------------------------------------------
// References / rename
// ---------------------------------------------------------------------------

export class HdlReferenceProvider implements vscode.ReferenceProvider {
  constructor(private readonly svc: IndexService) {}

  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Location[]> {
    await this.svc.ensureReady();
    this.svc.syncOpenDocuments();
    const hit = resolveAt(this.svc.index, document.fileName, document.getText(), position.line, position.character);
    if (!hit) {
      return [];
    }
    // The leaf name of a hierarchical reference is what users search for.
    const name = hit.word.name;
    return this.find(name, hit.resolution, refScopeAt(hit.mod, hit.resolution));
  }

  private find(name: string, resolution: Resolution, scope?: RefScope): vscode.Location[] {
    const out: vscode.Location[] = [];
    const index = this.svc.index;
    if (resolution.ok && resolution.decl.kind === 'module') {
      for (const { mod, inst } of instancesOf(index, name)) {
        out.push(locationOf(mod.file, inst.nameRange));
      }
      const def = index.resolveModule(name);
      if (def) {
        out.push(locationOf(def.file, def.nameRange));
      }
      return dedupe(out);
    }
    // `referencesTo` matches by name across the whole workspace, which is what a
    // package-level or module-level symbol needs but far too broad for a plain
    // signal: `data` in one module has nothing to do with `data` in another. The
    // scope the cursor was in decides how much of that is in the same scope.
    for (const { mod, ref } of referencesInScope(index, name, scope)) {
      out.push(locationOf(mod.file, ref.range));
    }
    if (resolution.ok && (!scope || resolution.decl.file === scope.file)) {
      out.push(locationOf(resolution.decl.file, resolution.decl.nameRange));
    }
    return dedupe(out);
  }
}

export class HdlRenameProvider implements vscode.RenameProvider {
  constructor(private readonly svc: IndexService) {}

  /**
   * Reject a rename before the user types a new name when the word is not a
   * renameable declaration at all. Throwing here is what makes VS Code say
   * "cannot rename" instead of accepting the rename and finding nothing.
   */
  async prepareRename(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Range> {
    await this.svc.ensureReady();
    const word = wordAtPosition(document.getText(), position.line, position.character);
    if (!word) {
      throw new Error('HDL: there is no renameable HDL name at the cursor.');
    }
    this.svc.syncOpenDocuments();
    const hit = resolveAt(this.svc.index, document.fileName, document.getText(), position.line, position.character);
    if (!hit || !hit.resolution.ok) {
      throw new Error(`HDL: \`${word.fullPath}\` does not resolve, so it cannot be renamed safely.`);
    }
    if (!renameAllowed(hit.resolution, document.fileName)) {
      throw new Error(renameRefusal(hit.resolution));
    }
    return range(word.nameRange);
  }

  async provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string,
  ): Promise<vscode.WorkspaceEdit> {
    await this.svc.ensureReady();
    const edit = new vscode.WorkspaceEdit();
    const invalid = identifierProblem(newName);
    if (invalid) {
      throw new Error(invalid);
    }
    if (newName === wordAtPosition(document.getText(), position.line, position.character)?.name) {
      return edit;
    }
    this.svc.syncOpenDocuments();
    const hit = resolveAt(this.svc.index, document.fileName, document.getText(), position.line, position.character);
    if (!hit || !hit.resolution.ok) {
      throw new Error('HDL: the name at the cursor is not resolved, so it cannot be renamed safely.');
    }
    if (!renameAllowed(hit.resolution, document.fileName)) {
      throw new Error(renameRefusal(hit.resolution));
    }
    this.assertNoCollision(hit, newName);
    const refs = await new HdlReferenceProvider(this.svc).provideReferences(document, position);
    const texts = new Map<string, string>();
    for (const loc of refs) {
      const key = loc.uri.toString();
      if (!texts.has(key)) {
        const doc = await vscode.workspace.openTextDocument(loc.uri);
        texts.set(key, doc.getText());
      }
      // A package-qualified reference is one range covering `cfg::WIDTH`; the
      // rename has to touch the leaf only or the qualifier is lost.
      const target = leafRangeIn(
        { start: loc.range.start, end: loc.range.end },
        texts.get(key)!,
        hit.word.name,
      );
      edit.replace(loc.uri, target ? range(target) : loc.range, newName);
    }
    return edit;
  }

  /**
   * Renaming onto a name that already resolves in the same scope would shadow
   * it, and the shadowed declaration would silently stop resolving. VS Code
   * refuses such renames for its own providers, so this one does too.
   */
  private assertNoCollision(
    hit: { mod: ModuleDef | undefined; resolution: Resolution },
    newName: string,
  ): void {
    const decl = (hit.resolution as { ok: true; decl: ResolvedDecl }).decl;
    if (decl.kind === 'module') {
      // A module may legitimately be declared in several files, so only a
      // definition somewhere else counts as a collision.
      const elsewhere = this.svc.index
        .allDefs(newName)
        .some((m) => m.file !== decl.file || m.nameRange.start.line !== decl.nameRange.start.line);
      if (elsewhere) {
        throw new Error(`HDL: a module named \`${newName}\` already exists in the workspace.`);
      }
      return;
    }
    if (!hit.mod) {
      return;
    }
    const other = resolveInScope(this.svc.index, hit.mod, newName);
    if (other.ok && other.decl !== decl) {
      throw new Error(
        `HDL: \`${newName}\` already exists in \`${hit.mod.name}\`; renaming would shadow it.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Document symbols (outline)
// ---------------------------------------------------------------------------

export class HdlDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  constructor(private readonly svc: IndexService) {}

  async provideDocumentSymbols(document: vscode.TextDocument): Promise<vscode.DocumentSymbol[]> {
    await this.svc.ensureReady();
    this.svc.syncOpenDocuments();
    const mods = this.svc.index.modulesInFile(document.fileName);
    const out: vscode.DocumentSymbol[] = [];
    for (const m of mods) {
      const children: vscode.DocumentSymbol[] = [];
      for (const p of m.ports) {
        children.push(
          symbol(vscode.SymbolKind.Field, p.name, portDetail(p), range(p.range), range(p.nameRange), p.direction),
        );
      }
      for (const p of m.params) {
        children.push(
          symbol(
            vscode.SymbolKind.Constant,
            p.name,
            paramDetail(p),
            range(p.range),
            range(p.nameRange),
            p.isLocal ? 'localparam' : 'parameter',
          ),
        );
      }
      for (const d of m.decls) {
        children.push(
          symbol(vscode.SymbolKind.Variable, d.name, varDetail(d), range(d.range), range(d.nameRange), d.kind),
        );
      }
      for (const i of m.instances) {
        children.push(
          symbol(vscode.SymbolKind.Class, i.name, instDetail(i), range(i.range), range(i.nameRange), i.moduleName),
        );
      }
      for (const f of m.funcs) {
        children.push(symbol(vscode.SymbolKind.Method, f.name, '', range(f.range), range(f.nameRange), f.kind));
      }
      const sym = symbol(
        moduleSymbolKind(m.kind),
        m.name,
        m.kind,
        range(m.range),
        range(m.nameRange),
        `${m.ports.length}p ${m.instances.length}i ${m.assigns.length}a`,
      );
      sym.children = children;
      out.push(sym);
    }
    return out;
  }
}

/**
 * The workspace-symbol feed for the system quick open (`#`, `Ctrl+T`,
 * `workbench.action.showAllSymbols`). One `SymbolInformation` per
 * module definition - not per name, so an RTL module and its black-box stub
 * stay distinguishable - with `location` pinned to `nameRange` so choosing a
 * row opens the declaration with the cursor on the name.
 */
export class HdlWorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
  constructor(private readonly svc: IndexService) {}

  async provideWorkspaceSymbols(query: string): Promise<vscode.SymbolInformation[]> {
    await this.svc.ensureReady();
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const mods = this.svc.index
      .allModules()
      .sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file));
    const out: vscode.SymbolInformation[] = [];
    for (const m of mods) {
      const rel = String(this.svc.relFile(m.file)).toLowerCase();
      if (tokens.length && !tokens.every((t) => subsequence(m.name.toLowerCase(), t) || subsequence(rel, t))) {
        continue;
      }
      out.push(new vscode.SymbolInformation(m.name, moduleSymbolKind(m.kind), m.kind, locationOf(m.file, m.nameRange)));
    }
    return out;
  }
}

function moduleSymbolKind(kind: ModuleDef['kind']): vscode.SymbolKind {
  switch (kind) {
    case 'package':
      return vscode.SymbolKind.Namespace;
    case 'interface':
      return vscode.SymbolKind.Interface;
    case 'class':
      return vscode.SymbolKind.Class;
    default:
      return vscode.SymbolKind.Module;
  }
}

/** Case-insensitive subsequence test: every character of `token`, in order. */
function subsequence(text: string, token: string): boolean {
  let at = 0;
  for (const ch of token) {
    at = text.indexOf(ch, at);
    if (at < 0) {
      return false;
    }
    at += 1;
  }
  return true;
}

function symbol(
  kind: vscode.SymbolKind,
  name: string,
  detail: string,
  full: vscode.Range,
  sel: vscode.Range,
  tag?: string,
): vscode.DocumentSymbol {
  const s = new vscode.DocumentSymbol(name, tag ? `${tag} - ${detail}` : detail, kind, full, sel);
  return s;
}

function portDetail(p: PortDecl): string {
  const w = p.isInterface ? 'interface' : typeText(p.dataType.t);
  return `${p.direction} ${w}`;
}

function paramDetail(p: ParamDecl): string {
  const v = p.value?.value ?? p.value?.raw ?? '';
  return `parameter = ${v}`;
}

function varDetail(d: VarDecl): string {
  return `${d.kind} ${typeText(d.dataType.t)}`;
}

function instDetail(i: InstanceSite): string {
  const ports = i.connections.filter((c) => !c.empty).length;
  return `${i.moduleName}${i.paramOverrides.length ? ` #(${i.paramOverrides.length} params)` : ''}, ${ports} connections`;
}

function typeText(t: string): string {
  return t === 'unknown' ? '' : t;
}

function dedupe(locs: vscode.Location[]): vscode.Location[] {
  const seen = new Set<string>();
  const out: vscode.Location[] = [];
  for (const l of locs) {
    const k = `${l.uri.toString()}:${l.range.start.line}:${l.range.start.character}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(l);
    }
  }
  return out;
}

/**
 * The scope of a lookup, widened for the kinds Verilog scopes by name only.
 * Anything else is narrowed to the module the cursor was in, so find-references
 * and rename do not walk into unrelated modules that happen to use the same
 * signal name.
 */
export function refScopeAt(mod: ModuleDef | undefined, resolution: Resolution): RefScope | undefined {
  if (!mod) {
    return undefined;
  }
  return {
    file: mod.file,
    moduleName: mod.name,
    workspaceWide: resolution.ok && WORKSPACE_WIDE.has(resolution.decl.kind),
  };
}

const WORKSPACE_WIDE: ReadonlySet<ResolvedDecl['kind']> = new Set([
  'module',
  'param',
  'function',
  'interface',
  'type',
]);

// ---------------------------------------------------------------------------
// Selection helper reused by the graph and generator commands
// ---------------------------------------------------------------------------

/**
 * What the user has "selected" in the editor: the enclosing module plus, when
 * the cursor sits on an instantiation, that instance.
 */
export interface EditorSelection {
  mod: ModuleDef;
  /** Full text of the file the cursor is in. */
  text: string;
  file: string;
  /** Instance path, when the cursor is on an instance name. */
  instancePath?: string;
  word?: string;
}

export function selectionAt(svc: IndexService, document: vscode.TextDocument, position: vscode.Position): EditorSelection | undefined {
  // Deliberately no `syncOpenDocuments()` here: this runs on every cursor move
  // and every selection change. `watchDocument` already re-parses a dirty buffer
  // after a short debounce, and the caller passes the live text in, so the index
  // is at most one debounce behind - which no tree view can show.
  const text = document.getText();
  const file = document.fileName;
  const mod = svc.moduleAt(file, position.line);
  if (!mod) {
    return undefined;
  }
  const out: EditorSelection = { mod, text, file };
  const word = wordAtPosition(text, position.line, position.character);
  if (word) {
    out.word = word.name;
    // The word has to be the instance name itself; a line-only match would pick
    // the wrong one for `leaf a (...), b (...);` and would also claim the module
    // name of a declaration it is not pointing at.
    const inst =
      mod.instances.find(
        (i) =>
          i.nameRange.start.line === word.nameRange.start.line &&
          i.nameRange.start.character === word.nameRange.start.character,
      ) ?? mod.instances.find((i) => i.moduleNameRange?.start.line === word.nameRange.start.line);
    if (inst) {
      // `buildHierarchy` roots a hierarchy at the module name, so a path is only
      // valid once it carries that prefix - the same way the composition tree
      // spells it.
      const local = inst.genPrefix ? `${inst.genPrefix}.${inst.name}` : inst.name;
      out.instancePath = `${mod.name}.${local}`;
    }
  }
  return out;
}

/** Resolve a name in a module scope; exported for the command implementations. */
export function resolveNameIn(
  index: import('../core/index').HdlIndex,
  mod: ModuleDef,
  name: string,
): Resolution {
  return resolveInScope(index, mod, name);
}

export function resolveDotted(
  index: import('../core/index').HdlIndex,
  mod: ModuleDef,
  path: string,
): Resolution {
  return resolvePath(index, mod, path.split('.'));
}

export type { AssignSite };
