(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root, require('./c4-route-frame.js'), require('./c4-route-labels.js'),
      require('./c4-route-candidates.js'), require('./c4-route-select.js'), require('./c4-route-growth.js'),
      require('./c4-route-evidence.js'));
  } else {
    var parts = root.ArchUMLC4RouteParts || {};
    root.ArchUMLC4Route = factory(root, parts.frame, parts.labels, parts.candidates, parts.select, parts.growth, parts.evidence);
  }
})(typeof self !== 'undefined' ? self : this, function (root, frameModule, labelsModule, candidatesModule, selectModule, growthModule, evidenceModule) {
  'use strict';

  // Routing of C4 views (routing redesign §5, docs/superpowers/specs/2026-11-09-c4-routing-redesign.md), published as
  // `ArchUMLC4Route`. Routing reads geometry only (boxes, boundaries, their nesting), so pinned and hand-moved layouts
  // route the same way. For every edge it lists end options on the sides of its boxes (§5.2), builds candidate routes
  // with at most four bends through tracks between the boxes (§5.3), drops every candidate that breaks a hard rule
  // (§5.4), and then chooses one candidate per edge for all edges together (§5.5, §5.6). Everything runs in a flow
  // frame where the flow points down; a view laid out to the right is transposed in and out. DOM-free; `UMLShared` is
  // read only for the grid fallback, only inside `route`, and never written. Every tie ends in view-model order.
  //
  // The parts load before this file, each a file of its own: the frame and the constants (c4-route-frame.js), route
  // shapes (c4-route-shapes.js), labels (c4-route-labels.js), candidates (c4-route-candidates.js), the objective
  // (c4-route-costs.js), the selection state (c4-route-state.js), move pricing (c4-route-pricing.js), the separation
  // of close parallels (c4-route-separate.js), selection (c4-route-select.js), growth (c4-route-growth.js), and
  // evidence mode (c4-route-evidence.js). This file runs a routing through them.

  const { CFG, transposedRect, plainRect, frameOf, realPoint, realSide, classesOf } = frameModule;
  const { chooseLabels } = labelsModule;
  const { candidatesOf } = candidatesModule;
  const { select } = selectModule;
  const { growthFor } = growthModule;
  const { exhaustiveCrossings } = evidenceModule;

  // ---- Entry point --------------------------------------------------------------------------------------------------

  /** The §5.0 classes of one edge of `scene` on its boxes: `{upward, sameRank, blocked, boundaryEntry, exempt, detourCap, maxBends}`. */
  function classify(scene, edgeId) {
    const frame = frameOf(scene);
    const edge = frame.edges.find((candidate) => candidate.id === edgeId);
    if (!edge) throw new Error('C4 routing: no edge "' + edgeId + '"');
    return classesOf(frame, edge);
  }

  /**
   * Routes and labels every edge of `scene` (routing redesign §3.2): `{boxes, boundaries, boundaryLabels, parentOf,
   * edges, direction, corridors}`, never mutated. `options.shared` is `UMLShared` (else the page's), used only for
   * the grid fallback; `options.noGrowth` names corridors the caller cannot grow; `options.exhaustivePairs` (tests
   * and threshold evidence only) names edges whose fewest crossings `stats.exhaustive` reports
   * (`exhaustiveCrossings`). Returns `{edges: [{id, points, labelBox, bends, sides, labelFallback, fallbackRoute}],
   * growth: [{corridorId, axis, by}], stats}` in view-model order, with integer coordinates in real space. A label
   * without a legal place is a fallback, and `growth` names the corridors whose growth would give it one, or would
   * give the ends that still crowd a side room to move (§6.4).
   */
  function route(scene, options) {
    const settings = Object.assign({ shared: null, exhaustivePairs: null, noGrowth: [] }, options);
    const shared = settings.shared || root.UMLShared;
    const frame = frameOf(scene);
    const perEdge = candidatesOf(frame, shared);
    const selection = select(frame, perEdge);
    const labels = chooseLabels(frame, selection.chosen);
    const toReal = frame.flip ? transposedRect : plainRect;
    const edges = frame.edges.map((edge, index) => {
      const candidate = selection.chosen[index];
      const label = labels[index];
      return {
        id: edge.id, points: candidate.points.map((point) => realPoint(frame, point)), labelBox: label ? toReal(label.place.rect) : null,
        bends: candidate.bends, sides: [realSide(frame, candidate.source.side), realSide(frame, candidate.target.side)],
        labelFallback: Boolean(label && label.fallback), fallbackRoute: perEdge[index].fallback,
      };
    });
    return {
      edges: edges,
      growth: growthFor(frame, scene.corridors || [], selection.chosen, labels, new Set(settings.noGrowth)),
      stats: {
        crossings: selection.cost[1], bends: selection.cost[4], rounds: selection.rounds,
        candidates: perEdge.reduce((sum, option) => sum + option.list.length, 0),
        fallbackRoutes: edges.filter((edge) => edge.fallbackRoute).length, labelFallbacks: edges.filter((edge) => edge.labelFallback).length,
        exhaustive: settings.exhaustivePairs ? exhaustiveCrossings(selection.state, perEdge, settings.exhaustivePairs) : null,
      },
    };
  }

  return { CFG: CFG, route: route, classify: classify };
});
