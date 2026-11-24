(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./c4-route-frame.js'));
  } else {
    var parts = root.ArchUMLC4RouteParts = root.ArchUMLC4RouteParts || {};
    parts.shapes = factory(parts.frame);
  }
})(typeof self !== 'undefined' ? self : this, function (frameModule) {
  'use strict';

  // The routes an edge may take (routing redesign §5.1–§5.3): what its route keeps out of and the tracks between the
  // boxes, the end options on the sides of its boxes, and the shapes built from them: straight routes, routes with one
  // to four bends through the tracks, corridor routes, and the lanes of a bundle member beyond the first two. Shapes
  // are only built here; c4-route-candidates.js judges them.

  const { CFG, otherAxis, rectOf, ancestorsOf, boundariesHoldingOneEnd, boundariesHoldingNeitherEnd, grown,
    outlineLines, sideRange, sidePoint, centre, spans, openOverlap, classesOf } = frameModule;

  // ---- Obstacles and tracks (§5.1) ----------------------------------------------------------------------------------

  /**
   * What an edge's route must keep out of: every other element box inflated by the box clearance, every boundary
   * holding neither end inflated by the boundary band (`obstacles`); the passable boundaries (holding one or both
   * ends) with their crossing allowance; and its own end boxes, whose interiors no segment enters and whose
   * clearance only the segment leaving or entering them may cross.
   */
  function routingRules(frame, edge) {
    const holders = new Set(ancestorsOf(frame, edge.source).concat(ancestorsOf(frame, edge.target)));
    const ends = [edge.source, edge.target];
    const obstacles = frame.elements.filter((id) => !ends.includes(id)).map((id) => grown(rectOf(frame, id), CFG.boxClearance))
      .concat(boundariesHoldingNeitherEnd(frame, edge).map((id) => grown(rectOf(frame, id), CFG.boundaryBand)));
    const crossingOnce = new Set(boundariesHoldingOneEnd(frame, edge));
    return {
      obstacles: obstacles,
      passable: Array.from(holders).map((id) => ({ rect: rectOf(frame, id), lines: outlineLines(rectOf(frame, id)), allowance: crossingOnce.has(id) ? 1 : 0 })),
      source: rectOf(frame, edge.source),
      target: rectOf(frame, edge.target),
    };
  }

  function uniqueSorted(values) {
    return Array.from(new Set(values.map(Math.round))).sort((a, b) => a - b);
  }

  /**
   * The coordinates where a route may run across an axis (`x` for vertical runs, `y` for horizontal ones): the
   * middle of every gap between box and boundary lines and a track or two either side of it, a lane just outside
   * every boundary's band and every box's clearance, and outer lanes beyond everything.
   */
  function tracksOn(frame, axis) {
    const size = axis === 'x' ? 'width' : 'height';
    const outsideBand = [];
    frame.elements.concat(frame.boundaries).forEach((id) => {
      const rect = rectOf(frame, id);
      const clear = frame.boundaries.includes(id) ? CFG.boundaryBand : CFG.laneClearance;
      [rect[axis], rect[axis] + rect[size]].forEach((line) => {
        [0, 1].forEach((k) => outsideBand.push(line - clear - k * CFG.trackPitch, line + clear + k * CFG.trackPitch));
      });
    });
    const sorted = outlineCoordinates(frame, axis);
    const tracks = outsideBand.slice();
    sorted.slice(1).forEach((line, index) => {
      const middle = (sorted[index] + line) / 2;
      [0, -1, 1, -2, 2].forEach((k) => {
        const at = middle + k * CFG.trackPitch;
        if (at > sorted[index] && at < line) tracks.push(at);
      });
    });
    [0, 1, 2, 3].forEach((k) => {
      tracks.push(sorted[0] - CFG.boundaryBand - k * CFG.trackPitch, sorted[sorted.length - 1] + CFG.boundaryBand + k * CFG.trackPitch);
    });
    return uniqueSorted(tracks);
  }

  /** Every box and boundary line across `axis` (their coordinates on it), sorted ascending without repeats. */
  function outlineCoordinates(frame, axis) {
    const size = axis === 'x' ? 'width' : 'height';
    return uniqueSorted(frame.elements.concat(frame.boundaries).flatMap((id) => {
      const rect = rectOf(frame, id);
      return [rect[axis], rect[axis] + rect[size]];
    }));
  }

  /** The middle of every gap between two consecutive box or boundary lines across `axis`: one track per corridor. */
  function corridorMiddles(frame, axis) {
    const sorted = outlineCoordinates(frame, axis);
    return uniqueSorted(sorted.slice(1).map((line, index) => (sorted[index] + line) / 2));
  }

  // ---- Ends (§5.2) --------------------------------------------------------------------------------------------------

  // A side's outward direction in the frame: the axis a route leaving it moves along, and the sign of that move.
  const SIDE_MOVE = {
    top: { move: 'y', dir: -1 }, bottom: { move: 'y', dir: 1 }, left: { move: 'x', dir: -1 }, right: { move: 'x', dir: 1 },
  };

  function clamp(value, range) {
    return Math.min(range[1], Math.max(range[0], value));
  }

  /**
   * Slot coordinates on one side, preferred first: aligned with the partner, the centre, then the evenly spread slots
   * of two to four ends and the slot-pitch grid from the corner margin, nearest the partner first; all at least the
   * corner margin from the corners.
   */
  function slotsOn(rect, side, partner) {
    const range = sideRange(rect, side);
    const inner = [range[0] + CFG.cornerMargin, range[1] - CFG.cornerMargin];
    if (inner[0] > inner[1]) return [Math.round(centre(range))];
    const length = range[1] - range[0];
    const aligned = clamp(centre(sideRange(partner, side)), inner);
    const spread = [];
    [2, 3, 4].forEach((n) => { for (let k = 1; k <= n; k++) spread.push(range[0] + (k * length) / (n + 1)); });
    for (let at = inner[0]; at <= inner[1]; at += CFG.slotPitch) spread.push(at);
    const slots = [aligned, centre(range)].concat(spread, inner).map((value) => Math.round(clamp(value, inner)));
    const ordered = slots.slice(2).sort((a, b) => Math.abs(a - aligned) - Math.abs(b - aligned) || a - b);
    return Array.from(new Set(slots.slice(0, 2).concat(ordered)));
  }

  /**
   * The sides an end may use: the flow side first (the source's bottom and the target's top; reversed for an upward
   * edge), the facing sides of boxes beside each other, and the perpendicular escape sides, which cost a move
   * penalty.
   */
  function sidesFor(classes, sourceRect, targetRect, role) {
    const isSource = role === 'source';
    const facingRight = centre(sideRange(targetRect, 'top')) >= centre(sideRange(sourceRect, 'top'));
    if (classes.sameRank) {
      const facing = (facingRight === isSource) ? 'right' : 'left';
      return [{ side: facing, preferred: true }, { side: 'top', preferred: false }, { side: 'bottom', preferred: false }];
    }
    const flowDown = !classes.upward;
    const flow = (flowDown === isSource) ? 'bottom' : 'top';
    return [{ side: flow, preferred: true }, { side: 'left', preferred: false }, { side: 'right', preferred: false }];
  }

  function endOptions(frame, edge, classes, role) {
    const own = rectOf(frame, role === 'source' ? edge.source : edge.target);
    const partner = rectOf(frame, role === 'source' ? edge.target : edge.source);
    return sidesFor(classes, rectOf(frame, edge.source), rectOf(frame, edge.target), role).flatMap((choice) => {
      const middle = centre(sideRange(own, choice.side));
      return slotsOn(own, choice.side, partner).map((along, rank) => Object.assign(endAt(own, choice.side, along,
        choice.preferred ? 0 : Math.round(CFG.escapePenalty + CFG.escapePenaltyPerUnit * Math.abs(along - middle))),
      { preferred: choice.preferred, rank: rank }));
    });
  }

  function endAt(rect, side, along, penalty) {
    return Object.assign({ side: side, along: along, penalty: penalty, key: side + ':' + along }, sidePoint(rect, side, along), SIDE_MOVE[side]);
  }

  // ---- Candidate routes (§5.3) --------------------------------------------------------------------------------------

  /**
   * The route from end `s` to end `t` that turns at `values`: it leaves `s` along its outward axis, turns at each
   * value on the axis it moves along, and enters `t` against `t`'s outward direction. Null when a segment would have
   * no length, the route would leave or enter a box the wrong way, or a stub would be too short.
   */
  function buildRoute(s, t, values) {
    const points = [{ x: s.x, y: s.y }];
    let axis = s.move;
    values.forEach((value) => {
      const next = Object.assign({}, points[points.length - 1]);
      next[axis] = value;
      points.push(next);
      axis = otherAxis(axis);
    });
    if (axis !== t.move) return null;
    const last = points[points.length - 1];
    if (last[otherAxis(axis)] !== t[otherAxis(axis)]) return null;
    points.push({ x: t.x, y: t.y });
    for (let index = 1; index < points.length; index++) {
      if (points[index].x === points[index - 1].x && points[index].y === points[index - 1].y) return null;
    }
    const firstStep = points[1][s.move] - s[s.move];
    const lastStep = t[t.move] - points[points.length - 2][t.move];
    if (Math.sign(firstStep) !== s.dir || Math.abs(firstStep) < CFG.tailStub) return null;
    if (Math.sign(lastStep) !== -t.dir || Math.abs(lastStep) < CFG.headStub) return null;
    return points;
  }

  // Track lists are sorted ascending without repeats (`tracksOn`), so the selections below search them instead of
  // filtering and sorting every list for every pair of ends.

  /** The index of the first track above `value`, or at it when `orAt`; the length when there is none. */
  function firstTrack(tracks, value, orAt) {
    let lo = 0;
    let hi = tracks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tracks[mid] < value || (!orAt && tracks[mid] === value)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function firstAtLeast(tracks, value) {
    return firstTrack(tracks, value, true);
  }

  function firstAbove(tracks, value) {
    return firstTrack(tracks, value, false);
  }

  /**
   * At most `count` of the tracks with index in [`from`, `to`), nearest `middle` first; of two equally near, the
   * lower one first.
   */
  function nearestTracks(tracks, from, to, middle, count) {
    const picked = [];
    let right = Math.min(Math.max(firstAtLeast(tracks, middle), from), to);
    let left = right - 1;
    while (picked.length < count && (left >= from || right < to)) {
      if (right >= to || (left >= from && middle - tracks[left] <= tracks[right] - middle)) picked.push(tracks[left--]);
      else picked.push(tracks[right++]);
    }
    return picked;
  }

  /** Tracks on `axis` beyond `end` in its outward direction, nearest first, at least `stub` away. */
  function tracksBeyond(tracks, end, stub, count) {
    const from = end[end.move];
    if (end.dir > 0) {
      const start = firstAtLeast(tracks, from + stub);
      return tracks.slice(start, start + count);
    }
    const stop = firstAbove(tracks, from - stub);
    return tracks.slice(Math.max(0, stop - count), stop).reverse();
  }

  /**
   * Lanes on `axis` around the two boxes and whatever blocks the way between them (§5.3): the nearest tracks outside
   * the joint range of the end boxes and of every obstacle lying between them on the other axis, on each side, and
   * the tracks inside that range nearest the middle.
   */
  function lanesAround(tracks, s, t, axis, rules) {
    const size = axis === 'x' ? 'width' : 'height';
    const across = otherAxis(axis);
    const acrossSize = across === 'x' ? 'width' : 'height';
    const between = [Math.min(s[across], t[across]), Math.max(s[across], t[across])];
    let lo = Math.min(rules.source[axis], rules.target[axis]);
    let hi = Math.max(rules.source[axis] + rules.source[size], rules.target[axis] + rules.target[size]);
    for (const rect of rules.obstacles) {
      if (rect[across] < between[1] && rect[across] + rect[acrossSize] > between[0]) {
        lo = Math.min(lo, rect[axis]);
        hi = Math.max(hi, rect[axis] + rect[size]);
      }
    }
    const insideFrom = firstAtLeast(tracks, lo);
    const insideTo = firstAbove(tracks, hi);
    const below = tracks.slice(Math.max(0, insideFrom - CFG.laneTracksPerSide), insideFrom).reverse();
    const above = tracks.slice(insideTo, insideTo + CFG.laneTracksPerSide);
    const inside = nearestTracks(tracks, insideFrom, insideTo, (s[axis] + t[axis]) / 2, CFG.laneTracksPerSide);
    return below.concat(above, inside);
  }

  /**
   * Jog tracks for a two-bend route, nearest the middle between the ends first. Non-exempt routes stay monotone;
   * exempt ones may also turn just beyond either end or in a lane around both boxes (a U).
   */
  function jogTracks(tracks, s, t, rules, exempt) {
    const axis = s.move;
    const middle = (s[axis] + t[axis]) / 2;
    const lo = Math.min(s[axis], t[axis]);
    const hi = Math.max(s[axis], t[axis]);
    const within = nearestTracks(tracks, firstAbove(tracks, lo), firstAtLeast(tracks, hi), middle, CFG.jogTracksPerPair);
    if (!exempt) return within;
    const pool = within.concat(tracksBeyond(tracks, s, CFG.tailStub, CFG.nearTracks),
      tracksBeyond(tracks, t, CFG.headStub, CFG.nearTracks), lanesAround(tracks, s, t, axis, rules));
    return Array.from(new Set(pool)).sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle) || a - b).slice(0, CFG.jogTracksPerPair);
  }

  /**
   * The choices for each turn of a shape with `bends` bends between two ends, in turn order; the last turn is fixed
   * by the target.
   */
  function turnChoices(s, t, bends, tracks, rules, exempt) {
    const axisAt = (index) => (index % 2 === 0 ? s.move : otherAxis(s.move));
    const finalValue = [t[axisAt(bends - 1)]];
    if (bends === 1) return [finalValue];
    if (bends === 2) return [jogTracks(tracks[s.move], s, t, rules, exempt), finalValue];
    const first = tracksBeyond(tracks[s.move], s, CFG.tailStub, CFG.nearTracks);
    const lanes = lanesAround(tracks[otherAxis(s.move)], s, t, otherAxis(s.move), rules);
    if (bends === 3) return [first, lanes, finalValue];
    return [first, lanes, tracksBeyond(tracks[s.move], t, CFG.headStub, CFG.nearTracks), finalValue];
  }

  /** The `middles` strictly between `from` and `to`. */
  function middlesBetween(middles, from, to) {
    return middles.slice(firstAbove(middles, Math.min(from, to)), firstAtLeast(middles, Math.max(from, to)));
  }

  /**
   * The turns of a corridor route (§5.3, the lanes that pass between boxes instead of around them all): with three
   * or four bends, a first turn in any corridor between the two ends, a lane in any corridor across the other axis
   * within `reach` of the two ends, and for four bends a last turn in any corridor between the ends. Each turn is
   * a corridor's middle (`middles`), so the route keeps the most room from the lines either side of it.
   */
  function corridorTurnChoices(s, t, bends, middles, reach) {
    const across = otherAxis(s.move);
    const between = middlesBetween(middles[s.move], s[s.move], t[s.move]);
    const lanes = middlesBetween(middles[across], Math.min(s[across], t[across]) - reach, Math.max(s[across], t[across]) + reach);
    const finalValue = [t[bends === 3 ? s.move : across]];
    return bends === 3 ? [between, lanes, finalValue] : [between, lanes, between, finalValue];
  }

  /**
   * The routes `buildRoute` makes from end `s` to end `t` for every combination of one value from each of `choices`
   * (nested, the first turn outermost), less those with a segment that `clear(from, to, index, last)` rejects. Each
   * segment is judged as soon as its turn is chosen, so a rejected segment drops every combination sharing it before
   * any is built. Routes share the points of their common turns; points are never changed once built.
   */
  function clearRoutes(s, t, choices, clear) {
    const last = choices.length;
    const routes = [];
    const points = [{ x: s.x, y: s.y }];
    const finish = (axis) => {
      const turn = points[points.length - 1];
      const lastStep = t[t.move] - turn[t.move];
      if (axis !== t.move || turn[otherAxis(axis)] !== t[otherAxis(axis)] || (turn.x === t.x && turn.y === t.y) ||
        Math.sign(lastStep) !== -t.dir || Math.abs(lastStep) < CFG.headStub || !clear(turn, t, last, last)) return;
      routes.push({ source: s, target: t, points: points.concat({ x: t.x, y: t.y }) });
    };
    const turnAt = (level, axis) => {
      if (level === choices.length) {
        finish(axis);
        return;
      }
      const from = points[level];
      for (const value of choices[level]) {
        const next = axis === 'x' ? { x: value, y: from.y } : { x: from.x, y: value };
        const firstStep = next[s.move] - s[s.move];
        const valid = value !== from[axis] && (level > 0 || (Math.sign(firstStep) === s.dir && Math.abs(firstStep) >= CFG.tailStub));
        if (valid && clear(from, next, level, last)) {
          points.push(next);
          turnAt(level + 1, otherAxis(axis));
          points.pop();
        }
      }
    };
    turnAt(0, s.move);
    return routes;
  }

  /** Straight routes between two facing sides, at every free coordinate of their straight band (§5.0). */
  function straightRoutes(frame, edge, classes) {
    const s = rectOf(frame, edge.source);
    const t = rectOf(frame, edge.target);
    let sides;
    if (classes.sameRank) sides = centre(sideRange(t, 'top')) >= centre(sideRange(s, 'top')) ? ['right', 'left'] : ['left', 'right'];
    else sides = classes.upward ? ['top', 'bottom'] : ['bottom', 'top'];
    const a = sideRange(s, sides[0]);
    const b = sideRange(t, sides[1]);
    const lo = Math.max(a[0], b[0]) + CFG.cornerMargin;
    const hi = Math.min(a[1], b[1]) - CFG.cornerMargin;
    if (lo > hi) return [];
    const coordinates = [Math.round((lo + hi) / 2), Math.ceil(lo), Math.floor(hi)];
    for (let at = Math.ceil(lo / CFG.straightStep) * CFG.straightStep; at <= hi; at += CFG.straightStep) coordinates.push(at);
    return Array.from(new Set(coordinates)).map((along) => ({
      source: endAt(s, sides[0], along, 0), target: endAt(t, sides[1], along, 0),
      points: [sidePoint(s, sides[0], along), sidePoint(t, sides[1], along)],
    }));
  }

  function sideLine(rect, side) {
    if (side === 'top') return rect.y;
    if (side === 'bottom') return rect.y + rect.height;
    return side === 'left' ? rect.x : rect.x + rect.width;
  }

  /** How far apart the lanes of a bundle's members lie (§5.2): room for a beside label and its foreign-route clearance. */
  function bundlePitch(frame, edge, stacked) {
    const size = frame.labelSizes[edge.index];
    const across = size ? (stacked ? size.width : size.height) : 0;
    return Math.max(CFG.slotPitch, across + CFG.labelBesideGap + CFG.labelForeignClear);
  }

  /** How many bundle members beyond the straight band an edge is: 1 for the third member, 2 for the fourth. */
  function bundleLanesOut(frame, edge) {
    return frame.bundles[edge.index].rank - CFG.bundleBandMembers + 1;
  }

  /**
   * The routes of a bundle member beyond the first two (§5.2): out of an escape side of its source, along a lane
   * outside both boxes, back into the same side of its target. The k-th such member's lanes lie up to k member
   * pitches beyond the straight band, then a few tracks further out; selection keeps the nearest one that leaves
   * every label of the bundle legal.
   */
  function bundleLaneRoutes(frame, edge) {
    const s = rectOf(frame, edge.source);
    const t = rectOf(frame, edge.target);
    const stacked = !openOverlap(spans(s).main, spans(t).main);
    const pitch = bundlePitch(frame, edge, stacked);
    const lanesOut = bundleLanesOut(frame, edge);
    const routes = [];
    (stacked ? ['left', 'right'] : ['top', 'bottom']).forEach((side) => {
      const dir = SIDE_MOVE[side].dir;
      const outer = (dir > 0 ? Math.max : Math.min)(sideLine(s, side), sideLine(t, side));
      const lanes = [];
      for (let member = 1; member <= lanesOut; member++) {
        for (let track = 0; track < CFG.bundleLaneTracks; track++) lanes.push(outer + dir * (member * pitch - CFG.cornerMargin + track * CFG.trackPitch));
      }
      const escape = (rect, along) => endAt(rect, side, along, Math.round(CFG.escapePenalty + CFG.escapePenaltyPerUnit * Math.abs(along - centre(sideRange(rect, side)))));
      slotsOn(s, side, t).slice(0, CFG.slotsForLanes).forEach((sourceAlong) => slotsOn(t, side, s).slice(0, CFG.slotsForLanes).forEach((targetAlong) => {
        const source = escape(s, sourceAlong);
        const target = escape(t, targetAlong);
        lanes.forEach((lane) => {
          const points = buildRoute(source, target, [lane, targetAlong]);
          if (points) routes.push({ source: source, target: target, points: points });
        });
      }));
    });
    return routes;
  }

  /** The limits of a bundle member's lane routes: one U (2 bends), detouring at most to its farthest lane. */
  function bundleLaneClasses(frame, edge) {
    const stacked = !openOverlap(spans(rectOf(frame, edge.source)).main, spans(rectOf(frame, edge.target)).main);
    const farthest = bundleLanesOut(frame, edge) * bundlePitch(frame, edge, stacked) + CFG.bundleLaneTracks * CFG.trackPitch;
    return Object.assign({}, classesOf(frame, edge), { maxBends: CFG.maxBends, detourCap: 2 * farthest });
  }

  /**
   * How many of a side's slots (in preference order) a shape tries: every slot for one bend and for two bends
   * between the flow sides, fewer for other two-bend shapes and for lanes, which mostly differ in their tracks.
   */
  function slotsTried(s, t, bends) {
    if (bends === 1 || (bends === 2 && s.preferred && t.preferred)) return Infinity;
    return bends === 2 ? CFG.slotsForTurns : CFG.slotsForLanes;
  }

  /**
   * Every bent route of an edge between its end options, with one to `shapes.maxBends` bends, whose segments `clear`
   * accepts (`clearRoutes`); `shapes.exempt` adds the detouring shapes (U turns and lanes) to the monotone ones.
   */
  function bentRoutes(sources, targets, tracks, rules, shapes, clear) {
    const routes = [];
    sources.forEach((s) => targets.forEach((t) => {
      for (let bends = 1; bends <= shapes.maxBends; bends++) {
        if ((bends % 2 === 0) !== (s.move === t.move)) continue;
        const tried = slotsTried(s, t, bends);
        if (s.rank >= tried || t.rank >= tried) continue;
        clearRoutes(s, t, turnChoices(s, t, bends, tracks, rules, shapes.exempt), clear).forEach((route) => routes.push(route));
      }
    }));
    return routes;
  }

  return {
    routingRules: routingRules, tracksOn: tracksOn, corridorMiddles: corridorMiddles, endOptions: endOptions,
    endAt: endAt, corridorTurnChoices: corridorTurnChoices, clearRoutes: clearRoutes, straightRoutes: straightRoutes,
    bundleLaneRoutes: bundleLaneRoutes, bundleLaneClasses: bundleLaneClasses, bentRoutes: bentRoutes
  };
});
