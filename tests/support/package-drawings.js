'use strict';

const { readRenderedRoutes } = require('./rendered-routes');

// What a reader can check of a class or component drawing with packages,
// measured from the rendered SVG in the browser (getBBox and the CTM, in the
// SVG's own user units), and the checks themselves as plain functions. The
// expected package structure is given by the test, never read from the
// renderer, so a renderer that loses a member cannot also hide it.

/**
 * Render `source` with `renderer` into a `pane`-sized element of `page` and
 * measure it. `page` has the bundle loaded.
 */
async function measurePackageDrawing(page, renderer, source, pane) {
  const drawing = await page.evaluate(({ renderer, source, pane }) => {
    const host = document.getElementById('diagram');
    host.style.width = pane.width + 'px';
    host.style.height = pane.height + 'px';
    const started = performance.now();
    window[renderer].render(host, source);
    const ms = performance.now() - started;
    const svg = host.querySelector('svg');
    const toSvg = svg.getScreenCTM().inverse();
    const box = (el) => {
      const b = el.getBBox();
      const m = toSvg.multiply(el.getScreenCTM());
      const p = new DOMPoint(b.x, b.y).matrixTransform(m);
      const q = new DOMPoint(b.x + b.width, b.y + b.height).matrixTransform(m);
      return { x: p.x, y: p.y, width: q.x - p.x, height: q.y - p.y };
    };
    const vb = svg.viewBox.baseVal;
    return {
      ms,
      issues: svg.getAttribute('data-uml-layout-issues'),
      viewBox: { x: vb.x, y: vb.y, width: vb.width, height: vb.height },
      boxes: [...svg.querySelectorAll('rect[data-layout-bounds-id]:not([data-layout-kind="port"])')]
        .map((el) => ({ id: el.getAttribute('data-layout-bounds-id'), ...box(el) })),
      notes: [...svg.querySelectorAll('.uml-note-box')].map((el) => box(el)),
      packages: [...svg.querySelectorAll('g[data-uml-package]')].map((group) => ({
        id: group.getAttribute('data-uml-package'),
        body: box(group.querySelector('[data-package-part="body"]')),
        tab: box(group.querySelector('[data-package-part="tab"]')),
      })),
      texts: [...svg.querySelectorAll('text')].filter((el) => el.textContent.trim())
        .map((el) => ({ text: el.textContent, size: Number(el.getAttribute('font-size')) || parseFloat(getComputedStyle(el).fontSize), box: box(el) })),
    };
  }, { renderer, source, pane });
  drawing.routes = await page.evaluate(readRenderedRoutes);
  return drawing;
}

const right = (r) => r.x + r.width;
const bottom = (r) => r.y + r.height;

function overlaps(a, b, tolerance = 0.5) {
  return Math.min(right(a), right(b)) - Math.max(a.x, b.x) > tolerance &&
    Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y) > tolerance;
}

function contains(outer, inner, tolerance = 0.5) {
  return inner.x >= outer.x - tolerance && inner.y >= outer.y - tolerance &&
    right(inner) <= right(outer) + tolerance && bottom(inner) <= bottom(outer) + tolerance;
}

function frameOf(pkg) {
  const x = Math.min(pkg.body.x, pkg.tab.x), y = Math.min(pkg.body.y, pkg.tab.y);
  return { x, y, width: Math.max(right(pkg.body), right(pkg.tab)) - x, height: Math.max(bottom(pkg.body), bottom(pkg.tab)) - y };
}

/**
 * Everything wrong with the packages of a drawing, as sentences.
 * `structure`: {members: {pkg: [element ids, nested members included]},
 * parents: {pkg: enclosing pkg}}.
 */
function packageDefects(drawing, structure) {
  const defects = [];
  const drawnIds = drawing.packages.map((p) => p.id).sort();
  const expectedIds = Object.keys(structure.members).sort();
  if (JSON.stringify(drawnIds) !== JSON.stringify(expectedIds)) defects.push(`packages drawn: ${drawnIds}, expected ${expectedIds}`);
  const parents = structure.parents || {};
  const encloses = (outer, inner) => { for (let p = parents[inner]; p; p = parents[p]) if (p === outer) return true; return false; };
  for (const pkg of drawing.packages) {
    const members = structure.members[pkg.id] || [];
    for (const element of drawing.boxes) {
      if (members.includes(element.id)) {
        if (!contains(pkg.body, element)) defects.push(`${element.id} is not inside ${pkg.id}`);
      } else if (overlaps(pkg.body, element) || overlaps(pkg.tab, element)) {
        defects.push(`${element.id} lies on ${pkg.id}, which it is not in`);
      }
    }
  }
  drawing.packages.forEach((a, i) => drawing.packages.slice(i + 1).forEach((b) => {
    const [outer, inner] = encloses(a.id, b.id) ? [a, b] : encloses(b.id, a.id) ? [b, a] : [null, null];
    if (outer) {
      if (!contains(outer.body, frameOf(inner))) defects.push(`${inner.id} is not nested inside ${outer.id}`);
    } else if (overlaps(frameOf(a), frameOf(b))) {
      defects.push(`${a.id} and ${b.id} overlap`);
    }
  }));
  return defects;
}

// Parts of the drawing outside its viewBox.
function outsideViewBox(drawing) {
  const view = drawing.viewBox;
  const parts = drawing.boxes.map((b) => [b.id, b])
    .concat(drawing.packages.map((p) => [`package ${p.id}`, frameOf(p)]))
    .concat(drawing.texts.map((t) => [`"${t.text}"`, t.box]));
  return parts.filter(([, r]) => !contains(view, r, 1)).map(([name]) => name);
}

/** The on-screen size of the smallest text when the drawing fits the pane. */
function smallestTextOnScreen(drawing, pane) {
  const smallest = Math.min(...drawing.texts.map((t) => t.size));
  return smallest * Math.min(pane.width / drawing.viewBox.width, pane.height / drawing.viewBox.height);
}

function segmentsOf(route) {
  const out = [];
  for (let i = 1; i < route.points.length; i++) out.push([route.points[i - 1], route.points[i]]);
  return out;
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

function crossings(drawing) {
  const side = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const apart = (u, v) => (u > 1e-6 && v < -1e-6) || (u < -1e-6 && v > 1e-6);
  let count = 0;
  drawing.routes.forEach((r1, i) => drawing.routes.slice(i + 1).forEach((r2) => {
    for (const [p, q] of segmentsOf(r1)) {
      for (const [r, s] of segmentsOf(r2)) {
        if (apart(side(r, s, p), side(r, s, q)) && apart(side(p, q, r), side(p, q, s))) count++;
      }
    }
  }));
  return count;
}

module.exports = { measurePackageDrawing, packageDefects, outsideViewBox, smallestTextOnScreen, bends, crossings };
