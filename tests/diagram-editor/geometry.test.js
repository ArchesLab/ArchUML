'use strict';

// The diagram editor's geometry (UML-view editing spec §2.2; plan Task 22): snapping, alignment guides, the free
// place for a box added without a drop point, overlaps, and the route a segment drag makes. The values are the UML
// editor's: a 10-unit layout grid, guides within four screen pixels (the editor passes that tolerance in drawing
// units), and a free place 60 units right of the rightmost box, 80 units down.

const test = require('node:test');
const assert = require('node:assert/strict');

const geometry = require('../../diagram-editor/de-geometry.js');

const box = (x, y, width, height) => ({ x, y, width, height });

test('a guide appears within four screen pixels and not at five', () => {
  const peer = box(100, 200, 50, 20);
  const fourOff = box(104, 0, 50, 20);
  const fiveOff = box(105, 0, 50, 20);

  // The left edges, the centres, and the right edges line up within four: one vertical guide at each of the peer's,
  // from just above the moving box to just below the peer.
  assert.deepEqual(geometry.alignmentGuides(fourOff, [peer], 4), [
    { x1: 100, y1: -12, x2: 100, y2: 232 },
    { x1: 125, y1: -12, x2: 125, y2: 232 },
    { x1: 150, y1: -12, x2: 150, y2: 232 },
  ]);
  assert.deepEqual(geometry.alignmentGuides(fiveOff, [peer], 4), []);
  assert.deepEqual(geometry.alignmentGuides(fiveOff, [peer], { x: 5, y: 4 }).map((guide) => guide.x1), [100, 125, 150],
    'a tolerance per axis widens only that axis');
});

test('snap rounds to the grid at both sides of a half step', () => {
  assert.deepEqual(geometry.snap({ x: 14.9, y: 15 }, 10), { x: 10, y: 20 });
  assert.deepEqual(geometry.snap({ x: -15.1, y: -14.9 }, 10), { x: -20, y: -10 });
  assert.deepEqual(geometry.snap({ x: 24.9, y: 25 }), { x: 20, y: 30 }, 'the default grid is the layout grid of 10');
});

test('the free place lies right of the rightmost drawn box with today\'s gap', () => {
  assert.deepEqual(geometry.freePlaceRightOf([box(0, 0, 100, 40), box(300, 200, 120, 40)], { width: 100, height: 40 }), { x: 480, y: 80 });
  assert.deepEqual(geometry.freePlaceRightOf([], { width: 100, height: 40 }), { x: 120, y: 80 },
    'an empty drawing places the box as if a box ended 60 units in');
  assert.deepEqual(geometry.freePlaceRightOf([box(-50, 0, 80, 40)], { width: 100, height: 40 }), { x: 120, y: 80 });
});

test('boxes that touch do not overlap, boxes that share one pixel do', () => {
  const a = box(0, 0, 10, 10);

  assert.equal(geometry.overlaps(a, box(10, 0, 10, 10)), false, 'touching on the right');
  assert.equal(geometry.overlaps(a, box(0, 10, 10, 10)), false, 'touching below');
  assert.equal(geometry.overlaps(a, box(9, 0, 10, 10)), true, 'one pixel shared across');
  assert.equal(geometry.overlaps(a, box(0, -9, 10, 10)), true, 'one pixel shared down');
  assert.equal(geometry.overlaps(a, box(9, 9, 10, 10)), true, 'one pixel shared at a corner');
});

test('an anchored route keeps both ends where they are and carries the dragged segment by the pointer\'s move', () => {
  const twoPoint = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const threePoint = [{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 100, y: 50 }];

  assert.deepEqual(geometry.anchoredRoute({ x: 50, y: 0 }, { x: 50, y: 30 }, twoPoint),
    [{ x: 0, y: 0 }, { x: 0, y: 30 }, { x: 100, y: 30 }, { x: 100, y: 0 }]);
  assert.deepEqual(geometry.anchoredRoute({ x: 0, y: 20 }, { x: 25, y: 20 }, threePoint, 0),
    [{ x: 0, y: 0 }, { x: 25, y: 0 }, { x: 25, y: 50 }, { x: 100, y: 50 }]);
});

