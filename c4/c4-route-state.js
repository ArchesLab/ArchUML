(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./c4-route-frame.js'), require('./c4-route-labels.js'),
      require('./c4-route-costs.js'));
  } else {
    var parts = root.ArchUMLC4RouteParts = root.ArchUMLC4RouteParts || {};
    parts.state = factory(parts.frame, parts.labels, parts.costs);
  }
})(typeof self !== 'undefined' ? self : this, function (frameModule, labelsModule, costsModule) {
  'use strict';

  // The selection state (routing redesign §5.6): one chosen candidate per edge, the running sums of the chosen routes'
  // own and pair costs, each candidate's cost against the chosen routes, and each label's conflict with them (§6.1).
  // `choose` is the one change of choice, and keeps all of these up to date.

  const { boundsMeet } = frameModule;
  const { labelOf, nearLabel, labelBlocked } = labelsModule;
  const { zeroCost, ZERO, added, addInto, subtractInto, subtracted, MAX_PAIR_REACH, pairCost, ownCost,
    sideCost } = costsModule;

  // ---- State --------------------------------------------------------------------------------------------------------

  /**
   * The selection state: one chosen candidate per edge (or null), the pair costs between chosen routes, `routes`,
   * the sum of every chosen route's own cost and of every pair cost (side costs are recounted each time), and the
   * label conflicts of the chosen routes: `labelConflict[i]` is 1 when edge i's label has no legal place against
   * the other chosen routes (§6.1), and `labelConflicts` their sum. `candidates` holds each edge's candidates with
   * the bounds of them all (`envelope`), whose `withChosen` `updatePairSums` keeps. `version` counts the changes of
   * choice; `settledEdges` and `settledPairs` hold the version at which an edge or a pair last found no better move.
   */
  function selectionState(frame, options) {
    const count = options.length;
    options.forEach((option) => option.list.forEach(startWithChosen));
    return {
      frame: frame, chosen: new Array(count).fill(null), routes: zeroCost(),
      pairs: Array.from({ length: count }, () => new Array(count).fill(ZERO)),
      labelConflict: new Array(count).fill(0), labelConflicts: 0,
      candidates: options.map((option) => ({ list: option.list, envelope: envelopeOf(option.list) })),
      version: 0, settledEdges: new Map(), settledPairs: new Map(),
    };
  }

  /**
   * Starts a candidate's `withChosen`, its own cost plus its pair costs against the chosen routes of the other edges,
   * with nothing chosen: its own cost. A price then adds one vector per pick instead of two.
   */
  function startWithChosen(candidate) {
    candidate.withChosen = ownCost(candidate).slice();
  }

  /** The bounds of every candidate in `list`. */
  function envelopeOf(list) {
    return list.reduce((envelope, candidate) => {
      const bounds = candidate.bounds;
      return { x0: Math.min(envelope.x0, bounds.x0), x1: Math.max(envelope.x1, bounds.x1), y0: Math.min(envelope.y0, bounds.y0), y1: Math.max(envelope.y1, bounds.y1) };
    }, { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity });
  }

  /**
   * Every candidate of an edge other than edge `index` whose bounds come within `pad` of `bounds`: an edge whose
   * candidates all lie farther away (its `envelope`) is passed over whole.
   */
  function candidatesNear(state, index, bounds, pad) {
    const near = [];
    state.candidates.forEach((edgeCandidates, at) => {
      if (at === index || !boundsMeet(edgeCandidates.envelope, bounds, pad)) return;
      for (const candidate of edgeCandidates.list) if (boundsMeet(candidate.bounds, bounds, pad)) near.push(candidate);
    });
    return near;
  }

  /**
   * Keeps every candidate's `withChosen` (its own cost plus its pair costs against the chosen routes of the other
   * edges) up to date when edge `index` changes from `before` to `after` (either may be null). Only candidates whose
   * bounds come within the pair-cost reach of a route can have a pair cost with it, so only those are visited.
   */
  function updatePairSums(state, index, before, after) {
    const pad = MAX_PAIR_REACH;
    if (before) {
      candidatesNear(state, index, before.bounds, pad).forEach((candidate) => {
        const cost = pairCost(state.frame, candidate, before);
        if (cost !== ZERO) subtractInto(candidate.withChosen, cost);
      });
    }
    if (after) {
      candidatesNear(state, index, after.bounds, pad).forEach((candidate) => {
        const cost = pairCost(state.frame, candidate, after);
        if (cost !== ZERO) addInto(candidate.withChosen, cost);
      });
    }
  }

  // ---- Label conflicts (§5.5, §6.1) ---------------------------------------------------------------------------------

  /** 1 when edge `index`'s label, at `pick(index)`, has no legal place against every other picked route. */
  function labelConflictAt(state, index, pick) {
    const candidate = pick(index);
    const label = candidate && labelOf(state.frame, candidate);
    if (!label) return 0;
    const routes = [];
    state.chosen.forEach((_, other) => {
      const route = other === index ? null : pick(other);
      if (route && nearLabel(label, route)) routes.push(route);
    });
    return labelBlocked(state.frame, label, routes, (route) => route.edge.index !== index && pick(route.edge.index) === route) ? 1 : 0;
  }

  /**
   * The edges whose label conflict can change when the edges in `changed` move to `pick`: the moved edges, and every
   * edge with a label place near the old or new route of a moved edge.
   */
  function labelsTouched(state, changed, pick) {
    const touched = new Set(changed);
    const moved = Array.from(changed).flatMap((index) => [state.chosen[index], pick(index)]).filter(Boolean);
    state.chosen.forEach((current, index) => {
      if (!current || touched.has(index)) return;
      const label = labelOf(state.frame, current);
      if (label && moved.some((route) => nearLabel(label, route))) touched.add(index);
    });
    return touched;
  }

  /** The view's label conflicts with the edges in `changed` at `pick`, and each touched edge's new conflict. */
  function labelConflictsWith(state, changed, pick) {
    const updates = new Map();
    let total = state.labelConflicts;
    labelsTouched(state, changed, pick).forEach((index) => {
      const conflict = labelConflictAt(state, index, pick);
      updates.set(index, conflict);
      total += conflict - state.labelConflict[index];
    });
    return { total: total, updates: updates };
  }

  // ---- Changes of choice --------------------------------------------------------------------------------------------

  /** The own and pair costs that involve the edges listed in `changes`, with each listed edge at `pick(index)`. */
  function involvedCost(state, changed, pick) {
    let total = zeroCost();
    changed.forEach((index) => {
      const candidate = pick(index);
      if (!candidate) return;
      total = added(total, ownCost(candidate));
      state.chosen.forEach((_, other) => {
        const partner = pick(other);
        if (other === index || !partner || (changed.has(other) && other < index)) return;
        total = added(total, changed.has(other) || candidate !== state.chosen[index] ? pairCost(state.frame, candidate, partner) : state.pairs[index][other]);
      });
    });
    return total;
  }

  /** The view's cost with the current choices. */
  function currentCost(state) {
    const cost = addInto(state.routes.slice(), sideCost(state.frame, state.chosen));
    cost[0] += state.labelConflicts;
    return cost;
  }

  function choose(state, index, candidate) {
    state.version++;
    updatePairSums(state, index, state.chosen[index], candidate);
    const changed = new Set([index]);
    const labels = labelConflictsWith(state, changed, (at) => (at === index ? candidate : state.chosen[at]));
    labels.updates.forEach((conflict, at) => { state.labelConflict[at] = conflict; });
    state.labelConflicts = labels.total;
    state.routes = subtracted(state.routes, involvedCost(state, changed, (at) => state.chosen[at]));
    state.chosen[index] = candidate;
    state.chosen.forEach((other, at) => {
      const cost = at === index || !other ? ZERO : pairCost(state.frame, candidate, other);
      state.pairs[index][at] = cost;
      state.pairs[at][index] = cost;
    });
    state.routes = added(state.routes, involvedCost(state, changed, (at) => state.chosen[at]));
  }

  /**
   * Starts `candidate`'s `withChosen` (`startWithChosen`) for a candidate made while routes are already chosen: its
   * own cost plus its pair costs against the chosen routes of every edge but its own.
   */
  function startWithChosenAgainst(state, candidate) {
    startWithChosen(candidate);
    state.chosen.forEach((route, index) => {
      if (!route || index === candidate.edge.index) return;
      const cost = pairCost(state.frame, candidate, route);
      if (cost !== ZERO) addInto(candidate.withChosen, cost);
    });
  }

  /**
   * Makes `candidate`, new to the selection and priced against the current choices (`startWithChosenAgainst`), one
   * of its edge's candidates, so that `updatePairSums` keeps its `withChosen` from now on.
   */
  function admitCandidate(state, option, candidate) {
    option.list.push(candidate);
    const edgeCandidates = state.candidates[candidate.edge.index];
    edgeCandidates.envelope = envelopeOf([{ bounds: edgeCandidates.envelope }, candidate]);
  }

  return {
    selectionState: selectionState, labelConflictAt: labelConflictAt, involvedCost: involvedCost,
    currentCost: currentCost, choose: choose, startWithChosenAgainst: startWithChosenAgainst,
    admitCandidate: admitCandidate
  };
});
