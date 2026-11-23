(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var parts = root.ArchUMLDiagramEditorParts = root.ArchUMLDiagramEditorParts || {};
    // A second load of the module replaces nothing (spec §2.2).
    if (!parts.gesturesConnect) parts.gesturesConnect = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The connect gesture of a session (UML-view editing spec §2.2, §3.8; plan Task 23): the gesture factory
  // `extend-handle` (a drag from a selected box's handle draws a relation to the box it is dropped on, or places a
  // new box there and connects it), and the hit test of a point against the drawn boxes.
  //
  // The new line's open end is its target, `to` (spec §7.4; plan Task 38): the drag asks the adapter's `targets` once,
  // when it starts, and the boxes it could end on are marked. A drop on a box marked not possible adds nothing and
  // says why. Without advice (the text adapter answers null) nothing is marked and every drop works as before.

  /**
   * The connect gesture.
   *
   * The functions came from the session in the inline script of _includes/uml-editor.html without a changed statement
   * (spec §3.6), except where noted. A part is made from the session's kit (createDiagramEditorSession): it takes the
   * values and the session's functions it uses when it is made, and what it uses of the other parts when the session
   * calls its link(), once every part and the pointer driver exist. Its members join the kit.
   * Changed statements: the reads of the document and the applies go through `kit.commands`.
   */
  function createConnectGestures(kit) {
    // What the session made this part with.
    var commands = kit.commands;
    var env = kit.env;
    var findEditableElements = kit.findEditableElements;
    var host = kit.host;
    var relationSchemasFor = kit.relationSchemasFor;
    var selectWhenDrawn = kit.selectWhenDrawn;
    // What the other parts and the pointer driver give this part, bound by link() once all of them exist.
    var addPortIntoComponent, announce, buildOperation, connectWithSelectedRelationTool, documentType, dragSession,
      drawnPositions, editorCanvasPoint, findSequenceMessageDropTarget, offerTargets, placeElementAt,
      refuseMarkedDrop, selectedRelationToolSpec, showElementChooser, showRelationChooser, withdrawTargets;

    // The extend handle's drag: a press on a box's "+" draws a line from the handle to the pointer; the
    // release connects the box to the one under the pointer, or offers a new element on empty canvas.
    function startExtendHandleDrag(ev, press) {
      // Only the primary button draws a line (a right-click opens the menu).
      if (press.site !== 'extend-handle' || ev.button > 0) return null;
      var ns = 'http://www.w3.org/2000/svg';
      var svg = press.svg;
      var layer = press.layer;
      var hx = press.x, hy = press.y;
      ev.preventDefault();
      ev.stopPropagation();
      press.handle.setPointerCapture(ev.pointerId);
      var startPt = editorCanvasPoint(svg, ev.clientX, ev.clientY);
      var line = env.document.createElementNS(ns, 'line');
      line.setAttribute('class', 'uml-pg-extend-line');
      line.setAttribute('x1', hx);
      line.setAttribute('y1', hy);
      line.setAttribute('x2', startPt.x);
      line.setAttribute('y2', startPt.y);
      layer.appendChild(line);
      var spec = selectedRelationToolSpec();
      var targets = offerTargets(svg, layer, newLineRequest(spec, press.item.id));
      var session = dragSession('extend', { svg: svg, layer: layer, line: line, sourceItem: press.item, sourceHitbox: press.hitbox, originX: hx, originY: hy, targets: targets, spec: spec,
        startClientX: ev.clientX, startClientY: ev.clientY, moved: false },
        updateExtendDrag, clearExtendDrag);
      // A pointer cancel ends the drag as Escape does.
      session.cancelOnPointerCancel = true;
      announce(spec
        ? 'Drag onto a target element to add ' + spec.label + '. Esc to cancel.'
        : 'Drag onto a target element. Release to choose a relation. Esc to cancel.', true);
      return session;
    }
    function clearExtendDrag(gesture) {
      if (gesture.state) withdrawTargets(gesture.state.layer, gesture.state.targets);
      if (gesture.state && gesture.state.line.parentNode) gesture.state.line.parentNode.removeChild(gesture.state.line);
      gesture.state = null;
    }
    // The request for the advice about a new line from `sourceId` with the relation tool `spec` (null before a
    // relation is chosen): relation.add without its open end, `to`.
    function newLineRequest(spec, sourceId) {
      return { op: 'relation.add', tool: spec ? spec.id : null, from: sourceId, label: null, open: 'to' };
    }
    // The relation.add of a new line from `sourceId` to `targetId` with the relation tool `spec`, for asking `can`
    // why a drop is refused; null before a relation is chosen.
    function newLineOperation(spec, sourceId, targetId) {
      return spec ? buildOperation('relation.add', { tool: spec.id, from: sourceId, to: targetId, label: null }, {}, null) : null;
    }
    // Labels, activation bars, anchored notes, messages and fragments have
    // layout ids so they can be moved, but they are not model elements:
    // nothing connects to them.
    function isRelationEndpointId(id) {
      return !!id && !/^(?:actbar|note|label|seqmsg|frag):/.test(String(id));
    }

    // The model element under a point: where a relation being drawn can end.
    function findItemAtPoint(svg, clientX, clientY) {
      var els = env.document.elementsFromPoint(clientX, clientY);
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.classList &&
            (el.classList.contains('uml-pg-edit-hitbox') ||
             el.classList.contains('uml-pg-edit-a11y-target')) &&
            isRelationEndpointId(el.getAttribute('data-layout-id'))) {
          return { id: el.getAttribute('data-layout-id'), hitbox: el };
        }
      }
      var pt = editorCanvasPoint(svg, clientX, clientY);
      var editables = findEditableElements(svg);
      for (var j = editables.length - 1; j >= 0; j--) {
        var item = editables[j];
        if (!item || !item.box || !isRelationEndpointId(item.id)) continue;
        if (pt.x >= item.box.x && pt.x <= item.box.x + item.box.width &&
            pt.y >= item.box.y && pt.y <= item.box.y + item.box.height) {
          return { id: item.id, hitbox: null };
        }
      }
      return null;
    }
    function updateExtendDrag(gesture, ev, finish) {
      var extendDragState = gesture.state;
      if (!extendDragState) return;
      var pt = editorCanvasPoint(extendDragState.svg, ev.clientX, ev.clientY);
      extendDragState.line.setAttribute('x2', pt.x);
      extendDragState.line.setAttribute('y2', pt.y);
      if (Math.abs(ev.clientX - extendDragState.startClientX) > 5 || Math.abs(ev.clientY - extendDragState.startClientY) > 5) {
        extendDragState.moved = true;
      }
      if (finish) {
        // A click on "+" without a drag names no target: it offers a new
        // element to connect to, the same as dropping on empty canvas.
        var dragged = extendDragState.moved;
        var hit = dragged ? findItemAtPoint(extendDragState.svg, ev.clientX, ev.clientY) : null;
        if (dragged && !hit && documentType() === 'sequence') {
          var sequenceTarget = findSequenceMessageDropTarget(extendDragState, ev.clientX, ev.clientY);
          if (sequenceTarget) hit = { id: sequenceTarget.id, hitbox: null };
        }
        var sourceId = extendDragState.sourceItem.id;
        var svg = extendDragState.svg;
        // Clean up the rubberband line and the target marks first
        withdrawTargets(extendDragState.layer, extendDragState.targets);
        if (extendDragState.line.parentNode) extendDragState.line.parentNode.removeChild(extendDragState.line);
        var clientX = ev.clientX, clientY = ev.clientY;
        gesture.state = null;
        if (hit && refuseMarkedDrop(extendDragState.targets, hit.id, newLineOperation(extendDragState.spec, sourceId, hit.id))) return;
        if (!hit) {
          // Drop on empty canvas — offer to create a new element here, then
          // immediately follow up with the relation-type picker so the whole
          // gesture stays in flow.
          showElementChooser(clientX, clientY, sourceId, function (spec) {
            if (!spec) return;
            var type = documentType();
            var newId = commands.contents().uniqueId(spec.base);
            var place = editorCanvasPoint(svg, clientX, clientY);
            // A port/interface created by extending "+" from a component attaches
            // to that source component (the "+" handle only appears on components,
            // so sourceId is one) instead of becoming an orphaned top-level
            // declaration that renders detached from any component border.
            if (type === 'component' && (spec.isPort || spec.isInterface)) {
              var portLabel = spec.isPort
                ? (spec.portKind === 'portin' ? 'in' : 'out')
                : (spec.interfaceKind === 'provide' ? 'P_iface' : 'R_iface');
              addPortIntoComponent(sourceId, spec, newId, portLabel);
              host.redraw();
              selectWhenDrawn({ id: sourceId, kind: 'node' });
              return;
            }
            // Route all elements that need custom source manipulation through
            // placeElementAt. It handles: gitgraph row insertion (branch-safety
            // guard), folder-tree line appending, activity action-chaining,
            // deployment-node nesting, component port host-snapping, note anchoring
            // (arms the attach tool), and structural stubs (pseudo-states,
            // fragments, composite states). placeElementAt also calls
            // snapshotForUndo internally, so we skip the outer call here to
            // avoid a duplicate no-op undo step.
            if (spec.pseudo || spec.activityPseudo || spec.activityDecision || spec.activityFork ||
                spec.activityLane || spec.sequenceFragment || spec.isComposite ||
                spec.gitBranch || spec.gitCommit || spec.folderTreeKind || spec.activityAction ||
                spec.isNote || spec.isPort || spec.isInterface ||
                (type === 'deployment' && (spec.id === 'component' || spec.id === 'artifact'))) {
              placeElementAt(spec, place);
              return;
            }
            // The new element is named here, since its line from sourceId follows.
            commands.apply(buildOperation('element.add',
              { tool: spec.id, name: newId, into: null, anchor: sourceId, placed: 'dropped' },
              { at: place, positions: drawnPositions() }, null));
            env.schedule(function () {
              if (connectWithSelectedRelationTool(sourceId, newId, { snapshot: false })) return;
              showRelationChooser(clientX, clientY, sourceId, newId);
            }, 60);
          });
          return;
        }
        // For diagram types with no relation schemas (venn, gitgraph, folder-tree)
        // there is no connect semantics — redirect a drop-onto-element to the
        // element chooser so "+" remains a useful creation affordance.
        if (!relationSchemasFor(documentType()).length) {
          showElementChooser(clientX, clientY, sourceId, function (spec) {
            if (!spec) return;
            placeElementAt(spec, editorCanvasPoint(svg, clientX, clientY));
          });
          return;
        }
        var targetId = hit.id;
        if (targetId === sourceId && ['class', 'sequence', 'state'].indexOf(documentType()) === -1) {
          announce('Self-relations not supported here.', false);
          return;
        }
        if (connectWithSelectedRelationTool(sourceId, targetId)) return;
        showRelationChooser(clientX, clientY, sourceId, targetId);
      }
    }

    return {
      link: function () {
        addPortIntoComponent = kit.addPortIntoComponent;
        announce = kit.announce;
        buildOperation = kit.buildOperation;
        connectWithSelectedRelationTool = kit.connectWithSelectedRelationTool;
        documentType = kit.documentType;
        dragSession = kit.dragSession;
        drawnPositions = kit.drawnPositions;
        editorCanvasPoint = kit.editorCanvasPoint;
        findSequenceMessageDropTarget = kit.findSequenceMessageDropTarget;
        offerTargets = kit.offerTargets;
        placeElementAt = kit.placeElementAt;
        refuseMarkedDrop = kit.refuseMarkedDrop;
        selectedRelationToolSpec = kit.selectedRelationToolSpec;
        showElementChooser = kit.showElementChooser;
        showRelationChooser = kit.showRelationChooser;
        withdrawTargets = kit.withdrawTargets;
      },
      members: {
        findItemAtPoint: findItemAtPoint,
        isRelationEndpointId: isRelationEndpointId,
        startExtendHandleDrag: startExtendHandleDrag
      }
    };
  }

  return { createConnectGestures: createConnectGestures };
});
