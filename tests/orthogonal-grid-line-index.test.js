'use strict';

// The router's grid-line index answers "is this grid point inside a box?"
// and "is this grid link blocked?" from the obstacles and reserved segments
// that can touch the link's grid line. Its answers must equal the full scan
// that UMLShared.routeHitsObstacle does over every box and segment, also at
// the exact tolerances: touching edges, the 2px crossing margin, the 6px
// lane clearance and overlap, links shorter than a pixel, zero-length links.

const assert = require('assert/strict');
const test = require('node:test');
const { loadBundle } = require('./support/load-bundle');

const { UMLShared } = loadBundle();

// The rectangle form the router works with (left/right/top/bottom) and the
// obstacle form routeHitsObstacle reads; integer and half-integer values
// keep the two exactly equal.
function boxes(list) {
  return {
    rects: list.map(([left, top, right, bottom]) => ({ left, top, right, bottom })),
    obstacles: list.map(([x1, y1, x2, y2]) => ({ x1, y1, x2, y2 })),
  };
}

// Grid coordinates at and around every edge and segment, at the offsets
// where a tolerance flips.
function boundaryCoordinates(values) {
  const offsets = [-6.5, -6, -5.5, -2.5, -2, -1.5, -1, -0.6, 0, 0.6, 1, 1.5, 2, 2.5, 5.5, 6, 6.5];
  const out = new Set();
  values.forEach((v) => offsets.forEach((d) => out.add(v + d)));
  return Array.from(out).sort((a, b) => a - b);
}

function mismatches(boxList, occupied) {
  const { rects, obstacles } = boxes(boxList);
  const xsSource = [], ysSource = [];
  boxList.forEach(([l, t, r, b]) => { xsSource.push(l, r); ysSource.push(t, b); });
  occupied.h.forEach((s) => { ysSource.push(s.y); xsSource.push(s.x1, s.x2); });
  occupied.v.forEach((s) => { xsSource.push(s.x); ysSource.push(s.y1, s.y2); });
  const xs = boundaryCoordinates(xsSource);
  const ys = boundaryCoordinates(ysSource);
  const index = UMLShared.createOrthogonalGridLineIndex(xs, ys, rects, occupied);
  const scanHits = (p0, p1, occ) => UMLShared.routeHitsObstacle([p0, p1], obstacles, null, occ);
  const wrong = [];
  for (let xi = 0; xi < xs.length; xi++) {
    for (let yi = 0; yi < ys.length; yi++) {
      const p = { x: xs[xi], y: ys[yi] };
      if (index.pointInside(xi, yi) !== scanHits(p, p, null)) wrong.push(['point', p]);
    }
  }
  for (let yi = 0; yi < ys.length; yi++) {
    for (let a = 0; a < xs.length; a++) {
      for (let b = a; b < xs.length; b += 1 + (b - a > 3 ? 3 : 0)) {
        const pa = { x: xs[a], y: ys[yi] }, pb = { x: xs[b], y: ys[yi] };
        if (index.horizontalLinkBlocked(yi, a, b) !== scanHits(pa, pb, occupied)) wrong.push(['h', pa, pb]);
        if (index.horizontalLinkBlocked(yi, b, a) !== scanHits(pb, pa, occupied)) wrong.push(['h', pb, pa]);
      }
    }
  }
  for (let xi = 0; xi < xs.length; xi++) {
    for (let a = 0; a < ys.length; a++) {
      for (let b = a; b < ys.length; b += 1 + (b - a > 3 ? 3 : 0)) {
        const pa = { x: xs[xi], y: ys[a] }, pb = { x: xs[xi], y: ys[b] };
        if (index.verticalLinkBlocked(xi, a, b) !== scanHits(pa, pb, occupied)) wrong.push(['v', pa, pb]);
        if (index.verticalLinkBlocked(xi, b, a) !== scanHits(pb, pa, occupied)) wrong.push(['v', pb, pa]);
      }
    }
  }
  return wrong;
}

test('without reserved segments, points and links are blocked exactly where a box is', () => {
  const wrong = mismatches([[0, 0, 40, 30], [40, 30, 80, 60], [100, 10, 101, 50]], { h: [], v: [] });
  assert.deepEqual(wrong, []);
});

test('links near or across reserved segments are blocked exactly as the full scan says', () => {
  const occupied = {
    h: [{ y: 20, x1: 10, x2: 70 }, { y: 50, x1: 60, x2: 61 }],
    v: [{ x: 30, y1: 5, y2: 45 }, { x: 90, y1: 0, y2: 0 }],
  };
  assert.deepEqual(mismatches([[40, 30, 80, 60]], occupied), []);
});

test('boxes and reserved segments that share edges and lanes are indexed exactly', () => {
  const occupied = {
    h: [{ y: 0, x1: 0, x2: 40 }, { y: 30, x1: 40, x2: 80 }, { y: 36, x1: 0, x2: 100 }],
    v: [{ x: 40, y1: 0, y2: 60 }, { x: 46, y1: 30, y2: 31 }],
  };
  assert.deepEqual(mismatches([[0, 0, 40, 30], [40, 30, 80, 60], [34, 24, 46, 36]], occupied), []);
});

test('with no reserved segments object, only boxes block', () => {
  const { rects } = boxes([[0, 0, 40, 30]]);
  const xs = [-10, 20, 50], ys = [-10, 15, 40];
  const index = UMLShared.createOrthogonalGridLineIndex(xs, ys, rects, null);
  assert.equal(index.horizontalLinkBlocked(1, 0, 2), true);
  assert.equal(index.horizontalLinkBlocked(0, 0, 2), false);
  assert.equal(index.verticalLinkBlocked(1, 0, 2), true);
  assert.equal(index.pointInside(1, 1), true);
  assert.equal(index.pointInside(0, 0), false);
});
