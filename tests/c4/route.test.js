'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Routing redesign §5 (docs/superpowers/specs/2026-11-09-c4-routing-redesign.md): ends, candidate routes, hard
// filters and global selection. Scenes are hand-built boxes of 300 × 120 at the stated top-left corners, laid out
// down, with unlabelled edges. Every oracle is computed here from the returned points with the independent metrics
// module; what the router reports is only compared with those computed values.

const metrics = require('../../../../scripts/tests/c4-route-metrics.js');

const ARCHUML_ROOT = path.join(__dirname, '..', '..');

/** The router's scripts (`c4-route*.js`) of the manifest's `render` list, in load order. */
const ROUTER_FILES = JSON.parse(fs.readFileSync(path.join(ARCHUML_ROOT, 'c4/manifest.json'), 'utf8')).render
  .filter((file) => /^c4\/c4-route[^/]*\.js$/.test(file));

/** A classic-script context without a DOM, holding the bundle (for `UMLShared`) and then the router. */
function routerContext() {
  const context = {
    document: { readyState: 'loading', addEventListener() {}, documentElement: {} },
    MutationObserver: class { observe() {} },
  };
  context.window = context;
  context.self = context;
  vm.createContext(context);
  ['uml-bundle.js'].concat(ROUTER_FILES).forEach((file) => {
    vm.runInContext(fs.readFileSync(path.join(ARCHUML_ROOT, file), 'utf8'), context, { filename: file });
  });
  return context;
}

const context = routerContext();
const Route = context.ArchUMLC4Route;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const box = (x, y, width = 300, height = 120) => ({ x, y, width, height });

/**
 * A frozen scene: `boxes` as `{id: [x, y]}` (or `[x, y, width, height]`), edges as `'a→b'` strings (the id is the
 * string itself; a `#n` suffix keeps the ids of parallel edges apart), every edge labelled `label` (`{width,
 * height}`, unlabelled by default), and the placement's `corridors`.
 */
function scene({ boxes, edges, boundaries = {}, parentOf = {}, label = { width: 0, height: 0 }, corridors = [] }) {
  const all = Object.fromEntries(Object.entries(boxes).map(([id, rect]) => [id, box(...rect)]));
  const parents = Object.fromEntries(Object.keys(all).concat(Object.keys(boundaries)).map((id) => [id, parentOf[id] || null]));
  return deepFreeze({
    boxes: all,
    boundaries,
    boundaryLabels: [],
    parentOf: parents,
    edges: edges.map((id) => {
      const [source, target] = id.split('#')[0].split('→');
      return { id, source, target, labelWidth: label.width, labelHeight: label.height };
    }),
    direction: 'down',
    corridors,
  });
}

function route(input, options = {}) {
  return Route.route(input, options);
}

function routeOf(result, id) {
  const found = result.edges.find((edge) => edge.id === id);
  assert.ok(found, `the result routes ${id}`);
  return found;
}

const bendsOf = (points) => metrics.bendsOf(points);
const crossingsBetween = (first, second, sceneValue, a, b) => {
  const shared = [a.source, a.target].filter((id) => id === b.source || id === b.target).map((id) => sceneValue.boxes[id]);
  return metrics.routeIntersections(first, second, shared);
};
const edgeOf = (sceneValue, id) => sceneValue.edges.find((edge) => edge.id === id);

/** The crossings between every pair of routes in `result`, measured with the metrics module. */
function crossingsOfView(result, sceneValue) {
  let crossings = 0;
  result.edges.forEach((first, i) => result.edges.slice(i + 1).forEach((second, offset) => {
    crossings += crossingsBetween(first.points, second.points, sceneValue, sceneValue.edges[i], sceneValue.edges[i + 1 + offset]).crossings;
  }));
  return crossings;
}

/** Which side of `rect` a route end lies on, judged by the segment that leaves it. */
function sideOf(point, next, rect) {
  if (point.x === next.x) return point.y === rect.y ? 'top' : point.y === rect.y + rect.height ? 'bottom' : null;
  return point.x === rect.x ? 'left' : point.x === rect.x + rect.width ? 'right' : null;
}

function headSide(points, rect) {
  const simple = metrics.simplify(points);
  return sideOf(simple[simple.length - 1], simple[simple.length - 2], rect);
}

function tailSide(points, rect) {
  const simple = metrics.simplify(points);
  return sideOf(simple[0], simple[1], rect);
}

test('a straight route wins whenever the two boxes overlap', () => {
  const input = scene({ boxes: { a: [0, 0], b: [100, 300] }, edges: ['a→b'] });
  const edge = routeOf(route(input), 'a→b');
  assert.equal(edge.points.length, 2);
  assert.equal(edge.points[0].x, edge.points[1].x);
  assert.ok(edge.points[0].x >= 124 && edge.points[0].x <= 276, `the line runs at x ${edge.points[0].x}`);
  assert.equal(bendsOf(edge.points), 0);
  assert.equal(edge.bends, bendsOf(edge.points));
});

