'use strict';

// Gestures as sessions (UML-view editing spec §2.1, §3.4, §3.8; plan Task 23): a gesture factory `{ start(event,
// press) }` returns the session `{ move, end, cancel }` of one press. A gesture asks the adapter's advice through the
// commands (`can`) when it starts and when it is dropped, never per pointer move; Escape cancels the session through
// the surface's key handler, and a cancelled gesture applies nothing. An in-place editor is a gesture too: one entry
// of text, committed once or cancelled.
//
// The move factory runs here outside a page, on a class drawing of one box, with the commands, the scene functions,
// and the surface functions the session's kit gives it replaced by fakes: the commands record what they are asked.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMoveGestures } = require('../../diagram-editor/de-gestures-move.js');
const { startInlineEditor } = require('../../diagram-editor/de-inline.js');
const { createSelection } = require('../../diagram-editor/de-selection.js');
const { accepted } = require('../../diagram-editor/de-operations.js');

const REVISION = 'r00000001:1';
const BOX = { id: 'Order', kind: 'class', axis: 'xy', box: { x: 100, y: 80, width: 120, height: 60 } };

/** The kit of the session a move part is made from: fakes of what it uses, and `asked`, the commands' log. */
function moveKit() {
  const asked = [];
  const kit = {
    asked,
    commands: {
      contents: () => ({ type: 'class', revision: REVISION, layoutPositions: {} }),
      targetsFor: () => null,
      can: (operation) => { asked.push(`can ${operation.op}`); return accepted(null, null); },
      apply: (operation) => { asked.push(`apply ${operation.op}`); return accepted(null, null); },
    },
    env: { document: null, now: () => 0, schedule: () => {} },
    host: { redraw: () => asked.push('redraw') },
    output: { querySelector: () => null },
    selectedLayout: createSelection(),
    snapToggle: null,
    textGrammar: {},
    activityLabelForNode: () => '',
    findEditableElements: () => [BOX],
    isSelectedAs: () => false,
    selectedLayoutPrimaryId: () => null,
    setSelectedLayoutId: () => {},
    // What the other parts give the move part through link().
    toolState: { activeTool: null, pendingRelation: null },
    documentType: () => 'class',
    announce: (message) => asked.push(`announce ${message}`),
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
    moveSequenceMessageToY: () => false,
    activityNodeInfoForId: () => null,
  };
  return kit;
}

/** The element-move gesture factory of a move part made from `kit`, linked as the session links it. */
function elementMove(kit) {
  const part = createMoveGestures(kit);
  Object.assign(kit, part.members);
  part.link();
  return { id: 'element-move', start: part.members.startElementMove };
}

/** A press on the hit box of BOX in a drawing that holds nothing else. */
function pressOnBox() {
  const svg = { querySelector: () => null, querySelectorAll: () => [] };
  const rect = { setAttribute: () => {} };
  return { site: 'hitbox', svg, layer: { querySelector: () => rect }, item: BOX, rect, editables: [BOX] };
}

const pointer = (clientX, clientY) => ({ clientX, clientY, currentTarget: null, pointerId: 1 });

test('a gesture asks can when it starts and when it is dropped, never per pointer move', () => {
  const kit = moveKit();
  const session = elementMove(kit).start(pointer(110, 90), pressOnBox());
  assert.deepEqual(kit.asked, ['can layout.set'], 'the press asks once, before anything moves');

  for (let step = 1; step <= 5; step++) session.move(pointer(110 + 10 * step, 90 + 5 * step));
  assert.deepEqual(kit.asked, ['can layout.set'], 'five pointer moves ask nothing');

  session.end(pointer(160, 115));
  assert.deepEqual(kit.asked, ['can layout.set', 'can layout.set', 'apply layout.set'], 'the drop asks, then applies once');
});

