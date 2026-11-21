'use strict';

// Component stereotypes follow UML 2.5.1: keywords in plain face, centered
// within one pair of guillemets above the bold name (9.2.4, 12.3.4), with the
// component icon kept (11.6.4). Components without stereotypes keep their
// existing one-line header.
const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { launchBrowser, openDiagramPage, render, overlaps, contains } = require('./support/diagram-page');

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { if (browser) await browser.close(); });

async function withPage(run, options) {
  const page = await openDiagramPage(browser, options);
  try { await run(page); } finally { await page.close(); }
}

function parse(page, source) {
  return page.evaluate((text) => window.UMLComponentDiagram.parse(text), source);
}

test('a stereotyped component with a port block keeps its box and its ports', async () => {
  await withPage(async (page) => {
    const source = [
      'component "Trip Website" as Website <<web application>> {',
      '  portout "orders" as w_out',
      '}',
      'component OPC <<service>> {',
      '  portin "orders" as opc_in',
      '}',
      'w_out --> opc_in : HTTPS',
    ].join('\n');
    const parsed = await parse(page, source);
    assert.deepEqual(parsed.components.map((c) => c.name), ['Website', 'OPC'], 'ports must not become components');
    assert.deepEqual(parsed.components.map((c) => c.ports.map((p) => p.alias)), [['w_out'], ['opc_in']]);

    await render(page, 'UMLComponentDiagram', source);
    const drawn = await page.evaluate(() => ({ ids: measure.componentIds(), routes: measure.routes() }));
    assert.deepEqual(drawn.ids.sort(), ['OPC', 'Website']);
    assert.equal(drawn.routes.length, 1);
    assert.equal(drawn.routes[0].source, 'Website.w_out', 'the connector starts at the Website port');
    assert.equal(drawn.routes[0].target, 'OPC.opc_in');
  });
});

for (const [kind, source] of [
  ['without ports', 'component OrderDB <<repository>>'],
  ['with ports', 'component OrderDB <<repository>> {\n  portin "queries" as db_in\n}\ncomponent Client\nClient --> db_in'],
]) {
  test(`a stereotype ${kind} is centered in plain face above the centered bold name`, async () => {
    await withPage(async (page) => {
      await render(page, 'UMLComponentDiagram', source);
      const drawn = await page.evaluate(() => ({
        box: measure.componentBox('OrderDB'), stereotype: measure.text('«repository»'), name: measure.text('OrderDB'),
      }));
      assert.ok(drawn.stereotype, 'the stereotype is shown within guillemets');
      assert.equal(drawn.stereotype.bold, false, 'plain face, not bold');
      assert.equal(drawn.stereotype.italic, false, 'plain face, not italic');
      assert.equal(drawn.name.bold, true, 'the name stays bold');
      assert.ok(drawn.stereotype.bottom <= drawn.name.y + 1, 'the stereotype sits above the name');
      const center = (text) => text.x + text.width / 2;
      assert.ok(Math.abs(center(drawn.stereotype) - center(drawn.name)) < 1, 'stereotype and name share one center line');
      assert.ok(contains(drawn.box, drawn.stereotype, 2) && contains(drawn.box, drawn.name, 2), 'both lines fit inside the box');
    });
  });
}

test('stereotype lists display as one comma-separated pair with the author\'s capitalization', async () => {
  await withPage(async (page) => {
    const parsed = await parse(page, 'component A <<Service, External>>\ncomponent B <<Service>> <<External>>');
    assert.deepEqual(parsed.components.map((c) => c.stereotype), ['Service, External', 'Service, External']);
    await render(page, 'UMLComponentDiagram', 'component A <<Service, External>>\ncomponent B <<Service>> <<External>>\nA --> B');
    const labels = await page.evaluate(() => measure.texts().map((t) => t.text));
    assert.equal(labels.filter((text) => text === '«Service, External»').length, 2);
  });
});

test('a color before or after the stereotype parses, as do textures, dashes, and the bracket form', async () => {
  await withPage(async (page) => {
    const parsed = await parse(page, [
      'component A #lightblue <<service>>',
      'component B <<service>> #lightblue',
      'component C <<service>> #FFEB3B hatched {',
      '  portin "in" as c_in',
      '}',
      'component D <<repository>> dashed',
      '[E] <<external>>',
    ].join('\n'));
    const summary = parsed.components.map((c) => [c.name, c.stereotype, c.highlight || null, c.texture || null, c.visualStyle || null]);
    assert.deepEqual(summary, [
      ['A', 'service', 'lightblue', null, null],
      ['B', 'service', 'lightblue', null, null],
      ['C', 'service', '#FFEB3B', 'hatched', null],
      ['D', 'repository', null, null, 'dashed'],
      ['E', 'external', null, null, null],
    ]);
    assert.deepEqual(parsed.components[2].ports.map((p) => p.alias), ['c_in']);
  });
});

test('a two-line header keeps every port below the name', async () => {
  await withPage(async (page) => {
    await render(page, 'UMLComponentDiagram', [
      'component Broker <<message broker>> {',
      '  portin "publish" as b_in',
      '  portout "deliver" as b_out',
      '  portout "dead letters" as b_dead',
      '}',
      'component Producer',
      'component Consumer',
      'component Auditor',
      'Producer --> b_in',
      'b_out --> Consumer',
      'b_dead --> Auditor',
    ].join('\n'));
    const drawn = await page.evaluate(() => ({ name: measure.text('Broker'), ports: measure.ports() }));
    assert.equal(drawn.ports.length, 3);
    for (const port of drawn.ports) {
      assert.ok(port.y >= drawn.name.bottom, `${port.id} starts below the name`);
    }
  });
});

