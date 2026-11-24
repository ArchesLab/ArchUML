(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./de-geometry.js'), require('./de-scene.js'));
  } else {
    var parts = root.ArchUMLDiagramEditorParts = root.ArchUMLDiagramEditorParts || {};
    // A second load of the module replaces nothing (spec §2.2).
    if (!parts.gesturesSequence) parts.gesturesSequence = factory(parts.geometry, parts.scene);
  }
})(typeof self !== 'undefined' ? self : this, function (geometry, scene) {
  'use strict';

  // The sequence gestures of a session (UML-view editing spec §2.2, §3.8; plan Task 23): the gesture factories
  // `sequence-message` (a drag between lifelines draws a message at the height it starts), `fragment` (a drag moves a
  // combined fragment to another place), and `activation-bar` (a drag moves or resizes an activation bar, or draws a
  // new one with the Activate tool), with the lifeline and message geometry they read.
  //
  // A message drawn between two lifelines has an open end, its target lifeline, `to` (spec §7.4; plan Task 38): the
  // drag asks the adapter's `targets` once, when it starts, and the lifelines it could end on are marked. A release on
  // a lifeline marked not possible adds nothing and says why. Without advice (the text adapter answers null) nothing
  // is marked. A lost or found message has no open end: its one lifeline is where the drag starts.

  // What this file uses of the parts before it in diagram-editor/manifest.json.
  var classicModelOf = scene.classicModelOf;
  var containsPoint = geometry.containsPoint;
  var cssAttrEscape = scene.cssAttrEscape;
  var sequenceRouteLineIndex = scene.sequenceRouteLineIndex;
  var sequenceRouteVisualY = scene.sequenceRouteVisualY;

  /**
   * The sequence gestures.
   *
   * The functions came from the session in the inline script of _includes/uml-editor.html without a changed statement
   * (spec §3.6), except where noted. A part is made from the session's kit (createDiagramEditorSession): it takes the
   * values and the session's functions it uses when it is made, and what it uses of the other parts when the session
   * calls its link(), once every part and the pointer driver exist. Its members join the kit.
   * Changed statements: the reads of the document go through `kit.commands`.
   */
  function createSequenceGestures(kit) {
    // What the session made this part with.
    var commands = kit.commands;
    var env = kit.env;
    var findEditableElements = kit.findEditableElements;
    var findEditableRoutes = kit.findEditableRoutes;
    var setSelectedLayoutId = kit.setSelectedLayoutId;
    // What the other parts and the pointer driver give this part, bound by link() once all of them exist.
    var activationBarSlots, addSequenceRelationAtY, addSequenceSingleMessage, announce, buildOperation,
      clientRectToEditorCanvasBox, createActivationBar, documentType, dragSession, editorCanvasPoint,
      handleHitboxClickForRelation, moveSequenceFragmentToY, offerTargets, parseSvgViewBox, pressTaken,
      refuseMarkedDrop, selectedRelationToolSpec, setActivationBarSlots, toolState, withdrawTargets;

    /** Sorted [{ lineIdx, y }] for each rendered message arrow (top → bottom). */
    function sequenceMessageRows(svg) {
      return findEditableRoutes(svg)
        .filter(function (route) { return /^seqmsg:\d+$/.test(String(route.id || '')); })
        .map(function (route) { return { lineIdx: sequenceRouteLineIndex(route.id), y: sequenceRouteVisualY(route) }; })
        .filter(function (r) { return r.lineIdx >= 0 && isFinite(r.y); })
        .sort(function (a, b) { return a.y - b.y; });
    }
    function selectedSequenceMessageToolSpec() {
      var spec = selectedRelationToolSpec();
      if (documentType() !== 'sequence' || !spec) return null;
      return spec;
    }
    function sequenceLifelineCenterX(item, svg) {
      if (!item || !item.box) return 0;
      if (svg && documentType() === 'sequence') {
        var xs = [];
        findEditableRoutes(svg).forEach(function (route) {
          if (!route || !route.points || !route.points.length) return;
          if (route.source === item.id) xs.push(Number(route.points[0].x));
          if (route.target === item.id) xs.push(Number(route.points[route.points.length - 1].x));
        });
        xs = xs.filter(function (x) { return Number.isFinite(x); }).sort(function (a, b) { return a - b; });
        if (xs.length) return xs[Math.floor(xs.length / 2)];
      }
      return item.box.x + item.box.width / 2;
    }
    function findSequenceLifelineAtPoint(svg, clientX, clientY) {
      if (documentType() !== 'sequence' || !svg) return null;
      var pt = editorCanvasPoint(svg, clientX, clientY);
      var view = parseSvgViewBox(svg) || { x: 0, y: 0, width: 4000, height: 4000 };
      var candidates = findEditableElements(svg).filter(function (item) {
        return item && item.axis === 'x' && item.box;
      }).map(function (item) {
        var centerX = sequenceLifelineCenterX(item, svg);
        var inHead = containsPoint(item.box, pt.x, pt.y, 12);
        var top = Math.min(item.box.y - 24, view.y - 12);
        var bottom = Math.max(view.y + view.height + 12, item.box.y + item.box.height + 360);
        var nearLine = pt.y >= top && pt.y <= bottom && Math.abs(pt.x - centerX) <= 36;
        if (!inHead && !nearLine) return null;
        return {
          item: item,
          distance: inHead ? 0 : Math.abs(pt.x - centerX)
        };
      }).filter(Boolean);
      candidates.sort(function (a, b) { return a.distance - b.distance; });
      if (candidates.length) return candidates[0].item;

      var modelById = {};
      commands.contents().elements.map(classicModelOf).forEach(function (model) {
        if (model && model.axis === 'x') modelById[model.id] = model;
      });
      Array.prototype.slice.call(svg.querySelectorAll('.uml-pg-edit-hitbox[data-layout-id]')).forEach(function (rect) {
        var id = rect.getAttribute('data-layout-id');
        var model = modelById[id];
        if (!model) return;
        var clientBox = rect.getBoundingClientRect();
        if (!clientBox || clientBox.width <= 0 || clientBox.height <= 0) return;
        var svgClientBox = svg.getBoundingClientRect();
        var centerX = clientBox.left + clientBox.width / 2;
        var top = Math.min(clientBox.top - 24, svgClientBox.top - 12);
        var bottom = Math.max(svgClientBox.bottom + 12, clientBox.bottom + 360);
        var inHead = clientX >= clientBox.left - 12 && clientX <= clientBox.right + 12 &&
          clientY >= clientBox.top - 12 && clientY <= clientBox.bottom + 12;
        var nearLine = clientY >= top && clientY <= bottom && Math.abs(clientX - centerX) <= 36;
        if (!inHead && !nearLine) return;
        var box = clientRectToEditorCanvasBox(svg, clientBox);
        candidates.push({
          item: { id: id, label: model.label || id, axis: 'x', box: box },
          distance: inHead ? 0 : Math.abs(clientX - centerX)
        });
      });
      candidates.sort(function (a, b) { return a.distance - b.distance; });
      return candidates.length ? candidates[0].item : null;
    }
    function clearSequenceMessageDrag(gesture) {
      var sequenceMessageDragState = gesture.state;
      if (!sequenceMessageDragState) return;
      withdrawTargets(sequenceMessageDragState.layer, sequenceMessageDragState.targets);
      if (sequenceMessageDragState.line && sequenceMessageDragState.line.parentNode) {
        sequenceMessageDragState.line.parentNode.removeChild(sequenceMessageDragState.line);
      }
      if (sequenceMessageDragState.sourceHitbox && sequenceMessageDragState.sourceHitbox.classList) {
        sequenceMessageDragState.sourceHitbox.classList.remove('is-relation-source');
      }
      gesture.state = null;
    }
    function clearFragmentDrag(gesture) {
      var fragmentDragState = gesture.state;
      if (!fragmentDragState) return;
      if (fragmentDragState.indicator && fragmentDragState.indicator.parentNode) {
        fragmentDragState.indicator.parentNode.removeChild(fragmentDragState.indicator);
      }
      gesture.state = null;
    }
    // The fragment drag: a press on a fragment's label moves the fragment to the height it is released
    // at; a press without a move selects it.
    function startFragmentGesture(event, press) {
      if (press.site !== 'fragment') return null;
      if (toolState.activeTool || event.button !== 0) return null;
      event.preventDefault();
      event.stopPropagation();
      var extend = event.metaKey || event.ctrlKey || event.shiftKey;
      return startFragmentDrag(press.svg, press.layer, press.frag, event, extend);
    }
    function startFragmentDrag(svg, layer, frag, event, extend) {
      if (!svg || !layer || !frag) return null;
      var ns = 'http://www.w3.org/2000/svg';
      var pt = editorCanvasPoint(svg, event.clientX, event.clientY);
      var session = dragSession('fragment', {
        svg: svg,
        layer: layer,
        frag: frag,
        indicator: null,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startCanvasY: pt.y,
        moved: false,
        extend: !!extend
      }, updateFragmentDrag, clearFragmentDrag);
      if (event.currentTarget && event.currentTarget.setPointerCapture) {
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch (e) {}
      }
      return session;
    }
    function updateFragmentDrag(gesture, ev, finish) {
      var fragmentDragState = gesture.state;
      if (!fragmentDragState) return;
      var state = fragmentDragState;
      var dx = ev.clientX - state.startClientX;
      var dy = ev.clientY - state.startClientY;
      if (!state.moved && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
        state.moved = true;
        var ns = 'http://www.w3.org/2000/svg';
        var view = parseSvgViewBox(state.svg) || { x: 0, y: 0, width: 4000, height: 4000 };
        var indicator = env.document.createElementNS(ns, 'line');
        indicator.setAttribute('class', 'uml-pg-frag-drop-indicator');
        indicator.setAttribute('x1', view.x + 8);
        indicator.setAttribute('x2', view.x + view.width - 8);
        indicator.setAttribute('y1', state.startCanvasY);
        indicator.setAttribute('y2', state.startCanvasY);
        state.layer.appendChild(indicator);
        state.indicator = indicator;
        announce('Drag the fragment "' + state.frag.id + '" to a new vertical position. Release to move. Esc to cancel.', true);
      }
      var pt = editorCanvasPoint(state.svg, ev.clientX, ev.clientY);
      if (state.moved && state.indicator) {
        state.indicator.setAttribute('y1', pt.y);
        state.indicator.setAttribute('y2', pt.y);
      }
      if (!finish) return;

      if (state.indicator && state.indicator.parentNode) {
        state.indicator.parentNode.removeChild(state.indicator);
      }
      var fragId = state.frag.id;
      var svg = state.svg;
      var moved = state.moved;
      var extend = state.extend;
      gesture.state = null;

      if (!moved) {
        setSelectedLayoutId(fragId, 'fragment', extend ? { extend: true } : undefined);
        return;
      }
      moveSequenceFragmentToY(fragId, svg, pt.y);
    }
    // ─── Activation bar drag (adjust / move / create) ─────────────────────
    // Mirrors the fragment drag: a guide line follows the snap target, and on
    // release we rewrite the source. `mode` is 'start' (drag the top edge),
    // 'end' (drag the bottom edge), 'move' (drag the body), or 'create' (drag
    // down a lifeline with the Activate tool to sweep a new bar).
    function selectedActivationToolSpec() {
      if (!toolState.activeTool || toolState.activeTool.kind !== 'element' || documentType() !== 'sequence') return null;
      var spec = toolState.activeTool.spec || {};
      return spec.sequenceControl === 'activate' ? spec : null;
    }
    function activationSlotForY(rows, canvasY) {
      var c = 0;
      for (var i = 0; i < rows.length; i++) { if (rows[i].y < canvasY) c++; }
      return c;
    }
    // Y of the boundary a directive in `slot` snaps to: midway between the
    // (slot-1)-th and slot-th message rows (or just past the ends).
    function activationSlotGuideY(rows, slot, fallbackY) {
      if (!rows.length) return fallbackY;
      if (slot <= 0) return Math.max(0, rows[0].y - 14);
      if (slot >= rows.length) return rows[rows.length - 1].y + 14;
      return (rows[slot - 1].y + rows[slot].y) / 2;
    }
    function computeActivationTarget(s, canvasY) {
      var slot = activationSlotForY(s.rows, canvasY);
      var newStart, newEnd, guideSlot;
      if (s.mode === 'create') {
        newStart = Math.min(s.createStartSlot, slot);
        newEnd = Math.max(s.createStartSlot, slot);
        guideSlot = slot;
      } else if (s.mode === 'start') {
        newStart = Math.min(slot, s.endSlot == null ? s.msgCount : s.endSlot);
        newEnd = s.endSlot;
        guideSlot = newStart;
      } else if (s.mode === 'end') {
        newStart = s.startSlot;
        newEnd = Math.max(slot, s.startSlot);
        guideSlot = newEnd;
      } else { // move
        var delta = slot - s.startSlot;
        newStart = s.startSlot + delta;
        newEnd = (s.endSlot == null ? null : s.endSlot + delta);
        if (newStart < 0) { if (newEnd != null) newEnd -= newStart; newStart = 0; }
        if (newEnd != null && newEnd > s.msgCount) { newStart -= (newEnd - s.msgCount); newEnd = s.msgCount; }
        newStart = Math.max(0, newStart);
        guideSlot = newStart;
      }
      return { startSlot: newStart, endSlot: newEnd, guideY: activationSlotGuideY(s.rows, guideSlot, canvasY) };
    }
    function applyActivationTarget(s, target) {
      if (s.mode === 'create') {
        createActivationBar(s.lifeline.id, target.startSlot, target.endSlot);
        return;
      }
      if (target.startSlot === s.startSlot && target.endSlot === s.endSlot) {
        setSelectedLayoutId(s.bar.id, 'activation');
        return;
      }
      var label = s.bar.target || 'object';
      var msg;
      if (s.mode === 'start') msg = 'Activation of "' + label + '" now starts ' + (target.startSlot < s.startSlot ? 'earlier' : 'later') + '.';
      else if (s.mode === 'end') msg = 'Activation of "' + label + '" now stops ' + ((s.endSlot != null && target.endSlot < s.endSlot) ? 'earlier' : 'later') + '.';
      else msg = 'Activation of "' + label + '" moved.';
      setActivationBarSlots(s.bar, target.startSlot, target.endSlot, 'activation-' + s.mode, msg);
    }
    function clearActivationBarDrag(gesture) {
      var activationDragState = gesture.state;
      if (!activationDragState) return;
      if (activationDragState.guide && activationDragState.guide.parentNode) {
        activationDragState.guide.parentNode.removeChild(activationDragState.guide);
      }
      gesture.state = null;
    }
    // The activation bar drag: a press on a bar's body moves it, on its top or bottom handle moves when
    // the object becomes or stops being active, and on a lifeline with the Activate tool sweeps a new bar.
    function startActivationBarGesture(ev, press) {
      if (press.site === 'activation-body') {
        if (toolState.activeTool || ev.button !== 0) return null;
        ev.preventDefault(); ev.stopPropagation();
        if (ev.metaKey || ev.ctrlKey || ev.shiftKey) {
          setSelectedLayoutId(press.bar.id, 'activation', { extend: true });
          return pressTaken();
        }
        return startActivationBarDrag(press.svg, press.layer, press.bar, 'move', ev);
      }
      if (press.site === 'activation-start' || press.site === 'activation-end') {
        if (toolState.activeTool) return null;
        ev.preventDefault(); ev.stopPropagation();
        return startActivationBarDrag(press.svg, press.layer, press.bar, press.site === 'activation-start' ? 'start' : 'end', ev);
      }
      // Activate tool: click a lifeline to add an activation bar at that
      // height, or drag down it to sweep the active span. Lands the
      // `activate`/`deactivate` lines at the clicked messages — not appended
      // at the end of the source.
      if (press.site === 'canvas' && !press.landedOnInteractive && selectedActivationToolSpec()) {
        var actLifeline = findSequenceLifelineAtPoint(press.svg, ev.clientX, ev.clientY);
        if (actLifeline) {
          ev.preventDefault();
          return startActivationCreateDrag(press.svg, press.layer, actLifeline, ev);
        }
      }
      return null;
    }
    function startActivationBarDrag(svg, layer, bar, mode, event) {
      if (!svg || !layer || !bar) return null;
      var pt = editorCanvasPoint(svg, event.clientX, event.clientY);
      var slots = activationBarSlots(bar);
      setSelectedLayoutId(bar.id, 'activation');
      var session = dragSession('activation', {
        svg: svg, layer: layer, bar: bar, mode: mode,
        rows: sequenceMessageRows(svg),
        startSlot: slots.startSlot, endSlot: slots.endSlot, msgCount: slots.msgCount,
        startClientX: event.clientX, startClientY: event.clientY, startCanvasY: pt.y,
        moved: false, guide: null
      }, updateActivationBarDrag, clearActivationBarDrag);
      if (event.currentTarget && event.currentTarget.setPointerCapture) {
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch (e) {}
      }
      return session;
    }
    function startActivationCreateDrag(svg, layer, lifeline, event) {
      if (!svg || !layer || !lifeline) return null;
      var pt = editorCanvasPoint(svg, event.clientX, event.clientY);
      var rows = sequenceMessageRows(svg);
      var session = dragSession('activation', {
        svg: svg, layer: layer, bar: null, mode: 'create', lifeline: lifeline,
        rows: rows, msgCount: rows.length,
        createStartSlot: activationSlotForY(rows, pt.y),
        startClientX: event.clientX, startClientY: event.clientY, startCanvasY: pt.y,
        moved: false, guide: null
      }, updateActivationBarDrag, clearActivationBarDrag);
      if (svg.setPointerCapture) { try { svg.setPointerCapture(event.pointerId); } catch (e) {} }
      announce('Drag down "' + lifeline.id + '" to set the activation span, or release for a one-step bar. Esc to cancel.', true);
      return session;
    }
    function updateActivationBarDrag(gesture, ev, finish) {
      var activationDragState = gesture.state;
      if (!activationDragState) return;
      var s = activationDragState;
      var ns = 'http://www.w3.org/2000/svg';
      var pt = editorCanvasPoint(s.svg, ev.clientX, ev.clientY);
      if (!s.moved && Math.abs(ev.clientY - s.startClientY) > 4) {
        s.moved = true;
        var view = parseSvgViewBox(s.svg) || { x: 0, y: 0, width: 4000, height: 4000 };
        s.guide = env.document.createElementNS(ns, 'line');
        s.guide.setAttribute('class', 'uml-pg-activation-guide');
        s.guide.setAttribute('x1', view.x + 8);
        s.guide.setAttribute('x2', view.x + view.width - 8);
        s.layer.appendChild(s.guide);
      }
      var target = computeActivationTarget(s, pt.y);
      if (s.moved && s.guide) {
        s.guide.setAttribute('y1', target.guideY);
        s.guide.setAttribute('y2', target.guideY);
      }
      if (!finish) return;
      clearActivationBarDrag(gesture);
      if (s.mode === 'create') {
        if (s.moved) createActivationBar(s.lifeline.id, target.startSlot, target.endSlot);
        else createActivationBar(s.lifeline.id, s.createStartSlot, s.createStartSlot + 1);
        return;
      }
      if (!s.moved) { setSelectedLayoutId(s.bar.id, 'activation'); return; }
      applyActivationTarget(s, target);
    }
    function findSequenceMessageDropTarget(state, clientX, clientY) {
      if (!state || !state.svg) return null;
      var target = findSequenceLifelineAtPoint(state.svg, clientX, clientY);
      if (target) return target;
      var source = state.sourceItem;
      if (!source || !source.box) return null;
      var sourceClientBox = state.sourceHitbox && state.sourceHitbox.getBoundingClientRect
        ? state.sourceHitbox.getBoundingClientRect()
        : null;
      if (!sourceClientBox || sourceClientBox.width <= 0 || sourceClientBox.height <= 0) {
        var sourceHitbox = state.svg.querySelector('.uml-pg-edit-hitbox[data-layout-id="' + cssAttrEscape(source.id) + '"]');
        sourceClientBox = sourceHitbox && sourceHitbox.getBoundingClientRect ? sourceHitbox.getBoundingClientRect() : null;
      }
      if (sourceClientBox && sourceClientBox.width > 0 && sourceClientBox.height > 0) {
        var svgClientBox = state.svg.getBoundingClientRect();
        var sourceClientCenterX = sourceClientBox.left + sourceClientBox.width / 2;
        var sourceClientTop = Math.min(sourceClientBox.top - 24, svgClientBox.top - 12);
        var sourceClientBottom = Math.max(svgClientBox.bottom + 12, sourceClientBox.bottom + 360);
        if (clientY >= sourceClientTop && clientY <= sourceClientBottom &&
            clientX >= sourceClientCenterX - 12 && clientX <= sourceClientCenterX + 180) {
          return source;
        }
      }
      var pt = editorCanvasPoint(state.svg, clientX, clientY);
      var centerX = sequenceLifelineCenterX(source, state.svg);
      var view = parseSvgViewBox(state.svg) || { x: 0, y: 0, width: 4000, height: 4000 };
      var top = Math.min(source.box.y - 24, view.y - 12);
      var bottom = Math.max(view.y + view.height + 12, source.box.y + source.box.height + 360);
      var loopReach = 180;
      if (pt.y >= top && pt.y <= bottom && pt.x >= centerX - 12 && pt.x <= centerX + loopReach) {
        return source;
      }
      return null;
    }
    // The sequence message drag: with a message tool armed, a press on a lifeline (its head, its body,
    // or a message over it) draws the message to the pointer; the release adds it.
    function startSequenceMessageGesture(event, press) {
      if (!selectedSequenceMessageToolSpec()) return null;
      if (press.site === 'hitbox') {
        if (!toolState.activeTool || toolState.activeTool.kind !== 'relation') return null;
        return startSequenceMessageDrag(press.svg, press.layer, press.item, press.rect, event);
      }
      if (press.site !== 'canvas') return null;
      if (press.landedOnInteractive) {
        if (!press.landedOnEdgeHitbox) return null;
        var edgeCoveredLifeline = findSequenceLifelineAtPoint(press.svg, event.clientX, event.clientY);
        return edgeCoveredLifeline ? startSequenceMessageDrag(press.svg, press.layer, edgeCoveredLifeline, null, event) : null;
      }
      var sourceLifeline = findSequenceLifelineAtPoint(press.svg, event.clientX, event.clientY);
      return sourceLifeline ? startSequenceMessageDrag(press.svg, press.layer, sourceLifeline, null, event) : null;
    }
    function startSequenceMessageDrag(svg, layer, item, hitbox, event) {
      var spec = selectedSequenceMessageToolSpec();
      if (!spec || !svg || !layer || !item) return null;
      event.preventDefault();
      event.stopPropagation();
      setSelectedLayoutId(item.id, 'node');
      if (hitbox && hitbox.classList) hitbox.classList.add('is-relation-source');

      var ns = 'http://www.w3.org/2000/svg';
      var pt = editorCanvasPoint(svg, event.clientX, event.clientY);
      var originX = sequenceLifelineCenterX(item, svg);
      var isSingle = !!spec.sequenceSingle;
      var line = env.document.createElementNS(ns, 'line');
      line.setAttribute('class', 'uml-pg-extend-line');
      line.setAttribute('x1', originX);
      line.setAttribute('y1', pt.y);
      line.setAttribute('x2', pt.x);
      line.setAttribute('y2', pt.y);
      layer.appendChild(line);
      var session = dragSession('sequence-message', {
        svg: svg,
        layer: layer,
        line: line,
        spec: spec,
        sourceItem: item,
        sourceHitbox: hitbox || null,
        originX: originX,
        originY: pt.y,
        startClientX: event.clientX,
        startClientY: event.clientY,
        moved: false,
        isSequenceSingle: isSingle,
        targets: isSingle ? null : offerTargets(svg, layer, { op: 'relation.add', tool: spec.id, from: item.id, label: null, open: 'to' })
      }, updateSequenceMessageDrag, clearSequenceMessageDrag);
      if (event.currentTarget && event.currentTarget.setPointerCapture) {
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch (e) {}
      }
      if (isSingle) {
        announce(spec.sequenceSingle === 'found'
          ? 'Drag from the empty point to "' + (item.label || item.id) + '" — release to add the found message at this height.'
          : 'Drag to where the message gets lost — release to add the lost message from "' + (item.label || item.id) + '" at this height.', true);
      } else {
        announce('Drag to the target lifeline. Release on the same lifeline or just to its right for a self-message.', true);
      }
      return session;
    }
    function updateSequenceMessageDrag(gesture, ev, finish) {
      var sequenceMessageDragState = gesture.state;
      if (!sequenceMessageDragState) return;
      var state = sequenceMessageDragState;
      var pt = editorCanvasPoint(state.svg, ev.clientX, ev.clientY);
      var dx = ev.clientX - state.startClientX;
      var dy = ev.clientY - state.startClientY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) state.moved = true;

      if (state.isSequenceSingle) {
        // Lost: arrow from lifeline outward to cursor.
        // Found: arrow from cursor inward to lifeline (reverse the line).
        if (state.spec.sequenceSingle === 'found') {
          state.line.setAttribute('x1', pt.x);
          state.line.setAttribute('y1', pt.y);
          state.line.setAttribute('x2', state.originX);
          state.line.setAttribute('y2', state.originY);
        } else {
          state.line.setAttribute('x1', state.originX);
          state.line.setAttribute('y1', state.originY);
          state.line.setAttribute('x2', pt.x);
          state.line.setAttribute('y2', pt.y);
        }
      } else {
        var dragTarget = findSequenceMessageDropTarget(state, ev.clientX, ev.clientY);
        var x2 = dragTarget ? sequenceLifelineCenterX(dragTarget, state.svg) : pt.x;
        if (dragTarget && dragTarget.id === state.sourceItem.id && state.moved) x2 = Math.max(x2 + 54, pt.x);
        state.line.setAttribute('x2', x2);
        state.line.setAttribute('y2', pt.y);
      }

      if (!finish) return;
      withdrawTargets(state.layer, state.targets);
      if (state.line.parentNode) state.line.parentNode.removeChild(state.line);
      if (state.sourceHitbox && state.sourceHitbox.classList) {
        state.sourceHitbox.classList.remove('is-relation-source');
      }
      gesture.state = null;

      if (state.isSequenceSingle) {
        // Click or drag, both insert at the lifeline+Y where the gesture started.
        addSequenceSingleMessage(state.spec, state.sourceItem.id, { svg: state.svg, canvasY: state.originY });
        return;
      }

      if (!state.moved) {
        handleHitboxClickForRelation(state.sourceItem, state.sourceHitbox);
        return;
      }
      var target = findSequenceMessageDropTarget(state, ev.clientX, ev.clientY);
      if (!target) {
        announce('Release on a lifeline to add the message. Press Esc to cancel.', true);
        return;
      }
      if (refuseMarkedDrop(state.targets, target.id, buildOperation('relation.add',
        { tool: state.spec.id, from: state.sourceItem.id, to: target.id, label: null }, {}, null))) return;
      addSequenceRelationAtY(state.svg, state.spec, state.sourceItem.id, target.id, state.originY);
    }

    return {
      link: function () {
        activationBarSlots = kit.activationBarSlots;
        addSequenceRelationAtY = kit.addSequenceRelationAtY;
        addSequenceSingleMessage = kit.addSequenceSingleMessage;
        announce = kit.announce;
        buildOperation = kit.buildOperation;
        clientRectToEditorCanvasBox = kit.clientRectToEditorCanvasBox;
        createActivationBar = kit.createActivationBar;
        documentType = kit.documentType;
        dragSession = kit.dragSession;
        editorCanvasPoint = kit.editorCanvasPoint;
        handleHitboxClickForRelation = kit.handleHitboxClickForRelation;
        moveSequenceFragmentToY = kit.moveSequenceFragmentToY;
        offerTargets = kit.offerTargets;
        parseSvgViewBox = kit.parseSvgViewBox;
        pressTaken = kit.pressTaken;
        refuseMarkedDrop = kit.refuseMarkedDrop;
        selectedRelationToolSpec = kit.selectedRelationToolSpec;
        setActivationBarSlots = kit.setActivationBarSlots;
        toolState = kit.toolState;
        withdrawTargets = kit.withdrawTargets;
      },
      members: {
        findSequenceLifelineAtPoint: findSequenceLifelineAtPoint,
        findSequenceMessageDropTarget: findSequenceMessageDropTarget,
        selectedSequenceMessageToolSpec: selectedSequenceMessageToolSpec,
        startActivationBarGesture: startActivationBarGesture,
        startFragmentGesture: startFragmentGesture,
        startSequenceMessageGesture: startSequenceMessageGesture
      }
    };
  }

  return { createSequenceGestures: createSequenceGestures };
});
