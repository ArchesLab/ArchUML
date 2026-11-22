'use strict';

const assert = require('assert/strict');
const test = require('node:test');
const { loadBundle } = require('./support/load-bundle');

const { UMLCompactLayout, UMLLayoutQuality } = loadBundle();

const CLEAR = { lanePitch: 10, boxClearance: 20, stub: 15, labelPad: 4 };

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function body(id, x, y, width = 100, height = 50, extra = {}) {
  return { id, x, y, width, height, pinned: false, alignTop: null, ...extra };
}

// A scene holding the bodies as nodes plus whatever occupies the gaps.
function sceneOf(bodies, { routes = [], labels = [] } = {}) {
  const s = UMLLayoutQuality.createScene();
  bodies.forEach((b) => s.addNode({ id: b.id, x: b.x, y: b.y, width: b.width, height: b.height, kind: 'class' }));
  routes.forEach((r) => s.addRoute(r));
  labels.forEach((l) => s.addLabel(l));
  return s;
}

function squeeze(bodies, extras, clearances = CLEAR) {
  return plain(UMLCompactLayout.squeeze(bodies, sceneOf(bodies, extras), clearances));
}

// The bodies moved to the squeezed positions.
function moved(bodies, positions) {
  return bodies.map((b) => ({ ...b, x: positions[b.id].x, y: positions[b.id].y }));
}

function byId(bodies) {
  return Object.fromEntries(bodies.map((b) => [b.id, b]));
}

function gapX(a, b) {
  return b.x - (a.x + a.width);
}

function gapY(a, b) {
  return b.y - (a.y + a.height);
}

function centreX(b) {
  return b.x + b.width / 2;
}

function pts(...pairs) {
  return pairs.map(([x, y]) => ({ x, y }));
}

// ── what a gap keeps ──────────────────────────────────────────────────

test('an empty gap between two boxes closes to the box clearance', () => {
  const bodies = [body('A', 0, 0), body('B', 300, 0)];
  const after = byId(moved(bodies, squeeze(bodies)));
  assert.equal(gapX(after.A, after.B), CLEAR.boxClearance);
});

test('a label in the gap keeps its width plus padding, plus the box clearance on each side', () => {
  const bodies = [body('A', 0, 0), body('B', 300, 0)];
  const label = { id: 'L', x: 170, y: 10, width: 60, height: 20, owner: null };
  const after = byId(moved(bodies, squeeze(bodies, { labels: [label] })));
  assert.equal(gapX(after.A, after.B), 60 + 2 * CLEAR.labelPad + 2 * CLEAR.boxClearance);
});

test('a label wider than the gap keeps the whole gap', () => {
  const bodies = [body('A', 0, 0), body('B', 300, 0)];
  const label = { id: 'L', x: 90, y: 10, width: 220, height: 20, owner: null };
  const after = byId(moved(bodies, squeeze(bodies, { labels: [label] })));
  assert.equal(gapX(after.A, after.B), 200);
});

test('two vertical route tracks in the gap keep a lane each', () => {
  const bodies = [body('A', 0, 0), body('B', 300, 0)];
  const routes = [
    { id: 'r1', points: pts([150, -100], [150, 150]) },
    { id: 'r2', points: pts([200, -100], [200, 150]) }
  ];
  const after = byId(moved(bodies, squeeze(bodies, { routes })));
  assert.equal(gapX(after.A, after.B), 2 * CLEAR.lanePitch + 2 * CLEAR.boxClearance);
});

// A stub is the lead a route needs beside the box it leaves, so on that side
// it takes the place of the box clearance instead of adding to it.
test('a route between the facing sides keeps a stub at each side', () => {
  const bodies = [body('A', 0, 0), body('B', 300, 0)];
  const routes = [{ id: 'r', points: pts([100, 25], [300, 25]), source: 'A', target: 'B' }];
  const after = byId(moved(bodies, squeeze(bodies, { routes })));
  assert.equal(gapX(after.A, after.B), 2 * CLEAR.stub);
});

