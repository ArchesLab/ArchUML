(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./c4-place-frame.js'), require('./c4-place-ranks.js'), require('./c4-place-corridors.js'));
  } else {
    var parts = root.ArchUMLC4PlaceParts = root.ArchUMLC4PlaceParts || {};
    parts.settle = factory(parts.frame, parts.ranks, parts.corridors);
  }
})(typeof self !== 'undefined' ? self : this, function (frameModule, ranksModule, corridorsModule) {
  'use strict';

  // The final boxes of a placement (routing redesign §4.7, §5.0) in real coordinates: the boxes and boundaries from
  // their frame positions, pins applied and overlapping siblings settled, and what is measured from those boxes:
  // the corridors and the edges a straight line can join.

  const { CFG, rectInFrame, rectInReal, frameRanges, frameAround, interiorOf } = frameModule;
  const { ROOT } = ranksModule;
  const { rankCorridorId } = corridorsModule;

  // ---- Real layout ------------------------------------------------------------------------------------------------

  /** The frame rectangles of every box and block from their cross and main positions, in real coordinates. */
  function realLayout(ordered, graph, cross, stacked, axes) {
    const layout = { nodes: {}, boundaries: {} };
    graph.items.forEach((item) => {
      const frameItem = ordered.structure.entries.get(item.id);
      layout.nodes[item.id] = rectInReal({
        cross: cross.left.get(item.id), main: stacked.main.get(item.id), crossSize: frameItem.width,
        mainSize: ordered.structure.graph.items.find((candidate) => candidate.id === item.id).height,
      }, axes);
    });
    graph.boundaries.forEach((boundary) => {
      layout.boundaries[boundary.id] = rectInReal({
        cross: cross.left.get(boundary.id), main: stacked.main.get(boundary.id),
        crossSize: cross.right.get(boundary.id) - cross.left.get(boundary.id), mainSize: stacked.sizes.get(boundary.id),
      }, axes);
    });
    return layout;
  }

  // ---- Pins and settling (§4.7; spec §6.4 step 5) ----------------------------------------------------------------

  /** Items first, then boundaries, each in graph order: the ids directly inside `levelId` (null: the outer level). */
  function graphChildren(graph, levelId) {
    return graph.items.map((item) => item.id).concat(graph.boundaries.map((boundary) => boundary.id))
      .filter((id) => parentIn(graph, id) === levelId);
  }

  function parentIn(graph, id) {
    const item = graph.items.find((candidate) => candidate.id === id) || graph.boundaries.find((candidate) => candidate.id === id);
    return item.parent === undefined ? null : item.parent;
  }

  function boxIn(layout, id) {
    return layout.nodes[id] || layout.boundaries[id];
  }

  function descendantsAndSelf(graph, id) {
    return [id].concat(graphChildren(graph, id).reduce((all, child) => all.concat(descendantsAndSelf(graph, child)), []));
  }

  /** Moves `id` and everything inside it by `distance` along y (down when positive). */
  function moveVertically(graph, layout, id, distance) {
    descendantsAndSelf(graph, id).forEach((member) => { boxIn(layout, member).y += distance; });
  }

  /** How far `lower` must move down to keep the box clearance below `upper`; 0 when the two are clear. */
  function overlapBelow(upper, lower) {
    const clearance = CFG.boxClearance;
    const isApart = upper.x + upper.width + clearance <= lower.x || lower.x + lower.width + clearance <= upper.x ||
      upper.y + upper.height + clearance <= lower.y || lower.y + lower.height + clearance <= upper.y;
    return isApart ? 0 : upper.y + upper.height + clearance - lower.y;
  }

  /**
   * Separates overlapping siblings until none overlap. A sibling in `holding` keeps its place (spec §9.2: a drop
   * lands where it is dropped): the other of an overlapping pair makes room, moving up when its top is the higher
   * one and down otherwise, and then holds its new place too, so whatever it pushes makes room for it in turn. When
   * both of a pair hold their place, or neither does, the lower moves down. `holding` is updated in place.
   */
  function separateSiblings(graph, layout, ids, holding) {
    const order = (a, b) => boxIn(layout, a).y - boxIn(layout, b).y || ids.indexOf(a) - ids.indexOf(b);
    for (let moved = true; moved;) {
      moved = false;
      const sorted = ids.slice().sort(order);
      for (let upper = 0; upper < sorted.length && !moved; upper++) {
        for (let lower = upper + 1; lower < sorted.length && !moved; lower++) {
          const [above, below] = [sorted[upper], sorted[lower]];
          const distance = overlapBelow(boxIn(layout, above), boxIn(layout, below));
          if (distance > 0) {
            makeRoom(graph, layout, above, below, distance, holding);
            moved = true;
          }
        }
      }
    }
  }

  /** Separates `above` and `below` (overlapping by `distance`): see separateSiblings. */
  function makeRoom(graph, layout, above, below, distance, holding) {
    if (holding.has(below) && !holding.has(above)) {
      moveVertically(graph, layout, above, -distance);
      holding.add(above);
      return;
    }
    moveVertically(graph, layout, below, distance);
    if (holding.has(above)) holding.add(below);
  }

  /**
   * Separates overlapping siblings at each level, inside out, and grows every boundary from its placed box to hold
   * its children: a boundary never loses the room placement gave it (side-end padding, its minimum width). At each
   * level the siblings that hold a pinned box (the box itself, or a boundary around it) keep their place.
   */
  function settleLevel(graph, layout, levelId, pinnedIds) {
    const children = graphChildren(graph, levelId);
    children.filter((id) => layout.boundaries[id]).forEach((id) => settleLevel(graph, layout, id, pinnedIds));
    const holding = new Set(children.filter((id) => descendantsAndSelf(graph, id).some((member) => pinnedIds.has(member))));
    separateSiblings(graph, layout, children, holding);
    if (levelId !== null && children.length) {
      const boundary = graph.boundaries.find((candidate) => candidate.id === levelId);
      layout.boundaries[levelId] = frameAround(boundary, children.map((id) => boxIn(layout, id)).concat([interiorOf(boundary, layout.boundaries[levelId])]));
    }
  }

  /**
   * Puts each pinned box's top-left corner on its pin, settles the levels (the boxes a pin overlaps make room for it),
   * and marks the boxes the settle step moved: `pinAdjusted` on a pinned box that had to leave its pin (only where two
   * pinned boxes overlap), `madeRoom` on an unpinned box that moved off the place the placement gave it.
   */
  function applyPins(graph, layout, pins) {
    const pinned = graph.items.filter((item) => pins && pins.has(item.id));
    pinned.forEach((item) => {
      const pin = pins.get(item.id);
      layout.nodes[item.id].x = pin[0];
      layout.nodes[item.id].y = pin[1];
    });
    const placedAt = new Map(graph.items.map((item) => [item.id, layout.nodes[item.id].y]));
    if (pinned.length) settleLevel(graph, layout, null, new Set(pinned.map((item) => item.id)));
    graph.items.forEach((item) => {
      const box = layout.nodes[item.id];
      const pin = pins && pins.get(item.id);
      box.pinAdjusted = Boolean(pin) && (box.x !== pin[0] || box.y !== pin[1]);
      box.madeRoom = !pin && box.y !== placedAt.get(item.id);
    });
  }

  /**
   * The corridors measured from the final boxes (§4.7). Pins and the settle step can move boxes and grow boundaries
   * after the ranks were stacked (`planned`), so a rank corridor runs from the far end of its rank's boxes to the
   * near end of the next rank's (or of its boundary), and a gap corridor from the box before it to the box after it,
   * in the flow frame. A corridor that a moved box closed keeps no extent (`to` equals `from`). A rank with no box
   * (only lane channels) keeps its stacked end. Without pins, and with pins where the boxes already were, these are
   * the planned corridors.
   */
  function settledCorridors(ordered, layout, axes, planned) {
    const extentOf = (id) => frameRanges(boxIn(layout, id), axes);
    const rankEnds = new Map();
    ordered.structure.levelOrder.forEach((levelId) => {
      const rows = ordered.rows.get(levelId).map((row) => row.filter((id) => !ordered.structure.lanes.has(id)).map((id) => extentOf(id).main));
      const boundary = levelId === ROOT ? null : extentOf(levelId).main;
      const rowEnd = (rank) => (rows[rank].length ? Math.max(...rows[rank].map((main) => main[1])) : null);
      const rowStart = (rank) => (rows[rank].length ? Math.min(...rows[rank].map((main) => main[0])) : null);
      for (let rank = -1; rank < rows.length; rank++) {
        rankEnds.set(rankCorridorId(levelId, rank), {
          from: rank === -1 ? boundary && boundary[0] : rowEnd(rank),
          to: rank === rows.length - 1 ? boundary && boundary[1] : rowStart(rank + 1),
        });
      }
    });
    return planned.map((corridor) => {
      const ends = corridor.kind === 'gap'
        ? { from: extentOf(corridor.between[0]).cross[1], to: extentOf(corridor.between[1]).cross[0] }
        : rankEnds.get(corridor.id);
      const from = ends.from === null ? corridor.from : ends.from;
      const to = ends.to === null ? corridor.to : ends.to;
      return Object.assign({}, corridor, { from: from, to: Math.max(from, to) });
    });
  }

  /**
   * The ids of the corridors whose growth would move a pinned box (routing redesign §6.4): every corridor that a
   * pinned box starts at or after, along the corridor's own axis of the flow frame. The renderer never grows them.
   */
  function pinnedCorridorIds(corridors, layout, axes, pins) {
    const starts = Array.from(pins.keys()).filter((id) => layout.nodes[id]).map((id) => rectInFrame(layout.nodes[id], axes));
    return corridors.filter((corridor) => starts.some((start) => start[corridor.axis] >= corridor.from)).map((corridor) => corridor.id);
  }

  // ---- Straight-capable edges (§5.0) --------------------------------------------------------------------------------

  function openOverlap(a, b) {
    return a[0] < b[1] && b[0] < a[1];
  }

  /**
   * Whether two final boxes can be joined by a straight line (§5.0): they overlap by at least
   * 2 · cornerMargin + slotPitch on the axis they face each other across, and some line of their straight band
   * between the facing sides stays clear of other boxes, foreign boundaries, and the bands along the lines of the
   * boundaries it passes. Boundary labels never block it: the renderer moves a label clear of the edges that cross
   * its label line.
   */
  function straightCapable(graph, layout, axes, edge) {
    const s = frameRanges(boxIn(layout, edge.source), axes);
    const t = frameRanges(boxIn(layout, edge.target), axes);
    const sameRank = openOverlap(s.main, t.main);
    const across = sameRank ? 'cross' : 'main';
    const along = sameRank ? 'main' : 'cross';
    const [first, second] = s[across][0] <= t[across][0] ? [s, t] : [t, s];
    const between = [first[across][1], second[across][0]];
    const lo = Math.max(s[along][0], t[along][0]);
    const hi = Math.min(s[along][1], t[along][1]);
    if (hi - lo < 2 * CFG.cornerMargin + CFG.slotPitch) return false;
    const blocked = [];
    const blockIf = (ranges, pad) => { if (openOverlap(ranges[across], between)) blocked.push([ranges[along][0] - pad, ranges[along][1] + pad]); };
    graph.items.filter((item) => item.id !== edge.source && item.id !== edge.target)
      .forEach((item) => blockIf(frameRanges(layout.nodes[item.id], axes), CFG.boxClearance));
    graph.boundaries.forEach((boundary) => {
      const box = layout.boundaries[boundary.id];
      const ranges = frameRanges(box, axes);
      const holds = isGraphAncestor(graph, boundary.id, edge.source) || isGraphAncestor(graph, boundary.id, edge.target);
      if (!holds) return blockIf(ranges, CFG.boundaryBand);
      const run = Math.min(ranges[across][1], between[1]) - Math.max(ranges[across][0], between[0]);
      if (run > 2) ranges[along].forEach((line) => blocked.push([line - CFG.boundaryBand, line + CFG.boundaryBand]));
      return undefined;
    });
    return clearPart([lo + CFG.cornerMargin, hi - CFG.cornerMargin], blocked);
  }

  function isGraphAncestor(graph, boundaryId, id) {
    for (let current = parentIn(graph, id); current !== null; current = parentIn(graph, current)) {
      if (current === boundaryId) return true;
    }
    return false;
  }

  /** Whether some point of the closed range `[lo, hi]` lies outside every open interval of `blocked`. */
  function clearPart(range, blocked) {
    let free = [range];
    blocked.forEach((cut) => {
      free = free.flatMap((part) => {
        if (cut[1] <= part[0] || cut[0] >= part[1]) return [part];
        return [[part[0], cut[0]], [cut[1], part[1]]].filter((piece) => piece[0] <= piece[1] && piece[0] >= part[0] && piece[1] <= part[1]);
      });
    });
    return free.length > 0;
  }

  return {
    realLayout: realLayout, applyPins: applyPins, settledCorridors: settledCorridors,
    pinnedCorridorIds: pinnedCorridorIds, straightCapable: straightCapable,
  };
});
