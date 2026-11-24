(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./c4-route-frame.js'), require('./c4-route-costs.js'));
  } else {
    var parts = root.ArchUMLC4RouteParts = root.ArchUMLC4RouteParts || {};
    parts.growth = factory(parts.frame, parts.costs);
  }
})(typeof self !== 'undefined' ? self : this, function (frameModule, costsModule) {
  'use strict';

  // Growth (routing redesign §6.4): which corridors the placement should widen, and by how much, so that a label
  // without a legal place gets one and the ends that still crowd the top or bottom of a box can move to its sides.

  const { CFG, rectOf } = frameModule;
  const { sideGroups, groupCost } = costsModule;

  /** The segment a label of a failing edge is planned on: its longest segment along the flow, else its longest. */
  function homeSegment(candidate) {
    const longest = (segments) => segments.reduce((best, segment) => (!best || segment.hi - segment.lo > best.hi - best.lo ? segment : best), null);
    return longest(candidate.segments.filter((segment) => !segment.horizontal)) || longest(candidate.segments);
  }

  /** The frame axis a corridor of `axis` spans: rank corridors span the flow (`y`), gap corridors run across it (`x`). */
  function corridorAxis(axis) {
    return axis === 'main' ? 'y' : 'x';
  }

  /** The smallest corridor running along `along` (a frame axis) that holds `value`; gap corridors also hold `at` in their rank. */
  function corridorHolding(frame, corridors, along, value, at) {
    const holding = corridors.filter((corridor) => corridorAxis(corridor.axis) === along && corridor.from <= value && value <= corridor.to &&
      (corridor.axis === 'main' || rankHolds(frame, corridor, at)));
    return holding.reduce((best, corridor) => (!best || corridor.to - corridor.from < best.to - best.from ? corridor : best), null);
  }

  /** Whether the rank of a gap corridor (the main range of the boxes either side of it) holds the frame `y` value `at`. */
  function rankHolds(frame, corridor, at) {
    return (corridor.between || []).some((id) => {
      const rect = frame.rects.get(id);
      return Boolean(rect) && rect.y <= at && at <= rect.y + rect.height;
    });
  }

  /**
   * How much room a label at the middle of `segment` lacks across it, on each side (`-1`, `1`): the label's half
   * extent plus the foreign-route clearance against every other route running parallel beside it, and plus the label
   * clearance against every box beside it. Returns `[{side, by, at}]` for the sides that lack room, `at` being the
   * nearest blocker's coordinate.
   */
  function acrossShortfalls(frame, chosen, index, segment, size) {
    const alongAxis = segment.horizontal ? 'x' : 'y';
    const half = (segment.horizontal ? size.height : size.width) / 2;
    const middle = (segment.lo + segment.hi) / 2;
    const reach = [middle - (segment.horizontal ? size.width : size.height) / 2, middle + (segment.horizontal ? size.width : size.height) / 2];
    const lacks = new Map();
    const blocker = (at, clearance) => {
      const side = Math.sign(at - segment.at);
      const by = Math.ceil(half + clearance - Math.abs(at - segment.at));
      if (side === 0 || by <= 0) return;
      const known = lacks.get(side);
      if (!known || by > known.by) lacks.set(side, { side: side, by: by, at: at });
    };
    chosen.forEach((route, other) => {
      if (other === index) return;
      route.segments.filter((parallel) => parallel.horizontal === segment.horizontal &&
        parallel.lo < reach[1] + CFG.labelForeignClear && parallel.hi > reach[0] - CFG.labelForeignClear)
        .forEach((parallel) => blocker(parallel.at, CFG.labelForeignClear));
    });
    frame.elements.map((id) => rectOf(frame, id)).forEach((rect) => {
      const along = alongAxis === 'y' ? [rect.y, rect.y + rect.height] : [rect.x, rect.x + rect.width];
      const across = alongAxis === 'y' ? [rect.x, rect.x + rect.width] : [rect.y, rect.y + rect.height];
      if (along[0] >= reach[1] + CFG.labelBoxClear || along[1] <= reach[0] - CFG.labelBoxClear) return;
      if (across[1] <= segment.at) blocker(across[1], CFG.labelBoxClear);
      else if (across[0] >= segment.at) blocker(across[0], CFG.labelBoxClear);
    });
    return Array.from(lacks.values());
  }

  /**
   * The corridor that widens the room on one side of a label: a corridor across the segment lying between the
   * segment and the blocker (or holding the segment), preferring one beside the edge's own boxes, then the nearest.
   */
  function corridorBeside(corridors, edge, segment, lack) {
    const acrossAxis = segment.horizontal ? 'y' : 'x';
    const lo = Math.min(segment.at, lack.at);
    const hi = Math.max(segment.at, lack.at);
    const between = corridors.filter((corridor) => corridorAxis(corridor.axis) === acrossAxis &&
      ((corridor.from >= lo && corridor.to <= hi) || (corridor.from <= segment.at && segment.at <= corridor.to)));
    const ownBox = (corridor) => ((corridor.between || []).includes(edge.source) || (corridor.between || []).includes(edge.target) ? 0 : 1);
    const distance = (corridor) => Math.min(Math.abs(corridor.from - segment.at), Math.abs(corridor.to - segment.at));
    return between.slice().sort((a, b) => ownBox(a) - ownBox(b) || distance(a) - distance(b))[0] || null;
  }

  /**
   * The growth one failing label asks for (§6.4): when its legal places all lie on other labels, room for one more
   * label along its home segment; when the corridor its home segment runs through is too short for the label and
   * its stubs, the missing length; otherwise the room it lacks across the segment, on each side.
   */
  function growthOf(frame, corridors, chosen, entry) {
    const candidate = chosen[entry.index];
    const edge = frame.edges[entry.index];
    const size = frame.labelSizes[entry.index];
    const segment = homeSegment(candidate);
    const alongAxis = segment.horizontal ? 'x' : 'y';
    const alongSize = segment.horizontal ? size.width : size.height;
    const home = corridorHolding(frame, corridors, alongAxis, (segment.lo + segment.hi) / 2, segment.at);
    if (entry.free.length) return home ? [{ corridor: home, by: alongSize + CFG.labelBoxClear }] : [];
    const needed = alongSize + CFG.labelBoxClear + CFG.tailStub + CFG.headStub;
    if (home && home.to - home.from < needed) return [{ corridor: home, by: needed - (home.to - home.from) }];
    return acrossShortfalls(frame, chosen, entry.index, segment, size)
      .map((lack) => ({ corridor: corridorBeside(corridors, edge, segment, lack), by: lack.by }))
      .filter((request) => request.corridor);
  }

  /** The width a gap corridor needs for `lanes` routes to run through it, each a lane clearance from the boxes either side. */
  function laneRoom(lanes) {
    return 2 * CFG.laneClearance + (lanes - 1) * CFG.trackPitch;
  }

  /**
   * The growth the end conflicts still open on the top or bottom of a box ask for (§6.4): ends that crowd a side
   * across the flow move to the box's sides along the flow once the gap corridors beside the box have a lane for
   * each conflicting end, the lanes shared out evenly over those gaps; every such gap narrower than its share asks
   * for the missing width. Conflicts on a box's left or right side are not asked for: no corridor makes that side
   * longer.
   */
  function sideGrowth(frame, corridors, chosen) {
    return sideGroups(frame, chosen).filter((group) => group.side === 'top' || group.side === 'bottom').flatMap((group) => {
      const conflicts = groupCost(group)[0];
      const gaps = corridors.filter((corridor) => corridor.axis === 'cross' && (corridor.between || []).includes(group.box));
      if (!conflicts || !gaps.length) return [];
      const room = laneRoom(Math.ceil(conflicts / gaps.length));
      return gaps.filter((gap) => gap.to - gap.from < room).map((gap) => ({ corridor: gap, by: room - (gap.to - gap.from) }));
    });
  }

  /**
   * Every corridor that the failing labels (`growthOf`) and the open side conflicts (`sideGrowth`) ask to grow,
   * with the largest amount asked for each, in the order first asked; corridors in `noGrowth` are left out.
   */
  function growthFor(frame, corridors, chosen, entries, noGrowth) {
    const labelRequests = entries.filter((entry) => entry && entry.fallback).flatMap((entry) => growthOf(frame, corridors, chosen, entry));
    const requests = new Map();
    labelRequests.concat(sideGrowth(frame, corridors, chosen)).forEach((request) => {
      const id = request.corridor.id;
      if (noGrowth.has(id)) return;
      const known = requests.get(id);
      if (!known || request.by > known.by) requests.set(id, { corridorId: id, axis: request.corridor.axis, by: Math.ceil(request.by) });
    });
    return Array.from(requests.values());
  }

  return { growthFor: growthFor };
});
