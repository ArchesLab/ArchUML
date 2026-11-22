(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./c4-route-frame.js'), require('./c4-route-costs.js'),
      require('./c4-route-state.js'), require('./c4-route-pricing.js'), require('./c4-route-separate.js'));
  } else {
    var parts = root.ArchUMLC4RouteParts = root.ArchUMLC4RouteParts || {};
    parts.select = factory(parts.frame, parts.costs, parts.state, parts.pricing, parts.separate);
  }
})(typeof self !== 'undefined' ? self : this, function (frameModule, costsModule, stateModule, pricingModule, separateModule) {
  'use strict';

  // Global selection (routing redesign §5.6): every edge takes its cheapest candidate against the edges chosen before
  // it; then single moves and pair moves repeat while they lower the view cost, and close parallels are separated last
  // (c4-route-separate.js).

  const { CFG } = frameModule;
  const { ZERO, added, addInto, subtracted, compareCosts, pairCost, sideGroups, groupCost, headsByBox,
    oneSidedFanIn } = costsModule;
  const { selectionState, currentCost, choose } = stateModule;
  const { moveEvaluator, cheapest, rankedByBound, cheapestOfRanked } = pricingModule;
  const { separateParallels } = separateModule;

  // ---- Single moves -------------------------------------------------------------------------------------------------

  /** The candidate of `index` with the lowest view cost against the current choices, and that cost. */
  function bestFor(state, index, candidates) {
    const evaluator = moveEvaluator(state, [index]);
    return cheapest(candidates, 1, (candidate) => evaluator.bound([candidate]), (candidate, lower) => evaluator.costFrom(lower, [candidate]))[0];
  }

  /** Straight-capable edges first, then the edges with the fewest candidates, then view-model order. */
  function selectionOrder(options) {
    return options.map((option, index) => index).sort((a, b) => Number(options[b].straight) - Number(options[a].straight) ||
      options[a].list.length - options[b].list.length || a - b);
  }

  /**
   * Re-chooses each edge against all others; keeps a change only when the view cost strictly drops. An edge that
   * found no better candidate is not tried again until some choice changes (`state.version`).
   */
  function improveOnce(state, options, order) {
    let improved = false;
    order.forEach((index) => {
      if (state.settledEdges.get(index) === state.version) return;
      const current = currentCost(state);
      const best = bestFor(state, index, options[index].list);
      if (compareCosts(best.cost, current) < 0) {
        choose(state, index, best.candidate);
        improved = true;
      } else state.settledEdges.set(index, state.version);
    });
    return improved;
  }

  // ---- Pair moves ---------------------------------------------------------------------------------------------------

  /** Pairs of edges that still cost each other something, or that share an end box with a crowded or conflicting side
   * or a one-sided fan-in. */
  function pairsToRevisit(state) {
    const groups = sideGroups(state.frame, state.chosen);
    const troubled = new Set(groups.filter((group) => compareCosts(groupCost(group), ZERO) !== 0).map((group) => group.box));
    headsByBox(groups).forEach((sides, box) => { if (oneSidedFanIn(sides)) troubled.add(box); });
    const pairs = [];
    state.chosen.forEach((first, i) => {
      for (let j = i + 1; j < state.chosen.length; j++) {
        const cost = state.pairs[i][j];
        const second = state.chosen[j];
        const sharesTroubledBox = [first.edge.source, first.edge.target]
          .some((id) => troubled.has(id) && (id === second.edge.source || id === second.edge.target));
        if (sharesTroubledBox || cost[1] > 0 || cost[2] > 0 || cost[3] > 0) pairs.push([i, j]);
      }
    });
    return pairs;
  }

  /**
   * Whether the side costs of `a` and `b` depend on each other: an end of each lies on the same side of the same box,
   * or both arrive at the same box, whose fan-in counts the sides of all its heads.
   */
  function sideCostsInteract(a, b) {
    const same = (id, end, otherId, otherEnd) => id === otherId && end.side === otherEnd.side;
    return a.edge.target === b.edge.target || same(a.edge.source, a.source, b.edge.source, b.source) || same(a.edge.source, a.source, b.edge.target, b.target) ||
      same(a.edge.target, a.target, b.edge.source, b.source) || same(a.edge.target, a.target, b.edge.target, b.target);
  }

  /**
   * The cheapest answer (ties in list order), `{candidate, cost}`, of the edge at `answering` in a freed pair to
   * `lead` on the other edge, priced by `evaluator`. `answers` ranks the answers by their bound with the lead's edge
   * taken out (`rankedByBound`: `lower`, `order`), `leadAlone` is the lead's bound with the answer's edge taken out,
   * and `empty` the bound with both out. An answer whose side costs do not interact with the lead's
   * (`sideCostsInteract`) changes other sides and boxes than it does, so its bound is `leadAlone + lower − empty`
   * plus their pair cost (at least 0). Those answers are searched in `order`, where that rough bound rises, until it
   * can no longer beat the cheapest found; the few that interact are priced from the evaluator's bound.
   */
  function bestAnswer(evaluator, answers, answering, lead, leadAlone, empty) {
    const picksOf = (answer) => (answering === 0 ? [answer, lead] : [lead, answer]);
    const offset = subtracted(leadAlone, empty);
    let best = null;
    const beats = (value, index) => !best || (compareCosts(value, best.cost) || index - best.index) < 0;
    const price = (index, lower) => {
      const cost = evaluator.costFrom(lower, picksOf(answers.list[index]));
      if (beats(cost, index)) best = { candidate: answers.list[index], cost: cost, index: index };
    };
    answers.list.forEach((answer, index) => {
      if (!sideCostsInteract(answer, lead)) return;
      const lower = evaluator.bound(picksOf(answer));
      if (beats(lower, index)) price(index, lower);
    });
    for (const index of answers.order) {
      const answer = answers.list[index];
      if (sideCostsInteract(answer, lead)) continue;
      const rough = added(offset, answers.lower[index]);
      if (!beats(rough, index)) break;
      const lower = addInto(rough, pairCost(evaluator.frame, lead, answer));
      if (beats(lower, index)) price(index, lower);
    }
    return best;
  }

  /**
   * Pair moves (§5.6): for two edges that cost each other something or share an end box, each of the first edge's
   * best `pairMoveCandidates` routes with the second edge taken out, then the second edge's best answer to it, in
   * both orders; the best pair is kept when it lowers the view cost. This makes the exchanges one edge at a time
   * cannot, such as moving a neighbour's end along a side to make room for another end. A pair that found no better
   * move is not tried again until some choice changes (`state.version`).
   */
  function pairMoves(state, options) {
    let improved = false;
    pairsToRevisit(state).forEach((pair) => {
      const key = pair.join(' ');
      if (state.settledPairs.get(key) === state.version) return;
      const evaluator = moveEvaluator(state, pair);
      const empty = evaluator.bound([null, null]);
      /** The picks with `candidate` on the pair's edge `at` and the other edge taken out. */
      const picksAlone = (at, candidate) => (at === 0 ? [candidate, null] : [null, candidate]);
      // Each edge's candidates ranked by their bound with the other edge taken out.
      const ranked = [0, 1].map((at) => rankedByBound(options[pair[at]].list, (candidate) => evaluator.bound(picksAlone(at, candidate))));
      let best = { cost: currentCost(state), changes: null };
      [0, 1].forEach((leading) => {
        const answering = 1 - leading;
        const leads = cheapestOfRanked(ranked[leading], CFG.pairMoveCandidates,
          (index, lower) => evaluator.costFrom(lower, picksAlone(leading, ranked[leading].list[index])));
        leads.forEach((lead) => {
          const answer = bestAnswer(evaluator, ranked[answering], answering, lead.candidate, lead.lower, empty);
          if (compareCosts(answer.cost, best.cost) < 0) {
            best = { cost: answer.cost, changes: [{ index: pair[leading], candidate: lead.candidate }, { index: pair[answering], candidate: answer.candidate }] };
          }
        });
      });
      if (best.changes) {
        best.changes.forEach((change) => choose(state, change.index, change.candidate));
        improved = true;
      } else state.settledPairs.set(key, state.version);
    });
    return improved;
  }

  // ---- Entry point --------------------------------------------------------------------------------------------------

  /**
   * Chooses one candidate per edge for all edges together (§5.6) from `options`, each edge's candidates
   * (`candidatesOf`). Returns `{chosen, rounds, cost, state}`: the chosen candidates in view-model order, the rounds
   * of moves taken, the view cost, and the selection state, which evidence mode reads.
   */

  function select(frame, options) {
    const state = selectionState(frame, options);
    const order = selectionOrder(options);
    order.forEach((index) => choose(state, index, bestFor(state, index, options[index].list).candidate));
    let rounds = 0;
    for (let improved = true; improved && rounds < CFG.maxSelectionRounds; rounds++) {
      improved = improveOnce(state, options, order) || pairMoves(state, options);
    }
    if (separateParallels(state, options)) improveOnce(state, options, order);
    return { chosen: state.chosen, rounds: rounds, cost: currentCost(state), state: state };
  }

  return { select: select };
});
