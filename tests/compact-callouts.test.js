// Teaching callouts in `layout compact` drawings. The compact search must see
// the callouts it will draw: their text is set at the diagram's compact base
// size, the drawing the search judged is the drawing the page shows, and the
// callouts are placed without page layout (as in the worker or a hidden
// tab). Geometry is measured from the rendered DOM (getBBox + CTM), never
// from the renderer's scene record.

const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const path = require('node:path');
const { chromium } = require('playwright');
const { loadBundle } = require('./support/load-bundle');

const BUNDLE = path.join(__dirname, '../uml-bundle.js');

// SEBook/designpatterns/factory_method.md: a note, an `occurrence`, and
// targets on member text, a class name and an interface name.
const FACTORY_METHOD = `abstract class Creator {
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
note right of Creator
  product =
  factoryMethod();
end note
callout left of text "factoryMethod(): Product" occurrence 1 : Factory method: the hook a subclass overrides
callout left of text "operation()" : Creator code: uses products without naming a concrete class
callout bottom of text "ConcreteCreator" : Concrete creator: picks which product class to create
callout top of text "Product" : Product: the interface creator code depends on`;

// SEBook/uml_state_diagram.md: edge targets and text inside a longer label.
const TURNSTILE = `[*] --> Locked
Locked --> Unlocked : badgeRead [authorized] / releaseLock()
Unlocked --> [*] : sessionEnded
callout left of edge 1 start : Initial pseudostate: execution starts here and moves on
callout left of text "badgeRead" : Trigger: an event that may fire this transition
callout right of text "[authorized]" : Guard: must be true when the event is handled
callout left of text "releaseLock()" : Effect: behavior run when the transition fires
callout right of edge 3 end : Final state: this region has completed`;

// SEBook/uml_sequence_diagram.md: one callout per message kind.
const MESSAGES = `participant client: Client
participant server: LibraryServer
client -> server: findBook()
server --> client: book
client ->> server: reserveBook()
o-> server: availabilityChanged
callout right of edge 1 end : Synchronous call: the sender waits for completion
callout left of edge 2 end : Reply: returns control and any results
callout right of edge 3 end : Asynchronous message: the sender continues at once
callout right of edge 4 start : Found message: its sender is outside this interaction`;

const RENDERERS = { class: 'UMLClassDiagram', state: 'UMLStateDiagram', sequence: 'UMLSequenceDiagram' };
const source = (directive, body) => `@startuml\n${directive ? directive + '\n' : ''}${body}\n@enduml`;
const calloutCount = body => body.split('\n').filter(line => /^callout\s/.test(line)).length;
const withoutCallouts = body => body.split('\n').filter(line => !/^callout\s/.test(line)).join('\n');

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { if (browser) await browser.close(); });

async function withPage(fn) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  try {
    await page.setContent('<html><head><title>Compact callouts</title></head><body></body></html>');
    await page.addStyleTag({ path: path.join(__dirname, '../css/callouts.css') });
    await page.addScriptTag({ path: BUNDLE });
    return await fn(page);
  } finally {
    await page.close();
  }
}

/**
 * Renders into a pane-sized container (hidden while rendering when asked,
 * shown before measuring) and reads back, in root SVG units: the callouts
 * (box, text font, pointer tip), the model's boxes, texts and routes, the
 * viewBox, and the scene of the drawing the compact search chose.
 */
