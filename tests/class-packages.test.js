'use strict';

// UML packages in class diagrams (UML 2.5.1, 12.2.4): the same package shape
// as component diagrams, drawn behind the classes, inside the SVG bounds, and
// crossable by relationships. Qualified names (`opc::partners`) show as
// written. Member notes follow manual class positions.
const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { launchBrowser, openDiagramPage, render, overlaps, contains } = require('./support/diagram-page');

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { if (browser) await browser.close(); });

async function withPage(run) {
  const page = await openDiagramPage(browser);
  try { await run(page); } finally { await page.close(); }
}

const PARTNERS = [
  'package opc::partners {',
  '  class SupplierProvider',
  '  class ShuttleProvider',
  '}',
  'abstract class Provider',
  'SupplierProvider --|> Provider',
  'ShuttleProvider --|> Provider',
].join('\n');

async function drawn(page, source, classIds) {
  await render(page, 'UMLClassDiagram', source);
  return page.evaluate((ids) => ({
    packages: measure.packages(),
    boxes: Object.fromEntries(ids.map((id) => [id, measure.classBox(id)])),
  }), classIds);
}

test('the parser reports packages, their members, and each class\'s package', async () => {
  await withPage(async (page) => {
    const parsed = await page.evaluate((text) => window.UMLClassDiagram.parse(text), PARTNERS);
    assert.deepEqual(parsed.packages, [{ id: 'opc::partners', label: 'opc::partners', stereotype: null, parent: null, members: ['SupplierProvider', 'ShuttleProvider'] }]);
    assert.deepEqual(parsed.classes.map((c) => [c.name, c.package]), [['SupplierProvider', 'opc::partners'], ['ShuttleProvider', 'opc::partners'], ['Provider', null]]);
  });
});

test('a package encloses its classes, shows its qualified name in the tab, and leaves other classes outside', async () => {
  await withPage(async (page) => {
    const result = await drawn(page, PARTNERS, ['SupplierProvider', 'ShuttleProvider', 'Provider']);
    assert.equal(result.packages.length, 1);
    const [pkg] = result.packages;
    assert.deepEqual(pkg.labels.map((l) => [l.text, l.bold]), [['opc::partners', true]]);
    assert.ok(Math.abs(pkg.tab.bottom - pkg.body.y) < 0.5 && Math.abs(pkg.tab.x - pkg.body.x) < 0.5, 'the tab stands on the left of the top edge');
    for (const id of ['SupplierProvider', 'ShuttleProvider']) assert.ok(contains(pkg.body, result.boxes[id], 1), `${id} is inside`);
    assert.ok(!overlaps(pkg.body, result.boxes.Provider) && !overlaps(pkg.tab, result.boxes.Provider), 'Provider is outside');
  });
});

test('generalizations cross the package outline', async () => {
  await withPage(async (page) => {
    await render(page, 'UMLClassDiagram', PARTNERS);
    const result = await page.evaluate(() => {
      const segments = [];
      for (const line of document.querySelectorAll('#diagram svg line')) {
        segments.push([{ x: +line.getAttribute('x1'), y: +line.getAttribute('y1') }, { x: +line.getAttribute('x2'), y: +line.getAttribute('y2') }]);
      }
      for (const route of document.querySelectorAll('#diagram svg polyline.uml-class-hierarchy-route')) {
        const points = [...route.points];
        for (let i = 1; i < points.length; i++) segments.push([points[i - 1], points[i]].map(({ x, y }) => ({ x, y })));
      }
      return { pkg: measure.packages()[0], segments };
    });
    const { body } = result.pkg;
    const inside = (p) => p.x > body.x && p.x < body.right && p.y > body.y && p.y < body.bottom;
    assert.ok(result.segments.some(([a, b]) => inside(a) !== inside(b)), 'a generalization line runs from inside the package to outside it');
  });
});