test('a stub at one side and a label in the middle keep the clearance only at the free side', () => {
  const bodies = [body('A', 0, 0), body('B', 300, 0)];
  const routes = [{ id: 'r', points: pts([100, 25], [200, 25], [200, -60]), source: 'A', target: 'Z' }];
  const label = { id: 'L', x: 230, y: 10, width: 30, height: 20, owner: null };
  const after = byId(moved(bodies, squeeze(bodies, { routes, labels: [label] })));
  // stub 100..115, track 195..205, label 226..264, then the clearance at B.
  assert.equal(gapX(after.A, after.B), CLEAR.stub + CLEAR.lanePitch + 30 + 2 * CLEAR.labelPad + CLEAR.boxClearance);
});

test('two diagonal boxes with nothing between them may slide until their starts meet', () => {
  const bodies = [body('A', 0, 0), body('B', 300, 100)];
  const after = byId(moved(bodies, squeeze(bodies)));
  assert.equal(after.B.x, after.A.x);
});

test('the label of the edge joining two boxes keeps its room between them, even outside the band where they face', () => {
  // A and B barely share a row; their edge leaves A's side below that band,
  // runs right and enters B from below, carrying its label on the way.
  const bodies = [body('A', 0, 59), body('B', 300, 0, 100, 60)];
  const routes = [{ id: 'r', points: pts([100, 90], [350, 90], [350, 60]), source: 'A', target: 'B' }];
  const label = { id: 'L', x: 180, y: 70, width: 60, height: 18, owner: 'r' };
  const after = byId(moved(bodies, squeeze(bodies, { routes, labels: [label] })));
  assert.ok(gapX(after.A, after.B) >= 60 + 2 * CLEAR.labelPad, `gap ${gapX(after.A, after.B)}`);
});

test('a track outside the band where two boxes face each other does not hold their gap open', () => {
  const bodies = [body('A', 0, 0), body('B', 300, 0)];
  const routes = [{ id: 'r', points: pts([150, 80], [150, 200]) }];
  const after = byId(moved(bodies, squeeze(bodies, { routes })));
  assert.equal(gapX(after.A, after.B), CLEAR.boxClearance);
});

// Text reads along x: the label of an edge joining two boxes side by side
// runs along that edge and keeps the end padding the renderer gives it
// from the edge's ends; any other label keeps the label padding.
test('the label of an edge joining two boxes side by side keeps the end padding of that edge', () => {
  const bodies = [body('A', 0, 0), body('B', 300, 0)];
  const routes = [{ id: 'r', points: pts([100, 25], [300, 25]), source: 'A', target: 'B' }];
  const label = { id: 'L', x: 170, y: 5, width: 60, height: 20, owner: 'r' };
  const clearances = { ...CLEAR, labelEndPad: 12 };
  const after = byId(moved(bodies, squeeze(bodies, { routes, labels: [label] }, clearances)));
  assert.equal(gapX(after.A, after.B), CLEAR.stub + 60 + 2 * 12 + CLEAR.stub);
});

test('a label of no edge joining the two boxes keeps the label padding in a horizontal gap', () => {
  const bodies = [body('A', 0, 0), body('B', 300, 0)];
  const label = { id: 'L', x: 170, y: 10, width: 60, height: 20, owner: null };
  const clearances = { ...CLEAR, labelEndPad: 12 };
  const after = byId(moved(bodies, squeeze(bodies, { labels: [label] }, clearances)));
  assert.equal(gapX(after.A, after.B), 60 + 2 * CLEAR.labelPad + 2 * CLEAR.boxClearance);
});

test('a label in a vertical gap keeps the label padding, not the end padding', () => {
  const bodies = [body('A', 0, 0), body('B', 0, 300)];
  const label = { id: 'L', x: 10, y: 150, width: 60, height: 20, owner: null };
  const clearances = { ...CLEAR, labelEndPad: 12 };
  const after = byId(moved(bodies, squeeze(bodies, { labels: [label] }, clearances)));
  assert.equal(gapY(after.A, after.B), 20 + 2 * CLEAR.labelPad + 2 * CLEAR.boxClearance);
});

