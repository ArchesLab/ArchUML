'use strict';

// A package drawn without its members (UML 2.5.1, 12.2.4): a `package` line
// without braces. It is a node of the class diagram: a large rectangle that
// holds the name, with a small tab on the left of its top edge. Dependencies
// connect such packages, which makes a UML package diagram, and each
// relationship ends on the outline a reader sees, not on the bounding box.
const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { launchBrowser, openDiagramPage, render, contains } = require('./support/diagram-page');

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { if (browser) await browser.close(); });

async function withPage(run) {
  const page = await openDiagramPage(browser);
  try { await run(page); } finally { await page.close(); }
}

const parse = (page, source) => page.evaluate(
  (text) => window.UMLClassDiagram.parse(window.UMLShared.extractLayoutMetadata(text).text), source);

// The drawn parts of every package node, and the routes between nodes.
const drawn = (page) => page.evaluate(() => ({
  nodes: Object.fromEntries([...document.querySelectorAll('#diagram svg g[data-uml-package-node]')].map((group) => [
    group.getAttribute('data-uml-package-node'), {
      tab: measure.box(group.querySelector('[data-package-node-part="tab"]')),
      body: measure.box(group.querySelector('[data-package-node-part="body"]')),
      bounds: measure.classBox(group.getAttribute('data-uml-package-node')),
    }])),
  texts: measure.texts(),
  routes: measure.routes(),
}));

const IMPORTS = [
  'package loyalty',
  'package broker',
  'package http',
  'loyalty ..> broker : «use»',
  'broker ..> http : «use»',
].join('\n');

test('a package line without braces is a node, and one with braces still groups its members', async () => {
  await withPage(async (page) => {
    const parsed = await parse(page, [
      'package infra {',
      '  package broker',
      '  package "HTTP client" as http <<framework>>',
      '}',
      'package loyalty',
      'class Message',
      'loyalty ..> broker',
    ].join('\n'));

    assert.deepEqual(parsed.classes.map((c) => [c.name, c.type, c.label, c.stereotype, c.package]), [
      ['broker', 'package', null, null, 'infra'],
      ['http', 'package', 'HTTP client', 'framework', 'infra'],
      ['loyalty', 'package', null, null, null],
      ['Message', 'class', null, null, null],
    ]);
    assert.deepEqual(parsed.packages.map((p) => [p.id, p.members]), [['infra', ['broker', 'http']]]);
    assert.deepEqual(parsed.relationships.map((r) => [r.from, r.to, r.type]), [['loyalty', 'broker', 'dependency']]);
  });
});

test('a package node is a rectangle holding its name, with a small tab on the left of its top edge', async () => {
  await withPage(async (page) => {
    await render(page, 'UMLClassDiagram', 'package infra::http\npackage "Message broker" as broker <<framework>>');
    const { nodes, texts } = await drawn(page);

    assert.deepEqual(Object.keys(nodes).sort(), ['broker', 'infra::http']);
    for (const [id, node] of Object.entries(nodes)) {
      assert.ok(Math.abs(node.tab.bottom - node.body.y) < 0.5, `${id}: the tab stands on the body's top edge`);
      assert.ok(Math.abs(node.tab.x - node.body.x) < 0.5, `${id}: the tab starts at the body's left edge`);
      assert.ok(node.tab.width < node.body.width / 2 && node.tab.height < node.body.height / 2, `${id}: the tab is small`);
      // Layout tools address the node by the box around the whole symbol.
      assert.ok(Math.abs(node.bounds.y - node.tab.y) < 0.5 && Math.abs(node.bounds.bottom - node.body.bottom) < 0.5 &&
        Math.abs(node.bounds.width - node.body.width) < 0.5, `${id}: the bounds cover the tab and the body`);
    }
    const name = texts.find((t) => t.text === 'infra::http');
    assert.ok(name && name.bold && contains(nodes['infra::http'].body, name), 'the name is bold, inside the large rectangle');
    const stereotype = texts.find((t) => t.text === '«framework»');
    const label = texts.find((t) => t.text === 'Message broker');
    assert.ok(stereotype && label && contains(nodes.broker.body, stereotype) && contains(nodes.broker.body, label));
    assert.ok(stereotype.bottom <= label.y + 2 && !stereotype.bold, 'the stereotype stands above the name');
  });
});

