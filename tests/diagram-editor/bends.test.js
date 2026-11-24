'use strict';

// Bends as numbered things (UML-view editing spec §3.11; plan Task 25b): a bend is a point of a line between its two
// ends, numbered from the line's source end, from 1. session.startPlacing({ ref, bend: n }) moves one, with exact
// steps and pointer positions on the grid as the route drag rounds them; commands.addBend previews a new one until its
// move is committed; removeBend and straighten write at once. Every write is one layout.set with that line's
// `routes` entry and the scene facts of a route drag's drop.
//
// The session runs outside a page (helpers/placing-session.js): the module's own commands, gestures, and placing
// part, over a fake adapter, host, and drawing. The canvas point of a pointer event is its client point.

const test = require('node:test');
const assert = require('node:assert/strict');

const { placingSession, pointerAt, operationFields } = require('./helpers/placing-session.js');
const { refused } = require('../../diagram-editor/de-operations.js');

const ORDER = { id: 'Order', x: 100, y: 80, width: 120, height: 60 };
const CUSTOMER = { id: 'Customer', x: 400, y: 300, width: 120, height: 60 };
const LINE = { id: 'edge-0', kind: 'route' };

/** A line from Order (its source) to Customer through `points`. */
const lineThrough = (...points) => ({ id: 'edge-0', index: 0, source: 'Order', target: 'Customer', points });
const SOURCE_END = { x: 220, y: 110 };
const TARGET_END = { x: 400, y: 330 };
const STRAIGHT = lineThrough(SOURCE_END, TARGET_END);
// Segments of 80, 220, and 100 px: the middle one is the longest.
const TWO_BENDS = lineThrough(SOURCE_END, { x: 300, y: 110 }, { x: 300, y: 330 }, TARGET_END);

const sessionWith = (line, options) => placingSession([ORDER, CUSTOMER], [line], options);

test('bends are numbered from the line\'s source end', () => {
  const session = sessionWith(TWO_BENDS);

  assert.deepEqual(session.kit.bends(LINE), [{ n: 1, x: 300, y: 110 }, { n: 2, x: 300, y: 330 }]);
  assert.deepEqual(session.kit.bends({ id: 'edge-9', kind: 'route' }), [], 'a line that is not drawn has none');
  assert.deepEqual(sessionWith(STRAIGHT).kit.bends(LINE), [], 'a straight line has none');
});

test('a bend\'s nudge is exact with snapping on, and a pointer position rounds to the grid as the route drag does', async () => {
  const session = sessionWith(lineThrough(SOURCE_END, { x: 303, y: 107 }, TARGET_END), { snap: true });
  const placing = session.startPlacing({ ref: LINE, bend: 1 });

  placing.nudge(1, 0);
  assert.deepEqual(placing.position(), { x: 304, y: 107 }, 'a 1 px step from a bend off the grid');
  assert.deepEqual(session.linePoints('edge-0')[1], { x: 304, y: 107 }, 'the drawing shows the bend there');

  placing.follow(pointerAt(347, 213));
  assert.deepEqual(placing.position(), { x: 350, y: 210 }, 'a pointer position on the grid');
  await placing.commit(pointerAt(352, 226));

  assert.deepEqual(session.storedRoutes()['edge-0'].points, [SOURCE_END, { x: 350, y: 230 }, TARGET_END]);
});

test('a new bend on a straight line is at its midpoint', async () => {
  const session = sessionWith(STRAIGHT);

  const placing = session.kit.addBend(LINE);

  assert.equal(placing.target.bend, 1);
  assert.deepEqual(placing.position(), { x: 310, y: 220 });
  assert.deepEqual(session.linePoints('edge-0'), [SOURCE_END, { x: 310, y: 220 }, TARGET_END], 'the drawing previews it');
  assert.deepEqual(session.log.applied, [], 'nothing is written before the commit');
  await placing.commit();
  assert.deepEqual(session.storedRoutes()['edge-0'].points, [SOURCE_END, { x: 310, y: 220 }, TARGET_END]);
});

test('a new bend goes into the longest segment, and into the first of two equally long ones', () => {
  const longestInTheMiddle = sessionWith(TWO_BENDS).kit.addBend(LINE);
  assert.equal(longestInTheMiddle.target.bend, 2, 'it comes after the bend that starts the longest segment');
  assert.deepEqual(longestInTheMiddle.position(), { x: 300, y: 220 });

  const equalSegments = sessionWith(lineThrough({ x: 220, y: 110 }, { x: 320, y: 110 }, { x: 320, y: 210 })).kit.addBend(LINE);
  assert.equal(equalSegments.target.bend, 1);
  assert.deepEqual(equalSegments.position(), { x: 270, y: 110 });
});

test('addBend at a point puts the bend there, in the segment nearest to it', async () => {
  const session = sessionWith(TWO_BENDS);

  const placing = session.kit.addBend(LINE, { x: 260, y: 100 });
  await placing.commit();

  assert.equal(placing.target.bend, 1, 'the point lies by the first segment, not the longest');
  assert.deepEqual(session.storedRoutes()['edge-0'].points, [SOURCE_END, { x: 260, y: 100 }, ...TWO_BENDS.points.slice(1)]);
});

