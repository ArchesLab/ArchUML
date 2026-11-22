(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./de-operations.js'));
  } else {
    var parts = root.ArchUMLDiagramEditorParts = root.ArchUMLDiagramEditorParts || {};
    // A second load of the module replaces nothing (spec §2.2).
    if (!parts.placing) parts.placing = factory(parts.operations);
  }
})(typeof self !== 'undefined' ? self : this, function (operations) {
  'use strict';

  // Moves without a drag (UML-view editing spec §3.11, stage A1; plan Task 25b): a box, a port, a label, a note, a
  // card, or a lifeline head, or one bend of a line, moved without a press, and the bend commands. The module holds
  // these once; each surface adds its own ways in (the classic surface's menu and keys, the C4 surface's Move mode).
  //
  // A move without a press is the drag's own session, started by the move or route gesture factory with no pointer
  // down, so the preview, the snapping of a pointer position, a port's border, what a node carries, and the rest of a
  // selection are the drag's. One runs at a time. It ends when its commit starts, so the drawing its own operation
  // causes cancels nothing; any other drawing (the learner typed, undid, switched the diagram type) cancels it.

  var refused = operations.refused;

  // What sync announces when a drawing ends a running move.
  var DRAWING_CHANGED = 'The drawing changed, so the move was cancelled.';

  /** The length of the segment from `a` to `b`. */
  function segmentLength(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  /** The index of the first of the longest segments of the line through `points` (segment i runs from point i). */
  function longestSegmentIndex(points) {
    var longest = 0;
    for (var i = 1; i < points.length - 1; i++) {
      if (segmentLength(points[i], points[i + 1]) > segmentLength(points[longest], points[longest + 1])) longest = i;
    }
    return longest;
  }

  /** The distance from `point` to the segment from `a` to `b`. */
  function distanceToSegment(point, a, b) {
    var length = segmentLength(a, b);
    if (!length) return segmentLength(point, a);
    var along = ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / (length * length);
    var t = Math.max(0, Math.min(1, along));
    return segmentLength(point, { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
  }

  /** The index of the first segment of the line through `points` nearest to `point`. */
  function nearestSegmentIndex(points, point) {
    var nearest = 0;
    for (var i = 1; i < points.length - 1; i++) {
      if (distanceToSegment(point, points[i], points[i + 1]) < distanceToSegment(point, points[nearest], points[nearest + 1])) nearest = i;
    }
    return nearest;
  }

  /**
   * The moves without a drag of a session, made from the session's kit (createDiagramEditorSession) like the other
   * parts: it takes what the session made it with when it is made, and what it uses of the other parts when the
   * session calls its link(). Its members join the kit; the session publishes startPlacing and the bend commands.
   */
  function createPlacing(kit) {
    // What the session made this part with.
    var commands = kit.commands;
    var host = kit.host;
    var output = kit.output;
    // What the other parts give this part, bound by link() once all of them exist.
    var announce, bendableRoute, bendsOf, clearSmartGuides, clonePoints, dropBendHere, dropHere, moveBendBy, moveBy,
      routeLayoutSetOperation, startAt, startBendAt, updateBend, updateDrag;

    // The running move: { placing, gesture }, or null.
    var running = null;

    // The verdict of a commit that comes after its move ended: nothing was applied, and nothing is said.
    function cancelledVerdict() {
      return refused('cancelled', null, null, null);
    }

    /**
     * The placing of `target` over the drag session `gesture`, with the move's own steps: `update(gesture, event,
     * finish)` follows a pointer (and drops at it), `moveBy(gesture, dx, dy)` steps exactly, `dropHere(gesture)` drops
     * where the preview is.
     */
    function placingOf(target, gesture, steps) {
      var lastAt = null;
      function runs() { return !!running && running.placing === placing; }
      // Keeps where the preview shows the moved item or bend, for position() after the move has ended.
      function remember() {
        if (gesture.state) lastAt = { x: gesture.state.at.x, y: gesture.state.at.y };
      }
      var placing = {
        target: target,
        follow: function (event) {
          if (!runs()) return;
          steps.update(gesture, event, false);
          remember();
        },
        nudge: function (dx, dy) {
          if (!runs()) return;
          steps.moveBy(gesture, dx, dy);
          remember();
        },
        // The move ends before its operation is applied, so the drawing that operation causes cancels nothing.
        commit: function (event) {
          if (!runs()) return Promise.resolve(cancelledVerdict());
          running = null;
          var state = gesture.state;
          var dropped = event ? steps.update(gesture, event, true) : steps.dropHere(gesture);
          lastAt = { x: state.at.x, y: state.at.y };
          return Promise.resolve(dropped);
        },
        cancel: function () {
          if (!runs()) return;
          running = null;
          putPreviewBack(gesture);
        },
        position: function () { return lastAt ? { x: lastAt.x, y: lastAt.y } : null; }
      };
      remember();
      return placing;
    }

    // A cancelled move: nothing is applied, and the drawing is made again, which puts the preview back.
    function putPreviewBack(gesture) {
      gesture.cancel();
      clearSmartGuides();
      host.redraw();
    }

    // Ends the running move, if any, as a cancel does.
    function cancelRunning() {
      if (running) running.placing.cancel();
    }

    // Runs `placing` as the one running move and returns it.
    function run(placing, gesture) {
      running = { placing: placing, gesture: gesture };
      return placing;
    }

    // The announcement of a refused start: the refusal's sentence, with its verdict, so a host can show its offer.
    function announceRefusal(verdict) {
      host.announce(verdict.message, { verdict: verdict });
    }

    /**
     * Starts a move without a press (spec §2.4, §3.11): of the box `target.ref` names, or, with `target.bend`, of
     * that bend of the line `target.ref` names. Returns its placing `{ target, follow(event), nudge(dx, dy),
     * commit(event?), cancel(), position() }`, or null: after announcing why when the adapter refuses the move, and
     * without a word for a target no drag moves. A move already running is cancelled first.
     */
    function startPlacing(target) {
      cancelRunning();
      if (!target || !target.ref) return null;
      if (target.bend !== undefined && target.bend !== null) return startBendPlacing(target, null);
      var gesture = startAt(target.ref, announceRefusal);
      if (!gesture) return null;
      return run(placingOf(target, gesture, { update: updateDrag, moveBy: moveBy, dropHere: dropHere }), gesture);
    }

    // The move of bend `target.bend` of a line, starting from the line drawn with `points` (null: as it is drawn).
    function startBendPlacing(target, points) {
      var line = drawnLine(target.ref);
      var drawn = points || (line && line.route.points);
      if (!line || !(target.bend >= 1 && target.bend <= drawn.length - 2)) return null;
      var refusal = commands.can(routeLayoutSetOperation(line.svg, line.route, drawn, null));
      if (!refusal.ok) {
        announceRefusal(refusal);
        return null;
      }
      var gesture = startBendAt(target.ref.id, target.bend, points);
      if (!gesture) return null;
      return run(placingOf(target, gesture, { update: updateBend, moveBy: moveBendBy, dropHere: dropBendHere }), gesture);
    }

    // The drawn line `ref` names whose bends a drag moves, with the drawing it lies in, or null.
    function drawnLine(ref) {
      var svg = output.querySelector('svg');
      var route = svg && ref ? bendableRoute(svg, ref.id) : null;
      return route ? { svg: svg, route: route } : null;
    }

    /**
     * Stores the drawn line `ref` names with `points` as one layout.set (spec §3.11), and reports the verdict as a
     * command does: a refusal is announced and changes nothing. A promise of the verdict.
     */
    function writeLine(ref, pointsOf) {
      var line = drawnLine(ref);
      var points = line ? pointsOf(clonePoints(line.route.points)) : null;
      if (!points || points.length === line.route.points.length) return Promise.resolve(cancelledVerdict());
      return commands.run(routeLayoutSetOperation(line.svg, line.route, points, null));
    }

    return {
      link: function () {
        announce = kit.announce;
        bendableRoute = kit.bendableRoute;
        bendsOf = kit.bendsOf;
        clearSmartGuides = kit.clearSmartGuides;
        clonePoints = kit.clonePoints;
        dropBendHere = kit.dropBendHere;
        dropHere = kit.dropHere;
        moveBendBy = kit.moveBendBy;
        moveBy = kit.moveBy;
        routeLayoutSetOperation = kit.routeLayoutSetOperation;
        startAt = kit.startAt;
        startBendAt = kit.startBendAt;
        updateBend = kit.updateBend;
        updateDrag = kit.updateDrag;
      },
      members: {
        // What a drawing that ends a running move announces; a surface that ends its own ways in says it again
        // after whatever the drawing's cause announced (an Undo's "Undone.").
        drawingChangedMessage: DRAWING_CHANGED,
        startPlacing: startPlacing,
        // The session calls it when a drawing is synced: a move still running ends, nothing is applied, and the
        // learner hears why. Its drawing is a new one, so there is no preview to put back.
        cancelPlacingForNewDrawing: function () {
          if (!running) return;
          var ended = running;
          running = null;
          ended.gesture.cancel();
          announce(DRAWING_CHANGED, false);
        },
        // The session calls it when it is destroyed: a running move is cancelled, and its preview put back.
        cancelPlacing: cancelRunning,
        // The bends of the drawn line `ref` names, numbered from its source end: [{ n, x, y }].
        bends: function (ref) {
          var svg = output.querySelector('svg');
          return svg && ref ? bendsOf(svg, ref.id) : [];
        },
        /**
         * A new bend of the drawn line `ref` names, as a preview until its placing is committed: in the middle of
         * the line's longest segment (the first of equally long ones), or at `at`, in the segment nearest to it. Null
         * when the line takes no bend, or after announcing the adapter's refusal.
         */
        addBend: function (ref, at) {
          cancelRunning();
          var line = drawnLine(ref);
          if (!line) return null;
          var points = clonePoints(line.route.points);
          var segment = at ? nearestSegmentIndex(points, at) : longestSegmentIndex(points);
          var a = points[segment], b = points[segment + 1];
          var point = at ? { x: at.x, y: at.y } : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          points.splice(segment + 1, 0, point);
          return startBendPlacing({ ref: ref, bend: segment + 1 }, points);
        },
        // Removes bend `n` of the drawn line `ref` names. A promise of the verdict.
        removeBend: function (ref, n) {
          return writeLine(ref, function (points) {
            if (n >= 1 && n <= points.length - 2) points.splice(n, 1);
            return points;
          });
        },
        // Leaves the drawn line `ref` names its two ends and no bend. A promise of the verdict.
        straighten: function (ref) {
          return writeLine(ref, function (points) { return [points[0], points[points.length - 1]]; });
        }
      }
    };
  }

  return { createPlacing: createPlacing };
});