test('a dependency between packages is a dashed route from the importing package to the imported one', async () => {
  await withPage(async (page) => {
    await render(page, 'UMLClassDiagram', IMPORTS);
    const { routes, texts } = await drawn(page);

    assert.deepEqual(routes.map((r) => [r.source, r.target, r.dashed]).sort(),
      [['broker', 'http', true], ['loyalty', 'broker', true]]);
    assert.equal(texts.filter((t) => t.text === '«use»').length, 2);
  });
});

// Right of the tab, the top of the bounding box is empty: the outline lies
// one tab height lower. A line that stopped at the box would end in the air.
function assertEndsOnOutline(routes, nodes) {
  for (const route of routes) {
    for (const [end, neighbor, id] of [
      [route.points[0], route.points[1], route.source],
      [route.points.at(-1), route.points.at(-2), route.target],
    ]) {
      const { tab, body } = nodes[id];
      const where = `${route.source} to ${route.target}, at ${id} (${end.x}, ${end.y})`;
      if (Math.abs(neighbor.x - end.x) < 0.75 && neighbor.y < end.y) {
        // From above: the tab's top edge over the tab, the body's elsewhere.
        const outlineY = end.x <= tab.right + 0.5 ? tab.y : body.y;
        assert.ok(Math.abs(end.y - outlineY) < 0.75, `${where} ends on the top outline at y=${outlineY}`);
      } else if (Math.abs(neighbor.x - end.x) < 0.75) {
        assert.ok(Math.abs(end.y - body.bottom) < 0.75, `${where} ends on the bottom edge`);
      } else if (neighbor.x > end.x) {
        // From the right: only the large rectangle has a right edge there.
        assert.ok(Math.abs(end.x - body.right) < 0.75 && end.y >= body.y - 0.75 && end.y <= body.bottom + 0.75,
          `${where} ends on the right edge of the large rectangle`);
      } else {
        // From the left: the tab and the body share the left edge.
        assert.ok(Math.abs(end.x - body.x) < 0.75 && end.y >= tab.y - 0.75 && end.y <= body.bottom + 0.75,
          `${where} ends on the left edge`);
      }
    }
  }
}

test('relationships from above end on the large rectangle right of the tab', async () => {
  await withPage(async (page) => {
    const sources = ['a', 'b', 'c', 'd', 'e'];
    await render(page, 'UMLClassDiagram', [
      ...sources.map((id) => `package ${id}`),
      'package shared_module_with_a_long_name',
      ...sources.map((id) => `${id} ..> shared_module_with_a_long_name`),
      '@layout',
      ...sources.map((id, index) => `${id} @pos(${index * 190}, 0)`),
      'shared_module_with_a_long_name @pos(300, 320)',
      '@endlayout',
    ].join('\n'));
    const { nodes, routes } = await drawn(page);
    const target = nodes.shared_module_with_a_long_name;
    const fromAbove = routes.filter((route) => Math.abs(route.points.at(-1).x - route.points.at(-2).x) < 0.75);

    assert.equal(routes.length, sources.length);
    assert.ok(fromAbove.filter((route) => route.points.at(-1).x > target.tab.right + 0.5).length >= 2,
      'the layout sends several routes to the top edge right of the tab');
    for (const route of fromAbove) {
      assert.ok(Math.abs(route.points.at(-1).y - target.body.y) < 0.75,
        `${route.source}: the route reaches the large rectangle (y=${route.points.at(-1).y}, its top is ${target.body.y})`);
    }
    assertEndsOnOutline(routes, nodes);
  });
});

test('a relationship from above the tab ends on the tab', async () => {
  await withPage(async (page) => {
    await render(page, 'UMLClassDiagram', [
      'package importer',
      'package imported_module_with_a_long_name',
      'importer ..> imported_module_with_a_long_name',
      '@layout',
      // Wide enough for the source's centre to stand over the target's tab.
      'importer @pos(-40, 0)',
      'imported_module_with_a_long_name @pos(0, 260)',
      '@endlayout',
    ].join('\n'));
    const { nodes, routes } = await drawn(page);
    const target = nodes.imported_module_with_a_long_name;
    const end = routes[0].points.at(-1);

    assert.ok(end.x <= target.tab.right + 0.5, `the route arrives over the tab (x=${end.x}, the tab ends at ${target.tab.right})`);
    assert.ok(Math.abs(end.y - target.tab.y) < 0.75, 'and ends on the tab\'s top edge');
    assertEndsOnOutline(routes, nodes);
  });
});

