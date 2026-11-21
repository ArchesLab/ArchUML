'use strict';

const assert = require('assert/strict');
const test = require('node:test');
const { loadBundle } = require('./support/load-bundle');

const { UMLLayoutQuality } = loadBundle();

const PANE = { width: 600, height: 750 };
const FONT = 14; // line height for detachment: 14 + 6 = 20

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function pts(...pairs) {
  return pairs.map(([x, y]) => ({ x, y }));
}

// Builds a scene through the public builder API. `spec` lists plain records.
function scene({ nodes = [], routes = [], labels = [], size = [600, 300], font = FONT } = {}) {
  const s = UMLLayoutQuality.createScene();
  nodes.forEach((n) => s.addNode(n));
  routes.forEach((r) => s.addRoute(r));
  labels.forEach((l) => s.addLabel(l));
  s.setSize(size[0], size[1]);
  if (font != null) s.noteFont(font);
  return s;
}

function box(id, x, y, width = 100, height = 50, extra = {}) {
  return { id, x, y, width, height, kind: 'class', ...extra };
}

function violationsOf(s) {
  return plain(UMLLayoutQuality.evaluate(s, PANE).violations);
}

// ── scene builder ─────────────────────────────────────────────────────

test('a new scene has no font noted and nothing in it', () => {
  const s = UMLLayoutQuality.createScene();
  assert.equal(s.smallestFont, Infinity);
  assert.deepEqual(plain([s.nodes, s.routes, s.labels]), [[], [], []]);
});

test('the scene keeps the smallest font it was told about', () => {
  const s = UMLLayoutQuality.createScene();
  [14, 12, 16].forEach((size) => s.noteFont(size));
  assert.equal(s.smallestFont, 12);
});

test('setSize records the drawing size', () => {
  const s = UMLLayoutQuality.createScene();
  s.setSize(640, 480);
  assert.deepEqual([s.width, s.height], [640, 480]);
});

test('a copied scene records what the original records', () => {
  const s = scene({ nodes: [box('A', 0, 0)], routes: [{ id: 'r', points: pts([0, 0], [10, 0]), source: 'A', target: 'A' }],
    labels: [{ id: 'L', x: 1, y: 2, width: 3, height: 4, owner: 'A' }], size: [640, 480], font: 12 });
  s.setOrigin(5, 7);
  assert.deepEqual(plain(UMLLayoutQuality.copyScene(s)), plain(s));
});

test('what is added to a copied scene leaves the original unchanged', () => {
  const s = scene({ nodes: [box('A', 0, 0)], size: [640, 480], font: 14 });
  const before = plain(s);
  const copy = UMLLayoutQuality.copyScene(s);
  copy.addLabel({ id: 'callout:0', kind: 'callout', x: 0, y: 0, width: 10, height: 10 });
  copy.noteFont(9);
  copy.setSize(900, 700);
  copy.nodes[0].x = 50;
  assert.deepEqual(plain(s), before);
});

// ── node overlap ──────────────────────────────────────────────────────

test('boxes that just touch are valid', () => {
  assert.deepEqual(violationsOf(scene({ nodes: [box('A', 0, 0), box('B', 100, 0)] })), []);
});

test('boxes overlapping by one unit are a node-node violation', () => {
  assert.deepEqual(violationsOf(scene({ nodes: [box('A', 0, 0), box('B', 99, 0)] })),
    [{ kind: 'node-node', a: 'A', b: 'B' }]);
});

test('a container holding its child is valid', () => {
  const nodes = [
    box('P', 0, 0, 300, 200, { container: true }),
    box('C', 50, 50, 100, 50, { parent: 'P' }),
  ];
  assert.deepEqual(violationsOf(scene({ nodes })), []);
});

// ── label overlap ─────────────────────────────────────────────────────

const twoBoxesAndRoute = {
  nodes: [box('A', 0, 0), box('B', 200, 0)],
  routes: [{ id: 'r', points: pts([100, 25], [200, 25]), source: 'A', target: 'B' }],
};

test('an edge label lying on a box it does not belong to is a label-node violation', () => {
  const labels = [{ id: 'L', x: 190, y: 5, width: 40, height: 14, owner: 'r', kind: 'relation' }];
  assert.deepEqual(violationsOf(scene({ ...twoBoxesAndRoute, labels })),
    [{ kind: 'label-node', a: 'L', b: 'B' }]);
});

test('a label lying on its owner box is valid', () => {
  const labels = [{ id: 'L', x: 10, y: 10, width: 50, height: 14, owner: 'A', kind: 'stereotype' }];
  assert.deepEqual(violationsOf(scene({ ...twoBoxesAndRoute, labels })), []);
});

test('two overlapping labels are a label-label violation', () => {
  const labels = [
    { id: 'L1', x: 200, y: 200, width: 40, height: 14, owner: 'A', kind: 'note' },
    { id: 'L2', x: 220, y: 205, width: 40, height: 14, owner: 'A', kind: 'note' },
  ];
  assert.deepEqual(violationsOf(scene({ nodes: [box('A', 0, 0)], labels })),
    [{ kind: 'label-label', a: 'L1', b: 'L2' }]);
});

