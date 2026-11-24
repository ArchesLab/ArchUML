'use strict';

// UML packages in component diagrams (UML 2.5.1, 12.2.4): a rectangle with a
// name tab on the left of its top edge, drawn behind its members with a solid
// outline. Packages nest, follow their members' manual positions, and are
// not routing obstacles. `rectangle` blocks stay a parse no-op.
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

async function drawn(page, source, componentIds) {
  await render(page, 'UMLComponentDiagram', source);
  return page.evaluate((ids) => ({
    packages: measure.packages(),
    boxes: Object.fromEntries(ids.map((id) => [id, measure.componentBox(id)])),
    routes: measure.routes(),
  }), componentIds);
}

const HEADLINER = [
  'package Headliner {',
  '  component OPC <<service>>',
  '  component Loyalty <<service>>',
  '}',
  'component Partner <<external>>',
  'OPC --> Loyalty',
  'Loyalty --> Partner',
].join('\n');

test('the parser reports packages, their members, and each component\'s package', async () => {
  await withPage(async (page) => {
    const parsed = await page.evaluate((text) => window.UMLComponentDiagram.parse(text), HEADLINER);
    assert.deepEqual(parsed.packages, [{ id: 'Headliner', label: 'Headliner', stereotype: null, parent: null, members: ['OPC', 'Loyalty'] }]);
    assert.deepEqual(parsed.components.map((c) => [c.name, c.package || null]), [['OPC', 'Headliner'], ['Loyalty', 'Headliner'], ['Partner', null]]);
  });
});

test('a package encloses its members and not the other components', async () => {
  await withPage(async (page) => {
    const result = await drawn(page, HEADLINER, ['OPC', 'Loyalty', 'Partner']);
    assert.equal(result.packages.length, 1);
    const [pkg] = result.packages;
    for (const id of ['OPC', 'Loyalty']) assert.ok(contains(pkg.body, result.boxes[id], 1), `${id} is inside Headliner`);
    assert.ok(!overlaps(pkg.body, result.boxes.Partner) && !overlaps(pkg.tab, result.boxes.Partner), 'Partner is outside Headliner');
    assert.deepEqual(pkg.overlaps, [], 'no other component overlaps Headliner');
  });
});

test('a component placed inside a package it does not belong to is reported on that package', async () => {
  await withPage(async (page) => {
    const source = [
      'package Headliner {',
      '  component OPC @pos(0, 0)',
      '  component Loyalty @pos(500, 0)',
      '}',
      'component Bank <<external>> @pos(250, 0)',
      'OPC --> Loyalty',
    ].join('\n');
    const result = await drawn(page, source, []);
    assert.deepEqual(result.packages.map((p) => [p.id, p.overlaps]), [['Headliner', ['Bank']]]);
  });
});

test('the name sits in a tab on the left of the top edge, with the stereotype above it', async () => {
  await withPage(async (page) => {
    const source = 'package "Order Processing Center" as OPC <<Subsystem>> {\n  component Workflow\n  component Callbacks\n}\nWorkflow --> Callbacks';
    const parsed = await page.evaluate((text) => window.UMLComponentDiagram.parse(text), source);
    assert.deepEqual(parsed.packages.map((p) => [p.id, p.label, p.stereotype]), [['OPC', 'Order Processing Center', 'Subsystem']]);
    const [pkg] = (await drawn(page, source, [])).packages;
    assert.ok(Math.abs(pkg.tab.x - pkg.body.x) < 0.5, 'the tab starts at the left edge');
    assert.ok(Math.abs(pkg.tab.bottom - pkg.body.y) < 0.5, 'the tab stands on the top edge');
    assert.ok(pkg.tab.width < pkg.body.width, 'the tab is narrower than the body');
    const [stereotype, name] = pkg.labels;
    assert.deepEqual([stereotype.text, stereotype.bold, name.text, name.bold], ['«Subsystem»', false, 'Order Processing Center', true]);
    assert.ok(stereotype.bottom <= name.y + 1, 'the stereotype is above the name');
    for (const label of pkg.labels) assert.ok(contains(pkg.tab, label), `"${label.text}" fits in the tab`);
  });
});

