'use strict';

const assert = require('assert/strict');
const test = require('node:test');
const { loadBundle } = require('./support/load-bundle');

const { UMLCompactLayout, UMLLayoutQuality } = loadBundle();

const CLEAR = { lanePitch: 10, boxClearance: 20, stub: 15, labelPad: 4 };
const PANE = { width: 600, height: 750 };
const FONT = 14;
const MARGIN = 10;
const BOX = { width: 100, height: 50 };

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function pts(...pairs) {
  return pairs.map(([x, y]) => ({ x, y }));
}

function candidate(tag, positions) {
  return { tag, positions };
}

/**
 * A renderer stand-in. A placement is {tag, positions}; every body is a
 * 100×50 box unless `sizes` gives its own; `decorate(rects)` adds the routes
 * and labels the "renderer" would draw for those positions. `log` records
 * every realized placement.
 */
function fakeAdapter({ ids = ['A', 'B'], candidates, size = { boxes: 2, edges: 0 }, decorate = () => ({}), estimate, sizes = {} }) {
  const log = [];
  const boxOf = (id) => sizes[id] || BOX;
  const adapter = {
    clearances: CLEAR,
    size,
    candidates: () => candidates,
    bodies: (placement) => ids.map((id) => ({
      id, ...placement.positions[id], ...boxOf(id), pinned: false, alignTop: null
    })),
    withPositions: (placement, positions) => ({ ...placement, positions: { ...placement.positions, ...positions } }),
    realize(placement) {
      log.push(placement);
      const rects = Object.fromEntries(ids.map((id) => [id, { ...placement.positions[id], ...boxOf(id) }]));
      const scene = UMLLayoutQuality.createScene();
      ids.forEach((id) => scene.addNode({ id, ...rects[id], kind: 'class' }));
      const extras = decorate(rects);
      (extras.routes || []).forEach((r) => scene.addRoute(r));
      (extras.labels || []).forEach((l) => scene.addLabel(l));
      const xs = ids.flatMap((id) => [rects[id].x, rects[id].x + rects[id].width]);
      const ys = ids.flatMap((id) => [rects[id].y, rects[id].y + rects[id].height]);
      if (ids.length) {
        scene.setSize(Math.max(...xs) - Math.min(...xs) + 2 * MARGIN, Math.max(...ys) - Math.min(...ys) + 2 * MARGIN);
      }
      scene.noteFont(FONT);
      return { svg: `<svg data-candidate="${placement.tag}" data-positions='${JSON.stringify(placement.positions)}'/>`, scene };
    }
  };
  if (estimate) adapter.estimate = estimate;
  return { adapter, log };
}

function nodeOf(result, id) {
  return result.scene.nodes.find((n) => n.id === id);
}

function candidateOf(result) {
  return /data-candidate="([^"]*)"/.exec(result.svg)[1];
}

// Two routes that cross each other, away from every box.
const CROSSING_PAIR = [
  { id: 'c1', points: pts([0, 300], [100, 300]) },
  { id: 'c2', points: pts([50, 250], [50, 350]) }
];

// ── budget ────────────────────────────────────────────────────────────

[[6, 6, 8], [7, 6, 5], [15, 15, 5], [16, 15, 3]].forEach(([boxes, edges, passes]) => {
  test(`${boxes} boxes and ${edges} edges get ${passes} routing passes`, () => {
    assert.equal(UMLCompactLayout.passBudget(boxes, edges), passes);
  });
});

test('passes count every call to realize and never exceed the budget', () => {
  const many = Array.from({ length: 6 }, (_, i) => candidate(`c${i}`, { A: { x: 0, y: 0 }, B: { x: 300 + i, y: 0 } }));
  const { adapter, log } = fakeAdapter({ candidates: many, size: { boxes: 20, edges: 11 } });
  const result = UMLCompactLayout.optimize(adapter, PANE);
  assert.equal(result.passes, log.length);
  assert.ok(result.passes <= UMLCompactLayout.passBudget(20, 11), `${result.passes} passes`);
});

// An adapter can ask how many widenings its reference would get: every
// other candidate keeps a pass to be drawn and one to be squeezed, and the
// reference itself spent one (8 passes for 2 boxes).
[[1, 3], [3, 3], [4, 1], [5, 0], [9, 0]].forEach(([count, repairs]) => {
  test(`with ${count} candidates and 8 passes an overlapping reference gets ${repairs} widenings`, () => {
    assert.equal(UMLCompactLayout.referenceRepairs({ boxes: 2, edges: 0 }, count), repairs);
  });
});

