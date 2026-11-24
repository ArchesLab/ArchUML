(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./c4-route-frame.js'), require('./c4-route-shapes.js'),
      require('./c4-route-candidates.js'), require('./c4-route-costs.js'), require('./c4-route-state.js'),
      require('./c4-route-pricing.js'));
  } else {
    var parts = root.ArchUMLC4RouteParts = root.ArchUMLC4RouteParts || {};
    parts.separate = factory(parts.frame, parts.shapes, parts.candidates, parts.costs, parts.state, parts.pricing);
  }
})(typeof self !== 'undefined' ? self : this, function (frameModule, shapesModule, candidatesModule, costsModule, stateModule, pricingModule) {
  'use strict';

  // Separating close parallels (routing redesign §5.5 term 4), the last pass of selection. Tracks and slots lie on a
  // grid, so two routes can be left closer than the track pitch when neither has a candidate a pitch further out.
  // Separation moves one run of a route across to clear the other route, takes the moved route as a new candidate
  // when it passes every filter, and keeps it only when the view cost drops.

  const { CFG, rectOf, sideRange, centre } = frameModule;
  const { endAt } = shapesModule;
  const { described, passesEveryFilter } = candidatesModule;
  const { compareCosts } = costsModule;
  const { currentCost, choose, startWithChosenAgainst, admitCandidate } = stateModule;
  const { moveEvaluator, cheapest } = pricingModule;

  /** The coordinates a run may move to so that it clears a parallel run at `at`: a track pitch or an approach gap away. */
  function clearingCoordinates(at) {
    return [CFG.trackPitch, -CFG.trackPitch, CFG.approachGap, -CFG.approachGap].map((gap) => at + gap);
  }

  /** `end` moved along its side of `rect` to `along`, or null when that comes nearer than the corner margin to a corner. */
  function endMovedTo(rect, end, along) {
    const range = sideRange(rect, end.side);
    if (along < range[0] + CFG.cornerMargin || along > range[1] - CFG.cornerMargin) return null;
    const penalty = end.penalty === 0 ? 0 : Math.round(CFG.escapePenalty + CFG.escapePenaltyPerUnit * Math.abs(along - centre(range)));
    return Object.assign(endAt(rect, end.side, along, penalty), { preferred: end.preferred, rank: end.rank });
  }

  /**
   * `candidate`'s route with segment `index` moved across to `at` (`{source, target, points}`), its end moving along
   * its side when the segment is the first or last one; null when an end would leave its side, two points would
   * meet, or a stub would grow too short.
   */
  function shiftedRoute(frame, candidate, index, at) {
    const points = candidate.points.map((point) => ({ x: point.x, y: point.y }));
    const key = candidate.segments[index].horizontal ? 'y' : 'x';
    points[index][key] = at;
    points[index + 1][key] = at;
    const source = index === 0 ? endMovedTo(rectOf(frame, candidate.edge.source), candidate.source, at) : candidate.source;
    const target = index === points.length - 2 ? endMovedTo(rectOf(frame, candidate.edge.target), candidate.target, at) : candidate.target;
    if (!source || !target) return null;
    for (let point = 1; point < points.length; point++) if (points[point].x === points[point - 1].x && points[point].y === points[point - 1].y) return null;
    const firstStep = points[1][source.move] - points[0][source.move];
    const lastStep = points[points.length - 1][target.move] - points[points.length - 2][target.move];
    if (Math.sign(firstStep) !== source.dir || Math.abs(firstStep) < CFG.tailStub) return null;
    if (Math.sign(lastStep) !== -target.dir || Math.abs(lastStep) < CFG.headStub) return null;
    return { source: source, target: target, points: points };
  }

  /**
   * The candidates made by moving each run of `moving` that lies close beside a run of `staying` clear of it. Each
   * variant's `withChosen` holds its own cost and its pair costs against the chosen routes of the other edges
   * (`staying` among them), so a move evaluator prices it like any other candidate of its edge.
   */
  function separatedCandidates(state, option, moving, staying) {
    const frame = state.frame;
    const rules = option.rules;
    const variants = [];
    moving.segments.forEach((segment, index) => staying.segments.forEach((other) => {
      if (segment.horizontal !== other.horizontal || Math.abs(segment.at - other.at) >= CFG.approachGap) return;
      if (Math.min(segment.hi, other.hi) - Math.max(segment.lo, other.lo) < CFG.parallelOverlap) return;
      clearingCoordinates(other.at).forEach((at) => {
        const route = shiftedRoute(frame, moving, index, at);
        if (!route) return;
        const candidate = described(route, moving.edge);
        if (!passesEveryFilter(frame, candidate, rules.classes, rules.context)) return;
        startWithChosenAgainst(state, candidate);
        variants.push(candidate);
      });
    }));
    return variants;
  }

  /**
   * For every pair of chosen routes that still run close beside each other, moves a run of either route clear of
   * the other and keeps the moved route when the view cost strictly drops.
   */
  function separateParallels(state, options) {
    let improved = false;
    state.chosen.forEach((first, i) => state.chosen.forEach((second, j) => {
      if (j <= i) return;
      [[i, j], [j, i]].forEach(([moving, staying]) => {
        if (state.pairs[i][j][3] === 0) return;
        const variants = separatedCandidates(state, options[moving], state.chosen[moving], state.chosen[staying]);
        if (!variants.length) return;
        const evaluator = moveEvaluator(state, [moving]);
        const best = cheapest(variants, 1, (candidate) => evaluator.bound([candidate]), (candidate, lower) => evaluator.costFrom(lower, [candidate]))[0];
        if (best && compareCosts(best.cost, currentCost(state)) < 0) {
          admitCandidate(state, options[moving], best.candidate);
          choose(state, moving, best.candidate);
          improved = true;
        }
      });
    }));
    return improved;
  }

  return { separateParallels: separateParallels };
});