function measure(type, src, { hidden = false } = {}) {
  return withPage(page => page.evaluate(({ renderer, text, hidden }) => {
    // A closed tab: the renderer shows its own container, not its host.
    const host = document.createElement('div');
    if (hidden) host.style.display = 'none';
    const container = document.createElement('div');
    container.style.cssText = 'width:600px;height:750px';
    host.appendChild(container);
    document.body.appendChild(host);

    // The scene of the drawing the compact search returned (class, state),
    // or the scene the sequence renderer judged.
    let chosenScene = null;
    const optimize = window.UMLCompactLayout.optimize;
    window.UMLCompactLayout.optimize = (adapter, pane) => {
      const result = optimize(adapter, pane);
      chosenScene = result.scene;
      return result;
    };
    const evaluate = window.UMLLayoutQuality.evaluate;
    window.UMLLayoutQuality.evaluate = (scene, pane) => {
      if (renderer === 'UMLSequenceDiagram') chosenScene = scene;
      return evaluate(scene, pane);
    };
    window[renderer].render(container, text);
    const calloutsWhileHidden = container.querySelectorAll('.uml-callout').length;
    host.style.display = 'block';

    const svg = container.querySelector('svg');
    const toSvg = svg.getScreenCTM().inverse();
    const vb = svg.viewBox.baseVal;
    function box(el) {
      const b = el.getBBox();
      const m = toSvg.multiply(el.getScreenCTM());
      const p = new DOMPoint(b.x, b.y).matrixTransform(m);
      const q = new DOMPoint(b.x + b.width, b.y + b.height).matrixTransform(m);
      return { x: p.x, y: p.y, width: q.x - p.x, height: q.y - p.y };
    }
    function points(el) {
      const m = toSvg.multiply(el.getScreenCTM());
      const raw = el.tagName === 'line'
        ? [{ x: el.x1.baseVal.value, y: el.y1.baseVal.value }, { x: el.x2.baseVal.value, y: el.y2.baseVal.value }]
        : [...el.points];
      return raw.map(pt => new DOMPoint(pt.x, pt.y).matrixTransform(m)).map(pt => ({ x: pt.x, y: pt.y }));
    }
    const font = el => parseFloat(getComputedStyle(el).fontSize);
    const inModel = el => !el.closest('.uml-callouts');
    const callouts = [...svg.querySelectorAll('.uml-callout')].map(group => {
      const pointer = points(group.querySelector('.uml-callout-pointer'));
      return {
        box: box(group.querySelector('.uml-callout-box')),
        font: font(group.querySelector('text')),
        tip: pointer[1],
      };
    });
    const boxes = [...svg.querySelectorAll('[data-layout-bounds-id], .uml-note-box')].filter(inModel).map(el => ({
      id: el.getAttribute('data-layout-bounds-id') || 'note', ...box(el),
    }));
    const texts = [...svg.querySelectorAll('text')].filter(el => inModel(el) && el.textContent.trim()).map(el => ({
      text: el.textContent.replace(/\s+/g, ' ').trim(), font: font(el), ...box(el),
    }));
    const routes = [...svg.querySelectorAll('polyline[data-layout-route-id], line[data-layout-route-id], polyline.uml-class-hierarchy-route')]
      .filter(inModel).map(el => ({ id: el.getAttribute('data-layout-route-id'), points: points(el) }));
    return {
      calloutsWhileHidden, callouts, boxes, texts, routes,
      viewBox: { x: vb.x, y: vb.y, width: vb.width, height: vb.height },
      scene: chosenScene && { width: chosenScene.width, height: chosenScene.height, smallestFont: chosenScene.smallestFont },
    };
  }, { renderer: RENDERERS[type], text: src, hidden }));
}

function overlaps(a, b) {
  return Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0.5 &&
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0.5;
}

function inside(inner, outer) {
  return inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 &&
    inner.x + inner.width <= outer.x + outer.width + 0.5 && inner.y + inner.height <= outer.y + outer.height + 0.5;
}

// Length of the segment p–q inside the box (Liang–Barsky).
function lengthInBox(p, q, b) {
  let t0 = 0, t1 = 1;
  const dx = q.x - p.x, dy = q.y - p.y;
  const P = [-dx, dx, -dy, dy], Q = [p.x - b.x, b.x + b.width - p.x, p.y - b.y, b.y + b.height - p.y];
  for (let i = 0; i < 4; i++) {
    if (P[i] === 0) { if (Q[i] < 0) return 0; continue; }
    const r = Q[i] / P[i];
    if (P[i] < 0) { if (r > t1) return 0; t0 = Math.max(t0, r); } else { if (r < t0) return 0; t1 = Math.min(t1, r); }
  }
  return Math.max(0, t1 - t0) * Math.hypot(dx, dy);
}

