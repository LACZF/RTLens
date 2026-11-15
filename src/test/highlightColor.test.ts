import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

const ROOT = path.join(__dirname, '..', '..');

const IDENTIFIER_PREFIXES = [
  'variable.',
  'entity.name.',
  'entity.other.attribute-name.',
  'support.type.',
  'support.function.',
  'constant.other.enum-member.',
];

interface TextMateRule {
  scope: string | string[];
  settings: { foreground?: string };
}

interface TokenColors {
  textMateRules?: TextMateRule[];
  [theme: string]: unknown;
}

interface SemanticColors {
  rules?: Record<string, { foreground?: string }>;
  [theme: string]: unknown;
}

interface Manifest {
  contributes: {
    configurationDefaults: {
      'editor.tokenColorCustomizations': TokenColors;
      'editor.semanticTokenColorCustomizations': SemanticColors;
    };
    semanticTokenTypes: { id: string }[];
  };
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')) as T;
}

function grammarScopes(): string[] {
  const grammar = readJson<Record<string, unknown>>(path.join('syntaxes', 'verilog.tmLanguage.json'));
  const scopes = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== 'object' || node === null) {
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.name === 'string') {
      scopes.add(record.name);
    }
    for (const [key, value] of Object.entries(record)) {
      if (key !== 'name' && key !== 'comment' && key !== 'begin' && key !== 'end' && key !== 'match' && key !== 'include') {
        walk(value);
      }
    }
  };
  walk(grammar);
  return [...scopes].filter((scope) => IDENTIFIER_PREFIXES.some((prefix) => scope.startsWith(prefix))).sort();
}

function customizations(): { dark: TokenColors; light: TokenColors } {
  const manifest = readJson<Manifest>('package.json');
  const colors = manifest.contributes.configurationDefaults['editor.tokenColorCustomizations'];
  const light = colors['[*Light*]'] as TokenColors | undefined;
  return { dark: colors, light: light ?? {} };
}

function semanticCustomizations(): { dark: SemanticColors; light: SemanticColors } {
  const manifest = readJson<Manifest>('package.json');
  const colors = manifest.contributes.configurationDefaults['editor.semanticTokenColorCustomizations'];
  const light = colors['[*Light*]'] as SemanticColors | undefined;
  return { dark: colors, light: light ?? {} };
}

function scopesOf(rules: TextMateRule[]): string[] {
  return rules.flatMap((rule) => (Array.isArray(rule.scope) ? rule.scope : [rule.scope]));
}

function colourFor(colors: TokenColors, scope: string): string | undefined {
  for (const rule of colors.textMateRules ?? []) {
    if (scopesOf([rule]).some((candidate) => scope === candidate || scope.startsWith(`${candidate}.`))) {
      return rule.settings.foreground;
    }
  }
  return undefined;
}

function expectHex(colour: string | undefined, where: string): void {
  assert.match(colour ?? '', /^#[0-9a-f]{6}$/i, `${where}: ${colour} is a six-digit hex colour`);
}

test('every identifier scope the grammar emits is coloured without asking the theme', () => {
  const scopes = grammarScopes();
  assert.ok(scopes.length >= 15, `grammar exposes ${scopes.length} identifier scopes`);
  const { dark } = customizations();
  for (const scope of scopes) {
    const colour = colourFor(dark, scope);
    assert.ok(colour, `${scope} has a forced dark colour`);
    expectHex(colour, scope);
  }
});

test('light themes get their own identifier palette instead of the dark one', () => {
  const { light } = customizations();
  assert.ok(light.textMateRules?.length, 'light theme override exists');
  for (const scope of grammarScopes()) {
    const colour = colourFor(light, scope);
    assert.ok(colour, `${scope} has a forced light colour`);
    expectHex(colour, scope);
  }
});

test('every semantic token type is coloured without asking the theme', () => {
  const manifest = readJson<Manifest>('package.json');
  const { dark, light } = semanticCustomizations();
  assert.ok(dark.rules && light.rules, 'both semantic palettes exist');
  for (const { id } of manifest.contributes.semanticTokenTypes) {
    expectHex(dark.rules[id]?.foreground, `${id} dark`);
    expectHex(light.rules[id]?.foreground, `${id} light`);
  }
});

test('forced code colours stay on identifier scopes and never repaint keywords or punctuation', () => {
  for (const [where, colors] of Object.entries(customizations())) {
    for (const scope of scopesOf(colors.textMateRules ?? [])) {
      if (scope.startsWith('comment.')) {
        continue;
      }
      assert.ok(
        IDENTIFIER_PREFIXES.some((prefix) => scope.startsWith(prefix)),
        `${where}: ${scope} is an identifier scope`,
      );
    }
  }
});
