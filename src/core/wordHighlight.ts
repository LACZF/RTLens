/**
 * Word-occurrence highlighting helpers.
 *
 * A syntax-agnostic, whole-token match: the word under the cursor (from
 * `wordAtPosition`) is searched verbatim so an identifier is highlighted only
 * when it stands alone, never as a prefix of a longer name. Deliberately not
 * comment/string aware, matching how editors highlight the current word.
 */

export interface WordMatch {
  /** 0-based line. */
  line: number;
  /** 0-based start column, inclusive. */
  startChar: number;
  /** 0-based end column, exclusive. */
  endChar: number;
}

/** Characters an HDL identifier (and a highlighted word) is made of. */
const WORD_RE = /[A-Za-z0-9_$]+/g;

/**
 * Every standalone occurrence of `word` in `text`, in document order.
 *
 * A match is only counted when the whole token equals `word`, so `a` does not
 * match inside `ab` or `a1`.
 */
export function findWordMatches(text: string, word: string): WordMatch[] {
  if (!word) {
    return [];
  }
  const out: WordMatch[] = [];
  const lines = text.split('\n');
  for (let line = 0; line < lines.length; line++) {
    WORD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WORD_RE.exec(lines[line])) !== null) {
      if (m[0] === word) {
        out.push({ line, startChar: m.index, endChar: m.index + word.length });
      }
    }
  }
  return out;
}

/** Background / border / ruler colours for one highlight. */
export interface HighlightColor {
  background: string;
  border: string;
  ruler: string;
}

/**
 * A random highlight colour, as a low-alpha background plus a solid border and
 * overview-ruler stroke in the same hue. `rand` is injectable so the choice is
 * testable.
 */
export function randomHighlightColor(rand: () => number = Math.random): HighlightColor {
  const hue = Math.floor(rand() * 360);
  return {
    background: `hsla(${hue}, 85%, 55%, 0.35)`,
    border: `1px solid hsla(${hue}, 85%, 45%, 0.9)`,
    ruler: `hsla(${hue}, 85%, 55%, 0.9)`,
  };
}