test('a package frame encloses the package nodes declared in it, at their manual positions', async () => {
  await withPage(async (page) => {
    await render(page, 'UMLClassDiagram', [
      'package services {',
      '  package loyalty',
      '  package website',
      '}',
      'package infra {',
      '  package http',
      '}',
      'loyalty ..> http',
      'website ..> http',
      '@layout',
      'loyalty @pos(0, 0)',
      'website @pos(260, 0)',
      'http @pos(130, 300)',
      '@endlayout',
    ].join('\n'));
    const { nodes } = await drawn(page);
    const frames = await page.evaluate(() => measure.packages());
    const frame = (id) => frames.find((f) => f.id === id);

    assert.deepEqual([nodes.loyalty.bounds.x, nodes.loyalty.bounds.y], [0, 0]);
    assert.deepEqual([nodes.http.bounds.x, nodes.http.bounds.y], [130, 300]);
    for (const id of ['loyalty', 'website']) {
      assert.ok(contains(frame('services').body, nodes[id].bounds, 1), `${id} is inside services`);
    }
    assert.ok(contains(frame('infra').body, nodes.http.bounds, 1), 'http is inside infra');
    assert.deepEqual(frames.map((f) => f.overlaps), [[], []]);
  });
});

// `::` separates the parts of a qualified name; only a single colon starts
// the text of a one-line note.
test('a note names its package by a qualified name, in one line or several', async () => {
  await withPage(async (page) => {
    const source = [
      'package infra::http',
      'package services::loyalty',
      'services::loyalty ..> infra::http',
      'note right of infra::http',
      'Key: a package diagram.',
      'Dashed arrow: imports.',
      'end note',
      'note left of services::loyalty : the Loyalty service',
    ].join('\n');
    const parsed = await parse(page, source);
    assert.deepEqual(parsed.notes.map((n) => [n.target, n.lines]), [
      ['infra::http', ['Key: a package diagram.', 'Dashed arrow: imports.']],
      ['services::loyalty', ['the Loyalty service']],
    ]);

    await render(page, 'UMLClassDiagram', source);
    const { texts } = await drawn(page);
    for (const line of ['Key: a package diagram.', 'Dashed arrow: imports.', 'the Loyalty service']) {
      assert.ok(texts.some((t) => t.text === line), `the note line "${line}" is drawn`);
    }
  });
});

// Packages nest hierarchically (UML 2.5.1, 12.2.4): a package that shows its
// members is a frame, and its members may be frames again or package nodes.
test('packages nest to any depth: frames in frames, with package nodes inside and dependencies across them', async () => {
  await withPage(async (page) => {
    const source = [
      'package headliner {',
      '  package services {',
      '    package website {',
      '      package checkout',
      '      package clients',
      '    }',
      '    package loyalty',
      '  }',
      '  package infra {',
      '    package http',
      '  }',
      '}',
      'checkout ..> clients',
      'clients ..> http',
      'loyalty ..> http',
    ].join('\n');
    const parsed = await parse(page, source);
    assert.deepEqual(parsed.packages.map((p) => [p.id, p.parent, p.members]), [
      ['headliner', null, []],
      ['services', 'headliner', ['loyalty']],
      ['website', 'services', ['checkout', 'clients']],
      ['infra', 'headliner', ['http']],
    ]);
    assert.deepEqual(parsed.classes.map((c) => [c.name, c.type, c.package]), [
      ['checkout', 'package', 'website'], ['clients', 'package', 'website'],
      ['loyalty', 'package', 'services'], ['http', 'package', 'infra'],
    ]);

    await render(page, 'UMLClassDiagram', source);
    const { nodes, routes } = await drawn(page);
    const frames = await page.evaluate(() => measure.packages());
    const frame = (id) => frames.find((f) => f.id === id);
    const inside = (outer, inner) => contains(frame(outer).body, frame(inner).body) && contains(frame(outer).body, frame(inner).tab);

    assert.deepEqual(frames.map((f) => f.id).sort(), ['headliner', 'infra', 'services', 'website']);
    assert.ok(inside('headliner', 'services') && inside('headliner', 'infra') && inside('services', 'website'), 'each frame lies inside its parent');
    assert.ok(!contains(frame('services').body, frame('infra').body), 'sibling frames stay apart');
    for (const [id, owner] of [['checkout', 'website'], ['clients', 'website'], ['loyalty', 'services'], ['http', 'infra']]) {
      assert.ok(contains(frame(owner).body, nodes[id].bounds, 1), `${id} is inside ${owner}`);
    }
    assert.ok(!contains(frame('website').body, nodes.loyalty.bounds), 'loyalty is in services, outside website');
    assert.deepEqual(frames.map((f) => f.overlaps).flat(), [], 'no frame holds a non-member');
    assert.deepEqual(routes.map((r) => `${r.source} -> ${r.target}`).sort(),
      ['checkout -> clients', 'clients -> http', 'loyalty -> http']);
    assertEndsOnOutline(routes, nodes);
  });
});

