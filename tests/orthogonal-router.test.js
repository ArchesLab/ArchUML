'use strict';

// The shared orthogonal router (UMLShared.routeOrthogonalConnector), which
// every box-and-line renderer uses. These are characterization tests: the
// expected point lists are what the router produced before its obstacle
// tests were indexed, so they pin route choice exactly, including which of
// two equally short routes wins and how the route falls back when no grid
// path exists. A changed point list means changed drawings.

const assert = require('assert/strict');
const test = require('node:test');
const { loadBundle } = require('./support/load-bundle');
const associationCall = require('./fixtures/orthogonal-route-association.json');

const { UMLShared } = loadBundle();

function box(x, y, w, h, name) {
  return { x1: x, y1: y, x2: x + w, y2: y + h, name: name };
}

// Copied into this realm: the bundle runs in its own vm context, and
// deepEqual compares prototypes.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function routePoints(start, end, obstacles, options) {
  return plain(UMLShared.routeOrthogonalConnector(start, end, obstacles, options).points);
}

const WEST = { x: 0, y: 100, side: 'right' };
const EAST = { x: 300, y: 100, side: 'left' };

test('a route detours around a box on the side nearer its endpoints', () => {
  assert.deepEqual(routePoints(WEST, EAST, [box(120, 70, 60, 80)]), [
    { x: 0, y: 100 }, { x: 18, y: 100 }, { x: 18, y: 56 },
    { x: 282, y: 56 }, { x: 282, y: 100 }, { x: 300, y: 100 },
  ]);
});

test('of two equally short detours around a centred box, the route keeps taking the lower one', () => {
  assert.deepEqual(routePoints(WEST, EAST, [box(120, 60, 60, 80)]), [
    { x: 0, y: 100 }, { x: 18, y: 100 }, { x: 18, y: 154 },
    { x: 282, y: 154 }, { x: 282, y: 100 }, { x: 300, y: 100 },
  ]);
});

test('a route moves off the track of an earlier route it would run along', () => {
  const occupied = { h: [{ y: 100, x1: 20, x2: 280 }], v: [] };
  assert.deepEqual(routePoints(WEST, EAST, [], { occupied: occupied }), [
    { x: 0, y: 100 }, { x: 18, y: 100 }, { x: 18, y: 86 },
    { x: 282, y: 86 }, { x: 282, y: 100 }, { x: 300, y: 100 },
  ]);
});

test('a route goes around the end of an earlier route rather than crossing it', () => {
  const occupied = { h: [], v: [{ x: 150, y1: 0, y2: 200 }] };
  assert.deepEqual(routePoints(WEST, EAST, [], { occupied: occupied }), [
    { x: 0, y: 100 }, { x: 18, y: 100 }, { x: 18, y: 214 },
    { x: 282, y: 214 }, { x: 282, y: 100 }, { x: 300, y: 100 },
  ]);
});

test('a second route keeps clear of the reserved segments of the first', () => {
  const obstacles = [box(120, 60, 60, 80)];
  const occupied = { h: [], v: [] };
  const first = routePoints({ x: 0, y: 40, side: 'right' }, { x: 300, y: 160, side: 'left' }, obstacles, { occupied: occupied });
  UMLShared.reserveOrthogonalRoute(first, occupied);
  const second = routePoints({ x: 0, y: 60, side: 'right' }, { x: 300, y: 180, side: 'left' }, obstacles, { occupied: occupied });
  assert.deepEqual(first, [{ x: 0, y: 40 }, { x: 282, y: 40 }, { x: 282, y: 160 }, { x: 300, y: 160 }]);
  assert.deepEqual(second, [{ x: 0, y: 60 }, { x: 18, y: 60 }, { x: 18, y: 180 }, { x: 300, y: 180 }]);
});

test('a route between anchors on box borders leaves and enters through the anchor stubs', () => {
  const obstacles = [box(0, 0, 100, 60, 'A'), box(200, 120, 100, 60, 'B'), box(130, 20, 40, 120, 'C')];
  assert.deepEqual(routePoints({ x: 100, y: 30, side: 'right' }, { x: 250, y: 120, side: 'top' }, obstacles), [
    { x: 100, y: 30 }, { x: 118, y: 30 }, { x: 118, y: 6 }, { x: 250, y: 6 }, { x: 250, y: 120 },
  ]);
});

test('a skipped box does not deflect the route', () => {
  const obstacles = [box(0, 0, 100, 60, 'A'), box(200, 120, 100, 60, 'B'), box(130, 20, 40, 120, 'C')];
  assert.deepEqual(routePoints({ x: 100, y: 30, side: 'right' }, { x: 250, y: 120, side: 'top' }, obstacles, { skipNames: { C: true } }), [
    { x: 100, y: 30 }, { x: 250, y: 30 }, { x: 250, y: 120 },
  ]);
});

test('an endpoint stub inside a box leaves no grid path, so the route falls back to a single elbow', () => {
  assert.deepEqual(routePoints({ x: 0, y: 0, side: 'right' }, EAST, [box(250, 50, 100, 100)]), [
    { x: 0, y: 0 }, { x: 282, y: 0 }, { x: 282, y: 100 }, { x: 300, y: 100 },
  ]);
});

test('grid lanes less than a pixel apart still give the same route', () => {
  assert.deepEqual(routePoints(WEST, { x: 300, y: 160, side: 'left' }, [box(120, 60, 60, 80)], {
    extraXs: [18.7, 140.6],
    extraYs: [100.8],
  }), [
    { x: 0, y: 100 }, { x: 18, y: 100 }, { x: 18, y: 160 }, { x: 300, y: 160 },
  ]);
});

// An association in the class-diagram example of test-uml.html (corpus
// class-005), recorded from a compact render: 17 boxes, eight reserved
// segments of earlier routes, sliding anchors and extra lanes.
test('an association among seventeen boxes and earlier routes keeps its recorded route', () => {
  const args = associationCall.args;
  assert.deepEqual(routePoints(args[0], args[1], args[2], args[3]), associationCall.points);
});