test('a crossing-free route beats a crossing one at equal bends', () => {
  const input = scene({ boxes: { a: [0, 0], b: [0, 300], c: [390, 0], d: [-390, 600] }, edges: ['a→b', 'c→d'] });
  const result = route(input);
  const ab = routeOf(result, 'a→b');
  const cd = routeOf(result, 'c→d');
  // Precondition: a Z for c→d with its jog in the corridor between a and b (y = 210) crosses a→b.
  const zThroughCorridor = [{ x: 540, y: 120 }, { x: 540, y: 210 }, { x: -240, y: 210 }, { x: -240, y: 600 }];
  assert.equal(metrics.routeIntersections(zThroughCorridor, ab.points).crossings, 1);

  // The brief asked for exactly 2 bends; an L into d's right side (an escape side, §5.2) needs only 1 and crosses
  // nothing, so the objective (§5.5, bends before length) rightly prefers it. Either way the route bends at most twice.
  assert.ok(bendsOf(cd.points) >= 1 && bendsOf(cd.points) <= 2, `c→d has ${bendsOf(cd.points)} bends`);
  assert.equal(crossingsBetween(cd.points, ab.points, input, edgeOf(input, 'c→d'), edgeOf(input, 'a→b')).crossings, 0);
  assert.equal(metrics.detourOf(cd.points), 0);
  const horizontal = metrics.segmentsOf(metrics.simplify(cd.points)).find((segment) => segment.horizontal);
  assert.ok(horizontal.at > 420, `the jog runs at y ${horizontal.at}, below b`);
});

test('a crossing is taken when avoiding it needs a long detour', () => {
  const input = scene({ boxes: { s1: [0, 0], t1: [600, 400], s2: [600, 0], t2: [0, 400] }, edges: ['s1→t1', 's2→t2'] });
  ['s1→t1', 's2→t2'].forEach((id) => {
    const classes = Route.classify(input, id);
    assert.equal(classes.exempt, false, `${id} is not exempt`);
    assert.equal(classes.detourCap, 0);
  });
  const result = route(input);
  const first = routeOf(result, 's1→t1');
  const second = routeOf(result, 's2→t2');
  assert.equal(crossingsBetween(first.points, second.points, input, edgeOf(input, 's1→t1'), edgeOf(input, 's2→t2')).crossings, 1);
  [first, second].forEach((edge) => {
    assert.equal(metrics.detourOf(edge.points), 0, `${edge.id} takes no detour`);
    assert.ok(bendsOf(edge.points) <= 2, `${edge.id} has ${bendsOf(edge.points)} bends`);
    assert.equal(edge.fallbackRoute, false);
  });
});

test('fan-in spreads its heads over two sides and keeps their order', () => {
  const sources = { s1: [0, 0], s2: [390, 0], s3: [780, 0], s4: [1170, 0] };
  const input = scene({ boxes: Object.assign({ t: [585, 400] }, sources), edges: ['s1→t', 's2→t', 's3→t', 's4→t'] });
  const result = route(input);
  const target = input.boxes.t;
  const heads = Object.keys(sources).map((id) => {
    const points = metrics.simplify(routeOf(result, `${id}→t`).points);
    return { id, side: headSide(points, target), point: points[points.length - 1] };
  });
  const onSide = (side) => heads.filter((head) => head.side === side);
  assert.ok(onSide('top').length <= 2, `${onSide('top').length} heads on the top side`);
  assert.deepEqual(heads.filter((head) => head.side === null), [], 'every head ends on a side of t');
  assert.equal(heads.find((head) => head.id === 's1').side, 'left');
  assert.equal(heads.find((head) => head.id === 's4').side, 'right');
  ['top', 'left', 'right', 'bottom'].forEach((side) => {
    const along = onSide(side).map((head) => (side === 'top' || side === 'bottom' ? head.point.x : head.point.y)).sort((a, b) => a - b);
    const length = side === 'top' || side === 'bottom' ? target.width : target.height;
    const minimum = Math.max(60, length / (along.length + 1) - 10);
    along.slice(1).forEach((value, index) => assert.ok(value - along[index] >= minimum, `${side}: ends ${along[index]} and ${value} are closer than ${minimum}`));
  });
  const topOrder = onSide('top').sort((a, b) => a.point.x - b.point.x).map((head) => head.id);
  const sourceOrder = onSide('top').map((head) => head.id).sort((a, b) => sources[a][0] - sources[b][0]);
  assert.deepEqual(topOrder, sourceOrder);
});

// The three scenes below are generated landscapes (c4-route-views.js `generatedLandscape`) reduced to the boxes,
// boundaries and edges that still show the defect, at the positions placement gave them.
const ENTERPRISE_AND_GROUP = (enterprise, group) => ({ boundaries: { E: box(...enterprise), G: box(...group) }, groupParent: { G: 'E' } });

test('a fan-in of three takes heads on a second side even when all three fit on the top side', () => {
  // Seed 1: x1 below a group; an L or Z onto x1's top costs no more bends than a lane into its right side, but §9.2
  // asks every box with fan-in ≥ 3 for heads on at least two sides.
  const { boundaries, groupParent } = ENTERPRISE_AND_GROUP([-533, 312, 1007, 1038], [-503, 596, 947, 698]);
  const input = scene({
    boxes: { s2: [-124, 626, 300, 114], s3: [-372, 854, 300, 114], s5: [84, 1124, 300, 114], x1: [-485, 1536, 300, 114], x2: [-20, 1536, 300, 114] },
    boundaries, parentOf: Object.assign({ s2: 'G', s3: 'G', s5: 'G' }, groupParent),
    edges: ['s2→x1', 's3→x1', 's5→x1'], label: { width: 200, height: 34 },
  });
  const result = route(input);
  const sides = new Set(['s2→x1', 's3→x1', 's5→x1'].map((id) => headSide(routeOf(result, id).points, input.boxes.x1)));
  assert.ok(sides.size >= 2, `x1 receives its heads on ${Array.from(sides).join(', ')}`);
});