[[4, true], [5, false]].forEach(([count, widened]) => {
  test(`with ${count} candidates and 8 passes the overlapping reference is ${widened ? '' : 'not '}widened before the others are drawn`, () => {
    const overlapping = candidate('ref', { A: { x: 0, y: 0 }, B: { x: 50, y: 0 } });
    const others = Array.from({ length: count - 1 }, (_, i) => candidate(`c${i}`, { A: { x: 0, y: 0 }, B: { x: 300 + 10 * i, y: 0 } }));
    const { adapter, log } = fakeAdapter({ candidates: [overlapping, ...others] });
    UMLCompactLayout.optimize(adapter, PANE);
    assert.equal(log[0].tag, 'ref');
    assert.equal(log[1].tag === 'ref', widened, `second pass drew ${log[1].tag}`);
  });
});

// ── squeeze, verify, select ───────────────────────────────────────────

test('the squeezed drawing is chosen when it is valid', () => {
  const { adapter } = fakeAdapter({ candidates: [candidate('ref', { A: { x: 0, y: 0 }, B: { x: 300, y: 0 } })] });
  const result = UMLCompactLayout.optimize(adapter, PANE);
  const a = nodeOf(result, 'A'), b = nodeOf(result, 'B');
  assert.equal(b.x - (a.x + a.width), CLEAR.boxClearance);
  assert.equal(result.issues, 0);
});

test('a squeeze that adds a crossing is rejected and the reference is kept', () => {
  const { adapter } = fakeAdapter({
    candidates: [candidate('ref', { A: { x: 0, y: 0 }, B: { x: 300, y: 0 } })],
    decorate: (r) => ({ routes: r.B.x - (r.A.x + r.A.width) < 150 ? CROSSING_PAIR : [] })
  });
  const result = UMLCompactLayout.optimize(adapter, PANE);
  assert.deepEqual([nodeOf(result, 'A').x, nodeOf(result, 'B').x], [0, 300]);
  assert.equal(result.metrics.crossings, 0);
});

test('a rejected squeeze is retried with wider gaps at most twice', () => {
  const { adapter } = fakeAdapter({
    candidates: [candidate('ref', { A: { x: 0, y: 0 }, B: { x: 300, y: 0 } })],
    decorate: (r) => ({ routes: r.B.x - (r.A.x + r.A.width) < 150 ? CROSSING_PAIR : [] })
  });
  const result = UMLCompactLayout.optimize(adapter, PANE);
  const reference = 1, squeeze = 1, retries = 2;
  assert.equal(result.passes, reference + squeeze + retries);
});

test('a retried squeeze widens the gap by one lane pitch per retry', () => {
  // The crossing appears only while the gap is narrower than one lane more
  // than the box clearance; the first retry clears it.
  const { adapter } = fakeAdapter({
    candidates: [candidate('ref', { A: { x: 0, y: 0 }, B: { x: 300, y: 0 } })],
    decorate: (r) => ({ routes: r.B.x - (r.A.x + r.A.width) < CLEAR.boxClearance + CLEAR.lanePitch ? CROSSING_PAIR : [] })
  });
  const result = UMLCompactLayout.optimize(adapter, PANE);
  const a = nodeOf(result, 'A'), b = nodeOf(result, 'B');
  assert.equal(b.x - (a.x + a.width), CLEAR.boxClearance + CLEAR.lanePitch);
});

