(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./c4-route-frame.js'), require('./c4-route-costs.js'),
      require('./c4-route-state.js'));
  } else {
    var parts = root.ArchUMLC4RouteParts = root.ArchUMLC4RouteParts || {};
    parts.evidence = factory(parts.frame, parts.costs, parts.state);
  }
})(typeof self !== 'undefined' ? self : this, function (frameModule, costsModule, stateModule) {
  'use strict';

  // Evidence mode (routing redesign §5.6, §9.4), for tests and threshold evidence only: the fewest crossings the named
  // edges can reach together, searched over every combination of their candidates.

  const { realPoint } = frameModule;
  const { pairCost, sideCost } = costsModule;
  const { labelConflictAt } = stateModule;

  function crossingsBetween(frame, a, b) {
    return pairCost(frame, a, b)[1];
  }

  /**
   * The conflicts (§5.5 term 1) of the view with every edge at `pick(index)`: its side conflicts and one-sided
   * fan-ins, and its labels without a legal place.
   */
  function conflictsWith(state, pick) {
    const picked = state.chosen.map((_, index) => pick(index));
    const labels = picked.reduce((sum, _, index) => sum + labelConflictAt(state, index, pick), 0);
    return sideCost(state.frame, picked)[0] + labels;
  }

  /** What two routes cost each other in the §9.2 zero-gate terms below crossings: over-ends and close parallels. */
  function gatedBetween(frame, a, b) {
    const cost = pairCost(frame, a, b);
    return cost[2] + cost[3];
  }

  /**
   * The fewest crossings the named edges can reach together without breaking another gate the chosen routes keep:
   * every combination of their candidate sets, with every other edge kept on its chosen route. A combination counts
   * only when the view has no more conflicts (§5.5 term 1, which ranks above crossings) and no more over-ends and
   * close parallels (zero gates of §9.2, which rank below them) than with the chosen routes. Pair terms are
   * tabulated first, so each combination only adds numbers, and only combinations with fewer crossings than the best
   * found are checked further. Returns `{edges, combinations, minCrossings, routes}`, `routes` being one combination
   * that reaches the minimum (the chosen routes when none has fewer crossings).
   */
  function exhaustiveCrossings(state, perEdge, edgeIds) {
    const frame = state.frame;
    const indices = edgeIds.map((id) => {
      const index = frame.edges.findIndex((edge) => edge.id === id);
      if (index < 0) throw new Error('C4 routing: no edge "' + id + '" to search exhaustively');
      return index;
    });
    const named = new Set(indices);
    const lists = indices.map((index) => perEdge[index].list);
    /** `measure` of every candidate of each named edge against the fixed edges, and of every pair of named candidates. */
    const tabulate = (measure) => ({
      fixed: lists.map((list) => list.map((candidate) => state.chosen.reduce((sum, other, at) => sum + (named.has(at) ? 0 : measure(frame, candidate, other)), 0))),
      between: indices.map((_, a) => indices.map((__, b) => (b <= a ? null : lists[a].map((first) => lists[b].map((second) => measure(frame, first, second)))))),
    });
    const crossings = tabulate(crossingsBetween);
    const gated = tabulate(gatedBetween);
    const totalOf = (table, picks) => picks.reduce((sum, pick, depth) =>
      sum + table.fixed[depth][pick] + picks.slice(0, depth).reduce((pairs, earlier, at) => pairs + table.between[at][depth][earlier][pick], 0), 0);
    const routeOf = (picks) => (at) => (named.has(at) ? lists[indices.indexOf(at)][picks[indices.indexOf(at)]] : state.chosen[at]);
    const chosenPicks = indices.map((index, depth) => lists[depth].indexOf(state.chosen[index]));
    const allowed = { conflicts: conflictsWith(state, routeOf(chosenPicks)), gated: totalOf(gated, chosenPicks) };
    const keepsGates = (picks) => totalOf(gated, picks) <= allowed.gated && conflictsWith(state, routeOf(picks)) <= allowed.conflicts;
    let best = { total: totalOf(crossings, chosenPicks), picks: chosenPicks };
    const visit = (depth, picks, total) => {
      if (total >= best.total) return;
      if (depth === indices.length) {
        if (keepsGates(picks)) best = { total: total, picks: picks.slice() };
        return;
      }
      lists[depth].forEach((_, pick) => {
        const extra = picks.reduce((sum, earlier, at) => sum + crossings.between[at][depth][earlier][pick], crossings.fixed[depth][pick]);
        visit(depth + 1, picks.concat(pick), total + extra);
      });
    };
    visit(0, [], 0);
    return {
      edges: edgeIds.slice(),
      combinations: lists.reduce((product, list) => product * list.length, 1),
      minCrossings: best.total,
      routes: best.picks.map((pick, at) => ({ id: edgeIds[at], points: lists[at][pick].points.map((point) => realPoint(frame, point)) })),
    };
  }

  return { exhaustiveCrossings: exhaustiveCrossings };
});