test('an aliased stereotyped component keeps its manual position', async () => {
  await withPage(async (page) => {
    await render(page, 'UMLComponentDiagram', [
      'component "Trip Website" as Website <<web application>> @pos(400, 120) {',
      '  portout "orders" as w_out',
      '}',
      'component OPC <<service>> #lightblue @pos(40, 20)',
      'w_out --> OPC',
    ].join('\n'));
    const boxes = await page.evaluate(() => ({ website: measure.componentBox('Website'), opc: measure.componentBox('OPC') }));
    assert.deepEqual([boxes.website.x, boxes.website.y], [400, 120]);
    assert.deepEqual([boxes.opc.x, boxes.opc.y], [40, 20]);
  });
});

test('a stereotyped component keeps its component icon clear of the header text', async () => {
  await withPage(async (page) => {
    await render(page, 'UMLComponentDiagram', 'component Gateway <<external service, rate limited>>');
    const drawn = await page.evaluate(() => {
      const box = measure.componentBox('Gateway');
      const parts = [...document.querySelectorAll('#diagram svg rect')]
        .filter((el) => el.getAttribute('data-layout-id') === 'Gateway' && !el.classList.contains('uml-component-box'))
        .map(measure.box)
        .filter((rect) => rect.width < box.width / 2);
      return { box, icon: parts, texts: [measure.text('«external service, rate limited»'), measure.text('Gateway')] };
    });
    assert.ok(drawn.icon.length >= 1, 'the component icon is drawn');
    for (const part of drawn.icon) {
      assert.ok(contains(drawn.box, part), 'the icon stays inside the box');
      for (const text of drawn.texts) assert.ok(!overlaps(part, text), `the icon clears "${text.text}"`);
    }
  });
});

test('components without stereotypes keep their one-line header', async () => {
  await withPage(async (page) => {
    await render(page, 'UMLComponentDiagram', [
      'component Client',
      'component Backend {',
      '  portin "httpIn" as b_in',
      '}',
      'Client --> b_in : REST',
    ].join('\n'));
    const drawn = await page.evaluate(() => ({
      client: measure.componentBox('Client'), backend: measure.componentBox('Backend'),
      clientName: measure.texts().find((t) => t.text === 'Client' && t.bold),
      backendName: measure.texts().find((t) => t.text === 'Backend' && t.bold),
      port: measure.ports()[0],
      guillemets: measure.texts().filter((t) => t.text.includes('«')).length,
    }));
    assert.equal(drawn.guillemets, 0);
    // A box without ports centers its name; a box with ports puts it top-left.
    assert.equal(drawn.client.height, 50);
    assert.equal(drawn.clientName.anchor, 'middle');
    assert.equal(drawn.backend.height, 90);
    assert.equal(drawn.backendName.anchor, 'start');
    assert.ok(Math.abs(drawn.backendName.x - (drawn.backend.x + 24)) < 1, 'the name starts one padding from the left edge');
    assert.ok(drawn.port.y >= drawn.backend.y + 36, 'the port area starts below a one-line header');
  });
});

test('provided and required interfaces join inside stereotyped components', async () => {
  await withPage(async (page) => {
    const source = [
      'component Bank <<external>> {',
      '  provide "Payments" as pay',
      '}',
      'component Shop <<service>> {',
      '  require "Payments" as need_pay',
      '}',
      'pay --> need_pay',
    ].join('\n');
    const parsed = await parse(page, source);
    assert.deepEqual(parsed.components.map((c) => [c.name, c.stereotype, c.ports.map((p) => p.kind)]),
      [['Bank', 'external', ['provide']], ['Shop', 'service', ['require']]]);
    await render(page, 'UMLComponentDiagram', source);
    const drawn = await page.evaluate(() => ({
      routes: measure.routes(),
      circles: document.querySelectorAll('#diagram svg circle').length,
      label: measure.text('Payments'),
    }));
    // A joined assembly is drawn as two halves meeting at the ball and socket.
    assert.ok(drawn.routes.some((r) => r.source === 'Bank.pay'), 'the assembly leaves the provided interface');
    assert.ok(drawn.routes.some((r) => r.target === 'Shop.need_pay'), 'the assembly reaches the required interface');
    assert.ok(drawn.circles >= 1, 'the provided interface is drawn as a ball');
    assert.ok(drawn.label, 'the shared interface name is shown');
  });
});

for (const label of ['<<subscribe>> {binding = "trip.*"}', '«subscribe» {binding = "trip.*"}']) {
  test(`a connector label ${label} shows the stereotype in guillemets and keeps the property string`, async () => {
    await withPage(async (page) => {
      const source = `component Exchange\ncomponent Loyalty\nExchange -- Loyalty : ${label}`;
      const parsed = await parse(page, source);
      assert.equal(parsed.connectors[0].label, '«subscribe» {binding = "trip.*"}');
      await render(page, 'UMLComponentDiagram', source);
      const drawn = await page.evaluate(() => {
        const label = document.querySelector('#diagram svg text.uml-component-connector-label');
        return { text: label.textContent, box: measure.box(label),
          components: [measure.componentBox('Exchange'), measure.componentBox('Loyalty')] };
      });
      // A long label may wrap onto a second line; its characters stay the same.
      assert.equal(drawn.text.replace(/\s+/g, ''), '«subscribe»{binding="trip.*"}', 'every character of the label is shown');
      for (const component of drawn.components) assert.ok(!overlaps(drawn.box, component), 'the label stays off the components');
    });
  });
}