test('a squeeze rejected for a detached label is retried with room for that label at its edge', () => {
  // The "renderer" routes A to B over the top of both boxes and puts the
  // label above that route, outside the gap the squeeze measures. It keeps
  // the label with its line only while the gap holds the label's width plus
  // padding and clearance; narrower, the label is drawn far below. One lane
  // pitch per retry cannot make that room.
  const LABEL = { width: 100, height: 20 };
  const needed = LABEL.width + 2 * CLEAR.labelPad + 2 * CLEAR.boxClearance;
  const { adapter } = fakeAdapter({
    candidates: [candidate('ref', { A: { x: 0, y: 0 }, B: { x: 300, y: 0 } })],
    decorate: (r) => {
      const gap = r.B.x - (r.A.x + r.A.width);
      const left = r.A.x + r.A.width + gap / 2 - LABEL.width / 2;
      return {
        routes: [{ id: 'r', points: pts([r.A.x + 50, 0], [r.A.x + 50, -30], [r.B.x + 50, -30], [r.B.x + 50, 0]), source: 'A', target: 'B' }],
        labels: [{ id: 'L', owner: 'r', x: left, y: gap >= needed ? -55 : 200, ...LABEL }]
      };
    }
  });
  const result = UMLCompactLayout.optimize(adapter, PANE);
  const a = nodeOf(result, 'A'), b = nodeOf(result, 'B');
  assert.equal(result.metrics.valid, true);
  assert.ok(b.x - (a.x + a.width) < 200, `gap ${b.x - (a.x + a.width)}: the squeeze was not kept`);
});

test('every candidate is realized and squeezed once before a rejected squeeze is retried', () => {
  // Any squeeze of the row adds a crossing; the column squeezes cleanly.
  const { adapter, log } = fakeAdapter({
    candidates: [
      candidate('row', { A: { x: 0, y: 0 }, B: { x: 300, y: 0 } }),
      candidate('column', { A: { x: 0, y: 0 }, B: { x: 0, y: 300 } })
    ],
    decorate: (r) => ({ routes: r.B.y === r.A.y && r.B.x < 300 ? CROSSING_PAIR : [] })
  });
  UMLCompactLayout.optimize(adapter, PANE);
  assert.deepEqual(log.slice(0, 4).map((p) => p.tag), ['row', 'row', 'column', 'column']);
});

test('a candidate estimated to fit the pane better is squeezed before the reference', () => {
  const { adapter, log } = fakeAdapter({
    candidates: [
      candidate('row', { A: { x: 0, y: 0 }, B: { x: 300, y: 0 } }),
      candidate('column', { A: { x: 0, y: 0 }, B: { x: 0, y: 300 } })
    ],
    size: { boxes: 20, edges: 11 },
    estimate: (placement) => (placement.tag === 'row' ? { width: 400, height: 50 } : { width: 100, height: 350 })
  });
  UMLCompactLayout.optimize(adapter, PANE);
  assert.deepEqual(log.map((p) => p.tag), ['row', 'column', 'column']);
});

test('an overlapping reference is repaired by widening and ends valid', () => {
  const { adapter } = fakeAdapter({ candidates: [candidate('ref', { A: { x: 0, y: 0 }, B: { x: 90, y: 0 } })] });
  const result = UMLCompactLayout.optimize(adapter, PANE);
  assert.equal(result.metrics.valid, true);
  assert.equal(result.issues, 0);
});

test('when no drawing is valid, the one with fewest violations is returned with issues set', () => {
  // Two labels of A lie on B in the reference, one once B has moved right.
  const { adapter } = fakeAdapter({
    candidates: [candidate('ref', { A: { x: 0, y: 0 }, B: { x: 300, y: 0 } })],
    decorate: (r) => ({
      labels: (r.B.x > 300 ? ['L1'] : ['L1', 'L2']).map((id, i) => ({
        id, x: r.B.x + 10 + i * 40, y: r.B.y + 10, width: 30, height: 20, owner: 'A'
      }))
    })
  });
  const result = UMLCompactLayout.optimize(adapter, PANE);
  assert.equal(result.issues, 1);
  assert.equal(result.metrics.valid, false);
});

test('a later candidate with a better fit for the pane wins', () => {
  const { adapter } = fakeAdapter({
    candidates: [
      candidate('row', { A: { x: 0, y: 0 }, B: { x: 120, y: 0 } }),
      candidate('column', { A: { x: 0, y: 0 }, B: { x: 0, y: 70 } })
    ]
  });
  assert.equal(candidateOf(UMLCompactLayout.optimize(adapter, PANE)), 'column');
});

test('a candidate that adds a crossing to the reference is not chosen, even with a better fit', () => {
  const { adapter } = fakeAdapter({
    candidates: [
      candidate('row', { A: { x: 0, y: 0 }, B: { x: 120, y: 0 } }),
      candidate('column', { A: { x: 0, y: 0 }, B: { x: 0, y: 70 } })
    ],
    decorate: (r) => ({ routes: r.B.y > r.A.y ? CROSSING_PAIR : [] })
  });
  assert.equal(candidateOf(UMLCompactLayout.optimize(adapter, PANE)), 'row');
});

