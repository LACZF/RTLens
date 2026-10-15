/**
 * Word-occurrence highlighting helpers.
 *
 * A language-agnostic, whole-token match: the word under the cursor (from the
 * editor's own word pattern) is searched verbatim so a word is highlighted only
 * when it stands alone, never as a fragment of a longer name. "Standing alone"
 * means the characters on either side are not word characters (`\p{L}\p{N}_$`),
 * which keeps the old identifier semantics (`a` never matches inside `ab`) while
 * working for any script and any file type. Deliberately not comment/string
 * aware, matching how editors highlight the current word.
 */

export interface WordMatch {
  /** 0-based line. */
  line: number;
  /** 0-based start column, inclusive. */
  startChar: number;
  /** 0-based end column, exclusive. */
  endChar: number;
}

/** A character that can glue two words into one token. */
const WORD_CHAR_RE = /[\p{L}\p{N}_$]/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR_RE.test(ch);
}

/**
 * Every standalone occurrence of `word` in `text`, in document order.
 *
 * A match is only counted when neither neighbour is a word character, so `a`
 * does not match inside `ab`, `a1` or `数据a`, while `$display` matches next to
 * punctuation and not inside `foo$display`.
 */
export function findWordMatches(text: string, word: string): WordMatch[] {
  if (!word) {
    return [];
  }
  const out: WordMatch[] = [];
  const lines = text.split('\n');
  for (let line = 0; line < lines.length; line++) {
    const src = lines[line];
    let from = 0;
    for (;;) {
      const idx = src.indexOf(word, from);
      if (idx < 0) {
        break;
      }
      const before = idx > 0 ? src[idx - 1] : undefined;
      const end = idx + word.length;
      const after = end < src.length ? src[end] : undefined;
      if (!isWordChar(before) && !isWordChar(after)) {
        out.push({ line, startChar: idx, endChar: end });
      }
      from = idx + 1;
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