// The renderer puts the end texts of an edge that crosses a gap straight
// (multiplicities, role names) beside that edge by their ends, beside the
// end markers: the gap keeps room for them one after another (each height
// with its padding on both sides), not for the places they happen to have
// now.
test('end labels beside an edge crossing the gap straight keep only their stacked size', () => {
  const bodies = [body('A', 0, 0), body('B', 0, 300)];
  const routes = [{ id: 'r', points: pts([50, 50], [50, 300]), source: 'A', target: 'B' }];
  const labels = [
    { id: 'm1', x: 56, y: 110, width: 30, height: 20, owner: 'r', atEnd: true },
    { id: 'm2', x: 56, y: 220, width: 20, height: 20, owner: 'r', atEnd: true }
  ];
  const after = byId(moved(bodies, squeeze(bodies, { routes, labels })));
  assert.equal(gapY(after.A, after.B), 20 + 20 + 4 * CLEAR.labelPad);
});

test('end labels beside a straight edge never leave less than its two stubs', () => {
  const bodies = [body('A', 0, 0), body('B', 0, 300)];
  const routes = [{ id: 'r', points: pts([50, 50], [50, 300]), source: 'A', target: 'B' }];
  const labels = [{ id: 'm', x: 56, y: 110, width: 30, height: 10, owner: 'r', atEnd: true }];
  const after = byId(moved(bodies, squeeze(bodies, { routes, labels })));
  // 10 + 2 × 4 = 18 < 2 × 15
  assert.equal(gapY(after.A, after.B), 2 * CLEAR.stub);
});

// A renderer that sets the name label of an edge crossing a gap straight
// beside the line, clear of the end markers and on the side free of its
// end labels (nameLabelsShareStubs), lets it share the gap with the stubs.
const SHARING = { ...CLEAR, nameLabelsShareStubs: true };

test('with nameLabelsShareStubs, the name label of a straight edge shares the gap with its stubs', () => {
  const bodies = [body('A', 0, 0), body('B', 0, 300)];
  const routes = [{ id: 'r', points: pts([50, 50], [50, 300]), source: 'A', target: 'B' }];
  const labels = [{ id: 'n', x: 56, y: 160, width: 30, height: 30, owner: 'r' }];
  const after = byId(moved(bodies, squeeze(bodies, { routes, labels }, SHARING)));
  assert.equal(gapY(after.A, after.B), 30 + 2 * CLEAR.labelPad);
});

test('with nameLabelsShareStubs, a short name label of a straight edge never leaves less than its two stubs', () => {
  const bodies = [body('A', 0, 0), body('B', 0, 300)];
  const routes = [{ id: 'r', points: pts([50, 50], [50, 300]), source: 'A', target: 'B' }];
  const labels = [{ id: 'n', x: 56, y: 160, width: 30, height: 10, owner: 'r' }];
  const after = byId(moved(bodies, squeeze(bodies, { routes, labels }, SHARING)));
  // 10 + 2 × 4 = 18 < 2 × 15
  assert.equal(gapY(after.A, after.B), 2 * CLEAR.stub);
});

test('with nameLabelsShareStubs, the name and end labels of a straight edge keep the larger of their sizes', () => {
  const bodies = [body('A', 0, 0), body('B', 0, 300)];
  const routes = [{ id: 'r', points: pts([50, 50], [50, 300]), source: 'A', target: 'B' }];
  const labels = [
    { id: 'n', x: 10, y: 160, width: 34, height: 20, owner: 'r' },
    { id: 'm1', x: 56, y: 60, width: 10, height: 20, owner: 'r', atEnd: true },
    { id: 'm2', x: 56, y: 270, width: 10, height: 20, owner: 'r', atEnd: true }
  ];
  const after = byId(moved(bodies, squeeze(bodies, { routes, labels }, SHARING)));
  assert.equal(gapY(after.A, after.B), 2 * (20 + 2 * CLEAR.labelPad));
});

test('without nameLabelsShareStubs, the name label of a straight edge keeps its place between the stubs', () => {
  const bodies = [body('A', 0, 0), body('B', 0, 300)];
  const routes = [{ id: 'r', points: pts([50, 50], [50, 300]), source: 'A', target: 'B' }];
  const labels = [{ id: 'n', x: 56, y: 160, width: 30, height: 20, owner: 'r' }];
  const after = byId(moved(bodies, squeeze(bodies, { routes, labels })));
  assert.equal(gapY(after.A, after.B), CLEAR.stub + 20 + 2 * CLEAR.labelPad + CLEAR.stub);
});