function routeThrough(route, b) {
  for (let i = 1; i < route.points.length; i++) if (lengthInBox(route.points[i - 1], route.points[i], b) > 0.5) return true;
  return false;
}

function distanceToBox(p, b) {
  return Math.hypot(Math.max(b.x - p.x, 0, p.x - b.x - b.width), Math.max(b.y - p.y, 0, p.y - b.y - b.height));
}

function bends(drawing) {
  let count = 0;
  for (const route of drawing.routes) {
    for (let i = 2; i < route.points.length; i++) {
      const a = route.points[i - 2], b = route.points[i - 1], c = route.points[i];
      if (Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) > 1e-6) count++;
    }
  }
  return count;
}

// What a reader of a compact drawing with callouts may rely on: every
// callout is inside the picture, covers no box, text, route or other
// callout, and points at something drawn right next to its tip.
function assertCalloutsPlaced(drawing, expected) {
  assert.equal(drawing.callouts.length, expected, 'every callout is drawn');
  drawing.callouts.forEach((c, i) => {
    assert.ok(inside(c.box, drawing.viewBox), `callout ${i} lies inside the picture`);
    drawing.boxes.forEach(b => assert.ok(!overlaps(c.box, b), `callout ${i} covers box ${b.id}`));
    drawing.texts.forEach(t => assert.ok(!overlaps(c.box, t), `callout ${i} covers "${t.text}"`));
    drawing.routes.forEach(r => assert.ok(!routeThrough(r, c.box), `route ${r.id} runs through callout ${i}`));
    drawing.callouts.forEach((d, j) => { if (j > i) assert.ok(!overlaps(c.box, d.box), `callouts ${i} and ${j} overlap`); });
    const nearest = Math.min(...drawing.texts.map(t => distanceToBox(c.tip, t)), ...drawing.boxes.map(b => distanceToBox(c.tip, b)),
      ...drawing.routes.flatMap(r => r.points.slice(1).map((q, k) => segmentDistance(c.tip, r.points[k], q))));
    assert.ok(nearest <= 8, `callout ${i}'s pointer ends ${nearest.toFixed(1)} from anything drawn`);
  });
}

function segmentDistance(p, a, b) {
  const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y)));
}

// The drawing the compact search scored is the drawing on the page: same
// size, and the smallest text it counted is the smallest text drawn.
function assertJudgedIsShown(drawing) {
  assert.ok(drawing.scene, 'the compact search ran');
  assert.ok(Math.abs(drawing.scene.width - drawing.viewBox.width) <= 1,
    `judged width ${drawing.scene.width} vs drawn ${drawing.viewBox.width}`);
  assert.ok(Math.abs(drawing.scene.height - drawing.viewBox.height) <= 1,
    `judged height ${drawing.scene.height} vs drawn ${drawing.viewBox.height}`);
  const smallestDrawn = Math.min(...drawing.texts.map(t => t.font), ...drawing.callouts.map(c => c.font));
  assert.equal(drawing.scene.smallestFont, smallestDrawn);
}

// ───── Class ──────────────────────────────────────────────────────────

test('compact class callouts are set at the member text size', async () => {
  const drawing = await measure('class', source('layout compact 600x750', FACTORY_METHOD));
  const member = drawing.texts.find(t => t.text === '+operation()');
  assert.ok(drawing.callouts.length > 0);
  drawing.callouts.forEach(c => assert.equal(c.font, member.font));
});

test('the compact class drawing the search judged, callouts included, is the drawing shown', async () => {
  assertJudgedIsShown(await measure('class', source('layout compact 600x750', FACTORY_METHOD)));
});

