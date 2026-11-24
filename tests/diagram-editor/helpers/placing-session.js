'use strict';

// A session of the diagram editor outside a page, for the tests of moves without a drag (spec §3.11; plan Task 25b):
// the module's own commands, route and move gestures, and placing part, made from a kit as createDiagramEditorSession
// makes them, over three fakes at the ports the module owns:
// - the adapter keeps a document of stored positions and stored line points, logs every operation it is asked to
//   apply, applies a layout.set to its document, and has the host draw it again (its `can` can be told to refuse,
//   and its `apply` can answer a promise that settles after the drawing, as the C4 adapter's does);
// - the host records what it is told to announce, and draws the document again when asked (`redraw`), as a host does
//   after a change: then it syncs the session, which ends a move still running;
// - the drawing is a minimal stand-in for the SVG and its edit layer: a hit box per item, whose x and y show where
//   the preview puts the item, and each line's drawn points.
// The canvas and the page share one coordinate system here, so a pointer event's client point is the canvas point.

const { createClassicCommands, createCommands } = require('../../../diagram-editor/de-commands.js');
const { createRouteGestures } = require('../../../diagram-editor/de-gestures-routes.js');
const { createMoveGestures } = require('../../../diagram-editor/de-gestures-move.js');
const { createPlacing } = require('../../../diagram-editor/de-placing.js');
const { createSelection } = require('../../../diagram-editor/de-selection.js');
const { accepted } = require('../../../diagram-editor/de-operations.js');
const { layoutRouteStorageKey, clonePointsOf } = require('../../../diagram-editor/text/te-read.js');

const SVG_NS = 'http://www.w3.org/2000/svg';

/** An element of the stand-in drawing: attributes, classes, children, and removal from its parent. */
function fakeElement(tag) {
  const element = {
    tagName: tag,
    attributes: {},
    children: [],
    parentNode: null,
    textContent: '',
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    remove() {
      if (!this.parentNode) return;
      this.parentNode.children = this.parentNode.children.filter((other) => other !== this);
      this.parentNode = null;
    },
  };
  element.classList = {
    contains: (name) => (element.getAttribute('class') || '').split(/\s+/).includes(name),
    toggle() {},
  };
  return element;
}

/** The class of every element `root` holds, at any depth, matching `className`. */
function descendantsWithClass(root, className) {
  const found = [];
  (function visit(node) {
    node.children.forEach((child) => {
      if (child.classList.contains(className)) found.push(child);
      visit(child);
    });
  })(root);
  return found;
}

/**
 * A session over a document of `boxes` (`{ id, x, y, width, height, axis?, parentOf? }`; a port names the box whose
 * border holds it with `parentOf`) and `lines` (`{ id, index, source, target, points }`), with `options`:
 * `snap` (the Snap box checked), `refuse` (a verdict `can` answers for every operation), and `applyLater` (apply
 * answers a promise that settles after the host has drawn and synced).
 */