test('a label of another edge in the gap still keeps the place it has', () => {
  const bodies = [body('A', 0, 0), body('B', 0, 300)];
  const routes = [
    { id: 'r', points: pts([50, 50], [50, 300]), source: 'A', target: 'B' },
    { id: 'other', points: pts([80, 150], [400, 150]), source: 'A', target: 'Z' }
  ];
  const labels = [{ id: 'm', x: 56, y: 110, width: 30, height: 20, owner: 'other' }];
  const after = byId(moved(bodies, squeeze(bodies, { routes, labels })));
  // stub, the label where it is, the other edge's lane, stub.
  assert.equal(gapY(after.A, after.B), CLEAR.stub + 20 + 2 * CLEAR.labelPad + CLEAR.lanePitch + CLEAR.stub);
});

// Two boxes stacked in a column whose edges both leave sideways run side by
// side through the corridor beyond the column: what lies there between the
// two leads (the lower edge's label above its lead) keeps its room, though
// it lies outside the column. What lies beyond the shorter lead does not.
test('a label between two parallel leads keeps its room beyond the boxes they leave', () => {
  const bodies = [body('A', 0, 0, 100, 40), body('B', 0, 200, 100, 40), body('H', 400, 60, 100, 200)];
  const routes = [
    { id: 'ra', points: pts([100, 20], [400, 20]), source: 'A', target: 'H' },
    { id: 'rb', points: pts([100, 220], [300, 220], [300, 130], [400, 130]), source: 'B', target: 'H' }
  ];
  const labels = [{ id: 'L', x: 150, y: 170, width: 120, height: 18, owner: 'rb' }];
  const after = byId(moved(bodies, squeeze(bodies, { routes, labels })));
  // The label with its padding, and the clearance at both boxes; the lead
  // of B turning at x 300 into H's side lies beyond B's lead.
  assert.equal(gapY(after.A, after.B), 18 + 2 * CLEAR.labelPad + 2 * CLEAR.boxClearance);
});

// A renderer may list a route's points from its target to its source (the
// class renderer draws inheritance from the parent down). The lead of a box
// is the end of the route at that box, whichever way the points run.
test('a lead counts at the box it leaves, whichever end of the route its points start from', () => {
  const bodies = [body('A', 0, 0, 100, 40), body('B', 0, 200, 100, 40), body('H', 400, 60, 100, 200)];
  const routes = [
    { id: 'ra', points: pts([450, 60], [450, 20], [100, 20]), source: 'A', target: 'H' },
    { id: 'rb', points: pts([100, 220], [300, 220], [300, 130], [400, 130]), source: 'B', target: 'H' }
  ];
  const labels = [{ id: 'L', x: 150, y: 170, width: 120, height: 18, owner: 'rb' }];
  const after = byId(moved(bodies, squeeze(bodies, { routes, labels })));
  assert.equal(gapY(after.A, after.B), 18 + 2 * CLEAR.labelPad + 2 * CLEAR.boxClearance);
});

// Two boxes side by side whose edges both run straight down: a label beside
// the left one's line lies in the corridor between the two lines, below the
// boxes. A renderer whose labels need that corridor (labelsBesideLeads)
// keeps the label's room between the boxes; others close the gap.
function besideLeads() {
  const bodies = [body('A', 0, 0), body('B', 300, 0), body('A2', 0, 200), body('B2', 300, 200)];
  const routes = [
    { id: 'ra', points: pts([50, 50], [50, 200]), source: 'A', target: 'A2' },
    { id: 'rb', points: pts([350, 50], [350, 200]), source: 'B', target: 'B2' }
  ];
  const labels = [{ id: 'L', x: 58, y: 110, width: 200, height: 18, owner: 'ra' }];
  return { bodies, routes, labels };
}

test('with labelsBesideLeads, a label beside a line in the corridor below two boxes keeps its room between them', () => {
  const { bodies, routes, labels } = besideLeads();
  const after = byId(moved(bodies, squeeze(bodies, { routes, labels }, { ...CLEAR, labelsBesideLeads: true })));
  // From A's right side: the label's overhang past A, its padding, and the
  // clearance before B.
  assert.equal(gapX(after.A, after.B), 58 + 200 - 100 + CLEAR.labelPad + CLEAR.boxClearance);
});

