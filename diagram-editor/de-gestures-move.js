(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./de-geometry.js'), require('./de-scene.js'), require('./de-operations.js'));
  } else {
    var parts = root.ArchUMLDiagramEditorParts = root.ArchUMLDiagramEditorParts || {};
    // A second load of the module replaces nothing (spec §2.2).
    if (!parts.gesturesMove) parts.gesturesMove = factory(parts.geometry, parts.scene, parts.operations);
  }
})(typeof self !== 'undefined' ? self : this, function (geometry, scene, operations) {
  'use strict';

  // The move gestures of a session (UML-view editing spec §2.2, §3.8; plan Task 23): the gesture factory
  // `element-move` (a press on a drawn box moves it, and the other selected boxes with it, with smart guides and the
  // grid), the drop of a route edit's bends, and the session shape every drag of the module takes (dragSession,
  // pressTaken).
  //
  // A move asks the adapter's advice, `commands.can`, when it starts and when it is dropped, never per pointer move
  // (spec §3.4). A refusal at the start announces its sentence and takes the press; at the drop it is handled as a
  // refused apply: the drawing is made again and the sentence announced. The text adapter refuses nothing a gesture
  // starts with, so the UML editor behaves as before.
  //
  // A move has an open end, its parent (spec §7.4; plan Task 38): it asks the adapter's `targets` once, when it starts,
  // and the scene marks each candidate. A drop on a box marked possible puts the moved box into it (element.reparent);
  // a drop on any other box puts the preview back and says why when the adapter refuses. Without advice (the text
  // adapter answers null) nothing is marked and every drop moves, as before. The other gestures with an open end (a
  // new line's `to`, a palette element's `into`) ask and mark through this part's offerTargets.

  // What this file uses of the parts before it in diagram-editor/manifest.json.
  var alignedCoordinate = geometry.alignedCoordinate;
  var alignmentGuides = geometry.alignmentGuides;
  var anchoredThreePointRoute = geometry.anchoredThreePointRoute;
  var anchoredTwoPointRoute = geometry.anchoredTwoPointRoute;
  var clearTargetMarks = scene.clearTargetMarks;
  var constrainedPortPosition = geometry.constrainedPortPosition;
  var containsBox = geometry.containsBox;
  var containsPoint = geometry.containsPoint;
  var cssAttrEscape = scene.cssAttrEscape;
  var elementSvgBox = scene.elementSvgBox;
  var layoutElementsForId = scene.layoutElementsForId;
  var markTargets = scene.markTargets;
  var refused = operations.refused;
  var snapCoordinate = geometry.snapCoordinate;
  var targetRefId = scene.targetRefId;
  var textOf = scene.textOf;

  /**
   * The move gestures.
   *
   * The functions came from the session in the inline script of _includes/uml-editor.html without a changed statement
   * (spec §3.6), except where noted. A part is made from the session's kit (createDiagramEditorSession): it takes the
   * values and the session's functions it uses when it is made, and what it uses of the other parts when the session
   * calls its link(), once every part and the pointer driver exist. Its members join the kit.
   * Changed statements: the reads of the document and the applies go through `kit.commands` (`commands.contents()`,
   * `commands.apply`), since a gesture holds no adapter (spec §2.1), and the two `commands.can` checks above.
   */
  function createMoveGestures(kit) {
    // What the session made this part with.
    var activityLabelForNode = kit.activityLabelForNode;
    var commands = kit.commands;
    var env = kit.env;
    var findEditableElements = kit.findEditableElements;
    var host = kit.host;
    var isSelectedAs = kit.isSelectedAs;
    var output = kit.output;
    var selectedLayout = kit.selectedLayout;
    var selectedLayoutPrimaryId = kit.selectedLayoutPrimaryId;
    var setSelectedLayoutId = kit.setSelectedLayoutId;
    var snapToggle = kit.snapToggle;
    var textGrammar = kit.textGrammar;
    // What the other parts and the pointer driver give this part, bound by link() once all of them exist.
    var activityNodeInfoForId, announce, applyConnectedRouteDeltas, applyRoutePoints, buildOperation, clonePoints,
      collectConnectedRoutes, documentType, editorCanvasPoint, layoutSetOperation, mergeConnectedRouteEntries,
      messageMoveOperation, movedBoxesOf, routeLayoutSetOperation, syncRouteOverlays, toolState;

    function collectPositions(editables) {
      var positions = {};
      var existingPositions = commands.contents().layoutPositions;
      for (var i = 0; i < editables.length; i++) {
        var item = editables[i];
        if (/^note:\d+$/.test(String(item.id || '')) && item.id !== selectedLayoutPrimaryId() && !existingPositions[item.id]) {
          continue;
        }
        if ((item.axis === 'branch-label' || item.axis === 'label') && item.id !== selectedLayoutPrimaryId()) {
          if (existingPositions[item.id]) {
            positions[item.id] = {
              x: existingPositions[item.id].x,
              y: existingPositions[item.id].y
            };
          }
          continue;
        }
        positions[item.id] = {
          x: item.axis === 'x' || item.axis === 'port' ? item.box.x + item.box.width / 2 : item.box.x,
          y: item.axis === 'port' ? item.box.y + item.box.height / 2 : item.box.y
        };
      }
      return positions;
    }
    function collectMoveParts(svg, box, id) {
      var dataEls = layoutElementsForId(svg, id);
      if (dataEls.length) {
        if ((documentType() || '') === 'component' && String(id).indexOf('.') === -1) {
          Array.prototype.slice.call(svg.querySelectorAll('[data-layout-id]')).forEach(function (el) {
            var childId = el.getAttribute('data-layout-id') || '';
            if (childId.indexOf(id + '.') === 0 && !el.closest('defs') && !el.closest('.uml-pg-edit-layer')) {
              dataEls.push(el);
            }
          });
        }
        if ((documentType() || '') === 'deployment') {
          // Contained elements are drawn as siblings of their node; show them
          // travelling with it, as they will once the move is saved.
          commands.contents().ownedElementIds(id, 'deployment').forEach(function (childId) {
            layoutElementsForId(svg, childId).forEach(function (el) {
              if (dataEls.indexOf(el) === -1) dataEls.push(el);
            });
          });
        }
        if ((documentType() || '') === 'gitgraph') {
          var explicitPositions = commands.contents().layoutPositions;
          Array.prototype.slice.call(svg.querySelectorAll('[data-layout-id][data-layout-anchor]')).forEach(function (el) {
            var labelId = el.getAttribute('data-layout-id') || '';
            if (el.getAttribute('data-layout-anchor') !== id || explicitPositions[labelId]) return;
            if (el.closest('defs') || el.closest('.uml-pg-edit-layer')) return;
            if (dataEls.indexOf(el) === -1) dataEls.push(el);
          });
        }
        if (movePartsShouldAugmentByLabel()) {
          dataEls = augmentActivityMoveElements(svg, dataEls, box, id);
        }
        return dataEls.map(function (el) {
          return {
            el: el,
            transform: el.getAttribute('transform') || '',
            styleTransform: el.style ? (el.style.transform || '') : ''
          };
        });
      }

      if (movePartsShouldAugmentByLabel()) {
        var activityEls = activityMoveElementsByLabel(svg, box, id);
        if (activityEls.length) {
          return activityEls.map(function (el) {
            return {
              el: el,
              transform: el.getAttribute('transform') || '',
              styleTransform: el.style ? (el.style.transform || '') : ''
            };
          });
        }
      }

      var selector = 'rect,circle,ellipse,polygon,path,line,polyline,text';
      return Array.prototype.slice.call(svg.querySelectorAll(selector)).filter(function (el) {
        if (el.closest('.uml-pg-edit-layer') || el.closest('defs')) return false;
        var b = elementSvgBox(svg, el);
        if (!b) return false;
        return containsBox(box, b, 3) || containsPoint(box, b.x + b.width / 2, b.y + b.height / 2, 3);
      }).map(function (el) {
        return {
          el: el,
          transform: el.getAttribute('transform') || '',
          styleTransform: el.style ? (el.style.transform || '') : ''
        };
      });
    }
    function movePartsShouldAugmentByLabel() {
      var type = documentType() || '';
      return type === 'activity' || type === 'state';
    }
    function augmentActivityMoveElements(svg, elements, box, id) {
      var out = elements.slice();
      var byElement = [];
      function add(el) {
        if (!el || byElement.indexOf(el) !== -1) return;
        byElement.push(el);
        out.push(el);
      }
      elements.forEach(function (el) { byElement.push(el); });
      activityMoveElementsByLabel(svg, box, id).forEach(add);
      return out;
    }
    function activityMoveElementsByLabel(svg, box, id) {
      var nodeInfo = (documentType() || '') === 'activity' ? activityNodeInfoForId(id) : null;
      var labels = [id, nodeInfo && activityLabelForNode(nodeInfo)].filter(Boolean).map(function (s) {
        return String(s).replace(/\s+/g, ' ').trim();
      });
      var exactTexts = Array.prototype.slice.call(svg.querySelectorAll('text')).filter(function (text) {
        if (text.closest('.uml-pg-edit-layer') || text.closest('defs')) return false;
        var content = textOf(text).replace(/\s+/g, ' ').trim();
        if (labels.indexOf(content) === -1) return false;
        var tb = elementSvgBox(svg, text);
        if (!tb) return false;
        return containsPoint(box, tb.x + tb.width / 2, tb.y + tb.height / 2, 6);
      });
      if (!exactTexts.length) return [];

      var out = exactTexts.slice();
      var shapes = Array.prototype.slice.call(svg.querySelectorAll('rect,circle,ellipse,polygon,path')).filter(function (shape) {
        if (shape.closest('.uml-pg-edit-layer') || shape.closest('defs')) return false;
        if (shape.getAttribute('data-layout-route-id')) return false;
        if (shape.closest('[data-layout-route-id]')) return false;
        if (shape.getAttribute('data-layout-route-decorative') === 'true') return false;
        if (shape.tagName.toLowerCase() === 'path' && (shape.getAttribute('fill') || 'none') === 'none') return false;
        var sb = elementSvgBox(svg, shape);
        if (!sb) return false;
        return exactTexts.some(function (text) {
          var tb = elementSvgBox(svg, text);
          if (!tb) return false;
          return containsPoint(sb, tb.x + tb.width / 2, tb.y + tb.height / 2, 4);
        });
      });
      shapes.forEach(function (shape) {
        if (out.indexOf(shape) === -1) out.push(shape);
      });
      return out;
    }
    // A drag whose record R0 kept in a drag-state variable: `state` holds the record until the drop
    // clears it, `update(session, event, finish)` follows a move or the release, and `clear(session)`
    // puts the drawing back when it is cancelled. `slot` names that variable (the pointer driver).
    function dragSession(slot, state, update, clear) {
      var session = {
        slot: slot,
        state: state,
        move: function (event) { update(session, event, false); },
        end: function (event) { update(session, event, true); },
        cancel: function () { clear(session); }
      };
      return session;
    }
    // A press a gesture has handled without a drag (a selection, a tool's click, an in-place edit): it
    // takes the press, so no later gesture does, and does nothing with the moves or the release.
    function pressTaken() {
      return { move: function () {}, end: function () {}, cancel: function () {} };
    }
    // The element move with smart guides: a plain press on a drawn item drags it (and every other selected
    // item with it) once the pointer has moved 3 px; the release stores the positions.
    // The adapter's refusal of a move of `item` from where it is drawn, asked when the move starts, or null.
    function refusalOfMoveStart(item) {
      var positions = {};
      positions[item.id] = { x: item.box.x, y: item.box.y };
      var verdict = commands.can(buildOperation('layout.set', { positions: positions, routes: [] }, {}, null));
      return verdict.ok ? null : verdict;
    }
    // A refusal said as a result is, with its verdict, so a host can show the verdict's offer (spec §2.4 `announce`;
    // plan Task 39). The classic host reads the sentence alone, so what it says is unchanged.
    function announceRefusal(verdict) {
      announce(verdict.message, false, verdict);
    }
    function startElementMove(event, press) {
      if (press.site !== 'hitbox' || toolState.activeTool) return null;
      var refusedAtStart = refusalOfMoveStart(press.item);
      if (refusedAtStart) {
        announceRefusal(refusedAtStart);
        return pressTaken();
      }
      var session = moveSession(press, event);
      if (event.currentTarget && event.currentTarget.setPointerCapture) {
        // R0 captured after it had stored the drag, so a capture that throws (a press with no active
        // pointer) still leaves the move running; the error is still reported, a moment later.
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch (error) {
          env.schedule(function () { throw error; }, 0);
        }
      }
      return session;
    }
    // The session of a move of `press.item`, grabbed by the pointer event `grab` (its place on the page counts the 3 px
    // a drag goes before it moves anything) or, without a press (null), at the centre of its box, moving at once. The
    // item is selected, unless it is already, and every selected box moves with it.
    function moveSession(press, grab) {
      var svg = press.svg;
      var layer = press.layer;
      var item = press.item;
      var rect = press.rect;
      var editables = press.editables;
      // Plain click on a hitbox already in the selection? Keep selection,
      // but start drag of all selected elements (group move).
      var alreadySelected = isSelectedAs(item.id, 'node');
      if (!alreadySelected) {
        setSelectedLayoutId(item.id, 'node');
      }
      var start = grab ? editorCanvasPoint(svg, grab.clientX, grab.clientY)
        : { x: item.box.x + item.box.width / 2, y: item.box.y + item.box.height / 2 };
      // Build group drag state if multiple selected.
      var allPositions = collectPositions(editables);
      var groupItems = [];
      selectedLayout.all().forEach(function (selected) {
        if (selected.kind !== 'node') return;
        var sid = selected.id;
        var ed = editables.find(function (e) { return e.id === sid; });
        if (!ed) return;
        groupItems.push({
          item: ed,
          rect: layer.querySelector('.uml-pg-edit-hitbox[data-layout-id="' + cssAttrEscape(sid) + '"]'),
          parts: collectMoveParts(svg, ed.box, sid),
          connectedRoutes: collectConnectedRoutes(svg, sid, ed)
        });
      });
      return dragSession('drag', {
        svg: svg,
        layer: layer,
        rect: rect,
        item: item,
        editables: editables,
        targets: offerParentTargets(layer, item, editables),
        start: start,
        startClient: grab ? { x: grab.clientX, y: grab.clientY } : null,
        box: item.box,
        positions: allPositions,
        parts: collectMoveParts(svg, item.box, item.id),
        connectedRoutes: collectConnectedRoutes(svg, item.id, item),
        groupItems: groupItems.length > 1 ? groupItems : null
      }, updateDrag, clearMove);
    }
    // A cancelled move or route edit: R0 dropped its drag state and let the next drawing put it back. A move's target
    // marks go with it.
    function clearMove(gesture) {
      if (gesture.state) forgetTargets(gesture.state);
      gesture.state = null;
    }
    // ─── Open ends (spec §3.4 `targets`, §7.4 "Target marks"; plan Task 38) ───
    // A gesture with an open end (a move's `parent`, a new line's `to`, a palette element's `into`) asks the adapter's
    // advice once, when it starts, and the scene marks each candidate over its drawn box. The other gesture parts reach
    // these through the kit.
    // The candidates of the running gesture in keyboard order, or null when its adapter gave no advice.
    var markedTargets = null;
    /**
     * Asks the adapter, once, about the candidates for the open end of `request` (an operation without that end, plus
     * `open`), and marks them in `layer` over the boxes of `editables` (by default the items drawn in `svg`). Returns
     * the candidates in keyboard order, or null without advice; the gesture keeps them for its drop and gives them
     * back to withdrawTargets when it ends.
     */
    function offerTargets(svg, layer, request, editables) {
      markedTargets = null;
      var advice = layer ? commands.targetsFor(request) : null;
      if (!advice) return null;
      var drawn = editables || findEditableElements(svg);
      markedTargets = markTargets(layer, advice, function (id) {
        var item = drawn.find(function (candidate) { return candidate.id === id; });
        return item ? item.box : null;
      }, env.document);
      return markedTargets;
    }
    /** Takes away the marks of `candidates` (an offerTargets answer) from `layer`; nothing for null. */
    function withdrawTargets(layer, candidates) {
      if (!candidates) return;
      clearTargetMarks(layer);
      if (markedTargets === candidates) markedTargets = null;
    }
    /** The candidate of `candidates` marked over the drawn item `id`, or null (also without advice). */
    function markedCandidate(candidates, id) {
      return (candidates || []).find(function (marked) { return targetRefId(marked.ref) === id; }) || null;
    }
    /**
     * Whether a drop on the drawn item `id` lands on a candidate marked not possible. Then it says why: the refusal
     * sentence of `can` for `operation` (the gesture's operation with that end, when it can be built), else the
     * candidate's short reason; the gesture applies nothing and puts its preview back. False for every other drop.
     */
    function refuseMarkedDrop(candidates, id, operation) {
      var candidate = markedCandidate(candidates, id);
      if (!candidate || candidate.ok) return false;
      var verdict = operation ? commands.can(operation) : null;
      var message = (verdict && !verdict.ok && verdict.message) || candidate.summary;
      if (message) announce(message, false);
      return true;
    }
    // The move's open end is its parent: where the moved `item` could go.
    function offerParentTargets(layer, item, editables) {
      return offerTargets(null, layer, { op: 'element.reparent', ref: item.id, open: 'parent' }, editables);
    }
    function forgetTargets(dragState) {
      withdrawTargets(dragState.layer, dragState.targets);
    }
    // The drawn box a move with advice is dropped on at `point`: the smallest one holding it that does not move with
    // the drag and is not drawn inside the moved box; null for empty canvas. Ports and labels hold nothing.
    function landingBox(dragState, point) {
      var moving = [dragState.item.id].concat((dragState.groupItems || []).map(function (g) { return g.item.id; }));
      var hits = dragState.editables.filter(function (drawn) {
        if (moving.indexOf(drawn.id) !== -1) return false;
        if (drawn.axis === 'port' || drawn.axis === 'label' || drawn.axis === 'branch-label') return false;
        if (containsBox(dragState.box, drawn.box, 0.5)) return false;
        return containsPoint(drawn.box, point.x, point.y, 0);
      });
      hits.sort(function (a, b) { return a.box.width * a.box.height - b.box.width * b.box.height; });
      return hits[0] || null;
    }
    // A drop on `landing`: the moved box goes into it when the advice marked it possible and the adapter agrees now;
    // otherwise the drawing is made again, which puts the preview back, and the adapter's refusal, if any, is said.
    function dropOnTarget(dragState, landing) {
      var candidate = markedCandidate(dragState.targets, landing.id);
      var reparent = buildOperation('element.reparent', { ref: dragState.item.id, parent: landing.id }, {}, 'drag:reparent:' + dragState.item.id);
      var verdict = commands.can(reparent);
      if (candidate && candidate.ok && verdict.ok) {
        return whenSettled(commands.apply(reparent), function (settled) {
          if (!settled.ok) {
            host.redraw();
            announceRefusal(settled);
          }
          return settled;
        });
      }
      host.redraw();
      if (verdict.ok) return refused('cancelled', null, null, null);
      announceRefusal(verdict);
      return verdict;
    }
    /**
     * Snap a git-graph branch label / HEAD to the nearest commit.
     *
     * @param {string} draggedId   The branch label id, of the form `branch:<name>`
     *                             (a regular commit id triggers no snapping).
     * @param {object} positions   Map of id → {x, y} from the drag.
     * @returns {string|null}      Rewritten source if a snap happened.
     */
    function snapBranchLabelToCommit(draggedId, positions) {
      var match = String(draggedId || '').match(/^branch:(.+)$/);
      if (!match) return null;
      var branchName = match[1];
      var dragPos = positions[draggedId];
      if (!dragPos) return null;

      // Collect commit ids and their (final-position) coordinates.
      var commits = [];
      Object.keys(positions).forEach(function (id) {
        if (id === draggedId) return;
        if (/^branch:/.test(id)) return;
        commits.push({ id: id, pos: positions[id] });
      });
      if (!commits.length) return null;

      // Find nearest commit by Euclidean distance.
      var nearest = null, bestDist = Infinity;
      commits.forEach(function (c) {
        var dx = dragPos.x - c.pos.x;
        var dy = dragPos.y - c.pos.y;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d < bestDist) { bestDist = d; nearest = c.id; }
      });
      if (!nearest) return null;

      // Rewrite the `branch <name>` declaration to `branch <name> from <nearest>:`
      // (or `branch <name> at <nearest>:` — both forms are valid in ArchUML).
      var reading = commands.contents();
      var lines = reading.lines.slice();
      var changed = false;
      for (var i = 0; i < lines.length; i++) {
        var t = lines[i].trim();
        // Match `branch <name>...` (with optional ` from <commit>` / ` at <commit>` and trailing colon).
        var m = t.match(/^branch\s+([^:\s]+)(?:\s+(?:from|at)\s+\S+)?\s*:?\s*$/i);
        if (m && m[1] === branchName) {
          lines[i] = 'branch ' + branchName + ' from ' + nearest + ':';
          changed = true;
          break;
        }
      }
      if (!changed) {
        // Maybe it's a `head <branch>` — point HEAD at this commit instead.
        for (var j = 0; j < lines.length; j++) {
          var ht = lines[j].trim();
          if (/^head\s+/i.test(ht)) {
            lines[j] = 'head ' + nearest;
            changed = true;
            break;
          }
        }
      }
      if (!changed) return null;
      // Drop any explicit @pos for the branch label so the renderer re-anchors it.
      var freshPositions = {};
      Object.keys(positions).forEach(function (k) { if (k !== draggedId) freshPositions[k] = positions[k]; });
      var routes = reading.layoutRoutes;
      return textGrammar.writePositionsIntoSource(lines.join('\n'), 'gitgraph', freshPositions, routes, env.bundle);
    }
    /**
     * The order of the sequence lifelines by their final x-positions after a drag, or null when the
     * drag leaves the order as it is or a lifeline has no declaration line to move (then the drag only
     * moves positions). The rewrite of lifeline.reorder moves the declaration lines.
     */
    function lifelineOrderAfterDrag(draggedId, positions) {
      // Collect every participant/actor id with its final x coordinate.
      var reading = commands.contents();
      var ids = reading.elements
        .filter(function (e) { return e.axis === 'order'; })
        .map(function (e) { return e.id; });
      if (ids.length < 2 || ids.indexOf(draggedId) === -1) return null;
      // Sort by final x.
      var ordered = ids.slice().sort(function (a, b) {
        var pa = positions[a] ? positions[a].x : 0;
        var pb = positions[b] ? positions[b].x : 0;
        return pa - pb;
      });
      // Same order? Nothing to do.
      var same = ordered.length === ids.length && ordered.every(function (id, i) { return id === ids[i]; });
      if (same) return null;
      return reading.lifelineDeclarations(ids) ? ordered : null;
    }
    // The fields of the lifeline.reorder a head's drop builds: the new `order`, and `moved`, the dragged lifeline, for
    // an adapter whose reading says it takes it (`reorderNamesMoved`): when two neighbours swap, either one's move
    // gives the order, so the order alone does not say which of them the announcement names. The text adapter does
    // not take it, and its operation stays as the corpus records it.
    function lifelineReorderFields(order, draggedId) {
      return commands.contents().reorderNamesMoved ? { order: order, moved: draggedId } : { order: order };
    }
    function alignmentBoxesForDrag(state) {
      if (!state.alignmentBoxes) {
        state.alignmentBoxes = findEditableElements(state.svg).filter(function (item) {
          return item.axis === 'xy' && item.id !== state.item.id && !isSelectedAs(item.id, 'node');
        }).map(function (item) { return item.box; });
      }
      return state.alignmentBoxes;
    }
    function alignmentTolerance(svg) {
      var origin = editorCanvasPoint(svg, 0, 0);
      var offset = editorCanvasPoint(svg, 4, 4);
      return { x: Math.abs(offset.x - origin.x), y: Math.abs(offset.y - origin.y) };
    }
    function snapAlignedNodePosition(state, position) {
      var peers = alignmentBoxesForDrag(state);
      var tolerance = alignmentTolerance(state.svg);
      return {
        x: alignedCoordinate(position.x, state.box.width, peers, 'x', tolerance.x),
        y: alignedCoordinate(position.y, state.box.height, peers, 'y', tolerance.y)
      };
    }
    /**
     * Draw alignment-guide lines while dragging — show vertical/horizontal
     * dashed lines when the dragged element's centre or edge matches another's
     * within ~4 px. Cleared on each move.
     */
    function drawSmartGuides(dragState, visualDx, visualDy) {
      var svg = dragState.svg;
      var layer = svg.querySelector('.uml-pg-edit-layer');
      if (!layer) return;
      Array.prototype.slice.call(layer.querySelectorAll('.uml-pg-guide-line')).forEach(function (g) { g.remove(); });
      // Don't bother for ports / labels.
      if (dragState.item.axis === 'port' || dragState.item.axis === 'label' || dragState.item.axis === 'branch-label') return;
      var tolerance = alignmentTolerance(svg);
      if (snapToggle && snapToggle.checked && dragState.item.axis === 'xy') tolerance = { x: 0.01, y: 0.01 };
      var movedBox = {
        x: dragState.box.x + visualDx,
        y: dragState.box.y + visualDy,
        width: dragState.box.width,
        height: dragState.box.height
      };
      var others = [];
      Array.prototype.slice.call(layer.querySelectorAll('.uml-pg-edit-hitbox')).forEach(function (rect) {
        var id = rect.getAttribute('data-layout-id');
        if (id === dragState.item.id) return;
        if (isSelectedAs(id, 'node')) return; // skip group-moved siblings
        var b = {
          x: parseFloat(rect.getAttribute('x')),
          y: parseFloat(rect.getAttribute('y')),
          width: parseFloat(rect.getAttribute('width')),
          height: parseFloat(rect.getAttribute('height'))
        };
        if (isNaN(b.x) || isNaN(b.y) || isNaN(b.width) || isNaN(b.height)) return;
        others.push(b);
      });
      var ns = 'http://www.w3.org/2000/svg';
      function addLine(x1, y1, x2, y2) {
        var ln = env.document.createElementNS(ns, 'line');
        ln.setAttribute('class', 'uml-pg-guide-line');
        ln.setAttribute('x1', x1); ln.setAttribute('y1', y1);
        ln.setAttribute('x2', x2); ln.setAttribute('y2', y2);
        layer.appendChild(ln);
      }
      alignmentGuides(movedBox, others, tolerance).forEach(function (guide) {
        addLine(guide.x1, guide.y1, guide.x2, guide.y2);
      });
    }
    function clearSmartGuides() {
      var svg = output.querySelector('svg');
      if (!svg) return;
      var layer = svg.querySelector('.uml-pg-edit-layer');
      if (!layer) return;
      Array.prototype.slice.call(layer.querySelectorAll('.uml-pg-guide-line')).forEach(function (g) { g.remove(); });
    }
    function updateDrag(gesture, event, finish) {
      var dragState = gesture.state;
      if (!dragState) return;
      if (!dragState.hasMoved && dragState.startClient) {
        const distance = Math.hypot(event.clientX - dragState.startClient.x, event.clientY - dragState.startClient.y);
        if (distance < 3) {
          if (finish) {
            forgetTargets(dragState);
            gesture.state = null;
          }
          return;
        }
        dragState.hasMoved = true;
      }
      var now = editorCanvasPoint(dragState.svg, event.clientX, event.clientY);
      if (dragState.kind === 'route') {
        var routeDx = now.x - dragState.start.x;
        var routeDy = now.y - dragState.start.y;
        if (documentType() === 'sequence' && /^seqmsg:\d+$/.test(String(dragState.route.id || ''))) {
          var shiftedPoints = dragState.points.map(function (point) {
            return { x: point.x, y: point.y + routeDy };
          });
          applyRoutePoints(dragState.route, shiftedPoints);
          syncRouteOverlays(dragState.layer, dragState.route.id, shiftedPoints);
          if (finish) return dropMessage(gesture, routeDy, now.y);
          return;
        }
        var nextPoints = clonePoints(dragState.points);
        var si = dragState.segmentIndex;
        var a = dragState.points[si];
        var b = dragState.points[si + 1];
        var segDx = b.x - a.x;
        var segDy = b.y - a.y;
        var moveX = routeDx;
        var moveY = routeDy;

        if (Math.abs(segDx) >= Math.abs(segDy) * 1.4) {
          moveX = 0;
        } else if (Math.abs(segDy) >= Math.abs(segDx) * 1.4) {
          moveY = 0;
        }
        if (snapToggle && snapToggle.checked) {
          if (moveX) moveX = snapCoordinate(a.x + moveX) - a.x;
          if (moveY) moveY = snapCoordinate(a.y + moveY) - a.y;
        }
        if (dragState.lockedEndpoints && dragState.points.length === 2) {
          nextPoints = anchoredTwoPointRoute(dragState.points, moveX, moveY);
        } else if (dragState.lockedEndpoints && dragState.points.length === 3) {
          nextPoints = anchoredThreePointRoute(dragState.points, si, moveX, moveY);
        } else {
          nextPoints[si] = { x: a.x + moveX, y: a.y + moveY };
          nextPoints[si + 1] = { x: b.x + moveX, y: b.y + moveY };
        }
        applyRoutePoints(dragState.route, nextPoints);
        syncRouteOverlays(dragState.layer, dragState.route.id, nextPoints);

        if (finish) return dropRoutePoints(gesture, nextPoints);
        return;
      }
      var next = pointerPosition(dragState, now);
      dragState.pointer = now;
      return showMoveAt(gesture, next.x, next.y, finish);
    }
    // The drop of a message moved up or down by `dy` to height `canvasY` (spec §3.4 message.move, §5.6). No-movement
    // clicks should not trigger a reorder: the drop-Y can land just below the route's own Y and snap the message past
    // the next sibling, silently swapping their order on plain selection clicks. As a box's drop, the move is asked
    // about, then applied; a refused move puts the preview back and says why, and so does a drop that throws, before
    // the error goes on. Returns the verdict, or the apply's promise of it; null when nothing was dropped.
    function dropMessage(gesture, dy, canvasY) {
      var dragState = gesture.state;
      var verdict = null;
      try {
        if (Math.abs(dy) > 4) {
          var move = messageMoveOperation(dragState.route.id, dragState.svg, canvasY);
          var advice = commands.can(move);
          verdict = advice.ok ? commands.apply(move) : advice;
        }
      } finally {
        gesture.state = null;
        if (!verdict) host.redraw();
      }
      return verdict && whenSettled(verdict, function (settled) {
        if (settled.ok) {
          announce(settled.message, false, settled);
        } else {
          host.redraw();
          if (settled.message) announceRefusal(settled);
        }
        return settled;
      });
    }
    // The drop of a route edit or of a bend's move (spec §3.11): the line's points `points` are stored, or, when the
    // adapter refuses them, the drawing is made again and the refusal announced. Returns the verdict, or the apply's
    // promise of it.
    function dropRoutePoints(gesture, points) {
      var dragState = gesture.state;
      var bendDrop = routeLayoutSetOperation(dragState.svg, dragState.route, points, 'drag:route:' + dragState.route.id);
      gesture.state = null;
      var bendVerdict = commands.can(bendDrop);
      if (bendVerdict.ok) return commands.apply(bendDrop);
      host.redraw();
      announce(bendVerdict.message, false);
      return bendVerdict;
    }
    // Where a pointer at canvas point `now` puts the moved item: its stored position moved with the pointer, on its
    // component's border for a port, and, with the Snap box checked, lined up with a peer or on the grid.
    function pointerPosition(dragState, now) {
      var dx = now.x - dragState.start.x;
      var dy = dragState.item.axis === 'x' ? 0 : now.y - dragState.start.y;
      var basePos = dragState.positions[dragState.item.id];
      var nextX = basePos.x + dx;
      var nextY = basePos.y + dy;
      if (dragState.item.axis === 'port') {
        var constrained = constrainedPortPosition(dragState.item, nextX, nextY);
        nextX = constrained.x;
        nextY = constrained.y;
      }
      if (snapToggle && snapToggle.checked) {
        if (dragState.item.axis === 'xy') {
          var aligned = snapAlignedNodePosition(dragState, { x: nextX, y: nextY });
          nextX = aligned.x;
          nextY = aligned.y;
        } else {
          if (dragState.item.axis !== 'port') nextX = snapCoordinate(nextX);
          nextY = snapCoordinate(nextY);
        }
        if (dragState.item.axis === 'port') {
          var resnapped = constrainedPortPosition(dragState.item, nextX, nextY);
          nextX = resnapped.x;
          nextY = resnapped.y;
        }
      }
      return { x: nextX, y: nextY };
    }
    /**
     * The move's preview with the moved item's stored position at (nextX, nextY): the hit box, the drawn parts, the
     * other selected items, and the lines on them follow. With `finish` the move is dropped there: its operation is
     * built, asked about, and applied. Returns the drop's verdict, or the apply's promise of it.
     */
    function showMoveAt(gesture, nextX, nextY, finish) {
      var dragState = gesture.state;
      var basePos = dragState.positions[dragState.item.id];
      dragState.at = { x: nextX, y: nextY };
      var visualDx = dragState.item.axis === 'x'
        ? nextX - basePos.x
        : dragState.item.axis === 'port'
          ? nextX - basePos.x
          : nextX - dragState.box.x;
      var visualDy = dragState.item.axis === 'x' ? 0 : (dragState.item.axis === 'port' ? nextY - basePos.y : nextY - dragState.box.y);

      dragState.rect.setAttribute('x', dragState.box.x + visualDx);
      dragState.rect.setAttribute('y', dragState.box.y + visualDy);
      // Smart guides: when the dragged element's centre / edge lines up with
      // another's centre / edge within a small tolerance, draw a guide line.
      drawSmartGuides(dragState, visualDx, visualDy);
      dragState.parts.forEach(function (part) {
        if (part.el.classList && part.el.classList.contains('git-graph-label-g')) {
          var cssT = 'translate(' + visualDx + 'px,' + visualDy + 'px)';
          part.el.style.transform = part.styleTransform ? part.styleTransform + ' ' + cssT : cssT;
        } else {
          var t = 'translate(' + visualDx + ' ' + visualDy + ')';
          part.el.setAttribute('transform', part.transform ? part.transform + ' ' + t : t);
        }
      });

      // Group move: apply the same visual delta to every other selected element.
      if (dragState.groupItems) {
        dragState.groupItems.forEach(function (g) {
          if (g.item.id === dragState.item.id) return;
          if (g.rect) {
            g.rect.setAttribute('x', g.item.box.x + visualDx);
            g.rect.setAttribute('y', g.item.box.y + visualDy);
          }
          g.parts.forEach(function (part) {
            if (part.el.classList && part.el.classList.contains('git-graph-label-g')) {
              var cssT = 'translate(' + visualDx + 'px,' + visualDy + 'px)';
              part.el.style.transform = part.styleTransform ? part.styleTransform + ' ' + cssT : cssT;
            } else {
              var t = 'translate(' + visualDx + ' ' + visualDy + ')';
              part.el.setAttribute('transform', part.transform ? part.transform + ' ' + t : t);
            }
          });
        });
      }

      var movedDeltas = {};
      movedDeltas[dragState.item.id] = { x: visualDx, y: visualDy };
      var allConnectedRoutes = dragState.connectedRoutes || [];
      if (dragState.groupItems) {
        dragState.groupItems.forEach(function (g) {
          movedDeltas[g.item.id] = { x: visualDx, y: visualDy };
          allConnectedRoutes = mergeConnectedRouteEntries(allConnectedRoutes, g.connectedRoutes);
        });
      }
      applyConnectedRouteDeltas(allConnectedRoutes, movedDeltas, dragState.layer);

      if (finish && dragState.targets) {
        forgetTargets(dragState);
        // Where the drop lands: the pointer, or for a drop without one the centre of the box as the preview shows it.
        var dropPoint = dragState.pointer || {
          x: dragState.box.x + visualDx + dragState.box.width / 2,
          y: dragState.box.y + visualDy + dragState.box.height / 2
        };
        var landing = landingBox(dragState, dropPoint);
        if (landing) {
          clearSmartGuides();
          gesture.state = null;
          return dropOnTarget(dragState, landing);
        }
      }
      if (finish) {
        var dropped = {};
        dropped[dragState.item.id] = { x: nextX, y: nextY };
        // For group: shift every other selected element's stored position by the
        // same visualDx/Dy.
        if (dragState.groupItems) {
          dragState.groupItems.forEach(function (g) {
            if (g.item.id === dragState.item.id) return;
            var p = dragState.positions[g.item.id];
            if (p) dropped[g.item.id] = { x: p.x + visualDx, y: p.y + visualDy };
          });
        }
        var dropUndoKey = 'drag:elt:' + dragState.item.id;
        var positionsAtDrop = Object.assign({}, dragState.positions, dropped);
        // Sequence lifeline reordering: if a participant / actor was dragged
        // past another lifeline horizontally, swap their declaration order in
        // the source so the renderer lays them out in the new sequence.
        var lifelineOrder = documentType() === 'sequence' && dragState.item.axis === 'x'
          ? lifelineOrderAfterDrag(dragState.item.id, positionsAtDrop)
          : null;
        var drop = lifelineOrder
          ? buildOperation('lifeline.reorder', lifelineReorderFields(lifelineOrder, dragState.item.id),
            { positions: positionsAtDrop }, dropUndoKey)
          : layoutSetOperation(dragState.svg, {
            positions: dropped,
            routes: [],
            drawnPositions: dragState.positions,
            moved: movedBoxesOf(dragState),
            delta: { x: visualDx, y: visualDy },
            connectedRoutes: allConnectedRoutes,
            undoKey: dropUndoKey
          });
        clearSmartGuides();
        gesture.state = null;
        var verdict = commands.can(drop);
        if (verdict.ok) verdict = commands.apply(drop);
        return whenSettled(verdict, function (settled) {
          if (!settled.ok) {
            host.redraw();
            announceRefusal(settled);
          }
          return settled;
        });
      }
    }
    // `then(verdict)` for a verdict, at once, or for the verdict a promise brings, when it comes: an adapter's apply may
    // answer a promise (spec §3.4), and the text adapter's answer is handled before the drop returns, as it always was.
    function whenSettled(verdict, then) {
      return verdict && typeof verdict.then === 'function' ? verdict.then(then) : then(verdict);
    }
    // The move without a press (spec §3.11): the session a press at the centre of `ref`'s box would start, with no
    // pointer down, or null for an item no drag moves; when the adapter refuses the move, `refused(verdict)` hears why
    // and no session starts. Its preview, the snapping of a pointer position, the port's border, the carried parts,
    // and the rest of the selection are the drag's.
    function startAt(ref, refused) {
      var svg = output.querySelector('svg');
      var layer = svg && svg.querySelector('.uml-pg-edit-layer');
      if (!layer || !ref) return null;
      var editables = findEditableElements(svg);
      var item = editables.find(function (candidate) { return candidate.id === ref.id; });
      var rect = item && layer.querySelector('.uml-pg-edit-hitbox[data-layout-id="' + cssAttrEscape(item.id) + '"]');
      if (!rect) return null;
      var refusal = refusalOfMoveStart(item);
      if (refusal) {
        refused(refusal);
        return null;
      }
      var session = moveSession({ svg: svg, layer: layer, item: item, rect: rect, editables: editables }, null);
      var drawnAt = session.state.positions[item.id];
      session.state.at = { x: drawnAt.x, y: drawnAt.y };
      return session;
    }
    // Moves the preview of a running move by exactly (dx, dy) from where it shows the item now (spec §3.11): no grid
    // and no peer pulls it, whether the Snap box is checked or not, as the arrow keys' nudge adds its step. A lifeline
    // head moves only across; a port stays on its component's border.
    function moveBy(gesture, dx, dy) {
      var dragState = gesture.state;
      if (!dragState) return;
      var at = dragState.at;
      var next = { x: at.x + dx, y: dragState.item.axis === 'x' ? at.y : at.y + dy };
      if (dragState.item.axis === 'port') next = constrainedPortPosition(dragState.item, next.x, next.y);
      dragState.pointer = null;
      showMoveAt(gesture, next.x, next.y, false);
    }
    // Drops a running move where its preview shows the item, with no snapping. Returns the drop's verdict.
    function dropHere(gesture) {
      var dragState = gesture.state;
      if (!dragState) return null;
      return showMoveAt(gesture, dragState.at.x, dragState.at.y, true);
    }

    return {
      link: function () {
        activityNodeInfoForId = kit.activityNodeInfoForId;
        announce = kit.announce;
        applyConnectedRouteDeltas = kit.applyConnectedRouteDeltas;
        applyRoutePoints = kit.applyRoutePoints;
        buildOperation = kit.buildOperation;
        clonePoints = kit.clonePoints;
        collectConnectedRoutes = kit.collectConnectedRoutes;
        documentType = kit.documentType;
        editorCanvasPoint = kit.editorCanvasPoint;
        layoutSetOperation = kit.layoutSetOperation;
        mergeConnectedRouteEntries = kit.mergeConnectedRouteEntries;
        messageMoveOperation = kit.messageMoveOperation;
        movedBoxesOf = kit.movedBoxesOf;
        routeLayoutSetOperation = kit.routeLayoutSetOperation;
        syncRouteOverlays = kit.syncRouteOverlays;
        toolState = kit.toolState;
      },
      members: {
        clearMove: clearMove,
        clearSmartGuides: clearSmartGuides,
        collectPositions: collectPositions,
        // The candidates the running move marked, possible ones first, or null (spec §7.4).
        currentTargets: function () { return markedTargets; },
        offerTargets: offerTargets,
        refuseMarkedDrop: refuseMarkedDrop,
        withdrawTargets: withdrawTargets,
        dragSession: dragSession,
        dropHere: dropHere,
        dropRoutePoints: dropRoutePoints,
        moveBy: moveBy,
        pressTaken: pressTaken,
        startAt: startAt,
        startElementMove: startElementMove,
        updateDrag: updateDrag
      }
    };
  }

  return { createMoveGestures: createMoveGestures };
});