test('a port dragged near its component snaps onto the nearest side, kept eight units from the corners', () => {
  const port = { axis: 'port', parentBox: box(100, 100, 200, 100), portSide: 'right' };

  assert.deepEqual(geometry.constrainedPortPosition(port, 320, 150), { x: 300, y: 150, side: 'right' });
  assert.deepEqual(geometry.constrainedPortPosition(port, 97, 103), { x: 100, y: 108, side: 'left' },
    'as near the left as the top: the first side wins, eight units below the corner');
  assert.deepEqual(geometry.constrainedPortPosition({ ...port, portSide: 'top' }, 97, 103), { x: 108, y: 100, side: 'top' },
    'as near two sides, a port stays on the side it is drawn on');
  assert.deepEqual(geometry.constrainedPortPosition({ axis: 'xy' }, 5, 6), { x: 5, y: 6 }, 'a box that is no port is not constrained');
});

// The "⋯" button of the one selected element or line (spec §3.11; plan Task 25c), placed in screen space: the first
// place where its square overlaps no hit target of the layer. A box's places, in order: above its top-right corner,
// right of it, below its bottom-right corner, left of its top-left corner, each 4 px clear of the box. A line's: beside
// the middle of its longest segment, first on the side its left hand points to as it runs from its source end (above a
// line drawn left to right), then on the other, clear of the segment's own hit target. A hit target is a box or a
// segment `{ a, b, halfWidth }`; touching is no overlap.
test('actionButtonPlace takes the first free place around a box, then beside a segment, and reports none free when every place overlaps a target', () => {
  const size = 24;
  const item = box(100, 100, 80, 40);
  const above = { x: 156, y: 72 };
  const right = { x: 184, y: 100 };
  const below = { x: 156, y: 144 };
  const left = { x: 72, y: 100 };

  assert.deepEqual(geometry.actionButtonPlace({ box: item }, [item], size), { ...above, free: true },
    'above the top-right corner, when only the box itself is a target');
  assert.deepEqual(geometry.actionButtonPlace({ box: item }, [item, { a: { x: 150, y: 66 }, b: { x: 200, y: 66 }, halfWidth: 6 }], size),
    { ...above, free: true }, 'a segment whose hit target only touches the square leaves the place free');
  assert.deepEqual(geometry.actionButtonPlace({ box: item }, [item, { a: { x: 150, y: 84 }, b: { x: 200, y: 84 }, halfWidth: 6 }], size),
    { ...right, free: true }, 'a segment across the place above sends the button right of the box');
  assert.deepEqual(geometry.actionButtonPlace({ box: item }, [item, box(150, 60, 40, 20), box(184, 110, 10, 10)], size),
    { ...below, free: true }, 'boxes over the first two places send it below the bottom-right corner');
  assert.deepEqual(geometry.actionButtonPlace({ box: item }, [item, box(150, 60, 40, 20), box(184, 110, 10, 10), box(150, 150, 30, 30)], size),
    { ...left, free: true }, 'and a box there too sends it left of the top-left corner');

  const line = { points: [{ x: 0, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 140 }], halfWidth: 6 };
  const segments = [
    { a: { x: 0, y: 100 }, b: { x: 200, y: 100 }, halfWidth: 6 },
    { a: { x: 200, y: 100 }, b: { x: 200, y: 140 }, halfWidth: 6 },
  ];
  assert.deepEqual(geometry.actionButtonPlace(line, segments, size), { x: 88, y: 66, free: true },
    'beside the middle of the longest segment, above a line drawn left to right, clear of its hit target');
  assert.deepEqual(geometry.actionButtonPlace(line, [...segments, box(80, 60, 40, 20)], size), { x: 88, y: 110, free: true },
    'on the other side when a box covers the first');

  const everywhere = [item, box(150, 60, 40, 20), box(184, 110, 10, 10), box(150, 150, 30, 30), box(60, 100, 20, 20)];
  assert.deepEqual(geometry.actionButtonPlace({ box: item }, everywhere, size), { ...above, free: false },
    'no free place: the first place, reported as not free');
  assert.deepEqual(geometry.actionButtonPlace(line, [...segments, box(80, 60, 40, 20), box(80, 120, 40, 20)], size),
    { x: 88, y: 66, free: false }, 'the same for a line');
});
