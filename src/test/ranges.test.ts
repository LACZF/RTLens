import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { parseSource } from '../core/parser';
import { tokenize } from '../core/lexer';

/**
 * Range invariants.
 *
 * Every position the index hands to VS Code ends up as a cursor jump, a
 * selection or a semantic token, so a position that is off by one is not a
 * cosmetic problem: it lands the user in the wrong place, and VS Code clamps it
 * silently, which makes the bug look like "the jump is imprecise" instead of
 * "the offsets are wrong".
 *
 * Rather than assert on individual declarations, this walks the whole IR of
 * every fixture and every token, so any field added later is covered without
 * touching the test.
 */

interface Walker {
  where: string;
  line: number;
  character: number;
  label: string;
}

function collect(
  value: unknown,
  path: string,
  out: Walker[],
  seen = new Set<unknown>(),
  label = '',
): void {
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((v, i) => collect(v, `${path}[${i}]`, out, seen, label));
    return;
  }
  const rec = value as Record<string, unknown>;
  if (typeof rec.line === 'number' && typeof rec.character === 'number' && !('start' in rec)) {
    out.push({ where: path, line: rec.line, character: rec.character, label });
  }
  if (isPos(rec.start) && isPos(rec.end)) {
    out.push({ where: `${path}.start`, ...rec.start, label });
    out.push({ where: `${path}.end`, ...rec.end, label });
  }
  for (const [k, v] of Object.entries(rec)) {
    if (k === 'parent' || k === 'resolved') {
      continue;
    }
    collect(v, path ? `${path}.${k}` : k, out, seen, k);
  }
}

function isPos(v: unknown): v is { line: number; character: number } {
  return (
    v !== null &&
    typeof v === 'object' &&
    typeof (v as { line?: unknown }).line === 'number' &&
    typeof (v as { character?: unknown }).character === 'number'
  );
}

/** Longest character index that is still on `line` of `text`. */
function lineLength(text: string, line: number): number {
  const lines = text.split('\n');
  if (line < 0 || line >= lines.length) {
    return -1;
  }
  return (lines[line].replace(/\r$/, '')).length;
}

function checkAll(text: string, positions: Walker[], what: string): void {
  const lineCount = text.split('\n').length;
  for (const p of positions) {
    assert.ok(
      Number.isInteger(p.line) && p.line >= 0 && p.line < lineCount,
      `${what}: ${p.where} (${p.label}) has line ${p.line}, file has ${lineCount}`,
    );
    const len = lineLength(text, p.line);
    assert.ok(
      Number.isInteger(p.character) && p.character >= 0 && p.character <= len,
      `${what}: ${p.where} (${p.label}) has character ${p.character}, line ${p.line} has ${len}`,
    );
  }
}

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');

function fixtureFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...fixtureFiles(full));
    } else if (/\.(v|sv|svh|vh|vlt)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Sources that stress offsets: CRLF, tabs, long lines, deep nesting, unicode. */
const ADVERSARIAL: [string, string][] = [
  ['crlf', 'module a;\r\n  wire w;\r\n  assign w = 1\'b0;\r\nendmodule\r\n'],
  ['no trailing newline', 'module a; wire w; endmodule'],
  ['tabs', 'module\ta;\n\twire\t\tw;\n\tassign\t\tw\t=\t1\'b0;\nendmodule\n'],
  ['block comment spanning lines', '/**\n * x\n */\nmodule a; wire w; endmodule\n'],
  ['string with newline escape', 'module a; wire [8*3-1:0] w; initial $display("a\\nb"); endmodule\n'],
  ['unterminated block comment', 'module a; wire w;\n/* never closed\n'],
  ['unterminated string', 'module a; wire w; initial $display("oops); endmodule\n'],
  ['very long line', `module a; wire ${'w'.repeat(500)}; assign w = 1'b0; endmodule\n`],
  ['crlf inside block comment', 'module a;\r\n/*\r\n*/\r\nwire w;\r\nendmodule\r\n'],
];

test('ranges: every position in the IR stays inside its file', () => {
  const files = fixtureFiles(FIXTURES);
  assert.ok(files.length >= 4, `expected fixtures, found ${files.length}`);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const result = parseSource(file, text);
    const positions: Walker[] = [];
    for (const mod of result.modules) {
      collect(mod, `module ${mod.name}`, positions);
    }
    checkAll(text, positions, path.relative(FIXTURES, file));
    // Guard against a vacuous test: if the IR shape changes and the walker stops
    // matching, the assertions below would pass over nothing.
    assert.ok(positions.length > 20, `${file}: only ${positions.length} positions found`);
  }
});

test('ranges: every position stays inside offset-heavy sources', () => {
  for (const [name, text] of ADVERSARIAL) {
    const result = parseSource(name, text);
    const positions: Walker[] = [];
    for (const mod of result.modules) {
      collect(mod, `module ${mod.name}`, positions);
    }
    checkAll(text, positions, name);
    // Every one of these sources declares a module, so each must yield at least
    // its name range; an unterminated construct must not swallow the rest.
    assert.ok(positions.length > 0, `${name}: nothing was indexed`);
  }
});

test('ranges: a range never ends before it starts', () => {
  for (const [name, text] of ADVERSARIAL) {
    const result = parseSource(name, text);
    for (const mod of result.modules) {
      const ranges: { where: string; start: { line: number; character: number }; end: { line: number; character: number } }[] = [];
      const walk = (v: unknown, p: string, seen = new Set<unknown>()): void => {
        if (v === null || typeof v !== 'object' || seen.has(v)) {
          return;
        }
        seen.add(v);
        if (Array.isArray(v)) {
          v.forEach((x, i) => walk(x, `${p}[${i}]`, seen));
          return;
        }
        const rec = v as Record<string, unknown>;
        if (isPos(rec.start) && isPos(rec.end)) {
          ranges.push({ where: p, start: rec.start, end: rec.end });
        }
        for (const [k, x] of Object.entries(rec)) {
          if (k !== 'parent' && k !== 'resolved') {
            walk(x, p ? `${p}.${k}` : k, seen);
          }
        }
      };
      walk(mod, `module ${mod.name}`);
      for (const r of ranges) {
        const ordered =
          r.start.line < r.end.line || (r.start.line === r.end.line && r.start.character <= r.end.character);
        assert.ok(ordered, `${name}: ${r.where} ends before it starts`);
      }
    }
  }
});

test('ranges: token positions cover the source without gaps that matter', () => {
  for (const [name, text] of ADVERSARIAL) {
    const tokens = tokenize(text);
    assert.ok(tokens.length > 0, `${name}: no tokens`);
    let previousEnd = 0;
    for (const t of tokens) {
      checkAll(text, [{ where: `token ${t.text}`, ...t.range.start, label: t.kind }], name);
      checkAll(text, [{ where: `token ${t.text}`, ...t.range.end, label: t.kind }], name);
      const ordered =
        t.range.start.line < t.range.end.line ||
        (t.range.start.line === t.range.end.line && t.range.start.character <= t.range.end.character);
      assert.ok(ordered, `${name}: token ${t.text} (${t.kind}) ends before it starts`);
      // Tokens come in source order, so no token may start before the previous
      // one ended; only whitespace may be skipped between them.
      const here = t.range.start.line * 1e6 + t.range.start.character;
      assert.ok(here >= previousEnd, `${name}: token ${t.kind} ${t.text} at ${t.range.start.line}:${t.range.start.character} goes backwards`);
      previousEnd = t.range.end.line * 1e6 + t.range.end.character;
    }
  }
});
