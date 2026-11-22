// `layout compact` for component diagrams: the drawing whose smallest text is
// largest in its pane, with nothing overlapping, every edge label by its own
// edge, and no more bends or crossings than the drawing without a layout line.
// Every geometric claim is measured from the rendered DOM (getBBox + CTM),
// never from the renderer's own scene record. "Before" is the pre-compact
// bundle (support/pre-compact-bundle.js), rendered in the same browser.

const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const CORPUS = require('./support/test-uml-components.js');
const SITE = require('./support/site-component-specs.js');
const { writePreCompactBundle } = require('./support/pre-compact-bundle');

const BUNDLE = path.join(__dirname, '../uml-bundle.js');
const BASE_FONT = 14;            // connector labels, the component type's base size
const OVERLAP_TOLERANCE = 0.5;   // design spec 6.4
const LINE_GAP = 6;              // a label within font + 6 of its edge stays with it

const BACK_EDGES = '27b. Component API Back-Edges with Shared Ports';
// Its hidden `-[hidden]r-` chain: the author's reading order of the services.
const BACK_EDGE_ORDER = ['gateway', 'auth', 'users', 'clubs', 'events', 'notifications'];
const COLUMN = { width: 600, height: 700 };
const WIDE = { width: 1200, height: 675 };

// The spec with every layout preference line replaced by `layoutLine`
// (none when empty). `left to right direction` stays.
function withLayout(spec, layoutLine) {
  const lines = spec.split('\n').filter(line => !/^\s*layout\s+\S+/.test(line) || /^\s*layout\s+(horizontal|vertical|left-to-right|top-to-bottom)\b/i.test(line));
  if (layoutLine) lines.splice(lines.findIndex(line => /^\s*@startuml/.test(line)) + 1, 0, layoutLine);
  return lines.join('\n');
}
const compactFor = (spec, pane) => withLayout(spec, `layout compact ${pane.width}x${pane.height}`);

let browser;
let previousBundle;
before(async () => {
  previousBundle = writePreCompactBundle('archuml-component-');
  browser = await chromium.launch();
});
after(async () => {
  if (browser) await browser.close();
  if (previousBundle) fs.rmSync(path.dirname(previousBundle), { recursive: true, force: true });
});

async function withPage(bundle, pane, fn) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  try {
    await page.setContent(`<html><head><title>Component compact</title></head><body><div id="diagram" style="width:${pane.width}px;height:${pane.height}px"></div></body></html>`);
    await page.addScriptTag({ path: bundle });
    return await fn(page);
  } finally {
    await page.close();
  }
}

async function renderMarkup(bundle, source, renderer = 'UMLComponentDiagram') {
  return withPage(bundle, COLUMN, page => page.evaluate(([src, name]) => {
    const container = document.getElementById('diagram');
    window[name].render(container, src);
    return container.innerHTML;
  }, [source, renderer]));
}

// Everything a test needs, in root SVG units, from the rendered DOM.
async function measure(source, pane) {
  return withPage(BUNDLE, pane, page => page.evaluate(src => {
    const container = document.getElementById('diagram');
    window.UMLComponentDiagram.render(container, src);
    const svg = container.querySelector('svg');
    const toRoot = svg.getScreenCTM().inverse();
    const vb = svg.viewBox.baseVal;
    function box(el) {
      const b = el.getBBox();
      const m = toRoot.multiply(el.getScreenCTM());
      const pts = [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]]
        .map(([x, y]) => new DOMPoint(x, y).matrixTransform(m));
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
      return { x: Math.min(...xs), y: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
    }
    function points(el) {
      const m = toRoot.multiply(el.getScreenCTM());
      return [...el.points].map(p => new DOMPoint(p.x, p.y).matrixTransform(m)).map(p => ({ x: p.x, y: p.y }));
    }
    const boxes = [...svg.querySelectorAll('rect.uml-component-box')].map(el => ({ id: el.getAttribute('data-layout-id'), ...box(el) }));
    const ports = [...svg.querySelectorAll('rect[data-layout-kind="port"]')].map(el => ({
      id: el.getAttribute('data-layout-id'), parent: el.getAttribute('data-layout-parent'), side: el.getAttribute('data-port-side'), ...box(el),
    }));
    const routes = new Map();
    svg.querySelectorAll('polyline[data-layout-route-id]').forEach(el => {
      const id = el.getAttribute('data-layout-route-id');
      const route = routes.get(id) || { id, source: null, target: null, points: [] };
      route.source = route.source || el.getAttribute('data-layout-source');
      route.target = route.target || el.getAttribute('data-layout-target');
      route.points.push(...points(el));
      routes.set(id, route);
    });
    const texts = [...svg.querySelectorAll('text')].filter(t => t.textContent.trim()).map(el => {
      const group = el.closest('g[data-layout-id^="label:"]');
      return {
        text: el.textContent.trim(),
        route: group ? group.getAttribute('data-layout-id').slice('label:'.length) : null,
        font: parseFloat(getComputedStyle(el).fontSize),
        ...box(el),
      };
    });
    return {
      width: vb.width, height: vb.height, boxes, ports, routes: [...routes.values()], texts,
      issues: svg.getAttribute('data-uml-layout-issues'),
    };
  }, source));
}