// Nesting is recursive: no depth is special. Each level here holds one
// package node and the next level's frame.
for (const depth of [1, 2, 5, 8]) {
  test(`a chain of ${depth} nested package frames draws every level inside the one before`, async () => {
    await withPage(async (page) => {
      const lines = [];
      for (let level = 1; level <= depth; level++) {
        lines.push(`${'  '.repeat(level - 1)}package level${level} {`, `${'  '.repeat(level)}package node${level}`);
      }
      for (let level = depth; level >= 1; level--) lines.push(`${'  '.repeat(level - 1)}}`);
      lines.push('package outside', `outside ..> node${depth}`);
      const source = lines.join('\n');

      const parsed = await parse(page, source);
      assert.deepEqual(parsed.packages.map((p) => [p.id, p.parent, p.members]),
        Array.from({ length: depth }, (_, i) => [`level${i + 1}`, i ? `level${i}` : null, [`node${i + 1}`]]));

      await render(page, 'UMLClassDiagram', source);
      const { nodes, routes } = await drawn(page);
      const frames = await page.evaluate(() => measure.packages());
      const frame = (level) => frames.find((f) => f.id === `level${level}`);

      assert.equal(frames.length, depth, 'every level has a frame');
      for (let level = 1; level <= depth; level++) {
        assert.ok(contains(frame(level).body, nodes[`node${level}`].bounds, 1), `node${level} is inside level${level}`);
        if (level > 1) {
          assert.ok(contains(frame(level - 1).body, frame(level).body) && contains(frame(level - 1).body, frame(level).tab),
            `level${level} is inside level${level - 1}`);
          assert.ok(!contains(frame(level).body, nodes[`node${level - 1}`].bounds), `node${level - 1} stays outside level${level}`);
        }
      }
      assert.ok(!contains(frame(1).body, nodes.outside.bounds), 'a package declared outside stays outside');
      assert.deepEqual(frames.map((f) => f.overlaps).flat(), [], 'no frame holds a non-member');
      assert.deepEqual(routes.map((r) => `${r.source} -> ${r.target}`), [`outside -> node${depth}`], 'a dependency reaches the innermost level');
      assertEndsOnOutline(routes, nodes);
    });
  });
}

// A line through a package reads as if it belonged there. A relationship
// may cross the outline of a package that holds one of its ends; it keeps
// out of every other package and off every package's name tab.
function segmentsOf(route) {
  return route.points.slice(1).map((end, index) => [route.points[index], end]);
}
function segmentMeets([a, b], rect) {
  return Math.min(a.x, b.x) < rect.right && Math.max(a.x, b.x) > rect.x &&
    Math.min(a.y, b.y) < rect.bottom && Math.max(a.y, b.y) > rect.y;
}

