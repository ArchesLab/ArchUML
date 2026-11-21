'use strict';

// Characterization of teaching-callout placement. Each drawing below makes
// the placement search work hard in one way; the expected boxes and pointer
// outlines are the exact numbers the search produced when this file was
// written. A change to how callouts are placed must leave every number as it
// is, unless it is meant to move callouts — then regenerate the numbers and
// check the new placements by eye.
//
// The drawings go through drawCompact, which reads geometry from markup, so
// the test needs no layout engine. The stub canvas measures 8 units per
// character.

const assert = require('assert/strict');
const test = require('node:test');
const { loadBundle } = require('./support/load-bundle');

const { UMLCallouts } = loadBundle();

const drawing = (width, height, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
const label = (x, y, text, extra = '') => `<text x="${x}" y="${y}" font-size="14"${extra}>${text}</text>`;

// Labels on a grid, `centre` at its middle and `text` everywhere else.
function labelGrid(rows, columns, dx, dy, text, centre) {
  const labels = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const middle = row === rows >> 1 && column === columns >> 1;
      labels.push(label(100 + column * dx, 100 + row * dy, middle ? centre : text));
    }
  }
  return labels.join('');
}

// A walled room around label "XX" whose left wall has a gap `slit` high.
function walledRoom(slit, wallX) {
  const middle = 200, top = 160, bottom = 240, right = 260;
  return `<rect x="${wallX - 2}" y="${top}" width="4" height="${middle - slit / 2 - top}"/>` +
    `<rect x="${wallX - 2}" y="${middle + slit / 2}" width="4" height="${bottom - middle - slit / 2}"/>` +
    `<rect x="${wallX}" y="${top - 2}" width="${right - wallX}" height="4"/>` +
    `<rect x="${wallX}" y="${bottom - 2}" width="${right - wallX}" height="4"/>` +
    `<rect x="${right - 2}" y="${top}" width="4" height="${bottom - top}"/>` +
    label(200, middle + 5, 'XX');
}

/** Each callout's box (x y width height) and pointer points, as drawn. */
function placements(svg, directives) {
  const { callouts } = UMLCallouts.extract(directives.join('\n'));
  const markup = UMLCallouts.drawCompact(svg, null, callouts, { fontSize: 14, margin: 10 });
  const layer = markup.slice(markup.indexOf('<g class="uml-callouts">'));
  return [...layer.matchAll(/<g class="uml-callout"[\s\S]*?<\/g>/g)].map(([group]) => {
    const box = /<rect class="uml-callout-box" x="([^"]*)" y="([^"]*)" width="([^"]*)" height="([^"]*)"/.exec(group);
    return { box: box.slice(1).join(' '), pointer: /<polygon class="uml-callout-pointer" points="([^"]*)"/.exec(group)[1] };
  });
}

test('four callouts competing for the space around one class keep their placements', () => {
  const svg = drawing(420, 260, '<rect x="120" y="60" width="180" height="140" fill="white" stroke="black"/>' +
    label(210, 82, 'Order', ' text-anchor="middle" font-weight="bold"') + '<line x1="120" y1="90" x2="300" y2="90"/>' +
    label(128, 110, '- id: int') + label(128, 130, '- total: Money') + label(128, 150, '+ place()') + label(128, 170, '+ cancel()'));
  assert.deepEqual(placements(svg, [
    'callout left of text "- id: int" : Attribute: private state of each order',
    'callout right of text "+ place()" : Operation: what a client may ask an order to do',
    'callout top of text "Order" : Class name',
    'callout bottom of text "+ cancel()" : Another public operation, listed under the others',
  ]), EXPECTED.competing);
});

test('callouts on routes, a label on a route and a class box keep their placements', () => {
  const svg = drawing(400, 300, '<rect x="40" y="40" width="80" height="40" data-layout-bounds-id="A"/>' + label(60, 65, 'A') +
    '<rect x="260" y="200" width="80" height="40" data-layout-bounds-id="B"/>' + label(290, 225, 'B') +
    '<polyline data-layout-route-id="r1" fill="none" points="120,60 200,60 200,220 260,220"/>' +
    '<line data-layout-route-id="r2" x1="80" y1="80" x2="80" y2="260"/>' + label(205, 140, 'uses') + label(150, 55, '1..*'));
  assert.deepEqual(placements(svg, [
    'callout right of edge 1 middle : Association',
    'callout bottom of edge 2 end : Line end',
    'callout top of text "1..*" : Multiplicity',
    'callout left of element B : Class B',
  ]), EXPECTED.routes);
});