const cache = new Map();
function measured(source, pane) {
  const key = `${pane.width}x${pane.height}|${source}`;
  if (!cache.has(key)) cache.set(key, measure(source, pane));
  return cache.get(key);
}

// ───── Geometry over measured drawings ──────────────────────────────

const smallestFont = m => Math.min(...m.texts.map(t => t.font));
const onScreen = (m, pane) => smallestFont(m) * Math.min(pane.width / m.width, pane.height / m.height);

function overlaps(a, b, tol = OVERLAP_TOLERANCE) {
  return Math.min(a.right, b.right) - Math.max(a.x, b.x) > tol && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > tol;
}
function contains(outer, inner, tol = 1) {
  return inner.x >= outer.x - tol && inner.y >= outer.y - tol && inner.right <= outer.right + tol && inner.bottom <= outer.bottom + tol;
}
function inset(b, by) { return { x: b.x + by, y: b.y + by, right: b.right - by, bottom: b.bottom - by }; }

function mergeCollinear(points) {
  const out = [];
  points.forEach(p => { const q = out[out.length - 1]; if (!q || Math.hypot(p.x - q.x, p.y - q.y) > 0.01) out.push(p); });
  for (let i = 1; i < out.length - 1;) {
    const a = out[i - 1], b = out[i], c = out[i + 1];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const forward = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) > 0;
    if (Math.abs(cross) < 0.5 && forward) out.splice(i, 1); else i++;
  }
  return out;
}
const segments = pts => pts.slice(1).map((p, i) => [pts[i], p]);
const bends = m => m.routes.reduce((sum, r) => sum + Math.max(0, mergeCollinear(r.points).length - 2), 0);

function side(a, b, c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
function properCross([a, b], [c, d]) {
  const E = 0.01;
  const opposite = (u, v) => (u > E && v < -E) || (u < -E && v > E);
  return opposite(side(a, b, c), side(a, b, d)) && opposite(side(c, d, a), side(c, d, b));
}
function crossings(m) {
  let count = 0;
  for (let i = 0; i < m.routes.length; i++) {
    for (let j = i + 1; j < m.routes.length; j++) {
      for (const s of segments(m.routes[i].points)) for (const t of segments(m.routes[j].points)) if (properCross(s, t)) count++;
    }
  }
  return count;
}

// Length of segment [p, q] inside box b (Liang–Barsky).
function lengthInBox([p, q], b) {
  let t0 = 0, t1 = 1;
  const dx = q.x - p.x, dy = q.y - p.y;
  const P = [-dx, dx, -dy, dy], Q = [p.x - b.x, b.right - p.x, p.y - b.y, b.bottom - p.y];
  for (let i = 0; i < 4; i++) {
    if (P[i] === 0) { if (Q[i] < 0) return 0; continue; }
    const r = Q[i] / P[i];
    if (P[i] < 0) { if (r > t1) return 0; t0 = Math.max(t0, r); } else { if (r < t0) return 0; t1 = Math.min(t1, r); }
  }
  return Math.max(0, t1 - t0) * Math.hypot(dx, dy);
}
const routeThrough = (route, b) => segments(route.points).some(s => lengthInBox(s, b) > OVERLAP_TOLERANCE);

function pointToSegment(p, [a, b]) {
  const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y)));
}
function boxToRoute(b, route) {
  if (routeThrough(route, b)) return 0;
  const corners = [{ x: b.x, y: b.y }, { x: b.right, y: b.y }, { x: b.x, y: b.bottom }, { x: b.right, y: b.bottom }];
  let best = Infinity;
  for (const s of segments(route.points)) {
    for (const c of corners) best = Math.min(best, pointToSegment(c, s));
    for (const p of s) best = Math.min(best, Math.hypot(Math.max(b.x - p.x, 0, p.x - b.right), Math.max(b.y - p.y, 0, p.y - b.bottom)));
  }
  return best;
}