test('later candidates are realized in the order of their estimated fit', () => {
  const { adapter, log } = fakeAdapter({
    candidates: [
      candidate('ref', { A: { x: 0, y: 0 }, B: { x: 120, y: 0 } }),
      candidate('wide', { A: { x: 0, y: 0 }, B: { x: 120, y: 0 } }),
      candidate('tall', { A: { x: 0, y: 0 }, B: { x: 0, y: 70 } })
    ],
    estimate: (placement) => (placement.tag === 'wide' ? { width: 1000, height: 100 } : { width: 300, height: 400 })
  });
  UMLCompactLayout.optimize(adapter, PANE);
  assert.deepEqual(log.map((p) => p.tag), ['ref', 'tall', 'wide']);
});

// ── what the drawing without compact allows ─────────────────────────

test('a drawing with more crossings than the adapter\'s limits loses to one within them, even with a better fit', () => {
  const { adapter } = fakeAdapter({
    candidates: [
      candidate('row', { A: { x: 0, y: 0 }, B: { x: 140, y: 0 } }),
      candidate('column', { A: { x: 0, y: 0 }, B: { x: 0, y: 400 } })
    ],
    // The row always crosses; the column crosses once squeezed.
    decorate: (r) => ({ routes: r.B.y === r.A.y || r.B.y < 400 ? CROSSING_PAIR : [] })
  });
  adapter.limits = { crossings: 0, bends: 0 };
  assert.equal(candidateOf(UMLCompactLayout.optimize(adapter, PANE)), 'column');
});

test('without a drawing within the limits, the best drawing no worse than the reference is chosen', () => {
  const { adapter } = fakeAdapter({
    candidates: [candidate('row', { A: { x: 0, y: 0 }, B: { x: 300, y: 0 } })],
    decorate: () => ({ routes: CROSSING_PAIR })
  });
  adapter.limits = { crossings: 0, bends: 0 };
  const result = UMLCompactLayout.optimize(adapter, PANE);
  const a = nodeOf(result, 'A'), b = nodeOf(result, 'B');
  assert.equal(b.x - (a.x + a.width), CLEAR.boxClearance, 'the squeeze is still kept');
});

test('when the reference stays invalid, a drawing with more crossings than the reference is not chosen', () => {
  // The reference keeps a label of A on B whatever the repair does; the
  // column adds a crossing; the far row has neither and fits worse.
  const { adapter } = fakeAdapter({
    candidates: [
      candidate('ref', { A: { x: 0, y: 0 }, B: { x: 300, y: 0 } }),
      candidate('column', { A: { x: 0, y: 0 }, B: { x: 0, y: 70 } }),
      candidate('far', { A: { x: 0, y: 0 }, B: { x: 500, y: 0 } })
    ],
    decorate: (r) => ({
      routes: r.B.x === r.A.x ? CROSSING_PAIR : [],
      labels: r.B.x >= 300 && r.B.x < 500 ? [{ id: 'L', x: r.B.x + 10, y: 10, width: 30, height: 20, owner: 'A' }] : []
    })
  });
  const result = UMLCompactLayout.optimize(adapter, PANE);
  assert.equal(result.metrics.crossings, 0);
  assert.equal(result.metrics.valid, true);
});

test('repairing an invalid reference leaves passes to draw and squeeze every other candidate', () => {
  const { adapter, log } = fakeAdapter({
    candidates: [
      candidate('ref', { A: { x: 0, y: 0 }, B: { x: 300, y: 0 } }),
      candidate('column', { A: { x: 0, y: 0 }, B: { x: 0, y: 300 } }),
      candidate('far', { A: { x: 0, y: 0 }, B: { x: 600, y: 0 } })
    ],
    size: { boxes: 15, edges: 15 },
    decorate: (r) => ({
      labels: r.B.y === r.A.y && r.B.x < 600 ? [{ id: 'L', x: r.B.x + 10, y: 10, width: 30, height: 20, owner: 'A' }] : []
    })
  });
  UMLCompactLayout.optimize(adapter, PANE);
  const tags = new Set(log.map((p) => p.tag));
  assert.ok(tags.has('column') && tags.has('far'), `realized: ${log.map((p) => p.tag).join(', ')}`);
});

