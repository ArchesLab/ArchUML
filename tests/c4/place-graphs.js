'use strict';

// Placement test graphs as plain data (routing redesign §3.2 `graph` and `options`), shared by place.test.js and
// the seed recorder of Task 8b-2. Boxes are 300 × 120 and edges unlabelled (0 × 0) unless a graph says otherwise.

const BOX_WIDTH = 300;
const BOX_HEIGHT = 120;

function element(id, extra) {
  return Object.assign({ id: id, width: BOX_WIDTH, height: BOX_HEIGHT, parent: null, role: 'element', external: false }, extra);
}

function person(id, extra) {
  return element(id, Object.assign({ role: 'person' }, extra));
}

/** An unlabelled relationship whose id is `source→target`. */
function edge(source, target) {
  return { id: source + '→' + target, source: source, target: target, labelWidth: 0, labelHeight: 0 };
}

/** A relationship whose label is `labelWidth` × `labelHeight`. */
function labelledEdge(source, target, labelWidth, labelHeight) {
  return Object.assign(edge(source, target), { labelWidth: labelWidth, labelHeight: labelHeight });
}

function scope(id, extra) {
  return Object.assign({ id: id, parent: null, kind: 'scope', labelWidth: 0, labelHeight: 0 }, extra);
}

function graph(items, edges, extra) {
  return Object.assign({ items: items, boundaries: [], edges: edges, scopeId: null }, extra);
}

/**
 * `rankCount` ranks of seven boxes. Box `c` of a rank links to boxes `(3c + 1) mod 7` and `(2c + 3) mod 7` of the
 * next rank, so every rank holds seven movable boxes (the largest row the order search tries exhaustively) and the
 * orders differ in their crossings.
 */
function sevenWideRanks(rankCount) {
  const id = (rank, column) => `r${rank}c${column}`;
  const items = [];
  const edges = [];
  for (let rank = 0; rank < rankCount; rank++) {
    for (let column = 0; column < 7; column++) {
      items.push(element(id(rank, column)));
      if (rank + 1 < rankCount) {
        edges.push(edge(id(rank, column), id(rank + 1, (3 * column + 1) % 7)), edge(id(rank, column), id(rank + 1, (2 * column + 3) % 7)));
      }
    }
  }
  return graph(items, edges);
}

const OPTIONS = { direction: 'down', seed: null, pins: null, corridorExtra: null };

function options(extra) {
  return Object.assign({}, OPTIONS, extra);
}