test('an edge entering a boundary past a wide group runs through the corridors within its detour cap', () => {
  // Seed 10: p1→s6 must pass group g1, which holds neither end; the lanes beside every obstacle detour beyond the
  // cap, while the corridor between the enterprise line and g1, then the corridor below g1, does not.
  const input = scene({
    boxes: { p1: [0, 0, 300, 126], s1: [-734, 390, 300, 114], s6: [-580, 1524, 300, 114] },
    boundaries: { E: box(-764, 360, 1448, 1390), G1: box(-666, 672, 1208, 424), G2: box(-610, 1270, 750, 424) },
    parentOf: { s1: 'E', s6: 'G2', G1: 'E', G2: 'E' },
    edges: ['p1→s6'], label: { width: 174, height: 34 },
  });
  const classes = Route.classify(input, 'p1→s6');
  const edge = routeOf(route(input), 'p1→s6');
  assert.equal(edge.fallbackRoute, false);
  assert.ok(metrics.detourOf(edge.points) <= classes.detourCap, `detour ${metrics.detourOf(edge.points)}, cap ${classes.detourCap}`);
  assert.ok(bendsOf(edge.points) <= classes.maxBends, `${bendsOf(edge.points)} bends, limit ${classes.maxBends}`);
});

test('the router sizes the detour cap of an edge past a group holding neither end as the metrics do', () => {
  // Routing redesign §5.0 (Ruling 21): a boundary holding neither end is an obstacle the edge goes around, so it
  // counts as a blocker for the cap. The group lies 29 units beside the region (inside its 30-unit band).
  const input = scene({ boxes: { s: [0, 600], t: [0, 0] }, edges: ['s→t'], boundaries: { g: box(329, 250, 700, 200) } });
  assert.equal(Route.classify(input, 's→t').detourCap, 2 * (30 + 24 + 20) + 350);
  assert.equal(Route.classify(input, 's→t').detourCap, metrics.classify(input, 's→t').detourCap);
});

test('two routes left closer than the track pitch are moved apart', () => {
  // Seed 3: p1→s4 and s2→s3 first ran 22 units apart, on neighbouring tracks of one corridor.
  const { boundaries, groupParent } = ENTERPRISE_AND_GROUP([-154, 294, 972, 1284], [-46, 578, 834, 944]);
  const input = scene({
    boxes: { p1: [0, 0, 300, 126], s1: [-124, 324, 300, 114], s2: [0, 608, 300, 114], s3: [458, 836, 300, 114], s4: [68, 836, 300, 114], s7: [390, 1352, 300, 114] },
    boundaries, parentOf: Object.assign({ s1: 'E', s2: 'G', s3: 'G', s4: 'G', s7: 'G' }, groupParent),
    edges: ['p1→s4', 'p1→s3', 's2→s3'], label: { width: 150, height: 34 },
  });
  const result = route(input);
  const close = [];
  input.edges.forEach((first, i) => input.edges.slice(i + 1).forEach((second) => {
    metrics.segmentsOf(metrics.simplify(routeOf(result, first.id).points)).forEach((a) => metrics.segmentsOf(metrics.simplify(routeOf(result, second.id).points)).forEach((b) => {
      if (a.horizontal === b.horizontal && Math.abs(a.at - b.at) < 24 && Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) >= 40) close.push(`${first.id} and ${second.id} at ${a.at}/${b.at}`);
    }));
  }));
  assert.deepEqual(close, []);
});

test('moving a route clear of a close neighbour is not kept when the moved route crosses another route', () => {
  // Seed 8, reduced: selection routes s3→x2 down a lane left of s4 and s4→x2 9 units beside it, without crossings.
  // Moving s3→x2's lane clear of s4→x2 makes the lane cross s4→x2; by its own cost alone the move looked free. The
  // objective ranks crossings above close parallels (routing redesign §5.5), so no such move may be kept (§5.6).
  const input = scene({
    boxes: { s3: [68, 878, 300, 114], s4: [-350, 878, 300, 114], s5: [-73, 1102, 300, 114], s6: [136, 1326, 300, 114], x2: [-285, 1762, 300, 114] },
    boundaries: { E: box(-410, 336, 1110, 1216), G: box(-380, 620, 1050, 876) },
    parentOf: { G: 'E', s3: 'G', s4: 'G', s5: 'G', s6: 'G' },
    edges: ['s3→x2', 's4→x2'],
  });
  const result = route(input);
  const found = crossingsBetween(routeOf(result, 's3→x2').points, routeOf(result, 's4→x2').points, input, edgeOf(input, 's3→x2'), edgeOf(input, 's4→x2'));
  assert.equal(found.crossings, 0);
});

/** Asserts that no segment of `points` runs along a line of `boundary` closer than 30 over more than 2 units. */
function assertClearOfBand(points, boundary) {
  const lines = [
    { horizontal: true, at: boundary.y, lo: boundary.x, hi: boundary.x + boundary.width },
    { horizontal: true, at: boundary.y + boundary.height, lo: boundary.x, hi: boundary.x + boundary.width },
    { horizontal: false, at: boundary.x, lo: boundary.y, hi: boundary.y + boundary.height },
    { horizontal: false, at: boundary.x + boundary.width, lo: boundary.y, hi: boundary.y + boundary.height },
  ];
  metrics.segmentsOf(metrics.simplify(points)).forEach((segment) => lines.filter((line) => line.horizontal === segment.horizontal)
    .forEach((line) => {
      const overlap = Math.min(segment.hi, line.hi) - Math.max(segment.lo, line.lo);
      assert.ok(Math.abs(segment.at - line.at) >= 30 || overlap <= 2, `a segment at ${segment.at} runs ${Math.abs(segment.at - line.at)} from the line at ${line.at} over ${overlap}`);
    }));
}

