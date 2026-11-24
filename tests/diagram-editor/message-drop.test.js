'use strict';

// A message dragged up or down in a sequence drawing (UML-view editing spec §3.4 `message.move`, §5.6, §7.4): the drop
// builds the move to the place at its height, asks the adapter, and applies it. As a box's drop does, a refused move
// puts the preview back and then says why with its verdict (a host shows it as a refusal); a refusal without words says
// nothing; and a drop that throws puts the preview back before the error goes on, so the drawing never shows a move the
// document lacks. An adapter may answer with a promise (the C4 host): its verdict is handled when it settles.
//
// The move part runs outside a page, with the commands, the scene functions, and the host replaced by fakes that record
// what they are asked.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMoveGestures } = require('../../diagram-editor/de-gestures-move.js');
const { createSelection } = require('../../diagram-editor/de-selection.js');
const { accepted, refused } = require('../../diagram-editor/de-operations.js');

const REVISION = 'r00000001:1';
const MESSAGE = { id: 'seqmsg:3', points: [{ x: 0, y: 100 }, { x: 200, y: 100 }] };
const MOVE = { op: 'message.move', revision: REVISION, ref: { routeId: 'seqmsg:3', line: 3, candidates: [3] }, at: { beforeLine: 6 } };
const MOVED = accepted({ id: 'seqmsg:5', kind: 'route' }, 'Moved sequence message.');
const LOCKED = refused('locked', 'Given by the task', 'Locked: the steps of Enroll or a part of it is given by the task.', null);

/**
 * The kit of a move part over a sequence drawing: `moveAt` builds the drop's operation (the commands' messageMoveOperation),
 * `can` and `apply` answer for the adapter. `asked` logs, in order, what the commands, the host, and announce are asked.
 */
function messageKit({ moveAt = () => MOVE, can = () => accepted(null, null), apply = () => MOVED } = {}) {
  const asked = [];
  return {
    asked,
    commands: {
      contents: () => ({ type: 'sequence', revision: REVISION, layoutPositions: {} }),
      targetsFor: () => null,
      can: (operation) => { asked.push(`can ${operation.op}`); return can(operation); },
      apply: (operation) => { asked.push(`apply ${operation.op}`); return apply(operation); },
    },
    env: { document: null, now: () => 0, schedule: () => {} },
    host: { redraw: () => asked.push('redraw') },
    output: { querySelector: () => null },
    selectedLayout: createSelection(),
    snapToggle: null,
    textGrammar: {},
    activityLabelForNode: () => '',
    findEditableElements: () => [],
    isSelectedAs: () => false,
    selectedLayoutPrimaryId: () => null,
    setSelectedLayoutId: () => {},
    toolState: { activeTool: null, pendingRelation: null },
    documentType: () => 'sequence',
    announce: (message, isActive, verdict) => asked.push(`announce ${message}${verdict ? ` (${verdict.ok ? 'result' : 'refusal'})` : ''}`),
    editorCanvasPoint: (svg, clientX, clientY) => ({ x: clientX, y: clientY }),
    messageMoveOperation: (routeId, svg, canvasY) => moveAt(routeId, svg, canvasY),
    applyRoutePoints: () => {},
    syncRouteOverlays: () => {},
    clonePoints: (points) => points.map((point) => ({ ...point })),
  };
}

/** A press on MESSAGE's segment at (100, 100): the route drag a press on a message starts. */
function pressOnMessage(kit) {
  const part = createMoveGestures(kit);
  Object.assign(kit, part.members);
  part.link();
  return part.members.dragSession('drag', {
    kind: 'route', svg: {}, layer: {}, route: MESSAGE, segmentIndex: 0, lockedEndpoints: false,
    start: { x: 100, y: 100 }, startClient: { x: 100, y: 100 }, points: kit.clonePoints(MESSAGE.points),
  }, part.members.updateDrag, part.members.clearMove);
}

const pointer = (clientX, clientY) => ({ clientX, clientY, currentTarget: null, pointerId: 1 });
/** Lets every settled promise run its callbacks (a promise's then runs after the current task). */
const settled = () => new Promise((resolve) => setImmediate(resolve));

test('a message dropped at another height is asked about, applied once, and its result said, with no redraw of the old drawing', () => {
  const heights = [];
  const kit = messageKit({ moveAt: (routeId, svg, canvasY) => { heights.push([routeId, canvasY]); return MOVE; } });
  const drag = pressOnMessage(kit);

  drag.move(pointer(100, 160));
  drag.end(pointer(100, 160));

  assert.deepEqual(heights, [['seqmsg:3', 160]], 'the move goes to the place at the drop\'s height');
  assert.deepEqual(kit.asked, ['can message.move', 'apply message.move', 'announce Moved sequence message. (result)']);
});

test('a move the adapter refuses puts the preview back, then says why with its verdict, and applies nothing', () => {
  const kit = messageKit({ can: () => LOCKED });
  const drag = pressOnMessage(kit);

  drag.move(pointer(100, 160));
  drag.end(pointer(100, 160));

  assert.deepEqual(kit.asked, ['can message.move', 'redraw', `announce ${LOCKED.message} (refusal)`]);
});

test('a refusal without a sentence (a drop where the message already is) puts the preview back and says nothing', () => {
  const kit = messageKit({ apply: () => refused('message/unmoved', 'The message is already there', null, null) });
  const drag = pressOnMessage(kit);

  drag.move(pointer(100, 108));
  drag.end(pointer(100, 108));

  assert.deepEqual(kit.asked, ['can message.move', 'apply message.move', 'redraw']);
});

for (const [where, settings, asked] of [
  ['building the move', { moveAt: () => { throw new TypeError('Cannot read properties of undefined (reading \'3\')'); } }, []],
  ['asking the adapter', { can: () => { throw new TypeError('no insertion place'); } }, ['can message.move']],
  ['applying the move', { apply: () => { throw new TypeError('no insertion place'); } }, ['can message.move', 'apply message.move']],
]) {
  test(`a drop that throws while ${where} puts the preview back, and the error goes on`, () => {
    const kit = messageKit(settings);
    const drag = pressOnMessage(kit);
    drag.move(pointer(100, 250));

    assert.throws(() => drag.end(pointer(100, 250)), TypeError);

    assert.deepEqual(kit.asked, [...asked, 'redraw'], 'the drawing is made again from the document, which nothing changed');
  });
}

test('a press that moves the message 4 units or less moves nothing and draws the document again', () => {
  const kit = messageKit();
  const drag = pressOnMessage(kit);

  drag.move(pointer(100, 104));
  drag.end(pointer(100, 104));

  assert.deepEqual(kit.asked, ['redraw']);
});

test('with an adapter that answers with a promise, a result is said once it settles, and a settled refusal puts the preview back first', async () => {
  const accepting = messageKit({ apply: () => Promise.resolve(MOVED) });
  const first = pressOnMessage(accepting);
  first.move(pointer(100, 160));
  first.end(pointer(100, 160));
  await settled();
  assert.deepEqual(accepting.asked, ['can message.move', 'apply message.move', 'announce Moved sequence message. (result)']);

  const stale = refused('stale', null, 'The drawing changed before this edit was applied, so nothing was changed. Try again.', null);
  const refusing = messageKit({ apply: () => Promise.resolve(stale) });
  const second = pressOnMessage(refusing);
  second.move(pointer(100, 160));
  second.end(pointer(100, 160));
  await settled();
  assert.deepEqual(refusing.asked, ['can message.move', 'apply message.move', 'redraw', `announce ${stale.message} (refusal)`]);
});
