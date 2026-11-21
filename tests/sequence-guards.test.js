'use strict';

// A combined fragment's guard is drawn over the lifelines it crosses (UML
// 2.5.1, 17.6.4: the constraint covers the lifeline). Nothing drawn behind a
// guard may show through its text: hide the text and its box must be blank.
// The guard's own fragment stays readable: the operator tab and the dashed
// divider of an alternative keep their outlines.
const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { launchBrowser, openDiagramPage, render, inkPixels } = require('./support/diagram-page');

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { if (browser) await browser.close(); });

const GUARDS = '#diagram svg text[data-layout-fragment-role]';

// A guard on a plain lifeline, one on an activation bar, an alternative's
// second guard below its divider, and a long guard.
const SOURCE = [
  'participant site: TripWebsite',
  'participant po: PurchaseOrderService',
  'participant bank: Bank',
  'participant supplier: SupplierProvider',
  'site -> po: submit(tripOrder)',
  'activate po',
  'opt [the fan has a loyalty account]',
  'po -> bank: capture(cardToken, amount)',
  'end',
  'loop [for each supplier order]',
  'po -> bank: refund(amount)',
  'end',
  'alt [decision is reject]',
  'po -> site: rejected',
  'else [every supplier order confirmed]',
  'po -> site: confirmed',
  'end',
  'opt [every supplier order cancelled or rejected by the gateway]',
  'po -> supplier: cancel(supplierOrder)',
  'end',
  'deactivate po',
].join('\n');

// Draw the way site pages do. css/uml-diagram.css sizes a drawing so its
// smallest text has the paragraph size, and main.css sets the body's font
// weight to 500, which SVG text inherits.
async function renderAsPagesDo(page) {
  await page.addStyleTag({ content: 'body { font-weight: 500; } ' +
    '#diagram svg { display: block; width: var(--uml-readable-width, auto); height: auto; }' });
  await render(page, 'UMLSequenceDiagram', SOURCE);
}

/** Page-coordinate boxes of the guards, inset so only their inside is sampled. */
async function guardBoxes(page) {
  return page.$$eval(GUARDS, (texts) => texts.map((text) => {
    const box = text.getBoundingClientRect();
    return { text: text.textContent, x: box.x + 1, y: box.y + 1, width: box.width - 2, height: box.height - 2 };
  }));
}

test('no lifeline or activation bar shows through a guard', async () => {
  const page = await openDiagramPage(browser);
  try {
    await renderAsPagesDo(page);
    const guards = await guardBoxes(page);
    assert.equal(guards.length, 5, 'the example draws five guards');
    for (const guard of guards) {
      assert.equal(await inkPixels(page, guard, GUARDS), 0, `something shows through ${guard.text}`);
    }
  } finally {
    await page.close();
  }
});

test('a lifeline under the first or last letter of a guard stays covered', async () => {
  const page = await openDiagramPage(browser);
  try {
    await renderAsPagesDo(page);
    // Probe lines in the lifeline layer, through each guard's first and
    // last letter, wherever the real lifelines happen to fall.
    await page.evaluate((selector) => {
      const lifeline = document.querySelector('#diagram svg line.uml-sequence-lifeline');
      for (const text of document.querySelectorAll(selector)) {
        const box = text.getBBox();
        for (const x of [box.x + 1, box.x + box.width - 1]) {
          const probe = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          Object.entries({ x1: x, x2: x, y1: box.y - 20, y2: box.y + box.height + 20, stroke: '#000', 'stroke-width': 1 })
            .forEach(([name, value]) => probe.setAttribute(name, value));
          lifeline.after(probe);
        }
      }
    }, GUARDS);
    for (const guard of await guardBoxes(page)) {
      assert.equal(await inkPixels(page, guard, GUARDS), 0, `a line shows through an end of ${guard.text}`);
    }
  } finally {
    await page.close();
  }
});

test('the operator tab and the divider stay drawn where a guard meets them', async () => {
  const page = await openDiagramPage(browser);
  try {
    await renderAsPagesDo(page);
    // One-pixel strips along the tab's lower edge and along the divider,
    // as wide as the guard below them.
    const strips = await page.evaluate((selector) => {
      const strip = (element, guard) => {
        const box = element.getBoundingClientRect();
        const text = guard.getBoundingClientRect();
        const y = element.tagName === 'line' ? box.y : box.bottom - 1;
        return { name: element.tagName, x: text.x, y: Math.floor(y), width: Math.min(text.width, box.right - text.x), height: 1 };
      };
      const guards = [...document.querySelectorAll(selector)];
      const condition = guards.find((g) => g.getAttribute('data-layout-fragment-role') === 'condition');
      const branch = guards.find((g) => g.getAttribute('data-layout-fragment-role') === 'branch');
      const tab = document.querySelector(`#diagram svg polygon[data-layout-fragment-id="${condition.getAttribute('data-layout-fragment-id')}"]`);
      const divider = document.querySelector('#diagram svg line[data-layout-branch-line]');
      return [strip(tab, condition), strip(divider, branch)];
    }, GUARDS);
    for (const strip of strips) {
      assert.ok(await inkPixels(page, strip, GUARDS) > 0, `the ${strip.name === 'line' ? 'divider' : 'operator tab'} disappears above its guard`);
    }
  } finally {
    await page.close();
  }
});
