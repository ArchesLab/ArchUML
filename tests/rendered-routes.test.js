'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { launchBrowser } = require('./support/diagram-page');
const { readRenderedRoutes } = require('./support/rendered-routes');

test('route measurement follows every painted inheritance branch through shared junctions and transforms', async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="diagram"><svg width="100" height="100" viewBox="0 0 100 100" stroke="black">
      <g transform="translate(40 20)">
        <g data-uml-hierarchy="Parent:generalization" data-uml-hierarchy-root="0,0">
          <line x1="0" y1="0" x2="0" y2="10" />
          <line x1="-10" y1="10" x2="10" y2="10" />
          <line data-uml-hierarchy-child="Left" x1="-10" y1="10" x2="-10" y2="20" />
          <line data-uml-hierarchy-child="Right" x1="10" y1="10" x2="10" y2="20" />
        </g>
        <polyline data-layout-route-id="association" data-layout-source="A" data-layout-target="B" points="-20,5 20,5" />
      </g>
      <g transform="translate(80 20)" data-uml-hierarchy="Overlapping:generalization" data-uml-hierarchy-root="0,0">
        <line x1="0" y1="0" x2="0" y2="10" />
        <line x1="0" y1="10" x2="0" y2="10" />
        <line data-uml-hierarchy-child="Near" x1="0" y1="10" x2="0" y2="20" />
        <line data-uml-hierarchy-child="Far" x1="0" y1="10" x2="0" y2="30" />
      </g>
    </svg></div>`);

    const routes = await page.evaluate(readRenderedRoutes);

    assert.equal(routes.length, 5, 'all inheritance branches and the association must be measured');
    const branches = routes.filter(route => route.id.startsWith('hierarchy:Parent:'))
      .map(route => route.points).sort((a, b) => a[a.length - 1].x - b[b.length - 1].x);
    assert.deepEqual(branches, [
      [{ x: 40, y: 20 }, { x: 40, y: 30 }, { x: 30, y: 30 }, { x: 30, y: 40 }],
      [{ x: 40, y: 20 }, { x: 40, y: 30 }, { x: 50, y: 30 }, { x: 50, y: 40 }],
    ]);
    assert.deepEqual(routes.find(route => route.id === 'association'), {
      id: 'association', source: 'A', target: 'B', points: [{ x: 20, y: 25 }, { x: 60, y: 25 }],
    });
    const overlapping = routes.filter(route => route.id.startsWith('hierarchy:Overlapping:'))
      .map(route => route.points).sort((a, b) => a[a.length - 1].y - b[b.length - 1].y);
    assert.deepEqual(overlapping, [
      [{ x: 80, y: 20 }, { x: 80, y: 40 }],
      [{ x: 80, y: 20 }, { x: 80, y: 50 }],
    ]);
  } finally {
    await browser.close();
  }
});