test('a candidate within the adapter\'s limits wins on fit, though it bends more than the reference', () => {
  // The drawing without compact has two bends; the row has none, the
  // column two and a far better fit.
  const { adapter } = fakeAdapter({
    candidates: [
      candidate('row', { A: { x: 0, y: 0 }, B: { x: 300, y: 0 } }),
      candidate('column', { A: { x: 0, y: 0 }, B: { x: 0, y: 70 } })
    ],
    decorate: (r) => ({
      routes: [r.B.y === r.A.y
        ? { id: 'AB', points: pts([r.A.x + 100, 25], [r.B.x, 25]), source: 'A', target: 'B' }
        : { id: 'AB', points: pts([100, 25], [130, 25], [130, r.B.y + 25], [100, r.B.y + 25]), source: 'A', target: 'B' }]
    })
  });
  adapter.limits = { crossings: 0, bends: 2 };
  assert.equal(candidateOf(UMLCompactLayout.optimize(adapter, PANE)), 'column');
});

// ── repair ────────────────────────────────────────────────────────────

test('repairing an overlap never bends an edge that was straight', () => {
  // A (narrow) sits straight above B; the label of their edge lies on C
  // while C is close to B. Opening the gap before C must not push A off
  // B's centre line.
  const { adapter } = fakeAdapter({
    ids: ['A', 'B', 'C'],
    sizes: { A: { width: 60, height: 50 } },
    size: { boxes: 3, edges: 1 },
    candidates: [candidate('ref', { A: { x: 0, y: 0 }, B: { x: -20, y: 150 }, C: { x: 100, y: 150 } })],
    decorate: (r) => {
      const ax = r.A.x + r.A.width / 2, bx = r.B.x + r.B.width / 2;
      const top = r.A.y + r.A.height, bottom = r.B.y, mid = (top + bottom) / 2;
      const points = ax === bx ? pts([ax, top], [bx, bottom]) : pts([ax, top], [ax, mid], [bx, mid], [bx, bottom]);
      const crowded = r.C.x - (r.B.x + r.B.width) < 60;
      return {
        routes: [{ id: 'AB', points, source: 'A', target: 'B' }],
        labels: crowded ? [{ id: 'L', x: r.C.x + 10, y: r.C.y + 10, width: 30, height: 20, owner: 'AB' }] : []
      };
    }
  });
  const result = UMLCompactLayout.optimize(adapter, PANE);
  assert.equal(result.metrics.valid, true);
  assert.equal(result.metrics.bends, 0);
});

test('a note whose leader merges with an edge gets the room of the note when repaired', () => {
  // N, a 150-high note of A, fits beside A only once B is 160 below A;
  // until then its leader runs down A's edge to B. Widening by a lane at a
  // time would need more repairs than the budget allows.
  const NOTE = { width: 80, height: 150 };
  const { adapter } = fakeAdapter({
    candidates: [candidate('ref', { A: { x: 0, y: 0 }, B: { x: 0, y: 100 } })],
    decorate: (r) => {
      const gap = r.B.y - (r.A.y + 50);
      const fits = gap >= 160;
      return {
        routes: [
          { id: 'AB', points: pts([50, r.A.y + 50], [50, r.B.y]), source: 'A', target: 'B' },
          { id: 'leader:N', points: fits ? pts([120, r.A.y + 25], [100, r.A.y + 25]) : pts([50, r.A.y + 60], [50, r.B.y - 10]), source: 'N', target: 'A' }
        ],
        labels: [{ id: 'N', x: 120, y: fits ? r.A.y : r.B.y + 60, ...NOTE, owner: 'A', kind: 'note' }]
      };
    }
  });
  const result = UMLCompactLayout.optimize(adapter, PANE);
  assert.equal(result.issues, 0, JSON.stringify(result.metrics.violations));
});

// ── annotations (teaching callouts) ───────────────────────────────────

/**
 * Gives the adapter an `annotate` that marks the markup and lets
 * `annotation(drawing)` say what it adds to a copy of the drawing's scene:
 * {labels, grow: [dw, dh]}. `calls` counts the annotated drawings.
 */