test('connectors cross the package outline', async () => {
  await withPage(async (page) => {
    const result = await drawn(page, HEADLINER, []);
    const [pkg] = result.packages;
    const crossing = result.routes.find((route) => route.target === 'Partner');
    assert.ok(crossing, 'the connector from a member to an outside component is drawn');
    const inside = (point) => point.x > pkg.body.x && point.x < pkg.body.right && point.y > pkg.body.y && point.y < pkg.body.bottom;
    assert.equal(inside(crossing.points[0]), true, 'it starts inside the package');
    assert.equal(inside(crossing.points.at(-1)), false, 'it ends outside the package');
  });
});

test('the package outline is solid, unfilled, and painted behind the diagram', async () => {
  await withPage(async (page) => {
    await render(page, 'UMLComponentDiagram', HEADLINER);
    const result = await page.evaluate(() => {
      const group = document.querySelector('#diagram svg g[data-uml-package]');
      const firstBox = document.querySelector('#diagram svg rect.uml-component-box');
      const firstRoute = document.querySelector('#diagram svg [data-layout-route-id]');
      return { pkg: measure.packages()[0], order: [measure.paintOrder(group), measure.paintOrder(firstBox), measure.paintOrder(firstRoute)] };
    });
    assert.equal(result.pkg.dashed, false);
    assert.equal(result.pkg.fill, 'none');
    assert.equal(result.pkg.pointerEvents, 'none', 'clicks reach the components and connectors');
    assert.ok(result.order[0] < result.order[1] && result.order[0] < result.order[2], 'components and connectors paint over the package');
  });
});

test('a connector that crosses a package tab passes under the package name', async () => {
  await withPage(async (page) => {
    await render(page, 'UMLComponentDiagram', [
      'package "Order Processing Center" as OPC {',
      '  component Workflow @pos(0, 200)',
      '}',
      'component Website @pos(-360, 145)',
      'component Bank @pos(480, 145)',
      'Website --> Bank',
    ].join('\n'));
    const result = await page.evaluate(() => {
      const route = document.querySelector('#diagram svg [data-layout-route-id]');
      const name = [...document.querySelectorAll('#diagram svg g[data-uml-package-name] text')].find((t) => t.textContent === 'Order Processing Center');
      const style = getComputedStyle(name);
      return {
        tab: measure.packages()[0].tab, points: measure.routes()[0].points,
        nameAfterRoute: measure.paintOrder(name) > measure.paintOrder(route),
        halo: { paintOrder: style.paintOrder, stroke: name.getAttribute('stroke'), fill: getComputedStyle(document.getElementById('diagram')).getPropertyValue('--uml-fill').trim() || '#fdfcf8' },
      };
    });
    const crossesTab = result.points.some((p, i) => i > 0 && Math.min(p.y, result.points[i - 1].y) <= result.tab.bottom &&
      Math.max(p.y, result.points[i - 1].y) >= result.tab.y && Math.min(p.x, result.points[i - 1].x) <= result.tab.right &&
      Math.max(p.x, result.points[i - 1].x) >= result.tab.x);
    assert.equal(crossesTab, true, 'the connector runs through the tab (test setup)');
    assert.equal(result.nameAfterRoute, true, 'the name paints over the connector');
    assert.match(result.halo.paintOrder, /^stroke/, 'the name has a halo');
    assert.equal(result.halo.stroke, result.halo.fill, 'the halo has the diagram background color');
  });
});

test('a package takes its outline and tab colors from the diagram theme', async () => {
  await withPage(async (page) => {
    await page.evaluate(() => {
      const container = document.getElementById('diagram');
      container.style.setProperty('--uml-secondary-line', '#123456');
      container.style.setProperty('--uml-fill', '#fedcba');
    });
    await render(page, 'UMLComponentDiagram', HEADLINER);
    const colors = await page.evaluate(() => {
      const group = document.querySelector('#diagram svg g[data-uml-package]');
      return {
        body: group.querySelector('[data-package-part="body"]').getAttribute('stroke'),
        tab: group.querySelector('[data-package-part="tab"]').getAttribute('fill'),
      };
    });
    assert.deepEqual(colors, { body: '#123456', tab: '#fedcba' });
  });
});