const baseId = id => (id == null ? null : String(id).split('.')[0]);
const edgeLabels = m => m.texts.filter(t => t.route);
// Texts drawn in the open: edge labels and the names of standalone ports
// and interface symbols, not the names inside a component box.
const freeTexts = m => m.texts.filter(t => t.route || !m.boxes.some(b => contains(b, t)));

// Everything that overlaps in a drawing, as readable strings.
function overlapReport(m) {
  const found = [];
  m.boxes.forEach((a, i) => m.boxes.slice(i + 1).forEach(b => { if (overlaps(a, b)) found.push(`box ${a.id} × box ${b.id}`); }));
  const free = freeTexts(m);
  free.forEach((t, i) => {
    m.boxes.forEach(b => { if (overlaps(t, b)) found.push(`"${t.text}" × box ${b.id}`); });
    free.slice(i + 1).forEach(u => { if (overlaps(t, u)) found.push(`"${t.text}" × "${u.text}"`); });
  });
  m.routes.forEach(r => {
    const ends = new Set([baseId(r.source), baseId(r.target)]);
    m.boxes.filter(b => !ends.has(b.id)).forEach(b => { if (routeThrough(r, inset(b, 2))) found.push(`${r.id} through box ${b.id}`); });
    free.filter(t => t.route !== r.id).forEach(t => { if (routeThrough(r, inset(t, 1))) found.push(`${r.id} through "${t.text}"`); });
  });
  return found;
}

// Edge labels farther than one line height from their edge, or nearer to another edge.
function detachedLabels(m) {
  const found = [];
  edgeLabels(m).forEach(label => {
    const own = m.routes.find(r => r.id === label.route);
    if (!own) { found.push(`"${label.text}" has no edge ${label.route}`); return; }
    const ownDistance = boxToRoute(label, own);
    const nearestOther = Math.min(Infinity, ...m.routes.filter(r => r !== own).map(r => boxToRoute(label, r)));
    if (ownDistance > label.font + LINE_GAP || nearestOther < ownDistance) {
      found.push(`"${label.text}" is ${ownDistance.toFixed(1)} from its edge, ${nearestOther.toFixed(1)} from another`);
    }
  });
  return found;
}

// Component names in reading order: rows top to bottom (boxes whose
// vertical extents overlap share a row), left to right within a row.
function readingOrder(m) {
  const rows = [];
  [...m.boxes].sort((a, b) => a.y - b.y).forEach(b => {
    const row = rows.find(r => r.some(o => Math.min(o.bottom, b.bottom) - Math.max(o.y, b.y) > 0));
    if (row) row.push(b); else rows.push([b]);
  });
  return rows.flatMap(row => row.sort((a, b) => a.x - b.x).map(b => b.id));
}

// ───── 27b: one long chain with back-edges to shared ports ─────────

const backEdges = pane => measured(compactFor(CORPUS[BACK_EDGES], pane), pane);
const backEdgesPlain = pane => measured(withLayout(CORPUS[BACK_EDGES], ''), pane);

// Without a layout line the chain runs in one row (4.78 px in this pane).
// Compact wraps it into rows and closes the band between them; labels that
// are paths wrap at their slashes, so the drawing is narrow enough for 11 px.
test('27b in a 600×700 pane: compact text is smaller than 11 px on screen', async () => {
  const c = await backEdges(COLUMN);
  assert.ok(onScreen(c, COLUMN) >= 11, `compact ${onScreen(c, COLUMN).toFixed(2)} px (${c.width.toFixed(0)}×${c.height.toFixed(0)})`);
});