function placingSession(boxes, lines = [], options = {}) {
  const log = { applied: [], announced: [], redraws: 0 };
  const doc = {
    revision: 1,
    positions: Object.fromEntries(boxes.map((box) => [box.id, positionOf(box)])),
    routes: Object.fromEntries(lines.map((line) => [line.id, { points: line.points.map((p) => ({ ...p })) }])),
  };
  const sizes = Object.fromEntries(boxes.map((box) => [box.id, box]));

  // The document's stored position of a box: its top-left corner, a port's centre (as the move records them).
  function positionOf(box) {
    return box.axis === 'port' ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : { x: box.x, y: box.y };
  }
  function boxAt(id) {
    const size = sizes[id];
    const at = doc.positions[id];
    return size.axis === 'port'
      ? { x: at.x - size.width / 2, y: at.y - size.height / 2, width: size.width, height: size.height }
      : { x: at.x, y: at.y, width: size.width, height: size.height };
  }

  // ---------- the drawing ----------
  let drawing = null;
  function draw() {
    const layer = fakeElement('g');
    layer.setAttribute('class', 'uml-pg-edit-layer');
    const rects = {};
    boxes.forEach((box) => {
      const rect = fakeElement('rect');
      const drawn = boxAt(box.id);
      rect.setAttribute('class', 'uml-pg-edit-hitbox');
      rect.setAttribute('data-layout-id', box.id);
      ['x', 'y', 'width', 'height'].forEach((name) => rect.setAttribute(name, drawn[name]));
      rects[box.id] = rect;
      layer.appendChild(rect);
    });
    const lineElements = lines.map((line) => ({ line, element: { points: doc.routes[line.id].points.map((p) => ({ ...p })) } }));
    const svg = {
      querySelector: (selector) => (selector === '.uml-pg-edit-layer' ? layer : null),
      querySelectorAll: () => [],
    };
    layer.querySelector = (selector) => {
      const match = /^\.uml-pg-edit-hitbox\[data-layout-id="(.*)"\]$/.exec(selector);
      return match && rects[match[1]] && rects[match[1]].parentNode ? rects[match[1]] : null;
    };
    layer.querySelectorAll = (selector) => {
      const match = /^\.([\w-]+)/.exec(selector);
      return match && !selector.includes('[') ? descendantsWithClass(layer, match[1]) : [];
    };
    drawing = { svg, layer, rects, lineElements };
    log.redraws += 1;
  }
  draw();

  // ---------- the session's kit ----------
  const selection = createSelection();
  const bundle = {
    UMLShared: {
      setRoutePointsForElement(element, points) { element.points = points.map((p) => ({ ...p })); return element; },
      shiftRoutePoints(points, sourceDelta, targetDelta) {
        return points.map((p, at) => {
          const delta = at === 0 ? sourceDelta : at === points.length - 1 ? targetDelta : null;
          return delta ? { x: p.x + delta.x, y: p.y + delta.y } : { ...p };
        });
      },
    },
  };
  const env = {
    document: { createElementNS: (ns, tag) => fakeElement(tag) },
    now: () => 0,
    schedule: () => () => {},
    bundle,
  };

  let kit = null;
  // The host draws the document again and syncs the session, as the session's sync ends a running move.
  function redrawAndSync() {
    draw();
    kit.cancelPlacingForNewDrawing();
  }
  const host = {
    announce: (message, announceOptions) => log.announced.push({ message, verdict: announceOptions && announceOptions.verdict }),
    status: () => {},
    redraw: redrawAndSync,
  };
  const adapter = {
    contents: () => ({
      type: 'class',
      revision: `r${doc.revision}`,
      layoutPositions: JSON.parse(JSON.stringify(doc.positions)),
      layoutRoutes: JSON.parse(JSON.stringify(doc.routes)),
      elements: [],
      lines: [],
      ownedElementIds: () => [],
    }),
    can: () => options.refuse || accepted(null, null),
    apply(operation) {
      log.applied.push(operation);
      if (options.refuse) return options.refuse;
      const change = () => {
        Object.assign(doc.positions, operation.positions || {});
        (operation.routes || []).forEach((route) => {
          doc.routes[layoutRouteStorageKey(doc.routes, route) || route.id] = { points: route.points.map((p) => ({ ...p })) };
        });
        doc.revision += 1;
        redrawAndSync();
        return accepted(null, null);
      };
      return options.applyLater ? Promise.resolve().then(change) : change();
    },
  };
  adapter.targets = () => null;

  kit = {
    bendNumbers: false,
    clonePointsOf,
    commands: createCommands({ adapter, host, selection }),
    env,
    host,
    adapter,
    layoutRouteStorageKey,
    output: { querySelector: (selector) => (selector === 'svg' ? drawing.svg : null) },
    selectedLayout: selection,
    snapToggle: { checked: !!options.snap },
    textGrammar: {},
    activityLabelForNode: () => '',
    findEditableElements: () => boxes.map((box) => ({
      id: box.id,
      kind: box.axis === 'port' ? 'port' : 'class',
      axis: box.axis || 'xy',
      box: boxAt(box.id),
      parentBox: box.parentOf ? boxAt(box.parentOf) : undefined,
    })),
    findEditableRoutes: () => drawing.lineElements.map(({ line, element }) => ({
      id: line.id,
      index: line.index,
      source: line.source,
      target: line.target,
      points: element.points.map((p) => ({ ...p })),
      element,
    })),
    isSelectedAs: (id, kind) => selection.has({ id, kind }),
    selectedLayoutPrimaryId: () => (selection.primary() ? selection.primary().id : null),
    setSelectedLayoutId: (id, kind, setOptions) => {
      if (!id) selection.clear();
      else if (setOptions && setOptions.extend) selection.toggle({ id, kind: kind || 'node' });
      else selection.set({ id, kind: kind || 'node' });
    },
    // What the surface gives the parts: the canvas point of a pointer.
    editorCanvasPoint: (svg, clientX, clientY) => ({ x: clientX, y: clientY }),
  };
  const parts = [createClassicCommands(kit)];
  Object.assign(kit, parts[0].members);
  [createRouteGestures, createMoveGestures, createPlacing].forEach((create) => {
    const part = create(kit);
    parts.push(part);
    Object.assign(kit, part.members);
  });
  parts.forEach((part) => part.link());

  return {
    kit,
    log,
    selection,
    /** The session's startPlacing. */
    startPlacing: (target) => kit.startPlacing(target),
    /** The x and y of the hit box of `id` in the drawing shown now: where the preview, or the drawing, puts it. */
    shown: (id) => ({ x: Number(drawing.rects[id].getAttribute('x')), y: Number(drawing.rects[id].getAttribute('y')) }),
    /** The points of line `id` as the drawing shows them now. */
    linePoints: (id) => drawing.lineElements.find(({ line }) => line.id === id).element.points.map((p) => ({ ...p })),
    /** The document's stored lines. */
    storedRoutes: () => JSON.parse(JSON.stringify(doc.routes)),
    /** The drawn item `id`, as the move gesture's press finds it. */
    pressOn(id) {
      const item = kit.findEditableElements().find((candidate) => candidate.id === id);
      return { site: 'hitbox', svg: drawing.svg, layer: drawing.layer, item, rect: drawing.rects[id], editables: kit.findEditableElements() };
    },
    /** Draws the document again and syncs, as a host does after the learner typed in the source. */
    redrawAndSync,
  };
}

/** A pointer event at page point (x, y). */
const pointerAt = (x, y) => ({ clientX: x, clientY: y, currentTarget: null, pointerId: 1 });

/** The fields of a layout.set the tests compare: its op, positions, routes, and scene facts. */
const operationFields = (operation) => JSON.parse(JSON.stringify({
  op: operation.op, positions: operation.positions, routes: operation.routes, facts: operation.facts,
}));

module.exports = { placingSession, pointerAt, operationFields, SVG_NS };
