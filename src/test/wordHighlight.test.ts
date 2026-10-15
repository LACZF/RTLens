import * as assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { Module } from 'node:module';

import { findWordMatches, randomHighlightColor } from '../core/wordHighlight';
import { vscode } from './vscodeStub';

/**
 * Word-occurrence matching.
 *
 * The highlighter must work on any word in any file: whole-token matches only
 * (`a` never fires inside `ab` or `数据a`), Unicode words count, and a word
 * glued to punctuation (`$display`) still stands alone.
 */

test('wordHighlight: empty word matches nothing', () => {
  assert.deepEqual(findWordMatches('alpha beta', ''), []);
});

test('wordHighlight: whole-token matches only', () => {
  // "ab a a1 a": standalone `a` at 3 and 8 (the `a` of `a1` is glued to `1`).
  // "xa ay a": only the trailing `a` at 6 stands alone.
  const src = ['ab a a1 a', 'xa ay a'].join('\n');
  assert.deepEqual(findWordMatches(src, 'a'), [
    { line: 0, startChar: 3, endChar: 4 },
    { line: 0, startChar: 8, endChar: 9 },
    { line: 1, startChar: 6, endChar: 7 },
  ]);
});

test('wordHighlight: matches at line start and end', () => {
  assert.deepEqual(findWordMatches('foo bar\nbaz foo\nfoo', 'foo'), [
    { line: 0, startChar: 0, endChar: 3 },
    { line: 1, startChar: 4, endChar: 7 },
    { line: 2, startChar: 0, endChar: 3 },
  ]);
});

test('wordHighlight: every occurrence on one line', () => {
  assert.deepEqual(findWordMatches('x foo, foo; foo', 'foo'), [
    { line: 0, startChar: 2, endChar: 5 },
    { line: 0, startChar: 7, endChar: 10 },
    { line: 0, startChar: 12, endChar: 15 },
  ]);
});

test('wordHighlight: a word glued to punctuation stands alone', () => {
  assert.deepEqual(findWordMatches('$display; foo$display', '$display'), [
    { line: 0, startChar: 0, endChar: 8 },
  ]);
});

test('wordHighlight: Unicode words match whole tokens', () => {
  const src = '数据 数据库 x数据';
  assert.deepEqual(findWordMatches(src, '数据'), [
    { line: 0, startChar: 0, endChar: 2 },
  ]);
});

test('wordHighlight: repeated same-position scan does not loop forever on overlapping candidates', () => {
  // `aa` inside `aaa` overlaps itself; only the non-glued occurrence counts.
  assert.deepEqual(findWordMatches('aaa aa', 'aa'), [
    { line: 0, startChar: 4, endChar: 6 },
  ]);
});

test('wordHighlight: randomHighlightColor uses the injected rand for the hue', () => {
  const c = randomHighlightColor(() => 0.5);
  assert.match(c.background, /^hsla\(180, 85%, 55%, 0\.35\)$/);
  assert.match(c.border, /^1px solid hsla\(180, 85%, 45%, 0\.9\)$/);
  assert.match(c.ruler, /^hsla\(180, 85%, 55%, 0\.9\)$/);
});

test('wordHighlight: randomHighlightColor hues differ across draws', () => {
  const a = randomHighlightColor(() => 0.1);
  const b = randomHighlightColor(() => 0.9);
  assert.notEqual(a.background, b.background);
});

// ---------------------------------------------------------------------------
// Host side: the real WordHighlighter against the stubbed `vscode`. The stub
// has to be in place before the highlighter - and everything it imports - asks
// for the `vscode` module.
// ---------------------------------------------------------------------------

const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = loader._load;
loader._load = function (request: string, ...rest: unknown[]) {
  return request === 'vscode' ? vscode : originalLoad(request, ...rest);
};

type WordHighlighterCtor = new () => {
  toggle(): void;
  readonly words: string[];
  dispose(): void;
};
let WordHighlighter: WordHighlighterCtor;

before(async () => {
  const mod = (await import('../vscode/wordHighlight')) as { WordHighlighter: WordHighlighterCtor };
  WordHighlighter = mod.WordHighlighter;
});

after(() => {
  loader._load = originalLoad;
});

