(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./c4-place-frame.js'), require('./c4-place-ranks.js'));
  } else {
    var parts = root.ArchUMLC4PlaceParts = root.ArchUMLC4PlaceParts || {};
    parts.corridors = factory(parts.frame, parts.ranks);
  }
})(typeof self !== 'undefined' ? self : this, function (frameModule, ranksModule) {
  'use strict';

  // The corridors of a placement (routing redesign §3.2, §4.6): the band between two ranks of a level (a rank
  // corridor) and the gap between two neighbours of a rank (a gap corridor). Planned segments and their labels are
  // assigned to rank corridors, every corridor is budgeted the room its labels and jogs need, and the ranks are
  // stacked along the flow by those budgets.

  const { CFG, frameExtents } = frameModule;
  const { ROOT, compareScores, entryOf, itemAt, levelsAround } = ranksModule;

  // ---- Corridor ids (§3.2) --------------------------------------------------------------------------------------

  function gapCorridorId(levelId, rank, before, after) {
    return levelId + '|cross|' + rank + '|' + before + '|' + after;
  }

  function rankCorridorId(levelId, rank) {
    return levelId + '|main|' + rank;
  }

  // ---- Planned segments and their labels (§4.5, §4.6) -----------------------------------------------------------

  /** The rank corridor an edge's label is planned in: next to its target, in their lowest common level; or null. */
  function labelCorridorOf(ordered, edge) {
    const theirs = levelsAround(ordered.structure, edge.target);
    const common = levelsAround(ordered.structure, edge.source).find((level) => theirs.indexOf(level) >= 0);
    const source = ordered.ranks.get(itemAt(ordered.structure, edge.source, common));
    const target = ordered.ranks.get(itemAt(ordered.structure, edge.target, common));
    if (source === target) return null;
    return rankCorridorId(common, source < target ? target - 1 : target);
  }

  /**
   * The rank corridors an edge's straight segment crosses, with where it passes each one: the two rows on either
   * side and the positions in them of the entries (ends, blocks, or lane items) it joins.
   */
  function corridorsCrossed(ordered, edgeId) {
    const crossed = [];
    ordered.structure.levelOrder.forEach((levelId) => {
      const rows = ordered.rows.get(levelId);
      ordered.chains.get(levelId).filter((chain) => chain.edgeId === edgeId).forEach((chain) => chain.points.slice(1).forEach((lower, index) => {
        const upper = chain.points[index];
        if (upper.rank < 0 || lower.rank >= rows.length) return;
        const sides = [{ row: rows[upper.rank], at: rows[upper.rank].indexOf(upper.entry) }, { row: rows[lower.rank], at: rows[lower.rank].indexOf(lower.entry) }];
        crossed.push({ corridorId: rankCorridorId(levelId, upper.rank), sides: sides, key: sides.map((side) => side.at) });
      }));
    });
    return crossed;
  }

  /**
   * The planned segments in each rank corridor, sorted across it, each with the label position it plans there:
   * the outermost face outward, a lone one faces after, the others sit on their segment (§4.5 label clearance).
   * `segments` are `{edgeIndex, variable}`.
   */
  function corridorPlans(ordered, graph, segments) {
    const plans = new Map();
    segments.forEach((segment) => {
      const edge = graph.edges[segment.edgeIndex];
      const labelled = edge.labelCross > 0;
      corridorsCrossed(ordered, edge.id).forEach((crossing) => {
        if (!plans.has(crossing.corridorId)) plans.set(crossing.corridorId, []);
        plans.get(crossing.corridorId).push({
          edgeIndex: segment.edgeIndex, edgeId: edge.id, variable: segment.variable, key: crossing.key.concat(segment.edgeIndex),
          sides: crossing.sides, label: labelled && labelCorridorOf(ordered, edge) === crossing.corridorId ? edge.labelCross : 0,
        });
      });
    });
    plans.forEach((list) => {
      list.sort((x, y) => compareScores(x.key, y.key));
      list.forEach((entry, index) => {
        if (!entry.label) return;
        entry.position = list.length === 1 || index === list.length - 1 ? 'after' : (index === 0 ? 'before' : 'on');
      });
    });
    return plans;
  }

  // ---- Label slots and corridors (§4.6) ---------------------------------------------------------------------------

  /** Planned label slots (cross part) of every labelled edge that crosses a rank corridor. */
  function plannedSlots(ordered, graph, solved, cross) {
    const slots = new Map();
    const plans = corridorPlans(ordered, graph, solved.accepted.map((entry) => ({ edgeIndex: entry.request.edgeIndex, variable: entry.variable })));
    const segmentAt = new Map(solved.accepted.map((entry) => [entry.request.edgeIndex, entry.variable]));
    plans.forEach((list, corridorId) => list.filter((entry) => entry.label).forEach((entry) => {
      slots.set(entry.edgeIndex, { corridorId: corridorId, position: entry.position, cross: cross.at(segmentAt.get(entry.edgeIndex)), straight: true });
    }));
    const bent = new Map();
    graph.edges.forEach((edge, index) => {
      const corridorId = labelCorridorOf(ordered, edge);
      if (!corridorId || segmentAt.has(index) || edge.source === edge.target) return;
      const key = corridorId + '\u0000' + edge.target;
      if (!bent.has(key)) bent.set(key, []);
      bent.get(key).push(index);
    });
    bent.forEach((indices) => {
      const centreOf = (id) => (cross.left.get(id) + cross.right.get(id)) / 2;
      indices.sort((x, y) => centreOf(graph.edges[x].source) - centreOf(graph.edges[y].source) || x - y);
      indices.forEach((index, at) => {
        const edge = graph.edges[index];
        const target = cross.left.get(edge.target);
        const width = cross.right.get(edge.target) - target;
        slots.set(index, {
          corridorId: labelCorridorOf(ordered, edge), position: at < (indices.length - 1) / 2 ? 'before' : 'after',
          cross: target + Math.floor(width * (at + 1) / (indices.length + 1)), straight: false,
          from: centreOf(edge.source),
        });
      });
    });
    return slots;
  }

  /** The cross interval a planned label takes. */
  function labelInterval(slot, size) {
    if (slot.position === 'on') return [slot.cross - Math.ceil(size / 2), slot.cross + Math.ceil(size / 2)];
    return slot.position === 'before' ? [slot.cross - CFG.labelBesideGap - size, slot.cross - CFG.labelBesideGap]
      : [slot.cross + CFG.labelBesideGap, slot.cross + CFG.labelBesideGap + size];
  }

  /** Greedy interval colouring (sorted by start, then edge order): the levels `[{height, members}]` of the intervals. */
  function colourIntervals(intervals, gap) {
    const levels = [];
    intervals.slice().sort((a, b) => a.range[0] - b.range[0] || a.order - b.order).forEach((interval) => {
      let level = levels.find((candidate) => candidate.end + gap <= interval.range[0]);
      if (!level) {
        level = { end: -Infinity, height: 0, members: [] };
        levels.push(level);
      }
      level.end = Math.max(level.end, interval.range[1]);
      level.height = Math.max(level.height, interval.height);
      level.members.push(interval.order);
    });
    return levels;
  }

  /**
   * The label levels and jog tracks of every rank corridor: labels packed along the cross axis, and one track per
   * group of overlapping jogs of the edges planned without a straight segment.
   */
  function corridorContents(graph, slots) {
    const contents = new Map();
    const of = (corridorId) => {
      if (!contents.has(corridorId)) contents.set(corridorId, { labels: [], jogs: [] });
      return contents.get(corridorId);
    };
    slots.forEach((slot, index) => {
      const edge = graph.edges[index];
      if (edge.labelCross > 0) of(slot.corridorId).labels.push({ range: labelInterval(slot, edge.labelCross), height: edge.labelMain, order: index });
      if (!slot.straight) of(slot.corridorId).jogs.push({ range: [Math.min(slot.from, slot.cross), Math.max(slot.from, slot.cross)], height: 0, order: index });
    });
    contents.forEach((content) => {
      content.levels = colourIntervals(content.labels, CFG.labelBoxClear);
      content.tracks = colourIntervals(content.jogs, 0).length;
    });
    return contents;
  }

  // ---- Main positions (§4.6, §4.7) ----------------------------------------------------------------------------------

  function mainSizeOf(ordered, sizes, id) {
    const entry = entryOf(ordered.structure, id);
    if (entry.kind === 'lane') return 0;
    return entry.kind === 'block' ? sizes.get(id) : ordered.structure.graph.items.find((item) => item.id === id).height;
  }

  /** The main extent of the rank corridor between ranks `rank` and `rank + 1` of a level. */
  function corridorExtent(ordered, contents, extra, levelId, rank) {
    const content = contents.get(rankCorridorId(levelId, rank)) || { levels: [], tracks: 0 };
    const labels = content.levels.reduce((sum, level) => sum + level.height + CFG.labelBoxClear, 0);
    const rows = ordered.rows.get(levelId);
    const touchesBoundary = (row) => row.some((id) => entryOf(ordered.structure, id).kind === 'block');
    return Math.max(CFG.levelGapY, labels + content.tracks * CFG.trackPitch + CFG.tailStub + CFG.headStub) +
      CFG.boundaryBand * (Number(touchesBoundary(rows[rank])) + Number(touchesBoundary(rows[rank + 1]))) +
      (extra.get(rankCorridorId(levelId, rank)) || 0);
  }

  /**
   * Stacks every level's ranks along the flow (§4.7): block extents inside out, then positions from the outside in.
   * Returns `{main: Map entry → main start, sizes: Map block → main extent, corridors}`.
   */
  function stackRanks(ordered, contents, extra, cross, direction) {
    const structure = ordered.structure;
    const sizes = new Map();
    const layout = new Map();
    structure.levelOrder.slice().reverse().forEach((levelId) => {
      const rows = ordered.rows.get(levelId);
      const heights = rows.map((row) => Math.max(0, ...row.map((id) => mainSizeOf(ordered, sizes, id))));
      const corridors = rows.slice(0, -1).map((row, rank) => corridorExtent(ordered, contents, extra, levelId, rank));
      const inner = heights.reduce((sum, height) => sum + height, 0) + corridors.reduce((sum, extent) => sum + extent, 0);
      layout.set(levelId, { heights: heights, corridors: corridors, inner: inner });
      if (levelId === ROOT) return;
      const boundary = structure.graph.boundaries.find((candidate) => candidate.id === levelId);
      const frame = frameExtents({ main: inner, cross: cross.right.get(levelId) - cross.left.get(levelId) }, boundary.labelWidth, boundary.labelHeight, direction);
      const before = frame.mainBefore + (extra.get(rankCorridorId(levelId, -1)) || 0);
      const after = frame.mainAfter + (extra.get(rankCorridorId(levelId, rows.length - 1)) || 0);
      Object.assign(layout.get(levelId), { before: before, after: after });
      sizes.set(levelId, before + inner + after);
    });
    const main = new Map([[ROOT, 0]]);
    const corridors = [];
    structure.levelOrder.forEach((levelId) => {
      const level = layout.get(levelId);
      const start = levelId === ROOT ? 0 : main.get(levelId);
      let top = start + (level.before || 0);
      if (levelId !== ROOT) corridors.push(rankCorridor(levelId, -1, start, top));
      ordered.rows.get(levelId).forEach((row, rank) => {
        row.forEach((id) => main.set(id, top));
        const bottom = top + level.heights[rank];
        if (rank < level.corridors.length) {
          corridors.push(rankCorridor(levelId, rank, bottom, bottom + level.corridors[rank]));
          top = bottom + level.corridors[rank];
        } else if (levelId !== ROOT) {
          corridors.push(rankCorridor(levelId, rank, bottom, start + sizes.get(levelId)));
        }
      });
    });
    return { main: main, sizes: sizes, corridors: corridors };
  }

  function rankCorridor(levelId, rank, from, to) {
    return { id: rankCorridorId(levelId, rank), kind: 'rank', level: levelId, axis: 'main', from: from, to: to, between: null };
  }

  /** The gap corridors: between consecutive boxes and blocks of every rank, across the flow. */
  function gapCorridors(ordered, cross) {
    const corridors = [];
    ordered.structure.levelOrder.forEach((levelId) => ordered.rows.get(levelId).forEach((row, rank) => {
      const entries = row.filter((id) => !ordered.structure.lanes.has(id));
      entries.slice(1).forEach((id, index) => corridors.push({
        id: gapCorridorId(levelId, rank, entries[index], id), kind: 'gap', level: levelId, axis: 'cross',
        from: cross.right.get(entries[index]), to: cross.left.get(id), between: [entries[index], id],
      }));
    }));
    return corridors;
  }

  /** The main coordinate of each planned label: its level's start in its corridor, after the tail stub. */
  function slotMains(contents, corridors) {
    const mains = new Map();
    contents.forEach((content, corridorId) => {
      const corridor = corridors.find((candidate) => candidate.id === corridorId);
      let at = corridor.from + CFG.tailStub;
      content.levels.forEach((level) => {
        level.members.forEach((index) => mains.set(index, at));
        at += level.height + CFG.labelBoxClear;
      });
    });
    return mains;
  }

  return {
    gapCorridorId: gapCorridorId, rankCorridorId: rankCorridorId, corridorPlans: corridorPlans,
    plannedSlots: plannedSlots, corridorContents: corridorContents, stackRanks: stackRanks, gapCorridors: gapCorridors,
    slotMains: slotMains,
  };
});
