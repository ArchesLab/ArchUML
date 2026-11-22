(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./c4-route-frame.js'));
  } else {
    var parts = root.ArchUMLC4RouteParts = root.ArchUMLC4RouteParts || {};
    parts.costs = factory(parts.frame);
  }
})(typeof self !== 'undefined' ? self : this, function (frameModule) {
  'use strict';

  // The objective (routing redesign §5.5): cost vectors, compared lexicographically; what two routes cost each other
  // (crossings, over-ends, close parallels); a route's own cost (bends, length and end penalties); and what the ends on
  // each side of a box cost (conflicts and crowding, §5.2).

  const { CFG, rectOf, boundsMeet, sideRange } = frameModule;

  // ---- Cost vectors -------------------------------------------------------------------------------------------------

  // Cost vectors: [conflicts, crossings, overEnds, closeParallels, bends, crowding, base], compared lexicographically.
  /**
   * A new cost vector of zeros, written as a literal on purpose: selection makes and sums millions of these, and a
   * copy of the frozen `ZERO` (`slice`) was several times slower to make and to add into (routing redesign §8).
   */
  function zeroCost() {
    return [0, 0, 0, 0, 0, 0, 0];
  }

  const TERMS = zeroCost().length;

  const ZERO = Object.freeze(zeroCost());

  function added(a, b) {
    return a.map((value, index) => value + b[index]);
  }

  /** Adds `cost` into `total` in place and returns `total`: the evaluator's sums allocate no arrays. */
  function addInto(total, cost) {
    for (let index = 0; index < TERMS; index++) total[index] += cost[index];
    return total;
  }

  function subtractInto(total, cost) {
    for (let index = 0; index < TERMS; index++) total[index] -= cost[index];
    return total;
  }

  function subtracted(a, b) {
    return a.map((value, index) => value - b[index]);
  }

  function compareCosts(a, b) {
    for (let index = 0; index < TERMS; index++) {
      if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
    }
    return 0;
  }

  // ---- Own and pair costs -------------------------------------------------------------------------------------------

  function onOutline(x, y, rect) {
    const inX = x >= rect.x && x <= rect.x + rect.width;
    const inY = y >= rect.y && y <= rect.y + rect.height;
    return (inX && (y === rect.y || y === rect.y + rect.height)) || (inY && (x === rect.x || x === rect.x + rect.width));
  }

  /**
   * Whether two segments meet away from the outline of every box in `shared` (the boxes the two routes share as ends):
   * where they cross, or at either end of a run they share. Meeting only on a shared box's outline is two routes
   * leaving or entering the same box, not a crossing.
   */
  function meetsAwayFromShared(a, b, shared) {
    if (a.horizontal !== b.horizontal) {
      const h = a.horizontal ? a : b;
      const v = a.horizontal ? b : a;
      if (v.at < h.lo || v.at > h.hi || h.at < v.lo || h.at > v.hi) return false;
      return awayFrom(v.at, h.at, shared);
    }
    if (a.at !== b.at) return false;
    const lo = Math.max(a.lo, b.lo);
    const hi = Math.min(a.hi, b.hi);
    if (lo > hi) return false;
    return a.horizontal ? awayFrom(lo, a.at, shared) || awayFrom(hi, a.at, shared) : awayFrom(a.at, lo, shared) || awayFrom(a.at, hi, shared);
  }

  /** Whether the point (`x`, `y`) lies off the outline of every box in `rects`. */
  function awayFrom(x, y, rects) {
    for (const rect of rects) if (onOutline(x, y, rect)) return false;
    return true;
  }

  /** The squared distance from `point` to an axis-aligned segment. */
  function squaredDistanceToSegment(point, segment) {
    const along = segment.horizontal ? point.x : point.y;
    const across = (segment.horizontal ? point.y : point.x) - segment.at;
    const gap = Math.max(0, segment.lo - along, along - segment.hi);
    return gap * gap + across * across;
  }

  /** Whether `point` lies within the over-end distance of `route` (its bounds first, then each segment). */
  function nearRoute(point, route) {
    const reach = CFG.overEndDistance;
    const bounds = route.bounds;
    if (point.x < bounds.x0 - reach || point.x > bounds.x1 + reach || point.y < bounds.y0 - reach || point.y > bounds.y1 + reach) return false;
    return route.segments.some((segment) => squaredDistanceToSegment(point, segment) <= reach * reach);
  }

  /** Whether two runs lie closer than `gap` side by side, along at least `parallelOverlap`. */
  function runsClose(a, b, gap) {
    return a.horizontal === b.horizontal && Math.abs(a.at - b.at) < gap && Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) >= CFG.parallelOverlap;
  }

  /** The pairs of runs, one of `first` and one of `second`, closer than `gap` side by side. */
  function closeRuns(first, second, gap) {
    let count = 0;
    for (const a of first) for (const b of second) if (runsClose(a, b, gap)) count++;
    return count;
  }

  /** How many of `route`'s two ends lie within the over-end distance of `other`. */
  function endsNear(route, other) {
    return Number(nearRoute(route.points[0], other)) + Number(nearRoute(route.points[route.points.length - 1], other));
  }

  /** The farthest `pairReach` of any two routes. */
  const MAX_PAIR_REACH = Math.max(CFG.trackPitch, CFG.approachGap);

  /**
   * How far apart two routes' bounds can lie and still cost each other something (`measuredPairCost`): crossings need
   * the bounds to meet, over-ends to come within `overEndDistance`, close parallels within `trackPitch`, and two
   * approaches to one side of one box within `approachGap`.
   */
  function pairReach(a, b) {
    return a.edge.target === b.edge.target && a.target.side === b.target.side ? MAX_PAIR_REACH : CFG.trackPitch;
  }

  /**
   * What two chosen routes cost each other: crossings (touches included), over-ends and close parallels. Routes
   * beyond their `pairReach` cost nothing (the shared, frozen `ZERO`); the others' costs are kept on both routes.
   */
  function pairCost(frame, a, b) {
    if (!boundsMeet(a.bounds, b.bounds, pairReach(a, b))) return ZERO;
    let cost = a.pairCosts.get(b);
    if (cost === undefined) {
      cost = measuredPairCost(frame, a, b);
      a.pairCosts.set(b, cost);
      b.pairCosts.set(a, cost);
    }
    return cost;
  }

  /** The boxes two routes share as ends. */
  function sharedEnds(frame, a, b) {
    return [a.edge.source, a.edge.target].filter((id) => id === b.edge.source || id === b.edge.target).map((id) => rectOf(frame, id));
  }

  /** `pairCost` of two routes whose bounds come within the reach of some term. */
  function measuredPairCost(frame, a, b) {
    const cost = zeroCost();
    // Each term is measured only when the routes' bounds come within its own reach; crossings (bounds that meet) and
    // close parallels (within a track pitch) are counted in one pass over the pairs of segments.
    if (boundsMeet(a.bounds, b.bounds, CFG.trackPitch)) {
      const shared = boundsMeet(a.bounds, b.bounds, 0) ? sharedEnds(frame, a, b) : null;
      for (const sa of a.segments) {
        for (const sb of b.segments) {
          if (shared && meetsAwayFromShared(sa, sb, shared)) cost[1]++;
          if (runsClose(sa, sb, CFG.trackPitch)) cost[3]++;
        }
      }
    }
    if (boundsMeet(a.bounds, b.bounds, CFG.overEndDistance)) cost[2] = endsNear(b, a) + endsNear(a, b);
    if (a.edge.target === b.edge.target && a.target.side === b.target.side) {
      cost[3] += closeRuns(a.segments.slice(-2), b.segments.slice(-2), CFG.approachGap) > 0 ? 1 : 0;
    }
    return cost;
  }

  /** A candidate's own terms: its bends and its base cost (length and end penalties). */
  function ownCost(candidate) {
    if (!candidate.own) {
      candidate.own = zeroCost();
      candidate.own[4] = candidate.bends;
      candidate.own[6] = candidate.base;
    }
    return candidate.own;
  }

  // ---- Side costs (§5.2) --------------------------------------------------------------------------------------------

  /** The tail and head end of a chosen route: `[kind, box id, end]`. */
  function endsOf(candidate) {
    return [['tail', candidate.edge.source, candidate.source], ['head', candidate.edge.target, candidate.target]];
  }

  /** The key of the group of ends on one side of one box. */
  function sideKey(id, side) {
    return id + '\u0000' + side;
  }

  /** The chosen ends grouped by box side, by `sideKey`: `{box, rect, side, along, heads}`, in the order first met. */
  function sideGroupMap(frame, chosen) {
    const groups = new Map();
    chosen.forEach((candidate) => {
      if (!candidate) return;
      endsOf(candidate).forEach(([kind, id, end]) => {
        const key = sideKey(id, end.side);
        if (!groups.has(key)) groups.set(key, { box: id, rect: rectOf(frame, id), side: end.side, along: [], heads: 0 });
        const group = groups.get(key);
        group.along.push(end.along);
        if (kind === 'head') group.heads++;
      });
    });
    return groups;
  }

  /** The chosen ends grouped by box side: `{box, rect, side, along, heads}`. */
  function sideGroups(frame, chosen) {
    return Array.from(sideGroupMap(frame, chosen).values());
  }

  /** The conflicts of ends at the sorted coordinates `sorted` on a side spanning `range`: ends too close, or too many. */
  function sideConflicts(range, sorted) {
    const minimum = Math.max(CFG.minEndGap, (range[1] - range[0]) / (sorted.length + 1) - CFG.endSpreadTolerance);
    let conflicts = Math.max(0, sorted.length - CFG.maxEndsPerSide);
    for (let index = 1; index < sorted.length; index++) if (sorted[index] - sorted[index - 1] < minimum) conflicts++;
    return conflicts;
  }

  /** One side's conflicts (ends too close, or too many) and crowding (heads beyond the limit). */
  function groupCost(group) {
    const cost = zeroCost();
    cost[0] = sideConflicts(sideRange(group.rect, group.side), group.along.slice().sort((a, b) => a - b));
    cost[5] = Math.max(0, group.heads - CFG.maxHeadsPerSide);
    return cost;
  }

  /**
   * The heads each box receives, by side: box id → Map side → heads. A box with `fanInSides` or more heads must
   * receive them on at least two sides (routing redesign §9.2 "sides used").
   */
  function headsByBox(groups) {
    const boxes = new Map();
    groups.forEach((group) => {
      if (!group.heads) return;
      if (!boxes.has(group.box)) boxes.set(group.box, new Map());
      boxes.get(group.box).set(group.side, group.heads);
    });
    return boxes;
  }

  /** 1 when the heads of one box (side → heads) number at least `fanInSides` and all arrive on one side, else 0. */
  function oneSidedFanIn(sides) {
    if (sides.size !== 1) return 0;
    return sides.values().next().value >= CFG.fanInSides ? 1 : 0;
  }

  /** Conflicts and crowding over all chosen ends; a one-sided fan-in is a conflict. */
  function sideCost(frame, chosen) {
    const groups = sideGroups(frame, chosen);
    const total = groups.reduce((sum, group) => addInto(sum, groupCost(group)), zeroCost());
    headsByBox(groups).forEach((sides) => { total[0] += oneSidedFanIn(sides); });
    return total;
  }

  return {
    zeroCost: zeroCost, ZERO: ZERO, added: added, addInto: addInto, subtractInto: subtractInto, subtracted: subtracted,
    compareCosts: compareCosts, MAX_PAIR_REACH: MAX_PAIR_REACH, pairCost: pairCost, ownCost: ownCost, sideKey: sideKey,
    sideGroupMap: sideGroupMap, sideGroups: sideGroups, sideConflicts: sideConflicts, groupCost: groupCost,
    headsByBox: headsByBox, oneSidedFanIn: oneSidedFanIn, sideCost: sideCost
  };
});
