(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../c4-core.js'), function () {
      return { actionsShared: require('./c4-editor-actions-shared.js') };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.actionsCanvas = factory(root.ArchUMLC4, function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (C4, editorParts) {
  'use strict';

  // The palette and Add relationship hooks of the toolbar (Ruling 3), a unit of the shared commands
  // (c4-editor-actions.js). The canvas registers its interactive modes (in-place rename, palette and carry-down drags,
  // connecting) with `attachCanvas`, so a tile works the same from the palette, the Add menu, key A, and the empty
  // scope's button; without a canvas an added element is still selected, and the inspector's Name field renames it.
  // Where the canvas drew a pinned element (`drawnCorners`, `landingOf`) is read here too, for every pin's announcement.
  // On an edited UML-notation view the canvas's editing part (`umlEditing()`) adds a tile's element, says where a box
  // is kept, and resets the view's layout (UML-view editing spec §6, §7.6), so the palette, the Position section, and
  // Reset layout reach it here.

  /**
   * The palette and canvas commands. `actions` is the shared context of createActions (state, reading the model,
   * results). Returns them with `drawnCorners`, `landingOf`, and `forgetCanvas()` (the actions are destroyed).
   */
  function createCanvasCommands(actions) {
    const { options, state, announce, model, elementOf, nameOf, readOnlyReason, succeed, refuse, dispatch } = actions;
    const { PARENT_TYPE, TYPE_NAMES, namesList, placeholderName } = editorParts().actionsShared;
    // The canvas's interactive modes, while a canvas is attached (attachCanvas).
    let canvasModes = null;

    /**
     * Registers the canvas's modes `{ beginRename(id), startPaletteDrag(tile, event), startRefineDrag(refinement, event),
     * startConnect(use), endMode(), drawnCorners(), roomMakers(), uml() }`; `uml` gives the editing part of an edited
     * UML-notation view (`{ palette(), addTile(tile), resetLayout(), positionFor(selection), … }`), or null;
     * `endMode` ends a Move or Add relationship as cancelled and returns the sentence that says so ('' when none was on);
     * `drawnCorners` gives the open drawing's element corners, `Map<id, [x, y]>` in the frame of pins, and
     * `roomMakers` the ids of the elements it drew aside for a pinned element (a `Set`).
     */
    function attachCanvas(modes) {
      canvasModes = modes;
      return function detach() {
        if (canvasModes === modes) canvasModes = null;
      };
    }

    /** The editing part of the edited UML-notation view the canvas draws, or null (no canvas, another view). */
    function umlEditing() {
      return canvasModes && typeof canvasModes.uml === 'function' ? canvasModes.uml() : null;
    }

    /** The open drawing's element corners (`Map<id, [x, y]>`, the frame of pins), or null without a canvas. */
    function drawnCorners() {
      return canvasModes ? canvasModes.drawnCorners() : null;
    }

    /**
     * What the drawing did with a pin, for its announcement (spec §9.2: a drop lands where it is dropped, and the
     * boxes it covers make room): `nudged` (": it is drawn at x, y, nudged down so it does not overlap another pinned
     * element", when only another pin's overlap kept it off its pin) and `madeRoom` (" A and B moved to make room.",
     * the other elements that this pin moved aside: drawn elsewhere than before and marked by the drawing as having
     * made room, so an element that only follows a new element into the layout is not named). `before` holds
     * drawnCorners() from before the pin; both are '' without a canvas.
     */
    function landingOf(elementId, pin, before) {
      const after = drawnCorners();
      if (!before || !after || !after.has(elementId)) return { nudged: '', madeRoom: '' };
      const [x, y] = after.get(elementId);
      const direction = y > pin[1] ? 'down' : y < pin[1] ? 'up' : x > pin[0] ? 'right' : 'left';
      const nudged = x === pin[0] && y === pin[1] ? ''
        : `: it is drawn at ${x}, ${y}, nudged ${direction} so it does not overlap another pinned element`;
      const madeRoomFor = canvasModes.roomMakers();
      const moved = [...after.keys()].filter((id) => id !== elementId && madeRoomFor.has(id)
        && before.has(id) && String(before.get(id)) !== String(after.get(id)));
      const madeRoom = moved.length === 0 ? '' : ` ${namesList(moved.map(nameOf))} moved to make room.`;
      return { nudged, madeRoom };
    }

    /**
     * A tile was chosen (a click or key on a tile, the Add menu, or the empty scope's button; `use.source` says
     * which): adds what it stands for at an automatic position, selected, with its name ready for in-place editing
     * (spec §9.2 "Add details"). A press alone never adds: a drag starts through `startPaletteDrag`.
     */
    function activatePaletteTile(tile, use = {}) {
      const problem = readOnlyReason();
      if (problem) return refuse(problem);
      // A tile of a UML view's own tools (`tile.tool`) is the view's: an addition named in place (spec §6 rule 2, §7.7),
      // or a line tool's drawing. How it was chosen (`use`) decides between the pointer's and the keyboard's path (§7.4).
      const uml = tile.tool ? umlEditing() : null;
      if (uml) return uml.addTile(tile, use);
      // A Move or Add relationship still on would take the next click or Enter, so the add ends it and says so.
      const endedMode = canvasModes ? canvasModes.endMode() : '';
      const result = tile.kind === 'element' ? addElementFromTile(tile, null) : addFromSupportingTile(tile);
      if (endedMode && result.message) announce(`${endedMode} ${result.message}`);
      if (result.ok && tile.kind === 'element' && canvasModes) canvasModes.beginRename(result.elementId);
      return result;
    }

    /**
     * A primary press on an element tile, or on a tile of a UML view's own tools (`tile.tool`): the canvas follows it as
     * a drag (spec §9.2 "Add an element"; UML-view editing spec §6 rule 2).
     */
    function startPaletteDrag(tile, event) {
      // A UML view's line tool is not dragged: it draws between two boxes after it is chosen (`tile.line`).
      if (readOnlyReason() || (tile.kind !== 'element' && !tile.tool) || tile.line || !canvasModes) return null;
      return canvasModes.startPaletteDrag(tile, event);
    }

    /**
     * A primary press on a carry-down tray item (spec §9.2 "Refine a parent responsibility"): the canvas follows it as
     * a drag onto one of the scope's parts. `refinement` is the tray's `{ label, scopeName, childIds, refine }`.
     */
    function startRefineDrag(refinement, event) {
      if (readOnlyReason() || !canvasModes) return null;
      return canvasModes.startRefineDrag(refinement, event);
    }

    /** The toolbar's Add relationship: the canvas asks for the source (the selected element, if any) and the target. */
    function startAddRelationship(use = {}) {
      const problem = readOnlyReason();
      if (problem) return refuse(problem);
      if (!canvasModes) return refuse('Error: Relationships are added on the drawing; open a view that has one.');
      canvasModes.startConnect(use);
      return { ok: true };
    }

    /**
     * Adds the element a tile stands for, named by its placeholder ("New container", "New class"; its first rename gives
     * it the id of its name, c4-editor-actions-ids.js), inside the scope of the tile's view (or the selected
     * element, for a type of another level). With `position` (`{ viewKey, x, y }`, a top-left corner in the view's
     * layout) it is pinned there in the same undo step (Ruling 14: a dry run learns its id). Resolves
     * `{ ok, elementId }`.
     */
    function addElementFromTile(tile, position) {
      const problem = readOnlyReason();
      if (problem) return refuse(problem);
      const type = tile.elementType;
      const noun = TYPE_NAMES[type];
      const parentId = parentForNew(type, tile.scopeId);
      if (parentId === undefined) {
        return refuse(`Error: A ${noun} goes inside a ${TYPE_NAMES[PARENT_TYPE[type]]}; select one in the outline first.`);
      }
      const name = placeholderName(type);
      const add = { op: 'addElement', parentId, type, name };
      const where = parentId === null ? '' : ` inside ${nameOf(parentId)}`;
      if (!position) {
        const result = dispatch(add, `Add ${noun}`);
        return result.ok ? succeed(`Added ${name}${where}.`, { elementId: result.selection.elementId }) : result;
      }
      const dryRun = C4.edit(state.getDesign(), add);
      if (dryRun.error) return refuse(`Error: ${dryRun.message}.`, dryRun.error);
      const elementId = dryRun.selection.elementId;
      const pin = { op: 'pinPosition', viewKey: position.viewKey, elementId, x: Math.round(position.x), y: Math.round(position.y) };
      const before = drawnCorners();
      const result = dispatch({ op: 'batch', commands: [add, pin] }, `Add ${noun}`);
      if (!result.ok) return result;
      state.select(elementId);
      const landing = landingOf(elementId, [pin.x, pin.y], before);
      return succeed(`Added ${name}${where}${landing.nudged}; position pinned.${landing.madeRoom}`, { elementId });
    }

    /**
     * The parent of a new element of `type`: none for people and systems; the view's scope when it is of the parent
     * type; else the selected element when it is. Undefined when there is no fitting parent.
     */
    function parentForNew(type, scopeId) {
      const parentType = PARENT_TYPE[type];
      if (!parentType) return null;
      const scope = scopeId ? elementOf(scopeId) : null;
      if (scope && scope.type === parentType) return scope.id;
      const selection = state.getSelection();
      const selected = selection && selection.elementId ? elementOf(selection.elementId) : null;
      return selected && selected.type === parentType ? selected.id : undefined;
    }

    /**
     * The tiles of dynamic and deployment views (spec §9.2): a node or an infrastructure node is added to the view's
     * environment, a fragment ("opt") at the end of the view's scenario. A step and a host need choices the form
     * asks for, so they select the scenario or environment and open the inspector.
     */
    function addFromSupportingTile(tile) {
      const scopeId = tile.scopeId;
      if (tile.kind === 'node' || tile.kind === 'infrastructure-node') {
        const infrastructure = tile.kind === 'infrastructure-node';
        const name = placeholderName('node', infrastructure ? 'infrastructure' : null);
        const result = dispatch({ op: 'addNode', environmentId: scopeId, kind: infrastructure ? 'infrastructure' : null, name }, `Add ${name}`);
        if (!result.ok) return result;
        revealInspector();
        return succeed(`Added ${name}. Name it in the inspector's Name field.`);
      }
      if (tile.kind === 'fragment') {
        const scenario = model().scenarios.get(scopeId);
        const result = dispatch({ op: 'addFragment', scenarioId: scopeId, containerPath: [], index: scenario.steps.length, operator: 'opt' },
          'Add fragment');
        if (!result.ok) return result;
        revealInspector();
        return succeed('Added an optional fragment at the end of the scenario. Give it its condition in the inspector.');
      }
      state.select(tile.kind === 'step' ? { scenarioId: scopeId } : { environmentId: scopeId });
      revealInspector();
      return succeed(tile.kind === 'step'
        ? 'Add the step in the inspector: choose who sends it, who receives it, and what is asked.'
        : 'Choose the node and the containers it hosts in the inspector.', { unchanged: true });
    }

    function revealInspector() {
      if (options.layout && typeof options.layout.revealRegion === 'function') options.layout.revealRegion('inspector');
    }

    /**
     * Reset layout on an edited UML-notation view (spec §6 rule 3): the view's whole layout entry goes in one undo
     * step, said with the layout planner's words. Resolves the verdict, or a refusal without a UML view edited here.
     */
    function resetUmlLayout() {
      const problem = readOnlyReason();
      if (problem) return Promise.resolve(refuse(problem));
      const uml = umlEditing();
      return uml ? uml.resetLayout() : Promise.resolve(refuse('Error: This view keeps no layout here.'));
    }

    function forgetCanvas() {
      canvasModes = null;
    }

    return {
      attachCanvas, drawnCorners, landingOf, activatePaletteTile, startPaletteDrag, startRefineDrag, startAddRelationship,
      addElementFromTile, umlEditing, resetUmlLayout, forgetCanvas,
    };
  }

  return { createCanvasCommands };
});
