'use strict';

// The memo of finished compact drawings: a repeated render with the same
// inputs gives the same markup without searching again, and a render whose
// inputs changed (spec, pane, colours, text measurement) gives exactly what a
// fresh render gives. Renders run as in the worker: no DOM, stub text
// measurement (support/load-bundle.js).

const assert = require('assert/strict');
const test = require('node:test');
const { loadBundle } = require('./support/load-bundle');

// ───── The memo ───────────────────────────────────────────────────────

function counting(value) {
  const compute = () => { compute.calls++; return value; };
  compute.calls = 0;
  return compute;
}

test('a remembered key is computed once and gives the same value again', () => {
  const { UMLCompactMemo } = loadBundle();
  const compute = counting('<svg/>');
  assert.equal(UMLCompactMemo.remember('k', compute), '<svg/>');
  assert.equal(UMLCompactMemo.remember('k', compute), '<svg/>');
  assert.equal(compute.calls, 1);
});

test('a different key is computed on its own', () => {
  const { UMLCompactMemo } = loadBundle();
  UMLCompactMemo.remember('a', counting('A'));
  const compute = counting('B');
  assert.equal(UMLCompactMemo.remember('b', compute), 'B');
  assert.equal(compute.calls, 1);
});

test('at the limit the least recently used entry is dropped, and one used since survives', () => {
  const { UMLCompactMemo } = loadBundle();
  const keys = Array.from({ length: UMLCompactMemo.LIMIT }, (_, i) => `k${i}`);
  keys.forEach((key) => UMLCompactMemo.remember(key, counting(key)));
  UMLCompactMemo.remember('k0', counting('k0'));        // k0 is now the most recently used
  UMLCompactMemo.remember('one more', counting('x'));   // over the limit: k1 is the oldest
  const k0 = counting('k0'), k1 = counting('k1');
  UMLCompactMemo.remember('k0', k0);
  UMLCompactMemo.remember('k1', k1);
  assert.deepEqual([k0.calls, k1.calls], [0, 1]);
});

test('a compute that throws is not remembered: the next call computes again', () => {
  const { UMLCompactMemo } = loadBundle();
  assert.throws(() => UMLCompactMemo.remember('k', () => { throw new Error('no drawing'); }), /no drawing/);
  const compute = counting('<svg/>');
  assert.equal(UMLCompactMemo.remember('k', compute), '<svg/>');
  assert.equal(compute.calls, 1);
});

test('a null key is never remembered', () => {
  const { UMLCompactMemo } = loadBundle();
  const compute = counting('<svg/>');
  UMLCompactMemo.remember(null, compute);
  UMLCompactMemo.remember(null, compute);
  assert.equal(compute.calls, 2);
});

test('equal inputs give equal keys and different inputs different keys', () => {
  const { UMLCompactMemo } = loadBundle();
  const key = (pane) => UMLCompactMemo.keyOf('class', { spec: { classes: ['A'] }, pane });
  assert.equal(key({ width: 600, height: 750 }), key({ width: 600, height: 750 }));
  assert.notEqual(key({ width: 600, height: 750 }), key({ width: 601, height: 750 }));
  assert.notEqual(UMLCompactMemo.keyOf('class', { a: 1 }), UMLCompactMemo.keyOf('state', { a: 1 }));
});

test('inputs that JSON cannot write down faithfully give no key', () => {
  const { UMLCompactMemo } = loadBundle();
  [() => 1, NaN, Infinity, new Map([[1, 2]]), [1, undefined]].forEach((value) => {
    assert.equal(UMLCompactMemo.keyOf('class', { value }), null, String(value));
  });
});

test('the key changes when text measurement changes', () => {
  let unit = 8;
  const { UMLCompactMemo } = loadBundle({ measureText: (text) => ({ width: String(text).length * unit }) });
  const before = UMLCompactMemo.keyOf('class', { a: 1 });
  unit = 9;
  assert.notEqual(UMLCompactMemo.keyOf('class', { a: 1 }), before);
});

// ───── Renderers ──────────────────────────────────────────────────────

const CLASS = `@startuml
layout compact 600x750
abstract class Creator {
    + {abstract} factoryMethod(): Product
    + operation()
}
interface Product {
}
class ConcreteCreator {
    + factoryMethod(): Product
}
class ConcreteProduct {
}
ConcreteCreator --|> Creator
ConcreteProduct ..|> Product
Creator --> Product : product
ConcreteCreator ..> ConcreteProduct : <<create>>
callout left of text "operation()" : Creator code: uses products without naming a concrete class
callout top of text "Product" : Product: the interface creator code depends on
@enduml`;

const STATE = (extra = '') => `@startuml
layout compact 600x750
[*] --> Locked
Locked --> Unlocked : badgeRead [authorized] / releaseLock()
Unlocked --> Locked : timeout
${extra}
callout right of text "[authorized]" : Guard: must be true when the event is handled
@enduml`;

const COMPONENT = `@startuml
layout compact 600x750
component Client
component Server
component Database
Client --> Server : request
Server --> Database : query
callout bottom of text "Server" : Server: answers every request
@enduml`;

const SEQUENCE = `@startuml
layout compact 600x750
participant client: Client
participant server: LibraryServer
client -> server: findBook()
server --> client: book
callout right of edge 1 end : Synchronous call: the sender waits for completion
@enduml`;

const RENDERERS = { class: 'UMLClassDiagram', state: 'UMLStateDiagram', component: 'UMLComponentDiagram', sequence: 'UMLSequenceDiagram' };

