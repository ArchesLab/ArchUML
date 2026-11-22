'use strict';

// Target marks (UML-view editing spec §3.4 `targets`, §7.4 "Target marks"; plan Task 38): when a gesture with an open
// end starts, it asks the adapter's `targets` once, and the scene marks every candidate, a possible one apart from one
// that is not. The move gesture's open end is `parent`: a drop on a box marked possible puts the moved box into it
// (`element.reparent`), and a drop on any other box puts the preview back. An adapter that gives no advice (the text
// adapter answers null) keeps today's move.
//
// The other gestures with an open end mark their candidates the same way: a new line drawn from a box's handle and a
// message drawn from a lifeline (`to`), and an element dragged from the palette (`into`). A drop on a candidate marked
// not possible adds nothing and says why.
//
// The session runs outside a page (helpers/placing-session.js): the module's own commands and move gesture over a fake
// adapter, host, and drawing. The tests give its adapter the advice and the verdicts they need; for the other gestures
// they add the module's connect, sequence, and palette parts, with fakes for the choosers and the adds those parts
// hand on to.

const test = require('node:test');
const assert = require('node:assert/strict');

const { placingSession, pointerAt } = require('./helpers/placing-session.js');
const { accepted, refused } = require('../../diagram-editor/de-operations.js');
const { createConnectGestures } = require('../../diagram-editor/de-gestures-connect.js');
const { createSequenceGestures } = require('../../diagram-editor/de-gestures-sequence.js');
const { createPaletteGestures } = require('../../diagram-editor/de-gestures-palette.js');

const POD = { id: 'Pod', x: 100, y: 80, width: 120, height: 60 };
const CLOUD = { id: 'Cloud', x: 400, y: 300, width: 200, height: 160 };
const EDGE = { id: 'Edge', x: 700, y: 80, width: 120, height: 60 };
const DISK = { id: 'Disk', x: 100, y: 400, width: 120, height: 60 };

// The advice of a deployment drawing for a move of Pod: Cloud can take it, Edge cannot; Disk is not a candidate.
const ADVICE = [
  { ref: 'Edge', ok: false, code: 'infrastructure-leaf', summary: 'Edge is infrastructure and holds nothing' },
  { ref: 'Cloud', ok: true, code: null, summary: null },
];
const EDGE_REFUSAL = refused('infrastructure-leaf', 'Edge is infrastructure and holds nothing',
  'Edge is an infrastructure node, so it cannot hold Pod.');

const centreOf = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

/** A session over the four boxes whose adapter answers `advice` for every request and logs each request. */
function adviseSession(advice) {
  const session = placingSession([POD, CLOUD, EDGE, DISK]);
  const requests = [];
  session.kit.adapter.targets = (request) => {
    requests.push(request);
    return advice;
  };
  // Advice is not a verdict: the adapter still refuses Pod into Edge when asked (spec §3.4, one owner of validation).
  session.kit.adapter.can = (operation) => (operation.op === 'element.reparent' && operation.parent === 'Edge' ? EDGE_REFUSAL : accepted(null, null));
  return { session, requests };
}

/** The target marks the drawing shows now: each one's candidate and whether it is marked possible. */
function marksOf(session) {
  const layer = session.pressOn('Pod').layer;
  const found = [];
  (function visit(node) {
    node.children.forEach((child) => {
      if (child.classList.contains('uml-pg-target-mark')) {
        found.push({ ref: child.getAttribute('data-target-ref'), possible: child.classList.contains('is-possible'), notPossible: child.classList.contains('is-not-possible') });
      }
      visit(child);
    });
  })(layer);
  return found;
}

/** Presses Pod at its centre and drags it to `to` in three steps; returns the drag, not yet released. */
function dragPodTowards(session, to) {
  const from = centreOf(POD);
  const drag = session.kit.startElementMove(pointerAt(from.x, from.y), session.pressOn('Pod'));
  drag.move(pointerAt(from.x + 10, from.y + 10));
  drag.move(pointerAt((from.x + to.x) / 2, (from.y + to.y) / 2));
  drag.move(pointerAt(to.x, to.y));
  return drag;
}