function annotating(adapter, annotation = () => ({})) {
  const calls = [];
  adapter.annotate = (drawing) => {
    calls.push(drawing);
    const scene = UMLLayoutQuality.copyScene(drawing.scene);
    const { labels = [], grow = [0, 0] } = annotation(drawing);
    labels.forEach((l) => scene.addLabel(l));
    scene.setSize(scene.width + grow[0], scene.height + grow[1]);
    return { svg: drawing.svg.replace('<svg ', '<svg data-annotated="yes" '), scene };
  };
  return calls;
}

const isAnnotated = (result) => /data-annotated="yes"/.test(result.svg);
const NOTE_ID = 'callout:0';

// Two drawings that cannot be squeezed (their gap is the box clearance):
// the column fits the pane better than the row.
const ROW_AND_COLUMN = [
  candidate('row', { A: { x: 0, y: 0 }, B: { x: 120, y: 0 } }),
  candidate('column', { A: { x: 0, y: 0 }, B: { x: 0, y: 70 } })
];

test('a squeeze the bare drawing already rejects is not annotated', () => {
  // Every squeeze adds a crossing: the reference is drawn and annotated, the
  // squeeze and its two retries are drawn and rejected bare.
  const { adapter } = fakeAdapter({
    candidates: [candidate('ref', { A: { x: 0, y: 0 }, B: { x: 300, y: 0 } })],
    decorate: (r) => ({ routes: r.B.x - (r.A.x + r.A.width) < 150 ? CROSSING_PAIR : [] })
  });
  const calls = annotating(adapter);
  const result = UMLCompactLayout.optimize(adapter, PANE);
  assert.equal(result.passes, 4);
  assert.equal(calls.length, 1);
});

test('a squeeze of an annotated drawing keeps the gap its annotation sits in', () => {
  // The annotation lies between A and B, 60 wide: squeezed bare the gap
  // would close to the box clearance.
  const NOTE = { width: 60, height: 20 };
  const { adapter } = fakeAdapter({ candidates: [candidate('ref', { A: { x: 0, y: 0 }, B: { x: 300, y: 0 } })] });
  annotating(adapter, (drawing) => {
    const a = drawing.scene.nodes.find((n) => n.id === 'A'), b = drawing.scene.nodes.find((n) => n.id === 'B');
    const middle = (a.x + a.width + b.x) / 2;
    return { labels: [{ id: NOTE_ID, kind: 'callout', owner: 'A', x: middle - NOTE.width / 2, y: 15, ...NOTE }] };
  });
  const result = UMLCompactLayout.optimize(adapter, PANE);
  const a = nodeOf(result, 'A'), b = nodeOf(result, 'B');
  assert.ok(b.x < 300, 'the drawing was squeezed');
  assert.ok(b.x - (a.x + a.width) >= NOTE.width, `gap ${b.x - (a.x + a.width)} holds the annotation`);
  assert.equal(result.issues, 0);
});

test('the drawing returned is an annotated one, and its metrics are those of its annotated scene', () => {
  const { adapter } = fakeAdapter({ candidates: ROW_AND_COLUMN });
  annotating(adapter, () => ({ labels: [{ id: NOTE_ID, kind: 'callout', x: 300, y: 300, width: 40, height: 20, owner: 'A' }], grow: [0, 40] }));
  const result = UMLCompactLayout.optimize(adapter, PANE);
  assert.equal(isAnnotated(result), true);
  assert.ok(result.scene.labels.some((l) => l.id === NOTE_ID), 'the annotation is in the returned scene');
  assert.deepEqual(plain(result.metrics), plain(UMLLayoutQuality.evaluate(result.scene, PANE)));
});

test('annotation leaves the drawings it is given unchanged', () => {
  const { adapter } = fakeAdapter({ candidates: ROW_AND_COLUMN });
  const calls = annotating(adapter, () => ({ labels: [{ id: NOTE_ID, x: 300, y: 300, width: 40, height: 20, owner: 'A' }] }));
  UMLCompactLayout.optimize(adapter, PANE);
  assert.ok(calls.length > 0, 'something was annotated');
  calls.forEach((drawing) => {
    assert.equal(drawing.scene.labels.length, 0);
    assert.doesNotMatch(drawing.svg, /data-annotated/);
  });
});