test('a package follows the manual positions of its members', async () => {
  await withPage(async (page) => {
    const source = [
      'package Headliner {',
      '  component OPC <<service>> @pos(300, 200)',
      '  component Loyalty @pos(560, 200)',
      '}',
      'component Partner @pos(0, 0)',
      'OPC --> Loyalty',
    ].join('\n');
    const result = await drawn(page, source, ['OPC', 'Loyalty', 'Partner']);
    assert.deepEqual([result.boxes.OPC.x, result.boxes.OPC.y], [300, 200]);
    const [pkg] = result.packages;
    for (const id of ['OPC', 'Loyalty']) assert.ok(contains(pkg.body, result.boxes[id], 1), `${id} is inside Headliner`);
    assert.ok(!overlaps(pkg.body, result.boxes.Partner), 'Partner stays outside');
  });
});

test('nested packages nest inside their parents', async () => {
  await withPage(async (page) => {
    const source = [
      'package Headliner {',
      '  component OPC',
      '  package Integrations {',
      '    component Relay',
      '  }',
      '}',
      'OPC --> Relay',
    ].join('\n');
    const parsed = await page.evaluate((text) => window.UMLComponentDiagram.parse(text), source);
    assert.deepEqual(parsed.packages.map((p) => [p.id, p.parent, p.members]), [['Headliner', null, ['OPC']], ['Integrations', 'Headliner', ['Relay']]]);
    const result = await drawn(page, source, ['OPC', 'Relay']);
    const outer = result.packages.find((p) => p.id === 'Headliner');
    const inner = result.packages.find((p) => p.id === 'Integrations');
    assert.ok(contains(outer.body, inner.body) && contains(outer.body, inner.tab), 'the inner package, tab included, is inside the outer one');
    assert.ok(contains(inner.body, result.boxes.Relay, 1), 'Relay is inside Integrations');
    assert.ok(contains(outer.body, result.boxes.OPC, 1) && !overlaps(inner.body, result.boxes.OPC), 'OPC is only in Headliner');
  });
});

test('a one-line package body still places its members in the package', async () => {
  await withPage(async (page) => {
    const source = 'package Headliner { component OPC; component Loyalty }\ncomponent Partner\nOPC --> Loyalty\nLoyalty --> Partner';
    const result = await drawn(page, source, ['OPC', 'Loyalty', 'Partner']);
    assert.ok(result.boxes.OPC && result.boxes.Loyalty, 'both members are drawn');
    const [pkg] = result.packages;
    for (const id of ['OPC', 'Loyalty']) assert.ok(contains(pkg.body, result.boxes[id], 1), `${id} is inside Headliner`);
    assert.ok(!overlaps(pkg.body, result.boxes.Partner), 'the statement after the block is outside it');
  });
});

test('rectangle blocks remain a parse no-op', async () => {
  await withPage(async (page) => {
    const source = 'rectangle "Scope" {\n  component OPC\n}\ncomponent Partner\nOPC --> Partner';
    const parsed = await page.evaluate((text) => window.UMLComponentDiagram.parse(text), source);
    assert.deepEqual(parsed.packages, []);
    assert.deepEqual(parsed.components.map((c) => c.name), ['OPC', 'Partner']);
    const result = await drawn(page, source, ['OPC', 'Partner']);
    assert.equal(result.packages.length, 0, 'no frame is drawn for a rectangle');
    assert.ok(result.boxes.OPC && result.boxes.Partner);
  });
});