test('with targets answering, a gesture with an open end asks once and marks each candidate as possible or not', () => {
  const { session, requests } = adviseSession(ADVICE);

  const drag = dragPodTowards(session, centreOf(CLOUD));

  assert.equal(requests.length, 1, 'the advice is asked once, when the move starts, not per pointer move');
  assert.equal(requests[0].op, 'element.reparent');
  assert.equal(requests[0].ref, 'Pod');
  assert.equal(requests[0].open, 'parent');
  assert.equal('parent' in requests[0], false, 'the request is the operation without its open end');
  assert.equal(requests[0].revision, session.kit.commands.contents().revision);
  assert.deepEqual(marksOf(session).sort((a, b) => a.ref.localeCompare(b.ref)), [
    { ref: 'Cloud', possible: true, notPossible: false },
    { ref: 'Edge', possible: false, notPossible: true },
  ]);
  assert.deepEqual(session.kit.currentTargets().map((candidate) => candidate.ref), ['Cloud', 'Edge'],
    'keyboard order lists the possible targets first');
  drag.cancel();
});

test('a drop on a parent marked possible builds element.reparent; a drop on an unmarked node puts the preview back', async (t) => {
  await t.test('a drop on Cloud, marked possible, puts Pod into Cloud and moves no box', async () => {
    const { session } = adviseSession(ADVICE);
    const to = centreOf(CLOUD);

    dragPodTowards(session, to).end(pointerAt(to.x, to.y));
    await Promise.resolve();

    assert.deepEqual(session.log.applied.map((operation) => ({ op: operation.op, ref: operation.ref, parent: operation.parent })),
      [{ op: 'element.reparent', ref: 'Pod', parent: 'Cloud' }]);
    assert.equal(session.log.applied[0].revision, 'r1', 'built from the drawing the move started on');
    assert.deepEqual(marksOf(session), [], 'the marks go with the gesture');
  });

  await t.test('a drop on Disk, which is no candidate, applies nothing and puts the preview back', async () => {
    const { session } = adviseSession(ADVICE);
    const to = centreOf(DISK);

    dragPodTowards(session, to).end(pointerAt(to.x, to.y));

    assert.deepEqual(session.log.applied, []);
    assert.deepEqual(session.shown('Pod'), { x: POD.x, y: POD.y }, 'Pod is drawn where the document has it');
    assert.deepEqual(session.log.announced, []);
    assert.deepEqual(marksOf(session), []);
  });

  await t.test('a drop on Edge, marked not possible, applies nothing, puts the preview back, and says why', async () => {
    const { session } = adviseSession(ADVICE);
    const to = centreOf(EDGE);

    dragPodTowards(session, to).end(pointerAt(to.x, to.y));

    assert.deepEqual(session.log.applied, []);
    assert.deepEqual(session.shown('Pod'), { x: POD.x, y: POD.y });
    assert.deepEqual(session.log.announced.map((said) => said.message), [EDGE_REFUSAL.message]);
  });

  await t.test('a drop on empty canvas still moves the box', async () => {
    const { session } = adviseSession(ADVICE);

    dragPodTowards(session, { x: 400, y: 160 }).end(pointerAt(400, 160));

    assert.deepEqual(session.log.applied.map((operation) => operation.op), ['layout.set']);
    assert.deepEqual(session.log.applied[0].positions, { Pod: { x: 340, y: 130 } });
  });

  await t.test('with no advice, as from the text adapter, a drop on another box moves the box as before', async () => {
    const { session, requests } = adviseSession(null);
    const to = centreOf(CLOUD);

    dragPodTowards(session, to).end(pointerAt(to.x, to.y));

    assert.equal(requests.length, 1);
    assert.deepEqual(marksOf(session), []);
    assert.deepEqual(session.log.applied.map((operation) => operation.op), ['layout.set']);
    assert.deepEqual(session.log.applied[0].positions, { Pod: { x: 440, y: 350 } });
  });
});

// ─── The other open ends: a new line's `to`, a palette element's `into` ───