test('a package with a stereotype stays inside the SVG bounds, behind the classes', async () => {
  await withPage(async (page) => {
    const source = PARTNERS.replace('package opc::partners {', 'package opc::partners <<Subsystem>> {');
    await render(page, 'UMLClassDiagram', source);
    const result = await page.evaluate(() => {
      const svg = document.querySelector('#diagram svg');
      const group = svg.querySelector('g[data-uml-package]');
      const firstClass = svg.querySelector('rect[data-layout-bounds-id]');
      const outer = svg.getBoundingClientRect(), frame = group.getBoundingClientRect();
      return {
        labels: measure.packages()[0].labels.map((l) => [l.text, l.bold]),
        within: frame.left >= outer.left - 0.5 && frame.right <= outer.right + 0.5 && frame.top >= outer.top - 0.5 && frame.bottom <= outer.bottom + 0.5,
        behind: measure.paintOrder(group) < measure.paintOrder(firstClass),
      };
    });
    assert.deepEqual(result.labels, [['«Subsystem»', false], ['opc::partners', true]]);
    assert.equal(result.within, true, 'the whole package, tab included, is visible');
    assert.equal(result.behind, true, 'classes paint over the package');
  });
});

test('nested class packages nest, and their members follow manual positions', async () => {
  await withPage(async (page) => {
    const source = [
      'package opc {',
      '  class Workflow @pos(40, 40)',
      '  package opc::partners {',
      '    class SupplierProvider @pos(400, 260)',
      '  }',
      '}',
      'class Bank @pos(760, 40)',
      'Workflow --> SupplierProvider',
    ].join('\n');
    // The renderer reads manual positions before it parses the diagram.
    const parsed = await page.evaluate((text) => window.UMLClassDiagram.parse(window.UMLShared.extractLayoutMetadata(text).text), source);
    assert.deepEqual(parsed.packages.map((p) => [p.id, p.parent, p.members]), [['opc', null, ['Workflow']], ['opc::partners', 'opc', ['SupplierProvider']]]);
    const result = await drawn(page, source, ['Workflow', 'SupplierProvider', 'Bank']);
    assert.deepEqual([result.boxes.SupplierProvider.x, result.boxes.SupplierProvider.y], [400, 260]);
    const outer = result.packages.find((p) => p.id === 'opc');
    const inner = result.packages.find((p) => p.id === 'opc::partners');
    assert.ok(contains(outer.body, inner.body) && contains(outer.body, inner.tab), 'opc::partners is inside opc');
    assert.ok(contains(inner.body, result.boxes.SupplierProvider, 1), 'SupplierProvider is inside opc::partners at its manual position');
    assert.ok(contains(outer.body, result.boxes.Workflow, 1) && !overlaps(inner.body, result.boxes.Workflow));
    assert.ok(!overlaps(outer.body, result.boxes.Bank), 'Bank stays outside');
  });
});

test('a member note follows its class to a manual position', async () => {
  await withPage(async (page) => {
    await render(page, 'UMLClassDiagram', [
      'class Order @pos(420, 260) {',
      '  +id: int',
      '  +submit()',
      '}',
      'class Customer',
      'Customer --> Order',
      'note right of Order.submit : validates the cart',
    ].join('\n'));
    const result = await page.evaluate(() => {
      const anchor = document.querySelector('#diagram svg circle.uml-note-anchor');
      return { order: measure.classBox('Order'), member: measure.text('+submit()'), anchor: { x: +anchor.getAttribute('cx'), y: +anchor.getAttribute('cy') } };
    });
    assert.ok(Math.abs(result.anchor.x - result.order.right) <= 6, 'the note attaches to the right edge of Order where it now is');
    assert.ok(result.anchor.y >= result.member.y - 4 && result.anchor.y <= result.member.bottom + 4, 'the note attaches at the submit() row');
  });
});

