// `layout compact` keeps every guard of a combined fragment where UML puts
// it: at the head of the operand it guards. An operator's guard sits beside
// the operator tab or directly under it; an `else` guard sits at the left end
// of its divider. A guard never stretches its frame further than the guard
// itself needs from that spot. Everything is measured from the rendered DOM.

const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const path = require('node:path');
const { chromium } = require('playwright');

const BUNDLE = path.join(__dirname, '../uml-bundle.js');
// Tab to a guard beside it, and frame edge to a guard under the tab or
// under a divider: about one character at the message font.
const NEAR = 12;

const SPECS = {
  // test-uml.html §28: one long guard over a frame spanning two lifelines.
  'neg fragment': `actor user: User
participant sys: System
participant db: Database

user -> sys: deleteAccount()
activate sys
neg [must not happen during maintenance]
  sys -> db: DROP TABLE users
  activate db
  db --> sys: error
  deactivate db
end
sys --> user: maintenanceInProgress
deactivate sys`,
  'opt, loop, par and alt in sequence': `participant c: Client
participant s: OrderService
participant db: Database
participant log: AuditLog

c -> s: submit(order)
activate s
opt [order total above the approval limit]
  s -> log: flag(order)
end
loop [for each line item]
  s -> db: reserve(item)
end
par [inventory]
  s -> db: commit()
else [audit trail]
  s -> log: record(order)
end
alt [payment accepted by the external provider]
  s --> c: confirmation
else [declined]
  s --> c: rejection
end
deactivate s`,
  'nested fragments': `participant c: Client
participant s: Server
participant db: Database

c -> s: fetchAll()
activate s
loop [for each record in the requested page]
  alt [record found in the cache]
    s -> db: touch(id)
  else [cache miss for this record]
    s -> db: query(id)
    db --> s: record
  end
end
s --> c: results
deactivate s`,
};

const withLayout = (body, layout) => `@startuml\n${layout ? layout + '\n' : ''}${body}\n@enduml`;
const withoutGuards = body => body.replace(/^(\s*(?:alt|else|opt|loop|par|neg|break|critical)\b)\s*\[[^\]]*\]\s*$/gm, '$1');

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { if (browser) await browser.close(); });

async function measure(source, pane) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  try {
    await page.setContent(`<html><head><title>Guards</title></head><body><div id="d" style="width:${pane.width}px;height:${pane.height}px"></div></body></html>`);
    await page.addScriptTag({ path: BUNDLE });
    return await page.evaluate(src => {
      const container = document.getElementById('d');
      window.UMLSequenceDiagram.render(container, src);
      const svg = container.querySelector('svg');
      const toSvg = svg.getScreenCTM().inverse();
      function box(el) {
        const b = el.getBBox();
        const m = toSvg.multiply(el.getScreenCTM());
        const pts = [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]]
          .map(([x, y]) => new DOMPoint(x, y).matrixTransform(m));
        const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
        return { x: Math.min(...xs), y: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
      }
      const frames = [...svg.querySelectorAll('rect[data-layout-fragment-id]')].map(el => {
        const id = el.getAttribute('data-layout-fragment-id');
        const tab = svg.querySelector(`polygon[data-layout-fragment-id="${id}"]`);
        const guard = svg.querySelector(`text[data-layout-fragment-id="${id}"][data-layout-fragment-role="condition"]`);
        const branches = [...svg.querySelectorAll(`line[data-layout-fragment-id="${id}"][data-layout-branch-line]`)].map(line => {
          const text = svg.querySelector(`text[data-layout-fragment-id="${id}"][data-layout-branch-line="${line.getAttribute('data-layout-branch-line')}"]`);
          return { y: line.y1.baseVal.value, guard: text ? { text: text.textContent, ...box(text) } : null };
        });
        return { id, ...box(el), tab: box(tab), guard: guard ? { text: guard.textContent, ...box(guard) } : null, branches };
      });
      const texts = [...svg.querySelectorAll('text')].filter(t => t.textContent.trim())
        .map(t => ({ text: t.textContent, role: t.getAttribute('data-layout-fragment-role'), ...box(t) }));
      const lifelines = [...svg.querySelectorAll('line.uml-sequence-lifeline')].map(l => ({ x: l.x1.baseVal.value, y1: l.y1.baseVal.value, y2: l.y2.baseVal.value }));
      const bars = [...svg.querySelectorAll('rect[data-layout-kind="activation"]')].map(box);
      const vb = svg.viewBox.baseVal;
      const fonts = [...svg.querySelectorAll('text')].filter(t => t.textContent.trim()).map(t => parseFloat(getComputedStyle(t).fontSize));
      return { width: vb.width, height: vb.height, smallestFont: Math.min(...fonts), frames, texts, lifelines, bars };
    }, source);
  } finally {
    await page.close();
  }
}