const LINK_TOOL = { id: 'link', label: 'link' };
const NODE_TOOL = { id: 'node', label: 'Node' };
// The adapter refuses every operation that would end on Edge (a line to it, an element into it).
const refusesEdge = (operation) => (operation.to === 'Edge' || operation.into === 'Edge' || operation.parent === 'Edge'
  ? EDGE_REFUSAL : accepted(null, null));

/**
 * A session over `boxes` of a `type` drawing with the connect, sequence, and palette parts besides the move, whose
 * adapter answers `advice` for every request. What those parts hand on (a relation added, a message added, an element
 * placed, a chooser shown) lands in `handed`.
 */
function openEndSession(boxes, type, advice) {
  const session = placingSession(boxes);
  const requests = [];
  const handed = [];
  const { kit } = session;
  kit.adapter.targets = (request) => {
    requests.push(request);
    return advice;
  };
  kit.adapter.can = refusesEdge;
  kit.env.document.elementsFromPoint = () => [];
  Object.assign(kit, {
    documentType: () => type,
    relationSchemasFor: () => [LINK_TOOL],
    selectedRelationToolSpec: () => LINK_TOOL,
    selectWhenDrawn: () => {},
    parseSvgViewBox: () => null,
    diagramSupportsAnchoredNotes: () => false,
    selectionSize: () => 0,
    previewPane: { getBoundingClientRect: () => ({ left: -1e4, top: -1e4, right: 1e4, bottom: 1e4 }) },
    pointer: { running: () => null },
    setActiveTool: () => {},
    connectWithSelectedRelationTool: (from, to) => { handed.push(['relation', from, to]); return true; },
    showRelationChooser: (x, y, from, to) => handed.push(['relation chooser', from, to]),
    showElementChooser: () => handed.push(['element chooser']),
    addSequenceRelationAtY: (svg, spec, from, to) => handed.push(['message', from, to]),
    handleHitboxClickForRelation: () => handed.push(['click']),
    placeElementAt: (spec, at) => handed.push(['place', spec.id, at]),
  });
  const parts = [createConnectGestures, createSequenceGestures, createPaletteGestures].map((create) => {
    const part = create(kit);
    Object.assign(kit, part.members);
    return part;
  });
  parts.forEach((part) => part.link());
  return { session, requests, handed };
}

/** The drawing's edit layer under `id`'s press, which can also remove a child (a new line's rubber band). */
function layerOf(session, id) {
  const press = session.pressOn(id);
  press.layer.removeChild = (child) => child.remove();
  return press;
}

/** A pointer event at page point (x, y) that a gesture may prevent and stop. */
const pressAt = (x, y) => ({ ...pointerAt(x, y), type: 'pointermove', preventDefault() {}, stopPropagation() {} });

/** The target marks the drawing of `session` shows now, as `ref: possible`, sorted by ref. */
function markSummary(session, id) {
  const layer = session.pressOn(id).layer;
  return marksOf({ pressOn: () => ({ layer }) }).sort((a, b) => a.ref.localeCompare(b.ref)).map((mark) => `${mark.ref}: ${mark.possible ? 'possible' : 'not possible'}`);
}

/** Draws a new line from Pod's handle towards `to` in two steps; returns the drag, not yet released. */
function drawLineFromPod(session, to) {
  const press = layerOf(session, 'Pod');
  const handle = { x: POD.x + POD.width, y: POD.y + POD.height / 2 };
  const drag = session.kit.startExtendHandleDrag(pressAt(handle.x, handle.y),
    { site: 'extend-handle', svg: press.svg, layer: press.layer, x: handle.x, y: handle.y, handle: { setPointerCapture() {} }, item: press.item, hitbox: null });
  drag.move(pressAt((handle.x + to.x) / 2, (handle.y + to.y) / 2));
  drag.move(pressAt(to.x, to.y));
  return drag;
}

