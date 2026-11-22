'use strict';

// Moves without a drag (UML-view editing spec §2.4, §3.11; plan Task 25b): session.startPlacing({ ref }) starts the
// session a press at the centre of the box would start, with no pointer down. `follow` and `commit(event)` are the
// drag's move and release at that point, snapping included; `nudge` steps exactly, never snapped; `commit()` drops
// where the preview is; `cancel` applies nothing. One move runs at a time; a drawing made while one runs ends it, but
// not the drawing its own commit causes.
//
// The session runs outside a page (helpers/placing-session.js): the module's own commands, gestures, and placing
// part, over a fake adapter, host, and drawing. The canvas point of a pointer event is its client point.

const test = require('node:test');
const assert = require('node:assert/strict');

const { placingSession, pointerAt, operationFields } = require('./helpers/placing-session.js');
const { refused } = require('../../diagram-editor/de-operations.js');

const ORDER = { id: 'Order', x: 100, y: 80, width: 120, height: 60 };
const CUSTOMER = { id: 'Customer', x: 400, y: 300, width: 120, height: 60 };
// A line from Order to Customer whose points the document stores, so a move of Order shifts them (a scene fact).
const ORDER_TO_CUSTOMER = { id: 'edge-0', index: 0, source: 'Order', target: 'Customer', points: [{ x: 220, y: 110 }, { x: 400, y: 330 }] };
// A component with a port on its right border: the port's centre is (280, 120).
const BILLING = { id: 'Billing', x: 100, y: 80, width: 180, height: 120 };
const BILLING_PORT = { id: 'Billing.api', x: 274, y: 114, width: 12, height: 12, axis: 'port', parentOf: 'Billing' };

const centreOf = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const NODE = (id) => ({ id, kind: 'node' });
const MOVE_CANCELLED = 'The drawing changed, so the move was cancelled.';

/** The operation a drag of `id` from the centre of its box, released at `to`, builds in a session made by `make`. */
function dragOperation(make, box, to, selectFirst) {
  const session = make();
  if (selectFirst) selectFirst(session);
  const from = centreOf(box);
  const drag = session.kit.startElementMove(pointerAt(from.x, from.y), session.pressOn(box.id));
  drag.move(pointerAt(to.x, to.y));
  drag.end(pointerAt(to.x, to.y));
  assert.equal(session.log.applied.length, 1, 'the drag applied one operation');
  return session.log.applied[0];
}

/** The operation a move without a press of `id`, committed at `to`, builds in a session made by `make`. */
async function placingOperation(make, id, to, selectFirst) {
  const session = make();
  if (selectFirst) selectFirst(session);
  const placing = session.startPlacing({ ref: NODE(id) });
  assert.ok(placing, `a move of ${id} starts`);
  const verdict = await placing.commit(pointerAt(to.x, to.y));
  assert.equal(verdict.ok, true);
  assert.equal(session.log.applied.length, 1, 'the commit applied one operation');
  return session.log.applied[0];
}

test('a move started without a press and committed at a point builds the operation that a drag from the centre of the box, released at that point, builds', async (t) => {
  await t.test('a box', async () => {
    const make = () => placingSession([ORDER, CUSTOMER], [ORDER_TO_CUSTOMER], { snap: true });
    const to = { x: 187, y: 153 };

    const placed = await placingOperation(make, 'Order', to);

    assert.deepEqual(operationFields(placed), operationFields(dragOperation(make, ORDER, to)));
    assert.deepEqual(placed.positions, { Order: { x: 130, y: 120 } }, 'the snapped place of the dragged box (160 + 27, 110 + 43 from its centre)');
    assert.deepEqual(Object.keys(placed.facts.shiftedRoutes), ['edge-0'], 'the stored line on the box moves with it');
  });

  await t.test('a port, which stays on its component\'s border', async () => {
    const make = () => placingSession([BILLING, BILLING_PORT]);
    const to = { x: 250, y: 60 };   // above the component, nearest its top border

    const placed = await placingOperation(make, 'Billing.api', to);

    assert.deepEqual(operationFields(placed), operationFields(dragOperation(make, BILLING_PORT, to)));
    assert.deepEqual(placed.positions, { 'Billing.api': { x: 250, y: 80 } }, 'the port lands on the top border');
  });

  await t.test('one box of a multi-selection', async () => {
    const make = () => placingSession([ORDER, CUSTOMER]);
    const selectBoth = (session) => {
      session.kit.setSelectedLayoutId('Order', 'node');
      session.kit.setSelectedLayoutId('Customer', 'node', { extend: true });
    };
    const to = { x: 200, y: 150 };

    const placed = await placingOperation(make, 'Order', to, selectBoth);

    assert.deepEqual(operationFields(placed), operationFields(dragOperation(make, ORDER, to, selectBoth)));
    assert.deepEqual(placed.positions, { Order: { x: 140, y: 120 }, Customer: { x: 440, y: 340 } }, 'both boxes move by the same step');
  });
});

test('nudge moves the preview by exactly the step with snapping on, from a start off the grid', async () => {
  const offGrid = { ...ORDER, x: 123, y: 57 };
  const session = placingSession([offGrid], [], { snap: true });
  const placing = session.startPlacing({ ref: NODE('Order') });

  placing.nudge(10, 0);
  assert.deepEqual(session.shown('Order'), { x: 133, y: 57 }, 'the preview moved 10 px');
  placing.nudge(1, 0);
  assert.deepEqual(placing.position(), { x: 134, y: 57 });
  await placing.commit();

  assert.deepEqual(session.log.applied[0].positions, { Order: { x: 134, y: 57 } });
  const snappingDrag = dragOperation(() => placingSession([offGrid], [], { snap: true }), offGrid,
    { x: centreOf(offGrid).x + 11, y: centreOf(offGrid).y });
  assert.deepEqual(snappingDrag.positions, { Order: { x: 130, y: 60 } }, 'where a snapping drag by the same 11 px puts it');
});