// The empty height between two rows of components: the tallest horizontal
// strip between them that holds no text. Edges may cross it; their labels
// stack in it instead of leaving it empty.
function emptyBandsBetweenRows(m) {
  const rows = [];
  [...m.boxes].sort((a, b) => a.y - b.y).forEach(b => {
    const row = rows.find(r => r.some(o => Math.min(o.bottom, b.bottom) - Math.max(o.y, b.y) > 0));
    if (row) row.push(b); else rows.push([b]);
  });
  const bands = [];
  for (let k = 0; k + 1 < rows.length; k++) {
    const top = Math.max(...rows[k].map(b => b.bottom)), bottom = Math.min(...rows[k + 1].map(b => b.y));
    const covered = m.texts.map(t => [Math.max(top, t.y), Math.min(bottom, t.bottom)]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
    let at = top, widest = 0;
    for (const [a, b] of covered) { widest = Math.max(widest, a - at); at = Math.max(at, b); }
    bands.push(Math.max(widest, bottom - at));
  }
  return bands;
}

test('27b in a 600×700 pane: compact leaves an empty band between its rows', async () => {
  const bands = emptyBandsBetweenRows(await backEdges(COLUMN));
  const twoLines = 2 * (BASE_FONT + LINE_GAP);
  assert.ok(bands.length > 0, 'the chain is wrapped into rows');
  assert.ok(bands.every(h => h <= twoLines), `empty strips between rows: ${bands.map(h => h.toFixed(0)).join(', ')} units; at most ${twoLines}`);
});

for (const pane of [COLUMN, WIDE]) {
  const name = `27b in a ${pane.width}×${pane.height} pane`;

  test(`${name}: compact draws overlapping elements`, async () => {
    assert.deepEqual(overlapReport(await backEdges(pane)), []);
  });

  test(`${name}: compact puts an edge label away from its own edge`, async () => {
    assert.deepEqual(detachedLabels(await backEdges(pane)), []);
  });

  test(`${name}: compact has more bends or crossings than without a layout line`, async () => {
    const [c, plain] = await Promise.all([backEdges(pane), backEdgesPlain(pane)]);
    assert.ok(bends(c) <= bends(plain), `${bends(c)} bends, without a layout line ${bends(plain)}`);
    assert.ok(crossings(c) <= crossings(plain), `${crossings(c)} crossings, without a layout line ${crossings(plain)}`);
  });

  test(`${name}: compact reorders the services of the hidden chain`, async () => {
    const order = readingOrder(await backEdges(pane)).filter(id => BACK_EDGE_ORDER.includes(id));
    assert.deepEqual(order, BACK_EDGE_ORDER);
  });

  test(`${name}: an edge enters its port from a side other than the port's`, async () => {
    const m = await backEdges(pane);
    const outward = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } };
    let checked = 0;
    for (const route of m.routes) {
      const port = m.ports.find(p => p.id === route.target);
      if (!port) continue;
      const pts = mergeCollinear(route.points);
      const [prev, last] = pts.slice(-2);
      const n = outward[port.side];
      const along = (prev.x - last.x) * n.x + (prev.y - last.y) * n.y;
      const across = Math.abs((prev.x - last.x) * n.y - (prev.y - last.y) * n.x);
      assert.ok(along > 0 && across < 0.5, `${route.id} reaches ${port.id} (${port.side}) from (${prev.x.toFixed(0)}, ${prev.y.toFixed(0)}) to (${last.x.toFixed(0)}, ${last.y.toFixed(0)})`);
      checked++;
    }
    assert.equal(checked, 9, 'every edge of 27b ends at a port');
  });

  test(`${name}: compact shows text below the component base size`, async () => {
    const m = await backEdges(pane);
    const small = m.texts.filter(t => t.font < BASE_FONT).map(t => `"${t.text}" ${t.font}px`);
    assert.deepEqual(small, []);
  });

  test(`${name}: compact is flagged with layout issues`, async () => {
    assert.equal((await backEdges(pane)).issues, null);
  });
}

// ───── Every component diagram of test-uml.html, and site diagrams ──

// Requirements compact does not meet yet, by test name, with what was
// measured and why. Each stays a todo until the cause is fixed.
const KNOWN_GAPS = {};
const gap = name => (KNOWN_GAPS[name] ? { todo: KNOWN_GAPS[name] } : {});