test('a pointer that only fits narrowed, found on the nearest search, keeps its placement', () => {
  assert.deepEqual(placements(drawing(500, 400, walledRoom(16, 160)), ['callout left of text "XX" : Pointer through a slit']),
    EXPECTED.narrowedNear);
});

test('a pointer that only fits narrowed, found on the second search, keeps its placement', () => {
  assert.deepEqual(placements(drawing(500, 400, walledRoom(16, 150)), ['callout left of text "XX" : Pointer through a slit']),
    EXPECTED.narrowedSecond);
});

test('a needle pointer found only on the widest search keeps its placement', () => {
  assert.deepEqual(placements(drawing(460, 330, labelGrid(7, 7, 34, 22, 'ab', 'XX')), [
    'callout left of text "XX" : Reached only by a narrow pointer',
    'callout top of text "ab" occurrence 1 : Corner label',
  ]), EXPECTED.needle);
});

test('a callout with no clear pointer anywhere is placed first and keeps its forced placement', () => {
  assert.deepEqual(placements(drawing(460, 330, labelGrid(7, 5, 34, 22, 'abcd', 'XX')), [
    'callout left of text "abcd" occurrence 1 : Corner label',
    'callout right of text "XX" : No clear way in',
  ]), EXPECTED.forced);
});

test('callouts placed again after one is crowded out keep the cheaper arrangement', () => {
  assert.deepEqual(placements(drawing(460, 330, labelGrid(7, 5, 34, 22, 'abcd', 'XX')), [
    'callout left of text "abcd" occurrence 16 : Left middle label of the field',
    'callout right of text "abcd" occurrence 20 : Right middle label',
    'callout left of text "XX" : No clear way in',
  ]), EXPECTED.reordered);
});

const EXPECTED = {
  reordered: [
    { box: '-126 86.76 208 50', pointer: '72.10050506338834,136.76 96,152.56 82,126.86050506338833' },
    { box: '-78 204.76 160 30', pointer: '72.10050506338834,204.76 96,191.36 82,214.65949493661165' },
    { box: '-68 146.76000000000002 136 30', pointer: '68,149.76000000000002 164,161.76000000000002 68,173.76000000000002' },
  ],
  competing: [
    { box: '-98 42.760000000000005 208 50', pointer: '100.10050506338834,92.76 124,96.56 110,82.86050506338835' },
    { box: '-98 114.76 208 50', pointer: '110,132.76 124,139.76 110,146.76' },
    { box: '144 20.560000000000002 96 30', pointer: '185,50.56 192,64.56 199,50.56' },
    { box: '-90 174.76 200 70', pointer: '100.10050506338834,174.76 124,173.36 110,184.65949493661165' },
  ],
  routes: [
    { box: '221 68.5 104 30', pointer: '221,76.5 207,83.5 221,90.5' },
    { box: '38.5 281 80 30', pointer: '71.5,281 78.5,267 85.5,281' },
    { box: '94 -6.439999999999998 112 30', pointer: '143,23.560000000000002 150,37.56 157,23.560000000000002' },
    { box: '170 232 72 30', pointer: '242,235 256,240 242,249' },
  ],
  narrowedNear: [
    { box: '-40 185.76 192 30', pointer: '152,193.76 196,200.76 152,207.76' },
  ],
  narrowedSecond: [
    { box: '-58 185.76 192 30', pointer: '134,193.01 196,200.76 134,208.51' },
  ],
  needle: [
    { box: '-24 -49.23999999999998 208 50', pointer: '174.10050506338834,0.7600000000000193 198,152.56 184,-9.139494936611646' },
    { box: '44 38.56 112 30', pointer: '93,68.56 100,82.56 107,68.56' },
  ],
  forced: [
    { box: '-30 72.76 112 30', pointer: '82,80.76 96,87.76 82,94.76' },
    { box: '-58 146.76000000000002 136 30', pointer: '78,149.76000000000002 164,161.76000000000002 78,173.76000000000002' },
  ],
};
