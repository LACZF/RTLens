import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { HdlIndex } from '../core/index';
import { buildModuleTopology, type ModuleTopology } from '../core/topology';
import {
  renderFrameSvg,
  renderFramesSvg,
  topologyFileNames,
  type FrameInput,
  type NavRef,
} from '../core/topologySvg';

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

function indexDir(dir: string): HdlIndex {
  const index = new HdlIndex();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (/\.(v|sv|svh|vh)$/.test(e.name)) {
        index.addFile(p, fs.readFileSync(p, 'utf8'));
      }
    }
  };
  walk(dir);
  return index;
}

const LIB = indexDir(path.join(FIXTURES, 'lib'));

function chipTop(): ModuleTopology {
  const def = LIB.resolveModule('chip_top');
  assert.ok(def);
  return buildModuleTopology(LIB, def);
}

function input(model: ModuleTopology, children: Record<string, NavRef> = {}): FrameInput {
  return {
    key: model.path,
    model,
    self: { href: 'self.html' },
    crumbs: model.ancestors.map((a) => ({ label: a.moduleName, ref: { href: `${a.moduleName}.html` } })),
    children: Object.fromEntries(model.children.map((c) => [c.id, children[c.id] ?? { href: `${c.instName}.svg` }])),
  };
}

/** A model built by hand, for shapes the fixtures do not have. */
function synthetic(): ModuleTopology {
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
  return {
    moduleName: 'mod<x>&"',
    file: '/tmp/a<b>.v',
    nameRange: range,
    path: 'mod<x>&"',
    top: 'mod<x>&"',
    ancestors: [],
    inputs: [
      {
        name: 'a<b>&"',
        declName: 'a<b>&"',
        side: 'input',
        direction: 'input',
        width: 8,
        file: '/tmp/a<b>.v',
        range,
        nameRange: range,
      },
    ],
    outputs: [],
    children: [
      {
        id: 'u1',
        instName: 'u1',
        moduleName: 'leaf',
        defFile: '/tmp/leaf.v',
        file: '/tmp/a<b>.v',
        range,
        nameRange: range,
        moduleNameRange: range,
        resolved: true,
        ports: [{ name: 'p', side: 'input', direction: 'input', connected: true }],
      },
      {
        id: 'u2',
        instName: 'u2',
        moduleName: 'missing',
        file: '/tmp/a<b>.v',
        range,
        nameRange: range,
        moduleNameRange: range,
        resolved: false,
        ports: [],
      },
    ],
    edges: [
      {
        from: { kind: 'signal', name: 'a<b>&"' },
        to: { kind: 'child', child: 'u1', port: 'p', side: 'input' },
        kind: 'expression',
        label: 'x ? y : z',
      },
    ],
    warnings: [],
  };
}

test('svg: a frame is a standalone document', () => {
  const model = chipTop();
  const svg = renderFrameSvg(input(model)).svg;
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.trimEnd().endsWith('</svg>'));
  assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /viewBox="0 0 \d+ \d+"/);
  assert.match(svg, /<title>[^<]+<\/title>/);
  assert.match(svg, /<desc>[^<]+<\/desc>/);
});

test('svg: a frame carries no code, so it can be pasted anywhere', () => {
  const model = chipTop();
  for (const mode of ['all', 'hidden', 'bundled'] as const) {
    const svg = renderFrameSvg(input(model), { signalMode: mode }).svg;
    assert.ok(!/<script/i.test(svg), `${mode}: no script`);
    assert.ok(!/\son[a-z]+\s*=/i.test(svg), `${mode}: no event handler`);
    assert.ok(!/javascript:/i.test(svg), `${mode}: no javascript url`);
  }
});

test('svg: every number in the picture is finite and inside the canvas', () => {
  const model = chipTop();
  for (const mode of ['all', 'hidden', 'bundled'] as const) {
    const svg = renderFrameSvg(input(model), { signalMode: mode }).svg;
    assert.ok(!/\b(NaN|Infinity|undefined|null)\b/.test(svg), `${mode}: no broken number`);
    const w = Number(/width="(\d+)"/.exec(svg)?.[1]);
    const h = Number(/height="(\d+)"/.exec(svg)?.[1]);
    assert.ok(w > 0 && h > 0);
    for (const m of svg.matchAll(/<rect ([^>]*)\/?>/g)) {
      const x = Number(/\bx="(-?[\d.]+)"/.exec(m[1])?.[1] ?? 0);
      const y = Number(/\by="(-?[\d.]+)"/.exec(m[1])?.[1] ?? 0);
      const rw = Number(/\bwidth="(-?[\d.]+)"/.exec(m[1])?.[1] ?? 0);
      const rh = Number(/\bheight="(-?[\d.]+)"/.exec(m[1])?.[1] ?? 0);
      assert.ok(x >= 0 && y >= 0, `${mode}: rect starts inside`);
      assert.ok(x + rw <= w + 0.5 && y + rh <= h + 0.5, `${mode}: rect ends inside`);
    }
  }
});