for (const [heading, spec] of Object.entries({ ...CORPUS, ...SITE })) {
  for (const pane of [COLUMN, WIDE]) {
    const name = `${heading} in a ${pane.width}×${pane.height} pane`;
    const compact = () => measured(compactFor(spec, pane), pane);
    const plain = () => measured(withLayout(spec, ''), pane);

    test(`${name}: compact text is smaller on screen than without a layout line`, gap(`${name}: compact text is smaller on screen than without a layout line`), async () => {
      const [c, p] = await Promise.all([compact(), plain()]);
      assert.ok(onScreen(c, pane) >= onScreen(p, pane) - 1e-6, `compact ${onScreen(c, pane).toFixed(2)} px, without ${onScreen(p, pane).toFixed(2)} px`);
    });

    test(`${name}: compact draws overlapping elements`, async () => {
      assert.deepEqual(overlapReport(await compact()), []);
    });

    test(`${name}: compact puts an edge label away from its own edge`, async () => {
      assert.deepEqual(detachedLabels(await compact()), []);
    });

    // The renderer's judge also sees note shapes, which the DOM report above
    // does not: a drawing it could not make overlap-free carries the flag.
    test(`${name}: compact is flagged with layout issues`, gap(`${name}: compact is flagged with layout issues`), async () => {
      assert.equal((await compact()).issues, null);
    });

    test(`${name}: compact has more bends or crossings than without a layout line`, async () => {
      const [c, p] = await Promise.all([compact(), plain()]);
      assert.ok(bends(c) <= bends(p), `${bends(c)} bends, without ${bends(p)}`);
      assert.ok(crossings(c) <= crossings(p), `${crossings(c)} crossings, without ${crossings(p)}`);
    });

    test(`${name}: compact uses a font smaller than the drawing without a layout line`, async () => {
      const [c, p] = await Promise.all([compact(), plain()]);
      assert.ok(smallestFont(c) >= smallestFont(p), `compact ${smallestFont(c)} px, without ${smallestFont(p)} px`);
    });
  }
}

// The judge measures a label from the box it records; the reader sees the
// glyphs. In this pane the Therac-25 label "may inhibit" was placed by the
// fallback 19 units from its line by the recorded box and 21 by its glyphs.
test('Therac-25 layers in a 600×750 pane: compact puts an edge label away from its own edge', async () => {
  const pane = { width: 600, height: 750 };
  const m = await measured(compactFor(SITE['Therac-25 layers (_data/narration_visuals/therac25.json)'], pane), pane);
  assert.deepEqual(detachedLabels(m), []);
});

// ───── Determinism, the worker, and unchanged output elsewhere ─────

test('compact renders the same SVG twice', async () => {
  const source = compactFor(CORPUS[BACK_EDGES], COLUMN);
  assert.equal(await renderMarkup(BUNDLE, source), await renderMarkup(BUNDLE, source));
});

test('compact renders SVG text where there is no DOM, as in the worker', () => {
  const { loadBundle } = require('./support/load-bundle.js');
  const window = loadBundle();
  window.getComputedStyle = () => ({ getPropertyValue: () => '' });
  let markup = '';
  const container = {
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 600, height: 700, top: 0, left: 0, right: 600, bottom: 700 }; },
    clientWidth: 600,
    clientHeight: 700,
    getAttribute() { return null; },
    setAttribute() {},
    removeAttribute() {},
    hasAttribute() { return false; },
    get innerHTML() { return markup; },
    set innerHTML(value) { markup = value; },
  };
  for (const heading of ['40. Component Diagram with Note', BACK_EDGES]) {
    markup = '';
    window.UMLComponentDiagram.render(container, compactFor(CORPUS[heading], COLUMN));
    assert.match(markup, /^<svg[\s\S]*<\/svg>\s*$/, heading);
    assert.match(markup, /uml-component-box/, heading);
  }
});

test('component diagrams without layout compact render byte-identically to before', async () => {
  for (const spec of Object.values(CORPUS)) {
    const source = withLayout(spec, '');
    assert.equal(await renderMarkup(BUNDLE, source), await renderMarkup(previousBundle, source));
  }
});

test('the authored layout preference of a component spec renders byte-identically to before', async () => {
  const source = CORPUS[BACK_EDGES];
  assert.match(source, /layout landscape/);
  assert.equal(await renderMarkup(BUNDLE, source), await renderMarkup(previousBundle, source));
});

test('a compact component spec with an @layout block renders byte-identically to before', async () => {
  const source = `@startuml
layout compact
component Client
component Server
Client --> Server : request
@layout
pos Client 40 40
pos Server 320 40
@endlayout
@enduml`;
  assert.equal(await renderMarkup(BUNDLE, source), await renderMarkup(previousBundle, source));
});
