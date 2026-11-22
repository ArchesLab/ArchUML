(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./de-geometry.js'), require('./de-scene.js'));
  } else {
    var parts = root.ArchUMLDiagramEditorParts = root.ArchUMLDiagramEditorParts || {};
    // A second load of the module replaces nothing (spec §2.2).
    if (!parts.gesturesRoutes) parts.gesturesRoutes = factory(parts.geometry, parts.scene);
  }
})(typeof self !== 'undefined' ? self : this, function (geometry, scene) {
  'use strict';

  // The route gestures of a session (UML-view editing spec §2.2, §3.8; plan Task 23): the drawn routes and their
  // overlays as a drag changes them, the routes a moved box drags along, and the route edit, the gesture factory
  // `route-edit` (a press on a line's segment moves the segment, or a sequence message to another height). Since stage
  // A1 (spec §3.11; plan Task 25b) also the move of one bend without a press, and the bend numbers of a selected line.

  // What this file uses of the parts before it in diagram-editor/manifest.json.
  var cssAttrEscape = scene.cssAttrEscape;
  var pointsBox = geometry.pointsBox;
  var routeEndpointTouchesItem = geometry.routeEndpointTouchesItem;
  var snapCoordinate = geometry.snapCoordinate;

  /**
   * The route gestures.
   *
   * The functions came from the session in the inline script of _includes/uml-editor.html without a changed statement
   * (spec §3.6), except where noted. A part is made from the session's kit (createDiagramEditorSession): it takes the
   * values and the session's functions it uses when it is made, and what it uses of the other parts when the session
   * calls its link(), once every part and the pointer driver exist. Its members join the kit.
   */
  function createRouteGestures(kit) {
    // What the session made this part with.
    var bendNumbers = !!kit.bendNumbers;
    var clonePointsOf = kit.clonePointsOf;
    var env = kit.env;
    var findEditableRoutes = kit.findEditableRoutes;
    var layoutRouteStorageKey = kit.layoutRouteStorageKey;
    var output = kit.output;
    var selectedLayout = kit.selectedLayout;
    var setSelectedLayoutId = kit.setSelectedLayoutId;
    var snapToggle = kit.snapToggle;
    // What the other parts and the pointer driver give this part, bound by link() once all of them exist.
    var clearMove, documentType, dragSession, dropRoutePoints, editorCanvasPoint, toolState, updateDrag;

    function clonePoints(points) {
      return clonePointsOf(points, env.bundle);
    }
    function setRouteOverlaySegment(seg, p1, p2) {
      seg.setAttribute('x1', p1.x);
      seg.setAttribute('y1', p1.y);
      seg.setAttribute('x2', p2.x);
      seg.setAttribute('y2', p2.y);
    }
    function syncRouteOverlays(layer, routeId, points) {
      if (!layer) return;
      if (bendNumbers) showBendNumbers();
      Array.prototype.slice.call(layer.querySelectorAll('.uml-pg-edge-hitbox[data-route-id="' + cssAttrEscape(routeId) + '"]')).forEach(function (seg) {
        var idx = Number(seg.getAttribute('data-segment-index'));
        if (seg.getAttribute('data-locked-endpoints') === 'true' && points.length === 4 && idx === 0) {
          setRouteOverlaySegment(seg, points[1], points[2]);
          return;
        }
        if (!points[idx] || !points[idx + 1]) return;
        setRouteOverlaySegment(seg, points[idx], points[idx + 1]);
      });
    }
    function applyRoutePoints(route, points) {
      if (env.bundle.UMLShared && env.bundle.UMLShared.setRoutePointsForElement) {
        if (env.bundle.UMLShared.moveRouteDecorations && route.element) {
          env.bundle.UMLShared.moveRouteDecorations(route.element.ownerSVGElement, route.element, route.points, points);
        }
        route.element = env.bundle.UMLShared.setRoutePointsForElement(route.element, points) || route.element;
        route.points = clonePoints(points);
        route.box = pointsBox(points);
      }
    }
    function collectConnectedRoutes(svg, id) {
      var item = arguments.length > 2 ? arguments[2] : null;
      return findEditableRoutes(svg).filter(function (route) {
        return routeEndpointBelongsToItem(route, 0, id, item) ||
          routeEndpointBelongsToItem(route, route.points.length - 1, id, item);
      }).map(function (route) {
        return {
          route: route,
          points: clonePoints(route.points),
          source: route.source,
          target: route.target,
          sourceIds: routeEndpointBelongsToItem(route, 0, id, item) ? [id] : [],
          targetIds: routeEndpointBelongsToItem(route, route.points.length - 1, id, item) ? [id] : []
        };
      });
    }
    function routeEndpointBelongsTo(endpoint, id) {
      if (!endpoint || !id) return false;
      if (endpoint === id) return true;
      return (documentType() || '') === 'component' && endpoint.indexOf(id + '.') === 0;
    }
    function routeEndpointBelongsToItem(route, endpointIndex, id, item) {
      var endpointName = endpointIndex === 0 ? route.source : route.target;
      return routeEndpointBelongsTo(endpointName, id) || routeEndpointTouchesItem(route, endpointIndex, item);
    }
    function routeEntryKey(entry) {
      if (!entry || !entry.route) return '';
      if (entry.route.id) return entry.route.id;
      return (entry.route.source || '') + '|' + (entry.route.target || '') + '|' + (entry.route.index || 0);
    }
    function mergeConnectedRouteEntries() {
      var merged = {};
      function addEntries(entries) {
        (entries || []).forEach(function (entry) {
          var key = routeEntryKey(entry);
          if (!key) return;
          if (!merged[key]) {
            merged[key] = {
              route: entry.route,
              points: clonePoints(entry.points),
              source: entry.source,
              target: entry.target,
              sourceIds: [],
              targetIds: []
            };
          }
          ['sourceIds', 'targetIds'].forEach(function (field) {
            (entry[field] || []).forEach(function (id) {
              if (merged[key][field].indexOf(id) === -1) merged[key][field].push(id);
            });
          });
        });
      }
      for (var i = 0; i < arguments.length; i++) addEntries(arguments[i]);
      return Object.keys(merged).map(function (key) { return merged[key]; });
    }
    function routeDeltaForEndpoint(endpoint, endpointIds, deltas) {
      var ids = endpointIds || [];
      for (var i = 0; i < ids.length; i++) {
        if (deltas[ids[i]]) return deltas[ids[i]];
      }
      if (endpoint && deltas[endpoint]) return deltas[endpoint];
      if ((documentType() || '') === 'component' && endpoint) {
        for (var id in deltas) {
          if (Object.prototype.hasOwnProperty.call(deltas, id) && endpoint.indexOf(id + '.') === 0) return deltas[id];
        }
      }
      return null;
    }
    function shiftRoutePoints(points, sourceDelta, targetDelta) {
      if (env.bundle.UMLShared && env.bundle.UMLShared.shiftRoutePoints) {
        return env.bundle.UMLShared.shiftRoutePoints(points, sourceDelta, targetDelta);
      }
      return clonePoints(points);
    }
    function applyConnectedRouteDeltas(routes, deltas, layer) {
      (routes || []).forEach(function (entry) {
        var sourceDelta = routeDeltaForEndpoint(entry.source, entry.sourceIds, deltas);
        var targetDelta = routeDeltaForEndpoint(entry.target, entry.targetIds, deltas);
        if (!sourceDelta && !targetDelta) return;
        var next = shiftRoutePoints(entry.points, sourceDelta, targetDelta);
        applyRoutePoints(entry.route, next);
        syncRouteOverlays(layer, entry.route.id, next);
      });
    }
    // After a node is moved, persisted route overrides (the `edge "id"
    // points="…"` lines in the source) still reference the pre-move
    // endpoint coordinates. On the next render `applyLayoutRoutes` would
    // override the renderer's freshly-computed endpoints with those stale
    // points, snapping messages off their lifelines and associations off
    // their classes. Shift the persisted points by the same deltas the
    // live SVG just took on so the saved overrides stay attached to the
    // moved nodes.
    function shiftPersistedRouteEndpoints(routes, connectedRoutes, deltas) {
      if (!routes || !connectedRoutes) return;
      connectedRoutes.forEach(function (entry) {
        if (!entry || !entry.route || !entry.route.id) return;
        var routeKey = layoutRouteStorageKey(routes, entry.route);
        var stored = routeKey ? routes[routeKey] : null;
        if (!stored || !stored.points || stored.points.length < 2) return;
        var sourceDelta = routeDeltaForEndpoint(entry.source, entry.sourceIds, deltas);
        var targetDelta = routeDeltaForEndpoint(entry.target, entry.targetIds, deltas);
        if (!sourceDelta && !targetDelta) return;
        routes[routeKey] = { points: shiftRoutePoints(stored.points, sourceDelta, targetDelta) };
      });
    }
    function routeElementTag(route) {
      return route && route.element && route.element.tagName ? route.element.tagName.toLowerCase() : '';
    }
    function routeUsesLockedEndpoints(route) {
      if ((documentType() || '') === 'sequence') return false;
      return routeElementTag(route) !== 'rect';
    }
    // The route edit: a press on a line's segment drags the segment (a sequence message: the message to
    // another height); the release stores the bends or the message's new place.
    function startRouteEdit(event, press) {
      if (press.site !== 'segment' || toolState.activeTool) return null;
      var svg = press.svg;
      var route = press.route;
      var start = editorCanvasPoint(svg, event.clientX, event.clientY);
      var segmentIndex = Number(event.currentTarget.getAttribute('data-segment-index'));
      var locked = event.currentTarget.getAttribute('data-locked-endpoints') === 'true';
      setSelectedLayoutId(route.id, 'route');
      var session = dragSession('drag', {
        kind: 'route',
        svg: svg,
        layer: press.layer,
        route: route,
        segmentIndex: segmentIndex,
        lockedEndpoints: locked,
        start: start,
        startClient: { x: event.clientX, y: event.clientY },
        points: clonePoints(route.points)
      }, updateDrag, clearMove);
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch (e) {}
      return session;
    }

    // ---------- bends (spec §3.11) ----------
    // A bend is a point of a line between its two ends, numbered from the line's source end, from 1.

    // The drawn line `routeId` whose bends a press on its segment moves today: not a sequence message, which a
    // drag moves or retargets instead. Null for none.
    function bendableRoute(svg, routeId) {
      if (!svg) return null;
      if ((documentType() || '') === 'sequence' && /^seqmsg:\d+$/.test(String(routeId || ''))) return null;
      return findEditableRoutes(svg).find(function (route) { return route.id === routeId; }) || null;
    }
    // The bends of the drawn line `routeId`, in order from its source end: `[{ n, x, y }]`.
    function bendsOf(svg, routeId) {
      var route = bendableRoute(svg, routeId);
      if (!route) return [];
      return route.points.slice(1, -1).map(function (point, at) { return { n: at + 1, x: point.x, y: point.y }; });
    }
    /**
     * The move of bend `n` of the drawn line `routeId` without a press: the session of a route drag that moves that
     * one point, starting from the line drawn with `points` (its drawn points, or the preview of a new bend), or null
     * when the line has no bend `n`. The line is selected.
     */
    function startBendAt(routeId, n, points) {
      var svg = output.querySelector('svg');
      var layer = svg && svg.querySelector('.uml-pg-edit-layer');
      var route = layer ? bendableRoute(svg, routeId) : null;
      var drawn = points || (route && route.points);
      if (!route || !(n >= 1 && n <= drawn.length - 2)) return null;
      setSelectedLayoutId(route.id, 'route');
      var session = dragSession('drag', {
        kind: 'bend',
        svg: svg,
        layer: layer,
        route: route,
        bend: n,
        points: clonePoints(drawn),
        at: { x: drawn[n].x, y: drawn[n].y }
      }, updateBend, clearMove);
      if (points) showBendAt(session, session.state.at, false);
      return session;
    }
    // A pointer over the canvas puts the bend where it points, on the grid while the Snap box is checked, as the
    // route drag rounds a segment's place; a release there drops the line's points.
    function updateBend(gesture, event, finish) {
      var state = gesture.state;
      if (!state) return null;
      var now = editorCanvasPoint(state.svg, event.clientX, event.clientY);
      if (snapToggle && snapToggle.checked) now = { x: snapCoordinate(now.x), y: snapCoordinate(now.y) };
      return showBendAt(gesture, now, finish);
    }
    // The preview of the line with its bend at `point`; with `finish` the line's points are dropped. Returns the
    // drop's verdict, or the apply's promise of it.
    function showBendAt(gesture, point, finish) {
      var state = gesture.state;
      var nextPoints = clonePoints(state.points);
      nextPoints[state.bend] = { x: point.x, y: point.y };
      state.at = { x: point.x, y: point.y };
      applyRoutePoints(state.route, nextPoints);
      syncRouteOverlays(state.layer, state.route.id, nextPoints);
      return finish ? dropRoutePoints(gesture, nextPoints) : null;
    }
    // Moves a running bend's preview by exactly (dx, dy): no grid pulls a step.
    function moveBendBy(gesture, dx, dy) {
      var state = gesture.state;
      if (state) showBendAt(gesture, { x: state.at.x + dx, y: state.at.y + dy }, false);
    }
    // Drops a running bend's move where its preview shows the bend, with no snapping.
    function dropBendHere(gesture) {
      var state = gesture.state;
      return state ? showBendAt(gesture, state.at, true) : null;
    }
    // Shows the number of each bend of the selected line, when exactly one thing is selected and it is a line
    // (mount's `bendNumbers`): text in a mark at the bend, hidden from assistive technology (the bends are named
    // in the line's menu), no tab stop, and no pointer target. Any other selection shows none.
    function showBendNumbers() {
      var svg = output.querySelector('svg');
      var layer = svg && svg.querySelector('.uml-pg-edit-layer');
      if (!layer) return;
      Array.prototype.slice.call(layer.querySelectorAll('.uml-pg-bend-number')).forEach(function (mark) { mark.remove(); });
      var selected = selectedLayout.all();
      if (selected.length !== 1 || selected[0].kind !== 'route') return;
      var ns = 'http://www.w3.org/2000/svg';
      bendsOf(svg, selected[0].id).forEach(function (bend) {
        var mark = env.document.createElementNS(ns, 'g');
        mark.setAttribute('class', 'uml-pg-bend-number');
        mark.setAttribute('aria-hidden', 'true');
        mark.setAttribute('transform', 'translate(' + bend.x + ' ' + bend.y + ')');
        var disc = env.document.createElementNS(ns, 'circle');
        disc.setAttribute('class', 'uml-pg-bend-number-disc');
        var text = env.document.createElementNS(ns, 'text');
        text.setAttribute('class', 'uml-pg-bend-number-text');
        text.textContent = String(bend.n);
        mark.appendChild(disc);
        mark.appendChild(text);
        layer.appendChild(mark);
      });
    }

    return {
      link: function () {
        clearMove = kit.clearMove;
        documentType = kit.documentType;
        dragSession = kit.dragSession;
        dropRoutePoints = kit.dropRoutePoints;
        editorCanvasPoint = kit.editorCanvasPoint;
        toolState = kit.toolState;
        updateDrag = kit.updateDrag;
      },
      members: {
        applyConnectedRouteDeltas: applyConnectedRouteDeltas,
        applyRoutePoints: applyRoutePoints,
        bendableRoute: bendableRoute,
        bendsOf: bendsOf,
        clonePoints: clonePoints,
        collectConnectedRoutes: collectConnectedRoutes,
        dropBendHere: dropBendHere,
        mergeConnectedRouteEntries: mergeConnectedRouteEntries,
        moveBendBy: moveBendBy,
        routeUsesLockedEndpoints: routeUsesLockedEndpoints,
        setRouteOverlaySegment: setRouteOverlaySegment,
        shiftPersistedRouteEndpoints: shiftPersistedRouteEndpoints,
        showBendNumbers: showBendNumbers,
        startBendAt: startBendAt,
        startRouteEdit: startRouteEdit,
        syncRouteOverlays: syncRouteOverlays,
        updateBend: updateBend
      }
    };
  }

  return { createRouteGestures: createRouteGestures };
});