test('a one-line package places its classes and keeps later route ids on their source lines', async () => {
  await withPage(async (page) => {
    const source = 'package opc::partners { class Supplier { +place() }; class Shuttle }\nclass Provider\nSupplier --> Provider';
    const parsed = await page.evaluate((text) => window.UMLClassDiagram.parse(text), source);
    assert.deepEqual(parsed.classes.map((c) => [c.name, c.package, c.methods.length]),
      [['Supplier', 'opc::partners', 1], ['Shuttle', 'opc::partners', 0], ['Provider', null, 0]]);
    const result = await drawn(page, source, ['Supplier', 'Shuttle', 'Provider']);
    const [pkg] = result.packages;
    for (const id of ['Supplier', 'Shuttle']) assert.ok(contains(pkg.body, result.boxes[id], 1), `${id} is inside`);
    // The layout editor addresses a relationship by its source line.
    const routeIds = await page.evaluate(() => measure.routes().map((route) => [route.source, route.target]));
    const lineTwo = await page.evaluate(() => {
      const route = document.querySelector('#diagram svg [data-layout-route-id="rel:2"]');
      return route ? [route.getAttribute('data-layout-source'), route.getAttribute('data-layout-target')] : null;
    });
    assert.deepEqual(lineTwo, ['Supplier', 'Provider'], `the relationship on line 3 keeps route id rel:2 (routes: ${JSON.stringify(routeIds)})`);
  });
});

test('a class placed inside a package it does not belong to is reported on that package', async () => {
  await withPage(async (page) => {
    const source = [
      'package opc::partners {',
      '  class Supplier @pos(0, 0)',
      '  class Shuttle @pos(400, 0)',
      '}',
      'class Provider @pos(200, 0)',
    ].join('\n');
    const result = await drawn(page, source, []);
    assert.deepEqual(result.packages.map((p) => [p.id, p.overlaps]), [['opc::partners', ['Provider']]]);
    const clean = await drawn(page, PARTNERS, []);
    assert.deepEqual(clean.packages.map((p) => p.overlaps), [[]], 'a package that only holds its members reports nothing');
  });
});

test('classes declared outside any package carry no package', async () => {
  await withPage(async (page) => {
    const parsed = await page.evaluate(() => window.UMLClassDiagram.parse('class A\nclass B\nA --> B'));
    assert.deepEqual(parsed.packages, []);
    assert.deepEqual(parsed.classes.map((c) => c.package), [null, null]);
  });
});

// End labels drawn at a class in a package belong inside the package, and a
// note beside a member sits inside or outside the frame, never across it.
test('the frame encloses the end labels at its classes and keeps member notes off its outline', async () => {
  await withPage(async (page) => {
    await render(page, 'UMLClassDiagram', [
      'package opc::partners {',
      '  class Helper',
      '  class GlampingCoGateway {',
      '    + cancel(order)',
      '  }',
      '}',
      'class LodgingGateway',
      'class ManualCancellationRequired',
      'GlampingCoGateway "gateways 0..*" --> "1" LodgingGateway',
      'GlampingCoGateway "1..2" --> "0..1" ManualCancellationRequired',
      'note right of GlampingCoGateway.cancel : raises within 72 h',
      '@layout',
      'Helper @pos(0, 0)',
      'GlampingCoGateway @pos(220, 0)',
      'LodgingGateway @pos(620, 0)',
      'ManualCancellationRequired @pos(220, 260)',
      '@endlayout',
    ].join('\n'));
    const { pkg, texts, note, outside } = await page.evaluate(() => ({
      pkg: measure.packages()[0],
      texts: measure.texts(),
      note: measure.box(document.querySelector('#diagram svg polygon.uml-note-box')),
      outside: ['LodgingGateway', 'ManualCancellationRequired'].map((id) => measure.classBox(id)),
    }));
    const offOutline = (box) => !(overlaps(pkg.body, box) && !contains(pkg.body, box, 1)) && !overlaps(pkg.tab, box);

    for (const end of ['gateways 0..*', '1..2']) {
      assert.ok(contains(pkg.body, texts.find((t) => t.text === end), 1), `"${end}", at GlampingCoGateway, lies inside the frame`);
    }
    for (const text of texts.filter((t) => t.text !== 'opc::partners')) {
      assert.ok(offOutline(text), `"${text.text}" keeps off the frame outline`);
    }
    assert.ok(offOutline(note), 'the member note keeps off the frame outline');
    for (const box of outside) assert.ok(!overlaps(pkg.body, box) && !overlaps(pkg.tab, box), 'the other classes stay outside');
    assert.deepEqual(pkg.overlaps, []);
  });
});
