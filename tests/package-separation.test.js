'use strict';

// UMLShared.separatedPackagePositions: a placement whose package frames lie
// on each other or on an element they do not hold, moved apart without
// changing the order of the elements on either axis. Everything from where
// the later of two clashing things starts moves on by the overlap and the
// gap, so the arrangement (and every straight edge) stays as it was.
const assert = require('node:assert/strict');
const test = require('node:test');
const { loadBundle } = require('./support/load-bundle');

const { UMLShared } = loadBundle();

const STYLE = { fontFamily: 'sans-serif', fontSizeBold: 14, fontSizeStereotype: 12, lineHeight: 20 };
const GAP = 36;

const box = (x, y, width = 100, height = 60) => ({ x, y, width, height });
const pkg = (id, members, parent = null) => ({ id, label: id, stereotype: null, parent, members });
const plain = (value) => JSON.parse(JSON.stringify(value));

function separate(packages, boxes) {
  const positions = UMLShared.separatedPackagePositions(packages, boxes, STYLE, GAP);
  return positions && plain(positions);
}

// The boxes at the new positions.
function moved(boxes, positions) {
  return Object.fromEntries(Object.entries(boxes).map(([id, b]) => [id, { ...b, ...positions[id] }]));
}

// Element ids ordered by their start on an axis (ties by id).
function order(boxes, axis) {
  return Object.keys(boxes).sort((a, b) => boxes[a][axis] - boxes[b][axis] || (a < b ? -1 : 1));
}

function outer(packages, boxes, id) {
  const frames = UMLShared.layoutPackageFrames(packages, (e) => boxes[e] || null, Object.keys(boxes), STYLE);
  return frames.find((f) => f.id === id).outer;
}

// Two packages in rows whose frames overlap: the upper frame reaches over
// the lower package's tab, as in the default drawing of two sibling packages.
const ROWS = [pkg('Frontend', ['Web', 'Mobile']), pkg('Backend', ['API', 'Worker'])];
const ROW_BOXES = {
  Web: box(0, 0), Mobile: box(200, 0),
  API: box(200, 110), Worker: box(200, 230),
  Database: box(0, 350),
};

test('two sibling frames that overlap are moved apart, the later one down by the overlap and the gap', () => {
  assert.equal(UMLShared.packagesCollide(ROWS, ROW_BOXES, STYLE), true, 'the frames overlap to begin with');
  const positions = separate(ROWS, ROW_BOXES);
  const after = moved(ROW_BOXES, positions);
  assert.equal(UMLShared.packagesCollide(ROWS, after, STYLE), false);
  const upper = outer(ROWS, after, 'Frontend'), lower = outer(ROWS, after, 'Backend');
  assert.ok(lower.y - (upper.y + upper.height) >= GAP - 1e-9, `frames ${lower.y - (upper.y + upper.height)} apart, at least ${GAP}`);
});

test('separating frames keeps the order of the elements on both axes and every offset within a frame', () => {
  const after = moved(ROW_BOXES, separate(ROWS, ROW_BOXES));
  assert.deepEqual(order(after, 'x'), order(ROW_BOXES, 'x'));
  assert.deepEqual(order(after, 'y'), order(ROW_BOXES, 'y'));
  // Moving along y only: every column, and so every vertical edge, stays.
  for (const id of Object.keys(ROW_BOXES)) assert.equal(after[id].x, ROW_BOXES[id].x, `${id} keeps its x`);
  assert.equal(after.Worker.y - after.API.y, ROW_BOXES.Worker.y - ROW_BOXES.API.y, 'API and Worker keep their offset');
  assert.equal(after.Mobile.y, ROW_BOXES.Mobile.y, 'the upper package stays where it was');
});

test('an element a frame reaches over without holding it is moved out of the frame', () => {
  const packages = [pkg('Security', ['Auth'])];
  // The frame reaches 18 beyond Auth's right side, over Users' left 8.
  const boxes = { Auth: box(0, 0), Users: box(110, 20) };
  assert.equal(UMLShared.packagesCollide(packages, boxes, STYLE), true);
  const after = moved(boxes, separate(packages, boxes));
  assert.equal(UMLShared.packagesCollide(packages, after, STYLE), false);
  assert.deepEqual(after.Auth, boxes.Auth);
  assert.equal(after.Users.y, boxes.Users.y, 'Users moves across, the way it overlaps least');
});

test('sibling frames inside a package are moved apart and stay nested in it', () => {
  const packages = [pkg('Platform', ['Gateway']), pkg('Services', ['Accounts'], 'Platform'), pkg('Data', ['Store'], 'Platform')];
  const boxes = { Gateway: box(0, 0), Accounts: box(0, 110), Store: box(0, 220), Client: box(300, -200) };
  assert.equal(UMLShared.packagesCollide(packages, boxes, STYLE), true);
  const after = moved(boxes, separate(packages, boxes));
  assert.equal(UMLShared.packagesCollide(packages, after, STYLE), false);
  assert.deepEqual(order(after, 'y'), order(boxes, 'y'));
});

test('a placement whose frames already keep apart needs no separating', () => {
  const boxes = { ...ROW_BOXES, API: box(200, 300), Worker: box(200, 420), Database: box(0, 560) };
  assert.equal(UMLShared.packagesCollide(ROWS, boxes, STYLE), false);
  assert.equal(separate(ROWS, boxes), null);
});

test('a package whose members another element lies between cannot be separated without reordering', () => {
  // Orders, Inventory, Quotes, Purchasing in one column: Sales and Stock
  // interleave, which no move that keeps the order undoes.
  const packages = [pkg('Sales', ['Orders', 'Quotes']), pkg('Stock', ['Inventory', 'Purchasing'])];
  const boxes = { Orders: box(0, 0), Inventory: box(0, 120), Quotes: box(0, 240), Purchasing: box(0, 360) };
  assert.equal(separate(packages, boxes), null);
});

test('a drawing without packages needs no separating', () => {
  assert.equal(separate([], ROW_BOXES), null);
});
