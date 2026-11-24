'use strict';

// A lifeline head dragged sideways past others (UML-view editing spec §3.4 `lifeline.reorder`, §7.4 "Drag a head
// sideways"): the drop builds lifeline.reorder with the new order. When two neighbours swap, either one's move gives
// that order, so the order alone does not say which lifeline moved. An adapter whose reading says it takes the moved
// lifeline (`reorderNamesMoved`, the C4 host, which announces "Moved X before Y.") is told it as `moved`; an adapter
// that does not (the text adapter of the classic editor) gets the operation as the corpus records it, `order` only.
//
// The move factory runs outside a page, on a sequence drawing of three heads, with the commands, the scene functions,
// and the surface functions replaced by fakes; the commands record what they are asked to apply.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMoveGestures } = require('../../diagram-editor/de-gestures-move.js');
const { createSelection } = require('../../diagram-editor/de-selection.js');
const { accepted } = require('../../diagram-editor/de-operations.js');

const REVISION = 'r00000001:1';
const head = (id, x) => ({ id, kind: 'participant', axis: 'x', box: { x, y: 10, width: 80, height: 30 } });
const HEADS = [head('web', 0), head('coordinator', 200), head('policy', 400)];

/** The kit of a move part over a sequence drawing of HEADS; `reading` adds to what the adapter's contents say. */
function sequenceKit(reading) {
  const applied = [];
  const kit = {
    applied,
    commands: {
      contents: () => ({
        type: 'sequence', revision: REVISION, layoutPositions: {},
        elements: HEADS.map((item) => ({ id: item.id, axis: 'order' })),
        lifelineDeclarations: () => true,
        ...reading,
      }),
      targetsFor: () => null,
      can: () => accepted(null, null),
      apply: (operation) => { applied.push(operation); return accepted(null, null); },
    },
    env: { document: null, now: () => 0, schedule: () => {} },
    host: { redraw: () => {} },
    output: { querySelector: () => null },
    selectedLayout: createSelection(),
    snapToggle: null,
    textGrammar: {},
    activityLabelForNode: () => '',
    findEditableElements: () => HEADS,
    isSelectedAs: () => false,
    selectedLayoutPrimaryId: () => null,
    setSelectedLayoutId: () => {},
    toolState: { activeTool: null, pendingRelation: null },
    documentType: () => 'sequence',
    announce: () => {},
    editorCanvasPoint: (svg, clientX, clientY) => ({ x: clientX, y: clientY }),
    buildOperation: (op, fields, facts, undoKey) => ({ op, revision: REVISION, ...fields, facts, undo: { key: undoKey } }),
    layoutSetOperation: (svg, move) => ({ op: 'layout.set', revision: REVISION, positions: move.positions, routes: move.routes }),
    movedBoxesOf: () => [],
    mergeConnectedRouteEntries: (entries) => entries,
    applyConnectedRouteDeltas: () => {},
    collectConnectedRoutes: () => [],
    applyRoutePoints: () => {},
    syncRouteOverlays: () => {},
    clonePoints: (points) => points.map((point) => ({ ...point })),
    messageMoveOperation: () => null,
    activityNodeInfoForId: () => null,
  };
  const part = createMoveGestures(kit);
  Object.assign(kit, part.members);
  part.link();
  return kit;
}

const pointer = (clientX, clientY) => ({ clientX, clientY, currentTarget: null, pointerId: 1 });

/** The operations applied when the head of `policy` is dragged left of `coordinator`, its left neighbour. */
function dragPolicyLeftOfCoordinator(kit) {
  const svg = { querySelector: () => null, querySelectorAll: () => [] };
  const press = { site: 'hitbox', svg, layer: { querySelector: () => ({ setAttribute: () => {} }) }, item: HEADS[2],
    rect: { setAttribute: () => {} }, editables: HEADS };
  const session = kit.startElementMove(pointer(440, 20), press);
  session.move(pointer(300, 20));
  session.end(pointer(200, 20));
  return kit.applied;
}

test('a head dropped past its neighbour tells an adapter that takes it which lifeline moved', () => {
  const applied = dragPolicyLeftOfCoordinator(sequenceKit({ reorderNamesMoved: true }));

  assert.equal(applied.length, 1, 'the drop applies one operation');
  assert.equal(applied[0].op, 'lifeline.reorder');
  assert.deepEqual(applied[0].order, ['web', 'policy', 'coordinator']);
  assert.equal(applied[0].moved, 'policy');
});

test('a head dropped past its neighbour gives an adapter that does not take it the order alone', () => {
  const applied = dragPolicyLeftOfCoordinator(sequenceKit({}));

  assert.equal(applied.length, 1, 'the drop applies one operation');
  assert.equal(applied[0].op, 'lifeline.reorder');
  assert.deepEqual(applied[0].order, ['web', 'policy', 'coordinator']);
  assert.equal(Object.prototype.hasOwnProperty.call(applied[0], 'moved'), false, 'no moved field');
});