test('without labelsBesideLeads, a label in the corridor below two boxes does not hold their gap open', () => {
  const { bodies, routes, labels } = besideLeads();
  const after = byId(moved(bodies, squeeze(bodies, { routes, labels })));
  assert.equal(gapX(after.A, after.B), CLEAR.boxClearance);
});

test('a vertical gap closes the same way as a horizontal one', () => {
  const bodies = [body('A', 0, 0), body('B', 0, 250)];
  const after = byId(moved(bodies, squeeze(bodies)));
  assert.equal(gapY(after.A, after.B), CLEAR.boxClearance);
});

// ── what moves together ───────────────────────────────────────────────

test('two boxes joined by a straight vertical edge keep equal x-centres', () => {
  // D and A sit tight on the top row; B is centred under A and has room to
  // move towards C. Without the shared offset A and B would drift apart.
  const bodies = [
    body('D', 0, 0),
    body('A', 120, 0, 60, 50),
    body('B', 100, 150),
    body('C', 400, 150)
  ];
  const routes = [{ id: 'AB', points: pts([150, 50], [150, 150]), source: 'A', target: 'B' }];
  const after = byId(moved(bodies, squeeze(bodies, { routes })));
  assert.equal(centreX(after.A), centreX(after.B));
});

test('two boxes joined by a straight horizontal edge keep equal y-centres', () => {
  // The vertical test above, with the axes swapped.
  const bodies = [
    body('D', 0, 0, 50, 100),
    body('A', 0, 120, 50, 60),
    body('B', 150, 100, 50, 100),
    body('C', 150, 400, 50, 100)
  ];
  const routes = [{ id: 'AB', points: pts([50, 150], [150, 150]), source: 'A', target: 'B' }];
  const after = byId(moved(bodies, squeeze(bodies, { routes })));
  assert.equal(after.A.y + after.A.height / 2, after.B.y + after.B.height / 2);
});

test('a slight overlap with an unrelated box in another row does not hold a gap open', () => {
  // A and B share the top row with nothing between them. D, in the row
  // below, overlaps B by ten units on x and is held where it is by a label.
  const bodies = [
    body('A', 0, 0), body('B', 300, 0),
    body('C', 0, 200), body('D', 390, 200)
  ];
  const label = { id: 'L', x: 110, y: 210, width: 270, height: 20, owner: null };
  const after = byId(moved(bodies, squeeze(bodies, { labels: [label] })));
  assert.equal(gapX(after.A, after.B), CLEAR.boxClearance);
});

test('room asked for after a body on one axis keeps that gap on that side and axis only', () => {
  const bodies = [body('L', -300, 0), body('A', 0, 0), body('B', 300, 0), body('C', 0, 250)];
  const room = { A: { after: { x: 120 } } };
  const after = byId(moved(bodies, plain(UMLCompactLayout.squeeze(bodies, sceneOf(bodies), CLEAR, { room }))));
  assert.equal(gapX(after.A, after.B), 120);
  assert.equal(gapX(after.L, after.A), CLEAR.boxClearance);
  assert.equal(gapY(after.A, after.C), CLEAR.boxClearance);
});

test('room asked for before a body keeps the gap to the box before it', () => {
  const bodies = [body('A', 0, 0), body('B', 300, 0)];
  const room = { B: { before: { x: 90 } } };
  const after = byId(moved(bodies, plain(UMLCompactLayout.squeeze(bodies, sceneOf(bodies), CLEAR, { room }))));
  assert.equal(gapX(after.A, after.B), 90);
});

test('room larger than the gap keeps the gap as it is', () => {
  const bodies = [body('A', 0, 0), body('B', 300, 0)];
  const positions = plain(UMLCompactLayout.squeeze(bodies, sceneOf(bodies), CLEAR, { room: { B: { before: { x: 500 } } } }));
  assert.equal(gapX(...moved(bodies, positions)), 200);
});

test('a pinned box keeps its position and its neighbour closes up to it', () => {
  const bodies = [body('A', 0, 0, 100, 50, { pinned: true }), body('B', 300, 0)];
  const positions = squeeze(bodies);
  assert.deepEqual(positions.A, { x: 0, y: 0 });
  assert.equal(positions.B.x, 100 + CLEAR.boxClearance);
});