test('svg: every port and every instance is named', () => {
  const model = chipTop();
  const svg = renderFrameSvg(input(model)).svg;
  for (const s of [...model.inputs, ...model.outputs]) {
    assert.ok(svg.includes(s.name), `${s.name} is drawn`);
  }
  for (const c of model.children) {
    assert.ok(svg.includes(c.instName), `${c.instName} is drawn`);
    assert.ok(svg.includes(c.moduleName), `${c.moduleName} is drawn`);
  }
});

test('svg: hiding the signals keeps the instances and the names', () => {
  const model = chipTop();
  const all = renderFrameSvg(input(model), { signalMode: 'all' }).svg;
  const hidden = renderFrameSvg(input(model), { signalMode: 'hidden' }).svg;
  const rects = (s: string): number => (s.match(/<rect /g) ?? []).length;
  // The signal rows are gone, so the picture is narrower and has fewer boxes.
  assert.ok(rects(hidden) < rects(all), 'fewer boxes without the signal rows');
  const width = (s: string): number => Number(/width="(\d+)"/.exec(s)?.[1]);
  assert.ok(width(hidden) < width(all), 'a narrower picture');
  // The names survive on the side rails, and the instances stay.
  for (const s of [...model.inputs, ...model.outputs]) {
    assert.ok(hidden.includes(s.name), `${s.name} is still labelled`);
  }
  for (const c of model.children) {
    assert.ok(hidden.includes(c.instName), `${c.instName} is still drawn`);
  }
});

test('svg: bundling merges the signals into one bus per side', () => {
  const model = chipTop();
  const svg = renderFrameSvg(input(model), { signalMode: 'bundled' }).svg;
  assert.ok(svg.includes(`inputs (${model.inputs.length})`));
  assert.ok(svg.includes(`outputs (${model.outputs.length})`));
  // One trunk per side, drawn four units wide.
  assert.equal((svg.match(/stroke-width="4"/g) ?? []).length, 2);
});

test('svg: text and attribute values are escaped', () => {
  const svg = renderFrameSvg(input(synthetic())).svg;
  assert.ok(svg.includes('&lt;x&gt;'));
  assert.ok(svg.includes('&amp;'));
  assert.ok(!svg.includes('<x>'), 'no raw angle brackets from a name');
  assert.ok(!svg.includes('a<b>.v"'), 'no raw file name breaks an attribute');
});

test('svg: a child is linked by key, by href or by source position', () => {
  const model = chipTop();
  const keyed = renderFrameSvg(
    input(model, { u_ctrl: { key: 'chip_top.u_ctrl' } }),
  ).svg;
  assert.ok(keyed.includes('data-nav="chip_top.u_ctrl"'));

  const linked = renderFrameSvg(
    input(model, { u_ctrl: { href: 'u_ctrl.svg' } }),
  ).svg;
  assert.ok(linked.includes('href="u_ctrl.svg"'));

  const sourced = renderFrameSvg(
    input(model, { u_ctrl: { src: { file: '/tmp/control.v', line: 4, character: 2 } } }),
  ).svg;
  assert.ok(sourced.includes('data-src="/tmp/control.v:4:2"'));
});

test('svg: an instance whose module is missing is marked as such', () => {
  const svg = renderFrameSvg(input(synthetic())).svg;
  assert.ok(svg.includes('stroke-dasharray'), 'the box is dashed');
  assert.ok(/not found|missing/i.test(svg), 'the title says what is wrong');
});

test('svg: a short expression is written on the wire', () => {
  const svg = renderFrameSvg(input(synthetic())).svg;
  assert.ok(svg.includes('x ? y : z'), 'the expression is visible');
});

test('svg: the dark theme is a different picture', () => {
  const model = chipTop();
  const light = renderFrameSvg(input(model)).svg;
  const dark = renderFrameSvg(input(model), { dark: true }).svg;
  assert.notEqual(light, dark);
  assert.ok(light.includes('#ffffff') || light.includes('#f8fafc'));
  assert.ok(dark.includes('#0f172a') || dark.includes('#1e293b'));
});

test('svg: the same input always draws the same picture', () => {
  const model = chipTop();
  const a = renderFrameSvg(input(model)).svg;
  const b = renderFrameSvg(input(model)).svg;
  assert.equal(a, b);
});

test('svg: file names are unique and sanitised', () => {
  const names = topologyFileNames([
    { key: 'a', moduleName: 'chip_top' },
    { key: 'b', moduleName: 'chip_top' },
    { key: 'c', moduleName: 'my module!' },
  ]);
  assert.equal(new Set(names).size, 3);
  assert.ok(names.every((n) => n.endsWith('.svg')));
  assert.ok(!names.some((n) => /[^\w.-]/.test(n)), 'no unsafe character in a file name');
  assert.equal(names[2], 'my_module_-1.svg');
  // A second instance of the same module gets its own file.
  assert.equal(names[1], 'chip_top-2.svg');
});

test('svg: a set of frames is named after the modules it draws', () => {
  const model = chipTop();
  const frames: FrameInput[] = [
    input(model),
    { ...input(model), key: 'chip_top.u_ctrl', model: { ...model, moduleName: 'control' } },
  ];
  const rendered = renderFramesSvg(frames);
  assert.deepEqual(
    rendered.map((r) => r.fileName),
    topologyFileNames(frames.map((f) => ({ key: f.key, moduleName: f.model.moduleName }))),
  );
  assert.equal(rendered[0].key, 'chip_top');
});