test('a new line from a handle asks targets once for its open end to and marks each candidate', async (t) => {
  await t.test('the drag asks once, with the line without its to, and marks Cloud possible and Edge not', () => {
    const { session, requests } = openEndSession([POD, CLOUD, EDGE, DISK], 'deployment', ADVICE);

    const drag = drawLineFromPod(session, centreOf(DISK));

    assert.equal(requests.length, 1, 'asked once, when the line starts');
    assert.deepEqual({ op: requests[0].op, tool: requests[0].tool, from: requests[0].from, open: requests[0].open },
      { op: 'relation.add', tool: 'link', from: 'Pod', open: 'to' });
    assert.equal('to' in requests[0], false, 'the request is the operation without its open end');
    assert.deepEqual(markSummary(session, 'Pod'), ['Cloud: possible', 'Edge: not possible']);
    assert.deepEqual(session.kit.currentTargets().map((candidate) => candidate.ref), ['Cloud', 'Edge'], 'possible targets first');
    drag.cancel();
    assert.deepEqual(markSummary(session, 'Pod'), [], 'Escape takes the marks away');
  });

  await t.test('a release on Cloud, marked possible, adds the line', () => {
    const { session, handed } = openEndSession([POD, CLOUD, EDGE, DISK], 'deployment', ADVICE);
    const to = centreOf(CLOUD);

    drawLineFromPod(session, to).end(pressAt(to.x, to.y));

    assert.deepEqual(handed, [['relation', 'Pod', 'Cloud']]);
    assert.deepEqual(markSummary(session, 'Pod'), []);
  });

  await t.test('a release on Edge, marked not possible, adds nothing and says why', () => {
    const { session, handed } = openEndSession([POD, CLOUD, EDGE, DISK], 'deployment', ADVICE);
    const to = centreOf(EDGE);

    drawLineFromPod(session, to).end(pressAt(to.x, to.y));

    assert.deepEqual(handed, []);
    assert.deepEqual(session.log.announced.map((said) => said.message), [EDGE_REFUSAL.message]);
    assert.deepEqual(markSummary(session, 'Pod'), []);
  });

  await t.test('with no advice, as from the text adapter, nothing is marked and a release on Edge adds the line', () => {
    const { session, handed } = openEndSession([POD, CLOUD, EDGE, DISK], 'deployment', null);
    const to = centreOf(EDGE);

    const drag = drawLineFromPod(session, to);
    assert.deepEqual(markSummary(session, 'Pod'), []);
    drag.end(pressAt(to.x, to.y));

    assert.deepEqual(handed, [['relation', 'Pod', 'Edge']]);
  });
});

// Three lifelines of a sequence drawing: a message from Alice may go to Bob, not to Carol.
const ALICE = { id: 'Alice', x: 100, y: 40, width: 80, height: 40, axis: 'x' };
const BOB = { id: 'Bob', x: 400, y: 40, width: 80, height: 40, axis: 'x' };
const CAROL = { id: 'Carol', x: 700, y: 40, width: 80, height: 40, axis: 'x' };
const MESSAGE_ADVICE = [
  { ref: 'Carol', ok: false, code: 'not-reachable', summary: 'Carol cannot take this message' },
  { ref: 'Bob', ok: true, code: null, summary: null },
];

/** Draws a message from Alice's line at height 200 to the line at `x`; returns the drag, not yet released. */
function drawMessageFromAlice(session, x) {
  const press = layerOf(session, 'Alice');
  const drag = session.kit.startSequenceMessageGesture(pressAt(140, 200),
    { site: 'canvas', svg: press.svg, layer: press.layer, landedOnInteractive: false });
  drag.move(pressAt((140 + x) / 2, 200));
  drag.move(pressAt(x, 200));
  return drag;
}

