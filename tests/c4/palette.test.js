'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { PALETTE, contrastReport } = require('../../c4/c4-render.js');

// Spec §6.2: every diagram colour is checked on the real backdrops — the light page, the dark page after the
// site's `invert(1) hue-rotate(180deg)` filter, and white paper — with 4.5:1 for text and 3:1 for marks.
const BACKDROPS = ['light page', 'dark page', 'paper'];
const TEXT_MINIMUM = 4.5;
const MARK_MINIMUM = 3;

// The colour pairs the diagram draws, listed by hand from what c4-render.js paints, so that a palette key added
// later fails the classification test below until it is placed in a pair here. Text sits on the page (titles,
// boundary labels, legend) and on every fill (boxes and relationship labels); strokes, boundaries, and edges are
// marks on the page, and each box stroke is also a mark on its own fill.
const TEXT_PAIRS = [
  'text on page',
  'text on labelFill',
  'text on personFill',
  'text on systemFill',
  'text on containerFill',
  'text on componentFill',
  'text on externalFill',
];
const MARK_PAIRS = [
  'personStroke on page',
  'systemStroke on page',
  'containerStroke on page',
  'componentStroke on page',
  'externalStroke on page',
  'boundaryStroke on page',
  'edge on page',
  'personStroke on personFill',
  'systemStroke on systemFill',
  'containerStroke on containerFill',
  'componentStroke on componentFill',
  'externalStroke on externalFill',
];

function ratiosOf(report, pair) {
  return Object.fromEntries(report.filter((entry) => entry.pair === pair).map((entry) => [entry.backdrop, entry.ratio]));
}

function assertPairsReach(pairs, minimum) {
  const report = contrastReport(PALETTE);
  pairs.forEach((pair) => {
    const ratios = ratiosOf(report, pair);
    assert.deepEqual(Object.keys(ratios).sort(), [...BACKDROPS].sort(), `${pair} is checked on every backdrop`);
    BACKDROPS.forEach((backdrop) => {
      assert.ok(ratios[backdrop] >= minimum, `${pair} on the ${backdrop}: ${ratios[backdrop].toFixed(2)}:1 < ${minimum}:1`);
    });
  });
}

test('every palette colour belongs to a drawn pair the contrast checks cover', () => {
  const classified = new Set(TEXT_PAIRS.concat(MARK_PAIRS).flatMap((pair) => pair.split(' on ')));
  classified.delete('page');
  assert.deepEqual(Object.keys(PALETTE).sort(), [...classified].sort());
});

test('every palette text pair reaches 4.5:1 on the light page, the inverted dark page, and paper', () => {
  assertPairsReach(TEXT_PAIRS, TEXT_MINIMUM);
});

test('every palette mark reaches 3:1 against its backdrops', () => {
  assertPairsReach(MARK_PAIRS, MARK_MINIMUM);
});

test('the report marks each pair as passing exactly when it reaches its requirement', () => {
  const report = contrastReport(PALETTE);
  report.forEach((entry) => {
    assert.equal(entry.required, entry.pair.startsWith('text on') ? TEXT_MINIMUM : MARK_MINIMUM, entry.pair);
    assert.equal(entry.pass, entry.ratio >= entry.required, `${entry.pair} on the ${entry.backdrop}`);
  });
  const failing = contrastReport(Object.assign({}, PALETTE, { text: '#999999' }));
  assert.equal(failing.find((entry) => entry.pair === 'text on page' && entry.backdrop === 'paper').pass, false);
});

// Pure red text on the page, worked by hand from the WCAG relative-luminance formula. Light page #fdfdfd and
// paper #ffffff use the colour as drawn. In the dark page, invert(1) gives #00ffff and hue-rotate(180deg) with the
// Filter Effects matrix gives (1, 0.574, 0.574), composited on #121212. A plain invert would give 14.9:1 there.
test('the dark backdrop applies invert(1) then hue-rotate(180deg) with the CSS filter matrices on #121212', () => {
  const ratios = ratiosOf(contrastReport(Object.assign({}, PALETTE, { text: '#ff0000' })), 'text on page');
  assert.ok(Math.abs(ratios['light page'] - 3.93) < 0.01, `light page ${ratios['light page']}`);
  assert.ok(Math.abs(ratios.paper - 4.00) < 0.01, `paper ${ratios.paper}`);
  assert.ok(Math.abs(ratios['dark page'] - 8.75) < 0.02, `dark page ${ratios['dark page']}`);
});
