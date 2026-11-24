(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./c4-place-frame.js'), require('./c4-place-ranks.js'), require('./c4-place-corridors.js'));
  } else {
    var parts = root.ArchUMLC4PlaceParts = root.ArchUMLC4PlaceParts || {};
    parts.cross = factory(parts.frame, parts.ranks, parts.corridors);
  }
})(typeof self !== 'undefined' ? self : this, function (frameModule, ranksModule, corridorsModule) {
  'use strict';

  // Coordinates across the flow (routing redesign §4.5): straight edges first. Difference constraints keep the entries
  // of every rank apart and every boundary around its members; alignment requests for straight edges are accepted in
  // priority order while the drawing stays narrow enough; the result is compacted and balanced.

  const { CFG, frameExtents } = frameModule;
  const { ROOT, compareScores, entryOf, itemAt, levelsAround, widthOf, gapBetween } = ranksModule;
  const { gapCorridorId, corridorPlans } = corridorsModule;

  // ---- Relations between boxes across levels ----------------------------------------------------------------

  /** −1 when `a` lies before `b` on the flow axis, 1 after it, 0 when they share a rank of their lowest common level. */
  function flowSign(ordered, a, b) {
    const theirs = levelsAround(ordered.structure, b);
    const common = levelsAround(ordered.structure, a).find((level) => theirs.indexOf(level) >= 0);
    return Math.sign(ordered.ranks.get(itemAt(ordered.structure, a, common)) - ordered.ranks.get(itemAt(ordered.structure, b, common)));
  }

  /** The ranks of an entry and of the blocks around it, outermost first: ordered lexicographically, top to bottom. */
  function rankPath(ordered, id) {
    const path = [];
    for (let current = id; current !== ROOT; current = ordered.structure.entries.get(current).level) path.unshift(ordered.ranks.get(current));
    return path;
  }

  function compareRankPaths(a, b) {
    for (let index = 0; index < Math.min(a.length, b.length); index++) {
      if (a[index] !== b[index]) return a[index] - b[index];
    }
    return a.length - b.length;
  }

  /**
   * The element boxes at the other ends of an item's edges that lie on `side` of it (−1 before, 1 after), each
   * once, in edge order. Edges that land on a boundary have no box partner.
   */
  function partnersOn(ordered, id, side) {
    const partners = [];
    ordered.structure.graph.edges.forEach((edge) => {
      const other = edge.source === id ? edge.target : (edge.target === id ? edge.source : null);
      if (other === null || other === id || partners.indexOf(other) >= 0 || ordered.structure.entries.get(other).kind !== 'box') return;
      if (flowSign(ordered, other, id) === side) partners.push(other);
    });
    return partners;
  }

  function isAncestor(structure, boundaryId, id) {
    return levelsAround(structure, id).indexOf(boundaryId) >= 0;
  }

  // ---- Cross-axis constraint system (§4.5) -------------------------------------------------------------------

  // Difference constraints `x[to] ≥ x[from] + gap` over integer variables; variable 0 is the origin that balancing
  // fixes moved units to. The least solution above a start is a longest-path relaxation; a positive cycle means the
  // system has no solution. Compaction starts every variable at 0 (`compactionStart`), so the least solution puts
  // each one as far toward the before side as the constraints allow.

  /**
   * The solver's variables: the left edge of every box and lane item, the before and after borders of every
   * block, and room for one planned straight segment per alignment request (allocated as requests are tried).
   */
  function crossVariables(ordered) {
    const left = new Map();
    const right = new Map();
    let count = 1;
    ordered.structure.levelOrder.forEach((levelId) => ordered.rows.get(levelId).forEach((row) => row.forEach((id) => {
      left.set(id, count++);
      if (entryOf(ordered.structure, id).kind === 'block') right.set(id, count++);
    })));
    return { left: left, right: right, count: count };
  }

  function sideBefore(variables, id) {
    return { variable: variables.left.get(id), offset: 0 };
  }

  function sideAfter(ordered, variables, id) {
    return variables.right.has(id) ? { variable: variables.right.get(id), offset: 0 } : { variable: variables.left.get(id), offset: widthOf(ordered.structure, id) };
  }

  /** `later` ≥ `earlier` + `gap`, for two sides `{variable, offset}`. */
  function apart(earlier, later, gap) {
    return { from: earlier.variable, to: later.variable, gap: earlier.offset + gap - later.offset };
  }

  /** `x[second] = x[first] + offset`. */
  function together(first, second, offset) {
    return [{ from: first, to: second, gap: offset }, { from: second, to: first, gap: -offset }];
  }

  /** The least solution of the constraints at or above `start` (one value per variable), or null when they have none. */
  function solveCross(constraints, start) {
    const count = start.length;
    const value = start.slice();
    const outgoing = Array.from({ length: count }, () => []);
    constraints.forEach((constraint) => outgoing[constraint.from].push(constraint));
    const queue = Array.from({ length: count }, (_, index) => index);
    const queued = new Array(count).fill(true);
    const updates = new Array(count).fill(0);
    for (let head = 0; head < queue.length; head++) {
      const from = queue[head];
      queued[from] = false;
      for (const constraint of outgoing[from]) {
        if (value[from] + constraint.gap <= value[constraint.to]) continue;
        value[constraint.to] = value[from] + constraint.gap;
        if (queued[constraint.to]) continue;
        if (++updates[constraint.to] > count) return null;
        queued[constraint.to] = true;
        queue.push(constraint.to);
      }
    }
    return value;
  }

  /** Where compaction starts: every one of `count` variables at 0. */
  function compactionStart(count) {
    return new Array(count).fill(0);
  }

  // ---- Side ends and base constraints (§4.5) -------------------------------------------------------------------

  /** Heads a box is predicted to take on its before and after sides: those of a fan-in from above beyond two. */
  function predictedSideEnds(ordered, graph) {
    const sides = new Map();
    graph.items.forEach((item) => {
      const fanIn = graph.edges.filter((edge) => edge.target === item.id && edge.source !== item.id && flowSign(ordered, edge.source, item.id) < 0).length;
      const extra = Math.max(0, fanIn - CFG.maxHeadsPerSide);
      sides.set(item.id, { before: Math.floor(extra / 2), after: Math.ceil(extra / 2) });
    });
    return sides;
  }

  function sideEndsOf(sides, id) {
    return sides.get(id) || { before: 0, after: 0 };
  }

  /** The gap beside a side that takes `count` predicted ends: room for their approach run mid-gap. */
  function sideGap(count, gap) {
    return count ? Math.max(gap, CFG.headStub + (count - 1) * CFG.trackPitch + CFG.boxClearance) : gap;
  }

  /** The padding beside a member side that takes `count` predicted ends: the stub and its run stay out of the band. */
  function sidePad(count, pad) {
    return count ? Math.max(pad, CFG.boundaryBand + CFG.headStub + (count - 1) * CFG.trackPitch) : pad;
  }

  /** Separation of consecutive entries in every row, with side-end room and any extra a gap corridor asks for. */
  function rowConstraints(ordered, variables, sides, extra) {
    const constraints = [];
    ordered.structure.levelOrder.forEach((levelId) => ordered.rows.get(levelId).forEach((row, rank) => {
      const boxesAndBlocks = row.filter((id) => !ordered.structure.lanes.has(id));
      row.slice(1).forEach((id, index) => {
        const before = row[index];
        let gap = gapBetween(ordered.structure, before, id);
        gap = Math.max(sideGap(sideEndsOf(sides, before).after, gap), sideGap(sideEndsOf(sides, id).before, gap));
        const next = boxesAndBlocks[boxesAndBlocks.indexOf(before) + 1];
        if (!ordered.structure.lanes.has(before) && next) gap += extra.get(gapCorridorId(levelId, rank, before, next)) || 0;
        constraints.push(apart(sideAfter(ordered, variables, before), sideBefore(variables, id), gap));
      });
    }));
    return constraints;
  }

  /** Every block holds the entries of its level with its padding, and is at least as wide as its label needs. */
  function containmentConstraints(ordered, variables, sides, direction) {
    const constraints = [];
    ordered.structure.graph.boundaries.forEach((boundary) => {
      const pads = frameExtents({ main: Infinity, cross: Infinity }, boundary.labelWidth, boundary.labelHeight, direction);
      const least = frameExtents({ main: Infinity, cross: 0 }, boundary.labelWidth, boundary.labelHeight, direction);
      const border = { before: sideBefore(variables, boundary.id), after: sideAfter(ordered, variables, boundary.id) };
      constraints.push(apart(border.before, border.after, least.crossBefore + least.crossAfter));
      ordered.rows.get(boundary.id).forEach((row) => row.forEach((id) => {
        constraints.push(apart(border.before, sideBefore(variables, id), sidePad(sideEndsOf(sides, id).before, pads.crossBefore)));
        constraints.push(apart(sideAfter(ordered, variables, id), border.after, sidePad(sideEndsOf(sides, id).after, pads.crossAfter)));
      }));
    });
    return constraints;
  }

  /** The base system (row separation and containment, `constraints`) and its least solution. */
  function baseSystem(variables, constraints) {
    const values = solveCross(constraints, compactionStart(variables.count));
    if (values === null) throw new Error('C4 placement: the boxes cannot be separated across the flow');
    return { constraints: constraints, values: values };
  }

  // ---- Alignment requests (§4.5) -------------------------------------------------------------------------------

  /** Targets that more than half of `edges` go to. */
  function dominantTargets(edges) {
    return edges.map((edge) => edge.target).filter((target, index, all) => all.indexOf(target) === index &&
      2 * all.filter((other) => other === target).length > all.length);
  }

  function firstEdgeBetween(graph, a, b) {
    return graph.edges.findIndex((edge) => (edge.source === a && edge.target === b) || (edge.source === b && edge.target === a));
  }

  /**
   * The alignment requests of a graph: a centre-line request where an item's edges toward one side mostly go to one
   * neighbour that has no other partner in the item's rank, and one port-overlap request per partner of an item
   * with two or more partners on one side. `a` is the item the request starts from, `b` its partner.
   */
  function alignmentRequests(ordered, graph) {
    const requests = [];
    const seen = new Set();
    const add = (kind, a, b, edgeIndex) => {
      const key = kind === 'centre' ? kind + '|' + edgeIndex : kind + '|' + a + '|' + b;
      if (seen.has(key)) return;
      seen.add(key);
      requests.push({ kind: kind, a: a, b: b, edgeIndex: edgeIndex, edgeId: graph.edges[edgeIndex].id });
    };
    const isBox = (id) => ordered.structure.entries.get(id).kind === 'box';
    graph.items.forEach((item) => [1, -1].forEach((side) => {
      const outgoing = graph.edges.filter((edge) => edge.source === item.id && edge.target !== item.id && isBox(edge.target) &&
        flowSign(ordered, edge.target, item.id) === side);
      dominantTargets(outgoing).filter((target) => !partnersOn(ordered, target, -side)
        .some((other) => other !== item.id && flowSign(ordered, other, item.id) === 0))
        .forEach((target) => add('centre', item.id, target, firstEdgeBetween(graph, item.id, target)));
      const partners = partnersOn(ordered, item.id, side);
      if (partners.length >= 2) partners.forEach((partner) => add('overlap', item.id, partner, firstEdgeBetween(graph, item.id, partner)));
    }));
    return requests;
  }

  /** Whether an edge runs from a person into the scope boundary or from inside it to an external element. */
  function crossesScopeOutward(ordered, graph, edge) {
    const scope = graph.scopeId;
    if (!scope || !ordered.structure.levels.has(scope)) return false;
    const inside = (id) => isAncestor(ordered.structure, scope, id);
    const item = (id) => graph.items.find((candidate) => candidate.id === id);
    return inside(edge.source) !== inside(edge.target) && (item(edge.source).role === 'person' || item(edge.target).external === true);
  }

  /** Whether neither end of a request has another edge toward the other end's rank. */
  function oneToOne(ordered, graph, request) {
    const towardRankOf = (from, to) => graph.edges.filter((edge) => (edge.source === from || edge.target === from))
      .map((edge) => (edge.source === from ? edge.target : edge.source))
      .filter((other) => other !== to && other !== from && flowSign(ordered, other, to) === 0).length === 0;
    return towardRankOf(request.a, request.b) && towardRankOf(request.b, request.a);
  }

  /**
   * Requests in priority order (§4.5), each with its class (`[across the scope, derived]`) for retries: across the
   * scope boundary first, declared before derived, centre before overlap, edges with lane items first (a long edge
   * without a channel needs a detour, a short one only a jog), one-to-one first, fewer competing requests first,
   * then view-model edge order.
   */
  function prioritised(ordered, graph, requests) {
    const competing = (id) => requests.filter((request) => request.a === id || request.b === id).length;
    const itemIndex = (id) => graph.items.findIndex((item) => item.id === id);
    return requests.map((request) => {
      const edge = graph.edges[request.edgeIndex];
      const key = [
        crossesScopeOutward(ordered, graph, edge) ? 0 : 1, edge.derived ? 1 : 0, request.kind === 'centre' ? 0 : 1,
        lanesOf(ordered.structure, edge.id).length ? 0 : 1, oneToOne(ordered, graph, request) ? 0 : 1,
        competing(request.a) + competing(request.b), request.edgeIndex, itemIndex(request.a),
      ];
      return Object.assign({}, request, { key: key, priorityClass: key[0] * 2 + key[1] });
    }).sort((x, y) => compareScores(x.key, y.key));
  }

  function lanesOf(structure, edgeId) {
    return Array.from(structure.lanes.values()).filter((lane) => lane.edgeId === edgeId).map((lane) => lane.id);
  }

  /**
   * The constraints of one request with its planned segment `segment` (§4.5): the alignment itself, the segment
   * inside both boxes' straight window (a lane request: inside `a`'s window only), and the edge's lane items on the
   * segment. Boundary labels add nothing: they move clear of the routes that cross their label line instead
   * (c4-render.js `placeBoundaryLabels`).
   */
  function requestConstraints(ordered, variables, request, segment) {
    const structure = ordered.structure;
    const [a, b] = [request.a, request.b];
    const [left, right] = [variables.left.get(a), variables.left.get(b)];
    const [wa, wb] = [widthOf(structure, a), widthOf(structure, b)];
    const constraints = [];
    const insideWindow = (pair) => constraints.push(
      { from: pair[0], to: segment, gap: CFG.cornerMargin }, { from: segment, to: pair[0], gap: CFG.cornerMargin - pair[1] });
    if (request.kind === 'centre') {
      constraints.push(...together(left, right, Math.floor((wa - wb) / 2)), ...together(left, segment, Math.floor(wa / 2)));
    } else if (request.kind === 'overlap') {
      const overlap = 2 * CFG.cornerMargin + CFG.slotPitch;
      constraints.push({ from: right, to: left, gap: overlap - wa }, { from: left, to: right, gap: overlap - wb });
      [[left, wa], [right, wb]].forEach(insideWindow);
    } else {
      insideWindow([left, wa]);
    }
    lanesOf(structure, request.edgeId).forEach((lane) => constraints.push(...together(segment, variables.left.get(lane), -CFG.trackPitch / 2)));
    return constraints;
  }

  // ---- Label room between planned segments (§4.5, §4.6) ----------------------------------------------------------

  /** The room a label on its segment needs to the next segment on either side. */
  function onLabelRoom(entry) {
    return entry.label && entry.position === 'on' ? Math.ceil(entry.label / 2) + CFG.labelForeignClear : 0;
  }

  /**
   * Label room between planned segments (§4.5): neighbouring segments in a corridor keep a track apart, and an on
   * label keeps half its width plus the foreign-route clearance to each neighbour. A beside label faces away from
   * every other planned segment, so it needs room only from the lane items outward (`outwardLaneConstraints`).
   */
  function labelClearanceConstraints(ordered, variables, plans) {
    const constraints = [];
    plans.forEach((list) => list.slice(1).forEach((entry, index) => {
      const before = list[index];
      constraints.push({ from: before.variable, to: entry.variable, gap: Math.max(CFG.trackPitch, onLabelRoom(before), onLabelRoom(entry)) });
    }));
    return constraints.concat(outwardLaneConstraints(ordered, variables, plans));
  }

  /** The nearest lane item of another edge in `row`, stepping from position `at` by `step`; null when there is none. */
  function nearestLane(ordered, row, at, step, edgeId) {
    for (let index = at + step; index >= 0 && index < row.length; index += step) {
      const lane = ordered.structure.lanes.get(row[index]);
      if (lane && lane.edgeId !== edgeId) return lane.id;
    }
    return null;
  }

  /**
   * A beside label keeps its width, the beside gap and the foreign-route clearance free outward, up to the route
   * reserved by the nearest lane item outward in either row next to its corridor.
   */
  function outwardLaneConstraints(ordered, variables, plans) {
    const constraints = [];
    const reach = (entry) => entry.label + CFG.labelBesideGap + CFG.labelForeignClear;
    plans.forEach((list) => list.filter((entry) => entry.label && entry.position !== 'on').forEach((entry) => {
      const step = entry.position === 'after' ? 1 : -1;
      entry.sides.forEach((side) => {
        const lane = nearestLane(ordered, side.row, side.at, step, entry.edgeId);
        if (lane === null) return;
        const route = { variable: variables.left.get(lane), offset: CFG.trackPitch / 2 };
        const segment = { variable: entry.variable, offset: 0 };
        constraints.push(step > 0 ? apart(segment, route, reach(entry)) : apart(route, segment, reach(entry)));
      });
    }));
    return constraints;
  }

  // ---- Accepting requests (§4.5) ---------------------------------------------------------------------------------

  /** The cross extent of a solution: from the leftmost to the rightmost side of every box and block. */
  function crossExtent(ordered, variables, values) {
    const ids = ordered.structure.graph.items.map((item) => item.id).concat(ordered.structure.graph.boundaries.map((boundary) => boundary.id));
    const lefts = ids.map((id) => values[sideBefore(variables, id).variable]);
    const rights = ids.map((id) => {
      const side = sideAfter(ordered, variables, id);
      return values[side.variable] + side.offset;
    });
    return ids.length ? Math.max(...rights) - Math.min(...lefts) : 0;
  }

  /**
   * Tries the requests in priority order and keeps each one the system can still satisfy without stretching the
   * drawing by more than `maxStretch`; a rejected centre-line request is retried once, at the end of its class, as a
   * port-overlap request, and a rejected port-overlap request at once as lane requests (`laneRetries`). Returns
   * the accepted requests with their segment variables and the final solution.
   */
  function acceptRequests(ordered, graph, variables, base, requests) {
    const accepted = [];
    const aligned = new Set();
    let values = base.values;
    let rejected = 0;
    let next = variables.count;
    const queue = requests.slice();
    const systemWith = (trial) => base.constraints
      .concat(...trial.map((entry) => requestConstraints(ordered, variables, entry.request, entry.variable)))
      .concat(labelClearanceConstraints(ordered, variables, corridorPlans(ordered, graph, trial.map((entry) => ({ edgeIndex: entry.request.edgeIndex, variable: entry.variable })))));
    for (let index = 0; index < queue.length; index++) {
      const request = queue[index];
      if (aligned.has(request.edgeIndex)) continue;
      const trial = accepted.concat([{ request: request, variable: next }]);
      const solution = solveCross(systemWith(trial), compactionStart(next + 1));
      const affordable = solution && crossExtent(ordered, variables, solution) - crossExtent(ordered, variables, values) <= CFG.maxStretch;
      if (affordable) {
        accepted.push(trial[trial.length - 1]);
        aligned.add(request.edgeIndex);
        values = solution;
        next++;
        continue;
      }
      rejected++;
      if (request.kind === 'centre') queue.splice(endOfClass(queue, index, request.priorityClass), 0, Object.assign({}, request, { kind: 'overlap' }));
      else queue.splice(index + 1, 0, ...laneRetries(ordered.structure, request));
    }
    return { accepted: accepted, values: values, count: next, constraints: systemWith(accepted), rejected: rejected };
  }

  /**
   * A rejected port-overlap request of an edge with lane items is retried at once as two lane requests (§4.3 rule
   * 4): they keep only the lane items' channel inside the window of one end, `a` first, so the route still has a
   * monotone corridor with one jog.
   */
  function laneRetries(structure, request) {
    if (request.kind !== 'overlap' || !lanesOf(structure, request.edgeId).length) return [];
    return [Object.assign({}, request, { kind: 'lane' }), Object.assign({}, request, { kind: 'lane', a: request.b, b: request.a })];
  }

  function endOfClass(queue, from, priorityClass) {
    let index = from + 1;
    while (index < queue.length && queue[index].priorityClass === priorityClass) index++;
    return index;
  }

  // ---- Compaction and balance (§4.5) ------------------------------------------------------------------------------

  /** Union-find over the variables joined by equalities: centre-line pairs, segments with their lanes. */
  function alignmentUnits(ordered, variables, accepted, count) {
    const parent = Array.from({ length: count }, (_, index) => index);
    const find = (index) => (parent[index] === index ? index : (parent[index] = find(parent[index])));
    const union = (a, b) => { parent[find(a)] = find(b); };
    accepted.forEach((entry) => {
      if (entry.request.kind === 'centre') {
        union(variables.left.get(entry.request.a), variables.left.get(entry.request.b));
        union(variables.left.get(entry.request.a), entry.variable);
      }
      lanesOf(ordered.structure, entry.request.edgeId).forEach((lane) => union(entry.variable, variables.left.get(lane)));
    });
    const units = new Map();
    for (let index = 0; index < count; index++) {
      if (!units.has(find(index))) units.set(find(index), { variables: [], boxes: [] });
      units.get(find(index)).variables.push(index);
    }
    ordered.structure.graph.items.forEach((item) => units.get(find(variables.left.get(item.id))).boxes.push(item.id));
    return Array.from(units.values()).filter((unit) => unit.boxes.length > 0);
  }

  function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  /**
   * How far a unit wants to move across the flow (§4.5 balance): toward the median of its partners before it; a
   * unit without partners before it toward its soft target, centred over the partners after it of each of its fans.
   */
  function balanceShift(ordered, unit, sidesOf) {
    const centreOf = (id) => spanCentre([id], sidesOf);
    const outside = (id) => unit.boxes.indexOf(id) < 0;
    const before = unit.boxes.flatMap((id) => partnersOn(ordered, id, -1).filter(outside).map((partner) => centreOf(partner) - centreOf(id)));
    if (before.length) return median(before);
    const fans = unit.boxes.map((id) => [id, partnersOn(ordered, id, 1).filter(outside)]).filter((pair) => pair[1].length >= 2);
    if (!fans.length) return 0;
    return median(fans.map((pair) => spanCentre(pair[1], sidesOf) - centreOf(pair[0])));
  }

  /** The centre of the span the boxes `ids` cover across the flow; `sidesOf(id)` is a box's `[before, after]`. */
  function spanCentre(ids, sidesOf) {
    return (Math.min(...ids.map((id) => sidesOf(id)[0])) + Math.max(...ids.map((id) => sidesOf(id)[1]))) / 2;
  }

  /** The partners before a unit, when they are one single box (then siblings move as a group under it). */
  function soleParentOf(ordered, unit) {
    const parents = unit.boxes.flatMap((id) => partnersOn(ordered, id, -1)).filter((id, index, all) => unit.boxes.indexOf(id) < 0 && all.indexOf(id) === index);
    return parents.length === 1 ? parents[0] : null;
  }

  /**
   * The largest shift of the `moving` variables that keeps every frozen variable where it is: other variables may
   * be pushed along, but not past what the frozen ones allow.
   */
  function pushLimit(constraints, values, moving, frozen) {
    const count = values.length;
    const upper = new Array(count).fill(Infinity);
    frozen.forEach((variable) => { upper[variable] = values[variable]; });
    for (let changed = true, round = 0; changed && round <= count; round++) {
      changed = false;
      constraints.forEach((constraint) => {
        if (moving.has(constraint.from) || moving.has(constraint.to) || frozen.has(constraint.from)) return;
        if (upper[constraint.to] - constraint.gap < upper[constraint.from]) {
          upper[constraint.from] = upper[constraint.to] - constraint.gap;
          changed = true;
        }
      });
    }
    return constraints.filter((constraint) => moving.has(constraint.from) && !moving.has(constraint.to))
      .reduce((limit, constraint) => Math.min(limit, upper[constraint.to] - constraint.gap - values[constraint.from]), Infinity);
  }

  /**
   * The balancing aim of §4.5 (`aimOf` for `balance`): a unit moves toward the median of its partners before it, or
   * toward its soft target; siblings that share their only parent move as a group toward centring under it, so a
   * parent never moves for its children.
   */
  function centringAim(ordered) {
    return (unit, at) => {
      const parent = soleParentOf(ordered, unit);
      if (parent === null) return { group: [unit], wanted: balanceShift(ordered, unit, at.sidesOf) };
      const group = at.open.filter((other) => soleParentOf(ordered, other) === parent && compareRankPaths(at.topOf(other), at.topOf(unit)) === 0);
      return { group: group, wanted: spanCentre([parent], at.sidesOf) - spanCentre(group.flatMap((member) => member.boxes), at.sidesOf) };
    };
  }

  /**
   * Balances the units top-down in one pass (§4.5): each moves toward the aim `aimOf(unit, at)` gives
   * (`{group, wanted}`) within its slack, then stays where it is; `at` tells the aim the units still open and how to
   * read positions. Only moves across the flow to the after side are possible from the least solution: every unit
   * already lies as far before as the constraints allow.
   */
  function balance(ordered, variables, solved, aimOf) {
    const graph = ordered.structure.graph;
    const units = alignmentUnits(ordered, variables, solved.accepted, solved.count);
    const topOf = (unit) => unit.boxes.map((id) => rankPath(ordered, id)).sort(compareRankPaths)[0];
    units.sort((a, b) => compareRankPaths(topOf(a), topOf(b)) ||
      graph.items.findIndex((item) => item.id === a.boxes[0]) - graph.items.findIndex((item) => item.id === b.boxes[0]));
    let constraints = solved.constraints;
    let values = solved.values;
    const frozen = new Set([0]);
    const done = new Set();
    const sidesOf = (id) => [values[variables.left.get(id)], values[variables.left.get(id)] + widthOf(ordered.structure, id)];
    units.forEach((unit) => {
      if (done.has(unit)) return;
      const aim = aimOf(unit, { open: units.filter((other) => !done.has(other)), topOf: topOf, sidesOf: sidesOf });
      const shift = Math.round(aim.wanted);
      const moving = new Set(aim.group.flatMap((member) => member.variables));
      const step = shift > 0 ? Math.min(shift, pushLimit(constraints, values, moving, frozen)) : 0;
      constraints = constraints.concat(...Array.from(moving, (variable) => together(0, variable, values[variable] - values[0] + step)));
      if (step > 0) {
        values = solveCross(constraints, values);
        if (values === null) throw new Error('C4 placement: balancing pushed a unit past its slack');
      }
      moving.forEach((variable) => frozen.add(variable));
      aim.group.forEach((member) => done.add(member));
    });
    return values;
  }

  /**
   * Every block's before border moved as close to what it holds as its constraints allow, innermost block first
   * (§4.7 framing), so a boundary keeps only the room it needs on that side: padding, side-end room, the minimum
   * width its label needs. Compaction leaves a before border where compaction started when balancing moves its
   * members after it; its after border always follows them.
   */
  function huggingBorders(ordered, variables, constraints, values) {
    const hugged = values.slice();
    const outgoing = new Map();
    constraints.forEach((constraint) => {
      if (!outgoing.has(constraint.from)) outgoing.set(constraint.from, []);
      outgoing.get(constraint.from).push(constraint);
    });
    ordered.structure.levelOrder.slice().reverse().filter((levelId) => levelId !== ROOT).forEach((levelId) => {
      const border = variables.left.get(levelId);
      hugged[border] = Math.min(...outgoing.get(border).map((constraint) => hugged[constraint.to] - constraint.gap));
    });
    return hugged;
  }

  // ---- Cross positions -----------------------------------------------------------------------------------------

  /**
   * Cross positions of every entry (§4.5): `{left: Map id → before side, right: Map id → after side, at(variable)}`,
   * in the frame, where the first entry of the outer level's first rank starts at 0 (the origin, without one).
   */
  function crossPositions(ordered, variables, values) {
    const anchor = ordered.rows.get(ROOT)[0][0];
    const shift = anchor === undefined ? values[0] : values[variables.left.get(anchor)];
    const left = new Map();
    const right = new Map();
    variables.left.forEach((variable, id) => {
      left.set(id, values[variable] - shift);
      const after = sideAfter(ordered, variables, id);
      right.set(id, values[after.variable] + after.offset - shift);
    });
    return { left: left, right: right, at: (variable) => values[variable] - shift };
  }

  // ---- Entry point -------------------------------------------------------------------------------------------------

  /**
   * The cross positions of a ranked and ordered graph (§4.5): the base system, the alignment requests accepted in
   * priority order, then balance (`centringAim`) and hugging borders. Pins take no part: the settle step puts pinned
   * boxes on their pins afterwards (§4.7). Returns `{solved, cross}`: the accepted requests and their system
   * (`acceptRequests`), and `crossPositions`.
   */
  function placeAcross(ordered, frameGraph, direction, extra) {
    const variables = crossVariables(ordered);
    const sides = predictedSideEnds(ordered, frameGraph);
    const base = baseSystem(variables, rowConstraints(ordered, variables, sides, extra)
      .concat(containmentConstraints(ordered, variables, sides, direction)));
    const requests = prioritised(ordered, frameGraph, alignmentRequests(ordered, frameGraph));
    const solved = acceptRequests(ordered, frameGraph, variables, base, requests);
    const balanced = balance(ordered, variables, solved, centringAim(ordered));
    const cross = crossPositions(ordered, variables, huggingBorders(ordered, variables, solved.constraints, balanced));
    return { solved: solved, cross: cross };
  }

  return { placeAcross: placeAcross };
});
