import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { HdlIndex } from '../core/index';
import {
  buildModuleTopology,
  type ModuleTopology,
  type TopoChildPort,
  type TopoEdge,
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

function linkedPair(): ModuleTopology {
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
  const port = (name: string, direction: PortDir): TopoChildPort => ({
    name,
    side: direction === 'output' ? 'output' : 'input',
    direction,
    width: 1,
    connected: true,
  });
  const link = (fromPort: string, fromDir: PortDir, toPort: string, toDir: PortDir): TopoEdge => ({
    from: {
      kind: 'child',
      child: 'u_a',
      port: fromPort,
      side: fromDir === 'output' ? 'output' : 'input',
    },
    to: {
      kind: 'child',
      child: 'u_b',
      port: toPort,
      side: toDir === 'output' ? 'output' : 'input',
    },
    kind: 'port',
  });
  return {
    moduleName: 'pair',
    file: '/tmp/pair.v',
    nameRange: range,
    path: 'pair',
    top: 'pair',
    ancestors: [],
    inputs: [],
    outputs: [],
    children: [
      {
        id: 'u_a',
        instName: 'u_a',
        moduleName: 'a',
        defFile: '/tmp/a.v',
        file: '/tmp/pair.v',
        range,
        nameRange: range,
        moduleNameRange: range,
        resolved: true,
        ports: [port('o1', 'output'), port('o2', 'output'), port('io1', 'inout')],
      },
      {
        id: 'u_b',
        instName: 'u_b',
        moduleName: 'b',
        defFile: '/tmp/b.v',
        file: '/tmp/pair.v',
        range,
        nameRange: range,
        moduleNameRange: range,
        resolved: true,
        ports: [port('i1', 'input'), port('i2', 'input'), port('io2', 'inout')],
      },
    ],
    edges: [
      link('o1', 'output', 'i1', 'input'),
      link('o2', 'output', 'i2', 'input'),
      link('o1', 'output', 'i2', 'input'),
      link('io1', 'inout', 'io2', 'inout'),
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

test('svg: bundling draws one link per direction between two instances', () => {
  const model = linkedPair();
  const svg = renderFrameSvg(input(model), { signalMode: 'bundled' }).svg;
  const titles = [...svg.matchAll(/<g class="edge"><title>([^<]*)<\/title>/g)].map((m) => m[1]);
  assert.equal(titles.length, 2, 'the four links collapse into one wire per direction class');
  assert.ok(titles.some((t) => t.startsWith('out (3)')), 'the three output links are one wire');
  assert.ok(titles.some((t) => t.startsWith('inout (1)')), 'the inout link is a wire of its own');
  assert.ok(
    titles.some((t) => t.includes('o1') && t.includes('i1')),
    'the wire names the ports it swallowed',
  );
  assert.equal((svg.match(/marker-end=/g) ?? []).length, 2, 'every wire keeps its direction');
  const outputColor = /--output:(#[0-9a-f]{6})/.exec(svg)?.[1];
  assert.ok(outputColor, 'the theme knows the output colour');
  const strokes = [...svg.matchAll(/<g class="edge"><title>([^<]*)<\/title><path[^>]*stroke="(#[0-9a-f]{6})"/g)].map(
    (m) => ({ title: m[1], stroke: m[2] }),
  );
  assert.equal(
    strokes.find((s) => s.title.startsWith('out'))?.stroke,
    outputColor,
    'the output wire wears the output colour',
  );
  const all = renderFrameSvg(input(model), { signalMode: 'all' }).svg;
  assert.equal(
    (all.match(/<g class="edge">/g) ?? []).length,
    model.edges.length,
    'the plain mode keeps every link',
  );
});

test('svg: bundling gives the frame ports one link per instance', () => {
  const model = chipTop();
  const svg = renderFrameSvg(input(model), { signalMode: 'bundled' }).svg;
  const wires = [...svg.matchAll(/<g class="edge"><title>([^<]*)<\/title>/g)].map((m) => {
    const parts = /^(\w+) \((\d+)\): (.*)$/.exec(m[1]);
    assert.ok(parts, `the wire title reads as a class and a list: ${m[1]}`);
    return {
      cat: parts![1],
      pairs: parts![3].split(', ').map((p) => p.split('→') as [string, string]),
    };
  });
  const fromFrame = wires.filter((w) => w.pairs.every(([from]) => !from.includes('.')));
  const toFrame = wires.filter((w) => w.pairs.every(([, to]) => !to.includes('.')));
  const fed = new Set<string>();
  const drives = new Set<string>();
  for (const e of model.edges) {
    if (e.from.kind === 'signal' && e.to.kind === 'child') {
      fed.add(e.to.child);
    }
    if (e.from.kind === 'child' && e.to.kind === 'signal') {
      drives.add(e.from.child);
    }
  }
  assert.equal(fromFrame.length, fed.size, 'one wire from the input bus into each instance');
  assert.equal(toFrame.length, drives.size, 'one wire from each instance to the output bus');
  assert.equal(
    wires.length,
    fromFrame.length + toFrame.length + 1,
    'the link between the two instances is one wire',
  );
  const feed = fromFrame.find((w) => w.pairs.some(([, to]) => to.startsWith('u_ctrl.')));
  assert.ok(feed, 'the input bus feeds the control instance');
  assert.ok(
    feed.pairs.some(([, to]) => to.endsWith('.clk')),
    'the wire names the ports it swallowed',
  );
  const back = toFrame.find((w) => w.pairs.some(([from]) => from.startsWith('u_dpath.')));
  assert.ok(back, 'the data path instance drives the output bus');
  assert.ok(
    back.pairs.some(([from]) => from.endsWith('.result')),
    'the wire names the ports it swallowed',
  );
});

test('svg: the instances sit in a box the signals cross', () => {
  const model = chipTop();
  for (const mode of ['all', 'hidden', 'bundled'] as const) {
    const svg = renderFrameSvg(input(model), { signalMode: mode }).svg;
    const box = /<g class="instance-group"><rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/.exec(
      svg,
    );
    assert.ok(box, `the ${mode} picture has a box around the instances`);
    const bx = +box![1];
    const by = +box![2];
    const bw = +box![3];
    const bh = +box![4];
    const canvas = /<rect x="0" y="0" width="([-\d.]+)" height="([-\d.]+)"/.exec(svg);
    assert.ok(canvas);
    assert.ok(bx >= 0 && by >= 0, `the ${mode} box starts inside the canvas`);
    assert.ok(
      bx + bw <= +canvas![1] && by + bh <= +canvas![2],
      `the ${mode} box ends inside the canvas`,
    );
    const kids = [
      ...svg.matchAll(
        /(?:<g class="child">|<a [^>]*class="nav">|<g class="src"[^>]*>)<title>[^<]*<\/title><rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g,
      ),
    ];
    assert.equal(kids.length, model.children.length);
    for (const k of kids) {
      assert.ok(
        +k[1] >= bx && +k[2] >= by && +k[1] + +k[3] <= bx + bw && +k[2] + +k[4] <= by + bh,
        `the ${mode} box hugs the instance`,
      );
    }
    const wires = [
      ...svg.matchAll(/<g class="edge">.*?<path d="M ([-\d.]+),([-\d.]+) C [^"]* ([-\d.]+),([-\d.]+)"/g),
    ];
    const crossing = wires.filter(
      (w) => (+w[1] < bx && +w[3] > bx) || (+w[3] < bx && +w[1] > bx),
    );
    assert.ok(crossing.length > 0, `the ${mode} signals pass through the box`);
    assert.ok(
      svg.indexOf('class="instance-group"') < svg.indexOf('class="edges"'),
      `the ${mode} box sits behind the wires`,
    );
  }
});

test('svg: the current module has a frame that reaches the port boxes', () => {
  const model = chipTop();
  for (const mode of ['all', 'hidden', 'bundled'] as const) {
    const svg = renderFrameSvg(input(model), { signalMode: mode }).svg;
    const frame = /<g class="module-frame"><rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/.exec(
      svg,
    );
    assert.ok(frame, `the ${mode} picture has a frame around the current module`);
    const fx = +frame![1];
    const fw = +frame![3];
    let left = 0;
    let right = 0;
    let portTop = 0;
    let portBottom = 0;
    let portGroup = '';
    if (mode === 'all') {
      const rows = [
        ...svg.matchAll(
          /<g class="signal"><title>[^<]*<\/title><rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g,
        ),
      ];
      assert.ok(rows.length >= 2, `the ${mode} picture has input and output boxes`);
      left = +rows[0]![1] + +rows[0]![3] / 2;
      right = +rows[rows.length - 1]![1] + +rows[rows.length - 1]![3] / 2;
      portTop = +rows[0]![2];
      portBottom = +rows[rows.length - 1]![2] + +rows[rows.length - 1]![4];
      portGroup = 'class="signals"';
    } else if (mode === 'bundled') {
      const bars = [
        ...svg.matchAll(
          /<g class="bundle"><title>[^<]*<\/title><rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g,
        ),
      ];
      assert.ok(bars.length >= 2, `the ${mode} picture has input and output boxes`);
      left = +bars[0]![1] + +bars[0]![3] / 2;
      right = +bars[bars.length - 1]![1] + +bars[bars.length - 1]![3] / 2;
      portTop = +bars[0]![2];
      portBottom = +bars[bars.length - 1]![2] + +bars[bars.length - 1]![4];
      portGroup = 'class="bundles"';
    } else {
      const rails = [
        ...svg.matchAll(
          /<line x1="([-\d.]+)" y1="([-\d.]+)" x2="[-\d.]+" y2="([-\d.]+)" stroke="[^"]*" stroke-width="1" stroke-dasharray="3 3"/g,
        ),
      ];
      assert.equal(rails.length, 2, `the ${mode} picture has two rails`);
      left = +rails[0]![1];
      right = +rails[1]![1];
      portTop = +rails[0]![2];
      portBottom = +rails[1]![3];
      portGroup = 'class="rails"';
    }
    assert.ok(Math.abs(fx - left) < 0.02, `the ${mode} frame starts in the middle of the input box`);
    assert.ok(
      Math.abs(fx + fw - right) < 0.02,
      `the ${mode} frame ends in the middle of the output box`,
    );
    assert.ok(
      Math.abs(+frame![2] - portTop) < 0.02,
      `the ${mode} frame starts at the top of the port boxes`,
    );
    assert.ok(
      +frame![2] + +frame![4] >= portBottom - 0.02,
      `the ${mode} frame reaches past the port boxes`,
    );
    assert.ok(
      svg.indexOf('class="module-frame"') > svg.indexOf(portGroup),
      `the ${mode} frame is drawn over the port boxes`,
    );
  }
  const leaf: ModuleTopology = { ...model, children: [], edges: [] };
  for (const mode of ['all', 'hidden', 'bundled'] as const) {
    const svg = renderFrameSvg(input(leaf), { signalMode: mode }).svg;
    assert.ok(
      /<g class="module-frame">/.test(svg),
      `the ${mode} picture of a module without instances still has a frame`,
    );
    assert.ok(
      !/<g class="instance-group">/.test(svg),
      `the ${mode} picture of a module without instances has no instance box`,
    );
  }
});

test('svg: the wires stop at the border so their arrows stay visible', () => {
  const model = chipTop();
  for (const mode of ['all', 'hidden', 'bundled'] as const) {
    const svg = renderFrameSvg(input(model), { signalMode: mode }).svg;
    const boxes = [
      ...svg.matchAll(
        /(?:<g class="child">|<a [^>]*class="nav">)<title>([^<]*)<\/title><rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g,
      ),
    ].map((m) => ({ name: m[1], x: +m[2], y: +m[3], w: +m[4], h: +m[5] }));
    assert.ok(boxes.length > 0, `the ${mode} picture has instance boxes`);
    for (const m of svg.matchAll(
      /<g class="(?:bundle|signal)"><title>[^<]*<\/title><rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g,
    )) {
      boxes.push({ name: 'bus', x: +m[1], y: +m[2], w: +m[3], h: +m[4] });
    }
    const wires = [
      ...svg.matchAll(
        /<g class="edge">(?:<title>([^<]*)<\/title>)?<path d="M ([-\d.]+),([-\d.]+) C [^"]* ([-\d.]+),([-\d.]+)/g,
      ),
    ].map((m) => ({ title: m[1] ?? '', to: [+m[4], +m[5]] }));
    assert.ok(wires.length > 0, `the ${mode} picture has wires`);
    assert.equal(
      (svg.match(/marker-end=/g) ?? []).length,
      wires.length,
      `every ${mode} wire carries an arrow`,
    );
    for (const w of wires) {
      for (const b of boxes) {
        assert.ok(
          !(w.to[0] > b.x && w.to[0] < b.x + b.w && w.to[1] > b.y && w.to[1] < b.y + b.h),
          `the ${mode} wire into ${b.name} stops outside the box so the arrow shows`,
        );
      }
    }
  }
  const svg = renderFrameSvg(input(model), { signalMode: 'bundled' }).svg;
  const feed = [
    ...svg.matchAll(
      /<g class="edge"><title>([^<]*)<\/title><path d="M ([-\d.]+),([-\d.]+) C [^"]* ([-\d.]+),([-\d.]+)"/g,
    ),
  ].find((m) => m[1].includes('→u_ctrl.'));
  assert.ok(feed, 'a wire feeds the control instance');
  const ctrl = /(?:<g class="child">|<a [^>]*class="nav">)<title>u_ctrl<\/title><rect x="([-\d.]+)"/.exec(
    svg,
  );
  assert.ok(ctrl, 'the control instance is drawn');
  assert.equal(+feed![4], +ctrl![1], 'the wire stops on the border of the instance');
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