test("no segment runs inside a boundary's band", () => {
  const boundary = { x: 20, y: 200, width: 360, height: 180 };
  const input = scene({
    boxes: { m: [50, 230], p: [600, 0] }, edges: ['p→m'], boundaries: { B: boundary }, parentOf: { m: 'B' },
  });
  const points = routeOf(route(input), 'p→m').points;
  assert.ok(bendsOf(points) >= 1, 'p lies outside the x range of m, so the route bends');
  assertClearOfBand(points, boundary);
  assert.equal(metrics.outlineCrossings(points, boundary), 1);
});

test('a route whose shortest way runs along a boundary line takes another way', () => {
  // p's right side faces the boundary's top line: an L into m's top would run 0 to 30 below or above that line.
  const boundary = { x: 20, y: 200, width: 360, height: 180 };
  const input = scene({
    boxes: { m: [50, 230], p: [-420, 140] }, edges: ['p→m'], boundaries: { B: boundary }, parentOf: { m: 'B' },
  });
  const points = routeOf(route(input), 'p→m').points;
  assertClearOfBand(points, boundary);
  assert.equal(metrics.outlineCrossings(points, boundary), 1);
});

test('a route between two members of one boundary never leaves it, even for a shorter detour', () => {
  // k blocks the way between a and b; the lane inside the boundary, right of k, is longer than one outside it.
  const boundary = { x: 0, y: 200, width: 700, height: 820 };
  const input = scene({
    boxes: { a: [30, 230], k: [30, 550, 560, 120], b: [30, 870] }, edges: ['a→b'],
    boundaries: { B: boundary }, parentOf: { a: 'B', k: 'B', b: 'B' },
  });
  const points = routeOf(route(input), 'a→b').points;
  assert.equal(metrics.outlineCrossings(points, boundary), 0);
  assertClearOfBand(points, boundary);
});

test('an entering edge crosses the boundary line once', () => {
  const boundary = { x: 0, y: 200, width: 360, height: 500 };
  const input = scene({
    boxes: { m1: [30, 230], m2: [30, 550], c: [30, 0] }, edges: ['c→m2'], boundaries: { B: boundary }, parentOf: { m1: 'B', m2: 'B' },
  });
  const classes = Route.classify(input, 'c→m2');
  assert.equal(classes.boundaryEntry, true);
  assert.equal(classes.exempt, true);
  const cap = metrics.classify(input, 'c→m2').detourCap;
  const points = routeOf(route(input), 'c→m2').points;
  assert.equal(metrics.outlineCrossings(points, boundary), 1);
  assert.ok(bendsOf(points) <= 4, `${bendsOf(points)} bends`);
  assert.ok(metrics.detourOf(points) <= cap, `detour ${metrics.detourOf(points)} over the cap ${cap}`);
});

test('evidence mode reports the fewest crossings the named edges can reach', () => {
  const crossing = scene({ boxes: { s1: [0, 0], t1: [600, 400], s2: [600, 0], t2: [0, 400] }, edges: ['s1→t1', 's2→t2'] });
  const forced = route(crossing, { exhaustivePairs: ['s1→t1', 's2→t2'] }).stats.exhaustive;
  assert.equal(forced.minCrossings, 1, 'interleaved monotone routes always cross once');
  const [first, second] = forced.routes;
  assert.equal(metrics.routeIntersections(first.points, second.points).crossings, 1, 'the reported combination crosses once');

  const avoidable = scene({ boxes: { a: [0, 0], b: [0, 300], c: [390, 0], d: [-390, 600] }, edges: ['a→b', 'c→d'] });
  const free = route(avoidable, { exhaustivePairs: ['a→b', 'c→d'] }).stats.exhaustive;
  assert.equal(free.minCrossings, 0);
  assert.equal(route(avoidable).stats.exhaustive, null, 'the search runs only when asked for');
});

test('a crossing outranks a close parallel, so the router and evidence mode both reach no crossing', () => {
  // Reduced from generated seed 8: s3→x2 and s4→x2 avoid their crossing only by running down one corridor 9 units
  // apart. That close parallel breaks a §9.2 zero gate, but §5.5 ranks crossings above close parallels, so the
  // router takes it, and evidence mode, which allows the close parallels the chosen routes have, finds no fewer
  // crossings.
  const input = scene({
    boxes: { s3: [68, 878, 300, 114], s4: [-350, 878, 300, 114], s5: [-73, 1102, 300, 114], s6: [136, 1326, 300, 114], x2: [-285, 1762, 300, 114] },
    boundaries: { E: box(-410, 336, 1110, 1216), G: box(-380, 620, 1050, 876) },
    parentOf: { s3: 'G', s4: 'G', s5: 'G', s6: 'G', G: 'E' },
    edges: ['s3→x2', 's4→x2'],
  });
  const result = route(input, { exhaustivePairs: ['s3→x2', 's4→x2'] });
  const [first, second] = ['s3→x2', 's4→x2'].map((id) => routeOf(result, id).points);
  assert.equal(crossingsBetween(first, second, input, edgeOf(input, 's3→x2'), edgeOf(input, 's4→x2')).crossings, 0, 'the router takes no crossing');
  assert.equal(result.stats.exhaustive.minCrossings, 0);
});