const PANE = { width: 600, height: 700 };
const cache = new Map();
function measured(source) {
  if (!cache.has(source)) cache.set(source, measure(source, PANE));
  return cache.get(source);
}
const compact = name => measured(withLayout(SPECS[name], 'layout compact 600x700'));
const onScreen = m => m.smallestFont * Math.min(PANE.width / m.width, PANE.height / m.height);
function overlaps(a, b, tol = 0.5) {
  return Math.min(a.right, b.right) - Math.max(a.x, b.x) > tol && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > tol;
}
function besideTab(guard, tab) {
  return guard.x >= tab.right - 0.5 && guard.x <= tab.right + NEAR && guard.y < tab.bottom && guard.bottom > tab.y;
}
function underTab(guard, frame, tab) {
  return guard.x >= frame.x && guard.x <= frame.x + NEAR && guard.y >= tab.bottom - 1 && guard.y <= tab.bottom + NEAR;
}

for (const name of Object.keys(SPECS)) {
  test(`${name}: each operator guard heads its frame, beside the tab or under it`, async () => {
    const m = await compact(name);
    const guarded = m.frames.filter(f => f.guard);
    assert.ok(guarded.length > 0);
    for (const f of guarded) {
      assert.ok(besideTab(f.guard, f.tab) || underTab(f.guard, f, f.tab),
        `${f.guard.text} at (${f.guard.x.toFixed(1)}, ${f.guard.y.toFixed(1)}); frame at (${f.x.toFixed(1)}, ${f.y.toFixed(1)}), tab ends at ${f.tab.right.toFixed(1)}, ${f.tab.bottom.toFixed(1)}`);
    }
  });

  test(`${name}: each else guard starts at the left end of its divider`, async () => {
    const m = await compact(name);
    for (const f of m.frames) {
      for (const b of f.branches.filter(branch => branch.guard)) {
        assert.ok(b.guard.x >= f.x && b.guard.x <= f.x + NEAR, `${b.guard.text} starts ${(b.guard.x - f.x).toFixed(1)} right of its frame edge`);
        assert.ok(b.guard.y >= b.y - 0.5 && b.guard.y <= b.y + NEAR, `${b.guard.text} is ${(b.guard.y - b.y).toFixed(1)} below its divider`);
      }
    }
  });

  test(`${name}: a guard widens its frame beyond the room the guard itself needs`, async () => {
    const [withG, withoutG] = await Promise.all([compact(name), measured(withLayout(withoutGuards(SPECS[name]), 'layout compact 600x700'))]);
    for (const f of withG.frames) {
      const bare = withoutG.frames.find(other => other.id === f.id);
      const guards = [f.guard, ...f.branches.map(b => b.guard)].filter(Boolean);
      const need = Math.max(0, ...guards.map(g => (g.right - g.x) + 2 * NEAR));
      const allowed = Math.max(bare.right - bare.x, need);
      assert.ok(f.right - f.x <= allowed + 0.5, `${f.id} is ${(f.right - f.x).toFixed(1)} wide; without guards ${(bare.right - bare.x).toFixed(1)}, guards need ${need.toFixed(1)}`);
    }
  });

  test(`${name}: a guard beside its tab covers a lifeline or an activation bar`, async () => {
    const m = await compact(name);
    for (const f of m.frames.filter(frame => frame.guard && besideTab(frame.guard, frame.tab))) {
      for (const l of m.lifelines) {
        const covers = l.x > f.guard.x + 0.5 && l.x < f.guard.right - 0.5 && f.guard.bottom > l.y1 && f.guard.y < l.y2;
        assert.ok(!covers, `${f.guard.text} covers the lifeline at x ${l.x}`);
      }
      for (const bar of m.bars) assert.ok(!overlaps(f.guard, bar), `${f.guard.text} overlaps an activation bar`);
    }
  });

  test(`${name}: a guard overlaps another text`, async () => {
    const m = await compact(name);
    const guards = m.texts.filter(t => t.role === 'condition' || t.role === 'branch');
    for (const g of guards) {
      for (const other of m.texts) {
        if (other === g) continue;
        assert.ok(!overlaps(g, other), `${g.text} overlaps "${other.text}"`);
      }
    }
  });
}

test('neg fragment: compact text in a 600×700 pane is smaller than without a layout line', async () => {
  const [c, plain] = await Promise.all([compact('neg fragment'), measured(withLayout(SPECS['neg fragment'], ''))]);
  assert.ok(onScreen(c) >= onScreen(plain), `compact ${onScreen(c).toFixed(2)} px, without a layout line ${onScreen(plain).toFixed(2)} px`);
});
