/**
 * Synthetic large-workspace benchmark: `SCALE_MODULES` modules of
 * `SCALE_SIGNALS` signals each, spread over `SCALE_FILES` files.
 *
 * Reports parse+index time, the first jump-table build, steady-state jump
 * lookups, name lookup and `moduleAtLine` - the three hot paths a cursor hit
 * goes through. Run with:
 *
 *   npm run compile && node out/tools/scalePerf.js
 */

import { HdlIndex } from '../core/index';

const MODULES = Number(process.env.SCALE_MODULES ?? 400);
const SIGNALS = Number(process.env.SCALE_SIGNALS ?? 100);
const FILES = Number(process.env.SCALE_FILES ?? 20);

function workspaceSource(m: number): string {
  const lines: string[] = [];
  for (let i = 0; i < m; i++) {
    lines.push(`module mod${i} (input wire clk);`);
    for (let s = 0; s < SIGNALS; s++) {
      lines.push(`  wire [15:0] sig${i}_${s};`);
    }
    lines.push(`  assign sig${i}_0 = {16{clk}};`);
    lines.push('endmodule');
    lines.push('');
  }
  return lines.join('\n');
}

function nsPerCall(totalNs: number, calls: number): string {
  return `${(totalNs / calls).toFixed(0)} ns/call`;
}

function main(): void {
  const perFile = Math.ceil(MODULES / FILES);
  const sources: string[] = [];
  for (let f = 0; f < FILES; f++) {
    sources.push(workspaceSource(perFile));
  }

  const index = new HdlIndex();
  const parseStart = process.hrtime.bigint();
  for (let f = 0; f < FILES; f++) {
    index.addFile(`/w/f${f}.v`, sources[f]);
  }
  const parseNs = Number(process.hrtime.bigint() - parseStart);
  console.log(
    `index: ${MODULES} modules x ${SIGNALS} signals over ${FILES} files in ${(parseNs / 1e6).toFixed(0)} ms`,
  );

  // Jump: the first query pays for the build, every later one is a lookup.
  const file = '/w/f0.v';
  const src = sources[0];
  const srcLines = src.split('\n');
  const assignLine = 1 + SIGNALS;
  const col = srcLines[assignLine].indexOf('sig0_0');
  const buildStart = process.hrtime.bigint();
  const first = index.lookupJump(file, src, assignLine, col);
  const buildNs = Number(process.hrtime.bigint() - buildStart);
  console.log(
    `jump build: ${(buildNs / 1e6).toFixed(1)} ms, ${index.jumpEntryCount} relations held`,
  );
  if (!first?.target) {
    throw new Error('the benchmark lookup did not resolve');
  }

  const lookups = 10_000;
  const lookupStart = process.hrtime.bigint();
  for (let i = 0; i < lookups; i++) {
    const l = 2 + (i % (SIGNALS + 2));
    const text = srcLines[l] ?? '';
    const at = text.indexOf('sig');
    index.lookupJump(file, src, l, at >= 0 ? at : 0);
  }
  console.log(`jump lookup: ${nsPerCall(Number(process.hrtime.bigint() - lookupStart), lookups)} (${lookups} calls)`);

  // Name lookup inside one module, which is what hover and definition ask.
  const mod = index.modulesInFile(file)[0];
  const nameCalls = 100_000;
  const nameStart = process.hrtime.bigint();
  for (let i = 0; i < nameCalls; i++) {
    if (!index.findDecl(mod, `sig0_${i % SIGNALS}`)) {
      throw new Error('benchmark name lookup missed');
    }
  }
  console.log(`findDecl: ${nsPerCall(Number(process.hrtime.bigint() - nameStart), nameCalls)} (${nameCalls} calls)`);

  // The module under the cursor, asked for every line of the first file.
  const lines = srcLines.length;
  const lineCalls = 100_000;
  const lineStart = process.hrtime.bigint();
  for (let i = 0; i < lineCalls; i++) {
    index.moduleAtLine(file, i % lines);
  }
  console.log(`moduleAtLine: ${nsPerCall(Number(process.hrtime.bigint() - lineStart), lineCalls)} (${lineCalls} calls)`);

  console.log(
    `tables: ${index.jumpTableCount} held, ${index.jumpBuildCount} built, ${index.jumpEntryCount} relations`,
  );
}

main();
