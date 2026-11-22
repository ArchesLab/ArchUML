(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var parts = root.ArchUMLDiagramEditorParts = root.ArchUMLDiagramEditorParts || {};
    // A second load of the module replaces nothing (spec §2.2).
    if (!parts.gesturesPalette) parts.gesturesPalette = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The palette and placement gestures of a session (UML-view editing spec §2.2, §3.8; plan Task 23): the gesture
  // factory `palette-drag` (a palette button dragged onto the canvas drops its tool there), and `placement-press`
  // (a press on the canvas places the armed tool's element, pans, or clears the selection).
  //
  // An element dragged from the palette has an open end, what it goes into, `into` (spec §7.4; plan Task 38): once the
  // drag is armed it asks the adapter's `targets` once, and the boxes it could go into are marked. A drop on a box
  // marked not possible places nothing and says why. Without advice (the text adapter answers null) nothing is marked
  // and every drop places as before. A note is anchored, not put into a box, so it asks nothing.

  /**
   * The palette and placement gestures.
   *
   * The functions came from the session in the inline script of _includes/uml-editor.html without a changed statement
   * (spec §3.6), except where noted. A part is made from the session's kit (createDiagramEditorSession): it takes the
   * values and the session's functions it uses when it is made, and what it uses of the other parts when the session
   * calls its link(), once every part and the pointer driver exist. Its members join the kit.
   * The pointer driver (`kit.pointer`) reaches this part through link(), since the palette drag is one of the
   * factories it is made with.
   */
  function createPaletteGestures(kit) {
    // What the session made this part with.
    var diagramSupportsAnchoredNotes = kit.diagramSupportsAnchoredNotes;
    var output = kit.output;
    var previewPane = kit.previewPane;
    var selectionSize = kit.selectionSize;
    var setSelectedLayoutId = kit.setSelectedLayoutId;
    // What the other parts and the pointer driver give this part, bound by link() once all of them exist.
    var addElementWithoutCanvas, addSequenceSingleMessage, announce, applyPanTransform, buildOperation, documentType,
      editorCanvasPoint, findItemAtPoint, findSequenceLifelineAtPoint, handleHitboxClickForAnchoredNoteTool,
      offerTargets, panOffset, placeElementAt, pointer, refuseMarkedDrop, setActiveTool, toolState, withdrawTargets;

    function pointInsideElement(el, clientX, clientY) {
      if (!el) return false;
      var rect = el.getBoundingClientRect();
      return clientX >= rect.left && clientX <= rect.right &&
             clientY >= rect.top && clientY <= rect.bottom;
    }
    function eventInsidePreview(event) {
      return pointInsideElement(previewPane, event.clientX, event.clientY);
    }
    // The advice about where the palette element `spec` could go (element.add without its open end, `into`), marked
    // over the drawing shown now: `{ layer, candidates }`, or null for a relation tool, a note, no drawing, or no advice.
    function offerIntoTargets(kind, spec) {
      if (kind !== 'element' || spec.isNote) return null;
      var svg = output.querySelector('svg');
      var layer = svg && svg.querySelector('.uml-pg-edit-layer');
      var candidates = layer ? offerTargets(svg, layer, { op: 'element.add', tool: spec.id, name: null, anchor: null, placed: 'dropped', open: 'into' }) : null;
      return candidates ? { layer: layer, candidates: candidates } : null;
    }
    function withdrawIntoTargets(dragState) {
      if (dragState && dragState.targets) withdrawTargets(dragState.targets.layer, dragState.targets.candidates);
    }
    // The palette drag (spec §3.8): a press on a palette button, which arms once the pointer has moved
    // past 5 px (so a normal click still works) and drops the button's tool where it is released. The
    // click that follows an armed drag is the drag's (R0's suppressPaletteClick); it comes after the
    // release, so the factory keeps it, not the session.
    function createPaletteDragGesture() {
      var clickTaken = false;
      function start(event, press) {
        if (press.site !== 'palette') return null;
        var btn = press.button;
        var kind = press.kind;
        var spec = press.spec;
        if (btn.setPointerCapture && event.pointerId != null) {
          try { btn.setPointerCapture(event.pointerId); } catch (e) {}
        }
        var startX = event.clientX, startY = event.clientY;
        var armed = false;
        function releaseCapture(ev) {
          if (ev && btn.releasePointerCapture && ev.pointerId != null &&
              (!btn.hasPointerCapture || btn.hasPointerCapture(ev.pointerId))) {
            try { btn.releasePointerCapture(ev.pointerId); } catch (e) {}
          }
        }
        var session = {
          // As at R0: capture-phase listeners that hear mouse events too, and a pointer cancel ends it.
          capture: true,
          mouse: true,
          cancelOnPointerCancel: true,
          slot: 'palette',
          // What an armed drag drops (R0's paletteDragState). Escape clears it; the drag then runs on to
          // its release and drops nothing.
          state: null,
          move: function (ev) {
            if (!armed && (Math.abs(ev.clientX - startX) > 5 || Math.abs(ev.clientY - startY) > 5)) {
              armed = true;
              clickTaken = true;
              session.state = { kind: kind, spec: spec, x: ev.clientX, y: ev.clientY, sourceId: null, targets: offerIntoTargets(kind, spec) };
              announce('Drop on the canvas to ' + (kind === 'element' ? 'place a ' + spec.label : 'start a ' + spec.label + ' relation') + '. Esc to cancel.', true);
              // Visual hint on the button
              btn.classList.add('is-dragging');
            }
            if (ev.type === 'pointermove') updatePaletteDrag(session, ev, false);
          },
          end: function (ev) {
            releaseCapture(ev);
            btn.classList.remove('is-dragging');
            if (session.state) updatePaletteDrag(session, ev, true);
          },
          cancel: function (ev) {
            releaseCapture(ev);
            btn.classList.remove('is-dragging');
            withdrawIntoTargets(session.state);
            session.state = null;
          }
        };
        return session;
      }
      // What an armed palette drag would drop, or null.
      function dropping() {
        var running = pointer.running('palette-drag');
        return running ? running.state : null;
      }
      return {
        id: 'palette-drag',
        start: start,
        dropping: dropping,
        // Whether a palette button's click belongs to a drag: the one after an armed drag, or one while a
        // drag is armed.
        takesClick: function () {
          if (clickTaken) {
            clickTaken = false;
            return true;
          }
          return !!dropping();
        },
        // Escape: an armed drag drops nothing at its release, and the next click is the drag's.
        cancelDrop: function () {
          var running = pointer.running('palette-drag');
          clickTaken = !!(running && running.state);
          if (running) {
            withdrawIntoTargets(running.state);
            running.state = null;
          }
        }
      };
    }
    function updatePaletteDrag(gesture, event, finish) {
      var paletteDragState = gesture.state;
      if (!paletteDragState) return;
      paletteDragState.x = event.clientX;
      paletteDragState.y = event.clientY;
      if (finish) {
        withdrawIntoTargets(paletteDragState);
        var svg = output.querySelector('svg');
        if (!svg) {
          var pendingDrag = paletteDragState;
          gesture.state = null;
          if (pendingDrag && pendingDrag.kind === 'element') {
            addElementWithoutCanvas(pendingDrag.spec);
          }
          return;
        }
        var hit = findItemAtPoint(svg, event.clientX, event.clientY);
        var ds = paletteDragState;
        gesture.state = null;
        if (ds.kind === 'element') {
          // The whole preview pane is the placement surface. Coordinates outside
          // the current SVG viewport intentionally extrapolate so the diagram
          // can grow toward the drop point.
          if (!eventInsidePreview(event)) {
            announce('Drop inside the diagram preview to place an element.', false);
            return;
          }
          if (diagramSupportsAnchoredNotes(documentType()) && ds.spec.isNote) {
            setActiveTool('element', ds.spec);
            if (hit && handleHitboxClickForAnchoredNoteTool({ id: hit.id })) return;
            announce('Drop the note on a diagram element, or click one now.', true);
            return;
          }
          var pt = editorCanvasPoint(svg, event.clientX, event.clientY);
          if (hit && ds.targets && refuseMarkedDrop(ds.targets.candidates, hit.id, buildOperation('element.add',
            { tool: ds.spec.id, name: null, into: hit.id, anchor: null, placed: 'dropped' }, { at: pt }, null))) return;
          placeElementAt(ds.spec, pt);
        } else {
          // Relation: drop on element → use as source, await target click.
          if (documentType() === 'sequence' && ds.spec && ds.spec.sequenceSingle) {
            setActiveTool('relation', ds.spec);
            if (!hit) {
              // Drop on the lifeline body (not the head) — use the drop point as
              // both the lifeline target AND the Y position so the message lands
              // at the dropped height in the sequence.
              var droppedLifeline = findSequenceLifelineAtPoint(svg, event.clientX, event.clientY);
              if (droppedLifeline) {
                var dropPt = editorCanvasPoint(svg, event.clientX, event.clientY);
                addSequenceSingleMessage(ds.spec, droppedLifeline.id, { svg: svg, canvasY: dropPt.y });
                return;
              }
              announce('Drop ' + ds.spec.label + ' on a lifeline, or click a lifeline now. Esc to cancel.', true);
              return;
            }
            addSequenceSingleMessage(ds.spec, hit.id);
            return;
          }
          if (documentType() === 'sequence' && ds.spec && !ds.spec.sequenceSingle && !hit) {
            var lifeline = findSequenceLifelineAtPoint(svg, event.clientX, event.clientY);
            if (lifeline) hit = { id: lifeline.id, hitbox: null };
          }
          if (!hit) {
            // Activate connect-mode anyway and prompt to click a source.
            setActiveTool('relation', ds.spec);
            announce(documentType() === 'sequence'
              ? 'Drag from a lifeline to add a ' + ds.spec.label + ' message. Esc to cancel.'
              : 'Click a source element for the ' + ds.spec.label + ' relation. Esc to cancel.', true);
            return;
          }
          setActiveTool('relation', ds.spec);
          toolState.pendingRelation = { spec: ds.spec, sourceId: hit.id };
          if (hit.hitbox && hit.hitbox.classList) hit.hitbox.classList.add('is-relation-source');
          announce('Source = "' + hit.id + '". Now click the target element. Esc to cancel.', true);
        }
      }
    }
    function handleCanvasPointerDown(svg, event) {
      if (!toolState.activeTool || toolState.activeTool.kind !== 'element') return false;
      // Don't handle if click landed on a hitbox (those have their own handler).
      var target = event.target;
      while (target && target !== svg) {
        if (target.classList && (target.classList.contains('uml-pg-edit-hitbox') || target.classList.contains('uml-pg-edge-hitbox'))) {
          return false;
        }
        target = target.parentNode;
      }
      event.preventDefault();
      var pt = editorCanvasPoint(svg, event.clientX, event.clientY);
      placeElementAt(toolState.activeTool.spec, pt);
      return true;
    }
    // A press on the preview pane beside the drawing, with an element tool armed: a click there places
    // the element; a press that moves more than 5 px places nothing.
    function startPreviewPlacement(event) {
      if (!toolState.activeTool || toolState.activeTool.kind !== 'element') return null;
      if (!eventInsidePreview(event)) return null;

      // Clicks that start inside the SVG are handled by the SVG-level
      // click-vs-pan logic. This listener owns the rest of the preview pane.
      if (event.target && event.target.closest && event.target.closest('#uml-pg-output svg')) return null;

      event.preventDefault();
      var startX = event.clientX;
      var startY = event.clientY;
      var moved = false;
      return {
        move: function (moveEvent) {
          if (Math.abs(moveEvent.clientX - startX) > 5 || Math.abs(moveEvent.clientY - startY) > 5) {
            moved = true;
          }
        },
        end: function (upEvent) {
          if (moved) return;
          if (!toolState.activeTool || toolState.activeTool.kind !== 'element') return;
          var svg = output.querySelector('svg');
          if (!svg) {
            addElementWithoutCanvas(toolState.activeTool.spec);
            return;
          }
          placeElementAt(toolState.activeTool.spec, editorCanvasPoint(svg, upEvent.clientX, upEvent.clientY));
        },
        cancel: function () {}
      };
    }
    function startPlacementPress(ev, press) {
      if (press.site === 'preview') return startPreviewPlacement(ev);
      if (press.site !== 'canvas' || press.landedOnInteractive) return null;
      var svg = press.svg;
      // Empty canvas: begin a click-vs-pan gesture. We commit to one or the
      // other on pointermove (>5 px → pan) or pointerup (no movement →
      // click). Marquee select (Shift+drag) is handled by a separate
      // listener on the #uml-pg-output container so it works even when the
      // pointerdown lands outside the SVG's reported bbox (some renderers
      // collapse the SVG's getBoundingClientRect to 0×0 while painting
      // content outside it).
      if (ev.shiftKey && !toolState.activeTool) return null;
      ev.preventDefault();
      var startX = ev.clientX, startY = ev.clientY;
      var startPan = { x: panOffset.x, y: panOffset.y };
      var moved = false;
      return {
        move: function (mv) {
          var dx = mv.clientX - startX, dy = mv.clientY - startY;
          if (!moved && Math.abs(dx) <= 5 && Math.abs(dy) <= 5) return;
          moved = true;
          svg.classList.add('uml-pg-panning');
          panOffset.x = startPan.x + dx;
          panOffset.y = startPan.y + dy;
          applyPanTransform(svg);
        },
        end: function (up) {
          svg.classList.remove('uml-pg-panning');
          if (moved) return; // pan committed, no click action
          // Treat as click on empty canvas
          if (handleCanvasPointerDown(svg, up)) return; // place tool succeeded
          if (toolState.activeTool) {
            setActiveTool(null);
            announce('Cancelled.', false);
          } else if (selectionSize() > 0) {
            setSelectedLayoutId(null);
          }
        },
        cancel: function () { svg.classList.remove('uml-pg-panning'); }
      };
    }

    return {
      link: function () {
        addElementWithoutCanvas = kit.addElementWithoutCanvas;
        addSequenceSingleMessage = kit.addSequenceSingleMessage;
        announce = kit.announce;
        applyPanTransform = kit.applyPanTransform;
        buildOperation = kit.buildOperation;
        documentType = kit.documentType;
        editorCanvasPoint = kit.editorCanvasPoint;
        findItemAtPoint = kit.findItemAtPoint;
        findSequenceLifelineAtPoint = kit.findSequenceLifelineAtPoint;
        handleHitboxClickForAnchoredNoteTool = kit.handleHitboxClickForAnchoredNoteTool;
        offerTargets = kit.offerTargets;
        panOffset = kit.panOffset;
        placeElementAt = kit.placeElementAt;
        pointer = kit.pointer;
        refuseMarkedDrop = kit.refuseMarkedDrop;
        setActiveTool = kit.setActiveTool;
        toolState = kit.toolState;
        withdrawTargets = kit.withdrawTargets;
      },
      members: {
        createPaletteDragGesture: createPaletteDragGesture,
        pointInsideElement: pointInsideElement,
        startPlacementPress: startPlacementPress
      }
    };
  }

  return { createPaletteGestures: createPaletteGestures };
});