test('a box before a pinned box moves forward to it', () => {
  const bodies = [body('A', 0, 0), body('B', 300, 0, 100, 50, { pinned: true })];
  const positions = squeeze(bodies);
  assert.deepEqual(positions.B, { x: 300, y: 0 });
  assert.equal(positions.A.x, 300 - CLEAR.boxClearance - 100);
});

test('bodies sharing alignTop keep a common top edge', () => {
  // A label holds C1 away from the parent; C2 alone would rise further.
  const bodies = [
    body('P', 0, 0, 400, 50),
    body('C1', 0, 200, 100, 50, { alignTop: 'P' }),
    body('C2', 300, 200, 100, 50, { alignTop: 'P' })
  ];
  const label = { id: 'L', x: 20, y: 100, width: 40, height: 40, owner: null };
  const after = byId(moved(bodies, squeeze(bodies, { labels: [label] })));
  assert.equal(after.C1.y, after.C2.y);
});

test('bodies sharing alignLeft keep a common left edge', () => {
  // The mirror of alignTop: a label holds C1 away from P; C2 alone would
  // move further left.
  const bodies = [
    body('P', 0, 0, 50, 400),
    body('C1', 200, 0, 50, 100, { alignLeft: 'P' }),
    body('C2', 200, 300, 50, 100, { alignLeft: 'P' })
  ];
  const label = { id: 'L', x: 100, y: 20, width: 40, height: 40, owner: null };
  const after = byId(moved(bodies, squeeze(bodies, { labels: [label] })));
  assert.equal(after.C1.x, after.C2.x);
});

test('alignLeft ties only the horizontal axis and alignTop only the vertical one', () => {
  // Without a shared key on an axis, C2 closes up further than C1 on it.
  const label = { id: 'L', x: 100, y: 20, width: 40, height: 40, owner: null };
  const left = [
    body('P', 0, 0, 50, 400),
    body('C1', 200, 0, 50, 100, { alignTop: 'P' }),
    body('C2', 200, 300, 50, 100, { alignTop: 'P' })
  ];
  const after = byId(moved(left, squeeze(left, { labels: [label] })));
  assert.notEqual(after.C1.x, after.C2.x, 'alignTop does not tie left edges');
});

// ── invariants ────────────────────────────────────────────────────────

test('squeezing its own output again changes nothing', () => {
  const bodies = [body('A', 0, 0), body('B', 250, 0), body('C', 420, 0), body('D', 0, 300)];
  const once = moved(bodies, squeeze(bodies));
  const twice = moved(once, squeeze(once));
  assert.deepEqual(twice, once);
});

test('positions are whole units when the scene has fractional geometry', () => {
  const bodies = [body('A', 0, 0), body('B', 300, 0)];
  const label = { id: 'L', x: 170.25, y: 10, width: 60.4, height: 20, owner: null };
  const positions = squeeze(bodies, { labels: [label] });
  Object.values(positions).forEach((p) => {
    assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y), JSON.stringify(p));
  });
});

test('squeeze leaves its inputs unchanged', () => {
  const bodies = [body('A', 0, 0), body('B', 300, 0)];
  const scene = sceneOf(bodies, { labels: [{ id: 'L', x: 170, y: 10, width: 60, height: 20, owner: null }] });
  const before = plain({ bodies, scene });
  UMLCompactLayout.squeeze(bodies, scene, CLEAR);
  assert.deepEqual(plain({ bodies, scene }), before);
});

test('zero bodies give no positions', () => {
  assert.deepEqual(squeeze([]), {});
});

// ── seeded properties over generated layouts ──────────────────────────

// Deterministic generator (LCG) so every run sees the same layouts.
function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// Boxes on a jittered grid, at least the box clearance apart at the start.
function generatedLayout(seed) {
  const next = generator(seed);
  const bodies = [];
  const cols = 2 + Math.floor(next() * 3);
  const rows = 1 + Math.floor(next() * 3);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (next() < 0.25) continue;
      const width = 60 + Math.floor(next() * 80);
      const height = 30 + Math.floor(next() * 40);
      const x = c * 260 + Math.floor(next() * (260 - width - CLEAR.boxClearance));
      const y = r * 200 + Math.floor(next() * (200 - height - CLEAR.boxClearance));
      bodies.push(body(`b${r}_${c}`, x, y, width, height));
    }
  }
  return bodies;
}