test('evidence mode does not count a combination with fewer crossings that adds a conflict', () => {
  // b3's bottom side already holds b2→b3's head and b3→b1's tail, so b1→b3 goes round to b3's right side and crosses
  // b2→b3 on the way. b1→b3 could avoid the crossing only by entering b3's bottom between those two ends, closer to
  // b3→b1's tail than the end gap: a side conflict (§5.5 term 1), which ranks above crossings. Evidence mode keeps
  // the chosen routes' conflicts, so it reports the router's one crossing, not that combination's none.
  const input = scene({
    boxes: { b0: [0, 600], b1: [390, 600], b2: [780, 600], b3: [780, 300] },
    edges: ['b2→b3', 'b0→b3', 'b3→b1', 'b1→b3'],
  });
  const result = route(input, { exhaustivePairs: ['b2→b3', 'b1→b3'] });
  assert.equal(crossingsOfView(result, input), 1, 'the router takes one crossing');
  assert.equal(result.stats.exhaustive.minCrossings, 1);
});

test('an upward edge goes straight up when nothing blocks it', () => {
  const input = scene({ boxes: { s: [0, 400], t: [0, 0] }, edges: ['s→t'] });
  assert.equal(Route.classify(input, 's→t').upward, true);
  const points = routeOf(route(input), 's→t').points;
  assert.equal(points.length, 2);
  assert.equal(metrics.detourOf(points), 0);
  assert.equal(tailSide(points, input.boxes.s), 'top');
  assert.equal(headSide(points, input.boxes.t), 'bottom');
});

test('an upward edge between offset boxes bends once, leaving its source against the flow', () => {
  const input = scene({ boxes: { s: [400, 400], t: [0, 0] }, edges: ['s→t'] });
  assert.equal(Route.classify(input, 's→t').upward, true);
  const points = routeOf(route(input), 's→t').points;
  assert.equal(bendsOf(points), 1);
  assert.equal(metrics.detourOf(points), 0);
});

test('an upward edge takes a crossing rather than a detour beyond its cap', () => {
  // a→b runs straight across the gap between t and s; going around a or b is a detour of 800 or more.
  const input = scene({ boxes: { s: [0, 400], t: [0, 0], a: [-400, 200], b: [400, 200] }, edges: ['s→t', 'a→b'] });
  const result = route(input);
  const upward = routeOf(result, 's→t').points;
  const across = routeOf(result, 'a→b').points;
  const cap = metrics.classify(input, 's→t').detourCap;
  assert.ok(metrics.detourOf(upward) <= cap, `detour ${metrics.detourOf(upward)} over the cap ${cap}`);
  assert.equal(crossingsBetween(upward, across, input, edgeOf(input, 's→t'), edgeOf(input, 'a→b')).crossings, 1);
});

test('blocked upward edges nest their lanes', () => {
  const input = scene({ boxes: { s: [0, 1200], k: [0, 800], t1: [0, 400], t2: [0, 0] }, edges: ['s→t1', 's→t2'] });
  ['s→t1', 's→t2'].forEach((id) => {
    const classes = Route.classify(input, id);
    assert.equal(classes.upward, true, `${id} is upward`);
    assert.equal(classes.blocked, true, `${id} is blocked`);
  });
  const result = route(input);
  const near = routeOf(result, 's→t1').points;
  const far = routeOf(result, 's→t2').points;
  [['s→t1', near], ['s→t2', far]].forEach(([id, points]) => {
    assert.ok(bendsOf(points) <= 4, `${id} has ${bendsOf(points)} bends`);
    const cap = metrics.classify(input, id).detourCap;
    assert.ok(metrics.detourOf(points) <= cap, `${id}: detour ${metrics.detourOf(points)} over the cap ${cap}`);
  });
  assert.equal(crossingsBetween(near, far, input, edgeOf(input, 's→t1'), edgeOf(input, 's→t2')).crossings, 0);
  const lane = (points) => metrics.segmentsOf(metrics.simplify(points)).filter((segment) => !segment.horizontal)
    .reduce((longest, segment) => (!longest || segment.hi - segment.lo > longest.hi - longest.lo ? segment : longest), null).at;
  const [nearLane, farLane] = [lane(near), lane(far)];
  const sideOfLane = (x) => (x < 0 ? 'left' : x > 300 ? 'right' : 'inside');
  if (sideOfLane(nearLane) === sideOfLane(farLane)) {
    assert.ok(Math.abs(nearLane - 150) < Math.abs(farLane - 150), `the s→t1 lane (x ${nearLane}) lies between the boxes and the s→t2 lane (x ${farLane})`);
  }
});

test('selection reaches the fewest crossings the exhaustive search finds for a booking component layout', () => {
  // The boxes of the booking component view as placement put them (Task 8b-2). Two crossings are forced: the
  // coordinator's edge to the permission policy must pass the room finder's edges to the ledger and to the catalog.
  // Reaching that minimum needs edges to give way to each other, which one edge at a time cannot do.
  const input = scene({
    boxes: {
      app: [0, 0, 300, 190], coordinator: [-195, 416, 300, 192], permissions: [373, 774, 300, 140], finder: [195, 416, 300, 140],
      catalog: [373, 1252, 300, 166], ledger: [-17, 774, 300, 296], 'calendar-gateway': [-407, 774, 300, 166],
      db: [-17, 1764, 300, 174], calendar: [-407, 1764, 300, 140],
    },
    edges: ['app→coordinator', 'app→finder', 'app→catalog', 'coordinator→permissions', 'coordinator→ledger', 'coordinator→calendar-gateway',
      'permissions→catalog', 'finder→catalog', 'finder→ledger', 'catalog→db', 'ledger→db', 'calendar-gateway→calendar'],
    boundaries: { api: { x: -437, y: 386, width: 1363, height: 1088 } },
    parentOf: { coordinator: 'api', permissions: 'api', finder: 'api', catalog: 'api', ledger: 'api', 'calendar-gateway': 'api' },
  });
  const involved = ['coordinator→permissions', 'finder→ledger', 'finder→catalog'];
  const result = route(input, { exhaustivePairs: involved });
  assert.equal(result.stats.exhaustive.minCrossings, 2);
  assert.equal(crossingsOfView(result, input), 2);
});