test('when its annotation grows the best-fitting drawing, another drawing wins', () => {
  const { adapter } = fakeAdapter({ candidates: ROW_AND_COLUMN });
  annotating(adapter, (drawing) => ({ grow: /column/.test(drawing.svg) ? [2000, 2000] : [0, 0] }));
  assert.equal(candidateOf(UMLCompactLayout.optimize(adapter, PANE)), 'row');
});

test('when its annotation makes the best-fitting drawing overlap, another drawing wins', () => {
  // In the column the annotation lies on B.
  const { adapter } = fakeAdapter({ candidates: ROW_AND_COLUMN });
  annotating(adapter, (drawing) => ({
    labels: /column/.test(drawing.svg) ? [{ id: NOTE_ID, kind: 'callout', x: 10, y: 80, width: 40, height: 20, owner: 'A' }] : []
  }));
  const result = UMLCompactLayout.optimize(adapter, PANE);
  assert.equal(candidateOf(result), 'row');
  assert.equal(result.issues, 0);
});

test('when every annotated drawing overlaps, the one with fewest overlaps is returned with issues set', () => {
  // The annotation lies on B: twice in the column, once in the row.
  const onB = (rect, n) => Array.from({ length: n }, (_, i) => ({ id: `callout:${i}`, kind: 'callout', owner: 'A',
    x: rect.x + 5 + 45 * i, y: rect.y + 5, width: 40, height: 20 }));
  const { adapter } = fakeAdapter({ candidates: ROW_AND_COLUMN });
  annotating(adapter, (drawing) => {
    const column = /column/.test(drawing.svg);
    const b = drawing.scene.nodes.find((n) => n.id === 'B');
    return { labels: onB(b, column ? 2 : 1) };
  });
  const result = UMLCompactLayout.optimize(adapter, PANE);
  assert.equal(isAnnotated(result), true);
  assert.equal(candidateOf(result), 'row');
  assert.equal(result.issues, 1);
});

test('an annotation that adds nothing leaves the choice as it is without annotation', () => {
  const make = () => fakeAdapter({
    candidates: [
      candidate('row', { A: { x: 0, y: 0 }, B: { x: 300, y: 0 } }),
      candidate('column', { A: { x: 0, y: 0 }, B: { x: 0, y: 200 } })
    ]
  }).adapter;
  const plainRun = UMLCompactLayout.optimize(make(), PANE);
  const annotated = make();
  annotating(annotated);
  const annotatedRun = UMLCompactLayout.optimize(annotated, PANE);
  assert.equal(annotatedRun.svg, plainRun.svg.replace('<svg ', '<svg data-annotated="yes" '));
  assert.deepEqual(plain(annotatedRun.metrics), plain(plainRun.metrics));
  assert.equal(annotatedRun.passes, plainRun.passes);
});

// ── renderer-shaped edge cases ────────────────────────────────────────

test('a drawing with no bodies comes back valid after one pass', () => {
  const { adapter } = fakeAdapter({ ids: [], candidates: [candidate('empty', {})], size: { boxes: 0, edges: 0 } });
  const result = UMLCompactLayout.optimize(adapter, PANE);
  assert.deepEqual([result.passes, result.issues, typeof result.svg], [1, 0, 'string']);
});

test('a single box without routes comes back valid after one pass', () => {
  const { adapter } = fakeAdapter({ ids: ['A'], candidates: [candidate('one', { A: { x: 0, y: 0 } })], size: { boxes: 1, edges: 0 } });
  const result = UMLCompactLayout.optimize(adapter, PANE);
  assert.deepEqual([result.passes, result.issues], [1, 0]);
});

// ── determinism and purity ────────────────────────────────────────────

test('two runs give identical results', () => {
  const make = () => fakeAdapter({
    candidates: [
      candidate('row', { A: { x: 0, y: 0 }, B: { x: 300, y: 0 } }),
      candidate('column', { A: { x: 0, y: 0 }, B: { x: 0, y: 200 } })
    ]
  }).adapter;
  assert.deepEqual(plain(UMLCompactLayout.optimize(make(), PANE)), plain(UMLCompactLayout.optimize(make(), PANE)));
});

test('optimize leaves the candidates unchanged', () => {
  const candidates = [candidate('ref', { A: { x: 0, y: 0 }, B: { x: 300, y: 0 } })];
  const before = plain(candidates);
  UMLCompactLayout.optimize(fakeAdapter({ candidates }).adapter, PANE);
  assert.deepEqual(plain(candidates), before);
});