test('cancelling a new bend\'s move leaves the line as it was', () => {
  const session = sessionWith(STRAIGHT);
  const placing = session.kit.addBend(LINE);
  placing.nudge(20, 0);

  placing.cancel();

  assert.deepEqual(session.linePoints('edge-0'), [SOURCE_END, TARGET_END]);
  assert.deepEqual(session.storedRoutes()['edge-0'].points, [SOURCE_END, TARGET_END]);
  assert.deepEqual(session.log.applied, []);
});

test('removing the only bend leaves the two ends', async () => {
  const session = sessionWith(lineThrough(SOURCE_END, { x: 300, y: 110 }, TARGET_END));

  const verdict = await session.kit.removeBend(LINE, 1);

  assert.equal(verdict.ok, true);
  assert.deepEqual(session.storedRoutes()['edge-0'].points, [SOURCE_END, TARGET_END]);
});

test('removing the first and the last of three bends keeps the others in order', async () => {
  const bends = [{ x: 260, y: 110 }, { x: 260, y: 200 }, { x: 330, y: 200 }];
  const threeBends = lineThrough(SOURCE_END, ...bends, TARGET_END);

  const withoutFirst = sessionWith(threeBends);
  await withoutFirst.kit.removeBend(LINE, 1);
  assert.deepEqual(withoutFirst.storedRoutes()['edge-0'].points, [SOURCE_END, bends[1], bends[2], TARGET_END]);

  const withoutLast = sessionWith(threeBends);
  await withoutLast.kit.removeBend(LINE, 3);
  assert.deepEqual(withoutLast.storedRoutes()['edge-0'].points, [SOURCE_END, bends[0], bends[1], TARGET_END]);
});

test('straighten keeps the two ends and no bend', async () => {
  const session = sessionWith(TWO_BENDS);

  await session.kit.straighten(LINE);

  assert.deepEqual(session.storedRoutes()['edge-0'].points, [SOURCE_END, TARGET_END]);
});

/** The layout.set a drag of the first segment of `line` by 10 px down builds: the route drag's commit. */
function routeDragOperation(line) {
  const session = sessionWith(line);
  const route = session.kit.findEditableRoutes().find((candidate) => candidate.id === line.id);
  const segment = { getAttribute: (name) => ({ 'data-segment-index': '0', 'data-locked-endpoints': 'false' }[name]), setPointerCapture() {} };
  const press = { site: 'segment', svg: session.kit.output.querySelector('svg'), layer: null, route };
  const from = { x: (line.points[0].x + line.points[1].x) / 2, y: line.points[0].y };
  const drag = session.kit.startRouteEdit({ ...pointerAt(from.x, from.y), currentTarget: segment }, press);
  drag.move(pointerAt(from.x, from.y + 10));
  drag.end(pointerAt(from.x, from.y + 10));
  return session.log.applied[0];
}

test('each bend command is one layout.set with that line\'s routes entry', async () => {
  const routeDrag = operationFields(routeDragOperation(TWO_BENDS));
  const writes = {
    'the move of a bend': async (session) => session.startPlacing({ ref: LINE, bend: 1 }).commit(pointerAt(280, 90)),
    'a new bend': async (session) => session.kit.addBend(LINE).commit(),
    'a removed bend': async (session) => session.kit.removeBend(LINE, 2),
    'a straightened line': async (session) => session.kit.straighten(LINE),
  };
  for (const [name, write] of Object.entries(writes)) {
    const session = sessionWith(TWO_BENDS);
    await write(session);

    assert.equal(session.log.applied.length, 1, `${name}: one operation`);
    const written = operationFields(session.log.applied[0]);
    assert.equal(written.op, 'layout.set', name);
    assert.deepEqual(written.positions, {}, `${name}: no box moves`);
    assert.deepEqual(written.routes.map(({ id, index }) => ({ id, index })), [{ id: 'edge-0', index: 0 }], `${name}: that line's entry`);
    assert.deepEqual(written.facts, routeDrag.facts, `${name}: the scene facts of a route drag's commit`);
  }
});

test('a bend command the adapter refuses changes nothing and announces the verdict', async () => {
  const verdict = refused('layout/route', 'Line kept', 'Not changed: this line keeps its shape.', null);
  const session = sessionWith(TWO_BENDS, { refuse: verdict });

  assert.equal(session.kit.addBend(LINE), null, 'no new bend is previewed');
  assert.equal(session.startPlacing({ ref: LINE, bend: 1 }), null, 'no bend move starts');
  assert.equal((await session.kit.removeBend(LINE, 1)).ok, false);
  assert.equal((await session.kit.straighten(LINE)).ok, false);

  assert.deepEqual(session.storedRoutes()['edge-0'].points, TWO_BENDS.points);
  assert.deepEqual(session.linePoints('edge-0'), TWO_BENDS.points, 'the drawing shows the line as it was');
  assert.deepEqual(session.log.announced, [verdict, verdict, verdict, verdict].map((refusal) => ({ message: refusal.message, verdict: refusal })));
});
