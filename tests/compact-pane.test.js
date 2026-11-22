'use strict';

const assert = require('assert/strict');
const test = require('node:test');
const { loadBundle } = require('./support/load-bundle');

const win = loadBundle();
const { UMLShared, UMLLayoutCore } = win;

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function fakeContainer({ clientWidth, rectWidth = clientWidth, rectHeight }) {
  return {
    clientWidth,
    getBoundingClientRect() { return { width: rectWidth, height: rectHeight }; },
  };
}

// ── parseLayoutDirective: pane ────────────────────────────────────────

test('bare layout compact asks for compact with no pane', () => {
  const directive = UMLShared.parseLayoutDirective('layout compact');
  assert.equal(directive.layoutPreference, 'compact');
  assert.equal(directive.pane, null);
});

test('layout compact WxH carries the pane size', () => {
  const directive = UMLShared.parseLayoutDirective('layout compact 600x700');
  assert.equal(directive.layoutPreference, 'compact');
  assert.deepEqual(plain(directive.pane), { width: 600, height: 700 });
});

for (const line of ['layout compact 0x700', 'layout compact axb', 'layout compact 600x']) {
  test(`"${line}" keeps compact but ignores the unusable size`, () => {
    const directive = UMLShared.parseLayoutDirective(line);
    assert.equal(directive.layoutPreference, 'compact');
    assert.equal(directive.pane, null);
  });
}

test('directives other than compact report no pane', () => {
  assert.equal(UMLShared.parseLayoutDirective('layout landscape').pane, null);
  assert.equal(UMLShared.parseLayoutDirective('layout lr').pane, null);
  assert.equal(UMLShared.parseLayoutDirective('layout shadows off').pane, null);
});

test('a size after a preference other than compact is still rejected', () => {
  assert.equal(UMLShared.parseLayoutDirective('layout landscape 600x700'), null);
});

// ── resolvePane ───────────────────────────────────────────────────────

test('a pane given in the spec wins over the container', () => {
  const container = fakeContainer({ clientWidth: 500, rectHeight: 400 });
  assert.deepEqual(plain(UMLLayoutCore.resolvePane(container, { width: 600, height: 700 })),
    { width: 600, height: 700, source: 'spec' });
});

test('a spec pane is used when there is no container', () => {
  assert.deepEqual(plain(UMLLayoutCore.resolvePane(null, { width: 600, height: 700 })),
    { width: 600, height: 700, source: 'spec' });
});

test('with neither spec nor container the pane is the 900x600 default', () => {
  assert.deepEqual(plain(UMLLayoutCore.resolvePane(null, null)),
    { width: 900, height: 600, source: 'default' });
});

test('a measurable container gives its client width and own height', () => {
  const container = fakeContainer({ clientWidth: 500, rectHeight: 400 });
  assert.deepEqual(plain(UMLLayoutCore.resolvePane(container, null)),
    { width: 500, height: 400, source: 'container' });
});

test('a collapsed container takes the window height less 24', () => {
  const container = fakeContainer({ clientWidth: 500, rectHeight: 0 });
  win.innerHeight = 800;
  try {
    assert.deepEqual(plain(UMLLayoutCore.resolvePane(container, null)),
      { width: 500, height: 776, source: 'container' });
  } finally {
    delete win.innerHeight;
  }
});

test('a collapsed container without a window height takes the default height', () => {
  const container = fakeContainer({ clientWidth: 500, rectHeight: 0 });
  assert.deepEqual(plain(UMLLayoutCore.resolvePane(container, null)),
    { width: 500, height: 600, source: 'container' });
});

test('a container with no usable width falls back to the default pane', () => {
  const container = fakeContainer({ clientWidth: 0, rectWidth: 0, rectHeight: 400 });
  assert.deepEqual(plain(UMLLayoutCore.resolvePane(container, null)),
    { width: 900, height: 600, source: 'default' });
});

// ── renderer parse loops keep the pane ────────────────────────────────

test('the class parser keeps the pane named by layout compact', () => {
  const parsed = win.UMLClassDiagram.parse('layout compact 600x700\nclass A\nclass B\nA --> B');
  assert.equal(parsed.layoutPreference, 'compact');
  assert.deepEqual(plain(parsed.pane), { width: 600, height: 700 });
});

test('the class parser drops the pane when a later direction overrides compact', () => {
  const parsed = win.UMLClassDiagram.parse('layout compact 600x700\nlayout lr\nclass A');
  assert.equal(parsed.pane, null);
});

test('the state parser keeps the pane named by layout compact', () => {
  const parsed = win.UMLStateDiagram.parse('layout compact 600x750\n[*] --> Idle\nIdle --> Busy : go');
  assert.equal(parsed.layoutPreference, 'compact');
  assert.deepEqual(plain(parsed.pane), { width: 600, height: 750 });
});