test('provided and required interfaces join inside and across packages', async () => {
  await withPage(async (page) => {
    const source = [
      'package Headliner {',
      '  component OPC <<service>> {',
      '    provide "PurchaseOrderService" as po',
      '    require "Payments" as opc_pay',
      '  }',
      '  component Website <<web application>> {',
      '    require "PurchaseOrderService" as w_po',
      '  }',
      '}',
      'component Bank <<external>> {',
      '  provide "Payments" as pay',
      '}',
      'po --> w_po',
      'pay --> opc_pay',
    ].join('\n');
    const parsed = await page.evaluate((text) => window.UMLComponentDiagram.parse(text), source);
    assert.deepEqual(parsed.components.map((c) => [c.name, c.package || null, c.ports.map((p) => p.kind)]),
      [['OPC', 'Headliner', ['provide', 'require']], ['Website', 'Headliner', ['require']], ['Bank', null, ['provide']]]);
    const result = await drawn(page, source, ['OPC', 'Website', 'Bank']);
    for (const [source, target] of [['OPC.po', 'Website.w_po'], ['Bank.pay', 'OPC.opc_pay']]) {
      assert.ok(result.routes.some((r) => r.source === source), `${source} has its assembly`);
      assert.ok(result.routes.some((r) => r.target === target), `${target} has its assembly`);
    }
    const [pkg] = result.packages;
    assert.ok(contains(pkg.body, result.boxes.OPC, 1) && contains(pkg.body, result.boxes.Website, 1));
    assert.ok(!overlaps(pkg.body, result.boxes.Bank), 'Bank is outside Headliner');
  });
});

// What is drawn at a member belongs inside its package: the member's own
// interface symbols and names, and the joined ball and socket that an
// assembly draws beside it, with their names.
test('the frame encloses the interfaces drawn at a member, joined ones included', async () => {
  await withPage(async (page) => {
    const source = [
      'package Headliner {',
      '  component Planner',
      '  component Notifications {',
      '    provide "Status" as status',
      '    require "Templates" as templates',
      // A joined ball and socket is drawn beside its provider: the member.
      '    provide "MailDelivery" as smtp',
      '  }',
      '}',
      'component MailRelay <<external>> {',
      '  require "MailDelivery" as relay_smtp',
      '}',
      'smtp --> relay_smtp',
      '@layout',
      'Planner @pos(0, 0)',
      'Notifications @pos(260, 0)',
      'MailRelay @pos(700, 0)',
      'Notifications.status @pos(330, 0)',
      'Notifications.templates @pos(330, 130)',
      'Notifications.smtp @pos(432, 65)',
      'MailRelay.relay_smtp @pos(700, 65)',
      '@endlayout',
    ].join('\n');
    await render(page, 'UMLComponentDiagram', source);
    const { pkg, member, outside, interfaces, symbols, texts } = await page.evaluate(() => ({
      pkg: measure.packages()[0],
      member: measure.componentBox('Notifications'),
      outside: measure.componentBox('MailRelay'),
      interfaces: ['Status', 'Templates', 'MailDelivery'].map((name) => measure.text(name)),
      symbols: [...document.querySelectorAll('#diagram svg circle, #diagram svg path')]
        .filter((el) => !el.closest('defs')).map((el) => measure.box(el)),
      texts: measure.texts(),
    }));
    const joinedName = interfaces[2];
    assert.equal(symbols.length, 4, 'a ball, a socket, and one joined ball and socket (test setup)');
    assert.ok(joinedName.x - member.right < outside.x - joinedName.right, 'the joined symbol is drawn at the member (test setup)');

    for (const box of [...symbols, ...interfaces]) {
      assert.ok(contains(pkg.body, box, 1), `${box.text ? `"${box.text}"` : 'an interface symbol'} lies inside the frame`);
    }
    for (const text of texts.filter((t) => t.text !== 'Headliner')) {
      const acrossBody = overlaps(pkg.body, text) && !contains(pkg.body, text, 1);
      assert.ok(!acrossBody && !overlaps(pkg.tab, text), `"${text.text}" keeps off the frame outline`);
    }
    assert.ok(!overlaps(pkg.body, outside) && !overlaps(pkg.tab, outside), 'MailRelay stays outside the frame');
    assert.deepEqual(pkg.overlaps, []);
  });
});