test('follow and commit at a point snap as the drag does', async () => {
  const session = placingSession([ORDER], [], { snap: true });
  const placing = session.startPlacing({ ref: NODE('Order') });

  placing.follow(pointerAt(173, 117));
  assert.deepEqual(placing.position(), { x: 110, y: 90 }, 'the pointer 13 px right and 7 px down of the centre, on the grid');
  assert.deepEqual(session.shown('Order'), { x: 110, y: 90 });
  await placing.commit(pointerAt(204, 132));

  assert.deepEqual(session.log.applied[0].positions, { Order: { x: 140, y: 100 } });
});

test('commit without an event writes where the preview is, unsnapped', async () => {
  const session = placingSession([ORDER], [], { snap: true });
  const placing = session.startPlacing({ ref: NODE('Order') });

  placing.follow(pointerAt(173, 117));
  placing.nudge(3, -2);
  await placing.commit();

  assert.deepEqual(session.log.applied[0].positions, { Order: { x: 113, y: 88 } });
});

test('cancel applies nothing and puts the preview back', async () => {
  const session = placingSession([ORDER]);
  const placing = session.startPlacing({ ref: NODE('Order') });
  placing.follow(pointerAt(260, 200));
  assert.deepEqual(session.shown('Order'), { x: 200, y: 170 }, 'the preview moved');

  placing.cancel();

  assert.deepEqual(session.shown('Order'), { x: 100, y: 80 }, 'the drawing shows the box where the document has it');
  assert.deepEqual(session.log.applied, []);
  assert.deepEqual(session.log.announced, [], 'a cancel says nothing; the surface says what it wants');
  assert.equal((await placing.commit(pointerAt(300, 300))).code, 'cancelled', 'a commit after the cancel applies nothing');
  assert.deepEqual(session.log.applied, []);
});

test('a refused can starts no move and announces the verdict', () => {
  const verdict = refused('layout/inside-node', 'Moves with its node', 'Not moved: this box moves with its node.', null);
  const session = placingSession([ORDER], [], { refuse: verdict });

  assert.equal(session.startPlacing({ ref: NODE('Order') }), null);
  assert.deepEqual(session.log.announced, [{ message: verdict.message, verdict }]);
  assert.deepEqual(session.log.applied, []);
});

test('a target no drag can move starts no move', () => {
  const session = placingSession([ORDER], [ORDER_TO_CUSTOMER]);

  assert.equal(session.startPlacing({ ref: NODE('Nothing') }), null, 'no item of that name is drawn');
  assert.equal(session.startPlacing({ ref: { id: 'edge-0', kind: 'route' }, bend: 1 }), null, 'a straight line has no bend 1');
  assert.deepEqual(session.log.announced, []);
});

test('starting a second move cancels the first', async () => {
  const session = placingSession([ORDER, CUSTOMER]);
  const first = session.startPlacing({ ref: NODE('Order') });
  first.follow(pointerAt(260, 200));

  const second = session.startPlacing({ ref: NODE('Customer') });
  first.nudge(10, 10);

  assert.deepEqual(session.shown('Order'), { x: 100, y: 80 }, 'the first move\'s preview is put back and follows nothing more');
  assert.equal((await first.commit()).code, 'cancelled');
  await second.commit(pointerAt(500, 350));
  assert.deepEqual(session.log.applied.map((operation) => operation.positions), [{ Customer: { x: 440, y: 320 } }]);
  assert.deepEqual(session.log.announced, [], 'the first move ended without a word');
});

test('a redraw while a move runs cancels it, applies nothing, and says that the drawing changed', async () => {
  const session = placingSession([ORDER]);
  const placing = session.startPlacing({ ref: NODE('Order') });
  placing.follow(pointerAt(260, 200));

  session.redrawAndSync();   // the learner typed in the source, undid, or switched the diagram type

  assert.deepEqual(session.log.announced.map((entry) => entry.message), [MOVE_CANCELLED]);
  placing.nudge(5, 5);
  assert.equal((await placing.commit()).code, 'cancelled');
  assert.deepEqual(session.log.applied, []);
  assert.deepEqual(session.shown('Order'), { x: 100, y: 80 });
});

test('committing a move announces only the drag\'s announcement, and the redraw it causes cancels nothing, also when the adapter\'s apply resolves after the host has redrawn and synced', async (t) => {
  for (const [name, applyLater] of [['an apply that answers at once', false], ['an apply that answers a promise', true]]) {
    await t.test(name, async () => {
      const session = placingSession([ORDER], [], { applyLater });
      const placing = session.startPlacing({ ref: NODE('Order') });
      placing.follow(pointerAt(260, 200));
      const redrawsBefore = session.log.redraws;

      const verdict = await placing.commit(pointerAt(260, 200));

      assert.equal(verdict.ok, true);
      assert.equal(session.log.redraws, redrawsBefore + 1, 'the host drew the moved box once');
      assert.deepEqual(session.log.announced, [], 'an accepted drop is announced by nothing but the drag, which says nothing');
      assert.deepEqual(session.log.applied.map((operation) => operation.positions), [{ Order: { x: 200, y: 170 } }]);
      assert.deepEqual(session.shown('Order'), { x: 200, y: 170 });
    });
  }
});