test('compact class callouts are placed without page layout, inside the picture and clear of the model', async () => {
  const drawing = await measure('class', source('layout compact 600x750', FACTORY_METHOD), { hidden: true });
  assert.equal(drawing.calloutsWhileHidden, calloutCount(FACTORY_METHOD), 'callouts exist before the page lays the drawing out');
  assertCalloutsPlaced(drawing, calloutCount(FACTORY_METHOD));
});

test('callouts cost a compact class drawing no bends', async () => {
  const withCallouts = await measure('class', source('layout compact 600x750', FACTORY_METHOD), { hidden: true });
  const plain = await measure('class', source('layout compact 600x750', withoutCallouts(FACTORY_METHOD)));
  assert.equal(withCallouts.calloutsWhileHidden, calloutCount(FACTORY_METHOD));
  assert.ok(bends(withCallouts) <= bends(plain), `${bends(withCallouts)} bends with callouts, ${bends(plain)} without`);
});

// ───── State ──────────────────────────────────────────────────────────

test('compact state callouts are set at the transition label size', async () => {
  const drawing = await measure('state', source('layout compact 600x750', TURNSTILE));
  const label = drawing.texts.find(t => t.text === 'sessionEnded');
  assert.equal(drawing.callouts.length, calloutCount(TURNSTILE));
  drawing.callouts.forEach(c => assert.equal(c.font, label.font));
});

test('the compact state drawing the search judged, callouts included, is the drawing shown', async () => {
  assertJudgedIsShown(await measure('state', source('layout compact 600x750', TURNSTILE)));
});

test('compact state callouts are placed without page layout, inside the picture and clear of the model', async () => {
  const drawing = await measure('state', source('layout compact 600x750', TURNSTILE), { hidden: true });
  assert.equal(drawing.calloutsWhileHidden, calloutCount(TURNSTILE));
  assertCalloutsPlaced(drawing, calloutCount(TURNSTILE));
});

// ───── Sequence ───────────────────────────────────────────────────────

test('compact sequence callouts are never smaller than the message text or the usual callout size', async () => {
  const compact = await measure('sequence', source('layout compact 600x750', MESSAGES));
  const usual = await measure('sequence', source('', MESSAGES));
  const message = compact.texts.find(t => t.text === 'findBook()');
  compact.callouts.forEach(c => assert.ok(c.font >= Math.max(message.font, usual.callouts[0].font)));
  assert.equal(compact.callouts.length, calloutCount(MESSAGES));
});

test('the compact sequence drawing the renderer judged, callouts included, is the drawing shown', async () => {
  assertJudgedIsShown(await measure('sequence', source('layout compact 600x750', MESSAGES)));
});

test('compact sequence callouts are placed without page layout, inside the picture and clear of the model', async () => {
  const drawing = await measure('sequence', source('layout compact 600x750', MESSAGES), { hidden: true });
  assert.equal(drawing.calloutsWhileHidden, calloutCount(MESSAGES));
  assertCalloutsPlaced(drawing, calloutCount(MESSAGES));
});

// ───── Worker ─────────────────────────────────────────────────────────

// The container shape js/uml-worker.js hands to a renderer: no layout.
function workerContainer() {
  let markup = '';
  return {
    markup: () => markup,
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() { return null; },
    querySelector() { return null; },
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

test('compact drawings carry their callouts where there is no DOM, as in the worker', () => {
  const window = loadBundle();
  window.getComputedStyle = () => ({ getPropertyValue: () => '' });
  for (const [type, body] of [['class', FACTORY_METHOD], ['state', TURNSTILE], ['sequence', MESSAGES]]) {
    const container = workerContainer();
    window[RENDERERS[type]].render(container, source('layout compact 600x750', body));
    const drawn = (container.markup().match(/class="uml-callout"/g) || []).length;
    assert.equal(drawn, calloutCount(body), `${type}: callouts in the worker's markup`);
    assert.doesNotMatch(container.markup(), /data-uml-callouts=/, `${type}: nothing is left for the page to place`);
  }
});