test('a relationship goes around a package that holds neither of its ends', async () => {
  await withPage(async (page) => {
    await render(page, 'UMLClassDiagram', [
      'package left { package a }',
      'package middle { package b }',
      'package right { package c }',
      'a ..> c',
      '@layout',
      'a @pos(0, 0)',
      'b @pos(300, 0)',
      'c @pos(600, 0)',
      '@endlayout',
    ].join('\n'));
    const { routes } = await drawn(page);
    const frames = await page.evaluate(() => measure.packages());
    const middle = frames.find((f) => f.id === 'middle');

    assert.deepEqual(routes.map((r) => `${r.source} -> ${r.target}`), ['a -> c']);
    for (const segment of segmentsOf(routes[0])) {
      assert.ok(!segmentMeets(segment, middle.body), `the route keeps out of middle (segment ${JSON.stringify(segment)})`);
      assert.ok(!segmentMeets(segment, middle.tab), 'and off its name tab');
    }
  });
});

test('a relationship into a package enters beside the name tab, not across it', async () => {
  await withPage(async (page) => {
    await render(page, 'UMLClassDiagram', [
      'package importer',
      // The long name makes a tab that covers the whole top of the member.
      'package shared_infrastructure_code as infra { package broker }',
      'importer ..> broker',
      '@layout',
      // Straight down from the importer would cross the tab that names the package.
      'importer @pos(0, 0)',
      'broker @pos(0, 240)',
      '@endlayout',
    ].join('\n'));
    const { routes } = await drawn(page);
    const frames = await page.evaluate(() => measure.packages());
    const infra = frames.find((f) => f.id === 'infra');

    assert.equal(routes.length, 1);
    for (const segment of segmentsOf(routes[0])) {
      assert.ok(!segmentMeets(segment, infra.tab), `the route keeps off the tab (segment ${JSON.stringify(segment)})`);
    }
    assert.ok(segmentsOf(routes[0]).some((segment) => segmentMeets(segment, infra.body)), 'it still enters the package');
  });
});

// A box grows with the number of relationships that end at it. Laying a
// package out on its own must not shrink it: relationships from other
// packages count too.
test('a class in a package is as large as it would be outside any package', async () => {
  await withPage(async (page) => {
    const clients = ['A', 'B', 'C', 'D'];
    const uses = clients.map((id) => `${id} ..> Shared`);
    const flat = [...clients.map((id) => `class ${id}`), 'class Shared', ...uses].join('\n');
    const packaged = ['package services {', ...clients.map((id) => `  class ${id}`), '}', 'package infra {', '  class Shared', '}', ...uses].join('\n');
    const size = async (source) => {
      await render(page, 'UMLClassDiagram', source);
      const box = await page.evaluate(() => measure.classBox('Shared'));
      return [box.width, box.height];
    };

    assert.deepEqual(await size(packaged), await size(flat));
  });
});

// A dependency may also start or end at a package that shows its members
// (UML 2.5.1, 7.7.4): the line stops at the frame, not at one of the members.
test('a dependency ends on the outline of a package frame', async () => {
  await withPage(async (page) => {
    await render(page, 'UMLClassDiagram', [
      'package model {',
      '  class TripItem',
      '  class FestivalPass',
      '}',
      'package payloads',
      'payloads ..> model : «use»',
      'FestivalPass --|> TripItem',
      '@layout',
      'TripItem @pos(80, 0)',
      'FestivalPass @pos(80, 140)',
      'payloads @pos(60, 340)',
      '@endlayout',
    ].join('\n'));
    const { nodes, routes, texts } = await drawn(page);
    const frames = await page.evaluate(() => measure.packages());
    const model = frames.find((f) => f.id === 'model');
    const route = routes.find((r) => r.source === 'payloads' && r.target === 'model');

    assert.ok(route, 'the dependency on the package is drawn');
    assert.equal(route.dashed, true);
    assert.equal(route.points.length, 2, 'the two ends face each other, so the line is straight');
    const [start, end] = route.points;
    assert.ok(Math.abs(start.x - end.x) < 0.75, 'and vertical');
    assert.ok(Math.abs(end.y - model.body.bottom) < 0.75, `it ends on the frame's bottom edge (y=${end.y}, the edge is at ${model.body.bottom})`);
    assert.ok(end.x > model.body.x && end.x < model.body.right);
    assert.ok(Math.abs(start.y - nodes.payloads.tab.y) < 0.75 || Math.abs(start.y - nodes.payloads.body.y) < 0.75, 'it starts on the package node\'s outline');
    assert.ok(texts.some((t) => t.text === '«use»'), 'with its label');
  });
});

