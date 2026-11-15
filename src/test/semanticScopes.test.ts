import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { TOKEN_TYPES } from '../core/tokens';

/**
 * Semantic token theming.
 *
 * VS Code colours a semantic token from the theme's `semanticTokenColors`; when
 * the theme has no rule, it probes the TextMate scopes declared in
 * `semanticTokenScopes` and paints the token with the plain editor foreground
 * when none of them is themed. A custom token type does **not** inherit the
 * TextMate mapping of its `superType` (only the `semanticTokenColors` rules), so
 * a custom type with no entry silently loses the grammar's colour - which is how
 * declared signals used to turn white while undeclared names stayed coloured.
 *
 * The check is on the manifest itself, because that is where the mapping lives
 * and no extension host is needed to prove it is complete.
 */

const ROOT = path.join(__dirname, '..', '..');

interface SemanticTokenType {
  id: string;
  superType?: string;
}

interface ScopeMapEntry {
  language?: string;
  scopes: Record<string, string[]>;
}

interface Manifest {
  contributes: {
    languages: { id: string }[];
    semanticTokenTypes: SemanticTokenType[];
    semanticTokenScopes: ScopeMapEntry[];
  };
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
) as Manifest;

/**
 * The predefined TextMate probes of the standard types this extension subtypes
 * (see the "Semantic token scope map" table in the VS Code API reference). A
 * custom type has to repeat at least one of them, otherwise themes that know
 * only the standard types leave it uncoloured.
 */
const SUPER_TYPE_PROBES: Record<string, string[]> = {
  type: ['entity.name.type'],
  variable: ['variable.other.readwrite', 'entity.name.variable'],
  parameter: ['variable.parameter'],
  function: ['entity.name.function'],
};

/** Entries with no `language` apply to every language VS Code resolves them for. */
function scopesFor(language: string): Record<string, string[]> {
  const merged: Record<string, string[]> = {};
  for (const entry of manifest.contributes.semanticTokenScopes) {
    if (entry.language !== undefined && entry.language !== language) {
      continue;
    }
    for (const [selector, probes] of Object.entries(entry.scopes)) {
      merged[selector] = probes;
    }
  }
  return merged;
}

test('semantic scopes: the legend and the contribution declare the same types', () => {
  const declared = manifest.contributes.semanticTokenTypes.map((t) => t.id).sort();
  assert.deepEqual(declared, [...TOKEN_TYPES].sort());
});

for (const { id: language } of manifest.contributes.languages) {
  test(`semantic scopes: every token type is themable in ${language}`, () => {
    for (const entry of manifest.contributes.semanticTokenScopes) {
      assert.ok(
        Object.keys(entry.scopes).length > 0,
        `an empty scope map does not fall back to anything (${language})`,
      );
    }
    const scopes = scopesFor(language);
    for (const type of manifest.contributes.semanticTokenTypes) {
      const probes = scopes[type.id];
      assert.ok(
        probes && probes.length > 0,
        `${type.id} has no TextMate fallback in ${language}: it renders in the plain text colour`,
      );
      for (const probe of probes) {
        assert.match(probe, /^[a-z][\w-]*(\.[\w-]+)+$/, `${type.id} maps to "${probe}", which is not a scope`);
      }
      const superProbes = SUPER_TYPE_PROBES[type.superType ?? ''];
      assert.ok(superProbes, `${type.id} declares unknown superType ${type.superType}`);
      assert.ok(
        probes.some((probe) => superProbes.includes(probe)),
        `${type.id} does not repeat a fallback of its superType ${type.superType}`,
      );
    }
  });
}
