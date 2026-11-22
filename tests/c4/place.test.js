'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Place = require('../../c4/c4-place.js');
const { GRAPHS, element, person, edge, graph, options } = require('./place-graphs.js');

const SEEDS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/place-seeds.json'), 'utf8'));

// Routing redesign §4.2–§4.4: ranks (people on top, shortest spans, lane items for long edges) and the order inside
// every rank (fewest crossings, outside partners at their positions, then nearest the seed), and placement, where a
// pin moves its own box only (pins never enter ranking or ordering).

function deepFreeze(value) {
  if (value && typeof value === 'object' && !(value instanceof Map) && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** Runs rankAndOrder on a frozen graph, as every caller hands it one. */
function rankAndOrder(name) {
  const { graph, options } = GRAPHS[name];
  return Place.rankAndOrder(deepFreeze(graph), deepFreeze(options));
}

function permutationsOf(items) {
  if (items.length <= 1) return [items.slice()];
  return items.flatMap((item, index) => permutationsOf(items.filter((_, other) => other !== index)).map((rest) => [item, ...rest]));
}

/** Pairs of edges between two ranks whose ends lie in opposite orders, counted from `order` alone. */
function crossingsOf(order, edges) {
  const index = new Map(order.flatMap((row) => row.map((id, position) => [id, position])));
  let count = 0;
  edges.forEach((first, i) => edges.slice(i + 1).forEach((second) => {
    const top = index.get(first.source) - index.get(second.source);
    const bottom = index.get(first.target) - index.get(second.target);
    if (top * bottom < 0) count++;
  }));
  return count;
}

test('people take rank 0 even in a view without a scope', () => {
  const { ranks } = rankAndOrder('peopleWithoutScope');
  assert.equal(ranks.p, 0);
  assert.ok(ranks.a >= 1, `a is on rank ${ranks.a}`);
  assert.ok(ranks.m >= 1, `m is on rank ${ranks.m}`);
});

test('rank 0 holds only people, even beside an element without relationships', () => {
  const { ranks } = rankAndOrder('personBesideLoneElement');
  assert.equal(ranks.p, 0);
  assert.equal(ranks.e, 1);
});

test('an item with no incoming edge ranks as low as its successors allow', () => {
  const { ranks } = rankAndOrder('sourceWithoutIncomingEdge');
  assert.equal(ranks.d, ranks.b);
});

test('a long edge gets one lane item per intermediate rank', () => {
  const { lanes, order } = rankAndOrder('longEdge');
  assert.deepEqual(lanes, [{ id: 'lane:a→c:root:1', edgeId: 'a→c', level: 'root', rank: 1 }]);
  assert.ok(order.root[1].includes('lane:a→c:root:1'), `rank 1 holds ${order.root[1]}`);
});

test("a long edge's lane item is ordered among the boxes without crossings", () => {
  const { order, stats } = rankAndOrder('laneAmongBoxes');
  const lane = 'lane:a→c:root:1';
  assert.deepEqual(order.root[1].slice().sort(), [lane, 'x', 'y'], 'x, y, and the lane of a→c share rank 1');
  const idx = (id) => order.root.find((row) => row.includes(id)).indexOf(id);
  const sideOfA = Math.sign(idx('a') - idx('d'));
  assert.equal(Math.sign(idx(lane) - idx('x')), sideOfA, `a→c crosses d→x in ${JSON.stringify(order.root)}`);
  assert.equal(Math.sign(idx(lane) - idx('y')), sideOfA, `a→c crosses d→y in ${JSON.stringify(order.root)}`);
  assert.equal(stats.layerCrossings, 0);
});

test('the order with no crossings is found when one exists', () => {
  const { graph } = GRAPHS.crossing;
  const { order, stats } = rankAndOrder('crossing');
  const idx = (id) => order.root.find((row) => row.includes(id)).indexOf(id);
  graph.edges.forEach((first) => graph.edges.forEach((second) => {
    assert.equal(Math.sign(idx(first.source) - idx(second.source)), Math.sign(idx(first.target) - idx(second.target)),
      `${first.id} and ${second.id} cross in ${JSON.stringify(order.root)}`);
  }));
  assert.equal(stats.layerCrossings, 0);
  assert.equal(crossingsOf(order.root, graph.edges), 0);
});

test('no order of a seven-box row crosses its neighbour row less often than the chosen one', () => {
  const { graph } = GRAPHS.sevenWideTwoRanks;
  const { order } = rankAndOrder('sevenWideTwoRanks');
  const chosen = crossingsOf(order.root, graph.edges);
  [0, 1].forEach((rank) => {
    const fewest = Math.min(...permutationsOf(order.root[rank]).map((row) => {
      const rows = order.root.slice();
      rows[rank] = row;
      return crossingsOf(rows, graph.edges);
    }));
    assert.equal(chosen, fewest, `rank ${rank} could cross only ${fewest} times, but ${JSON.stringify(order.root)} crosses ${chosen} times`);
  });
});

test('among equally good orders the one nearest the seed wins', () => {
  const { order } = rankAndOrder('fanOutWithSeed');
  assert.deepEqual(order.root[1], ['z', 'x', 'y']);
});

test('among orders with equally few crossings, a box under its partner wins over the seed order', () => {
  // The seed puts x left of y and z (every order of that rank has no crossings); x under p has no barycentre
  // displacement, and of the two such orders, y-x-z moves less from the seed than z-x-y.
  const { order } = rankAndOrder('partnerBesideTwoLoners');
  assert.deepEqual(order.root[1], ['y', 'x', 'z']);
});

test("outside partners order a boundary's members", () => {
  const { order } = rankAndOrder('outsidePartners');
  assert.deepEqual(order.s[0], ['m2', 'm1']);
  const outer = order.root.flat();
  assert.equal(outer.filter((id) => id === 's').length, 1);
  assert.ok(!outer.includes('m1') && !outer.includes('m2'), `the outer level holds ${outer}`);
});

test('ranking and order ignore object key order and id spelling', async (t) => {
  await t.test('numeric-looking ids keep view-model order', () => {
    assert.deepEqual(rankAndOrder('numericIds').order.root[0], ['10', '2']);
  });

  await t.test('renaming every id against lexical order changes nothing', () => {
    const rename = new Map([['a', 'z9'], ['b', 'y8'], ['c', 'x7'], ['x', '3'], ['y', '20'], ['z', '100']]);
    const back = new Map(Array.from(rename, ([from, to]) => [to, from]));
    const { graph, options } = GRAPHS.crossing;
    const renamed = Object.assign({}, graph, {
      items: graph.items.map((item) => Object.assign({}, item, { id: rename.get(item.id) })),
      edges: graph.edges.map((edge) => Object.assign({}, edge, {
        id: `${rename.get(edge.source)}→${rename.get(edge.target)}`, source: rename.get(edge.source), target: rename.get(edge.target),
      })),
    });
    const result = Place.rankAndOrder(deepFreeze(renamed), deepFreeze(Object.assign({}, options)));
    const mappedBack = {
      ranks: Object.fromEntries(Object.entries(result.ranks).map(([id, rank]) => [back.get(id), rank])),
      order: { root: result.order.root.map((row) => row.map((id) => back.get(id))) },
      lanes: result.lanes,
      stats: result.stats,
    };
    assert.deepEqual(mappedBack, rankAndOrder('crossing'));
  });

  await t.test('two calls on the same frozen graph agree', () => {
    const { graph, options } = GRAPHS.outsidePartners;
    deepFreeze(graph);
    assert.deepEqual(Place.rankAndOrder(graph, options), Place.rankAndOrder(graph, options));
  });
});

test('ordering six ranks of seven boxes stays within the time ceiling', (t) => {
  // Routing redesign §8: a generous ceiling (median of 3, in a test of its own), far above the expected time, so
  // that it fails only when the order search grows by orders of magnitude (it once took seconds on this graph).
  const CEILING_MS = 1500;
  const { graph, options } = GRAPHS.sevenWideSixRanks;
  deepFreeze(graph);
  const times = [0, 1, 2].map(() => {
    const started = performance.now();
    Place.rankAndOrder(graph, options);
    return performance.now() - started;
  }).sort((a, b) => a - b);
  t.diagnostic(`rankAndOrder on 42 boxes and 70 edges: median ${times[1].toFixed(1)} ms`);
  assert.ok(times[1] < CEILING_MS, `rankAndOrder took ${times[1].toFixed(0)} ms (median of 3); the ceiling is ${CEILING_MS} ms`);
});

// ---- place (routing redesign §4.1, §4.5–§4.7) --------------------------------------------------------------

/** Places a graph of place-graphs.js, frozen, with `extra` options over its own. */
function place(name, extra) {
  const { graph, options } = GRAPHS[name];
  return Place.place(deepFreeze(graph), deepFreeze(Object.assign({}, options, extra)));
}

/**
 * Runs `check(placement, seed)` as one subtest per seed: none, the one recorded from the seed function, and any
 * `more` (`[label, seed]`) a test names.
 */
async function forEachSeed(t, name, check, extra = {}, more = []) {
  const seeds = [['without a seed', null], ['with the recorded seed', SEEDS[name]]].concat(more);
  for (const [label, seed] of seeds) {
    await t.test(label, () => check(place(name, Object.assign({}, extra, { seed })), seed));
  }
}

const centreX = (box) => box.x + box.width / 2;
const centreY = (box) => box.y + box.height / 2;
const xOverlap = (a, b) => Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
const boxesOverlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

function overlappingPairs(boxes) {
  const entries = Object.entries(boxes);
  return entries.flatMap(([a, first], index) => entries.slice(index + 1)
    .filter(([, second]) => boxesOverlap(first, second)).map(([b]) => `${a} × ${b}`));
}

/** Whether the vertical line at `x` from `top` to `bottom` enters `box` inflated by `pad`. */
function verticalLineHits(x, top, bottom, box, pad) {
  return x > box.x - pad && x < box.x + box.width + pad && bottom > box.y - pad && top < box.y + box.height + pad;
}

test('people sit above every other box', (t) => forEachSeed(t, 'peopleWithoutScope', ({ boxes }) => {
  assert.ok(boxes.p.y + boxes.p.height < Math.min(boxes.a.y, boxes.m.y), `p at ${boxes.p.y}, a at ${boxes.a.y}, m at ${boxes.m.y}`);
}));

test('a one-to-one edge shares a centre line', (t) => forEachSeed(t, 'oneToOne', ({ boxes, centreAligned, straightCapable }) => {
  assert.equal(centreX(boxes.a), centreX(boxes.b));
  assert.notEqual(boxes.b.x, boxes.a.x, 'b moved off its left-justified position');
  assert.ok(centreAligned.includes('a→b'), 'the edge is centre-aligned');
  assert.ok(straightCapable.includes('a→b'), 'the edge is straight-capable');
}, {}, [['with an explicit seed', { a: { x: 0, y: 0 }, b: { x: 400, y: 300 } }]]));

test('a fan-out centres its children under the parent and keeps both straight', (t) => forEachSeed(t, 'fanOut', (placement) => {
  const { p, c1, c2 } = placement.boxes;
  assert.ok(xOverlap(p, c1) >= 88, `p and c1 overlap by ${xOverlap(p, c1)}`);
  assert.ok(xOverlap(p, c2) >= 88, `p and c2 overlap by ${xOverlap(p, c2)}`);
  assert.equal(p.x + 150, (c1.x + c2.x + 300) / 2);
  assert.deepEqual(placement.straightCapable.slice().sort(), ['p→c1', 'p→c2']);
  assert.deepEqual(placement.centreAligned, []);
}));

test('two parents share a child: both straight when the gap allows, exactly one when it does not', (t) => forEachSeed(t, 'twoParents', (first, seed) => {
  const { a, b, c } = first.boxes;
  assert.ok(c.x - a.x >= 178 && c.x - a.x <= 212, `c is ${c.x - a.x} right of a`);
  assert.deepEqual(first.straightCapable.slice().sort(), ['a→c', 'b→c']);
  assert.deepEqual(first.centreAligned, []);
  assert.equal(boxesOverlap(a, b), false);

  const gap = first.corridors.find((corridor) => corridor.kind === 'gap' && JSON.stringify(corridor.between) === '["a","b"]');
  assert.ok(gap, 'the gap between a and b is a corridor');
  const widened = place('twoParents', { seed, corridorExtra: new Map([[gap.id, 300]]) });
  const after = widened.boxes;
  assert.equal(after.b.x - (after.a.x + 300), 390);
  assert.equal(widened.straightCapable.length, 1, `straight: ${widened.straightCapable}`);
  const bent = ['a→c', 'b→c'].find((id) => !widened.straightCapable.includes(id));
  assert.ok(xOverlap(after[bent[0]], after.c) < 88, `${bent} still overlaps by ${xOverlap(after[bent[0]], after.c)}`);
  assert.deepEqual(overlappingPairs(after), []);
}));

test('a member aligns with an outside person across its boundary, and the line stays clear', (t) => forEachSeed(t, 'memberBelowPerson', (placement) => {
  const { u, m1, m2 } = placement.boxes;
  const scope = placement.boundaries.s;
  assert.equal(centreX(u), centreX(m2));
  assert.ok(placement.centreAligned.includes('u→m2'), 'u→m2 is centre-aligned');
  assert.equal(verticalLineHits(centreX(u), u.y + u.height, m2.y, m1, 20), false, 'the line from u to m2 passes clear of m1');
  assert.ok(placement.straightCapable.includes('m1→m2'), 'm1→m2 is straight-capable');
  [m1, m2].forEach((member) => {
    assert.ok(member.x - scope.x >= 30 && scope.x + scope.width - member.x - member.width >= 30, 'side padding');
    assert.ok(member.y - scope.y >= 30 && scope.y + scope.height - member.y - member.height >= 30, 'top and bottom padding');
  });
  assert.deepEqual(overlappingPairs(placement.boxes), []);
}, {}, [['with m1 and m2 seeded in one column', GRAPHS.memberBelowPerson.options.seed]]));

test('the container-view shape keeps both lower edges straight and clear', (t) => forEachSeed(t, 'containerView', (placement) => {
  const { api, db, billing } = placement.boxes;
  assert.ok(placement.straightCapable.includes('api→db'), 'api→db is straight-capable');
  assert.ok(placement.straightCapable.includes('api→billing'), 'api→billing is straight-capable');
  const line = placement.labelSlots['api→billing'].cross;
  assert.ok(line <= db.x - 20 || line >= db.x + db.width + 20, `the planned line at ${line} is within 20 of db [${db.x}, ${db.x + db.width}]`);
  assert.equal(verticalLineHits(line, api.y + api.height, billing.y, db, 20), false, 'the line from api to billing passes clear of db');
}));

test('a fan-out plans its labels on opposite sides and budgets one level', (t) => forEachSeed(t, 'labelledFanOut', (placement) => {
  const { p, c1, c2 } = placement.boxes;
  const [left, right] = c1.x < c2.x ? ['p→c1', 'p→c2'] : ['p→c2', 'p→c1'];
  assert.equal(placement.labelSlots[left].position, 'before');
  assert.equal(placement.labelSlots[right].position, 'after');
  // One label level (86 + 8), no jog track, the tail and head stubs (18 + 30), plus at most one track pitch.
  const gap = Math.min(c1.y, c2.y) - (p.y + p.height);
  assert.ok(gap >= 142 && gap <= 166, `the corridor below p is ${gap} deep`);
}));

test('a child added to a fan-out leaves the parent where it was', async (t) => {
  // The first box of the outer level's first rank anchors the drawing (§4.5), so an addition below it moves only
  // the boxes that make room for it.
  for (const [label, three] of [['without a seed', null], ['with the recorded seeds', SEEDS.fanOutOfThree]]) {
    await t.test(label, () => {
      const before = place('fanOut', { seed: three && SEEDS.fanOut }).boxes.p;
      const after = place('fanOutOfThree', { seed: three }).boxes.p;
      assert.deepEqual([after.x, after.y], [before.x, before.y]);
    });
  }
});

test('a label planned on its segment keeps the foreign-route clearance to the other planned lines', (t) => forEachSeed(t, 'labelledFanOutOfThree', ({ labelSlots }) => {
  // The middle label sits on its line; half of its 600 width plus 12 of clearance is 312 to each neighbouring line.
  assert.deepEqual(['p→c1', 'p→c2', 'p→c3'].map((id) => labelSlots[id].position), ['before', 'on', 'after']);
  const gaps = [labelSlots['p→c2'].cross - labelSlots['p→c1'].cross, labelSlots['p→c3'].cross - labelSlots['p→c2'].cross];
  assert.ok(gaps.every((gap) => gap >= 312), `the planned lines are ${gaps} apart`);
}));

test('a label beside its segment keeps clear of the channel a lane reserves outward of it', () => {
  // Without a seed, rank 1 is ordered c1, c2, the lane of x→B, w (the recorded seed gives w a rank of its own). The
  // lane's route runs at least laneClearance (32) plus half a track (12) left of w; the label beside p→c2 (400
  // wide, 6 from its segment) must end 12 short of that route.
  const { boxes, labelSlots, order } = place('labelBesideReservedChannel');
  assert.deepEqual(order.root[1], ['c1', 'c2', 'lane:x→B:root:1', 'w']);
  const slot = labelSlots['p→c2'];
  assert.equal(slot.position, 'after');
  const labelEnd = slot.cross + 6 + 400;
  assert.ok(labelEnd + 12 <= boxes.w.x - 32 - 12, `the label ends at ${labelEnd}, w starts at ${boxes.w.x}`);
});

// A boundary's label never widens it for the edges that leave through its label line: the renderer moves the label
// clear of them instead (Ruling 16). reg's 500-wide label is wider than its members (368), so reg is exactly as
// wide as the label and the padding on either side (500 + 2 · 30), wherever api→billing leaves it.
const LONG_LABEL_BOUNDARY_WIDTH = 500 + 2 * 30;

test('a segment leaving a boundary through its label line stays straight without widening the boundary', (t) => forEachSeed(t, 'containerViewWithLongBoundaryLabel', (placement) => {
  assert.ok(placement.straightCapable.includes('api→billing'), 'api→billing is straight-capable');
  assert.equal(placement.boundaries.reg.width, LONG_LABEL_BOUNDARY_WIDTH, 'reg is as wide as its label needs');
}));

test('an edge whose straight band another box blocks is not straight-capable', (t) => forEachSeed(t, 'pinnedInLine', (placement) => {
  assert.deepEqual(placement.straightCapable, [], 'b sits between a and c');
  const aside = place('pinnedInLine', { seed: null, pins: new Map([['a', [0, 0]], ['b', [600, 230]], ['c', [0, 460]]]) });
  assert.deepEqual(aside.straightCapable, ['a→c'], 'with b moved aside the line is clear');
}));

/**
 * The cross coordinates where a vertical from `source` to `target` runs inside the window of one of them (24 from its
 * corners) and keeps the 20-unit box clearance from every other box: the monotone channel a route with one jog needs.
 */
function channelsBetween(boxes, source, target) {
  const top = boxes[source].y + boxes[source].height;
  const bottom = boxes[target].y;
  const others = Object.keys(boxes).filter((id) => id !== source && id !== target);
  return [source, target].flatMap((end) => {
    const xs = [];
    for (let x = boxes[end].x + 24; x <= boxes[end].x + boxes[end].width - 24; x++) xs.push(x);
    return xs;
  }).filter((x) => others.every((id) => !verticalLineHits(x, top, bottom, boxes[id], 20)));
}

test('a long edge beside a chain keeps a channel inside one end box', (t) => forEachSeed(t, 'longEdgeBesideChain', ({ boxes, ranks }) => {
  assert.equal(ranks.i - ranks.l, 3, 'l → i spans two intermediate ranks');
  assert.notDeepEqual(channelsBetween(boxes, 'l', 'i'), [], `no channel past r and s: ${JSON.stringify(boxes)}`);
  assert.deepEqual(overlappingPairs(boxes), []);
}));

test('a long edge keeps its channel clear of a box that answers its source', (t) => forEachSeed(t, 'longEdgePastAnswer', ({ boxes, ranks }) => {
  assert.deepEqual([ranks.u, ranks.m, ranks.t], [0, 1, 2]);
  assert.notDeepEqual(channelsBetween(boxes, 'u', 't'), [], `no channel past m: ${JSON.stringify(boxes)}`);
  assert.deepEqual(overlappingPairs(boxes), []);
}));

test('extra room in a corridor moves only the ranks after it', (t) => forEachSeed(t, 'chain', (first, seed) => {
  const pin = [first.boxes.c.x, first.boxes.c.y];
  const grown = place('chain', { seed, pins: new Map([['c', pin]]), corridorExtra: new Map([['root|main|0', 100]]) });
  const { a, b, c } = grown.boxes;
  assert.deepEqual([a.x, a.y], [first.boxes.a.x, first.boxes.a.y], 'a did not move');
  // c keeps its pin; b moves by the extra room unless that brings it within the 20-unit box clearance of c, and then
  // it makes room for c and stops just above it.
  assert.deepEqual([c.x, c.y, c.pinAdjusted], pin.concat([false]), 'the pinned box keeps its pin');
  const crowded = pin[1] < first.boxes.b.y + 100 + b.height + 20;
  assert.equal(b.y, crowded ? pin[1] - 20 - b.height : first.boxes.b.y + 100);
}));

test('a pin moves its own box and leaves its partner where the placement without pins put it', (t) => forEachSeed(t, 'pinnedPartner', ({ boxes }, seed) => {
  const free = place('pinnedPartner', { seed, pins: null });
  assert.deepEqual([boxes.b.x, boxes.b.y], [700, 400]);
  assert.equal(boxes.b.pinAdjusted, false);
  assert.deepEqual([boxes.a.x, boxes.a.y], [free.boxes.a.x, free.boxes.a.y], 'a stays where it was drawn');
}));

/**
 * Spec §9.2 (a drop re-routes, it never re-ranks): a box at the outer level pinned past the right end of the
 * drawing, so it overlaps nothing, moves alone. Every other box and boundary keeps the place the placement without
 * pins gave it, whichever way the view flows.
 */
for (const direction of ['down', 'right']) {
  test(`a box pinned clear of the drawing moves alone (${direction})`, async (t) => {
    const names = Object.keys(GRAPHS).filter((name) => !GRAPHS[name].options.pins && name !== 'sevenWideSixRanks');
    for (const name of names) {
      await t.test(name, () => {
        const free = place(name, { direction });
        const outer = Object.keys(free.boxes).filter((id) => !GRAPHS[name].graph.items.find((item) => item.id === id).parent);
        const rects = Object.values(free.boxes).concat(Object.values(free.boundaries));
        const beyond = Math.max(...rects.map((rect) => rect.x + rect.width)) + 400;
        outer.forEach((id) => {
          const pin = [beyond, free.boxes[id].y + 50];
          const { boxes, boundaries } = place(name, { direction, pins: new Map([[id, pin]]) });
          assert.deepEqual([boxes[id].x, boxes[id].y, boxes[id].pinAdjusted], pin.concat([false]), `${id} is at its pin`);
          Object.keys(free.boxes).filter((other) => other !== id).forEach((other) => {
            assert.deepEqual([boxes[other].x, boxes[other].y], [free.boxes[other].x, free.boxes[other].y], `pinning ${id} moved ${other}`);
          });
          assert.deepEqual(boundaries, free.boundaries, `pinning ${id} moved a boundary`);
        });
      });
    }
  });
}

/**
 * Spec §9.2 (a drop lands where it is dropped): a box pinned onto an unpinned one stays on its pin, and the box it
 * overlaps makes room, upward when the pin lies on its lower part and downward when it lies on its upper part; a box
 * that makes room pushes the next one the same way. The chain stacks a, b, c 300 × 120 with the 20-unit clearance.
 */
const CLEARANCE = 20;

test('a box pinned onto the lower part of another stays on its pin, and the other makes room above it', () => {
  const free = place('chain', { seed: null, pins: null });
  // b's top moves above a's clearance, so a makes room for b in turn.
  const pin = [free.boxes.b.x + 40, free.boxes.b.y + 30];
  const { boxes } = place('chain', { seed: null, pins: new Map([['c', pin]]) });
  assert.deepEqual([boxes.c.x, boxes.c.y, boxes.c.pinAdjusted], pin.concat([false]), 'c is on its pin');
  assert.deepEqual([boxes.b.x, boxes.b.y], [free.boxes.b.x, pin[1] - CLEARANCE - free.boxes.b.height], 'b moves up just clear of c');
  assert.deepEqual([boxes.a.x, boxes.a.y], [free.boxes.a.x, boxes.b.y - CLEARANCE - free.boxes.a.height], 'a moves up just clear of b');
  assert.deepEqual(overlappingPairs(boxes), []);
  assert.deepEqual(['a', 'b', 'c'].map((id) => boxes[id].madeRoom), [true, true, false], 'a and b are marked as having made room');
});

/**
 * What a placement marks as having made room for a pin (`madeRoom`, which the editor names in its announcement): only
 * a box the settle step moved off the place the placement gave it. A pin that overlaps nothing marks none.
 */
test('a pin that overlaps nothing marks no box as having made room', () => {
  const free = place('chain', { seed: null, pins: null });
  const right = Math.max(...Object.values(free.boxes).map((box) => box.x + box.width)) + 400;
  const { boxes } = place('chain', { seed: null, pins: new Map([['b', [right, free.boxes.b.y]]]) });
  assert.deepEqual(Object.keys(boxes).filter((id) => boxes[id].madeRoom), []);
  assert.deepEqual(Object.keys(free.boxes).filter((id) => free.boxes[id].madeRoom), [], 'without pins no box makes room');
});

test('a box pinned onto the upper part of another stays on its pin, and the other makes room below it', () => {
  const free = place('chain', { seed: null, pins: null });
  const pin = [free.boxes.b.x + 40, free.boxes.b.y - 30];
  const { boxes } = place('chain', { seed: null, pins: new Map([['a', pin]]) });
  assert.deepEqual([boxes.a.x, boxes.a.y, boxes.a.pinAdjusted], pin.concat([false]), 'a is on its pin');
  assert.deepEqual([boxes.b.x, boxes.b.y], [free.boxes.b.x, pin[1] + free.boxes.a.height + CLEARANCE], 'b moves down just clear of a');
  assert.deepEqual([boxes.c.x, boxes.c.y], [free.boxes.c.x, boxes.b.y + free.boxes.b.height + CLEARANCE], 'c moves down just clear of b');
  assert.deepEqual(overlappingPairs(boxes), []);
});

test('a box pinned onto a box inside a boundary moves the boundary\'s parts, and the boundary grows to hold them', () => {
  const free = place('containerView', { seed: null, pins: null });
  const pin = [free.boxes.api.x + 40, free.boxes.api.y + 60];
  const { boxes, boundaries } = place('containerView', { seed: null, pins: new Map([['db', pin]]) });
  assert.deepEqual([boxes.db.x, boxes.db.y, boxes.db.pinAdjusted], pin.concat([false]), 'db is on its pin');
  assert.ok(boxes.api.y + boxes.api.height + CLEARANCE <= pin[1], 'api makes room above db');
  assert.deepEqual(overlappingPairs(boxes), []);
  ['web', 'api', 'db'].forEach((id) => {
    const box = boxes[id];
    const reg = boundaries.reg;
    assert.ok(box.x >= reg.x && box.y >= reg.y && box.x + box.width <= reg.x + reg.width && box.y + box.height <= reg.y + reg.height,
      `the boundary holds ${id}`);
  });
});

test('a box pinned on the far side of a rank-mate lands on its pin and settles without error', (t) => forEachSeed(t, 'pinned', ({ boxes }) => {
  assert.deepEqual([boxes.b.x, boxes.b.y], [-400, 0]);
  assert.deepEqual(overlappingPairs(boxes), []);
}));

test('a box pinned onto another settles just below it and is marked pin adjusted', (t) => forEachSeed(t, 'overlappingPins', ({ boxes }) => {
  assert.deepEqual([boxes.a.x, boxes.a.y], [0, 0]);
  assert.equal(boxes.a.pinAdjusted, false);
  assert.deepEqual([boxes.b.x, boxes.b.y], [100, boxes.a.height + 20], 'b keeps its pin across the flow and moves below a by the box clearance');
  assert.equal(boxes.b.pinAdjusted, true, 'the settled box had to leave its pin');
  assert.deepEqual(overlappingPairs(boxes), []);
}));

/**
 * Metamorphic relation of pins: a pin where the placement already put a box (what an editor records when a drag
 * ends where it started) changes nothing: no box, boundary, rank, order, corridor, label slot, or edge class (only
 * the diagnostic `stats` and `pinnedCorridors`, which names the corridors the pin keeps from growing, may differ).
 * Every graph without pins of its own runs with no seed and with its recorded seed; the 42-box timing graph is left
 * out (see the todo test below).
 */
const withoutPinDiagnostics = (placement) => Object.assign({}, placement, { stats: undefined, pinnedCorridors: undefined });

function pinningInPlaceChangesNothing(direction) {
  return async (t) => {
    const names = Object.keys(GRAPHS).filter((name) => !GRAPHS[name].options.pins && name !== 'sevenWideSixRanks');
    const withoutStats = withoutPinDiagnostics;
    for (const name of names) {
      for (const [label, seed] of [['without a seed', null], ['with the recorded seed', SEEDS[name]]]) {
        await t.test(`${name}, ${label}`, () => {
          const free = place(name, { seed, direction });
          Object.entries(free.boxes).forEach(([id, box]) => {
            const pinned = place(name, { seed, direction, pins: new Map([[id, [box.x, box.y]]]) });
            assert.deepEqual(withoutStats(pinned), withoutStats(free), `pinning ${id} at (${box.x}, ${box.y}) changed the placement`);
          });
        });
      }
    }
  };
}

test('pinning a box where the placement put it changes nothing', pinningInPlaceChangesNothing('down'));

test('pinning a box where a placement to the right put it changes nothing', pinningInPlaceChangesNothing('right'));

// A former pinned placement pass re-measured each alignment's stretch on a drawing the pin had already widened, so on
// this graph a box pinned where it was moved 32 of 42 boxes (down) or 29 (right). Pins now never enter placement.
test('pinning a box of the 42-box graph where the placement put it changes nothing', () => {
  for (const [direction, id] of [['down', 'r0c0'], ['right', 'r2c0']]) {
    const free = place('sevenWideSixRanks', { direction });
    const box = free.boxes[id];
    const pinned = place('sevenWideSixRanks', { direction, pins: new Map([[id, [box.x, box.y]]]) });
    assert.deepEqual(withoutPinDiagnostics(pinned), withoutPinDiagnostics(free), `pinning ${id} in place (${direction}) changed the placement`);
  }
});

/**
 * Where every corridor of a placement lies according to its final boxes (routing redesign §3.2): a rank corridor
 * (`${level}|main|${r}`) from the far end of rank r's boxes, or the boundary's start for r = −1, to the near end of
 * rank r + 1's boxes, or the boundary's end after the last rank; a gap corridor from its box before to its box after,
 * across the flow. A corridor that a moved box closed has no extent. Lane channels have no box. `[id, from, to]`.
 */
function corridorsOfFinalBoxes(placement, direction) {
  const flow = direction === 'right' ? 'x' : 'y';
  const across = flow === 'x' ? 'y' : 'x';
  const boxOf = (id) => placement.boxes[id] || placement.boundaries[id];
  const range = (id, axis) => [boxOf(id)[axis], boxOf(id)[axis] + boxOf(id)[axis === 'x' ? 'width' : 'height']];
  return placement.corridors.map((corridor) => {
    let from;
    let to;
    if (corridor.kind === 'gap') {
      from = range(corridor.between[0], across)[1];
      to = range(corridor.between[1], across)[0];
    } else {
      const rank = Number(corridor.id.split('|')[2]);
      const rows = placement.order[corridor.level].map((row) => row.filter(boxOf));
      from = rank === -1 ? range(corridor.level, flow)[0] : Math.max(...rows[rank].map((id) => range(id, flow)[1]));
      to = rank === rows.length - 1 ? range(corridor.level, flow)[1] : Math.min(...rows[rank + 1].map((id) => range(id, flow)[0]));
    }
    return [corridor.id, from, Math.max(from, to)];
  });
}

const corridorEnds = (placement) => placement.corridors.map((corridor) => [corridor.id, corridor.from, corridor.to]);

for (const direction of ['down', 'right']) {
  test(`corridors follow a box dragged off its rank and the boundary it grows (${direction})`, (t) => forEachSeed(t, 'containerViewWithLongBoundaryLabel', (free, seed) => {
    // db is dragged 100 along the flow, out of its rank's band, so the settle step grows reg around it.
    const db = free.boxes.db;
    const shifted = direction === 'right' ? [db.x + 100, db.y] : [db.x, db.y + 100];
    const pinned = place('containerViewWithLongBoundaryLabel', { seed, direction, pins: new Map([['db', shifted]]) });
    assert.deepEqual([pinned.boxes.db.x, pinned.boxes.db.y], shifted, 'precondition: db is at its pin');
    assert.notDeepEqual(corridorEnds(pinned), corridorEnds(free), 'precondition: the drag moved some corridor');
    assert.deepEqual(corridorEnds(pinned), corridorsOfFinalBoxes(pinned, direction));
  }, { direction }));

  test(`corridors follow a box the settle step moved off its pin (${direction})`, (t) => forEachSeed(t, 'overlappingPins', (placement) => {
    assert.equal(placement.boxes.b.pinAdjusted, true, 'precondition: b was settled off its pin');
    assert.deepEqual(corridorEnds(placement), corridorsOfFinalBoxes(placement, direction));
  }, { direction }));

  test(`placement names the corridors a pin keeps from growing: those the pinned box starts at or after (${direction})`, (t) => forEachSeed(t, 'containerViewWithLongBoundaryLabel', (free, seed) => {
    assert.deepEqual(free.pinnedCorridors, [], 'without pins every corridor may grow');
    const db = free.boxes.db;
    const pinned = place('containerViewWithLongBoundaryLabel', { seed, direction, pins: new Map([['db', [db.x, db.y]]]) });
    const flow = direction === 'right' ? 'x' : 'y';
    const across = flow === 'x' ? 'y' : 'x';
    const expected = pinned.corridors.filter((corridor) => pinned.boxes.db[corridor.axis === 'main' ? flow : across] >= corridor.from)
      .map((corridor) => corridor.id);
    assert.ok(expected.length > 0 && expected.length < pinned.corridors.length, `precondition: db lies after ${expected.length} of ${pinned.corridors.length} corridors`);
    assert.deepEqual(pinned.pinnedCorridors.slice().sort(), expected.sort());
  }, { direction }));
}

test('a gap corridor closed by a box settled off its pin has no extent', () => {
  // Without a seed, a and b share a rank with a gap corridor between them. b, pinned onto a, settles below a: the two
  // no longer sit side by side across the flow. (The recorded seed ranks b below a, so no gap lies between them.)
  const placement = place('overlappingPins', { seed: null });
  const { a, b } = placement.boxes;
  assert.ok(b.y >= a.y + a.height, `precondition: b (y ${b.y}) is below a`);
  const gap = placement.corridors.find((corridor) => corridor.kind === 'gap');
  assert.deepEqual(gap.between, ['a', 'b'], 'precondition: the placement put a gap corridor between a and b');
  assert.equal(gap.to, gap.from, `the gap between ${gap.between} is closed`);
});

test('a pinned member keeps a segment leaving through its boundary label line straight without widening the boundary', (t) => forEachSeed(t, 'containerViewWithLongBoundaryLabel', (free, seed) => {
  // db is dragged 100 down its own column, so the settle step runs and grows reg from its placed box.
  const db = free.boxes.db;
  const placement = place('containerViewWithLongBoundaryLabel', { seed, pins: new Map([['db', [db.x, db.y + 100]]]) });
  assert.deepEqual([placement.boxes.db.x, placement.boxes.db.y], [db.x, db.y + 100], 'db is at its pin');
  assert.ok(placement.straightCapable.includes('api→billing'), 'api→billing is straight-capable');
  assert.equal(placement.boundaries.reg.width, LONG_LABEL_BOUNDARY_WIDTH, 'reg is as wide as its label needs');
}));

/**
 * The chapter's university landscape (final review I3): people inside the enterprise boundary, and the Student's
 * edge to the Learning Management System leaving it past Course Registration. The seed (the renderer's for that
 * figure) starts the edge's lane items right of Course Registration, where its edge to Student Records crosses them;
 * a row search moves one lane at a time and stays there. Moving the whole lane chain to the start of its rows removes
 * the crossing.
 */
test('a long edge that leaves a boundary moves with all its lane items to a crossing-free place', () => {
  const inside = { parent: 'e' };
  const landscape = graph(
    [person('student', inside), person('adviser', inside), person('registrar', inside), element('registration', inside),
      element('records', inside), element('audit', inside), element('billing', inside), element('lms', { external: true })],
    [edge('student', 'registration'), edge('student', 'lms'), edge('adviser', 'audit'), edge('registrar', 'records'),
      edge('registration', 'records'), edge('registration', 'billing'), edge('registration', 'lms'), edge('audit', 'records')],
    { boundaries: [{ id: 'e', parent: null, kind: 'enterprise', labelWidth: 160, labelHeight: 26 }] });
  const seed = {
    student: { x: 225, y: 30 }, adviser: { x: 661, y: 30 }, registrar: { x: 1051, y: 30 }, registration: { x: 179, y: 369 },
    records: { x: 810, y: 662 }, audit: { x: 661, y: 369 }, billing: { x: 30, y: 662 }, lms: { x: 540.5, y: 1011 },
  };
  const { order, stats } = Place.place(deepFreeze(landscape), deepFreeze(options({ seed })));
  assert.equal(stats.layerCrossings, 0);
  assert.deepEqual([order.e[1][0], order.e[2][0]], ['lane:student→lms:e:1', 'lane:student→lms:e:2'], 'the lane chain leads both rows');
});

test('a boundary holds its members with its padding and no more across the flow', async (t) => {
  // Neither boundary has a label or a member that takes side ends, so each keeps exactly 30 beside its members.
  for (const [name, boundaryId, members] of [['labelBesideReservedChannel', 'B', ['m']], ['memberBelowPerson', 's', ['m1', 'm2']]]) {
    await forEachSeed(t, name, ({ boxes, boundaries }) => {
      const left = Math.min(...members.map((id) => boxes[id].x));
      const right = Math.max(...members.map((id) => boxes[id].x + boxes[id].width));
      const boundary = boundaries[boundaryId];
      assert.deepEqual([boundary.x, boundary.x + boundary.width], [left - 30, right + 30], `${boundaryId} around ${members}`);
    });
  }
});

test('direction right turns the flow sideways', async (t) => {
  await forEachSeed(t, 'peopleWithoutScope', ({ boxes }) => {
    assert.ok(boxes.p.x + boxes.p.width < Math.min(boxes.a.x, boxes.m.x), 'the person is left of everything else');
    assert.equal(centreY(boxes.p), centreY(boxes.a), 'p→a runs on one horizontal line');
  }, { direction: 'right' });
  await t.test('the boundary label adds to the cross extent', () => {
    const { boxes, boundaries } = place('scopeWithLongLabel', { direction: 'right' });
    const label = GRAPHS.scopeWithLongLabel.graph.boundaries[0];
    assert.ok(boundaries.s.width >= label.labelWidth, `the scope is ${boundaries.s.width} wide`);
    assert.ok(boundaries.s.height >= boxes.m.height + 2 * 30 + label.labelHeight, `the scope is ${boundaries.s.height} high`);
  });
});

test('frameExtents puts the boundary label after the members on the flow axis down and across it to the right', () => {
  const inner = { main: 400, cross: 300 };
  assert.deepEqual(Place.frameExtents(inner, 420, 26, 'down'), { mainBefore: 30, mainAfter: 56, crossBefore: 30, crossAfter: 150 });
  assert.deepEqual(Place.frameExtents(inner, 420, 26, 'right'), { mainBefore: 30, mainAfter: 50, crossBefore: 30, crossAfter: 56 });
  assert.deepEqual(Place.frameExtents(inner, 200, 26, 'right'), { mainBefore: 30, mainAfter: 30, crossBefore: 30, crossAfter: 56 });
});

test('placement ignores object key order and id spelling', async (t) => {
  await t.test('numeric-looking ids keep view-model order', () => {
    const { boxes } = place('numericIds');
    assert.ok(boxes['10'].x < boxes['2'].x, `10 at ${boxes['10'].x}, 2 at ${boxes['2'].x}`);
  });

  await t.test('renaming every id against lexical order changes no coordinate', () => {
    const rename = new Map([['student', 'z9'], ['web', '3'], ['api', '20'], ['db', '100'], ['billing', 'a1'], ['reg', '7']]);
    const back = new Map(Array.from(rename, ([from, to]) => [to, from]));
    const { graph, options } = GRAPHS.containerView;
    const renamed = Object.assign({}, graph, {
      items: graph.items.map((item) => Object.assign({}, item, { id: rename.get(item.id), parent: item.parent && rename.get(item.parent) })),
      boundaries: graph.boundaries.map((boundary) => Object.assign({}, boundary, { id: rename.get(boundary.id) })),
      edges: graph.edges.map((edge) => Object.assign({}, edge, {
        id: `${rename.get(edge.source)}→${rename.get(edge.target)}`, source: rename.get(edge.source), target: rename.get(edge.target),
      })),
      scopeId: rename.get(graph.scopeId),
    });
    const result = Place.place(deepFreeze(renamed), deepFreeze(Object.assign({}, options)));
    const original = place('containerView');
    const mapBack = (boxes) => Object.fromEntries(Object.entries(boxes).map(([id, box]) => [back.get(id), box]));
    assert.deepEqual(mapBack(result.boxes), original.boxes);
    assert.deepEqual(mapBack(result.boundaries), original.boundaries);
  });

  await t.test('two calls on the same frozen graph agree', () => {
    assert.deepEqual(place('containerView'), place('containerView'));
  });
});

test('every coordinate of a placement is an integer', () => {
  Object.keys(GRAPHS).filter((name) => !name.startsWith('sevenWide')).forEach((name) => {
    const placement = place(name);
    const values = Object.values(placement.boxes).concat(Object.values(placement.boundaries))
      .flatMap((box) => [box.x, box.y, box.width, box.height]);
    assert.ok(values.every(Number.isInteger), `${name}: ${values.filter((value) => !Number.isInteger(value))}`);
  });
});

/** The placement scripts (`c4-place*.js`) of the manifest's `render` list, in load order. */
const PLACEMENT_FILES = JSON.parse(fs.readFileSync(path.join(__dirname, '../../c4/manifest.json'), 'utf8')).render
  .filter((file) => /^c4\/c4-place[^/]*\.js$/.test(file));

/** A classic-script context in which only the placement scripts ran, in order. */
function placementContext() {
  const context = vm.createContext({});
  context.self = context;
  PLACEMENT_FILES.forEach((file) => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../..', file), 'utf8'), context, { filename: file });
  });
  return context;
}

test('c4-place.js loads without the bundle', () => {
  const context = placementContext();
  assert.equal(vm.runInContext('typeof ArchUMLC4Place.rankAndOrder', context), 'function');
  assert.equal(vm.runInContext('typeof ArchUMLC4Place.place', context), 'function');
});

test('placement loaded as classic scripts places and ranks every graph as the Node module does', () => {
  const classic = placementContext().ArchUMLC4Place;
  const plain = (value) => JSON.parse(JSON.stringify(value));
  Object.keys(GRAPHS).filter((name) => !name.startsWith('sevenWide')).forEach((name) => {
    const { graph, options } = GRAPHS[name];
    const withSeed = Object.assign({}, options, { seed: SEEDS[name] });
    assert.deepEqual(plain(classic.place(graph, withSeed)), plain(Place.place(graph, withSeed)), `${name}: place`);
    assert.deepEqual(plain(classic.rankAndOrder(graph, withSeed)), plain(Place.rankAndOrder(graph, withSeed)), `${name}: rankAndOrder`);
  });
  assert.deepEqual(plain(classic.CFG), plain(Place.CFG));
  assert.deepEqual(plain(classic.frameExtents({ main: 100, cross: 40 }, 60, 26, 'right')), plain(Place.frameExtents({ main: 100, cross: 40 }, 60, 26, 'right')));
});
