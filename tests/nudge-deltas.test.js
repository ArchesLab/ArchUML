'use strict';

// The shifts the class and component nudge passes try for a box
// (UMLShared.distinctNudgeDeltas): each candidate clamped to the shift limit
// and to the room beside its neighbours, every distinct shift once, so no
// shift is routed and scored twice.

const assert = require('assert/strict');
const test = require('node:test');
const { loadBundle } = require('./support/load-bundle');

const { UMLShared } = loadBundle();

// Copied into this realm: the bundle runs in its own vm context.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('nudge shifts are clamped to both limits, in candidate order, each once', () => {
  assert.deepEqual(plain(UMLShared.distinctNudgeDeltas([30, 200, -200, 90, 30, -10], 80, -50, 60)), [30, 60, -50, -10]);
});

test('nudge shifts drop non-finite and sub-pixel candidates', () => {
  assert.deepEqual(plain(UMLShared.distinctNudgeDeltas([0.4, -0.99, 1, NaN, -1], Infinity, -Infinity, Infinity)), [1, -1]);
});