test('a message drawn from a lifeline asks targets once for its open end to and marks each lifeline', async (t) => {
  await t.test('the drag asks once and marks Bob possible and Carol not', () => {
    const { session, requests } = openEndSession([ALICE, BOB, CAROL], 'sequence', MESSAGE_ADVICE);

    const drag = drawMessageFromAlice(session, 440);

    assert.equal(requests.length, 1);
    assert.deepEqual({ op: requests[0].op, tool: requests[0].tool, from: requests[0].from, open: requests[0].open },
      { op: 'relation.add', tool: 'link', from: 'Alice', open: 'to' });
    assert.equal('to' in requests[0], false);
    assert.deepEqual(markSummary(session, 'Alice'), ['Bob: possible', 'Carol: not possible']);
    drag.cancel();
    assert.deepEqual(markSummary(session, 'Alice'), []);
  });

  await t.test('a release on Bob adds the message; a release on Carol adds nothing and says why', () => {
    const toBob = openEndSession([ALICE, BOB, CAROL], 'sequence', MESSAGE_ADVICE);
    drawMessageFromAlice(toBob.session, 440).end(pressAt(440, 200));
    assert.deepEqual(toBob.handed, [['message', 'Alice', 'Bob']]);
    assert.deepEqual(markSummary(toBob.session, 'Alice'), []);

    const toCarol = openEndSession([ALICE, BOB, CAROL], 'sequence', MESSAGE_ADVICE);
    drawMessageFromAlice(toCarol.session, 740).end(pressAt(740, 200));
    assert.deepEqual(toCarol.handed, []);
    assert.deepEqual(toCarol.session.log.announced.map((said) => said.message), ['Carol cannot take this message'],
      'without a refusal from can, the candidate\'s short reason is said');
    assert.deepEqual(markSummary(toCarol.session, 'Alice'), []);
  });
});

/** Presses the palette's Node button and drags it to `to`; returns the drag, armed and not yet released. */
function dragNodeFromPalette(session, to) {
  const palette = session.kit.createPaletteDragGesture();
  const button = { setPointerCapture() {}, releasePointerCapture() {}, classList: { add() {}, remove() {} } };
  const drag = palette.start(pressAt(-50, -50), { site: 'palette', button, kind: 'element', spec: NODE_TOOL });
  drag.move(pressAt(0, 0));
  drag.move(pressAt(to.x, to.y));
  return drag;
}

test('an element dragged from the palette asks targets once for its open end into and marks each box', async (t) => {
  await t.test('the armed drag asks once, with the add without its into, and marks Cloud possible and Edge not', () => {
    const { session, requests } = openEndSession([POD, CLOUD, EDGE, DISK], 'deployment', ADVICE);

    const drag = dragNodeFromPalette(session, centreOf(DISK));

    assert.equal(requests.length, 1, 'asked once, when the drag is armed');
    assert.deepEqual({ op: requests[0].op, tool: requests[0].tool, open: requests[0].open }, { op: 'element.add', tool: 'node', open: 'into' });
    assert.equal('into' in requests[0], false);
    assert.deepEqual(markSummary(session, 'Pod'), ['Cloud: possible', 'Edge: not possible']);
    drag.cancel();
    assert.deepEqual(markSummary(session, 'Pod'), []);
  });

  await t.test('a drop on Cloud places the element there; a drop on Edge places nothing and says why', () => {
    const intoCloud = openEndSession([POD, CLOUD, EDGE, DISK], 'deployment', ADVICE);
    const cloud = centreOf(CLOUD);
    dragNodeFromPalette(intoCloud.session, cloud).end(pressAt(cloud.x, cloud.y));
    assert.deepEqual(intoCloud.handed, [['place', 'node', cloud]]);
    assert.deepEqual(markSummary(intoCloud.session, 'Pod'), []);

    const intoEdge = openEndSession([POD, CLOUD, EDGE, DISK], 'deployment', ADVICE);
    const edge = centreOf(EDGE);
    dragNodeFromPalette(intoEdge.session, edge).end(pressAt(edge.x, edge.y));
    assert.deepEqual(intoEdge.handed, []);
    assert.deepEqual(intoEdge.session.log.announced.map((said) => said.message), [EDGE_REFUSAL.message]);
    assert.deepEqual(markSummary(intoEdge.session, 'Pod'), []);
  });

  await t.test('with no advice, as from the text adapter, nothing is marked and a drop on Edge places the element', () => {
    const { session, handed } = openEndSession([POD, CLOUD, EDGE, DISK], 'deployment', null);
    const edge = centreOf(EDGE);

    const drag = dragNodeFromPalette(session, edge);
    assert.deepEqual(markSummary(session, 'Pod'), []);
    drag.end(pressAt(edge.x, edge.y));

    assert.deepEqual(handed, [['place', 'node', edge]]);
  });
});