// ---- Labels (routing redesign §6) ------------------------------------------------------------------------------

const LABEL = { width: 308, height: 86 };
const OWN_ROUTE_MAX = 6; // labelBesideGap: the farthest a label may sit from its own route
const FOREIGN_ROUTE_MIN = 12; // labelForeignClear
const LABEL_PAD = 8; // labelBoxClear: to boxes and other labels

/** A copy of a router result made of this realm's objects, so strict deep equality can compare it. */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** Axis-aligned distance from `rect` to the polyline `points` (0 when they touch or overlap). */
function distanceToRoute(rect, points) {
  return Math.min(...points.slice(1).map((to, index) => {
    const from = points[index];
    const dx = Math.max(0, Math.min(from.x, to.x) - (rect.x + rect.width), rect.x - Math.max(from.x, to.x));
    const dy = Math.max(0, Math.min(from.y, to.y) - (rect.y + rect.height), rect.y - Math.max(from.y, to.y));
    return Math.hypot(dx, dy);
  }));
}

function overlapsWithPad(a, b, pad) {
  return a.x - pad < b.x + b.width && b.x < a.x + a.width + pad && a.y - pad < b.y + b.height && b.y < a.y + a.height + pad;
}

/** Every edge has a label at most 6 from its own route, at least 12 from every other route, clear of boxes and labels. */
function assertLabelsOnOwnEdges(input, result) {
  const problems = [];
  result.edges.forEach((edge) => {
    const label = edge.labelBox;
    if (edge.labelFallback !== false) problems.push(`${edge.id} is a label fallback`);
    if (!label) {
      problems.push(`${edge.id} has no label`);
      return;
    }
    const own = distanceToRoute(label, edge.points);
    if (own > OWN_ROUTE_MAX) problems.push(`${edge.id}: label ${own} from its own route`);
    result.edges.filter((other) => other !== edge).forEach((other) => {
      const foreign = distanceToRoute(label, other.points);
      if (foreign < FOREIGN_ROUTE_MIN) problems.push(`${edge.id}: label ${foreign} from the route of ${other.id}`);
      if (other.labelBox && overlapsWithPad(label, other.labelBox, LABEL_PAD)) problems.push(`${edge.id}: label on the label of ${other.id}`);
    });
    Object.entries(input.boxes).filter(([, rect]) => overlapsWithPad(label, rect, LABEL_PAD))
      .forEach(([id]) => problems.push(`${edge.id}: label on box ${id}`));
  });
  assert.deepEqual(problems, []);
}

test('a fan-out of three keeps every label on its own edge', () => {
  const input = scene({
    boxes: { p: [390, 0], c1: [0, 400], c2: [390, 400], c3: [780, 400] }, edges: ['p→c1', 'p→c2', 'p→c3'], label: LABEL,
  });
  assertLabelsOnOwnEdges(input, route(input));
});

test('a fan-in of four with side heads keeps every label on its own edge', () => {
  const sources = { s1: [0, 0], s2: [390, 0], s3: [780, 0], s4: [1170, 0] };
  const input = scene({ boxes: Object.assign({ t: [585, 400] }, sources), edges: ['s1→t', 's2→t', 's3→t', 's4→t'], label: LABEL });
  const result = route(input);
  const sides = result.edges.map((edge) => headSide(edge.points, input.boxes.t));
  assert.ok(sides.some((side) => side === 'left' || side === 'right'), `heads arrive on ${sides.join(', ')}`);
  assertLabelsOnOwnEdges(input, result);
});

test('two close straight edges label outward', () => {
  const input = scene({ boxes: { a: [0, 0], b1: [-195, 400], b2: [195, 400] }, edges: ['a→b1', 'a→b2'], label: LABEL });
  const result = route(input);
  const left = routeOf(result, 'a→b1');
  const right = routeOf(result, 'a→b2');
  assert.deepEqual([bendsOf(left.points), bendsOf(right.points)], [0, 0], 'both routes are straight');
  assert.ok(left.labelBox.x + left.labelBox.width <= left.points[0].x, `the a→b1 label ends at x ${left.labelBox.x + left.labelBox.width}, right of its route at ${left.points[0].x}`);
  assert.ok(right.labelBox.x >= right.points[0].x, `the a→b2 label starts at x ${right.labelBox.x}, left of its route at ${right.points[0].x}`);
  [[left, right], [right, left]].forEach(([edge, other]) => {
    assert.ok(distanceToRoute(edge.labelBox, edge.points) <= OWN_ROUTE_MAX, `${edge.id}: label beside its own route`);
    assert.ok(distanceToRoute(edge.labelBox, other.points) >= FOREIGN_ROUTE_MIN, `${edge.id}: label clear of ${other.id}`);
  });
});

