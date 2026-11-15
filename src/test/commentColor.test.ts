import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

const ROOT = path.join(__dirname, '..', '..');

interface TextMateRule {
  scope: string | string[];
  settings: { foreground?: string };
}

interface TokenColors {
  textMateRules?: TextMateRule[];
  [theme: string]: unknown;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')) as T;
}

function commentScopes(): string[] {
  const grammar = readJson<{ repository: { comments: { patterns: { name?: string }[] } } }>(
    path.join('syntaxes', 'verilog.tmLanguage.json'),
  );
  return grammar.repository.comments.patterns
    .map((pattern) => pattern.name)
    .filter((name): name is string => typeof name === 'string');
}

function customizations(): TokenColors {
  const manifest = readJson<{ contributes: { configurationDefaults: { 'editor.tokenColorCustomizations': TokenColors } } }>(
    'package.json',
  );
  return manifest.contributes.configurationDefaults['editor.tokenColorCustomizations'];
}

function rulesOf(colors: TokenColors | undefined): TextMateRule[] {
  return colors?.textMateRules ?? [];
}

function scopesOf(rules: TextMateRule[]): string[] {
  return rules.flatMap((rule) => (Array.isArray(rule.scope) ? rule.scope : [rule.scope]));
}

function isGreen(hex: string | undefined): boolean {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
  if (!match) {
    return false;
  }
  const [red, green, blue] = match.slice(1, 4).map((value) => parseInt(value, 16));
  return green > red + 16 && green > blue + 16;
}

function commentRules(rules: TextMateRule[]): TextMateRule[] {
  return rules.filter((rule) =>
    (Array.isArray(rule.scope) ? rule.scope : [rule.scope]).every((scope) => scope.startsWith('comment.')),
  );
}

function expectCommentOnlyGreen(rules: TextMateRule[], where: string): void {
  const scopes = commentScopes();
  assert.ok(scopes.length >= 3, 'grammar declares the three comment kinds');
  const coloured = scopesOf(commentRules(rules));
  for (const scope of scopes) {
    assert.ok(coloured.includes(scope), `${where}: ${scope} has a colour rule`);
  }
  for (const rule of commentRules(rules)) {
    assert.ok(isGreen(rule.settings.foreground), `${where}: ${rule.settings.foreground} is green`);
    for (const scope of Array.isArray(rule.scope) ? rule.scope : [rule.scope]) {
      assert.match(scope, /^comment\..+\.verilog$/, `${where}: ${scope} stays inside comments`);
    }
  }
}

test('comments are green whatever the theme calls its comment colour', () => {
  expectCommentOnlyGreen(rulesOf(customizations()), 'default');
});

test('light themes get the darker green instead of the dark-theme one', () => {
  const light = customizations()['[*Light*]'] as TokenColors | undefined;
  assert.ok(light, 'light theme override exists');
  expectCommentOnlyGreen(rulesOf(light), 'light');
});