test('a dependency joins two package frames, and one from a package to its own content is left out', async () => {
  await withPage(async (page) => {
    await render(page, 'UMLClassDiagram', [
      'package services { package website; package loyalty }',
      'package infra { package http }',
      'services ..> infra',
      'website ..> services',
      '@layout',
      'website @pos(0, 0)',
      'loyalty @pos(180, 0)',
      'http @pos(600, 6)',
      '@endlayout',
    ].join('\n'));
    const { routes } = await drawn(page);
    const frames = await page.evaluate(() => measure.packages());
    const frame = (id) => frames.find((f) => f.id === id);

    assert.deepEqual(routes.map((r) => `${r.source} -> ${r.target}`), ['services -> infra']);
    const [start, end] = [routes[0].points[0], routes[0].points.at(-1)];
    assert.equal(routes[0].points.length, 2);
    assert.ok(Math.abs(start.x - frame('services').body.right) < 0.75, 'it leaves the right edge of services');
    assert.ok(Math.abs(end.x - frame('infra').body.x) < 0.75, 'and ends on the left edge of infra');
    assert.ok(Math.abs(start.y - end.y) < 0.75);
  });
});

// The two ends of such a dependency may stand anywhere beside each other:
// facing over their whole height, over a few pixels, or not at all. The
// dependency is drawn in every case, as a line between the two outlines.
const besideAFrame = (from, to, tool) => [
  'package model { class TripItem }',
  'class Tool',
  `${from} ..> ${to}`,
  '@layout',
  'TripItem @pos(0, 0)',
  `Tool @pos(${tool.x}, ${tool.y})`,
  '@endlayout',
].join('\n');

const frameAndTool = (page) => page.evaluate(() => {
  const model = measure.packages().find((f) => f.id === 'model');
  return { body: model.body, tab: model.tab, tool: measure.classBox('Tool'), item: measure.classBox('TripItem'), routes: measure.routes() };
});

// A segment runs through a rectangle when it shares more than its edge.
const runsThrough = (a, b, rect) => Math.min(a.x, b.x) < rect.right - 0.75 && Math.max(a.x, b.x) > rect.x + 0.75 &&
  Math.min(a.y, b.y) < rect.bottom - 0.75 && Math.max(a.y, b.y) > rect.y + 0.75;
const onEdgeOf = (point, rect) =>
  point.x > rect.x - 0.75 && point.x < rect.right + 0.75 && point.y > rect.y - 0.75 && point.y < rect.bottom + 0.75 &&
  [point.x - rect.x, point.x - rect.right, point.y - rect.y, point.y - rect.bottom].some((distance) => Math.abs(distance) < 0.75);

// The pixels of the frame's side that Tool shares, at either end of that
// side; zero or less puts Tool past the corner. Around 24 the line changes
// from one corner to none, and around half the height of either end a line
// with a corner would have to turn back.
const SHARED = [-60, -13, -1, 0, 1, 5, 6, 11, 12, 13, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 30, 34];