const GRAPHS = {
  peopleWithoutScope: {
    graph: graph([person('p'), element('a'), element('m')], [edge('p', 'a'), edge('m', 'p')]),
    options: options(),
  },
  personBesideLoneElement: {
    graph: graph([person('p'), element('e')], []),
    options: options(),
  },
  sourceWithoutIncomingEdge: {
    graph: graph(['a', 'b', 'c', 'd'].map((id) => element(id)), [edge('a', 'b'), edge('b', 'c'), edge('d', 'c')]),
    options: options(),
  },
  longEdge: {
    graph: graph(['a', 'b', 'c'].map((id) => element(id)), [edge('a', 'b'), edge('b', 'c'), edge('a', 'c')]),
    options: options(),
  },
  laneAmongBoxes: {
    graph: graph([person('a'), person('d'), element('x'), element('y'), element('c')],
      [edge('a', 'c'), edge('d', 'x'), edge('d', 'y'), edge('x', 'c')]),
    options: options(),
  },
  crossing: {
    graph: graph(['a', 'b', 'c', 'x', 'y', 'z'].map((id) => element(id)), [edge('a', 'z'), edge('b', 'y'), edge('c', 'x')]),
    options: options(),
  },
  fanOutWithSeed: {
    graph: graph([element('p'), element('x'), element('y'), element('z')], [edge('p', 'x'), edge('p', 'y'), edge('p', 'z')]),
    options: options({ seed: { p: { x: 390, y: 0 }, z: { x: 0, y: 300 }, x: { x: 390, y: 300 }, y: { x: 780, y: 300 } } }),
  },
  partnerBesideTwoLoners: {
    graph: graph([element('p'), element('x'), element('y'), element('z')], [edge('p', 'x')]),
    options: options({ seed: { p: { x: 390, y: 0 }, x: { x: 0, y: 300 }, y: { x: 390, y: 300 }, z: { x: 780, y: 300 } } }),
  },
  outsidePartners: {
    graph: graph(
      [element('m1', { parent: 's' }), element('m2', { parent: 's' }), person('u1'), person('u2')],
      [edge('u1', 'm2'), edge('u2', 'm1')],
      { boundaries: [{ id: 's', parent: null, kind: 'scope', labelWidth: 0, labelHeight: 0 }], scopeId: 's' }),
    options: options(),
  },
  pinned: {
    graph: graph([element('a'), element('b')], []),
    options: options({ pins: new Map([['b', [-400, 0]]]) }),
  },
  numericIds: {
    graph: graph([element('10'), element('2')], []),
    options: options(),
  },
  sevenWideTwoRanks: {
    graph: sevenWideRanks(2),
    options: options(),
  },
  sevenWideSixRanks: {
    graph: sevenWideRanks(6),
    options: options(),
  },
  oneToOne: {
    graph: graph([element('a'), element('b', { width: 180 })], [edge('a', 'b')]),
    options: options(),
  },
  fanOut: {
    graph: graph(['p', 'c1', 'c2'].map((id) => element(id)), [edge('p', 'c1'), edge('p', 'c2')]),
    options: options(),
  },
  twoParents: {
    graph: graph(['a', 'b', 'c'].map((id) => element(id)), [edge('a', 'c'), edge('b', 'c')]),
    options: options(),
  },
  memberBelowPerson: {
    graph: graph(
      [person('u', { width: 200 }), element('m1', { parent: 's' }), element('m2', { parent: 's' })],
      [edge('u', 'm2'), edge('m1', 'm2')],
      { boundaries: [scope('s')], scopeId: 's' }),
    options: options({ seed: { u: { x: 0, y: 0 }, m1: { x: 0, y: 300 }, m2: { x: 0, y: 600 } } }),
  },
  containerView: {
    graph: graph(
      [person('student'), element('web', { parent: 'reg' }), element('api', { parent: 'reg' }), element('db', { parent: 'reg' }),
        element('billing', { external: true })],
      [labelledEdge('student', 'web', 308, 86), labelledEdge('web', 'api', 308, 86), labelledEdge('api', 'db', 308, 86),
        labelledEdge('api', 'billing', 308, 86)],
      { boundaries: [scope('reg')], scopeId: 'reg' }),
    options: options(),
  },
  labelledFanOut: {
    graph: graph(['p', 'c1', 'c2'].map((id) => element(id)), [labelledEdge('p', 'c1', 308, 86), labelledEdge('p', 'c2', 308, 86)]),
    options: options(),
  },
  chain: {
    graph: graph(['a', 'b', 'c'].map((id) => element(id)), [edge('a', 'b'), edge('b', 'c')]),
    options: options(),
  },
  pinnedPartner: {
    graph: graph([element('a'), element('b')], [edge('a', 'b')]),
    options: options({ pins: new Map([['b', [700, 400]]]) }),
  },
  overlappingPins: {
    graph: graph([element('a'), element('b')], []),
    options: options({ pins: new Map([['a', [0, 0]], ['b', [100, 0]]]) }),
  },
  fanOutOfThree: {
    graph: graph(['p', 'c1', 'c2', 'c3'].map((id) => element(id)), [edge('p', 'c1'), edge('p', 'c2'), edge('p', 'c3')]),
    options: options(),
  },
  labelledFanOutOfThree: {
    // A wide parent over three narrow children: all three edges can be straight, and the middle label sits on its line.
    graph: graph([element('p', { width: 900 })].concat(['c1', 'c2', 'c3'].map((id) => element(id, { width: 120 }))),
      [labelledEdge('p', 'c1', 600, 60), labelledEdge('p', 'c2', 600, 60), labelledEdge('p', 'c3', 600, 60)]),
    options: options(),
  },
  labelBesideReservedChannel: {
    // x's only relationship lands on the group B, so it gets no alignment request; its lane item in rank 1 reserves a
    // channel between c2 and w.
    graph: graph(
      [person('p'), person('x'), element('c1'), element('c2'), element('w'), element('m', { parent: 'B' })],
      [labelledEdge('p', 'c1', 400, 86), labelledEdge('p', 'c2', 400, 86), edge('x', 'B'), edge('c2', 'm')],
      { boundaries: [scope('B', { kind: 'group' })] }),
    options: options(),
  },
  containerViewWithLongBoundaryLabel: {
    graph: graph(
      [person('student'), element('web', { parent: 'reg' }), element('api', { parent: 'reg' }), element('db', { parent: 'reg' }),
        element('billing', { external: true })],
      [edge('student', 'web'), edge('web', 'api'), edge('api', 'db'), edge('api', 'billing')],
      { boundaries: [scope('reg', { labelWidth: 500, labelHeight: 26 })], scopeId: 'reg' }),
    options: options(),
  },
  pinnedInLine: {
    graph: graph([element('a'), element('b'), element('c')], [edge('a', 'c')]),
    options: options({ pins: new Map([['a', [0, 0]], ['b', [0, 230]], ['c', [0, 460]]]) }),
  },
  // A chain l → r → s → i beside the long edge l → i: the chain stacks under l, so i is no help.
  longEdgeBesideChain: {
    graph: graph(['l', 'r', 's', 'i'].map((id) => element(id)), [edge('l', 'r'), edge('r', 's'), edge('s', 'i'), edge('l', 'i')]),
    options: options(),
  },
  // m answers u and would sit centred under it, in the way of the long edge u → t (w keeps t on rank 2).
  longEdgePastAnswer: {
    graph: graph([person('v'), person('u'), element('m'), element('w'), element('t')],
      [edge('m', 'u'), edge('v', 'w'), edge('w', 't'), edge('u', 't')]),
    options: options(),
  },
  scopeWithLongLabel: {
    graph: graph([element('m', { parent: 's' })], [], { boundaries: [scope('s', { labelWidth: 420, labelHeight: 26 })], scopeId: 's' }),
    options: options(),
  },
};

module.exports = { GRAPHS, BOX_WIDTH, BOX_HEIGHT, element, person, edge, labelledEdge, scope, graph, options };