// ── route through boxes ───────────────────────────────────────────────

test('a route through a third box is a route-node violation', () => {
  const nodes = [box('A', 0, 0), box('C', 200, 0), box('B', 400, 0)];
  const routes = [{ id: 'r', points: pts([100, 25], [400, 25]), source: 'A', target: 'B' }];
  assert.deepEqual(violationsOf(scene({ nodes, routes })), [{ kind: 'route-node', a: 'r', b: 'C' }]);
});

test('a route running through its own end box is valid', () => {
  const nodes = [box('A', 0, 0), box('B', 400, 0)];
  const routes = [{ id: 'r', points: pts([50, 25], [400, 25]), source: 'A', target: 'B' }];
  assert.deepEqual(violationsOf(scene({ nodes, routes })), []);
});

test('a route leaving through the container of its end is valid', () => {
  const nodes = [
    box('P', -20, -20, 200, 100, { container: true }),
    box('A', 0, 0, 100, 50, { parent: 'P' }),
    box('B', 400, 0),
  ];
  const routes = [{ id: 'r', points: pts([100, 25], [400, 25]), source: 'A', target: 'B' }];
  assert.deepEqual(violationsOf(scene({ nodes, routes })), []);
});

// ── route through labels ──────────────────────────────────────────────

test('a route through a label is a route-label violation', () => {
  const labels = [{ id: 'L', x: 130, y: 18, width: 40, height: 14, owner: 'r', kind: 'relation' }];
  assert.deepEqual(violationsOf(scene({ ...twoBoxesAndRoute, labels })),
    [{ kind: 'route-label', a: 'r', b: 'L' }]);
});

test('a route through a label drawn on its line by design is valid', () => {
  const labels = [{ id: 'L', x: 130, y: 18, width: 40, height: 14, owner: 'r', kind: 'cardinality', onRoute: true }];
  assert.deepEqual(violationsOf(scene({ ...twoBoxesAndRoute, labels })), []);
});

// ── merged routes ─────────────────────────────────────────────────────

test('two routes running on top of each other for 10 units are a route-merge violation', () => {
  const routes = [
    { id: 'r1', points: pts([0, 0], [100, 0]), source: 'A', target: 'B' },
    { id: 'r2', points: pts([90, 0], [200, 0]), source: 'C', target: 'D' },
  ];
  assert.deepEqual(violationsOf(scene({ routes })), [{ kind: 'route-merge', a: 'r1', b: 'r2' }]);
});

test('routes of one bundle may share a segment', () => {
  const routes = [
    { id: 'r1', points: pts([0, 0], [100, 0]), source: 'A', target: 'B', bundle: 'fan' },
    { id: 'r2', points: pts([90, 0], [200, 0]), source: 'C', target: 'D', bundle: 'fan' },
  ];
  assert.deepEqual(violationsOf(scene({ routes })), []);
});

test('routes touching on top of each other for only 5 units are valid', () => {
  const routes = [
    { id: 'r1', points: pts([0, 0], [100, 0]), source: 'A', target: 'B' },
    { id: 'r2', points: pts([95, 0], [200, 0]), source: 'C', target: 'D' },
  ];
  assert.deepEqual(violationsOf(scene({ routes })), []);
});

// ── crossings, bends, detours ─────────────────────────────────────────

function crossingsOf(routes) {
  return UMLLayoutQuality.evaluate(scene({ routes }), PANE).crossings;
}

test('two routes crossing properly count one crossing', () => {
  assert.equal(crossingsOf([
    { id: 'r1', points: pts([0, 50], [100, 50]) },
    { id: 'r2', points: pts([50, 0], [50, 100]) },
  ]), 1);
});

test('a route ending on another route (T-junction) is not a crossing', () => {
  assert.equal(crossingsOf([
    { id: 'r1', points: pts([0, 50], [100, 50]) },
    { id: 'r2', points: pts([50, 0], [50, 50]) },
  ]), 0);
});

test('routes sharing an endpoint do not cross', () => {
  assert.equal(crossingsOf([
    { id: 'r1', points: pts([0, 0], [100, 0]) },
    { id: 'r2', points: pts([100, 0], [100, 100]) },
  ]), 0);
});

test('an L-shaped route has one bend', () => {
  const routes = [{ id: 'r', points: pts([0, 0], [100, 0], [100, 100]) }];
  assert.equal(UMLLayoutQuality.evaluate(scene({ routes }), PANE).bends, 1);
});

test('a straight route with a midpoint has no bend', () => {
  const routes = [{ id: 'r', points: pts([0, 0], [50, 0], [100, 0]) }];
  assert.equal(UMLLayoutQuality.evaluate(scene({ routes }), PANE).bends, 0);
});

