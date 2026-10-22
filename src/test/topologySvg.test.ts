import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { HdlIndex } from '../core/index';
import {
  buildModuleTopology,
  type ModuleTopology,
  type TopoChildPort,
  type TopoSignal,
} from '../core/topology';
import type { PortDir } from '../core/ast';
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

/** A model with one child that has `count` input ports, for the port cap. */
function wideChild(count: number): ModuleTopology {
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
  const ports: TopoChildPort[] = Array.from({ length: count }, (_, i) => ({
    name: `p${i}`,
    side: 'input',
    direction: 'input',
    connected: true,
  }));
  return {
    moduleName: 'wide',
    file: '/tmp/wide.v',
    nameRange: range,
    path: 'wide',
    top: 'wide',
    ancestors: [],
    inputs: [],
    outputs: [],
    children: [
      {
        id: 'u_wide',
        instName: 'u_wide',
        moduleName: 'leaf',
        defFile: '/tmp/leaf.v',
        file: '/tmp/wide.v',
        range,
        nameRange: range,
        moduleNameRange: range,
        resolved: true,
        ports,
      },
    ],
    edges: [],
    warnings: [],
  };
}

/** A model with an inout port and an instance with every port direction. */
function mixedDirections(): ModuleTopology {
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
  const signal = (name: string, direction: PortDir): TopoSignal => ({
    name,
    declName: name,
    side: direction === 'output' ? 'output' : 'input',
    direction,
    width: 1,
    file: '/tmp/mixed.v',
    range,
    nameRange: range,
  });
  const port = (name: string, direction: PortDir): TopoChildPort => ({
    name,
    side: direction === 'output' ? 'output' : 'input',
    direction,
    width: 1,
    connected: true,
  });
  return {
    moduleName: 'mixed',
    file: '/tmp/mixed.v',
    nameRange: range,
    path: 'mixed',
    top: 'mixed',
    ancestors: [],
    inputs: [signal('clk', 'input'), signal('pad', 'inout')],
    outputs: [signal('q', 'output')],
    children: [
      {
        id: 'u_ctrl',
        instName: 'u_ctrl',
        moduleName: 'ctrl',
        defFile: '/tmp/ctrl.v',
        file: '/tmp/mixed.v',
        range,
        nameRange: range,
        moduleNameRange: range,
        resolved: true,
        ports: [
          port('in_x', 'input'),
          port('in_y', 'input'),
          port('out_z', 'output'),
          port('bio_w', 'inout'),
        ],
      },
      {
        id: 'u_leaf',
        instName: 'u_leaf',
        moduleName: 'leaf',
        defFile: '/tmp/leaf.v',
        file: '/tmp/mixed.v',
        range,
        nameRange: range,
        moduleNameRange: range,
        resolved: true,
        ports: [port('in_q', 'input')],
      },
    ],
    edges: [
      {
        from: { kind: 'signal', name: 'clk' },
        to: { kind: 'child', child: 'u_ctrl', port: 'in_x', side: 'input' },
        kind: 'port',
      },
      {
        from: { kind: 'signal', name: 'pad' },
        to: { kind: 'child', child: 'u_ctrl', port: 'bio_w', side: 'input' },
        kind: 'port',
      },
      {
        from: { kind: 'child', child: 'u_ctrl', port: 'out_z', side: 'output' },
        to: { kind: 'signal', name: 'q' },
        kind: 'port',
      },
      {
        from: { kind: 'child', child: 'u_ctrl', port: 'out_z', side: 'output' },
        to: { kind: 'child', child: 'u_leaf', port: 'in_q', side: 'input' },
        kind: 'port',
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

test('svg: bundling merges the ports of an instance by direction', () => {
  const model = mixedDirections();
  const svg = renderFrameSvg(input(model), { signalMode: 'bundled' }).svg;
  // One line per category: `in` and `inout` on the left of u_ctrl, `out` on
  // its right, `in` on the left of u_leaf.
  assert.ok(svg.includes('>in (2)<'), 'the two input ports are one line');
  assert.ok(svg.includes('>out (1)<'), 'the output port is one line');
  assert.ok(svg.includes('>inout (1)<'), 'the inout port is one line');
  assert.equal((svg.match(/class="port-group"/g) ?? []).length, 4);

  // The port names are not spelled out on the box any more.
  assert.ok(!svg.includes('>in_x</text>'), 'the port names are not written on the box');
  const all = renderFrameSvg(input(model), { signalMode: 'all' }).svg;
  assert.ok(all.includes('>in_x</text>'), 'the other modes still spell them out');
});

test('svg: an inout port gets a bus of its own', () => {
  const model = mixedDirections();
  const svg = renderFrameSvg(input(model), { signalMode: 'bundled' }).svg;
  assert.ok(svg.includes('inputs (1)'), 'the input bus holds the pure inputs only');
  assert.ok(svg.includes('inout (1)'), 'the inout port is a bus of its own');
  assert.ok(svg.includes('outputs (1)'));
  // Three buses: inputs, inout, outputs.
  assert.equal((svg.match(/stroke-width="4"/g) ?? []).length, 3);
});

test('svg: bundling keeps the link between two instances', () => {
  const model = mixedDirections();
  const svg = renderFrameSvg(input(model), { signalMode: 'bundled' }).svg;
  assert.equal((svg.match(/<g class="edge">/g) ?? []).length, model.edges.length);
});

test('svg: the bundled picture keeps every port name in a tooltip', () => {
  const model = mixedDirections();
  const svg = renderFrameSvg(input(model), { signalMode: 'bundled' }).svg;
  const groups = [...svg.matchAll(/<g class="port-group"><title>([^<]*)<\/title>/g)].map((m) => m[1]);
  assert.equal(groups.length, 4, 'one tooltip per merged line');
  const names = groups.flatMap((t) => t.split('\n'));
  for (const c of model.children) {
    for (const p of c.ports) {
      assert.ok(names.includes(p.name), `${p.name} is in a tooltip`);
    }
  }
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

test('svg: a child with many ports is capped and its box still hugs the content', () => {
  const model = wideChild(100);
  const svg = renderFrameSvg(input(model)).svg;

  const at = svg.indexOf('<title>u_wide</title>');
  assert.notEqual(at, -1, 'the child is in the picture');
  const closeG = svg.indexOf('</g>', at);
  const closeA = svg.indexOf('</a>', at);
  const stop = closeG < 0 ? closeA : closeA < 0 ? closeG : Math.min(closeG, closeA);
  const box = svg.slice(at, stop);

  assert.ok(box.includes('+92 more'), 'the overflow is announced');

  const rect = /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(box);
  assert.ok(rect, 'the child has a box');
  const boxBottom = Number(rect[2]) + Number(rect[4]);

  const stubYs = [...box.matchAll(/<line x1="[\d.]+" y1="([\d.]+)"/g)].map((m) => Number(m[1]));
  const rows = [...new Set(stubYs)].sort((a, b) => a - b);
  assert.equal(rows.length, 9, 'the header rule and eight port stubs');
  const pitch = (rows[rows.length - 1] - rows[1]) / (rows.length - 2);

  const more = /y="([\d.]+)"[^>]*>\+92 more<\/text>/.exec(box);
  assert.ok(more, 'the overflow line is drawn');
  const moreY = Number(more[1]);
  assert.ok(moreY <= boxBottom, 'the overflow line stays inside the box');
  assert.ok(boxBottom - moreY < pitch * 2, 'the box hugs the content instead of the port count');

  const height = Number(/height="(\d+)"/.exec(svg)?.[1]);
  assert.ok(height < 700, `the picture stays a normal size (${height}px)`);
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
