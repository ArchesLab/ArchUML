(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./c4-place-frame.js'));
  } else {
    var parts = root.ArchUMLC4PlaceParts = root.ArchUMLC4PlaceParts || {};
    parts.ranks = factory(parts.frame);
  }
})(typeof self !== 'undefined' ? self : this, function (frameModule) {
  'use strict';

  // Ranking and ordering (routing redesign §4.2–§4.4): the rank of every item along the flow axis and the order of the
  // items inside every rank. Each level (the outer one, then the children of each boundary) is ranked and ordered on
  // its own, and a nested boundary is one block item of its parent's level. Every tie ends in view-model order, then
  // id, so key order and id spelling never decide anything; the input is never mutated. The structure built here
  // (levels, entries, lane items) is what the later placement steps read.

  const { CFG } = frameModule;

  const ROOT = 'root';
  const EPSILON = 1e-9;

  // ---- Structure ------------------------------------------------------------------------------------------

  /**
   * The entries of a graph (boxes and boundary blocks, each with its level and view-model index), its levels, and
   * the levels in top-down order. A level's id is its boundary's id, or `ROOT` for the outer level. `person` marks
   * people and the blocks holding them, which share rank 0 with them. `seeding` is where the seed puts every item
   * (`seedingOf`), or null.
   */
  function structureOf(graph, seeding) {
    const entries = new Map();
    graph.items.forEach((item, index) => entries.set(item.id, {
      id: item.id, kind: 'box', width: item.width, level: levelIdOf(item.parent), vmIndex: index, person: item.role === 'person',
    }));
    graph.boundaries.forEach((boundary, index) => entries.set(boundary.id, {
      id: boundary.id, kind: 'block', width: 0, labelWidth: boundary.labelWidth || 0, level: levelIdOf(boundary.parent),
      vmIndex: graph.items.length + index, person: false,
    }));
    const levels = new Map([[ROOT, []]].concat(graph.boundaries.map((boundary) => [boundary.id, []])));
    entries.forEach((entry) => {
      if (!levels.has(entry.level)) throw new Error('C4 placement: unknown boundary "' + entry.level + '" for "' + entry.id + '"');
      levels.get(entry.level).push(entry.id);
    });
    const structure = { graph: graph, entries: entries, levels: levels, lanes: new Map(), laneBase: entries.size, seeding: seeding };
    graph.items.filter((item) => item.role === 'person').forEach((item) => markPersonHolders(structure, item.id));
    structure.levelOrder = Array.from(levels.keys())
      .sort((a, b) => depthOf(structure, a) - depthOf(structure, b) || levelIndex(structure, a) - levelIndex(structure, b));
    return structure;
  }

  function levelIdOf(parent) {
    return parent === null || parent === undefined ? ROOT : parent;
  }

  function levelIndex(structure, levelId) {
    return levelId === ROOT ? -1 : structure.entries.get(levelId).vmIndex;
  }

  function depthOf(structure, levelId) {
    let depth = 0;
    for (let current = levelId; current !== ROOT; current = structure.entries.get(current).level) depth++;
    return depth;
  }

  function markPersonHolders(structure, personId) {
    for (let level = structure.entries.get(personId).level; level !== ROOT; level = structure.entries.get(level).level) {
      structure.entries.get(level).person = true;
    }
  }

  /** The entry of `levelId` that is `id` or contains it; null when `id` lies outside the level. */
  function itemAt(structure, id, levelId) {
    if (!structure.entries.has(id)) throw new Error('C4 placement: unknown element "' + id + '"');
    for (let current = id; current !== ROOT; current = structure.entries.get(current).level) {
      if (structure.entries.get(current).level === levelId) return current;
    }
    return null;
  }

  function entryOf(structure, id) {
    return structure.entries.get(id) || structure.lanes.get(id);
  }

  /** View-model order (boxes, then boundaries, then lane items by edge), then id. */
  function byViewModel(structure) {
    return (a, b) => entryOf(structure, a).vmIndex - entryOf(structure, b).vmIndex || (a < b ? -1 : a > b ? 1 : 0);
  }

  function childrenOf(structure, levelId) {
    return structure.levels.get(levelId).slice().sort(byViewModel(structure));
  }

  /** The levels around an entry, from its own level out to the outer one. */
  function levelsAround(structure, id) {
    const levels = [];
    for (let level = structure.entries.get(id).level; ; level = structure.entries.get(level).level) {
      levels.push(level);
      if (level === ROOT) return levels;
    }
  }

  // ---- Relations of one level -----------------------------------------------------------------------------

  /** The edges seen from one level: `inner` between two of its entries, `ports` between an entry and the outside. */
  function relationsOf(structure, levelId) {
    const inner = [];
    const ports = [];
    structure.graph.edges.forEach((edge, edgeIndex) => {
      const source = itemAt(structure, edge.source, levelId);
      const target = itemAt(structure, edge.target, levelId);
      if (source !== null && target !== null) {
        if (source === target) return;
        inner.push({ edgeId: edge.id, edgeIndex: edgeIndex, source: source, target: target, sourceEnd: edge.source, targetEnd: edge.target });
      } else if (source !== null || target !== null) {
        ports.push({
          edgeId: edge.id, edgeIndex: edgeIndex, inside: source !== null ? source : target,
          insideEnd: source !== null ? edge.source : edge.target, outsideEnd: source !== null ? edge.target : edge.source,
          outsideIsSource: source === null,
        });
      }
    });
    return { inner: inner, ports: ports };
  }

  /**
   * Where a port's outside end lies relative to the level: above it, and whether it pulls the inside entry toward
   * that side. It is found in the nearest enclosing level that holds it, by comparing its rank with the rank of the
   * block that holds this level; people are always above.
   */
  function portSide(structure, ranks, levelId, port) {
    for (let level = levelId; ; level = structure.entries.get(level).level) {
      const parent = structure.entries.get(level).level;
      const outside = itemAt(structure, port.outsideEnd, parent);
      if (outside === null) continue;
      if (structure.entries.get(outside).person || ranks.get(outside) < ranks.get(level)) return { above: true, pulls: true };
      if (ranks.get(outside) > ranks.get(level)) return { above: false, pulls: true };
      return { above: port.outsideIsSource, pulls: false };
    }
  }

  // ---- Ranks (§4.3) ---------------------------------------------------------------------------------------

  /**
   * The rank constraint of one inner relation as `[upper, lower]`, or null. People (and the blocks holding them) stay
   * on top, so an edge to a person runs upward; around the scope's item, callers rank above it and the rest below.
   */
  function rankConstraint(structure, relation, pivot, inner) {
    const sourcePerson = structure.entries.get(relation.source).person;
    const targetPerson = structure.entries.get(relation.target).person;
    if (sourcePerson && targetPerson) return null;
    if (targetPerson) return [relation.target, relation.source];
    if (sourcePerson) return [relation.source, relation.target];
    if (pivot !== relation.source && pivot !== relation.target) return [relation.source, relation.target];
    const other = relation.source === pivot ? relation.target : relation.source;
    const pivotCalls = inner.some((candidate) => candidate.source === pivot && candidate.target === other);
    return other === relation.source && !pivotCalls ? [other, pivot] : [pivot, other];
  }

  /** Constraint pairs without cycles: a depth-first search in view-model order drops every back edge. */
  function acyclicConstraints(children, constraints) {
    const successors = new Map(children.map((id) => [id, []]));
    constraints.forEach((pair) => { if (successors.get(pair[0]).indexOf(pair[1]) < 0) successors.get(pair[0]).push(pair[1]); });
    const state = new Map();
    const kept = [];
    const visit = (id) => {
      state.set(id, 'open');
      successors.get(id).forEach((next) => {
        if (state.get(next) === 'open') return;
        kept.push([id, next]);
        if (!state.has(next)) visit(next);
      });
      state.set(id, 'done');
    };
    children.forEach((id) => { if (!state.has(id)) visit(id); });
    return kept;
  }

  /** The ranking problem of one level: its children, their acyclic constraints, and their neighbours. */
  function rankingProblem(structure, levelId) {
    const children = childrenOf(structure, levelId);
    const relations = relationsOf(structure, levelId);
    const pivot = structure.graph.scopeId ? itemAt(structure, structure.graph.scopeId, levelId) : null;
    const constraints = relations.inner.map((relation) => rankConstraint(structure, relation, pivot, relations.inner)).filter(Boolean);
    const predecessors = new Map(children.map((id) => [id, []]));
    const successors = new Map(children.map((id) => [id, []]));
    acyclicConstraints(children, constraints).forEach((pair) => {
      successors.get(pair[0]).push(pair[1]);
      predecessors.get(pair[1]).push(pair[0]);
    });
    const neighbours = new Map(children.map((id) => [id, []]));
    relations.inner.forEach((relation) => {
      neighbours.get(relation.source).push(relation.target);
      neighbours.get(relation.target).push(relation.source);
    });
    const hasPeople = children.some((id) => structure.entries.get(id).person);
    return {
      levelId: levelId, children: children, ports: relations.ports, predecessors: predecessors, successors: successors, neighbours: neighbours,
      isFixed: (id) => hasPeople && structure.entries.get(id).person,
      lowestRank: (id) => (hasPeople && !structure.entries.get(id).person ? 1 : 0),
    };
  }

  /** Starting ranks: people on 0, everyone else at their seed band (0 without a seed) or below their predecessors. */
  function startRanks(structure, problem) {
    const bands = structure.seeding ? seedBands(structure, problem.children) : null;
    const rank = new Map();
    topologicalOrder(problem.children, problem.predecessors).forEach((id) => {
      const start = problem.isFixed(id) ? 0 : Math.max(problem.lowestRank(id), bands ? bands.get(id) : 0);
      rank.set(id, problem.predecessors.get(id).reduce((lowest, upper) => Math.max(lowest, rank.get(upper) + 1), start));
    });
    return rank;
  }

  /** Children ordered so that every predecessor comes first, in view-model order otherwise. */
  function topologicalOrder(children, predecessors) {
    const done = new Set();
    const order = [];
    while (order.length < children.length) {
      children.forEach((id) => {
        if (done.has(id) || !predecessors.get(id).every((upper) => done.has(upper))) return;
        done.add(id);
        order.push(id);
      });
    }
    return order;
  }

  /** Ranks from the seed's y-bands: entries whose y ranges overlap share a band. */
  function seedBands(structure, children) {
    const spans = children.map((id) => ({ id: id, range: seedRange(structure, id) }))
      .sort((a, b) => a.range[0] - b.range[0] || byViewModel(structure)(a.id, b.id));
    const bands = new Map();
    let band = -1;
    let bottom = -Infinity;
    spans.forEach((span) => {
      if (span.range[0] >= bottom) band++;
      bottom = Math.max(bottom, span.range[1]);
      bands.set(span.id, band);
    });
    return bands;
  }

  /** The seed's y range of an entry: its box, or the union of the boxes inside a block. */
  function seedRange(structure, id) {
    const boxes = boxesWithin(structure, id);
    if (!boxes.length) return [0, 0];
    return boxes.reduce((range, item) => {
      const box = structure.seeding.boxes.get(item.id);
      return [Math.min(range[0], box.y), Math.max(range[1], box.y + box.height)];
    }, [Infinity, -Infinity]);
  }

  /**
   * Where a seed puts every item, in TB terms (`y` the rank axis, `x` the order axis): `{boxes: Map id → {x, y,
   * width, height}, laneCrosses: Map lane id → cross centre | null}`, or null without a seed. `seed` holds top-left
   * corners and `sizes` the sizes it laid the items out with.
   */
  function seedingOf(graph, seed, sizes) {
    if (!seed) return null;
    const boxes = new Map(graph.items.map((item) => {
      if (!seed[item.id]) throw new Error('C4 placement: the seed has no position for "' + item.id + '"');
      const size = sizes.get(item.id);
      return [item.id, { x: seed[item.id].x, y: seed[item.id].y, width: size.width, height: size.height }];
    }));
    return { boxes: boxes, laneCrosses: null };
  }

  /** The graph items that are `id` or lie inside it. */
  function boxesWithin(structure, id) {
    return structure.graph.items.filter((item) => {
      for (let current = item.id; current !== ROOT; current = structure.entries.get(current).level) {
        if (current === id) return true;
      }
      return false;
    });
  }

  /**
   * Pulls on a level's entries from outside it (only inside a boundary): an edge to an element above the level pulls
   * toward rank −1, one to an element below it toward `maxRank + 1`.
   */
  function outsidePulls(structure, problem, ranks, maxRank) {
    const pulls = new Map(problem.children.map((id) => [id, []]));
    if (problem.levelId === ROOT) return pulls;
    problem.ports.forEach((port) => {
      const side = portSide(structure, ranks, problem.levelId, port);
      if (side.pulls) pulls.get(port.inside).push(side.above ? -1 : maxRank + 1);
    });
    return pulls;
  }

  /**
   * Sweeps in seed order that move every movable entry to the rank of its feasible interval with the least
   * weighted span to its neighbours and outside pulls, until a sweep moves nothing (at most one sweep per entry).
   */
  function minimiseSpans(structure, problem, rank, pulls) {
    const maxRank = Math.max(0, ...rank.values());
    const sweepOrder = problem.children.slice().sort((a, b) => rank.get(a) - rank.get(b) ||
      (structure.seeding ? seedCross(structure, a) - seedCross(structure, b) : 0) || byViewModel(structure)(a, b));
    for (let sweep = 0; sweep < problem.children.length; sweep++) {
      let moved = false;
      sweepOrder.filter((id) => !problem.isFixed(id)).forEach((id) => {
        const low = problem.predecessors.get(id).reduce((lowest, upper) => Math.max(lowest, rank.get(upper) + 1), problem.lowestRank(id));
        const high = problem.successors.get(id).reduce((highest, lower) => Math.min(highest, rank.get(lower) - 1), maxRank);
        const best = leastSpanRank(rank.get(id), low, high, problem.neighbours.get(id).map((other) => rank.get(other)).concat(pulls.get(id)));
        moved = moved || best !== rank.get(id);
        rank.set(id, best);
      });
      if (!moved) break;
    }
  }

  /** The rank in `[low, high]` with the least total distance to `targets`; ties keep `current`, then the nearest to it. */
  function leastSpanRank(current, low, high, targets) {
    const cost = (candidate) => targets.reduce((sum, target) => sum + Math.abs(candidate - target), 0);
    let best = current;
    for (let candidate = low; candidate <= high; candidate++) {
      const difference = cost(candidate) - cost(best);
      if (difference < 0 || (difference === 0 && Math.abs(candidate - current) < Math.abs(best - current))) best = candidate;
    }
    return best;
  }

  /** Renumbers the used ranks 0, 1, 2, … in order, so no rank of a level is empty. */
  function compactRanks(children, rank) {
    const used = Array.from(new Set(children.map((id) => rank.get(id)))).sort((a, b) => a - b);
    return new Map(children.map((id) => [id, used.indexOf(rank.get(id))]));
  }

  /** Ranks one level into `ranks`, after the levels that enclose it (§4.3 rules 1–3). */
  function rankLevel(structure, levelId, ranks) {
    const problem = rankingProblem(structure, levelId);
    const rank = startRanks(structure, problem);
    const pulls = outsidePulls(structure, problem, ranks, Math.max(0, ...rank.values()));
    minimiseSpans(structure, problem, rank, pulls);
    compactRanks(problem.children, rank).forEach((value, id) => ranks.set(id, value));
  }

  // ---- Lane items (§4.3 rule 4) ---------------------------------------------------------------------------

  /**
   * The chains of one level: for each edge, `{edgeId, points}` with the ranks it passes from its upper end to its
   * lower end, one lane item per intermediate rank. An outside end is a port on rank −1 (above) or `maxRank + 1`
   * (below).
   */
  function chainsOf(structure, levelId, ranks) {
    const relations = relationsOf(structure, levelId);
    const maxRank = levelMaxRank(structure, levelId, ranks);
    const chains = relations.inner.filter((relation) => ranks.get(relation.source) !== ranks.get(relation.target)).map((relation) => {
      const ends = [endAt(relation.source, relation.sourceEnd, ranks), endAt(relation.target, relation.targetEnd, ranks)]
        .sort((a, b) => a.rank - b.rank);
      return chainBetween(structure, levelId, relation, ends[0], ends[1]);
    });
    if (levelId === ROOT) return chains;
    return chains.concat(relations.ports.map((port) => {
      const inside = endAt(port.inside, port.insideEnd, ranks);
      return portSide(structure, ranks, levelId, port).above
        ? chainBetween(structure, levelId, port, { rank: -1, port: true, element: port.outsideEnd }, inside)
        : chainBetween(structure, levelId, port, inside, { rank: maxRank + 1, port: true, element: port.outsideEnd });
    }));
  }

  function endAt(entryId, element, ranks) {
    return { rank: ranks.get(entryId), entry: entryId, element: element };
  }

  function chainBetween(structure, levelId, relation, upper, lower) {
    const points = [upper];
    for (let rank = upper.rank + 1; rank < lower.rank; rank++) {
      const id = 'lane:' + relation.edgeId + ':' + levelId + ':' + rank;
      if (!structure.lanes.has(id)) {
        structure.lanes.set(id, {
          id: id, kind: 'lane', width: CFG.trackPitch, edgeId: relation.edgeId, level: levelId, rank: rank,
          vmIndex: structure.laneBase + relation.edgeIndex,
        });
      }
      points.push({ rank: rank, entry: id, element: id });
    }
    points.push(lower);
    return { edgeId: relation.edgeId, points: points };
  }

  function levelMaxRank(structure, levelId, ranks) {
    return Math.max(0, ...structure.levels.get(levelId).map((id) => ranks.get(id)));
  }

  // ---- Row geometry used by the order search --------------------------------------------------------------

  function widthOf(structure, id) {
    return entryOf(structure, id).width;
  }

  function gapBetween(structure, left, right) {
    return structure.lanes.has(left) || structure.lanes.has(right) ? CFG.laneClearance : CFG.levelGapX;
  }

  function rowWidth(structure, row) {
    return row.reduce((sum, id, index) => sum + widthOf(structure, id) + (index ? gapBetween(structure, row[index - 1], id) : 0), 0);
  }

  /** Centres of a row's entries packed side by side with their gaps, the row starting at `left`. */
  function packedCentres(structure, row, left) {
    const centres = new Map();
    let cursor = left;
    row.forEach((id, index) => {
      if (index) cursor += gapBetween(structure, row[index - 1], id);
      centres.set(id, cursor + widthOf(structure, id) / 2);
      cursor += widthOf(structure, id);
    });
    return centres;
  }

  /** Centres of a row's entries, the row centred on 0 (the level's own frame). */
  function rowCentres(structure, row) {
    return packedCentres(structure, row, -rowWidth(structure, row) / 2);
  }

  /** Block widths, innermost first: the widest row of the block's level plus padding, at least its label wide. */
  function sizeBlocks(structure, rows) {
    structure.levelOrder.slice().reverse().filter((levelId) => levelId !== ROOT).forEach((levelId) => {
      const block = structure.entries.get(levelId);
      const widest = Math.max(0, ...rows.get(levelId).map((row) => rowWidth(structure, row)));
      block.width = Math.max(widest, block.labelWidth) + 2 * CFG.boundaryPad;
    });
  }

  /** Every entry's centre in the outer frame, from the current order of every level. */
  function absoluteCentres(structure, rows) {
    const centres = new Map();
    structure.levelOrder.forEach((levelId) => {
      const origin = levelId === ROOT ? 0 : centres.get(levelId);
      rows.get(levelId).forEach((row) => rowCentres(structure, row).forEach((centre, id) => centres.set(id, origin + centre)));
    });
    return centres;
  }

  // ---- Seed order -----------------------------------------------------------------------------------------

  /** The seed's cross centre of an entry (x in TB terms); a block's from the boxes inside it. */
  function seedCross(structure, id) {
    const boxes = boxesWithin(structure, id).map((item) => structure.seeding.boxes.get(item.id));
    if (!boxes.length) return 0;
    return (Math.min(...boxes.map((box) => box.x)) + Math.max(...boxes.map((box) => box.x + box.width))) / 2;
  }

  /** Cross centres from the seed; without one, rows in view-model order packed from 0. */
  function initialCrosses(structure, rows) {
    return structure.seeding ? seedCrosses(structure) : packedCrosses(structure, rows);
  }

  function seedCrosses(structure) {
    return new Map(Array.from(structure.entries.keys()).map((id) => [id, seedCross(structure, id)]));
  }

  function packedCrosses(structure, rows) {
    const crosses = new Map();
    structure.levelOrder.forEach((levelId) => {
      const left = levelId === ROOT ? 0 : crosses.get(levelId) - widthOf(structure, levelId) / 2 + CFG.boundaryPad;
      rows.get(levelId).forEach((row) => packedCentres(structure, row, left).forEach((centre, id) => crosses.set(id, centre)));
    });
    return crosses;
  }

  /**
   * A lane's starting cross coordinate: where the seed puts it (`laneCrosses`), or else interpolated along its edge
   * between the coordinates of the edge's ends.
   */
  function setLaneCrosses(chains, crosses, laneCrosses) {
    chains.forEach((chain) => {
      const points = chain.points;
      const first = points[0];
      const last = points[points.length - 1];
      const from = crosses.get(first.element);
      const to = crosses.get(last.element);
      points.slice(1, -1).forEach((point) => crosses.set(point.entry, laneCrosses && laneCrosses.has(point.entry)
        ? laneCrosses.get(point.entry) : from + (to - from) * (point.rank - first.rank) / (last.rank - first.rank)));
    });
  }

  // ---- Order (§4.4) ---------------------------------------------------------------------------------------

  /**
   * One level's ordering problem: its rows, the seed position and seed index of every entry, and the segments that
   * join consecutive rows, by upper row (−1 is the row of ports above, `maxRank + 1` the row of ports below). A
   * segment end is `{entry, offset}` (a box, lane, or block) or `{fixed}` (an outside port at its known coordinate).
   * With `memberOffsets`, an end inside a block sits at its member's position in the block; otherwise at the
   * block's centre, so the block counts as one item.
   */
  function orderingProblem(structure, context, levelId, memberOffsets) {
    const centres = absoluteCentres(structure, context.rows);
    const origin = levelId === ROOT ? 0 : centres.get(levelId);
    const seedPositions = new Map();
    const seedIndex = new Map();
    context.seedRows.get(levelId).forEach((row) => {
      rowCentres(structure, row).forEach((centre, id) => seedPositions.set(id, centre));
      row.forEach((id, index) => seedIndex.set(id, index));
    });
    const segments = new Map();
    const portSegments = new Set();
    context.chains.get(levelId).forEach((chain) => chain.points.slice(0, -1).forEach((upper, index) => {
      if (!segments.has(upper.rank)) segments.set(upper.rank, []);
      const segment = [upper, chain.points[index + 1]].map((point) => segmentEnd(point, origin, centres, memberOffsets));
      segments.get(upper.rank).push(segment);
      if (chain.points.some((point) => point.port)) portSegments.add(segment);
    }));
    return {
      rows: context.rows.get(levelId).map((row) => row.slice()), segments: segments, portSegments: portSegments,
      seedPositions: seedPositions, seedIndex: seedIndex,
    };
  }

  function segmentEnd(point, origin, centres, memberOffsets) {
    if (point.port) return { fixed: centres.get(point.element) - origin };
    const inBlock = point.element !== point.entry;
    return { entry: point.entry, offset: inBlock && memberOffsets ? centres.get(point.element) - centres.get(point.entry) : 0 };
  }

  function coordinate(end, positions) {
    return end.fixed !== undefined ? end.fixed : positions.get(end.entry) + end.offset;
  }

  function positionsOf(structure, rows) {
    const positions = new Map();
    rows.forEach((row) => rowCentres(structure, row).forEach((centre, id) => positions.set(id, centre)));
    return positions;
  }

  /** Whether two segments cross: the differences between their ends on the two rows have strictly opposite signs. */
  function inOppositeOrder(first, second) {
    return (first > EPSILON && second < -EPSILON) || (first < -EPSILON && second > EPSILON);
  }

  /** Pairs of segments between two rows whose ends lie in opposite orders (the bilayer inversion count). */
  function crossingsAmong(segments, positions) {
    const ends = segments.map((segment) => [coordinate(segment[0], positions), coordinate(segment[1], positions)]);
    let count = 0;
    for (let first = 0; first < ends.length; first++) {
      for (let second = first + 1; second < ends.length; second++) {
        if (inOppositeOrder(ends[first][0] - ends[second][0], ends[first][1] - ends[second][1])) count++;
      }
    }
    return count;
  }

  /**
   * The partners of every entry in rows `rank − 1` to `rank + 1`: the far end of each segment that touches it,
   * those in the row above first, each group in segment order.
   */
  function partnerEnds(problem, rank) {
    const partners = new Map();
    const add = (end, partner) => {
      if (end.entry === undefined) return;
      if (!partners.has(end.entry)) partners.set(end.entry, []);
      partners.get(end.entry).push(partner);
    };
    for (let upper = rank - 2; upper <= rank + 1; upper++) {
      (problem.segments.get(upper) || []).forEach((segment) => {
        add(segment[1], segment[0]);
        add(segment[0], segment[1]);
      });
    }
    return partners;
  }

  function mean(values) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  /** The mean coordinate of an entry's partners (`partnerEnds`); undefined when it has none. */
  function barycentreOf(partners, id, positions) {
    return partners.has(id) ? mean(partners.get(id).map((end) => coordinate(end, positions))) : undefined;
  }

  /**
   * Scores orders of row `rank` while every other row stays where it is (§4.4), compared lexicographically:
   * crossings next to the row, barycentre displacement of the row and its neighbours, displacement from the seed,
   * then inversions of the seed order. What does not depend on the row's order is gathered once: the row's own
   * entries have all their partners in the fixed rows, so their barycentres are known in advance. `counted`, when
   * given, is the row's crossing count, already known to the caller.
   */
  function rowScorer(structure, problem, rank) {
    const positions = positionsOf(structure, problem.rows);
    const above = problem.segments.get(rank - 1) || [];
    const below = problem.segments.get(rank) || [];
    const partners = partnerEnds(problem, rank);
    const ownBarycentres = new Map(problem.rows[rank].filter((id) => partners.has(id))
      .map((id) => [id, barycentreOf(partners, id, positions)]));
    const neighbours = [rank - 1, rank + 1].filter((near) => near >= 0 && near < problem.rows.length)
      .reduce((all, near) => all.concat(problem.rows[near].filter((id) => partners.has(id))), []);
    return (row, counted) => {
      rowCentres(structure, row).forEach((centre, id) => positions.set(id, centre));
      const crossings = counted === undefined ? crossingsAmong(above, positions) + crossingsAmong(below, positions) : counted;
      let barycentre = 0;
      row.forEach((id) => { if (ownBarycentres.has(id)) barycentre += Math.abs(positions.get(id) - ownBarycentres.get(id)); });
      neighbours.forEach((id) => { barycentre += Math.abs(positions.get(id) - barycentreOf(partners, id, positions)); });
      const stability = row.reduce((sum, id) => sum + Math.abs(positions.get(id) - problem.seedPositions.get(id)), 0);
      return { row: row, score: [crossings, barycentre, stability, seedInversions(problem, row)] };
    };
  }

  /** Pairs of the row's entries that appear in the opposite order in the seed. */
  function seedInversions(problem, row) {
    let count = 0;
    for (let first = 0; first < row.length; first++) {
      for (let second = first + 1; second < row.length; second++) {
        if (problem.seedIndex.get(row[second]) < problem.seedIndex.get(row[first])) count++;
      }
    }
    return count;
  }

  function compareScores(a, b) {
    for (let index = 0; index < a.length; index++) {
      if (Math.abs(a[index] - b[index]) > EPSILON) return a[index] - b[index];
    }
    return 0;
  }

  /** Negative when candidate `a` is better: by score, then by the view-model order of its row. */
  function compareCandidates(structure, a, b) {
    const byScore = compareScores(a.score, b.score);
    if (byScore) return byScore;
    const compare = byViewModel(structure);
    for (let slot = 0; slot < a.row.length; slot++) {
      if (compare(a.row[slot], b.row[slot])) return compare(a.row[slot], b.row[slot]);
    }
    return 0;
  }

  /**
   * The segment ends that move with each entry of row `rank`, by slot, as `{side, fixed, offset}`: `side` is 0 for a
   * segment to the row above and 1 for one to the row below, `fixed` the coordinate of the segment's other end, and
   * `offset` the moving end's distance from the entry's centre.
   */
  function movingEnds(structure, problem, rank) {
    const positions = positionsOf(structure, problem.rows);
    const row = problem.rows[rank];
    const ends = row.map(() => []);
    [problem.segments.get(rank - 1) || [], problem.segments.get(rank) || []].forEach((segments, side) => segments.forEach((segment) => {
      const moving = segment[1 - side];
      ends[row.indexOf(moving.entry)].push({ side: side, fixed: coordinate(segment[side], positions), offset: moving.offset });
    }));
    return ends;
  }

  /** Records an entry's segment ends, the entry centred at `centre`; returns how many recorded segments they cross. */
  function placeEnds(placed, ends, centre) {
    let crossings = 0;
    ends.forEach((end) => {
      const moving = centre + end.offset;
      placed[end.side].forEach((other) => { if (inOppositeOrder(end.fixed - other.fixed, moving - other.moving)) crossings++; });
      placed[end.side].push({ fixed: end.fixed, moving: moving });
    });
    return crossings;
  }

  function unplaceEnds(placed, ends) {
    ends.forEach((end) => placed[end.side].pop());
  }

  /**
   * The crossings between two entries' segments when the first stands left of the second, by slot
   * (`[left][right]`), for entries whose segment ends all sit at their centres; null when either entry has an end
   * off its centre (a member inside a block), because then the order alone does not decide its crossings.
   */
  function crossingsByOrder(ends) {
    const centred = ends.map((entryEnds) => entryEnds.every((end) => end.offset === 0));
    return ends.map((leftEnds, left) => ends.map((rightEnds, right) => {
      if (left === right || !centred[left] || !centred[right]) return null;
      let count = 0;
      leftEnds.forEach((a) => rightEnds.forEach((b) => { if (a.side === b.side && a.fixed - b.fixed > EPSILON) count++; }));
      return count;
    }));
  }

  /**
   * A lower bound on the crossings that the open slots (`open[slot]`, not yet placed) still add: every open entry
   * stands right of every placed one, and two open entries cross at least as often as in the better of their orders.
   */
  function crossingsStillToCome(byOrder, placedSlots, open) {
    let count = 0;
    for (let slot = 0; slot < open.length; slot++) {
      if (!open[slot]) continue;
      placedSlots.forEach((placed) => { if (byOrder[placed][slot] !== null) count += byOrder[placed][slot]; });
      for (let other = slot + 1; other < open.length; other++) {
        if (open[other] && byOrder[slot][other] !== null) count += Math.min(byOrder[slot][other], byOrder[other][slot]);
      }
    }
    return count;
  }

  /**
   * Calls `visit(order, crossings)` with every order of row `rank` whose crossings do not exceed `limit()`. A
   * depth-first search fills the row left to right and drops a prefix as soon as the crossings among its own
   * segments, plus those the open slots must still add, exceed the limit. The entries after a prefix do not move it
   * (only its offset from the row's centre changes, which no crossing depends on).
   */
  function forEachOrderWithin(structure, problem, rank, limit, visit) {
    const row = problem.rows[rank];
    const ends = movingEnds(structure, problem, rank);
    const byOrder = crossingsByOrder(ends);
    const open = row.map(() => true);
    const filled = [];
    const placed = [[], []];
    const fill = (right, crossings) => {
      if (crossings + crossingsStillToCome(byOrder, filled, open) > limit()) return;
      if (filled.length === row.length) {
        visit(filled.map((slot) => row[slot]), crossings);
        return;
      }
      row.forEach((id, slot) => {
        if (!open[slot]) return;
        const left = filled.length ? right + gapBetween(structure, row[filled[filled.length - 1]], id) : 0;
        const added = placeEnds(placed, ends[slot], left + widthOf(structure, id) / 2);
        open[slot] = false;
        filled.push(slot);
        fill(left + widthOf(structure, id), crossings + added);
        filled.pop();
        open[slot] = true;
        unplaceEnds(placed, ends[slot]);
      });
    };
    fill(0, 0);
  }

  /**
   * The best order of row `rank` over all orders of its entries. An order with more crossings than the best so far
   * cannot win (crossings come first in the score), so it is never scored.
   */
  function exhaustiveBest(structure, problem, rank, score) {
    let best = score(problem.rows[rank]);
    forEachOrderWithin(structure, problem, rank, () => best.score[0], (order, crossings) => {
      const candidate = score(order, crossings);
      if (compareCandidates(structure, candidate, best) < 0) best = candidate;
    });
    return best;
  }

  /** For rows too long to search exhaustively: barycentre order, then adjacent swaps while the score drops. */
  function sweptBest(structure, problem, rank, score) {
    const row = problem.rows[rank];
    const positions = positionsOf(structure, problem.rows);
    const partners = partnerEnds(problem, rank);
    const key = (id) => {
      const barycentre = barycentreOf(partners, id, positions);
      return barycentre === undefined ? positions.get(id) : barycentre;
    };
    const sorted = row.slice().sort((a, b) => key(a) - key(b) || row.indexOf(a) - row.indexOf(b));
    const current = score(row);
    const byBarycentre = score(sorted);
    let best = compareCandidates(structure, byBarycentre, current) < 0 ? byBarycentre : current;
    let swapped = adjacentSwapImproving(score, best);
    while (swapped) {
      best = swapped;
      swapped = adjacentSwapImproving(score, best);
    }
    return best;
  }

  /** The first adjacent swap of entries that lowers the score of `best`, or null. */
  function adjacentSwapImproving(score, best) {
    const current = best.row;
    for (let index = 0; index + 1 < current.length; index++) {
      const swapped = current.slice();
      swapped[index] = current[index + 1];
      swapped[index + 1] = current[index];
      const candidate = score(swapped);
      if (compareScores(candidate.score, best.score) < 0) return candidate;
    }
    return null;
  }

  /**
   * Whether a row's best order is found among all orders of its entries. Its result is then the one best order for
   * the rows around it, whatever the row's current order (sweeps start from the current order instead).
   */
  function searchedExhaustively(row) {
    return row.length <= CFG.exhaustiveOrderMax;
  }

  /** Improves row `rank` in place; returns whether its order changed. */
  function improveRow(structure, problem, rank) {
    const row = problem.rows[rank];
    if (row.length < 2) return false;
    const score = rowScorer(structure, problem, rank);
    const best = searchedExhaustively(row)
      ? exhaustiveBest(structure, problem, rank, score)
      : sweptBest(structure, problem, rank, score);
    problem.rows[rank] = best.row;
    return best.row.some((id, index) => id !== row[index]);
  }

  /**
   * Down and up sweeps over a level's rows until a round changes nothing (at most `maxOrderSweeps` rounds). The
   * score of a row reads only the two rows on either side of it, so a row searched exhaustively is searched again
   * only after one of those has changed since its last search; otherwise it would come out the same.
   */
  function orderLevel(structure, problem) {
    const count = problem.rows.length;
    let step = 0;
    const changedAt = problem.rows.map(() => 0);
    const improvedAt = problem.rows.map(() => -1);
    const unchangedAround = (rank) => changedAt.slice(Math.max(0, rank - 2), rank + 3).every((time) => time <= improvedAt[rank]);
    const improve = (rank) => {
      if (searchedExhaustively(problem.rows[rank]) && unchangedAround(rank)) return false;
      improvedAt[rank] = ++step;
      if (!improveRow(structure, problem, rank)) return false;
      changedAt[rank] = step;
      return true;
    };
    for (let round = 0; round < CFG.maxOrderSweeps; round++) {
      let changed = false;
      for (let down = 0; down < count; down++) changed = improve(down) || changed;
      for (let up = count - 1; up >= 0; up--) changed = improve(up) || changed;
      if (!changed) break;
    }
  }

  /** The bilayer crossings of one level's problem: every pair of segments, between every two consecutive rows. */
  function levelCrossings(structure, problem) {
    const positions = positionsOf(structure, problem.rows);
    return Array.from(problem.segments.values()).reduce((total, segments) => total + crossingsAmong(segments, positions), 0);
  }

  /**
   * The level's crossings that involve an edge with both ends in the level. Two edges that both leave the level
   * cross here only by the bilayer count, which puts their outside ends at the ports' centres: the router can still
   * order them where they leave, so a move that only trades such crossings settles nothing.
   */
  function innerCrossings(structure, problem) {
    const positions = positionsOf(structure, problem.rows);
    return Array.from(problem.segments.values()).reduce((total, segments) => {
      const inner = segments.filter((segment) => !problem.portSegments.has(segment));
      const leaving = segments.filter((segment) => problem.portSegments.has(segment));
      return total + crossingsAmong(inner, positions)
        + inner.reduce((sum, segment) => sum + crossingsAmong([segment].concat(leaving), positions) - crossingsAmong(leaving, positions), 0);
    }, 0);
  }

  /**
   * Moves whole lane chains after the row sweeps (§4.3 rule 4, §4.4). A row search moves one entry while the rows
   * beside it stay fixed, so the lane items of one long edge, which must move together, stay where the seed put
   * them even when the edge has a crossing-free place at the other end of every row it passes (a person's edge that
   * runs past a box and out of the boundary, final review I3). Each chain of an edge that leaves the level (its
   * outer end is a port) with two or more lane items here is tried at the start and at the end of all its rows at
   * once, and kept at the first of those that removes a crossing with an edge inside the level (`innerCrossings`)
   * and leaves the level with no crossings at all. The bilayer count only estimates the routed drawing (routing
   * redesign §9.3, Ruling 21): on the generated landscapes, moves that merely lower it gave routes no better, and
   * some worse, while a level without crossings gives the router an order it can draw without any.
   * Returns whether a chain moved.
   */
  function moveLaneChains(structure, problem, chains) {
    let moved = false;
    chains.filter((chain) => chain.points.some((point) => point.port)).forEach((chain) => {
      const lanes = chain.points.filter((point) => structure.lanes.has(point.entry));
      if (lanes.length < 2) return;
      const innerBefore = innerCrossings(structure, problem);
      if (innerBefore === 0) return;
      const saved = lanes.map((point) => problem.rows[point.rank].slice());
      const placeAt = (atStart) => lanes.forEach((point) => {
        const row = problem.rows[point.rank].filter((id) => id !== point.entry);
        problem.rows[point.rank] = atStart ? [point.entry].concat(row) : row.concat([point.entry]);
      });
      const restore = () => lanes.forEach((point, index) => { problem.rows[point.rank] = saved[index].slice(); });
      const better = [true, false].some((atStart) => {
        placeAt(atStart);
        if (levelCrossings(structure, problem) === 0) return true;
        restore();
        return false;
      });
      moved = moved || better;
    });
    return moved;
  }

  // ---- Entry point ----------------------------------------------------------------------------------------

  /** Each level's rows of entries (boxes and blocks) by rank, in view-model order. */
  function boxRowsOf(structure, ranks) {
    return new Map(structure.levelOrder.map((levelId) => {
      const rows = Array.from({ length: levelMaxRank(structure, levelId, ranks) + 1 }, () => []);
      childrenOf(structure, levelId).forEach((id) => rows[ranks.get(id)].push(id));
      return [levelId, rows];
    }));
  }

  /** The starting rows (boxes, blocks, and lanes, each row sorted by its starting cross coordinate). */
  function startRows(structure, ranks, chains) {
    const boxRows = boxRowsOf(structure, ranks);
    const rows = new Map(Array.from(boxRows, (pair) => [pair[0], pair[1].map((row) => row.slice())]));
    structure.lanes.forEach((lane) => rows.get(lane.level)[lane.rank].push(lane.id));
    sizeBlocks(structure, rows);
    const crosses = initialCrosses(structure, boxRows);
    chains.forEach((levelChains) => setLaneCrosses(levelChains, crosses, structure.seeding && structure.seeding.laneCrosses));
    const bySeed = (a, b) => crosses.get(a) - crosses.get(b) || byViewModel(structure)(a, b);
    return new Map(Array.from(rows, (pair) => [pair[0], pair[1].map((row) => row.slice().sort(bySeed))]));
  }

  /**
   * Orders every level: the outer levels first with blocks as single items, then each inner level with its outside
   * partners as fixed ports, then the levels holding blocks again with their members at their solved positions.
   */
  function orderLevels(structure, context) {
    const holdsBlocks = (levelId) => structure.levels.get(levelId).some((id) => structure.entries.get(id).kind === 'block');
    const passes = structure.levelOrder.map((levelId) => [levelId, false])
      .concat(structure.levelOrder.filter(holdsBlocks).map((levelId) => [levelId, true]));
    passes.forEach((pass) => {
      const problem = orderingProblem(structure, context, pass[0], pass[1]);
      orderLevel(structure, problem);
      if (moveLaneChains(structure, problem, context.chains.get(pass[0]))) orderLevel(structure, problem);
      context.rows.set(pass[0], problem.rows);
    });
  }

  /** Bilayer crossings of the final order, each counted once: in the level where both segments run. */
  function layerCrossingsOf(structure, context) {
    return structure.levelOrder.reduce((sum, levelId) => sum + levelCrossings(structure, orderingProblem(structure, context, levelId, false)), 0);
  }

  function objectOf(map) {
    const object = {};
    map.forEach((value, key) => { object[key] = value; });
    return object;
  }

  /**
   * Ranks and orders a graph given in the flow frame, and keeps the working data placement goes on from: the
   * structure, ranks, chains, and final rows of every level, from `seeding` (`seedingOf`, or null).
   */
  function orderInFrame(graph, seeding) {
    const structure = structureOf(graph, seeding);
    const ranks = new Map();
    structure.levelOrder.forEach((levelId) => rankLevel(structure, levelId, ranks));
    const chains = new Map(structure.levelOrder.map((levelId) => [levelId, chainsOf(structure, levelId, ranks)]));
    const rows = startRows(structure, ranks, chains);
    const context = { rows: rows, seedRows: new Map(Array.from(rows, (pair) => [pair[0], pair[1].map((row) => row.slice())])), chains: chains };
    orderLevels(structure, context);
    return { structure: structure, ranks: ranks, chains: chains, rows: context.rows, layerCrossings: layerCrossingsOf(structure, context) };
  }

  function sizesOf(graph) {
    return new Map(graph.items.map((item) => [item.id, { width: item.width, height: item.height }]));
  }

  /**
   * Ranks every level and orders every rank (routing redesign §4.2–§4.4).
   * `graph` as in §3.2; `options.seed` (TB-frame top-left corners, or null) supplies the starting ranks and orders.
   * Pins take no part (§4.4). Returns `{ranks: {id: rank}, order: {levelId: [[id, …] per rank]}, lanes: [{id,
   * edgeId, level, rank}], stats: {layerCrossings}}`; lane ids are `lane:<edgeId>:<levelId>:<rank>`.
   */
  function rankAndOrder(graph, options) {
    const settings = Object.assign({ seed: null }, options);
    const ordered = orderInFrame(graph, seedingOf(graph, settings.seed, sizesOf(graph)));
    return {
      ranks: objectOf(ordered.ranks),
      order: objectOf(ordered.rows),
      lanes: Array.from(ordered.structure.lanes.values(), (lane) => ({ id: lane.id, edgeId: lane.edgeId, level: lane.level, rank: lane.rank })),
      stats: { layerCrossings: ordered.layerCrossings },
    };
  }

  return {
    ROOT: ROOT, compareScores: compareScores, entryOf: entryOf, itemAt: itemAt, levelsAround: levelsAround,
    widthOf: widthOf, gapBetween: gapBetween, seedingOf: seedingOf, sizesOf: sizesOf,
    objectOf: objectOf, orderInFrame: orderInFrame, rankAndOrder: rankAndOrder,
  };
});