// The container shape js/uml-worker.js hands to a renderer; its svg records
// the attributes a renderer sets on it.
function workerContainer() {
  let markup = '';
  const svgAttributes = {};
  const svg = {
    setAttribute(name, value) { svgAttributes[name] = value; },
    getAttribute(name) { return name in svgAttributes ? svgAttributes[name] : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  return {
    svgAttributes,
    markup: () => markup,
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() { return null; },
    querySelector(selector) { return selector === 'svg' && markup.startsWith('<svg') ? svg : null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 600, height: 750, top: 0, left: 0, right: 600, bottom: 750 }; },
    clientWidth: 600,
    clientHeight: 750,
    getAttribute() { return null; },
    setAttribute() {},
    removeAttribute() {},
    hasAttribute() { return false; },
    get innerHTML() { return markup; },
    set innerHTML(value) { markup = value; },
  };
}

/** A bundle as the worker runs it, with the theme `css` (CSS variable values). */
function workerBundle(options) {
  const window = loadBundle(options);
  window.theme = {};
  window.getComputedStyle = () => ({ getPropertyValue: (name) => window.theme[name] || '' });
  return window;
}

function render(window, type, spec) {
  const container = workerContainer();
  window[RENDERERS[type]].render(container, spec);
  return container.markup();
}

// Counts the searches (UMLCompactLayout.optimize) or, for the sequence
// renderer, which draws in one pass, its compact callout placements.
function countSearches(window, type) {
  const counter = { calls: 0 };
  const owner = type === 'sequence' ? window.UMLCallouts : window.UMLCompactLayout;
  const name = type === 'sequence' ? 'drawCompact' : 'optimize';
  const original = owner[name];
  owner[name] = function () { counter.calls++; return original.apply(this, arguments); };
  return counter;
}

// What a render gives with nothing remembered.
function freshRender(window, type, spec) {
  window.UMLCompactMemo.forget();
  return render(window, type, spec);
}

for (const [type, spec] of Object.entries({ class: CLASS, state: STATE(), component: COMPONENT, sequence: SEQUENCE })) {
  test(`rendering the same compact ${type} spec twice searches once and gives the same markup`, () => {
    const window = workerBundle();
    const searches = countSearches(window, type);
    const first = render(window, type, spec);
    const second = render(window, type, spec);
    assert.match(first, /class="uml-callout"/);
    assert.equal(second, first);
    assert.equal(searches.calls, 1);
  });
}

test('a compact component render for another pane gives what a fresh render gives', () => {
  const inPane = (pane) => COMPONENT.replace('layout compact 600x750', `layout compact ${pane}`);
  const window = workerBundle();
  const column = render(window, 'component', inPane('300x1200'));
  const wide = render(window, 'component', inPane('2000x300'));
  assert.notEqual(wide, column, 'the pane changes the drawing');
  assert.equal(wide, freshRender(window, 'component', inPane('2000x300')));
});

test('a compact state render of a changed spec gives what a fresh render gives', () => {
  const window = workerBundle();
  render(window, 'state', STATE());
  const changed = render(window, 'state', STATE('Unlocked --> [*] : shutdown'));
  assert.equal(changed, freshRender(window, 'state', STATE('Unlocked --> [*] : shutdown')));
});

test('a compact component render in other colours gives what a fresh render gives', () => {
  const window = workerBundle();
  const plain = render(window, 'component', COMPONENT);
  window.theme['--uml-stroke'] = '#aa0000';
  const red = render(window, 'component', COMPONENT);
  assert.notEqual(red, plain, 'the colours change the drawing');
  assert.equal(red, freshRender(window, 'component', COMPONENT));
});

test('a compact render after text measurement changed (a web font loaded) gives what a fresh render gives', () => {
  let unit = 8;
  const window = workerBundle({ measureText: (text) => ({ width: String(text).length * unit }) });
  const before = render(window, 'class', CLASS);
  unit = 9;
  const after = render(window, 'class', CLASS);
  assert.notEqual(after, before, 'the measurement changes the drawing');
  assert.equal(after, freshRender(window, 'class', CLASS));
});

test('a compact render that fails is not remembered', () => {
  const window = workerBundle();
  const searches = countSearches(window, 'class');
  const broken = CLASS.replace('callout top of text "Product"', 'callout top of text "Nowhere"');
  assert.throws(() => render(window, 'class', broken), /Callout target not found/);
  assert.throws(() => render(window, 'class', broken), /Callout target not found/);
  assert.equal(searches.calls, 2);
});

test('a remembered compact drawing is marked with its layout issues like a fresh one, and warns once', () => {
  // The layers diagram keeps an overlap in this pane when text measures 8
  // units per character.
  const spec = require('./support/site-component-specs')['layers (SEBook/architectural_styles/layers.md)']
    .replace('@startuml', '@startuml\nlayout compact 600x750');
  const window = workerBundle();
  const warnings = [];
  window.console = { ...console, warn: (message) => warnings.push(message) };
  const first = workerContainer(), second = workerContainer();
  window.UMLComponentDiagram.render(first, spec);
  window.UMLComponentDiagram.render(second, spec);
  const issues = first.svgAttributes['data-uml-layout-issues'];
  assert.ok(Number(issues) > 0, 'the drawing keeps an overlap (the premise of this test)');
  assert.equal(second.svgAttributes['data-uml-layout-issues'], issues);
  assert.equal(warnings.length, 1);
});
