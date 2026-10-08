/**
 * Dev helper: dump the parse result for a file so the IR can be eyeballed.
 * Usage: node out/tools/dump.js <file> [module]
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseSource } from '../core/parser';

const file = process.argv[2];
if (!file) {
  console.error('usage: dump <file> [moduleName]');
  process.exit(1);
}
const only = process.argv[3];
const src = fs.readFileSync(file, 'utf8');
const res = parseSource(path.resolve(file), src);

for (const m of res.modules) {
  if (only && m.name !== only) {
    continue;
  }
  console.log(`\n=== module ${m.name} (${m.kind}) @ ${path.basename(m.file)}:${m.startLine} ===`);
  console.log(`  params : ${m.params.map((p) => `${p.name}=${p.value?.raw ?? ''}`).join(', ')}`);
  console.log(`  ports  :`);
  for (const p of m.ports) {
    const dt = p.dataType.t === 'unknown' ? '?' : p.dataType.t;
    const rng = (p.dataType as { range?: { msb: { raw: string }; lsb: { raw: string } } }).range;
    console.log(`    ${p.direction.padEnd(6)} ${p.name.padEnd(12)} : ${dt}${rng ? ` [${rng.msb.raw}:${rng.lsb.raw}]` : ''}${p.ansi ? '' : ' (non-ansi)'}`);
  }
  console.log(`  decls  : ${m.decls.map((d) => `${d.name}:${d.kind}`).join(', ')}`);
  console.log(`  funcs  : ${m.funcs.map((f) => `${f.kind} ${f.name}(${f.args.map((a) => a.name).join(',')})`).join(', ')}`);
  console.log(`  insts  :`);
  for (const i of m.instances) {
    console.log(`    ${i.moduleName} ${i.name}${i.arrayCount ? ' [array]' : ''}${i.inGenerate ? ' [gen]' : ''}${i.conditional ? ' [cond]' : ''}`);
    for (const c of i.connections) {
      console.log(`        .${c.portName || '<pos>'} (${c.rawExpr}) -> ${c.refs.map((r) => r.fullPath).join(', ')}`);
    }
    if (i.paramOverrides.length) {
      console.log(`        params: ${i.paramOverrides.map((p) => (p.name ? `${p.name}=` : '') + p.expr.raw).join(', ')}`);
    }
  }
  console.log(`  assigns: ${m.assigns.length}`);
  for (const a of m.assigns.slice(0, 12)) {
    console.log(`    [${a.inAlways ? 'proc' : 'cont'}] ${a.lhs.map((r) => r.fullPath).join(',')} <= ${a.rhs.map((r) => r.fullPath).join(',')}`);
  }
  console.log(`  defparams: ${m.defparams.map((d) => `${d.target}.${d.param}=${d.expr.raw}`).join(', ')}`);
  const unknown = m.refs.filter((r) => r.kind === 'unknown' && !r.isDecl);
  if (unknown.length) {
    console.log(`  UNKNOWN refs: ${[...new Set(unknown.map((r) => r.fullPath))].join(', ')}`);
  }
}
console.log(`\ntotal modules: ${res.modules.map((m) => m.name).join(', ')}`);
console.log(`includes: ${res.includes.join(', ')}`);
console.log(`parse time: ${res.timeMs}ms`);
