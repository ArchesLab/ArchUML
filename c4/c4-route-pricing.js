(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./c4-route-frame.js'), require('./c4-route-labels.js'),
      require('./c4-route-costs.js'), require('./c4-route-state.js'));
  } else {
    var parts = root.ArchUMLC4RouteParts = root.ArchUMLC4RouteParts || {};
    parts.pricing = factory(parts.frame, parts.labels, parts.costs, parts.state);
  }
})(typeof self !== 'undefined' ? self : this, function (frameModule, labelsModule, costsModule, stateModule) {
  'use strict';

  // Pricing moves (routing redesign §5.5, §8). A move puts one or two edges (the freed edges) on other candidates
  // while every other edge (the fixed edges) keeps its choice. Its price is the view cost after the move, equal to
  // recounting the whole view; each pricer below counts what the fixed edges contribute once (`fixedTotal`), so each
  // pick only adds the terms it can change (`addPicks(total, picks)`). The fixed edges' choices must not change while
  // a pricer is in use.

  const { CFG, rectOf, sideRange } = frameModule;
  const { labelOf, blocksPlace, nearLabel, labelBlocked } = labelsModule;
  const { zeroCost, ZERO, addInto, subtractInto, subtracted, compareCosts, pairCost, sideKey, sideGroupMap,
    sideConflicts, groupCost, headsByBox, oneSidedFanIn } = costsModule;
  const { involvedCost } = stateModule;

  /** Own and pair costs (§5.5 terms 2–5 and 7): the fixed edges' once, each pick's own and against the others. */
  function routePricer(state, freedSet) {
    const frame = state.frame;
    const fixedTotal = subtracted(state.routes, involvedCost(state, freedSet, (index) => state.chosen[index]));
    const freedRoutes = Array.from(freedSet).map((index) => state.chosen[index]).filter(Boolean);
    return {
      fixedTotal: fixedTotal,
      addPicks(total, picks) {
        picks.forEach((candidate, at) => {
          if (!candidate) return;
          // Its own cost and pair costs against the fixed routes: those against every chosen route but the freed ones.
          addInto(total, candidate.withChosen);
          for (const route of freedRoutes) {
            if (route.edge.index === candidate.edge.index) continue;
            const cost = pairCost(frame, candidate, route);
            if (cost !== ZERO) subtractInto(total, cost);
          }
          for (let other = at + 1; other < picks.length; other++) if (picks[other]) addInto(total, pairCost(frame, candidate, picks[other]));
        });
      },
    };
  }

  /** Side conflicts and crowding (§5.2; terms 1 and 6): the sides holding a picked end are recounted with it. */
  function sidePricer(state, freedSet) {
    const frame = state.frame;
    const groups = sideGroupMap(frame, state.chosen.map((candidate, index) => (freedSet.has(index) ? null : candidate)));
    const fixedTotal = zeroCost();
    groups.forEach((group) => {
      group.range = sideRange(group.rect, group.side);
      group.along.sort((a, b) => a - b);
      group.cost = groupCost(group);
      addInto(fixedTotal, group.cost);
    });
    /** Adds the change in a side's cost when the ends at `along` (`heads` of them arrive) join the fixed ends there. */
    const addJoined = (total, id, side, along, heads) => {
      const known = groups.get(sideKey(id, side));
      const sorted = (known ? known.along.concat(along) : along).sort((a, b) => a - b);
      total[0] += sideConflicts(known ? known.range : sideRange(rectOf(frame, id), side), sorted);
      total[5] += Math.max(0, (known ? known.heads : 0) + heads - CFG.maxHeadsPerSide);
      if (known) subtractInto(total, known.cost);
    };
    const fixedHeads = headsByBox(Array.from(groups.values()));
    fixedHeads.forEach((sides) => { fixedTotal[0] += oneSidedFanIn(sides); });
    /** The change in box `id`'s one-sided fan-in when heads arrive on each of `sides` (one entry per head). */
    const fanInChange = (id, sides) => {
      const fixed = fixedHeads.get(id) || new Map();
      const joined = new Map(fixed);
      sides.forEach((side) => joined.set(side, (joined.get(side) || 0) + 1));
      return oneSidedFanIn(joined) - oneSidedFanIn(fixed);
    };
    // Most prices add one pick, whose two ends join two different sides, and many picks share their ends, so the
    // change one end or one head makes on its own is worked out once per end (an end belongs to one edge's one end).
    const loneHeadChanges = new Map();
    const loneEndChanges = new Map();
    const loneHeadChange = (candidate) => {
      let change = loneHeadChanges.get(candidate.target);
      if (change === undefined) {
        change = fanInChange(candidate.edge.target, [candidate.target.side]);
        loneHeadChanges.set(candidate.target, change);
      }
      return change;
    };
    /** The change one end makes on its own, or `ZERO` when it changes nothing. */
    const loneEndChange = (id, end, head) => {
      let change = loneEndChanges.get(end);
      if (change === undefined) {
        change = zeroCost();
        addJoined(change, id, end.side, [end.along], head);
        if (change.every((term) => term === 0)) change = ZERO;
        loneEndChanges.set(end, change);
      }
      return change;
    };
    /** Adds the change in one-sided fan-ins on the boxes the picks' heads arrive at. */
    const addFanIns = (total, picks) => {
      const picked = picks.filter(Boolean);
      if (picked.length === 2 && picked[0].edge.target === picked[1].edge.target) {
        total[0] += fanInChange(picked[0].edge.target, [picked[0].target.side, picked[1].target.side]);
      } else picked.forEach((candidate) => { total[0] += loneHeadChange(candidate); });
    };
    /** Adds the change the picks' ends make on the sides they join, the ends on one side of one box joining together. */
    const addEnds = (total, picks) => {
      const ends = [];
      picks.forEach((candidate) => {
        if (!candidate) return;
        ends.push({ id: candidate.edge.source, end: candidate.source, head: 0 }, { id: candidate.edge.target, end: candidate.target, head: 1 });
      });
      ends.forEach((end, at) => {
        const sameSide = (other) => other.id === end.id && other.end.side === end.end.side;
        if (ends.slice(0, at).some(sameSide)) return;
        const joining = ends.filter(sameSide);
        if (joining.length === 1) addInto(total, loneEndChange(end.id, end.end, end.head));
        else addJoined(total, end.id, end.end.side, joining.map((other) => other.end.along), joining.reduce((sum, other) => sum + other.head, 0));
      });
    };
    return {
      fixedTotal: fixedTotal,
      addPicks(total, picks) {
        const lone = lonePick(picks);
        if (lone && (lone.edge.source !== lone.edge.target || lone.source.side !== lone.target.side)) {
          // The common price, one pick whose ends join two different sides, from the changes worked out once.
          total[0] += loneHeadChange(lone);
          const tail = loneEndChange(lone.edge.source, lone.source, 0);
          const head = loneEndChange(lone.edge.target, lone.target, 1);
          if (tail !== ZERO) addInto(total, tail);
          if (head !== ZERO) addInto(total, head);
          return;
        }
        addFanIns(total, picks);
        addEnds(total, picks);
      },
    };
  }

  /** The one candidate in `picks` when exactly one is not null, else null. */
  function lonePick(picks) {
    let lone = null;
    for (const pick of picks) {
      if (!pick) continue;
      if (lone) return null;
      lone = pick;
    }
    return lone;
  }

  /**
   * Label conflicts (§6.1; term 1): each pick's own label, and the fixed labels near a picked route or near a freed
   * edge's old route (`labelsTouched`); every other fixed label keeps its conflict. A fixed label near an old route
   * only is judged once, against the fixed routes alone, and a label's witness is checked against the fixed routes
   * once per pricer, so a pick usually costs one check per route it adds.
   */
  function labelPricer(state, freed, fixed) {
    const frame = state.frame;
    const freedAt = new Map(freed.map((index, at) => [index, at]));
    const memo = { touched: new Map(), near: new Map(), witnessClear: new Map(), alone: new Map() };
    const fixedRoutes = fixed.map((index) => state.chosen[index]);
    const fixedLabels = fixed.map((index) => ({ index: index, label: labelOf(frame, state.chosen[index]) })).filter((entry) => entry.label);
    const labelAt = new Map(fixedLabels.map((entry) => [entry.index, entry.label]));

    /** The fixed edges whose label comes near `route`, so that it may block one of their places. */
    const labelsNear = (route) => {
      if (!memo.touched.has(route)) {
        const near = [];
        for (const entry of fixedLabels) if (nearLabel(entry.label, route)) near.push(entry.index);
        memo.touched.set(route, near);
      }
      return memo.touched.get(route);
    };

    /** The fixed routes, other than the label's own, that come near `label`. */
    const fixedNear = (label) => {
      if (!memo.near.has(label)) {
        const own = label.candidate.edge.index;
        const near = [];
        for (const route of fixedRoutes) if (route.edge.index !== own && nearLabel(label, route)) near.push(route);
        memo.near.set(label, near);
      }
      return memo.near.get(label);
    };

    /** Whether the label's current witness is clear of every fixed route near it. */
    const witnessClearOfFixed = (label) => {
      const known = memo.witnessClear.get(label);
      if (known && known.witness === label.witness) return known.clear;
      const place = label.legal[label.witness];
      const clear = !fixedNear(label).some((route) => blocksPlace(route, place));
      memo.witnessClear.set(label, { witness: label.witness, clear: clear });
      return clear;
    };

    /** Whether some pick other than the label's own edge's blocks legal place `index` of `label`. */
    const pickBlocks = (label, picks, index) => picks.some((route) => route && route.edge.index !== label.candidate.edge.index &&
      blocksPlace(route, label.legal[index]));

    /** 1 when `label` has no legal place clear of the fixed routes and of `picks` (other than its own edge's). */
    const conflictOf = (label, picks) => {
      if (label.witness !== undefined && witnessClearOfFixed(label) && !pickBlocks(label, picks, label.witness)) return 0;
      const own = label.candidate.edge.index;
      const picked = picks.filter((route) => route && route.edge.index !== own && nearLabel(label, route));
      const isCurrent = (route) => route.edge.index !== own &&
        (freedAt.has(route.edge.index) ? picks[freedAt.get(route.edge.index)] === route : state.chosen[route.edge.index] === route);
      return labelBlocked(frame, label, fixedNear(label).concat(picked), isCurrent) ? 1 : 0;
    };

    /** The conflict of fixed edge `index`'s label with every freed edge taken out. */
    const conflictAlone = (index) => {
      if (!memo.alone.has(index)) memo.alone.set(index, conflictOf(labelAt.get(index), freed.map(() => null)));
      return memo.alone.get(index);
    };

    const nearOld = new Set(freed.map((index) => state.chosen[index]).filter(Boolean).flatMap(labelsNear));
    let fixedTotal = state.labelConflicts - freed.reduce((sum, index) => sum + state.labelConflict[index], 0);
    nearOld.forEach((index) => { fixedTotal += conflictAlone(index) - state.labelConflict[index]; });

    /** The change in fixed edge `index`'s label conflict that `picks` make. */
    const nearPickConflict = (index, picks) =>
      conflictOf(labelAt.get(index), picks) - (nearOld.has(index) ? conflictAlone(index) : state.labelConflict[index]);

    return {
      // Every term `added` counts is at least 0: a pick's own conflict, and a fixed label's conflict with the picks
      // against its conflict without them (more routes never free a place; a label near a freed edge's old route is
      // compared with its conflict without that route). So `fixedTotal` bounds the total from below.
      fixedTotal: fixedTotal,
      added(picks) {
        let conflicts = 0;
        picks.forEach((candidate) => {
          const label = candidate && labelOf(frame, candidate);
          if (label) conflicts += conflictOf(label, picks);
        });
        const [first, second] = picks.map((route) => (route ? labelsNear(route) : []));
        first.forEach((index) => { conflicts += nearPickConflict(index, picks); });
        if (second) second.forEach((index) => { if (!first.includes(index)) conflicts += nearPickConflict(index, picks); });
        return conflicts;
      },
    };
  }

  /**
   * Prices moves of the edges in `freed` (one or two) against the current choices of every other edge. `cost(picks)`
   * is the view cost with each freed edge at its pick (a candidate, or null to take it out); `bound(picks)` is a lower
   * bound of it (lexicographically) that leaves out the label conflicts the picks add, the dearest term to price.
   */
  function moveEvaluator(state, freed) {
    const freedSet = new Set(freed);
    const fixed = [];
    state.chosen.forEach((candidate, index) => { if (candidate && !freedSet.has(index)) fixed.push(index); });
    const pricers = [routePricer(state, freedSet), sidePricer(state, freedSet)];
    const labels = labelPricer(state, freed, fixed);
    // What the fixed edges contribute, the same for every pick.
    const fixedTotal = pricers.reduce((total, pricer) => addInto(total, pricer.fixedTotal), zeroCost());
    fixedTotal[0] += labels.fixedTotal;
    const bound = (picks) => {
      const total = fixedTotal.slice();
      for (const pricer of pricers) pricer.addPicks(total, picks);
      return total;
    };
    /** The cost of `picks` from their `bound`. */
    const costFrom = (lower, picks) => {
      const total = lower.slice();
      total[0] += labels.added(picks);
      return total;
    };
    return { frame: state.frame, bound: bound, costFrom: costFrom, cost: (picks) => costFrom(bound(picks), picks) };
  }

  // ---- The cheapest candidates --------------------------------------------------------------------------------------

  /**
   * The `count` cheapest of `candidates` in cost order (ties in list order), each `{candidate, cost}`.
   * `lowerBound(candidate)` must never exceed a candidate's cost (lexicographically) and `exactCost(candidate, lower)`
   * gives the cost. Candidates are priced exactly in the order of their bounds, and pricing stops once no bound left
   * can reach the cheapest `count`, so most candidates are never priced exactly.
   */
  function cheapest(candidates, count, lowerBound, exactCost) {
    const ranked = rankedByBound(candidates, lowerBound);
    return cheapestOfRanked(ranked, count, (index, lower) => exactCost(candidates[index], lower));
  }

  /**
   * `candidates` with their lower bounds (`lowerBound(candidate)`): `{list, lower, order}`, `lower[index]` being
   * candidate `index`'s bound and `order` every index by (bound, index).
   */
  function rankedByBound(candidates, lowerBound) {
    const lower = candidates.map(lowerBound);
    const order = candidates.map((_, index) => index).sort((a, b) => compareCosts(lower[a], lower[b]) || a - b);
    return { list: candidates, lower: lower, order: order };
  }

  /**
   * `cheapest` of candidates already ranked by their bounds (`rankedByBound`); `exactCost(index, lower)` gives
   * candidate `index`'s cost. Each result also carries the candidate's `index` and `lower` bound.
   */
  function cheapestOfRanked(ranked, count, exactCost) {
    const best = [];
    for (const index of ranked.order) {
      const lower = ranked.lower[index];
      const last = best[count - 1];
      if (last && (compareCosts(lower, last.cost) || index - last.index) > 0) break;
      const entry = { candidate: ranked.list[index], index: index, lower: lower, cost: exactCost(index, lower) };
      const at = best.findIndex((other) => (compareCosts(entry.cost, other.cost) || entry.index - other.index) < 0);
      best.splice(at < 0 ? best.length : at, 0, entry);
    }
    return best.slice(0, count);
  }

  return {
    moveEvaluator: moveEvaluator, cheapest: cheapest, rankedByBound: rankedByBound, cheapestOfRanked: cheapestOfRanked
  };
});