test('a U route three times its direct distance has excess detour 1.5', () => {
  const routes = [{ id: 'r', points: pts([0, 0], [0, 100], [100, 100], [100, 0]) }];
  assert.equal(UMLLayoutQuality.evaluate(scene({ routes }), PANE).excessDetour, 1.5);
});

// ── labels stay with their edge ───────────────────────────────────────

test('an edge label more than one line height from its route is detached', () => {
  const routes = [{ id: 'r', points: pts([0, 0], [200, 0]) }];
  const labels = [{ id: 'L', x: 80, y: 40, width: 40, height: 14, owner: 'r', kind: 'relation' }];
  assert.deepEqual(violationsOf(scene({ routes, labels })), [{ kind: 'label-detached', a: 'L', b: 'r' }]);
});

test('an edge label nearer to another route than to its own is detached', () => {
  const routes = [
    { id: 'r1', points: pts([0, 0], [200, 0]) },
    { id: 'r2', points: pts([0, 30], [200, 30]) },
  ];
  const labels = [{ id: 'L', x: 80, y: 12, width: 40, height: 14, owner: 'r1', kind: 'relation' }];
  assert.deepEqual(violationsOf(scene({ routes, labels })), [{ kind: 'label-detached', a: 'L', b: 'r2' }]);
});

// ── fit and score ─────────────────────────────────────────────────────

test('fit is the smallest font scaled to the pane', () => {
  const s = scene({ size: [600, 300], font: 14 });
  assert.equal(UMLLayoutQuality.evaluate(s, { width: 600, height: 750 }).fit, 14);
});

test('fit follows the tighter pane side', () => {
  const s = scene({ size: [600, 300], font: 14 });
  assert.equal(UMLLayoutQuality.evaluate(s, { width: 300, height: 750 }).fit, 7);
});

test('emArea is the drawing area in squared smallest-font units', () => {
  const s = scene({ size: [600, 300], font: 15 });
  assert.equal(UMLLayoutQuality.evaluate(s, PANE).emArea, 800);
});

test('the weights are crossing 0.05, bend 0.015, detour 0.03', () => {
  assert.deepEqual(plain(UMLLayoutQuality.WEIGHTS), { crossing: 0.05, bend: 0.015, detour: 0.03 });
});

test('score is ln(fit) less the weighted crossings, bends and excess detour', () => {
  const routes = [
    { id: 'r1', points: pts([0, 50], [100, 50], [100, 150]) },
    { id: 'r2', points: pts([50, 0], [50, 100]) },
    { id: 'r3', points: pts([500, 0], [500, 100], [600, 100], [600, 0]) },
  ];
  const result = UMLLayoutQuality.evaluate(scene({ routes, size: [600, 300], font: 14 }), PANE);
  assert.deepEqual([result.crossings, result.bends, result.excessDetour], [1, 3, 1.5]);
  const expected = Math.log(14) - 0.05 * 1 - 0.015 * 3 - 0.03 * 1.5;
  assert.ok(Math.abs(result.score - expected) < 1e-12, `score ${result.score} vs ${expected}`);
});

test('a drawing with a violation is invalid and one without is valid', () => {
  const overlapping = scene({ nodes: [box('A', 0, 0), box('B', 99, 0)] });
  const apart = scene({ nodes: [box('A', 0, 0), box('B', 100, 0)] });
  assert.equal(UMLLayoutQuality.evaluate(overlapping, PANE).valid, false);
  assert.equal(UMLLayoutQuality.evaluate(apart, PANE).valid, true);
});

// ── purity and degenerate scenes ──────────────────────────────────────

test('evaluate leaves the scene unchanged', () => {
  const s = scene({ ...twoBoxesAndRoute,
    labels: [{ id: 'L', x: 190, y: 5, width: 40, height: 14, owner: 'r', kind: 'relation' }] });
  const before = plain(s);
  UMLLayoutQuality.evaluate(s, PANE);
  assert.deepEqual(plain(s), before);
});

test('a single box with no edges evaluates as a valid drawing', () => {
  const result = UMLLayoutQuality.evaluate(scene({ nodes: [box('A', 0, 0)], size: [100, 50] }), PANE);
  assert.deepEqual([result.valid, result.crossings, result.bends, result.excessDetour], [true, 0, 0, 0]);
  assert.equal(result.fit, 14 * 6);
});

// ── per-route measures ────────────────────────────────────────────────

test('measureRoutes gives each route its own crossings and bends', () => {
  const routes = [
    { id: 'flat', points: pts([0, 50], [100, 50]) },
    { id: 'ell', points: pts([50, 0], [50, 100], [150, 100]) },
    { id: 'apart', points: pts([300, 0], [300, 100]) },
  ];
  assert.deepEqual(plain(UMLLayoutQuality.measureRoutes(scene({ routes }))), {
    flat: { crossings: 1, bends: 0 },
    ell: { crossings: 1, bends: 1 },
    apart: { crossings: 0, bends: 0 },
  });
});