test('Escape during a gesture calls cancel and runs no operation', () => {
  const kit = moveKit();
  const session = elementMove(kit).start(pointer(110, 90), pressOnBox());
  session.move(pointer(140, 110));

  session.cancel();                 // what the surface's Escape handler does to the running session
  session.end(pointer(150, 120));   // a release after the cancel drops nothing

  assert.deepEqual(kit.asked, ['can layout.set'], 'only the start was asked; nothing was applied');
});

test('a move the adapter refuses at its start announces why and takes the press without moving', () => {
  const kit = moveKit();
  kit.commands.can = (operation) => {
    kit.asked.push(`can ${operation.op}`);
    return { ok: false, code: 'layout/inside-node', summary: 'Moves with its node', message: 'Not moved: this box moves with its node.', offer: null };
  };
  const session = elementMove(kit).start(pointer(110, 90), pressOnBox());
  session.move(pointer(160, 120));
  session.end(pointer(160, 120));

  assert.deepEqual(kit.asked, ['can layout.set', 'announce Not moved: this box moves with its node.']);
});

// ---------- the in-place editor ----------

/** A DOM element that is enough for an in-place editor: attributes, listeners, children, and focus. */
function fakeElement(doc, tag) {
  const listeners = {};
  return {
    tagName: tag, ownerDocument: doc, parentNode: null, children: [], style: {}, attributes: {}, value: '',
    setAttribute(name, value) { this.attributes[name] = String(value); },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((other) => other !== child); child.parentNode = null; },
    addEventListener(type, listener) { (listeners[type] = listeners[type] || []).push(listener); },
    removeEventListener(type, listener) { listeners[type] = (listeners[type] || []).filter((other) => other !== listener); },
    dispatch(type, event = {}) { (listeners[type] || []).slice().forEach((listener) => listener({ preventDefault() {}, ...event })); },
    focus() { doc.activeElement = this; },
    select() {},
    getBoundingClientRect: () => ({ left: 40, top: 30, width: 80, height: 20 }),
  };
}

function editorRoot() {
  const doc = { activeElement: null };
  doc.createElement = (tag) => fakeElement(doc, tag);
  return fakeElement(doc, 'div');
}

test('an in-place editor commits its trimmed text once, and Escape through the host\'s order cancels it without a commit', () => {
  const root = editorRoot();
  const commits = [];
  const editor = startInlineEditor({
    root, anchor: root.ownerDocument.createElement('text'), label: 'Rename Order', value: 'Order',
    instruction: 'Enter keeps the name; Escape keeps the old one.', idPrefix: 'a-', onCommit: (text) => commits.push(text),
  });
  assert.equal(root.ownerDocument.activeElement, editor.input, 'the field has the focus');
  assert.equal(editor.input.attributes['aria-describedby'], 'a-inline-instruction', 'the instruction describes the field');

  editor.input.value = '  Invoice ';
  editor.input.dispatch('keydown', { key: 'Enter' });
  editor.input.dispatch('blur');
  assert.deepEqual(commits, ['Invoice'], 'Enter commits the trimmed text, and leaving the field afterwards does not commit again');
  assert.deepEqual(root.children, [], 'the field and its instruction are gone');

  const layers = [];
  const cancels = [];
  const escaped = startInlineEditor({
    root, anchor: { x: 10, y: 20 }, label: 'Rename Order', value: 'Order', idPrefix: 'b-',
    onCommit: (text) => commits.push(text), onCancel: () => cancels.push('cancelled'),
    registerEscape: (layer) => { layers.push(layer); return () => layers.splice(layers.indexOf(layer), 1); },
  });
  escaped.input.value = 'Draft';
  layers[0].onKey({ key: 'Escape', preventDefault() {} });

  assert.deepEqual(cancels, ['cancelled']);
  assert.deepEqual(commits, ['Invoice'], 'a cancelled entry commits nothing');
  assert.deepEqual(layers, [], 'the editor leaves the host\'s Escape order');
});
