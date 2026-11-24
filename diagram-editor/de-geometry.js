(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var parts = root.ArchUMLDiagramEditorParts = root.ArchUMLDiagramEditorParts || {};
    // A second load of the module replaces nothing (spec §2.2).
    if (!parts.geometry) parts.geometry = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The diagram editor's geometry (UML-view editing spec §2.2; plan Task 22): points, boxes, snapping, alignment
  // guides, free places, overlaps, and route maths. Every function reads only its arguments: no drawing, no page,
  // no clock. A box is `{ x, y, width, height }` and a point `{ x, y }`, both in drawing units.
  //
  // The functions that existed in the inline script of _includes/uml-editor.html moved here without a changed
  // statement (spec §3.6); snap, alignmentGuides, freePlaceRightOf, overlaps, and anchoredRoute name what the
  // editor computed inline, with today's constants.

  // The layout grid a snapped position lands on, in drawing units.
  var SNAP_GRID = 10;
  // The gap between the rightmost drawn box and the free place right of it, and the free place's top.
  var FREE_PLACE_GAP = 60;
  var FREE_PLACE_TOP = 80;
  // An alignment guide reaches this far beyond the two boxes it joins.
  var GUIDE_OVERHANG = 12;

  function containsPoint(box, x, y, pad) {
    pad = pad || 0;
    return x >= box.x - pad && x <= box.x + box.width + pad &&
      y >= box.y - pad && y <= box.y + box.height + pad;
  }
  function containsBox(outer, inner, pad) {
    pad = pad || 0;
    return inner.x >= outer.x - pad &&
      inner.y >= outer.y - pad &&
      inner.x + inner.width <= outer.x + outer.width + pad &&
      inner.y + inner.height <= outer.y + outer.height + pad;
  }
  function unionBox(a, b) {
    var x1 = Math.min(a.x, b.x);
    var y1 = Math.min(a.y, b.y);
    var x2 = Math.max(a.x + a.width, b.x + b.width);
    var y2 = Math.max(a.y + a.height, b.y + b.height);
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  }
  function pointsBox(points) {
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    (points || []).forEach(function (p) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    });
    if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /** Whether boxes `a` and `b` share area: boxes that only touch along an edge do not overlap. */
  function overlaps(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width &&
      a.y < b.y + b.height && b.y < a.y + a.height;
  }

  /** `value` on the nearest line of a `grid` (default SNAP_GRID); a half step rounds up, as Math.round does. */
  function snapCoordinate(value, grid) {
    var step = grid || SNAP_GRID;
    return Math.round(value / step) * step;
  }
  /** `point` on the nearest crossing of a `grid` (default SNAP_GRID). */
  function snap(point, grid) {
    return { x: snapCoordinate(point.x, grid), y: snapCoordinate(point.y, grid) };
  }

  /**
   * Where a box of `size` along `axis` ('x' or 'y') that a drag puts at `position` lands: lined up with a peer box
   * (centre first, then the near edge, then the far edge) within `tolerance`, else on the layout grid.
   */
  function alignedCoordinate(position, size, peers, axis, tolerance) {
    var dimension = axis === 'x' ? 'width' : 'height';
    // Prefer center alignment to a nearby edge, particularly when the two
    // classes have slightly different measured widths.
    var fractions = [0.5, 0, 1];
    for (var i = 0; i < fractions.length; i++) {
      var fraction = fractions[i];
      var closest = null;
      var distance = tolerance;
      peers.forEach(function (box) {
        var candidate = box[axis] + box[dimension] * fraction - size * fraction;
        if (Math.abs(candidate - position) <= distance) {
          closest = candidate;
          distance = Math.abs(candidate - position);
        }
      });
      if (closest !== null) return closest;
    }
    return snapCoordinate(position, SNAP_GRID);
  }

  /**
   * The alignment guides of a box being moved: a line `{ x1, y1, x2, y2 }` wherever an edge or the centre of
   * `moving` lies within `tolerance` of an edge or the centre of one of `others`, reaching a little beyond both
   * boxes. `tolerance` is in drawing units, one number or `{ x, y }`; the editor passes four screen pixels.
   */
  function alignmentGuides(moving, others, tolerance) {
    var within = typeof tolerance === 'number' ? { x: tolerance, y: tolerance } : tolerance;
    var guides = [];
    var movedCx = moving.x + moving.width / 2;
    var movedCy = moving.y + moving.height / 2;
    others.forEach(function (b) {
      var bCx = b.x + b.width / 2;
      var bCy = b.y + b.height / 2;
      // Vertical guides (matching X centres / edges).
      var movedXs = [moving.x, movedCx, moving.x + moving.width];
      var bXs = [b.x, bCx, b.x + b.width];
      for (var i = 0; i < movedXs.length; i++) {
        for (var j = 0; j < bXs.length; j++) {
          if (Math.abs(movedXs[i] - bXs[j]) <= within.x) {
            var x = bXs[j];
            var top = Math.min(moving.y, b.y) - GUIDE_OVERHANG;
            var bot = Math.max(moving.y + moving.height, b.y + b.height) + GUIDE_OVERHANG;
            guides.push({ x1: x, y1: top, x2: x, y2: bot });
          }
        }
      }
      // Horizontal guides.
      var movedYs = [moving.y, movedCy, moving.y + moving.height];
      var bYs = [b.y, bCy, b.y + b.height];
      for (var k = 0; k < movedYs.length; k++) {
        for (var m = 0; m < bYs.length; m++) {
          if (Math.abs(movedYs[k] - bYs[m]) <= within.y) {
            var y = bYs[m];
            var left = Math.min(moving.x, b.x) - GUIDE_OVERHANG;
            var right = Math.max(moving.x + moving.width, b.x + b.width) + GUIDE_OVERHANG;
            guides.push({ x1: left, y1: y, x2: right, y2: y });
          }
        }
      }
    });
    return guides;
  }

  /**
   * Where a box added without a drop point goes: right of the rightmost of the drawn `boxes`, with today's gap.
   * `size`, the new box's size where a host knows it, does not change the place today.
   */
  function freePlaceRightOf(boxes, size) {
    var right = boxes.reduce(function (edge, box) {
      return Math.max(edge, box.x + box.width);
    }, FREE_PLACE_GAP);
    return { x: right + FREE_PLACE_GAP, y: FREE_PLACE_TOP };
  }

  // ─── Route maths ───
  // A copy of `points`, as the bundle's cloneRoutePoints makes one.
  function copyPoints(points) {
    return (points || []).map(function (p) { return { x: Number(p.x) || 0, y: Number(p.y) || 0 }; });
  }
  function editableRouteSegmentIndices(route, lockedEndpoints) {
    var count = route && route.points ? route.points.length : 0;
    if (count < 2) return [];
    if (!lockedEndpoints) {
      var all = [];
      for (var ai = 0; ai < count - 1; ai++) all.push(ai);
      return all;
    }
    if (count === 2) return [0];
    if (count === 3) {
      var a = route.points[0];
      var b = route.points[1];
      var c = route.points[2];
      var firstLen = Math.abs((b.x || 0) - (a.x || 0)) + Math.abs((b.y || 0) - (a.y || 0));
      var secondLen = Math.abs((c.x || 0) - (b.x || 0)) + Math.abs((c.y || 0) - (b.y || 0));
      return [secondLen >= firstLen ? 1 : 0];
    }
    var inner = [];
    for (var ii = 1; ii < count - 2; ii++) inner.push(ii);
    return inner;
  }
  function anchoredTwoPointRoute(points, moveX, moveY) {
    var a = points[0];
    var b = points[1];
    var segDx = b.x - a.x;
    var segDy = b.y - a.y;
    if (Math.abs(segDx) >= Math.abs(segDy)) {
      return [
        { x: a.x, y: a.y },
        { x: a.x, y: a.y + moveY },
        { x: b.x, y: b.y + moveY },
        { x: b.x, y: b.y }
      ];
    }
    return [
      { x: a.x, y: a.y },
      { x: a.x + moveX, y: a.y },
      { x: b.x + moveX, y: b.y },
      { x: b.x, y: b.y }
    ];
  }
  function anchoredThreePointRoute(points, segmentIndex, moveX, moveY) {
    if (!points || points.length !== 3) return copyPoints(points);
    var start = points[0];
    var a = points[segmentIndex] || points[0];
    var b = points[segmentIndex + 1] || points[2];
    var end = points[2];
    var segDx = b.x - a.x;
    var segDy = b.y - a.y;
    if (Math.abs(segDx) >= Math.abs(segDy)) {
      var y = a.y + moveY;
      return [
        { x: start.x, y: start.y },
        { x: start.x, y: y },
        { x: end.x, y: y },
        { x: end.x, y: end.y }
      ];
    }
    var x = a.x + moveX;
    return [
      { x: start.x, y: start.y },
      { x: x, y: start.y },
      { x: x, y: end.y },
      { x: end.x, y: end.y }
    ];
  }
  /**
   * The route a drag of segment `segmentIndex` of `points` from `from` to `to` makes when the route's two ends stay
   * on their boxes: a two- or three-point route gains the bends that carry the dragged segment; any other route
   * moves that segment alone.
   */
  function anchoredRoute(from, to, points, segmentIndex) {
    var moveX = to.x - from.x;
    var moveY = to.y - from.y;
    var si = segmentIndex || 0;
    if (points.length === 2) return anchoredTwoPointRoute(points, moveX, moveY);
    if (points.length === 3) return anchoredThreePointRoute(points, si, moveX, moveY);
    var next = copyPoints(points);
    next[si] = { x: points[si].x + moveX, y: points[si].y + moveY };
    next[si + 1] = { x: points[si + 1].x + moveX, y: points[si + 1].y + moveY };
    return next;
  }
  function constrainedPortPosition(item, x, y) {
    if (!item || item.axis !== 'port' || !item.parentBox) return { x: x, y: y };
    var box = item.parentBox;
    var inset = 8;
    var minX = box.x + inset;
    var maxX = box.x + box.width - inset;
    var minY = box.y + inset;
    var maxY = box.y + box.height - inset;
    if (maxX < minX) {
      minX = box.x;
      maxX = box.x + box.width;
    }
    if (maxY < minY) {
      minY = box.y;
      maxY = box.y + box.height;
    }
    function clamp(v, lo, hi) {
      return Math.max(lo, Math.min(hi, v));
    }
    var choices = [
      { side: 'left', x: box.x, y: clamp(y, minY, maxY), distance: Math.abs(x - box.x) },
      { side: 'right', x: box.x + box.width, y: clamp(y, minY, maxY), distance: Math.abs(x - (box.x + box.width)) },
      { side: 'top', x: clamp(x, minX, maxX), y: box.y, distance: Math.abs(y - box.y) },
      { side: 'bottom', x: clamp(x, minX, maxX), y: box.y + box.height, distance: Math.abs(y - (box.y + box.height)) }
    ];
    choices.sort(function (a, b) {
      if (Math.abs(a.distance - b.distance) > 0.75) return a.distance - b.distance;
      if (a.side === item.portSide) return -1;
      if (b.side === item.portSide) return 1;
      return 0;
    });
    return { x: choices[0].x, y: choices[0].y, side: choices[0].side };
  }
  /** Whether the end `endpointIndex` of a drawn route lies on (or close around) the drawn `item`'s box. */
  function routeEndpointTouchesItem(route, endpointIndex, item) {
    if (!route || !route.points || !item || !item.box) return false;
    var point = route.points[endpointIndex];
    if (!point) return false;
    var pad = Math.max(10, Math.min(item.box.width || 0, item.box.height || 0) * 0.18);
    return containsPoint(item.box, point.x, point.y, pad);
  }

  // ─── The "⋯" button's place (spec §3.11; plan Task 25c) ───
  // Everything here is in screen space (CSS pixels after the view transform). A hit target is a box, or a segment
  // `{ a, b, halfWidth }`: a line drawn `2 × halfWidth` wide from `a` to `b`.

  // The gap between the button and the item it belongs to, in CSS pixels.
  var ACTION_BUTTON_GAP = 4;

  function distance(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }
  function distanceToSegment(point, a, b) {
    var length = distance(a, b);
    if (!length) return distance(point, a);
    var along = ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / (length * length);
    var t = Math.max(0, Math.min(1, along));
    return distance(point, { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
  }
  function distanceToBox(point, box) {
    var dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.width));
    var dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.height));
    return Math.hypot(dx, dy);
  }
  // Whether the segments p1–p2 and q1–q2 cross or touch.
  function segmentsCross(p1, p2, q1, q2) {
    function side(a, b, c) { return Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)); }
    return side(p1, p2, q1) * side(p1, p2, q2) <= 0 && side(q1, q2, p1) * side(q1, q2, p2) <= 0;
  }
  /** The shortest distance between the segment from `a` to `b` and `box` (0 when the segment enters the box). */
  function segmentDistanceToBox(a, b, box) {
    if (containsPoint(box, a.x, a.y) || containsPoint(box, b.x, b.y)) return 0;
    var corners = [
      { x: box.x, y: box.y }, { x: box.x + box.width, y: box.y },
      { x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height }
    ];
    for (var i = 0; i < 4; i++) {
      if (segmentsCross(a, b, corners[i], corners[(i + 1) % 4])) return 0;
    }
    return Math.min(
      distanceToBox(a, box), distanceToBox(b, box),
      Math.min.apply(null, corners.map(function (corner) { return distanceToSegment(corner, a, b); }))
    );
  }
  /** Whether the square `square` shares area with the hit target `target` (a box, or a segment with a half width). */
  function overlapsHitTarget(square, target) {
    if (target.a && target.b) return segmentDistanceToBox(target.a, target.b, square) < (target.halfWidth || 0);
    return overlaps(square, target);
  }
  // The places a button of `size` may take beside the box `box`, in the order they are tried.
  function placesBesideBox(box, size) {
    var gap = ACTION_BUTTON_GAP;
    var right = box.x + box.width;
    return [
      { x: right - size, y: box.y - gap - size },
      { x: right + gap, y: box.y },
      { x: right - size, y: box.y + box.height + gap },
      { x: box.x - gap - size, y: box.y }
    ];
  }
  // The places a button of `size` may take beside the middle of the longest segment of the line through `points`
  // (the first of equally long ones), clear of the segment's hit target of `halfWidth`: first on the side the line's
  // left hand points to as it runs from its first point, then on the other.
  function placesBesideLine(points, halfWidth, size) {
    var longest = 0;
    for (var i = 1; i < points.length - 1; i++) {
      if (distance(points[i], points[i + 1]) > distance(points[longest], points[longest + 1])) longest = i;
    }
    var a = points[longest];
    var b = points[longest + 1];
    var length = distance(a, b) || 1;
    var normal = { x: (b.y - a.y) / length, y: -(b.x - a.x) / length };
    // The centre's distance from the segment that keeps the square, whatever the segment's slope, clear of it.
    var reach = (halfWidth || 0) + ACTION_BUTTON_GAP + (size / 2) * (Math.abs(normal.x) + Math.abs(normal.y));
    var middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    return [1, -1].map(function (sign) {
      return { x: middle.x + sign * normal.x * reach - size / 2, y: middle.y + sign * normal.y * reach - size / 2 };
    });
  }
  /**
   * Where the "⋯" button of `target` goes (spec §3.11): `target` is `{ box }` for an element or `{ points, halfWidth }`
   * for a line, `hitTargets` the hit targets of the layer (the item's own among them), and `size` the button's side.
   * Returns the top-left corner of the first place where the button's square overlaps no hit target, with `free:
   * true`; when every place overlaps one, the first place with `free: false` (the surface then draws the button under
   * the targets).
   */
  function actionButtonPlace(target, hitTargets, size) {
    var places = target.box ? placesBesideBox(target.box, size) : placesBesideLine(target.points, target.halfWidth, size);
    for (var i = 0; i < places.length; i++) {
      var square = { x: places[i].x, y: places[i].y, width: size, height: size };
      var blocked = hitTargets.some(function (hit) { return overlapsHitTarget(square, hit); });
      if (!blocked) return { x: places[i].x, y: places[i].y, free: true };
    }
    return { x: places[0].x, y: places[0].y, free: false };
  }

  return {
    SNAP_GRID: SNAP_GRID,
    actionButtonPlace: actionButtonPlace,
    containsPoint: containsPoint,
    containsBox: containsBox,
    unionBox: unionBox,
    pointsBox: pointsBox,
    overlaps: overlaps,
    snap: snap,
    snapCoordinate: snapCoordinate,
    alignedCoordinate: alignedCoordinate,
    alignmentGuides: alignmentGuides,
    freePlaceRightOf: freePlaceRightOf,
    editableRouteSegmentIndices: editableRouteSegmentIndices,
    anchoredTwoPointRoute: anchoredTwoPointRoute,
    anchoredThreePointRoute: anchoredThreePointRoute,
    anchoredRoute: anchoredRoute,
    constrainedPortPosition: constrainedPortPosition,
    routeEndpointTouchesItem: routeEndpointTouchesItem
  };
});
