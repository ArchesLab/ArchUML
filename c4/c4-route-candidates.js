(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./c4-route-frame.js'), require('./c4-route-shapes.js'),
      require('./c4-route-labels.js'));
  } else {
    var parts = root.ArchUMLC4RouteParts = root.ArchUMLC4RouteParts || {};
    parts.candidates = factory(parts.frame, parts.shapes, parts.labels);
  }
})(typeof self !== 'undefined' ? self : this, function (frameModule, shapesModule, labelsModule) {
  'use strict';

  // Each edge's candidate routes (routing redesign §5.3, §5.4): the hard filters, what selection needs to know of a
  // candidate, the cap on the routes an edge keeps, and the fallback ladder, which ends in the grid route of
  // `UMLShared.routeOrthogonalConnector`.

  const { CFG, rectOf, grown, outlineLines, segmentsOf, boundsOf, classesOf } = frameModule;
  const { routingRules, tracksOn, corridorMiddles, endOptions, corridorTurnChoices, clearRoutes, straightRoutes,
    bundleLaneRoutes, bundleLaneClasses, bentRoutes } = shapesModule;
  const { labelOf, legalPlaceAt } = labelsModule;

  // ---- Hard filters (§5.4) ------------------------------------------------------------------------------------------

  /** Whether the run along the line at `at` from `lo` to `hi` (horizontal or not) passes through the open interior of `rect`. */
  function runEnters(horizontal, at, lo, hi, rect) {
    return horizontal
      ? at > rect.y && at < rect.y + rect.height && hi > rect.x && lo < rect.x + rect.width
      : at > rect.x && at < rect.x + rect.width && hi > rect.y && lo < rect.y + rect.height;
  }

  /**
   * The obstacles and own boxes a run along the line at `at` (a `y` for a horizontal run, an `x` for a vertical one)
   * can enter: the open ranges they cover along that line, worked out once per line and edge (tracks repeat across
   * routes).
   */
  function obstacleRanges(context, horizontal, at) {
    const lines = horizontal ? context.rows : context.columns;
    let ranges = lines.get(at);
    if (ranges === undefined) {
      const rules = context.rules;
      ranges = rules.obstacles.concat(rules.source, rules.target)
        .filter((rect) => (horizontal ? rect.y < at && at < rect.y + rect.height : rect.x < at && at < rect.x + rect.width))
        .map((rect) => (horizontal ? [rect.x, rect.x + rect.width] : [rect.y, rect.y + rect.height]));
      lines.set(at, ranges);
    }
    return ranges;
  }

  /**
   * Filter 1 for segment `index` (from `from` to `to`) of a route whose last segment is `last`: through an obstacle
   * or an own box (`obstacleRanges`), or through an own box's clearance away from its end.
   */
  function segmentHitsObstacle(context, from, to, index, last) {
    // The segment's line and range, as `segmentBetween` gives them, without building it: this runs for every turn tried.
    const horizontal = from.y === to.y;
    const at = horizontal ? from.y : from.x;
    const lo = horizontal ? Math.min(from.x, to.x) : Math.min(from.y, to.y);
    const hi = horizontal ? Math.max(from.x, to.x) : Math.max(from.y, to.y);
    for (const range of obstacleRanges(context, horizontal, at)) if (hi > range[0] && lo < range[1]) return true;
    return (index > 0 && runEnters(horizontal, at, lo, hi, context.sourceClearance)) || (index < last && runEnters(horizontal, at, lo, hi, context.targetClearance));
  }

  /** Filter 1: some segment of the route through `points` hits an obstacle (`segmentHitsObstacle`). */
  function hitsObstacle(points, context) {
    const last = points.length - 2;
    for (let index = 0; index <= last; index++) if (segmentHitsObstacle(context, points[index], points[index + 1], index, last)) return true;
    return false;
  }

  /** Filter 2: a segment runs along a boundary line (`boundaryLines`, every boundary's `outlineLines`) inside its band. */
  function hugsBoundaryLine(segments, boundaryLines) {
    return boundaryLines.some((line) => segments.some((segment) => segment.horizontal === line.horizontal &&
      Math.abs(segment.at - line.at) < CFG.boundaryBand && Math.min(segment.hi, line.hi) - Math.max(segment.lo, line.lo) > CFG.boundaryRunOverlap));
  }

  function outlineCrossings(segments, lines) {
    return segments.reduce((count, segment) => count + lines.filter((line) => line.horizontal !== segment.horizontal &&
      segment.at > line.lo && segment.at < line.hi && line.at > segment.lo && line.at < segment.hi).length, 0);
  }

  /** Filter 3: a passable boundary's outline is crossed more often than its allowance. */
  function crossesTooOften(segments, rules) {
    return rules.passable.some((boundary) => outlineCrossings(segments, boundary.lines) > boundary.allowance);
  }

  /** Filter 6: no place on or beside the route can carry its label, judged against the fixed obstacles only. */
  function noLabelRoom(frame, candidate) {
    const label = labelOf(frame, candidate);
    return Boolean(label) && !legalPlaceAt(frame, label, 0);
  }

  // ---- Candidates ---------------------------------------------------------------------------------------------------

  function lengthOf(segments) {
    return segments.reduce((sum, segment) => sum + segment.hi - segment.lo, 0);
  }

  /**
   * A candidate with what selection needs: segments, ends, bends, detour, its base cost (length and penalties), the
   * memo of its (symmetric) costs against other candidates, and `withChosen`, which selection fills
   * (`startWithChosen`).
   */
  function described(route, edge) {
    const points = route.points;
    const segments = segmentsOf(points);
    const first = points[0];
    const last = points[points.length - 1];
    const length = lengthOf(segments);
    return {
      edge: edge, points: points, segments: segments, source: route.source, target: route.target,
      bends: points.length - 2, length: length,
      detour: length - Math.abs(last.x - first.x) - Math.abs(last.y - first.y),
      base: length + route.source.penalty + route.target.penalty,
      bounds: boundsOf(points), pairCosts: new Map(), own: null, withChosen: null,
    };
  }

  /**
   * What the hard filters of one edge check its routes against: its routing rules, every boundary's outline lines,
   * its own boxes' clearance, and the obstacle ranges per line (`obstacleRanges`), filled as lines are asked for.
   */
  function filterContext(frame, edge) {
    const rules = routingRules(frame, edge);
    return {
      rules: rules, boundaryLines: frame.boundaries.flatMap((id) => outlineLines(rectOf(frame, id))), rows: new Map(), columns: new Map(),
      sourceClearance: grown(rules.source, CFG.boxClearance), targetClearance: grown(rules.target, CFG.boxClearance),
    };
  }

  /** Whether a route with these `points` breaks filter 1 or 7 (obstacles, bend limit): the filters most routes fail. */
  function blockedOrBent(points, classes, context) {
    return points.length - 2 > classes.maxBends || hitsObstacle(points, context);
  }

  /** Whether a candidate passes filters 1–3 and 7: obstacles, boundary bands, boundary crossings, bend limit. */
  function passesShapeFilters(candidate, classes, context) {
    const segments = candidate.segments;
    return !blockedOrBent(candidate.points, classes, context) &&
      !hugsBoundaryLine(segments, context.boundaryLines) && !crossesTooOften(segments, context.rules);
  }

  /** Whether a candidate passes every hard filter (§5.4). */
  function passesEveryFilter(frame, candidate, classes, context) {
    return passesShapeFilters(candidate, classes, context) && candidate.detour <= classes.detourCap && !noLabelRoom(frame, candidate);
  }

  /**
   * The candidates of one edge that pass every hard filter (`legal`), those failing only the detour cap
   * (`overDetour`, the fallback ladder), and those failing only filter 6 (`noRoom`): a label without room asks for
   * growth (§6.4) rather than a detour.
   */
  function filtered(frame, classes, candidates, context) {
    const legal = [];
    const overDetour = [];
    const noRoom = [];
    candidates.forEach((candidate) => {
      if (!passesShapeFilters(candidate, classes, context)) return;
      if (candidate.detour > classes.detourCap) overDetour.push(candidate);
      else if (noLabelRoom(frame, candidate)) noRoom.push(candidate);
      else legal.push(candidate);
    });
    return { legal: legal, overDetour: overDetour, noRoom: noRoom };
  }

  /**
   * What ordering and capping need of a route before it is described (`described`): its points and ends, bends, base
   * cost (length and end penalties) and pair key (its two ends and bend count).
   */
  function draftOf(route) {
    const points = route.points;
    let length = 0;
    for (let index = 1; index < points.length; index++) length += Math.abs(points[index].x - points[index - 1].x) + Math.abs(points[index].y - points[index - 1].y);
    const bends = points.length - 2;
    return {
      route: route, points: points, source: route.source, target: route.target, bends: bends,
      base: length + route.source.penalty + route.target.penalty, pair: route.source.key + '|' + route.target.key + '|' + bends,
    };
  }

  /**
   * At most the cap of the `entries` (drafts or candidates) that `admit` turns into candidates (every one as it is
   * when omitted), without duplicates and with a few per pair of ends. Shapes are taken in turn from every
   * combination of end sides and bend count (a shape group), lowest (bends, base) first within each, so the cap never
   * drops every route that leaves by an escape side; groups take their turns in the order of their best member.
   * Duplicates and pairs of ends never span two groups (a route's points fix its ends and bends), so each group is
   * worked through on its own and only as far as its turns reach: `admit` is asked about few routes (a duplicate is
   * admitted like its original, so asking before the duplicate check changes nothing). Returns
   * `{list, straight}`, `straight` telling whether any candidate would be admitted straight.
   */
  function capped(entries, admit) {
    const byGroup = new Map();
    entries.forEach((entry, order) => {
      const key = shapeGroupKey(entry);
      let group = byGroup.get(key);
      if (group === undefined) {
        group = { items: [], queue: null, kept: [], perPair: new Map(), seen: new Set() };
        byGroup.set(key, group);
      }
      group.items.push({ entry: entry, order: order });
    });
    const groups = Array.from(byGroup.values());
    // A group gives up its routes lowest (base, order) first, and most groups give up only their first few.
    groups.forEach((group) => { group.queue = smallestFirst(group.items, (a, b) => a.entry.base < b.entry.base || (a.entry.base === b.entry.base && a.order < b.order)); });
    /** Whether `group` has a member `rank` (0-based), admitting further routes until it has or runs out. */
    const reaches = (group, rank) => {
      while (group.kept.length <= rank && group.queue.size() > 0) {
        const item = group.queue.take();
        const entry = item.entry;
        const pair = entry.pair || entry.source.key + '|' + entry.target.key + '|' + entry.bends;
        if ((group.perPair.get(pair) || 0) >= CFG.candidatesPerEndPair) continue;
        const candidate = admit ? admit(entry) : entry;
        if (!candidate) continue;
        const key = entry.points.map((point) => point.x + ',' + point.y).join(' ');
        if (group.seen.has(key)) continue;
        group.seen.add(key);
        group.perPair.set(pair, (group.perPair.get(pair) || 0) + 1);
        group.kept.push({ candidate: candidate, order: item.order });
      }
      return group.kept.length > rank;
    };
    const firstOf = (group) => group.kept[0];
    const lists = groups.filter((group) => reaches(group, 0)).sort((a, b) =>
      firstOf(a).candidate.bends - firstOf(b).candidate.bends || firstOf(a).candidate.base - firstOf(b).candidate.base || firstOf(a).order - firstOf(b).order);
    const kept = [];
    for (let round = 0; kept.length < CFG.candidateCap && lists.some((group) => reaches(group, round)); round++) {
      lists.forEach((group) => { if (kept.length < CFG.candidateCap && reaches(group, round)) kept.push(group.kept[round].candidate); });
    }
    return { list: kept.sort((a, b) => a.bends - b.bends || a.base - b.base), straight: lists.some((group) => firstOf(group).candidate.bends === 0) };
  }

  const SIDE_ORDER = { top: 0, right: 1, bottom: 2, left: 3 };

  /** A number naming a route's shape group in `capped`: its source side, target side and bend count. */
  function shapeGroupKey(entry) {
    return entry.bends * 16 + SIDE_ORDER[entry.source.side] * 4 + SIDE_ORDER[entry.target.side];
  }

  /**
   * Takes `items` (which it reorders) one at a time, smallest first by `less` (a strict total order): a binary heap,
   * so taking the first few of many costs far less than sorting them all. Returns `{size(), take()}`.
   */
  function smallestFirst(items, less) {
    const heap = items;
    let size = heap.length;
    const swap = (a, b) => { const kept = heap[a]; heap[a] = heap[b]; heap[b] = kept; };
    const siftDown = (from) => {
      for (let at = from; ;) {
        const left = 2 * at + 1;
        const right = left + 1;
        let least = at;
        if (left < size && less(heap[left], heap[least])) least = left;
        if (right < size && less(heap[right], heap[least])) least = right;
        if (least === at) return;
        swap(at, least);
        at = least;
      }
    };
    for (let at = (size >> 1) - 1; at >= 0; at--) siftDown(at);
    return {
      size: () => size,
      take: () => {
        const first = heap[0];
        size--;
        swap(0, size);
        siftDown(0);
        return first;
      },
    };
  }

  // ---- Fallback ladder (§5.4) ---------------------------------------------------------------------------------------

  /**
   * The grid fallback (§5.3, §5.4 ladder): `UMLShared.routeOrthogonalConnector` between the preferred ends, around
   * every obstacle, with the boundary-band, bend and detour filters relaxed.
   */
  function gridFallback(frame, edge, classes, shared) {
    const rules = routingRules(frame, edge);
    const source = endOptions(frame, edge, classes, 'source')[0];
    const target = endOptions(frame, edge, classes, 'target')[0];
    const anchor = (end) => ({ x: end.x, y: end.y, side: end.side });
    const routed = shared.routeOrthogonalConnector(anchor(source), anchor(target), rules.obstacles, {
      stub: CFG.headStub, clearance: 0, bendPenalty: CFG.gridBendPenalty,
    });
    const points = shared.simplifyOrthogonalPath(routed.points.map((point) => ({ x: Math.round(point.x), y: Math.round(point.y) })));
    return described({ source: source, target: target, points: points }, edge);
  }

  /**
   * The corridor routes of an exempt edge (`corridorTurnChoices`) that pass filter 1, between the preferred slot of
   * each side of its two boxes; their detour stays within reach of the edge's cap.
   */
  function corridorRoutes(frame, edge, classes, middles, context) {
    const clear = (from, to, index, last) => !segmentHitsObstacle(context, from, to, index, last);
    const preferredSlots = (role) => endOptions(frame, edge, classes, role).filter((end) => end.rank === 0);
    const routes = [];
    preferredSlots('source').forEach((s) => preferredSlots('target').forEach((t) => {
      [3, 4].filter((bends) => bends <= classes.maxBends && (bends % 2 === 0) === (s.move === t.move)).forEach((bends) => {
        clearRoutes(s, t, corridorTurnChoices(s, t, bends, middles, classes.detourCap / 2), clear).forEach((route) => routes.push(route));
      });
    }));
    return routes;
  }

  /** The straight and bent routes of an edge that pass filter 1 (`context`), with at most `shapes.maxBends` bends. */
  function routesOf(frame, edge, classes, tracks, shapes, context) {
    const clear = (from, to, index, last) => !segmentHitsObstacle(context, from, to, index, last);
    return straightRoutes(frame, edge, classes).filter((route) => !hitsObstacle(route.points, context))
      .concat(bentRoutes(endOptions(frame, edge, classes, 'source'), endOptions(frame, edge, classes, 'target'), tracks, context.rules, shapes, clear));
  }

  /**
   * One edge's candidates (§5.4 fallback ladder): the ones passing every filter; else those whose only fault is a
   * label without room (growth makes the room, §6.4); else, for an exempt edge, the corridor routes that pass every
   * filter; else the least detour among routes that break only the detour cap, with the detouring shapes of exempt
   * edges tried too; else the grid. A bundle member beyond the first two only takes lanes outside both boxes (§5.2).
   * Every step of the ladder needs filters 1 and 7, so routes failing them, most of the routes there are, are dropped
   * as they are built. Returns `{list, fallback, straight}`.
   */
  function ladderOf(frame, edge, rules, grid, shared) {
    const { bundled, classes, context } = rules;
    const describe = (routes) => routes.map((route) => described(route, edge));
    const routes = bundled ? bundleLaneRoutes(frame, edge).filter((route) => !blockedOrBent(route.points, classes, context))
      : routesOf(frame, edge, classes, grid.tracks, classes, context);
    const legal = capped(routes.map(draftOf), (draft) => {
      const candidate = described(draft.route, edge);
      return passesEveryFilter(frame, candidate, classes, context) ? candidate : null;
    });
    if (legal.list.length) return { list: legal.list, fallback: false, straight: legal.straight };
    const result = filtered(frame, classes, describe(routes), context);
    if (result.noRoom.length) {
      const noRoom = capped(result.noRoom);
      return { list: noRoom.list, fallback: false, straight: noRoom.straight };
    }
    if (classes.exempt && !bundled) {
      const corridor = filtered(frame, classes, describe(corridorRoutes(frame, edge, classes, grid.middles, context)), context);
      if (corridor.legal.length) return { list: capped(corridor.legal).list, fallback: false, straight: false };
    }
    const detours = result.overDetour.concat(classes.exempt ? [] : filtered(frame, classes,
      describe(routesOf(frame, edge, classes, grid.tracks, Object.assign({}, classes, { exempt: true }), context)), context).overDetour);
    if (detours.length) {
      const least = Math.min.apply(null, detours.map((candidate) => candidate.detour));
      return { list: capped(detours.filter((candidate) => candidate.detour === least)).list, fallback: true, straight: false };
    }
    return { list: [gridFallback(frame, edge, classes, shared)], fallback: true, straight: false };
  }

  /**
   * Every edge's candidates (`ladderOf`), each with the rules its routes were judged by: `{list, fallback, straight,
   * rules: {bundled, classes, context}}`.
   */
  function candidatesOf(frame, shared) {
    const grid = {
      tracks: { x: tracksOn(frame, 'x'), y: tracksOn(frame, 'y') },
      middles: { x: corridorMiddles(frame, 'x'), y: corridorMiddles(frame, 'y') },
    };
    return frame.edges.map((edge) => {
      const bundled = frame.bundles[edge.index].rank >= CFG.bundleBandMembers;
      const rules = { bundled: bundled, classes: bundled ? bundleLaneClasses(frame, edge) : classesOf(frame, edge), context: filterContext(frame, edge) };
      return Object.assign(ladderOf(frame, edge, rules, grid, shared), { rules: rules });
    });
  }

  return { described: described, passesEveryFilter: passesEveryFilter, candidatesOf: candidatesOf };
});