test('a dependency on a package frame is drawn wherever the other end stands beside it', async () => {
  await withPage(async (page) => {
    await render(page, 'UMLClassDiagram', besideAFrame('model', 'Tool', { x: 420, y: 0 }));
    const apart = await frameAndTool(page);
    // The frame in the coordinates of `@pos`, where TripItem is at (0, 0).
    const frame = {
      x: apart.body.x - apart.item.x, right: apart.body.right - apart.item.x,
      y: apart.body.y - apart.item.y, bottom: apart.body.bottom - apart.item.y,
    };
    const { width, height } = apart.tool;
    const alongSide = (low, high, size) => SHARED.flatMap((shared) => [low + shared - size, high - shared]);
    const positions = {
      right: alongSide(frame.y, frame.bottom, height).map((y) => ({ x: frame.right + 300, y })),
      left: alongSide(frame.y, frame.bottom, height).map((y) => ({ x: frame.x - 300 - width, y })),
      below: alongSide(frame.x, frame.right, width).map((x) => ({ x, y: frame.bottom + 250 })),
      above: alongSide(frame.x, frame.right, width).map((x) => ({ x, y: frame.y - 250 - height })),
    };
    const seen = { straight: 0, corner: 0, partlyFacing: 0 };
    for (const [from, to] of [['model', 'Tool'], ['Tool', 'model']]) {
      for (const [side, places] of Object.entries(positions)) {
        for (const place of places) {
          await render(page, 'UMLClassDiagram', besideAFrame(from, to, place));
          const { body, tab, tool, routes } = await frameAndTool(page);
          const where = `${from} ..> ${to}, Tool ${side} of the frame at (${place.x}, ${place.y})`;
          const route = routes.find((r) => r.source === from && r.target === to);
          assert.ok(route, `${where}: the dependency is drawn`);

          const points = route.points;
          const onFrame = (point) => onEdgeOf(point, body) || onEdgeOf(point, tab);
          const onTool = (point) => onEdgeOf(point, tool);
          assert.ok((from === 'model' ? onFrame : onTool)(points[0]), `${where}: it starts on the outline of ${from}`);
          assert.ok((to === 'model' ? onFrame : onTool)(points.at(-1)), `${where}: it ends on the outline of ${to}`);
          for (let i = 0; i + 1 < points.length; i++) {
            const [a, b] = [points[i], points[i + 1]];
            assert.ok(Math.abs(a.x - b.x) < 0.75 || Math.abs(a.y - b.y) < 0.75, `${where}: every stretch is horizontal or vertical`);
            for (const [name, rect] of [['the frame', body], ['the name tab', tab], ['Tool', tool]]) {
              assert.ok(!runsThrough(a, b, rect), `${where}: the line does not run through ${name}`);
            }
          }

          // The stretch over which the two ends face each other.
          const facing = side === 'right' || side === 'left'
            ? Math.min(body.bottom, tool.bottom) - Math.max(body.y, tool.y)
            : Math.min(body.right, tool.right) - Math.max(body.x, tool.x);
          if (facing >= 30) {
            assert.equal(points.length, 2, `${where}: ends that face each other get a straight line`);
            seen.straight += 1;
          } else if (facing <= 0) {
            assert.equal(points.length, 3, `${where}: ends that do not face each other get one corner`);
            seen.corner += 1;
          } else {
            assert.ok(points.length <= 3, `${where}: at most one corner`);
            seen.partlyFacing += 1;
          }
        }
      }
    }
    assert.ok(seen.straight > 0 && seen.corner > 0 && seen.partlyFacing > 0,
      `the positions cover ends that face each other, partly, and not at all (${JSON.stringify(seen)})`);
  });
});

// A class placed on a package's name tab overlaps the package symbol. Its
// dependency still leaves the class and points at the package.
test('a dependency from a class standing on a package name tab does not run back through the class', async () => {
  await withPage(async (page) => {
    await render(page, 'UMLClassDiagram', besideAFrame('Tool', 'model', { x: 420, y: 0 }));
    const apart = await frameAndTool(page);
    // Tool's bottom edge in the middle of the tab's height, Tool reaching
    // 60 to the left of the tab; positions are relative to TripItem at (0, 0).
    const onTab = {
      x: Math.round(apart.tab.x - 60 - apart.item.x),
      y: Math.round(apart.tab.y + apart.tab.height / 2 - apart.tool.height - apart.item.y),
    };
    await render(page, 'UMLClassDiagram', besideAFrame('Tool', 'model', onTab));
    const { body, tab, tool, routes } = await frameAndTool(page);
    assert.ok(tool.bottom > tab.y + 1 && tool.bottom < tab.bottom - 1 && tool.right > tab.x + 1, 'Tool stands on the name tab');

    const route = routes.find((r) => r.source === 'Tool' && r.target === 'model');
    assert.ok(route, 'the dependency is drawn');
    const [start, end] = [route.points[0], route.points.at(-1)];
    assert.ok(onEdgeOf(start, tool), 'it starts on the outline of Tool');
    assert.ok(onEdgeOf(end, body) || onEdgeOf(end, tab), 'it ends on the outline of the package');
    for (let i = 0; i + 1 < route.points.length; i++) {
      assert.ok(!runsThrough(route.points[i], route.points[i + 1], tool), 'the line does not run back through Tool');
    }
  });
});