test('a bundle of three keeps every label unambiguous', () => {
  const input = scene({ boxes: { a: [0, 0], b: [0, 400] }, edges: ['a→b', 'b→a', 'a→b#2'], label: LABEL });
  const result = route(input);
  const ambiguous = result.edges.flatMap((edge) => result.edges.filter((other) => other !== edge)
    .filter((other) => distanceToRoute(edge.labelBox, other.points) < FOREIGN_ROUTE_MIN).map((other) => `${edge.id} near ${other.id}`));
  assert.deepEqual(ambiguous, []);
  result.edges.forEach((edge) => assert.ok(distanceToRoute(edge.labelBox, edge.points) > 0, `${edge.id}: the label sits on its route`));
  const lanes = metrics.segmentsOf(metrics.simplify(routeOf(result, 'a→b#2').points)).filter((segment) => !segment.horizontal);
  assert.ok(lanes.length > 0 && lanes.every((segment) => segment.at < 0 || segment.at > 300),
    `the third member runs at x ${lanes.map((segment) => segment.at).join(', ')}, inside the boxes' x range 0–300`);
});

/** Two boxes 60 apart, with the placement's rank corridor between them. */
const TIGHT_CORRIDOR = { id: 'root|main|0', kind: 'rank', axis: 'main', from: 120, to: 180 };
const tightScene = () => scene({ boxes: { a: [0, 0], b: [0, 180] }, edges: ['a→b'], label: LABEL, corridors: [TIGHT_CORRIDOR] });

test('a label that does not fit asks for growth on the flow axis', () => {
  const { growth } = route(tightScene());
  assert.equal(growth.length, 1, JSON.stringify(growth));
  assert.equal(growth[0].corridorId, 'root|main|0');
  assert.equal(growth[0].axis, 'main');
  // The label (86) with its clearance (8), the tail and head stubs (18, 30), less the 60 the corridor has.
  const missing = 86 + 8 + 18 + 30 - 60;
  assert.ok(growth[0].by >= missing && growth[0].by <= missing + 24, `grows by ${growth[0].by}`);
});

test('a label squeezed across the flow asks for growth on the cross axis', () => {
  const at = (x, y) => [x, y, 120, 120];
  const gap = (id, from, to, between) => ({ id, kind: 'gap', axis: 'cross', from, to, between });
  const input = scene({
    boxes: { s1: at(0, 0), s2: at(160, 0), s3: at(320, 0), t1: at(0, 400), t2: at(160, 400), t3: at(320, 400) },
    edges: ['s1→t1', 's2→t2', 's3→t3'], label: LABEL,
    corridors: [
      { id: 'root|main|0', kind: 'rank', axis: 'main', from: 120, to: 400 },
      gap('root|cross|0|s1|s2', 120, 160, ['s1', 's2']), gap('root|cross|0|s2|s3', 280, 320, ['s2', 's3']),
    ],
  });
  const { growth } = route(input);
  assert.deepEqual(plain(growth).map((entry) => entry.corridorId).sort(), ['root|cross|0|s1|s2', 'root|cross|0|s2|s3']);
  growth.forEach((entry) => {
    assert.equal(entry.axis, 'cross');
    assert.ok(entry.by >= 6 && entry.by <= 30, `${entry.corridorId} grows by ${entry.by}`);
  });
});

/**
 * The end conflicts on one side of `rect` (as the fan-in test judges them): pairs of neighbouring ends closer than
 * `max(60, side / (n + 1) − 10)`, plus the ends beyond four.
 */
function sideConflicts(result, rect, side) {
  const ends = result.edges.flatMap((edge) => {
    const points = metrics.simplify(edge.points);
    return [[points[0], points[1]], [points[points.length - 1], points[points.length - 2]]]
      .filter(([end, next]) => sideOf(end, next, rect) === side).map(([end]) => (side === 'top' || side === 'bottom' ? end.x : end.y));
  }).sort((a, b) => a - b);
  const length = side === 'top' || side === 'bottom' ? rect.width : rect.height;
  const minimum = Math.max(60, length / (ends.length + 1) - 10);
  return ends.slice(1).filter((value, index) => value - ends[index] < minimum).length + Math.max(0, ends.length - 4);
}

/**
 * Five sources above `t`, whose neighbours on its rank leave `gap` units on either side of it (and `gap` between the
 * two neighbours on its left). The second and fourth source reach over the gaps beside `t`, so with room there they
 * can enter its sides with one bend.
 */
function crowdedTopScene(gap) {
  const t = 390;
  const rank = (from, to, between) => ({ id: `root|cross|1|${between.join('|')}`, kind: 'gap', axis: 'cross', from, to, between });
  return scene({
    boxes: {
      s1: [-540, 0], s2: [-150, 0], s3: [240, 0], s4: [630, 0], s5: [1020, 0],
      n0: [t - 2 * gap - 600, 400], n1: [t - gap - 300, 400], t: [t, 400], n2: [t + 300 + gap, 400],
    },
    edges: ['s1→t', 's2→t', 's3→t', 's4→t', 's5→t'],
    corridors: [
      { id: 'root|main|0', kind: 'rank', axis: 'main', from: 120, to: 400 },
      rank(t - 2 * gap - 300, t - gap - 300, ['n0', 'n1']), rank(t - gap, t, ['n1', 't']), rank(t + 300, t + 300 + gap, ['t', 'n2']),
    ],
  });
}

