(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(function () {
      return { drag: require('./c4-editor-drag.js'), canvasText: require('./c4-editor-canvas-text.js') };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.canvasEditing = factory(function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (editorParts) {
  'use strict';

  // Editing on the canvas (spec §9.2 "Direct manipulation", Interactions table). Dragging is the default and every
  // drag has a single-pointer alternative and a keyboard path (WCAG 2.5.7):
  //
  // | Action             | Drag                                 | Single pointer                          | Keyboard            |
  // |--------------------|--------------------------------------|-----------------------------------------|---------------------|
  // | Move (pins)        | drag the element                     | menu "Move…", then click the place      | M, arrows, Enter    |
  // | Add a relationship | drag a connect handle onto a target  | click the handle or Add relationship,   | C, then Enter on    |
  // |                    |                                      | then the target                         | the target          |
  // | Add an element     | drag a palette tile onto the drawing | click the tile                          | A (the Add menu)    |
  // | Refine a parent    | drag a carry-down tray item onto a   | the item's "Refine into…" menu (the     | the same menu       |
  // | responsibility     | part of the scope                    | tray's own)                             |                     |
  // | Edit a text        | —                                    | double-click the text (a box: its name) | F2 (the name)       |
  // | Context menu       | —                                    | right-click, long press, or "⋯"         | Shift+F10, Menu key |
  //
  // Every change is one shared command of the actions (Ruling 5), so one undo step with its announcement; this part
  // owns only the gestures, the modes ("Move", "Add relationship"), their feedback, and focus. Text edited in place
  // (F2, a double-click; ED-12) is the canvas-text part's (c4-editor-canvas-text.js), which this part creates. It reaches the drawing
  // through the canvas's surface and registers its pointer gestures on the canvas's one dispatcher (Ruling 4).
  // A mode's instruction and its refusals are announced with a kind, so the editor's message region shows them
  // (UML-view editing spec §7.5, §14 D6); the instruction leaves the region when its mode ends.
  //
  // On an edited UML-notation view the same keys and a palette tile's drop go to that view's editing part
  // (`surface.uml()`: c4-editor-uml-canvas.js and c4-editor-uml-interaction.js), whose Move and C modes steer the
  // diagram editor's own placing and target marks (UML-view editing spec §7.4). The modes below stay the C4 views'.

  // A moved box snaps to this grid (drawing units), unless it aligns with another box within ALIGN_UNITS.
  const GRID_UNITS = 10;
  const ALIGN_UNITS = 6;
  // Arrow keys in Move: one grid step, or five with Shift.
  const KEY_STEP_UNITS = 10;
  const KEY_STEP_LARGE_UNITS = 50;
  // A touch long press also fires contextmenu; within this time after the press's own menu it is ignored.
  const CONTEXT_MENU_REPEAT_MS = 1500;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const TYPING_TARGETS = 'input, select, textarea, [contenteditable=""], [contenteditable="true"]';
  // A menu inside the canvas (the carry-down tray's Refine into…) owns its keys, even while a mode is on.
  const MENUS = '[role="menu"]';
  // The kinds the editor's announce shows in its message region: a mode's instruction, and why it cannot go on.
  const AS_INSTRUCTION = Object.freeze({ kind: 'instruction' });
  const AS_REFUSAL = Object.freeze({ kind: 'refusal' });
  // Help's rows for the keys onKeydown answers on a focused element (spec §9.2).
  const HELP_KEYS = Object.freeze([
    ['F2', 'Rename the focused element; in a dynamic view, edit a step\'s description or a fragment\'s first guard'],
    ['Delete or Backspace', 'Delete the focused element; you confirm first'],
    ['M', 'Move the focused element: arrow keys, then Enter; in a dynamic view Up and Down choose a step\'s place, '
      + 'and Left and Right a lifeline\'s'],
    ['C', 'Start a relationship from the focused element, then press Enter on its target; on a step of a dynamic view, '
      + 'add a step after it'],
    ['Double-click', 'Edit the text under the pointer in place: a name, description, technology, or responsibility, or a '
      + 'relationship\'s description or technology; Enter keeps it, Escape cancels'],
    ['Shift+F10 or the Menu key',
      'Open the focused element\'s or line\'s commands; in a UML view a line\'s commands add, move, and remove its bends'],
  ]);

  /**
   * Adds editing to a canvas. `surface` is the canvas's (`region`, `stage`, `svg()`, `viewModel()`, `options()`,
   * `optionFor(id)`, `focusOption(option)`, `reveal(area)`, `pointer`, `onDraw(listener)`); `context` is the mount's
   * part context (`state`, `dom`, `ids`, `announce`, `escape`, `actions`, `layout`). Registers the canvas modes with the
   * actions (`actions.attachCanvas`), so the toolbar's palette and Add relationship reach them. Returns
   * `{ helpKeys, destroy() }`: `helpKeys` are Help's `[key, effect]` rows for the keys this part answers.
   */
  function createCanvasEditing(surface, context) {
    const { state, dom, actions, announce, escape } = context;
    const drag = editorParts().drag;
    const { region, stage } = surface;
    const doc = region.ownerDocument;
    const editorRoot = region.closest('.c4-editor') || region;
    const marks = drag.createTargetMarks();
    let mode = null;
    let hoveredId = null;
    let lastLongPressMenu = -Infinity;

    // ---- The drawing ------------------------------------------------------------------------------------------

    function modelNow() {
      return state.getDesign().model;
    }

    function nameOf(elementId) {
      const element = modelNow().elements.get(elementId);
      return element ? element.name || elementId : elementId;
    }

    function elementIdOf(option) {
      return option.getAttribute('data-c4-option');
    }

    /** The option of the canvas that `target` is or lies in, or null. */
    function optionAt(target) {
      const option = target && target.closest ? target.closest('[role="option"]') : null;
      return option && surface.options().includes(option) ? option : null;
    }

    /** The element group the renderer drew for `elementId` (its transform is the box's top-left), or null. */
    function nodeOf(elementId) {
      const svg = surface.svg();
      if (!svg) return null;
      return [...svg.querySelectorAll('[data-layout-id]')].find((node) => node.getAttribute('data-layout-id') === elementId) || null;
    }

    /** The renderer's group in layout coordinates (the frame of pins): the parent of the element groups. */
    function layoutLayer() {
      const svg = surface.svg();
      const node = svg && svg.querySelector('[data-layout-id]');
      return node ? node.parentNode : null;
    }

    /** A client point in layout coordinates. */
    function toLayout(event) {
      return new DOMPoint(event.clientX, event.clientY).matrixTransform(layoutLayer().getScreenCTM().inverse());
    }

    /** An element's top-left corner in layout coordinates: where its box is pinned or placed. */
    function cornerOf(node) {
      const transform = node.transform.baseVal.consolidate();
      return { x: transform ? transform.matrix.e : 0, y: transform ? transform.matrix.f : 0 };
    }

    /** An element's box in layout coordinates: its pinned or placed top-left corner and its drawn size. */
    function boxOf(node) {
      const size = node.getBBox();
      return Object.assign(cornerOf(node), { width: size.width, height: size.height });
    }

    /** Each drawn element's top-left corner in layout coordinates (the frame of pins), by id. */
    function drawnCorners() {
      const svg = surface.svg();
      return new Map(svg ? [...svg.querySelectorAll('[data-layout-id]')].map((node) => {
        const { x, y } = cornerOf(node);
        return [node.getAttribute('data-layout-id'), [Math.round(x), Math.round(y)]];
      }) : []);
    }

    /** The ids of the drawn elements that moved aside for a pinned element overlapping them (the view's `madeRoom`). */
    function roomMakers() {
      const viewModel = surface.viewModel();
      return new Set(viewModel && viewModel.nodes ? viewModel.nodes.filter((node) => node.madeRoom).map((node) => node.id) : []);
    }

    function otherBoxes(elementId) {
      const svg = surface.svg();
      return [...svg.querySelectorAll('[data-layout-id]')].filter((node) => node.getAttribute('data-layout-id') !== elementId).map(boxOf);
    }

    /**
     * Whether a client point lies on the visible canvas of a drawing: an element may move, or be dropped, anywhere
     * there, also beside the drawing's current bounds (the layout grows to hold it).
     */
    function onDrawing(event) {
      return surface.svg() !== null && inside(region.getBoundingClientRect(), event);
    }

    function svgElement(tag, attributes) {
      const node = doc.createElementNS(SVG_NS, tag);
      Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
      return node;
    }

    /** A layer for drag feedback in layout coordinates; the caller removes it. */
    function feedbackLayer() {
      const layer = svgElement('g', { class: 'c4-editor__drag-layer', 'aria-hidden': 'true' });
      layoutLayer().appendChild(layer);
      return layer;
    }

    function readOnlyProblem() {
      return actions.readOnlyReason();
    }

    // ---- Moving an element (drag, Move…, M) --------------------------------------------------------------------

    /**
     * The ghost of a moving box, with alignment guides: `follow(event, lockAxis)` moves it with the pointer from
     * `start` (grid snap, alignment, Shift locks the axis), `nudge(dx, dy)` by keys, `centreAt(event)` under a click;
     * `position()` is its top-left corner in layout coordinates.
     */
    function createMoveGhost(elementId, start) {
      const box = boxOf(nodeOf(elementId));
      const others = otherBoxes(elementId);
      const layer = feedbackLayer();
      const ghost = svgElement('rect', { class: 'c4-editor__ghost', width: box.width, height: box.height, rx: 6 });
      layer.appendChild(ghost);
      const anchor = start ? toLayout(start) : null;
      let current = { x: box.x, y: box.y };

      function draw(x, y, guides) {
        current = { x, y };
        ghost.setAttribute('x', String(x));
        ghost.setAttribute('y', String(y));
        layer.querySelectorAll('.c4-editor__align-guide').forEach((line) => line.remove());
        guides.forEach((guide) => layer.appendChild(svgElement('line', Object.assign({ class: 'c4-editor__align-guide' }, guide))));
      }

      function snapped(x, y, lock) {
        const across = lock === 'x' ? { value: box.x, guide: null } : align(x, box.width, others, 'x', 'width');
        const down = lock === 'y' ? { value: box.y, guide: null } : align(y, box.height, others, 'y', 'height');
        const guides = [];
        if (across.guide !== null) {
          guides.push({ x1: across.guide, x2: across.guide, y1: Math.min(y, across.span[0]), y2: Math.max(y + box.height, across.span[1]) });
        }
        if (down.guide !== null) {
          guides.push({ y1: down.guide, y2: down.guide, x1: Math.min(x, down.span[0]), x2: Math.max(x + box.width, down.span[1]) });
        }
        draw(across.value, down.value, guides);
      }

      return {
        follow(event, lockAxis) {
          const point = toLayout(event);
          const dx = point.x - anchor.x;
          const dy = point.y - anchor.y;
          const lock = lockAxis ? (Math.abs(dx) >= Math.abs(dy) ? 'y' : 'x') : null;
          snapped(box.x + dx, box.y + dy, lock);
        },
        nudge(dx, dy) {
          draw(current.x + dx, current.y + dy, []);
        },
        centreAt(event) {
          const point = toLayout(event);
          snapped(point.x - box.width / 2, point.y - box.height / 2, null);
        },
        moved: () => current.x !== box.x || current.y !== box.y,
        position: () => current,
        remove: () => layer.remove(),
      };
    }

    /** Pins the element where its ghost is, focuses it, and announces the result (the actions' command). */
    function placeElement(elementId, ghost) {
      const position = ghost.position();
      ghost.remove();
      const result = actions.pinElement(elementId, { viewKey: surface.viewModel().key, x: position.x, y: position.y });
      focusElement(elementId);
      return result;
    }

    function moveCancelled(elementId) {
      announce(moveCancelledMessage(elementId));
    }

    function moveCancelledMessage(elementId) {
      return `Move canceled; ${nameOf(elementId)} stays where it was.`;
    }

    /** A press on an element: a tap selects it, a drag moves it (a double-click edits its text: the canvas-text part). */
    function pressElement(option, event, press) {
      const elementId = elementIdOf(option);
      const movable = option.classList.contains('c4-editor__option--box');
      let ghost = null;
      return drag.createDragSession({
        event,
        onBegin() {
          if (!movable || readOnlyProblem() || nodeOf(elementId) === null) return false;
          press.capture();
          ghost = createMoveGhost(elementId, event);
          return true;
        },
        onMove: (moved) => ghost.follow(moved, moved.shiftKey),
        onDrop(released) {
          if (!onDrawing(released) || !ghost.moved()) {
            ghost.remove();
            moveCancelled(elementId);
            return;
          }
          placeElement(elementId, ghost);
        },
        onLongPress(pressed) {
          lastLongPressMenu = pressed.timeStamp;
          openElementMenu(elementId, { point: pointOf(pressed), returnFocus: option });
        },
        onCancel() {
          ghost.remove();
          moveCancelled(elementId);
        },
      });
    }

    /**
     * The Move mode (spec §9.2: context menu "Move…", then click the destination; or M, arrow keys, Enter): a ghost
     * of the box follows the pointer over the drawing and the arrow keys; a click or Enter places and pins it; Escape
     * (a layer on the editor's Escape stack) cancels.
     */
    function startMoveMode(elementId) {
      const problem = readOnlyProblem();
      const option = surface.optionFor(elementId);
      if (problem || !option || !option.classList.contains('c4-editor__option--box')) {
        announce(problem || `Error: ${nameOf(elementId)} is drawn around what it contains, so it moves with them; move those instead.`,
          AS_REFUSAL);
        return;
      }
      leaveMode();
      const ghost = createMoveGhost(elementId, null);
      enterMode({ kind: 'move', elementId, ghost, cleanup: () => ghost.remove(), cancelMessage: () => moveCancelledMessage(elementId) });
      surface.focusOption(option);
      instruct(`Moving ${nameOf(elementId)}: arrow keys move it (Shift moves farther), or click where it should go; `
        + 'Enter places it; Escape cancels.');
    }

    function moveModeKey(event) {
      const steps = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (event.key in steps && !event.altKey && !event.ctrlKey && !event.metaKey) {
        const size = event.shiftKey ? KEY_STEP_LARGE_UNITS : KEY_STEP_UNITS;
        mode.ghost.nudge(steps[event.key][0] * size, steps[event.key][1] * size);
        return true;
      }
      if (event.key === 'Enter') {
        const { elementId, ghost } = mode;
        leaveMode();
        placeElement(elementId, ghost);
        return true;
      }
      return false;
    }

    // ---- Adding a relationship (connect-handle drag, click-then-click, C) -------------------------------------

    /** The options a relationship from `sourceId` may end at: every other element, except what contains it or lies in it. */
    function connectTargets(sourceId) {
      return surface.options().filter((option) => actions.newRelationshipProblem(sourceId, elementIdOf(option)) === null);
    }

    function targetUnder(event, targets) {
      return doc.elementsFromPoint(event.clientX, event.clientY).find((element) => targets.includes(element)) || null;
    }

    /**
     * Opens the anchored relationship form for the chosen ends; focus comes back to the source afterwards, unless the
     * form handed it to another region (Add an interface to the target).
     */
    function openRelationshipForm(sourceId, targetId, placement) {
      return actions.openRelationshipForm({ sourceId, targetId }, Object.assign({ returnFocus: surface.optionFor(sourceId) }, placement))
        .then((result) => {
          if (!result || !result.focusHandedOff) focusElement(sourceId);
          return result;
        });
    }

    /** A press on a connect handle: a drag draws the new relationship to its target; a tap starts click-then-click. */
    function pressHandle(sourceId, event, press) {
      let feedback = null;
      let targets = [];
      const finish = () => {
        if (feedback) feedback.remove();
        marks.clear();
      };
      return drag.createDragSession({
        event,
        onBegin() {
          if (readOnlyProblem()) return false;
          press.capture();
          targets = connectTargets(sourceId);
          marks.show(targets);
          const box = boxOf(nodeOf(sourceId));
          feedback = feedbackLayer();
          const centre = { x: box.x + box.width, y: box.y + box.height / 2 };
          feedback.appendChild(svgElement('line', { class: 'c4-editor__connect-line', x1: centre.x, y1: centre.y, x2: centre.x, y2: centre.y }));
          return true;
        },
        onMove(moved) {
          const point = toLayout(moved);
          const line = feedback.querySelector('line');
          line.setAttribute('x2', String(point.x));
          line.setAttribute('y2', String(point.y));
          marks.hover(targetUnder(moved, targets));
        },
        onDrop(released) {
          const target = targetUnder(released, targets);
          finish();
          if (target === null) {
            announce(`No relationship added: drop the line on another element to connect ${nameOf(sourceId)}.`);
            return;
          }
          openRelationshipForm(sourceId, elementIdOf(target), { point: pointOf(released) });
        },
        onTap: () => startConnectMode({ sourceId }),
        onCancel() {
          finish();
          announce(`No relationship added from ${nameOf(sourceId)}.`);
        },
      });
    }

    /**
     * The "Add relationship" mode (spec §9.2: click the handle or the toolbar's Add relationship, then click the
     * target; or C, then the target): without `sourceId` it first asks for the source. An option is picked by a
     * click or by Enter; a click on empty canvas or Escape cancels.
     */
    function startConnectMode({ sourceId = null } = {}) {
      const problem = readOnlyProblem()
        || (surface.options().length === 0 ? 'Error: Relationships are drawn between elements; this view has none to connect.' : null);
      if (problem) {
        announce(problem, AS_REFUSAL);
        return;
      }
      leaveMode();
      enterMode({ kind: 'connect', sourceId, cleanup: () => marks.clear(), cancelMessage: () => 'No relationship added.' });
      if (sourceId !== null) {
        marks.show(connectTargets(sourceId));
        instruct(`Adding a relationship from ${nameOf(sourceId)}: click its target, or move to it with the arrow keys and press Enter; `
          + 'Escape cancels.');
        return;
      }
      const stop = surface.options().find((option) => option.getAttribute('tabindex') === '0') || surface.options()[0];
      surface.focusOption(stop);
      instruct('Adding a relationship: click the element it starts from, or move to it with the arrow keys and press Enter; Escape cancels.');
    }

    /** Picks `option` as the source or the target of the relationship being added. */
    function pick(option) {
      if (mode === null || mode.kind !== 'connect') return;
      const elementId = elementIdOf(option);
      if (mode.sourceId === null) {
        mode.sourceId = elementId;
        marks.show(connectTargets(elementId));
        instruct(`From ${nameOf(elementId)}: now click its target, or move to it and press Enter.`);
        return;
      }
      const problem = actions.newRelationshipProblem(mode.sourceId, elementId);
      if (problem) {
        announce(problem, AS_REFUSAL);
        return;
      }
      const sourceId = mode.sourceId;
      leaveMode();
      openRelationshipForm(sourceId, elementId, { anchor: option });
    }

    /** The toolbar's Add relationship (through the actions' hook): from the selected element when it is drawn here. */
    function startConnectFromToolbar() {
      // On an edited UML view the line is the view's: drawn from the selected box, or from the box clicked first.
      const uml = surface.uml ? surface.uml() : null;
      if (uml && uml.startDrawing(null)) return;
      const selection = state.getSelection();
      const selected = selection && selection.elementId && surface.optionFor(selection.elementId);
      if (selected) {
        surface.focusOption(selected);
        startConnectMode({ sourceId: selection.elementId });
      } else {
        startConnectMode();
      }
    }

    // ---- Modes (one at a time; each is a layer of the editor's Escape stack, spec §9.2 Escape order) -------------

    function enterMode(next) {
      mode = Object.assign({ layer: escape.push({ close: cancelMode }), instruction: null }, next);
      region.classList.add(`is-${next.kind === 'move' ? 'moving' : 'connecting'}`);
    }

    /**
     * Announces what the current mode waits for as its instruction, which the editor shows until the mode ends (the
     * editor's `announce` returns the shown message's handle, or null when nothing is shown).
     */
    function instruct(message) {
      mode.instruction = announce(message, AS_INSTRUCTION) || null;
    }

    /** Ends the mode without announcing (its command ran, or another mode replaces it); its instruction goes with it. */
    function leaveMode() {
      if (mode === null) return;
      const ended = mode;
      mode = null;
      ended.layer.remove();
      ended.cleanup();
      if (ended.instruction) ended.instruction.withdraw();
      region.classList.remove('is-moving', 'is-connecting');
    }

    function cancelMode() {
      if (mode === null) return;
      const { elementId } = mode;
      announce(endModeAsCancelled());
      if (elementId) focusElement(elementId);
    }

    /**
     * Ends the mode as cancelled without announcing, and returns the sentence that says so ('' when no mode was on).
     * A palette add (the actions' `endMode` hook, or a tile drag) begins its own announcement with it.
     */
    function endModeAsCancelled() {
      if (mode === null) return '';
      const message = mode.cancelMessage();
      leaveMode();
      return message;
    }

    /** A press while a mode waits for a click: picks or places, or cancels on empty canvas. */
    function pressInMode(event) {
      const option = optionAt(event.target);
      if (mode.kind === 'connect') {
        if (option === null) {
          cancelMode();
          return null;
        }
        return drag.createDragSession({ event, onBegin: () => false, onTap: () => pick(option) });
      }
      return drag.createDragSession({
        event,
        onBegin: () => false,
        onTap(released) {
          // The mode may have ended (Escape) while the button was down.
          if (mode === null || mode.kind !== 'move' || !onDrawing(released)) return;
          const { elementId, ghost } = mode;
          ghost.centreAt(released);
          leaveMode();
          placeElement(elementId, ghost);
        },
      });
    }

    /** In Move, the ghost follows a hovering pointer over the drawing, so the click's result shows before it happens. */
    function onPointerMove(event) {
      if (mode && mode.kind === 'move' && event.buttons === 0 && onDrawing(event)) mode.ghost.centreAt(event);
      setHovered(affordanceIdAt(event.target));
    }

    // ---- Palette drags (spec §9.2 "Add an element": placed and pinned where dropped) ----------------------------

    /** Follows a press on a palette tile (the actions' `startPaletteDrag` hook); a drop on the drawing adds and pins. */
    function startPaletteDrag(tile, event) {
      const noun = tile.label.toLowerCase();
      let ghost = null;
      // A mode on when the drag begins ends then; its cancellation opens the drag's own announcement.
      let endedMode = '';
      const say = (message) => announce(endedMode ? `${endedMode} ${message}` : message);
      const finish = () => {
        if (ghost) ghost.remove();
        region.classList.remove('is-drop-zone', 'is-drop-hover');
      };
      const session = drag.createDragSession({
        event,
        onBegin() {
          endedMode = endModeAsCancelled();
          ghost = dom.el('div', { class: 'c4-editor__drag-ghost', 'aria-hidden': 'true', text: tile.label });
          editorRoot.appendChild(ghost);
          region.classList.add('is-drop-zone');
          return true;
        },
        onMove(moved) {
          followPointer(ghost, moved);
          region.classList.toggle('is-drop-hover', inside(region.getBoundingClientRect(), moved));
        },
        onDrop(released) {
          finish();
          if (!inside(region.getBoundingClientRect(), released)) {
            say(`No ${noun} added: drop the tile on the drawing, or click it to add one.`);
            return;
          }
          const uml = surface.uml ? surface.uml() : null;
          if (uml && uml.dropTile(tile, released)) return;
          // A tile of a UML view's own tools adds only on that view's drawing, which another drawing replaced meanwhile.
          if (tile.tool) {
            say(`No ${noun} added: the view changed during the drag.`);
            return;
          }
          const result = actions.addElementFromTile(tile, dropPosition(released));
          if (endedMode && result.message) say(result.message);
          if (result.ok) beginRename(result.elementId);
        },
        onCancel() {
          finish();
          say(`No ${noun} added.`);
        },
      });
      return drag.track(event, session);
    }

    /**
     * Where a dropped tile is pinned: centred under the pointer as the smallest box of the view (a new element has only
     * its name and type, so its box is about that size, and the pointer lies on it); null without a drawing.
     */
    function dropPosition(event) {
      if (!onDrawing(event)) return null;
      const point = toLayout(event);
      const boxes = [...surface.svg().querySelectorAll('[data-layout-id]')].map(boxOf);
      const width = Math.min(...boxes.map((box) => box.width));
      const height = Math.min(...boxes.map((box) => box.height));
      return { viewKey: surface.viewModel().key, x: point.x - width / 2, y: point.y - height / 2 };
    }

    // ---- Carry-down drags (spec §9.2 "Refine a parent responsibility": drag it from the tray onto a part) --------

    /**
     * Follows a press on a carry-down tray item (the actions' `startRefineDrag` hook). `refinement` is
     * `{ label, scopeName, childIds, refine(childId, { lead }) }`: the scope's parts drawn here are the valid targets;
     * a drop on one calls `refine` (one command and one undo step, which the tray announces) and focuses that part,
     * so the learner can reword its copy; a drop anywhere else, or Escape, changes nothing. While dragging, the
     * canvas is `is-refining`, which steps the open tray aside so no part is hidden under it.
     */
    function startRefineDrag(refinement, event) {
      let ghost = null;
      let targets = [];
      let endedMode = '';
      const say = (message) => announce(endedMode ? `${endedMode} ${message}` : message);
      const finish = () => {
        if (ghost) ghost.remove();
        marks.clear();
        region.classList.remove('is-refining');
      };
      const session = drag.createDragSession({
        event,
        onBegin() {
          endedMode = endModeAsCancelled();
          targets = refinement.childIds.map(surface.optionFor).filter(Boolean);
          marks.show(targets);
          ghost = dom.el('div', { class: 'c4-editor__drag-ghost', 'aria-hidden': 'true', text: refinement.label });
          editorRoot.appendChild(ghost);
          region.classList.add('is-refining');
          return true;
        },
        onMove(moved) {
          followPointer(ghost, moved);
          marks.hover(targetUnder(moved, targets));
        },
        onDrop(released) {
          const target = targetUnder(released, targets);
          finish();
          if (target === null) {
            say(`No responsibility refined: drop it on a part of ${refinement.scopeName}, or use its Refine into… menu.`);
            return;
          }
          const childId = elementIdOf(target);
          if (refinement.refine(childId, { lead: endedMode }).ok) focusElement(childId);
        },
        onCancel() {
          finish();
          say('No responsibility refined.');
        },
      });
      return drag.track(event, session);
    }

    /** Puts a drag ghost (an HTML label beside the pointer) at the pointer: a measured position, set through the CSSOM. */
    function followPointer(ghost, event) {
      ghost.style.setProperty('--c4-drag-x', `${event.clientX}px`);
      ghost.style.setProperty('--c4-drag-y', `${event.clientY}px`);
    }

    // ---- Text in place (spec §9.2 rename in place; ED-12): the canvas-text part -------------------------------

    const text = editorParts().canvasText.createCanvasText(surface, context, { focusElement });

    function beginRename(elementId) {
      text.beginRename(elementId);
    }

    /** A double-click on the drawing edits the text under the pointer (ED-12); it never zooms. */
    function onDoubleClick(event) {
      if (mode !== null || event.defaultPrevented || surface.svg() === null) return;
      if (text.editAt(event)) event.preventDefault();
    }

    // ---- Context menu, Delete, and keys -----------------------------------------------------------------------

    function openElementMenu(elementId, placement) {
      return actions.openElementMenu(elementId, Object.assign({}, placement, {
        onMove: (id) => startMoveMode(id),
        onAddRelationship: (id) => startConnectMode({ sourceId: id }),
      }));
    }

    /** Right-click on an element, its "⋯" button, or a declared relationship opens its context menu. */
    function onContextMenu(event) {
      // On an edited UML view a box or line has the view's menu, the one its "⋯" button and Shift+F10 open (§3.11).
      const uml = surface.uml ? surface.uml() : null;
      if (uml && uml.contextMenu(event)) {
        event.preventDefault();
        return;
      }
      const elementId = affordanceIdAt(event.target);
      const edge = event.target.closest('[data-layout-route-id][data-c4-derived="false"]');
      if (elementId === null && edge === null) return;
      event.preventDefault();
      // The press's own long-press menu is already open.
      if (event.timeStamp - lastLongPressMenu < CONTEXT_MENU_REPEAT_MS) return;
      const point = pointOf(event);
      if (elementId !== null) openElementMenu(elementId, { point, returnFocus: surface.optionFor(elementId) || region });
      else actions.openRelationshipMenu(edge.getAttribute('data-layout-route-id'), { point, returnFocus: region });
    }

    /**
     * Delete and Backspace (spec §9.2): the actions confirm with the dependent references; then focus goes to the
     * next option, else the previous, else the canvas region.
     */
    function deleteFocused(option) {
      const order = surface.options().map(elementIdOf);
      const index = order.indexOf(elementIdOf(option));
      const neighbours = order.slice(index + 1).concat(order.slice(0, index).reverse());
      actions.deleteElement(elementIdOf(option), { returnFocus: option }).then((result) => {
        if (!result.ok) return;
        const next = neighbours.map((id) => surface.optionFor(id)).find(Boolean);
        if (next) surface.focusOption(next);
        else region.focus({ preventScroll: true });
      });
    }

    /**
     * Keys on a focused option (spec §9.2 shortcut scope), and the keys of a mode. Runs in the capture phase, before
     * the canvas's arrow keys and Enter, so a mode takes them; F and A are ignored while a mode is on. Keys in a field
     * or a menu are left to it.
     */
    function onKeydown(event) {
      if (event.defaultPrevented || event.target.closest(TYPING_TARGETS) || event.target.closest(MENUS)) return;
      const uml = mode === null && surface.uml ? surface.uml() : null;
      if (uml) {
        if (uml.onKey(event)) event.preventDefault();
        return;
      }
      if (mode !== null) {
        if (modeKey(event)) event.preventDefault();
        return;
      }
      const option = optionAt(event.target);
      if (option === null || event.target !== option) return;
      const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
      const elementId = elementIdOf(option);
      if (event.key === 'F2' && plain && !event.shiftKey) beginRename(elementId);
      else if ((event.key === 'Delete' || event.key === 'Backspace') && plain) deleteFocused(option);
      else if (drag.isLetter(event, 'm') && !event.shiftKey) startMoveMode(elementId);
      else if (drag.isLetter(event, 'c') && !event.shiftKey) startConnectMode({ sourceId: elementId });
      else if ((event.key === 'F10' && event.shiftKey && plain) || (event.key === 'ContextMenu' && plain)) {
        openElementMenu(elementId, { anchor: option, returnFocus: option });
      } else return;
      event.preventDefault();
    }

    function modeKey(event) {
      if (drag.isLetter(event, 'f') || drag.isLetter(event, 'a')) return true;
      if (mode.kind === 'move') return moveModeKey(event);
      const option = optionAt(event.target);
      if (event.key === 'Enter' && option !== null) {
        pick(option);
        return true;
      }
      return false;
    }

    // ---- Connect handles and "⋯" buttons: shown on the selected and the hovered element ------------------------

    /** The element a press or hover on an option, a connect handle, or a "⋯" button belongs to, or null. */
    function affordanceIdAt(target) {
      if (!target || !target.closest) return null;
      const option = optionAt(target);
      if (option) return elementIdOf(option);
      const affordance = target.closest('[data-c4-handle], [data-c4-more]');
      if (!affordance || !region.contains(affordance)) return null;
      return affordance.getAttribute('data-c4-handle') || affordance.getAttribute('data-c4-more');
    }

    function setHovered(elementId) {
      if (elementId === hoveredId) return;
      hoveredId = elementId;
      showAffordances();
    }

    function showAffordances() {
      const svg = surface.svg();
      if (svg === null) return;
      const selection = state.getSelection();
      const selectedId = selection && selection.elementId;
      svg.querySelectorAll('[data-c4-handle], [data-c4-more]').forEach((affordance) => {
        const id = affordance.getAttribute('data-c4-handle') || affordance.getAttribute('data-c4-more');
        affordance.classList.toggle('is-visible', id === selectedId || id === hoveredId);
      });
    }

    // ---- The one pointer gesture on the canvas (Ruling 4) ------------------------------------------------------

    function startGesture(event, press) {
      // The scope header's tray has its own controls and drags (startRefineDrag); a press there is not on the drawing.
      if (event.target.closest('[data-c4-scope-header]')) return null;
      if (mode !== null) return pressInMode(event);
      const handle = event.target.closest('[data-c4-handle]');
      if (handle && region.contains(handle)) return pressHandle(handle.getAttribute('data-c4-handle'), event, press);
      const more = event.target.closest('[data-c4-more]');
      if (more && region.contains(more)) {
        const elementId = more.getAttribute('data-c4-more');
        return drag.createDragSession({ event, onBegin: () => false,
          onTap: () => openElementMenu(elementId, { anchor: more, returnFocus: surface.optionFor(elementId) }) });
      }
      const option = optionAt(event.target);
      return option ? pressElement(option, event, press) : null;
    }

    // ---- Redrawing --------------------------------------------------------------------------------------------

    /**
     * After a redraw the options are new: a connect mode marks its targets again; a Move ends (its ghost belonged
     * to the old drawing); a text being edited in place is laid over its text again when it is still drawn.
     */
    function onDraw(kind) {
      if (mode && mode.kind === 'connect' && mode.sourceId !== null) marks.show(connectTargets(mode.sourceId));
      if (mode && mode.kind === 'move' && kind === 'drawing') {
        leaveMode();
        announce('Move canceled: the drawing changed.');
      }
      text.onDraw();
      showAffordances();
    }

    function focusElement(elementId) {
      const option = surface.optionFor(elementId);
      if (option) surface.focusOption(option);
    }

    // ---- Wiring -----------------------------------------------------------------------------------------------

    const controller = new AbortController();
    const listen = { signal: controller.signal };
    region.addEventListener('keydown', onKeydown, { signal: controller.signal, capture: true });
    region.addEventListener('contextmenu', onContextMenu, listen);
    region.addEventListener('pointermove', onPointerMove, listen);
    region.addEventListener('pointerleave', () => setHovered(null), listen);
    region.addEventListener('dblclick', onDoubleClick, listen);
    const stops = [
      surface.pointer.use({ start: startGesture }),
      surface.onDraw(onDraw),
      state.on('selection', showAffordances),
      actions.attachCanvas({
        beginRename, startPaletteDrag, startRefineDrag, startConnect: startConnectFromToolbar, endMode: endModeAsCancelled,
        drawnCorners, roomMakers, uml: () => (surface.uml ? surface.uml() : null),
      }),
    ];
    showAffordances();

    return {
      helpKeys: HELP_KEYS,
      destroy() {
        leaveMode();
        text.end();
        marks.clear();
        stops.forEach((stop) => stop());
        controller.abort();
      },
    };
  }

  // ---- Geometry (pure) ---------------------------------------------------------------------------------------------

  /**
   * Snaps a box's start `value` on one axis: to the edge or centre of another box within ALIGN_UNITS (with the guide's
   * position and the span it runs along), else to the grid. `axis` is 'x' or 'y'; `extent` 'width' or 'height'.
   */
  function align(value, size, others, axis, extent) {
    const own = [0, size / 2, size];
    let best = null;
    others.forEach((other) => {
      const otherSize = other[extent];
      [other[axis], other[axis] + otherSize / 2, other[axis] + otherSize].forEach((line) => {
        own.forEach((offset) => {
          const distance = Math.abs(value + offset - line);
          if (distance <= ALIGN_UNITS && (best === null || distance < best.distance)) {
            const across = axis === 'x' ? 'y' : 'x';
            const acrossSize = axis === 'x' ? other.height : other.width;
            best = { distance, value: line - offset, guide: line, span: [other[across], other[across] + acrossSize] };
          }
        });
      });
    });
    return best || { value: Math.round(value / GRID_UNITS) * GRID_UNITS, guide: null };
  }

  function inside(box, event) {
    return event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
  }

  function pointOf(event) {
    return { x: event.clientX, y: event.clientY };
  }

  return { createCanvasEditing };
});
