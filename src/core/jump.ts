/**
 * Precomputed navigation table.
 *
 * The relation "identifier occurrence -> the declaration it names" is saved per
 * file while the workspace is indexed, so Go to Definition is a lookup instead
 * of a re-tokenisation of the whole buffer on every key press. An entry exists
 * only when the occurrence resolves; a cursor on anything else has no relation
 * to query and reports nothing, which is what an unresolved cursor means.
 *
 * The table is derived from the index, so it is invalidated whenever the index
 * changes (`HdlIndex.removeFile` / `addFile`) rather than patched in place -
 * a module added by a later file can give an occurrence its target.
 */

import { tokenize, type Range } from './lexer';
import type { HdlIndex } from './index';
import { resolvePath, resolveMacro, wordAtToken } from './resolve';
import type { DeclKind } from './resolve';

/** One saved relation: where an identifier sits and where it lands. */
export interface JumpEntry {
  /** Start of the occurrence in its line (0-based character). */
  start: number;
  /** End of the occurrence in its line, exclusive. */
  end: number;
  /** What kind of declaration the occurrence names. */
  kind: DeclKind;
  /** Module an instance names, before it is resolved to a file. */
  moduleName?: string;
  /** File and name extent to land on, when the target is known. */
  target?: { file: string; range: Range };
}

/** Every resolved occurrence of one file, grouped by line. */
export interface FileJumps {
  /** 0-based line -> occurrences on that line, ordered by start character. */
  lines: Map<number, JumpEntry[]>;
  /** How many relations were saved - reported by tests and the index log. */
  count: number;
  /**
   * Files the saved targets live in. When one of them changes, only the tables
   * that point into it go stale, not every table in the workspace.
   */
  targetFiles: Set<string>;
}

/**
 * Resolve every identifier of `source` against the current index.
 *
 * One tokenisation serves the whole file: `wordAtPosition` re-tokenises for a
 * single cursor, which is the cost of one lookup, not of a whole file.
 */
export function buildFileJumps(index: HdlIndex, file: string, source: string): FileJumps {
  const lines = new Map<number, JumpEntry[]>();
  const targetFiles = new Set<string>();
  const toks = tokenize(source).filter((t) => t.kind !== 'comment' && t.kind !== 'eof');
  let count = 0;
  // Tokens arrive in source order, so several per line share a module lookup;
  // resolving the owning module once per line rather than once per token is a
  // large saving on files with many identifiers.
  let lastLine = -1;
  let lastMod: ReturnType<HdlIndex['moduleAtLine']>;

  for (let i = 0; i < toks.length; i++) {
    const word = wordAtToken(toks, i);
    if (!word) {
      continue;
    }
    const tok = toks[i];
    const line = tok.range.start.line;
    let mod: ReturnType<HdlIndex['moduleAtLine']>;
    if (line === lastLine) {
      mod = lastMod;
    } else {
      mod = index.moduleAtLine(file, line);
      lastLine = line;
      lastMod = mod;
    }
    // One name is by far the common case, and splitting it would allocate an
    // array per identifier in the file.
    const path = word.fullPath.includes('.') ? word.fullPath.split('.') : [word.fullPath];
    const macro = word.isMacro ? resolveMacro(index, word.name, file) : undefined;
    const resolution = macro && macro.ok ? macro : resolvePath(index, mod, path);
    if (!resolution.ok) {
      continue;
    }
    const decl = resolution.decl;
    // For a `NAME macro reference the occurrence is the identifier, not the
    // backtick that precedes it; the saved hit should start on the name.
    const tokenRange = word.isMacro ? word.nameRange : tok.range;
    const entry: JumpEntry = {
      start: tokenRange.start.character,
      end: tokenRange.end.character,
      kind: decl.kind,
    };
    if (decl.kind === 'instance') {
      // The instance name jumps to the module it instantiates, which is the
      // only useful target: the declaration of the instance is the very word
      // under the cursor.
      entry.moduleName = decl.moduleName ?? decl.name;
      const target = index.resolveModule(entry.moduleName, decl.file);
      if (target) {
        entry.target = { file: target.file, range: target.nameRange };
      }
    } else {
      entry.target = { file: decl.file, range: decl.nameRange };
    }
    if (entry.target) {
      targetFiles.add(entry.target.file);
    }
    let bucket = lines.get(line);
    if (!bucket) {
      bucket = [];
      lines.set(line, bucket);
    }
    bucket.push(entry);
    count++;
  }

  return { lines, count, targetFiles };
}

/**
 * Query a saved table.
 *
 * The cursor may sit immediately after the identifier - the usual position
 * after typing a name - which is the tolerance `wordAtPosition` offers.
 */
export function lookupInTable(
  table: FileJumps,
  line: number,
  character: number,
): JumpEntry | undefined {
  const bucket = table.lines.get(line);
  if (!bucket) {
    return undefined;
  }
  for (const entry of bucket) {
    if (entry.start <= character && character <= entry.end) {
      return entry;
    }
  }
  return undefined;
}