/** A word range the way the editor's default word pattern sees it. */
function wordRangeAt(text: string, line: number, character: number) {
  const WORD = /[\p{L}\p{N}_$]+/gu;
  const src = text.split('\n')[line] ?? '';
  WORD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD.exec(src)) !== null) {
    if (m.index <= character && character <= m.index + m[0].length) {
      return {
        isEmpty: false,
        start: { line, character: m.index },
        end: { line, character: m.index + m[0].length },
      };
    }
  }
  return { isEmpty: true, start: { line, character }, end: { line, character } };
}

/** A visible editor over `text`; records every decoration push per type. */
function editorFor(text: string, cursor: { line: number; character: number }) {
  const decorations = new Map<unknown, { line: number; startChar: number; endChar: number }[]>();
  return {
    decorations,
    document: {
      getText: (range?: { start: { line: number; character: number }; end: { line: number; character: number } }) => {
        if (!range) return text;
        const lines = text.split('\n');
        if (range.start.line === range.end.line) {
          return lines[range.start.line].slice(range.start.character, range.end.character);
        }
        const head = lines[range.start.line].slice(range.start.character);
        const tail = lines[range.end.line].slice(0, range.end.character);
        return [head, ...lines.slice(range.start.line + 1, range.end.line), tail].join('\n');
      },
      getWordRangeAtPosition: (pos: { line: number; character: number }) => wordRangeAt(text, pos.line, pos.character),
    },
    selection: { active: { line: cursor.line, character: cursor.character } },
    setDecorations(decoration: unknown, ranges: { start: { line: number; character: number }; end: { line: number; character: number } }[]) {
      decorations.set(
        decoration,
        ranges.map((r) => ({ line: r.start.line, startChar: r.start.character, endChar: r.end.character })),
      );
    },
  };
}

test('wordHighlight host: F8 in a non-HDL file highlights every standalone occurrence', () => {
  const text = ['const alpha = 1;', '// alpha again', 'alphabet alpha'].join('\n');
  const ed = editorFor(text, { line: 0, character: 6 });
  vscode.window.activeTextEditor = ed as never;
  vscode.window.visibleTextEditors = [ed as never];
  const h = new WordHighlighter();
  try {
    h.toggle();
    assert.deepEqual(h.words, ['alpha']);
    const ranges = [...ed.decorations.values()][0];
    assert.deepEqual(ranges, [
      { line: 0, startChar: 6, endChar: 11 },
      { line: 1, startChar: 3, endChar: 8 },
      { line: 2, startChar: 9, endChar: 14 },
    ]);
  } finally {
    h.dispose();
    vscode.window.activeTextEditor = undefined;
    vscode.window.visibleTextEditors = [];
  }
});

test('wordHighlight host: toggling the same word again removes it, another word stacks', () => {
  const text = ['foo bar foo', 'bar foo'].join('\n');
  const ed = editorFor(text, { line: 0, character: 0 });
  vscode.window.activeTextEditor = ed as never;
  vscode.window.visibleTextEditors = [ed as never];
  const h = new WordHighlighter();
  try {
    h.toggle(); // foo, cursor on the first token
    assert.deepEqual(h.words, ['foo']);
    ed.selection.active = { line: 0, character: 4 }; // move to `bar`
    h.toggle();
    assert.deepEqual(h.words.sort(), ['bar', 'foo']);
    ed.selection.active = { line: 0, character: 0 }; // back on `foo`
    h.toggle(); // foo off
    assert.deepEqual(h.words, ['bar']);
    const bars = [...ed.decorations.values()].pop();
    assert.deepEqual(bars, [
      { line: 0, startChar: 4, endChar: 7 },
      { line: 1, startChar: 0, endChar: 3 },
    ]);
  } finally {
    h.dispose();
    vscode.window.activeTextEditor = undefined;
    vscode.window.visibleTextEditors = [];
  }
});

test('wordHighlight host: a cursor on whitespace is a no-op', () => {
  const ed = editorFor('foo   bar', { line: 0, character: 4 });
  vscode.window.activeTextEditor = ed as never;
  vscode.window.visibleTextEditors = [ed as never];
  const h = new WordHighlighter();
  try {
    h.toggle();
    assert.deepEqual(h.words, []);
  } finally {
    h.dispose();
    vscode.window.activeTextEditor = undefined;
    vscode.window.visibleTextEditors = [];
  }
});
