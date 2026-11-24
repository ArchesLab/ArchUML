(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./c4-place-frame.js'), require('./c4-place-ranks.js'), require('./c4-place-corridors.js'),
      require('./c4-place-cross.js'), require('./c4-place-settle.js'));
  } else {
    var parts = root.ArchUMLC4PlaceParts || {};
    root.ArchUMLC4Place = factory(parts.frame, parts.ranks, parts.corridors, parts.cross, parts.settle);
  }
})(typeof self !== 'undefined' ? self : this, function (frameModule, ranksModule, corridorsModule, crossModule, settleModule) {
  'use strict';

  // Placement of C4 views (routing redesign §4, docs/superpowers/specs/2026-11-09-c4-routing-redesign.md), published as
  // `ArchUMLC4Place`. Pure and DOM-free, with no dependency outside its parts, which load before it: the frame and the
  // constants (c4-place-frame.js), ranks and order (c4-place-ranks.js), corridors and label slots
  // (c4-place-corridors.js), coordinates across the flow (c4-place-cross.js), and the final boxes
  // (c4-place-settle.js). This file runs a placement through them.

  const { CFG, frameAxes, frameExtents, roundedGraph, graphInFrame, frameAround } = frameModule;
  const { seedingOf, sizesOf, objectOf, orderInFrame, rankAndOrder } = ranksModule;
  const { plannedSlots, corridorContents, stackRanks, gapCorridors, slotMains } = corridorsModule;
  const { placeAcross } = crossModule;
  const { realLayout, applyPins, settledCorridors, pinnedCorridorIds, straightCapable } = settleModule;

  /**
   * The placement in the flow frame (§4.3–§4.6): ranks and order from the seed (`seedingOf`, or null), cross
   * positions with straight edges first, planned label slots, and stacked ranks.
   */
  function placeInFrame(frameGraph, seeding, direction, extra) {
    const ordered = orderInFrame(frameGraph, seeding);
    const across = placeAcross(ordered, frameGraph, direction, extra);
    const slots = plannedSlots(ordered, frameGraph, across.solved, across.cross);
    const contents = corridorContents(frameGraph, slots);
    return {
      ordered: ordered, solved: across.solved, cross: across.cross, slots: slots, contents: contents,
      stacked: stackRanks(ordered, contents, extra, across.cross, direction),
    };
  }

  /**
   * Places a C4 view (routing redesign §3.2, §4): ranks and orders it (§4.2–§4.4), solves the cross positions with
   * straight edges first (§4.5), budgets every corridor for its labels (§4.6), stacks the ranks and applies pins
   * (§4.7). `graph` and `options` (`direction`, `seed`, `pins`, `corridorExtra`) as in §3.2; never mutated.
   * A pin moves its own box and nothing else (spec §9.2: a drop re-routes and never re-ranks): the view is placed as
   * it is without pins, each pinned box's top-left corner is put on its pin, and the settle step moves a box only to
   * separate it from one a pin made it overlap (`applyPins`). Returns `{boxes, boundaries, ranks, order,
   * centreAligned, straightCapable, corridors, pinnedCorridors, labelSlots, stats}` with every coordinate an
   * integer; boxes and boundaries are real, corridors
   * and label slots in the flow frame. Corridors are measured from the final boxes (`settledCorridors`), and so is
   * each label slot's `main`; a slot's `cross` is the planned line. `pinnedCorridors` lists the ids of the corridors
   * that a pin keeps from growing (`pinnedCorridorIds`).
   */
  function place(graph, options) {
    const settings = Object.assign({ direction: 'down', seed: null, pins: null, corridorExtra: null }, options);
    const axes = frameAxes(settings.direction);
    const real = roundedGraph(graph);
    const frameGraph = graphInFrame(real, axes);
    const extra = settings.corridorExtra || new Map();
    const placed = placeInFrame(frameGraph, seedingOf(real, settings.seed, sizesOf(real)), settings.direction, extra);
    const layout = realLayout(placed.ordered, real, placed.cross, placed.stacked, axes);
    applyPins(real, layout, settings.pins);
    const corridors = settledCorridors(placed.ordered, layout, axes, placed.stacked.corridors.concat(gapCorridors(placed.ordered, placed.cross)));
    const mains = slotMains(placed.contents, corridors);
    const labelSlots = {};
    placed.slots.forEach((slot, index) => {
      if (frameGraph.edges[index].labelCross > 0) {
        labelSlots[frameGraph.edges[index].id] = { corridorId: slot.corridorId, position: slot.position, cross: slot.cross, main: mains.get(index) };
      }
    });
    return {
      boxes: layout.nodes,
      boundaries: layout.boundaries,
      ranks: objectOf(placed.ordered.ranks),
      order: objectOf(placed.ordered.rows),
      centreAligned: placed.solved.accepted.filter((entry) => entry.request.kind === 'centre').map((entry) => entry.request.edgeId),
      straightCapable: real.edges.filter((edge) => edge.source !== edge.target && straightCapable(real, layout, axes, edge)).map((edge) => edge.id),
      corridors: corridors,
      pinnedCorridors: pinnedCorridorIds(corridors, layout, axes, settings.pins || new Map()),
      labelSlots: labelSlots,
      stats: {
        layerCrossings: placed.ordered.layerCrossings, requestsAccepted: placed.solved.accepted.length,
        requestsRejected: placed.solved.rejected,
      },
    };
  }

  return { CFG: CFG, rankAndOrder: rankAndOrder, frameExtents: frameExtents, frameAround: frameAround, place: place };
});
