/**
 * Glob handling for the file patterns of the settings.
 *
 * The extension matches its own `exclude` patterns instead of asking VS Code
 * to do it, so it has to agree with the glob syntax that `findFiles` and the
 * file watchers understand. The subset used here is `*`, `**`, `?` and `{}`
 * groups, which is what the shipped defaults need.
 *
 * It lives in `core` so it can be tested without an extension host; glob
 * mistakes are silent and expensive - a pattern for a testbench directory that
 * fails to match `tb/x.v` means testbench files end up in the index.
 */

/** Combine the settings patterns into the `{a,b}` form VS Code accepts. */
export function braceGlob(patterns: string[]): string {
  if (patterns.length === 0) {
    return '**/*';
  }
  if (patterns.length === 1) {
    return patterns[0];
  }
  return `{${patterns.join(',')}}`;
}

/** True when `text` matches `pattern`. */
export function matchesGlob(text: string, pattern: string): boolean {
  const re = globToRegExp(pattern);
  return re.test(text);
}

function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` may also match zero directories.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}
