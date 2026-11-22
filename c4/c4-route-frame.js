(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var parts = root.ArchUMLC4RouteParts = root.ArchUMLC4RouteParts || {};
    parts.frame = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The frame and the geometry every routing step shares (routing redesign §3.3, §5.0, §5.1): the routing constants,
  // the scene in the flow frame, where the flow points down (a view laid out to the right is transposed in and out),
  // what every step asks of it (rectangles, nesting, bundles, label sizes, the obstacles every label keeps clear of),
  // rectangle and segment geometry, and the geometric classes of an edge. `CFG` is the one source of the routing
  // constants: c4-route.js publishes it as `ArchUMLC4Route.CFG`. Pure and DOM-free, with no dependency.

  // Routing constants (routing redesign §3.3 and §5), in diagram units.
  const CFG = Object.freeze({
    slotPitch: 40,
    cornerMargin: 24,
    minEndGap: 60,
    endSpreadTolerance: 10,
    maxEndsPerSide: 4,
    maxHeadsPerSide: 2,
    fanInSides: 3,
    tailStub: 18,
    headStub: 30,
    trackPitch: 24,
    approachGap: 48,
    boundaryBand: 30,
    boxClearance: 20,
    laneClearance: 32,
    labelBesideGap: 6,
    labelForeignClear: 12,
    labelBoxClear: 8,
    labelOutlineClear: 4,
    maxBends: 2,
    maxBendsExempt: 4,
    maxSelectionRounds: 8,
    maxGrowthRounds: 2,
    bundleBandMembers: 2,
    bundleLaneTracks: 3,
    escapePenalty: 40,
    escapePenaltyPerUnit: 0.1,
    overEndDistance: 8,
    parallelOverlap: 40,
    boundaryRunOverlap: 2,
    straightStep: 8,
    labelStep: 8,
    jogTracksPerPair: 12,
    nearTracks: 3,
    laneTracksPerSide: 4,
    candidatesPerEndPair: 3,
    slotsForTurns: 6,
    slotsForLanes: 4,
    candidateCap: 200,
    pairMoveCandidates: 6,
    gridBendPenalty: 38,
  });

  // ---- Frame --------------------------------------------------------------------------------------------------------

  // The real side of each frame side when the view flows to the right (frame x is real y, frame y is real x).
  const RIGHT_FLOW_SIDE = { top: 'left', bottom: 'right', left: 'top', right: 'bottom' };

  function otherAxis(axis) {
    return axis === 'x' ? 'y' : 'x';
  }

  function transposedRect(rect) {
    return { x: rect.y, y: rect.x, width: rect.height, height: rect.width };
  }

  function plainRect(rect) {
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }

  /**
   * The scene in the flow frame: `rects` maps every element box and boundary to its rectangle, `elements` and
   * `boundaries` list their ids, `edges` keeps view-model order. Ids never decide an order: the lists only feed
   * checks that look at every entry.
   */
  function frameOf(scene) {
    const flip = scene.direction === 'right';
    const toFrame = flip ? transposedRect : plainRect;
    const rects = new Map();
    const elements = Object.keys(scene.boxes);
    const boundaries = Object.keys(scene.boundaries);
    elements.forEach((id) => rects.set(id, toFrame(scene.boxes[id])));
    boundaries.forEach((id) => rects.set(id, toFrame(scene.boundaries[id])));
    const edges = scene.edges.map((edge, index) => Object.assign({ index: index }, edge));
    const frame = {
      flip: flip, rects: rects, elements: elements, boundaries: boundaries, parentOf: scene.parentOf || {}, edges: edges,
      boundaryLabels: (scene.boundaryLabels || []).map(toFrame), labelSizes: edges.map(labelSizeOf), bundles: bundlesOf(edges),
    };
    frame.labelObstacles = fixedLabelObstacles(frame);
    return frame;
  }

  /** An edge's label size in whole units (rounded up), or null when the edge has no label. */
  function labelSizeOf(edge) {
    if (!edge.labelWidth || !edge.labelHeight) return null;
    return { width: Math.ceil(edge.labelWidth), height: Math.ceil(edge.labelHeight) };
  }

  /**
   * Each edge's place in its bundle (§5.2), `{rank, size}`: the edges between the same two boxes, in either
   * direction, counted in view-model order. A self-edge is never bundled.
   */
  function bundlesOf(edges) {
    const keyOf = (edge) => (edge.source < edge.target ? [edge.source, edge.target] : [edge.target, edge.source]).join('\u0000');
    const sizes = new Map();
    const ranks = edges.map((edge) => {
      if (edge.source === edge.target) return 0;
      const key = keyOf(edge);
      const rank = sizes.get(key) || 0;
      sizes.set(key, rank + 1);
      return rank;
    });
    return edges.map((edge, index) => ({ rank: ranks[index], size: edge.source === edge.target ? 1 : sizes.get(keyOf(edge)) }));
  }

  function rectOf(frame, id) {
    const rect = frame.rects.get(id);
    if (!rect) throw new Error('C4 routing: no box or boundary "' + id + '"');
    return rect;
  }

  function realPoint(frame, point) {
    return frame.flip ? { x: point.y, y: point.x } : { x: point.x, y: point.y };
  }

  function realSide(frame, side) {
    return frame.flip ? RIGHT_FLOW_SIDE[side] : side;
  }

  function ancestorsOf(frame, id) {
    const chain = [];
    for (let current = frame.parentOf[id]; current; current = frame.parentOf[current]) chain.push(current);
    return chain;
  }

  /** The boundaries holding exactly one end of `edge`: each must be crossed once. */
  function boundariesHoldingOneEnd(frame, edge) {
    const source = ancestorsOf(frame, edge.source);
    const target = ancestorsOf(frame, edge.target);
    return frame.boundaries.filter((id) => source.includes(id) !== target.includes(id));
  }

  /** The boundaries holding neither end of `edge` and not landed on by it: obstacles its route goes around (§5.1). */
  function boundariesHoldingNeitherEnd(frame, edge) {
    const holders = new Set([edge.source, edge.target].concat(ancestorsOf(frame, edge.source), ancestorsOf(frame, edge.target)));
    return frame.boundaries.filter((id) => !holders.has(id));
  }

  /** What a label must keep clear of whatever the routes (§6.1): element boxes, boundary labels and boundary outlines (as thin rects). */
  function fixedLabelObstacles(frame) {
    return {
      boxes: frame.elements.map((id) => rectOf(frame, id)),
      boundaryLabels: frame.boundaryLabels,
      outlines: frame.boundaries.flatMap((id) => outlineLines(rectOf(frame, id))).map((line) => (line.horizontal
        ? { x: line.lo, y: line.at, width: line.hi - line.lo, height: 0 } : { x: line.at, y: line.lo, width: 0, height: line.hi - line.lo })),
    };
  }

  // ---- Rectangles, segments and sides -------------------------------------------------------------------------------

  function grown(rect, by) {
    return { x: rect.x - by, y: rect.y - by, width: rect.width + 2 * by, height: rect.height + 2 * by };
  }

  function outlineLines(rect) {
    return [
      { horizontal: true, at: rect.y, lo: rect.x, hi: rect.x + rect.width },
      { horizontal: true, at: rect.y + rect.height, lo: rect.x, hi: rect.x + rect.width },
      { horizontal: false, at: rect.x, lo: rect.y, hi: rect.y + rect.height },
      { horizontal: false, at: rect.x + rect.width, lo: rect.y, hi: rect.y + rect.height },
    ];
  }

  function segmentBetween(from, to) {
    const horizontal = from.y === to.y;
    return {
      horizontal: horizontal, at: horizontal ? from.y : from.x,
      lo: horizontal ? Math.min(from.x, to.x) : Math.min(from.y, to.y), hi: horizontal ? Math.max(from.x, to.x) : Math.max(from.y, to.y),
    };
  }

  function segmentsOf(points) {
    return points.slice(1).map((to, index) => segmentBetween(points[index], to));
  }

  function boundsOf(points) {
    const bounds = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
    for (const point of points) {
      bounds.x0 = Math.min(bounds.x0, point.x);
      bounds.x1 = Math.max(bounds.x1, point.x);
      bounds.y0 = Math.min(bounds.y0, point.y);
      bounds.y1 = Math.max(bounds.y1, point.y);
    }
    return bounds;
  }

  function boundsMeet(a, b, pad) {
    return a.x0 - pad <= b.x1 && b.x0 - pad <= a.x1 && a.y0 - pad <= b.y1 && b.y0 - pad <= a.y1;
  }

  function sideRange(rect, side) {
    return side === 'top' || side === 'bottom' ? [rect.x, rect.x + rect.width] : [rect.y, rect.y + rect.height];
  }

  function sidePoint(rect, side, along) {
    if (side === 'top') return { x: along, y: rect.y };
    if (side === 'bottom') return { x: along, y: rect.y + rect.height };
    if (side === 'left') return { x: rect.x, y: along };
    return { x: rect.x + rect.width, y: along };
  }

  function centre(range) {
    return (range[0] + range[1]) / 2;
  }

  // ---- Geometric edge classes (§5.0) --------------------------------------------------------------------------------

  function spans(rect) {
    return { main: [rect.y, rect.y + rect.height], cross: [rect.x, rect.x + rect.width] };
  }

  function openOverlap(a, b) {
    return a[0] < b[1] && b[0] < a[1];
  }

  function inflated(range, by) {
    return [range[0] - by, range[1] + by];
  }

  function classesOf(frame, edge) {
    const s = spans(rectOf(frame, edge.source));
    const t = spans(rectOf(frame, edge.target));
    const sameRank = openOverlap(s.main, t.main);
    const across = sameRank ? 'cross' : 'main';
    const along = sameRank ? 'main' : 'cross';
    const [first, second] = s[across][0] <= t[across][0] ? [s, t] : [t, s];
    const between = [first[across][1], second[across][0]];
    const union = [Math.min(s[along][0], t[along][0]), Math.max(s[along][1], t[along][1])];
    /** The largest half-extent along the region of the named rectangles that, inflated by `pad`, enter it; -1 if none. */
    const widestBlocker = (ids, pad) => ids.reduce((widest, id) => {
      const other = spans(rectOf(frame, id));
      const enters = openOverlap(inflated(other[across], pad), between) && openOverlap(inflated(other[along], pad), union);
      return enters ? Math.max(widest, (other[along][1] - other[along][0]) / 2) : widest;
    }, -1);
    const halfExtent = widestBlocker(frame.elements.filter((id) => id !== edge.source && id !== edge.target), CFG.boxClearance);
    // A boundary holding neither end is an obstacle the route goes around (§5.1), so it sizes the cap too (Ruling 21).
    const capExtent = Math.max(halfExtent, widestBlocker(boundariesHoldingNeitherEnd(frame, edge), CFG.boundaryBand));
    const blocked = halfExtent >= 0;
    const upward = t.main[1] <= s.main[0];
    const boundaryEntry = blocked && boundariesHoldingOneEnd(frame, edge).length > 0;
    const exempt = upward || boundaryEntry || (sameRank && blocked);
    return {
      upward: upward, sameRank: sameRank, blocked: blocked, boundaryEntry: boundaryEntry, exempt: exempt,
      detourCap: exempt ? 2 * (CFG.boundaryBand + CFG.trackPitch + CFG.boxClearance) + Math.max(0, capExtent) : 0,
      maxBends: exempt ? CFG.maxBendsExempt : CFG.maxBends,
    };
  }

  return {
    CFG: CFG, otherAxis: otherAxis, transposedRect: transposedRect, plainRect: plainRect, frameOf: frameOf,
    rectOf: rectOf, realPoint: realPoint, realSide: realSide, ancestorsOf: ancestorsOf,
    boundariesHoldingOneEnd: boundariesHoldingOneEnd, boundariesHoldingNeitherEnd: boundariesHoldingNeitherEnd,
    grown: grown, outlineLines: outlineLines, segmentsOf: segmentsOf, boundsOf: boundsOf, boundsMeet: boundsMeet,
    sideRange: sideRange, sidePoint: sidePoint, centre: centre, spans: spans, openOverlap: openOverlap,
    classesOf: classesOf
  };
});
