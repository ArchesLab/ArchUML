(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./c4-route-frame.js'));
  } else {
    var parts = root.ArchUMLC4RouteParts = root.ArchUMLC4RouteParts || {};
    parts.labels = factory(parts.frame);
  }
})(typeof self !== 'undefined' ? self : this, function (frameModule) {
  'use strict';

  // Edge labels (routing redesign §6.1, §6.2, §6.4): every place a label may take on or beside its own route, the legal
  // places among them (clear of the boxes, boundary labels, boundary outlines and the route's other segments, found
  // lazily), whether other routes block them, and the joint choice of every label's place on the chosen routes, with
  // the fallback place of a label left without a legal one.

  const { CFG, boundsMeet } = frameModule;

  // ---- Places (§6.1) ------------------------------------------------------------------------------------------------

  function overlapsWithPad(a, b, pad) {
    return a.x - pad < b.x + b.width && b.x < a.x + a.width + pad && a.y - pad < b.y + b.height && b.y < a.y + a.height + pad;
  }

  /** Where along a segment a label is tried (§6.1): its middle, then 8-unit steps outward to both ends. */
  function labelCentres(segment) {
    const middle = (segment.lo + segment.hi) / 2;
    const centres = [middle];
    for (let offset = CFG.labelStep; offset <= (segment.hi - segment.lo) / 2; offset += CFG.labelStep) centres.push(middle - offset, middle + offset);
    return centres;
  }

  /** Whether `rect` comes nearer than `distance` to an axis-aligned segment (axis-aligned rect-to-segment distance). */
  function nearSegment(rect, segment, distance) {
    const x0 = segment.horizontal ? segment.lo : segment.at;
    const x1 = segment.horizontal ? segment.hi : segment.at;
    const y0 = segment.horizontal ? segment.at : segment.lo;
    const y1 = segment.horizontal ? segment.at : segment.hi;
    const dx = Math.max(0, x0 - (rect.x + rect.width), rect.x - x1);
    const dy = Math.max(0, y0 - (rect.y + rect.height), rect.y - y1);
    return dx * dx + dy * dy < distance * distance;
  }

  /**
   * The room an on place leaves at each end of segment `index` of `points`: the label clearance, plus the tail stub
   * on the route's first segment and the head stub before the arrow tip on its last.
   */
  function onClearance(points, segment, index, last) {
    const first = points[index];
    const startsAtLo = (segment.horizontal ? first.x : first.y) === segment.lo;
    const start = CFG.labelBoxClear + (index === 0 ? CFG.tailStub : 0);
    const end = index === last ? Math.max(CFG.headStub, CFG.labelBoxClear) : CFG.labelBoxClear;
    return startsAtLo ? { lo: start, hi: end } : { lo: end, hi: start };
  }

  /**
   * The side of a segment a beside label prefers (§6.2): right of a vertical segment and above a horizontal one,
   * judged in real coordinates. Returns the sign of the frame's across axis.
   */
  function awaySign(frame, segment) {
    return segment.horizontal !== frame.flip ? -1 : 1;
  }

  /**
   * Every place a label of `size` may take on the route of `candidate` (§6.1), segment by segment and along each
   * segment from its middle outward: on the segment, centred on it so its background interrupts its own line (never
   * for a bundled edge, and only where the label leaves the label clearance and the stubs free), and beside it on
   * either side at the beside gap. Each place is `{rect, on, segment, side, offset, visited}` in the frame, with
   * integer coordinates, `visited` counting the places before it.
   */
  function* labelPlaceWalk(candidate, size, bundled) {
    const segments = candidate.segments;
    let visited = 0;
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      const along = segment.horizontal ? size.width : size.height;
      const across = segment.horizontal ? size.height : size.width;
      const clear = onClearance(candidate.points, segment, index, segments.length - 1);
      const middle = (segment.lo + segment.hi) / 2;
      const rectAt = (start, from) => (segment.horizontal
        ? { x: start, y: from, width: size.width, height: size.height } : { x: from, y: start, width: size.width, height: size.height });
      for (const centre of labelCentres(segment)) {
        const start = Math.round(centre - along / 2);
        const offset = Math.abs(centre - middle);
        if (!bundled && start >= segment.lo + clear.lo && start + along <= segment.hi - clear.hi) {
          yield { rect: rectAt(start, Math.round(segment.at - across / 2)), on: true, segment: index, side: 0, offset: offset, visited: visited++ };
        }
        yield { rect: rectAt(start, segment.at + CFG.labelBesideGap), on: false, segment: index, side: 1, offset: offset, visited: visited++ };
        yield { rect: rectAt(start, segment.at - CFG.labelBesideGap - across), on: false, segment: index, side: -1, offset: offset, visited: visited++ };
      }
    }
  }

  /**
   * `places` of a candidate's label, preferred first (§6.2): on places, then beside ones; nearest the middle of
   * their segment; the side away from the flow; longer segments; then the order visited.
   */
  function preferred(frame, candidate, places) {
    const segments = candidate.segments;
    const longestFirst = segments.map((segment, index) => index)
      .sort((a, b) => (segments[b].hi - segments[b].lo) - (segments[a].hi - segments[a].lo) || a - b);
    const keyOf = (place) => [place.on ? 0 : 1, place.offset, place.on || place.side === awaySign(frame, segments[place.segment]) ? 0 : 1,
      longestFirst.indexOf(place.segment), place.visited];
    return places.map((place) => ({ place: place, key: keyOf(place) })).sort((a, b) => compareTuples(a.key, b.key)).map((entry) => entry.place);
  }

  /** The fixed label obstacles (`fixedLabelObstacles`) that a place inside `region` can break, by each rule's padding. */
  function labelObstaclesNear(frame, region) {
    const area = { x: region.x0, y: region.y0, width: region.x1 - region.x0, height: region.y1 - region.y0 };
    const near = (pad) => (rect) => overlapsWithPad(area, rect, pad);
    const fixed = frame.labelObstacles;
    return {
      boxes: fixed.boxes.filter(near(CFG.labelBoxClear)),
      boundaryLabels: fixed.boundaryLabels.filter(near(CFG.labelBoxClear)),
      outlines: fixed.outlines.filter(near(CFG.labelOutlineClear)),
    };
  }

  /**
   * The rules a label place must keep whatever the other routes (§6.1), one per kind of fixed obstacle: element
   * boxes and boundary labels (label clearance), boundary outlines (outline clearance), and its own route's other
   * segments (beside gap). Each rule lists its obstacles and says whether a place breaks one of them.
   */
  const FIXED_LABEL_RULES = Object.freeze([
    { obstacles: (fixed) => fixed.boxes, breaks: (place, rect) => overlapsWithPad(place.rect, rect, CFG.labelBoxClear) },
    { obstacles: (fixed) => fixed.boundaryLabels, breaks: (place, rect) => overlapsWithPad(place.rect, rect, CFG.labelBoxClear) },
    { obstacles: (fixed) => fixed.outlines, breaks: (place, rect) => overlapsWithPad(place.rect, rect, CFG.labelOutlineClear) },
    {
      obstacles: (fixed, segments) => segments,
      breaks: (place, segment, index) => index !== place.segment && nearSegment(place.rect, segment, CFG.labelBesideGap),
    },
  ]);

  /** How many fixed obstacles a label place breaks (`FIXED_LABEL_RULES`). */
  function fixedViolations(place, segments, fixed) {
    return FIXED_LABEL_RULES.reduce((sum, rule) =>
      sum + rule.obstacles(fixed, segments).filter((obstacle, index) => rule.breaks(place, obstacle, index)).length, 0);
  }

  /** Whether a label place breaks any fixed obstacle (`fixedViolations` > 0), stopping at the first. */
  function breaksFixed(place, segments, fixed) {
    return FIXED_LABEL_RULES.some((rule) => rule.obstacles(fixed, segments).some((obstacle, index) => rule.breaks(place, obstacle, index)));
  }

  /**
   * The label of a candidate route, made once: `null` for an unlabelled edge, else `{candidate, size, bundled, region,
   * legal, ...}`. `region` bounds every place it can take (`placeRegion`). Its legal places, those clear of every fixed
   * obstacle, are found lazily in walk order (`legalPlaceAt`), because selection mostly needs only the first free
   * one; `witness` and `blockers` remember the last answer of `labelBlocked`.
   */
  function labelOf(frame, candidate) {
    if (candidate.label === undefined) {
      const size = frame.labelSizes[candidate.edge.index];
      candidate.label = size ? {
        candidate: candidate, size: size, bundled: frame.bundles[candidate.edge.index].size > 1, region: placeRegion(candidate, size),
        legal: [], walk: null, fixed: null, complete: false, witness: undefined, blockers: null,
      } : null;
    }
    return candidate.label;
  }

  /**
   * Bounds of every place a label of `size` can take on `candidate`'s route (`labelPlaceWalk`): along each segment,
   * centres lie on the segment, so a place reaches half the label beyond its ends (one more for rounding); across it,
   * a place lies on the segment or beside it at the beside gap.
   */
  function placeRegion(candidate, size) {
    const region = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
    candidate.segments.forEach((segment) => {
      const along = Math.ceil((segment.horizontal ? size.width : size.height) / 2) + 1;
      const across = (segment.horizontal ? size.height : size.width) + CFG.labelBesideGap + 1;
      const [x0, x1, y0, y1] = segment.horizontal
        ? [segment.lo - along, segment.hi + along, segment.at - across, segment.at + across]
        : [segment.at - across, segment.at + across, segment.lo - along, segment.hi + along];
      region.x0 = Math.min(region.x0, x0);
      region.x1 = Math.max(region.x1, x1);
      region.y0 = Math.min(region.y0, y0);
      region.y1 = Math.max(region.y1, y1);
    });
    return region;
  }

  /** The legal place `index` of `label` in walk order, or null when it has fewer; walks only as far as needed. */
  function legalPlaceAt(frame, label, index) {
    if (!label.walk && !label.complete) {
      label.walk = labelPlaceWalk(label.candidate, label.size, label.bundled);
      label.fixed = labelObstaclesNear(frame, label.region);
    }
    while (label.legal.length <= index && !label.complete) {
      const next = label.walk.next();
      if (next.done) {
        label.complete = true;
        label.walk = null;
      } else if (!breaksFixed(next.value, label.candidate.segments, label.fixed)) label.legal.push(next.value);
    }
    return label.legal[index] || null;
  }

  /** Every legal place of `label`, in walk order. */
  function legalPlaces(frame, label) {
    legalPlaceAt(frame, label, Infinity);
    return label.legal;
  }

  // ---- Places other routes block (§5.5, §6.1) -----------------------------------------------------------------------

  /** Whether `route` comes nearer than the foreign-route clearance to a label `place`. */
  function blocksPlace(route, place) {
    const rect = place.rect;
    const clear = CFG.labelForeignClear;
    const bounds = route.bounds;
    if (rect.x - clear > bounds.x1 || bounds.x0 - clear > rect.x + rect.width || rect.y - clear > bounds.y1 || bounds.y0 - clear > rect.y + rect.height) return false;
    return route.segments.some((segment) => nearSegment(rect, segment, clear));
  }

  /** Whether `route` can come nearer than the foreign-route clearance to some place of `label`. */
  function nearLabel(label, route) {
    return boundsMeet(label.region, route.bounds, CFG.labelForeignClear);
  }

  /**
   * Whether every legal place of `label` is blocked (`blocksPlace`) by one of `routes`: the current routes, other
   * than the label's own, that come near it; `isCurrent(route)` tells whether a route is one of the current ones.
   * The label remembers a free place it found (`witness`) and routes that blocked every place (`blockers`): while
   * the witness stays free, or every blocker is still current, the answer needs no search.
   */
  function labelBlocked(frame, label, routes, isCurrent) {
    if (label.witness !== undefined && !routes.some((route) => blocksPlace(route, label.legal[label.witness]))) return false;
    if (label.blockers && label.blockers.every(isCurrent)) return true;
    const blockers = new Set();
    for (let index = 0, place = legalPlaceAt(frame, label, 0); place; place = legalPlaceAt(frame, label, ++index)) {
      const blocker = routes.find((route) => blocksPlace(route, place));
      if (!blocker) {
        label.witness = index;
        return false;
      }
      blockers.add(blocker);
    }
    label.blockers = Array.from(blockers);
    return true;
  }

  // ---- Choice (§6.2) and fallback (§6.4) ----------------------------------------------------------------------------

  /**
   * The sides (-1, 1) of `segment` on which other chosen routes run parallel to it near enough that a label on it
   * would reach them: its neighbours across the flow in a fan-out or fan-in.
   */
  function neighbourSides(chosen, index, segment, size) {
    const reach = (segment.horizontal ? size.height : size.width) + CFG.labelBesideGap + CFG.labelForeignClear;
    const sides = new Set();
    chosen.forEach((route, other) => {
      if (other === index) return;
      route.segments.forEach((parallel) => {
        if (parallel.horizontal === segment.horizontal && parallel.at !== segment.at && Math.abs(parallel.at - segment.at) < reach &&
          parallel.lo < segment.hi && parallel.hi > segment.lo) sides.add(Math.sign(parallel.at - segment.at));
      });
    });
    return sides;
  }

  /** The side of its segment a place lies on: 0 on it, else the sign of its offset across. */
  function placeSide(place, segment) {
    if (place.on) return 0;
    const middle = segment.horizontal ? place.rect.y + place.rect.height / 2 : place.rect.x + place.rect.width / 2;
    return Math.sign(middle - segment.at);
  }

  /**
   * The legal places of edge `index`'s label that no other chosen route blocks, in preference order, with the fan
   * rule of §6.1: a label whose segment has neighbours on one side only (the outermost of a fan) prefers the beside
   * place facing away from them, then its on place, then the beside place facing them.
   */
  function freePlaces(frame, chosen, index) {
    const candidate = chosen[index];
    const label = labelOf(frame, candidate);
    const size = frame.labelSizes[index];
    const others = chosen.filter((_, other) => other !== index);
    const free = preferred(frame, candidate, legalPlaces(frame, label).filter((place) => !others.some((route) => blocksPlace(route, place))));
    const sidesBySegment = new Map();
    const fanRank = (place) => {
      if (!sidesBySegment.has(place.segment)) sidesBySegment.set(place.segment, neighbourSides(chosen, index, candidate.segments[place.segment], size));
      const sides = sidesBySegment.get(place.segment);
      if (sides.size !== 1) return 0;
      const outward = -sides.values().next().value;
      if (place.on) return 1;
      return placeSide(place, candidate.segments[place.segment]) === outward ? 0 : 2;
    };
    return free.map((place, order) => ({ place: place, rank: fanRank(place), order: order }))
      .sort((a, b) => a.rank - b.rank || a.order - b.order).map((entry) => entry.place);
  }

  function overlapsLabels(place, entries, self) {
    return entries.some((other) => other && other !== self && other.place && overlapsWithPad(place.rect, other.place.rect, CFG.labelBoxClear));
  }

  /**
   * Gives a waiting label the first of its free places whose only obstacles are placed labels that can each move
   * to another free place of their own (§6.2 local search). Returns whether it found one.
   */
  function placeByMoving(entries, waiting) {
    return waiting.free.some((place) => {
      const blockers = entries.filter((other) => other && other !== waiting && other.place && overlapsWithPad(place.rect, other.place.rect, CFG.labelBoxClear));
      const moves = new Map();
      const settled = blockers.every((blocker) => {
        const taken = [{ place: place }].concat(entries.filter((other) => other && other !== blocker && other.place && !blockers.includes(other)),
          Array.from(moves.values()).map((moved) => ({ place: moved })));
        const elsewhere = blocker.free.find((alternative) => alternative !== blocker.place && !overlapsLabels(alternative, taken, null));
        if (elsewhere) moves.set(blocker, elsewhere);
        return Boolean(elsewhere);
      });
      if (!settled) return false;
      moves.forEach((moved, blocker) => { blocker.place = moved; });
      waiting.place = place;
      return true;
    });
  }

  /**
   * The place a label without a legal one takes (§6.4): the nearest place on or beside its own route, breaking the
   * fewest fixed obstacles first and only then the label-to-label rule and the foreign-route clearance.
   */
  function fallbackPlace(frame, chosen, entries, entry) {
    const candidate = chosen[entry.index];
    const others = chosen.filter((_, other) => other !== entry.index);
    const score = (place) => [
      fixedViolations(place, candidate.segments, frame.labelObstacles),
      entries.filter((other) => other && other !== entry && other.place && overlapsWithPad(place.rect, other.place.rect, CFG.labelBoxClear)).length,
      others.filter((route) => route.segments.some((segment) => nearSegment(place.rect, segment, CFG.labelForeignClear))).length,
    ];
    let best = null;
    const label = labelOf(frame, candidate);
    preferred(frame, candidate, Array.from(labelPlaceWalk(candidate, label.size, label.bundled))).forEach((place) => {
      const value = score(place);
      if (!best || compareTuples(value, best.value) < 0) best = { place: place, value: value };
    });
    return best.place;
  }

  function compareTuples(a, b) {
    for (let index = 0; index < a.length; index++) {
      if (a[index] !== b[index]) return a[index] - b[index];
    }
    return 0;
  }

  /**
   * Chooses every label's place on its chosen route, jointly (§6.2): the labels with the fewest free places go
   * first, each taking its most preferred free place clear of the labels placed before it; a label left without
   * one may move labels in its way to their other free places; a label still without one falls back (§6.4).
   * Returns per edge null (unlabelled) or `{index, free, place, fallback}`.
   */
  function chooseLabels(frame, chosen) {
    const entries = chosen.map((candidate, index) => (labelOf(frame, candidate)
      ? { index: index, free: freePlaces(frame, chosen, index), place: null, fallback: false } : null));
    const order = entries.filter(Boolean).sort((a, b) => a.free.length - b.free.length || a.index - b.index);
    order.forEach((entry) => { entry.place = entry.free.find((place) => !overlapsLabels(place, entries, entry)) || null; });
    order.filter((entry) => !entry.place).forEach((entry) => placeByMoving(entries, entry));
    order.filter((entry) => !entry.place).sort((a, b) => a.index - b.index).forEach((entry) => {
      entry.place = fallbackPlace(frame, chosen, entries, entry);
      entry.fallback = true;
    });
    return entries;
  }

  return {
    labelOf: labelOf, legalPlaceAt: legalPlaceAt, blocksPlace: blocksPlace, nearLabel: nearLabel,
    labelBlocked: labelBlocked, chooseLabels: chooseLabels
  };
});
