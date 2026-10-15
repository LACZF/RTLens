import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

/**
 * Configuration wiring.
 *
 * A setting that appears in the settings UI but is never read - or a field that
 * is parsed out of the configuration and then never used - is worse than no
 * setting at all: the user changes it, sees nothing happen, and concludes the
 * extension is broken. Both directions are checked here against the sources, so
 * the check needs no extension host.
 */

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...tsFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const CONFIG = path.join(SRC, 'vscode', 'config.ts');
const SOURCES = tsFiles(SRC)
  .filter((f) => f !== CONFIG && !f.includes(`${path.sep}test${path.sep}`))
  .map((f) => ({ file: path.relative(ROOT, f), text: read(f) }));

test('config: every parsed field is used somewhere', () => {
  const config = read(CONFIG);
  const body = config.slice(config.indexOf('export interface HdlConfig'));
  assert.ok(body.length > 0, 'HdlConfig not found in config.ts');
  const fields = [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
  assert.ok(fields.length >= 8, `only found ${fields.length} config fields`);
  for (const field of fields) {
    const users = SOURCES.filter((s) => new RegExp(`\\.${field}\\b`).test(s.text));
    assert.ok(
      users.length > 0,
      `HdlConfig.${field} is parsed but never read outside config.ts - it is a dead setting`,
    );
  }
});

test('config: every setting in the manifest is read', () => {
  const manifest = JSON.parse(read(path.join(ROOT, 'package.json')));
  const props: Record<string, unknown> = manifest.contributes.configuration.properties;
  const keys = Object.keys(props);
  assert.ok(keys.length >= 8, `only found ${keys.length} settings`);
  const config = read(CONFIG);
  for (const key of keys) {
    // `readConfig` looks the key up without the section, as a literal, so the
    // remainder of the key has to appear in the source.
    const scoped = key.startsWith('hdl.connectView.') ? key.slice('hdl.connectView.'.length) : key;
    assert.ok(
      config.includes(`'${scoped}'`),
      `${key} is in package.json but readConfig never reads it - it is a dead setting`,
    );
  }
});

test('config: numeric settings have a floor', () => {
  const manifest = JSON.parse(read(path.join(ROOT, 'package.json')));
  const props = manifest.contributes.configuration.properties as Record<
    string,
    { type?: string; minimum?: number; default?: unknown }
  >;
  // A budget of zero or a negative one either disables the guard it exists for
  // or makes the expansion loop misbehave; the schema is the only place the
  // user can be stopped.
  for (const [key, schema] of Object.entries(props)) {
    if (schema.type !== 'number') {
      continue;
    }
    // A handful of settings can be 0 to mean "no cap": the graph signal cap,
    // and the Composition tree's own depth / node budget (both unlimited by
    // default).
    if (
      key === 'hdl.connectView.graph.maxSignalsPerGroup' ||
      key === 'hdl.connectView.composition.maxDepth' ||
      key === 'hdl.connectView.composition.maxInstances'
    ) {
      assert.ok(
        typeof schema.minimum === 'number' && schema.minimum >= 0,
        `${key} must allow 0 or more`,
      );
      assert.ok(typeof schema.default === 'number', `${key} has no numeric default`);
      continue;
    }
    assert.ok(
      typeof schema.minimum === 'number' && schema.minimum > 0,
      `${key} is numeric with no positive minimum in package.json`,
    );
    assert.ok(typeof schema.default === 'number', `${key} has no numeric default`);
  }
});