test('a side conflict that room beside the box would fix asks for growth of the gaps beside it', () => {
  const narrow = crowdedTopScene(30);
  const result = route(narrow);
  const conflicts = sideConflicts(result, narrow.boxes.t, 'top');
  assert.ok(conflicts > 0, 'precondition: the five heads crowd the top of t');
  const growth = plain(result.growth);
  assert.deepEqual(growth.map((entry) => entry.corridorId).sort(), ['root|cross|1|n1|t', 'root|cross|1|t|n2']);
  // A lane beside t keeps 32 from each box (box clearance 20 plus half a track pitch); the conflicting ends share
  // the two gaps, and each further lane in one gap needs one more track pitch (24). The gaps have 30.
  const lanesPerGap = Math.ceil(conflicts / 2);
  growth.forEach((entry) => {
    assert.equal(entry.axis, 'cross');
    assert.ok(entry.by >= 64 - 30 && entry.by <= 64 - 30 + 24 * (lanesPerGap - 1), `${entry.corridorId} grows by ${entry.by}`);
  });

  const widened = crowdedTopScene(30 + Math.max(...growth.map((entry) => entry.by)));
  const after = route(widened);
  ['top', 'left', 'right'].forEach((side) => assert.equal(sideConflicts(after, widened.boxes.t, side), 0, `with the room, the ${side} of t has no end conflict`));
  assert.deepEqual(plain(after.growth), []);
});

test('when growth is not allowed the label stays on its edge', () => {
  const result = route(tightScene(), { noGrowth: ['root|main|0'] });
  const edge = routeOf(result, 'a→b');
  assert.equal(edge.labelFallback, true);
  assert.deepEqual(plain(result.growth), []);
  assert.ok(distanceToRoute(edge.labelBox, edge.points) <= OWN_ROUTE_MAX, `the label is ${distanceToRoute(edge.labelBox, edge.points)} from its route`);
  assert.equal(result.stats.labelFallbacks, 1);
});

test('routing is deterministic, does not mutate its input, and does not touch UMLShared', () => {
  const shared = context.UMLShared;
  const keysBefore = Object.keys(shared);
  const functionsBefore = keysBefore.map((key) => shared[key]);
  const input = scene({ boxes: { a: [0, 0], b: [0, 300], c: [390, 0], d: [-390, 600] }, edges: ['a→b', 'c→d'] });
  const first = route(input);
  assert.deepEqual(route(input), first);

  const rename = new Map([['a', 'z9'], ['b', '3'], ['c', '20'], ['d', '100']]);
  const renamed = deepFreeze({
    boxes: Object.fromEntries(Object.entries(input.boxes).map(([id, rect]) => [rename.get(id), rect])),
    boundaries: {},
    boundaryLabels: [],
    parentOf: Object.fromEntries(Object.keys(input.boxes).map((id) => [rename.get(id), null])),
    edges: input.edges.map((edge) => ({ id: `${rename.get(edge.source)}→${rename.get(edge.target)}`, source: rename.get(edge.source), target: rename.get(edge.target), labelWidth: 0, labelHeight: 0 })),
    direction: 'down',
    corridors: [],
  });
  const second = route(renamed);
  assert.deepEqual(second.edges.map((edge) => edge.points), first.edges.map((edge) => edge.points));

  assert.deepEqual(Object.keys(shared), keysBefore);
  keysBefore.forEach((key, index) => assert.equal(shared[key], functionsBefore[index], `UMLShared.${key} is unchanged`));
});

/**
 * Scenes that between them reach every step of the router: straight, bent, lane and corridor routes, a boundary
 * entry, a labelled bundle, growth on both axes and refused growth, a view laid out to the right, and evidence mode.
 * Each is `[name, scene, options]`.
 */
function classicSamples() {
  const crossing = scene({ boxes: { a: [0, 0], b: [0, 300], c: [390, 0], d: [-390, 600] }, edges: ['a→b', 'c→d'], label: LABEL });
  const entering = scene({
    boxes: { m1: [30, 230], m2: [30, 550], c: [30, 0] }, edges: ['c→m2'],
    boundaries: { B: { x: 0, y: 200, width: 360, height: 500 } }, parentOf: { m1: 'B', m2: 'B' },
  });
  return [
    ['a labelled pair in evidence mode', crossing, { exhaustivePairs: ['a→b', 'c→d'] }],
    ['the labelled pair laid out to the right', deepFreeze(Object.assign({}, crossing, { direction: 'right' })), {}],
    ['a labelled bundle of three', scene({ boxes: { a: [0, 0], b: [0, 400] }, edges: ['a→b', 'b→a', 'a→b#2'], label: LABEL }), {}],
    ['a label that asks for growth', tightScene(), {}],
    ['a label refused growth', tightScene(), { noGrowth: ['root|main|0'] }],
    ['a crowded top side', crowdedTopScene(30), {}],
    ['an edge entering a boundary', entering, {}],
    ['blocked upward edges', scene({ boxes: { s: [0, 1200], k: [0, 800], t1: [0, 400], t2: [0, 0] }, edges: ['s→t1', 's→t2'] }), {}],
  ];
}

test('the router loads without the bundle, and as classic scripts routes every scene as under Node require', () => {
  const bare = vm.createContext({});
  ROUTER_FILES.forEach((file) => {
    vm.runInContext(fs.readFileSync(path.join(ARCHUML_ROOT, file), 'utf8'), bare, { filename: file });
  });
  const classic = bare.ArchUMLC4Route;
  const required = require('../../c4/c4-route.js');
  assert.equal(Object.isFrozen(required.CFG), true);
  assert.deepEqual(plain(classic.CFG), plain(required.CFG));
  const shared = context.UMLShared;
  classicSamples().forEach(([name, input, options]) => {
    const settings = Object.assign({ shared }, options);
    assert.deepEqual(plain(classic.route(input, settings)), plain(required.route(input, settings)), `${name}: route`);
    input.edges.forEach((edge) => {
      assert.deepEqual(plain(classic.classify(input, edge.id)), plain(required.classify(input, edge.id)), `${name}: classify ${edge.id}`);
    });
  });
});