const SEEDS = Array.from({ length: 25 }, (_, i) => i + 1);

const AXES = [
  { start: (b) => b.x, end: (b) => b.x + b.width },
  { start: (b) => b.y, end: (b) => b.y + b.height }
];

function eachPair(bodies, visit) {
  for (let i = 0; i < bodies.length; i++) {
    for (let j = 0; j < bodies.length; j++) {
      if (i !== j) visit(bodies[i], bodies[j]);
    }
  }
}

// Two bodies apart on an axis keep their order on it. Two bodies whose
// extents overlap on an axis have no order there (the other axis keeps them
// apart), so either may end up starting first.
test('squeeze never reverses the order of two bodies that are apart on an axis', () => {
  SEEDS.forEach((seed) => {
    const before = generatedLayout(seed);
    const after = byId(moved(before, squeeze(before)));
    eachPair(before, (a, b) => {
      AXES.forEach(({ start, end }) => {
        if (end(a) <= start(b)) {
          assert.ok(start(after[a.id]) <= start(after[b.id]), `seed ${seed}: ${a.id} passed ${b.id}`);
        }
      });
    });
  });
});

test('squeeze never widens the gap between two bodies on an axis', () => {
  SEEDS.forEach((seed) => {
    const before = generatedLayout(seed);
    const after = byId(moved(before, squeeze(before)));
    eachPair(before, (a, b) => {
      AXES.forEach(({ start, end }) => {
        if (end(a) <= start(b)) {
          const gapBefore = start(b) - end(a);
          const gapAfter = start(after[b.id]) - end(after[a.id]);
          assert.ok(gapAfter <= gapBefore, `seed ${seed}: gap ${a.id}→${b.id} grew ${gapBefore}→${gapAfter}`);
        }
      });
    });
  });
});

test('squeeze never makes two boxes overlap or come closer than the box clearance', () => {
  SEEDS.forEach((seed) => {
    const after = moved(generatedLayout(seed), squeeze(generatedLayout(seed)));
    eachPair(after, (a, b) => {
      const apartX = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
      const apartY = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height));
      assert.ok(Math.max(apartX, apartY) >= CLEAR.boxClearance, `seed ${seed}: ${a.id} and ${b.id} too close`);
    });
  });
});

test('squeeze gives the same positions on every run', () => {
  SEEDS.forEach((seed) => {
    assert.deepEqual(squeeze(generatedLayout(seed)), squeeze(generatedLayout(seed)));
  });
});

// A package frame drawn around A and B reaches over the whole stretch its
// members span. C is no member and shares a column with neither, but lies
// below the frame, so the squeeze must keep it below the frame's bottom.
test('a box outside a package stays outside the frame its members span, not just clear of the members it faces', () => {
  const a = body('A', 0, 0, 100, 50, { pinned: true }), b = body('B', 300, 120, 100, 50, { pinned: true });
  const c = body('C', 150, 400);
  const s = UMLLayoutQuality.createScene();
  s.addNode({ id: 'package:P', x: -10, y: -40, width: 420, height: 220, kind: 'package', container: true, crossable: true });
  [a, b].forEach((n) => s.addNode({ id: n.id, x: n.x, y: n.y, width: n.width, height: n.height, kind: 'class', parent: 'package:P' }));
  s.addNode({ id: c.id, x: c.x, y: c.y, width: c.width, height: c.height, kind: 'class' });
  const separation = (aId, bId) => (aId === 'C') === (bId === 'C') ? 0 : 10;
  const at = plain(UMLCompactLayout.squeeze([a, b, c], s, CLEAR, { separation }));
  const frameBottom = Math.max(at.A.y + a.height, at.B.y + b.height) + 10;
  assert.ok(at.C.y >= frameBottom + CLEAR.boxClearance,
    `C at y ${at.C.y} lies inside the frame, whose bottom is at ${frameBottom}`);
});
