// `layout compact` for sequence diagrams: exact spacing on a fixed grid.
// Every geometric claim is measured from the rendered DOM (getBBox + CTM), so
// a gap in the renderer's own scene record cannot hide an overlap. "Today's
// compact" is the pre-compact bundle (support/pre-compact-bundle.js), rendered in
// the same browser, so no pixel value is hard-coded here.

const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { writePreCompactBundle } = require('./support/pre-compact-bundle');

const BUNDLE = path.join(__dirname, '../uml-bundle.js');
const MESSAGE_FONT = 13;

// Realistic specs, copied from SEBook/uml_sequence_diagram.md (OAuth example),
// test-uml.html §20 (nested fragments with self-calls) and
// SEBook/designpatterns/command.md (actor and side notes). Callouts removed.
const SPECS = {
  'three-lifeline exchange': {
    participants: ['B: Browser', 'A: AppBackend', 'G: GoogleOAuth'],
    body: `participant B: Browser
participant A: AppBackend
participant G: GoogleOAuth
B -> A: GET /login
activate A
A --> B: 302 redirect to accounts.google.com
deactivate A
B -> G: GET /authorize (clientId, scope)
activate G
G --> B: 200 auth form
deactivate G
B -> G: POST /authorize (credentials)
activate G
G --> B: 302 redirect with authCode
deactivate G
B -> A: GET /callback?code=authCode
activate A
A -> G: POST /token (authCode, clientSecret)
activate G
G --> A: accessToken
deactivate G
A --> B: 200 session cookie
deactivate A`,
  },
  'nested frames with self-calls': {
    participants: ['c: Client', 's: Server', 'db: Database'],
    body: `participant c: Client
participant s: Server
participant db: Database

c -> s: fetchAll()
activate s
loop [for each record]
  alt [found]
    s -> db: query(id)
    activate db
    db --> s: record
    deactivate db
    s -> s: transform()
    activate s
    deactivate s
  else [not found]
    s -> db: query(id)
    activate db
    db --> s: null
    deactivate db
    s -> s: logMissing()
    activate s
    deactivate s
  end
end
s --> c: results
deactivate s`,
  },
  'actor with side notes': {
    participants: ['user: User', 'remote: RemoteControl', 'command: LightOnCommand', 'light: Light'],
    body: `actor user: User
participant remote: RemoteControl
participant command: LightOnCommand
participant light: Light
user -> remote: pressOn()
activate remote
remote -> command: execute()
activate command
command -> light: isOn()
activate light
light --> command: false
deactivate light
command -> light: on()
activate light
deactivate light
deactivate command
note right of remote: undoCommand := command
deactivate remote
user -> remote: pressUndo()
activate remote
remote -> command: undo()
activate command
command -> light: setOn(previousOn)
activate light
deactivate light
deactivate command
note right of remote: undoCommand := new NoCommand()
deactivate remote`,
  },
};

const compactSource = body => `@startuml\nlayout compact\n${body}\n@enduml`;

let browser;
let previousBundle;
before(async () => {
  previousBundle = writePreCompactBundle('archuml-seq-');
  browser = await chromium.launch();
});
after(async () => {
  if (browser) await browser.close();
  if (previousBundle) fs.rmSync(path.dirname(previousBundle), { recursive: true, force: true });
});

async function withPage(bundle, fn) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  try {
    await page.setContent('<html><head><title>Sequence compact</title></head><body><div id="diagram"></div></body></html>');
    await page.addScriptTag({ path: bundle });
    return await fn(page);
  } finally {
    await page.close();
  }
}

async function renderMarkup(bundle, source) {
  return withPage(bundle, page => page.evaluate(src => {
    const container = document.getElementById('diagram');
    window.UMLSequenceDiagram.render(container, src);
    return container.querySelector('svg').outerHTML;
  }, source));
}

// Measures the drawing in SVG user units. Boxes are getBBox() mapped through
// the element's CTM relative to the root <svg>.
async function measure(bundle, source, participants) {
  return withPage(bundle, page => page.evaluate(([src, displayNames]) => {
    const container = document.getElementById('diagram');
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
    const texts = [...svg.querySelectorAll('text')].filter(t => t.textContent.trim());
    const headTexts = displayNames.map(name => texts.find(t => t.textContent === name && t.getAttribute('font-weight') === 'bold'));
    const shapes = [...svg.querySelectorAll('rect[filter], g[filter]')].filter(el => !el.hasAttribute('data-layout-kind'));
    const heads = headTexts.map(text => {
      const t = box(text);
      const cx = (t.x + t.right) / 2, cy = (t.y + t.bottom) / 2;
      const shape = shapes.map(box).find(s => s.x <= cx && cx <= s.right && s.y <= cy && cy <= s.bottom);
      // An actor's figure sits above its name.
      const figure = shapes.map(box).find(s => s.x <= cx && cx <= s.right && s.bottom <= t.y + 1 && s.bottom >= t.y - 20);
      const parts = [t, shape, figure].filter(Boolean);
      return {
        name: text.textContent, centerX: cx,
        x: Math.min(...parts.map(p => p.x)), y: Math.min(...parts.map(p => p.y)),
        right: Math.max(...parts.map(p => p.right)), bottom: Math.max(...parts.map(p => p.bottom)),
      };
    });
    const lifelines = [...svg.querySelectorAll('line.uml-sequence-lifeline')].map((line, index) => ({
      index, x: line.x1.baseVal.value, y1: line.y1.baseVal.value, y2: line.y2.baseVal.value,
    }));
    const routes = [...svg.querySelectorAll('line[data-layout-route-id], polyline[data-layout-route-id]')].map(el => {
      const points = el.tagName === 'line'
        ? [{ x: el.x1.baseVal.value, y: el.y1.baseVal.value }, { x: el.x2.baseVal.value, y: el.y2.baseVal.value }]
        : [...el.points].map(p => ({ x: p.x, y: p.y }));
      return { id: el.getAttribute('data-layout-route-id'), source: el.getAttribute('data-layout-source'), target: el.getAttribute('data-layout-target'), points };
    });
    const messageLabels = [...svg.querySelectorAll('text[data-layout-route-id]')].map(el => ({
      text: el.textContent, route: el.getAttribute('data-layout-route-id'), ...box(el),
    }));
    const bars = [...svg.querySelectorAll('rect[data-layout-kind="activation"]')].map(el => ({
      id: el.getAttribute('data-layout-id'), ...box(el),
    }));
    const frames = [...svg.querySelectorAll('rect[data-layout-fragment-id]')].map(el => ({
      id: el.getAttribute('data-layout-fragment-id'), ...box(el),
    }));
    const vb = svg.viewBox.baseVal;
    return {
      width: vb.width, height: vb.height,
      fonts: texts.map(t => ({ text: t.textContent, size: parseFloat(getComputedStyle(t).fontSize) })),
      allTexts: texts.map(t => ({ text: t.textContent, route: t.getAttribute('data-layout-route-id'), ...box(t) })),
      heads, lifelines, routes, messageLabels, bars, frames,
      issues: svg.getAttribute('data-uml-layout-issues'),
    };
  }, [source, participants]));
}

function smallestFont(m) { return Math.min(...m.fonts.map(f => f.size)); }
function emSize(m) { const f = smallestFont(m); return { w: m.width / f, h: m.height / f }; }
function overlaps(a, b, tol = 0.5) {
  return Math.min(a.right, b.right) - Math.max(a.x, b.x) > tol && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > tol;
}
function lifelineCovers(label, lifeline) {
  return lifeline.x > label.x + 0.5 && lifeline.x < label.right - 0.5 && label.bottom > lifeline.y1 && label.y < lifeline.y2;
}
function routeY(route) { return route.points[0].y; }
function routeLine(id) { return Number(id.replace('seqmsg:', '')); }

const cache = new Map();
function measured(bundle, name) {
  const key = bundle + '|' + name;
  if (!cache.has(key)) cache.set(key, measure(bundle, compactSource(SPECS[name].body), SPECS[name].participants));
  return cache.get(key);
}
const now = name => measured(BUNDLE, name);
const today = name => measured(previousBundle, name);

for (const name of Object.keys(SPECS)) {
  test(`${name}: compact is wider in font units than today's compact`, async () => {
    const [after_, before_] = [emSize(await now(name)), emSize(await today(name))];
    assert.ok(after_.w <= before_.w + 1e-6, `width ${after_.w.toFixed(2)} em exceeds today's ${before_.w.toFixed(2)} em`);
  });

  test(`${name}: compact is taller in font units than today's compact`, async () => {
    const [after_, before_] = [emSize(await now(name)), emSize(await today(name))];
    assert.ok(after_.h <= before_.h + 1e-6, `height ${after_.h.toFixed(2)} em exceeds today's ${before_.h.toFixed(2)} em`);
  });

  test(`${name}: a message label covers a lifeline`, async () => {
    const m = await now(name);
    for (const label of m.messageLabels) {
      for (const lifeline of m.lifelines) {
        assert.ok(!lifelineCovers(label, lifeline), `"${label.text}" covers lifeline ${lifeline.index} at x=${lifeline.x}`);
      }
    }
  });

  test(`${name}: a message label overlaps another text`, async () => {
    const m = await now(name);
    for (const label of m.messageLabels) {
      for (const other of m.allTexts) {
        if (other.text === label.text && other.route === label.route) continue;
        assert.ok(!overlaps(label, other), `"${label.text}" overlaps "${other.text}"`);
      }
    }
  });

  test(`${name}: a message label crosses a frame border`, async () => {
    const m = await now(name);
    for (const label of m.messageLabels) {
      for (const frame of m.frames) {
        const edges = [
          { x: frame.x, right: frame.right, y: frame.y, bottom: frame.y },
          { x: frame.x, right: frame.right, y: frame.bottom, bottom: frame.bottom },
          { x: frame.x, right: frame.x, y: frame.y, bottom: frame.bottom },
          { x: frame.right, right: frame.right, y: frame.y, bottom: frame.bottom },
        ];
        for (const edge of edges) {
          const crosses = edge.x <= label.right && edge.right >= label.x && edge.y <= label.bottom && edge.bottom >= label.y;
          assert.ok(!crosses, `"${label.text}" crosses the border of ${frame.id}`);
        }
      }
    }
  });

  test(`${name}: a message label touches another message's arrow`, async () => {
    const m = await now(name);
    const clearance = 2; // beyond the stroke's half width
    for (const label of m.messageLabels) {
      for (const route of m.routes) {
        if (route.id === label.route) continue;
        for (let i = 1; i < route.points.length; i++) {
          const a = route.points[i - 1], b = route.points[i];
          const seg = { x: Math.min(a.x, b.x) - clearance, right: Math.max(a.x, b.x) + clearance, y: Math.min(a.y, b.y) - clearance, bottom: Math.max(a.y, b.y) + clearance };
          assert.ok(!overlaps(label, seg, 0), `"${label.text}" touches ${route.id}`);
        }
      }
    }
  });

  // Where guards go (at their frame's top-left, clear of lifelines when
  // beside the tab) is specified in compact-sequence-guards.test.js.

  test(`${name}: a message label overlaps an activation bar`, async () => {
    const m = await now(name);
    for (const label of m.messageLabels) {
      for (const bar of m.bars) assert.ok(!overlaps(label, bar), `"${label.text}" overlaps bar ${bar.id}`);
    }
  });

  test(`${name}: a message label overlaps a participant head`, async () => {
    const m = await now(name);
    assert.equal(m.heads.length, SPECS[name].participants.length, 'every head must be found');
    for (const label of m.messageLabels) {
      for (const head of m.heads) assert.ok(!overlaps(label, head), `"${label.text}" overlaps head ${head.name}`);
    }
  });

  test(`${name}: some text is smaller than the message font`, async () => {
    const m = await now(name);
    for (const font of m.fonts) assert.ok(font.size >= MESSAGE_FONT, `"${font.text}" is ${font.size}px`);
  });

  test(`${name}: messages run out of source order`, async () => {
    const m = await now(name);
    const bySource = [...m.routes].sort((a, b) => routeLine(a.id) - routeLine(b.id));
    for (let i = 1; i < bySource.length; i++) {
      assert.ok(routeY(bySource[i]) > routeY(bySource[i - 1]), `${bySource[i].id} is not below ${bySource[i - 1].id}`);
    }
  });

  test(`${name}: lifelines run out of declaration order`, async () => {
    const m = await now(name);
    const xs = m.heads.map(head => head.centerX);
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i] > xs[i - 1], `${m.heads[i].name} is not right of ${m.heads[i - 1].name}`);
    assert.deepEqual(m.lifelines.map(l => Math.round(l.x)), xs.map(Math.round), 'each lifeline hangs below its own head');
  });

  test(`${name}: a frame encloses different messages than today`, async () => {
    function enclosed(m) {
      const result = {};
      for (const frame of m.frames) {
        result[frame.id] = m.routes.filter(r => r.points.every(p => p.y > frame.y && p.y < frame.bottom && p.x >= frame.x - 0.5 && p.x <= frame.right + 0.5))
          .map(r => r.id).sort();
      }
      return result;
    }
    assert.deepEqual(enclosed(await now(name)), enclosed(await today(name)));
  });

  test(`${name}: an activation bar starts or ends at a different message than today`, async () => {
    // A bar end is placed by the message occurrences (send and receive points)
    // above it and whether it sits on one of them.
    function anchors(m) {
      const ys = [];
      for (const r of m.routes) { ys.push(r.points[0].y); ys.push(r.points[r.points.length - 1].y); }
      const place = y => [ys.filter(v => v < y - 0.5).length, ys.some(v => Math.abs(v - y) <= 0.5)];
      const result = {};
      for (const bar of m.bars) result[bar.id] = { start: place(bar.y), end: place(bar.bottom) };
      return result;
    }
    assert.deepEqual(anchors(await now(name)), anchors(await today(name)));
  });

  test(`${name}: the compact drawing is flagged with layout issues`, async () => {
    const m = await now(name);
    assert.equal(m.issues, null);
  });

  test(`${name}: the recorded scene of the compact drawing has violations`, async () => {
    const result = await withPage(BUNDLE, page => page.evaluate(src => {
      const scene = window.UMLSequenceDiagram.layoutScene(src);
      const verdict = window.UMLLayoutQuality.evaluate(scene, { width: 600, height: 750 });
      return { routes: scene.routes.length, labels: scene.labels.length, violations: verdict.violations };
    }, compactSource(SPECS[name].body)));
    const m = await now(name);
    assert.equal(result.routes, m.routes.length, 'the scene must hold every message');
    assert.ok(result.labels >= m.messageLabels.length, 'the scene must hold every message label');
    assert.deepEqual(result.violations, []);
  });
}

test('nested frames with self-calls: compact area in font units is not 15 % below today', async () => {
  const name = 'nested frames with self-calls';
  const [after_, before_] = [emSize(await now(name)), emSize(await today(name))];
  const ratio = (after_.w * after_.h) / (before_.w * before_.h);
  assert.ok(ratio <= 0.85, `area is ${(ratio * 100).toFixed(1)} % of today's compact`);
});

test('nested frames with self-calls: a self-call label reaches the next lifeline', async () => {
  const m = await now('nested frames with self-calls');
  const selfLabels = m.messageLabels.filter(label => {
    const route = m.routes.find(r => r.id === label.route);
    return route && route.source === route.target;
  });
  assert.equal(selfLabels.length, 2);
  const db = m.lifelines[2];
  for (const label of selfLabels) assert.ok(label.right < db.x - 4, `"${label.text}" ends at ${label.right}, lifeline at ${db.x}`);
});

test('actor with side notes: a side note crosses the next lifeline', async () => {
  const m = await now('actor with side notes');
  const command = m.lifelines[2];
  const notes = m.allTexts.filter(t => t.text.startsWith('undoCommand'));
  assert.equal(notes.length, 2);
  for (const note of notes) assert.ok(note.right < command.x - 4, `"${note.text}" ends at ${note.right}, lifeline at ${command.x}`);
});

// Without `layout compact`, or with an authored layout, nothing changes.
const UNCHANGED = {
  ...Object.fromEntries(Object.entries(SPECS).map(([name, spec]) => [name, `@startuml\n${spec.body}\n@enduml`])),
  'create and destroy': `@startuml
participant client: Client
participant server: Server

client -> server: request()
activate server
create Handler
server --> Handler: <<create>>
activate Handler
Handler --> server: result
deactivate Handler
destroy Handler
server --> client: response
deactivate server
@enduml`,
  'lost, found and an organization box': `@startuml
box "Library"
participant client: Client
participant server: LibraryServer
end box
client -> server: findBook()
server --> client: book
o-> server: availabilityChanged
server ->o : auditLogged
note over server: Holds a reservation
@enduml`,
  'compact with an @layout block': `@startuml
layout compact
participant c: Client
participant s: Server
c -> s: ping()
alt [ok]
  s --> c: pong
end
@layout
pos c 80 40
pos s 300 40
@endlayout
@enduml`,
  'compact with an inline @pos': `@startuml
layout compact
participant c: Client @pos(80, 40)
participant s: Server
c -> s: ping()
s -> s: think()
note left of c: starts here
@enduml`,
};

for (const [name, source] of Object.entries(UNCHANGED)) {
  test(`${name}: output differs from the pre-change renderer`, async () => {
    const [after_, before_] = await Promise.all([renderMarkup(BUNDLE, source), renderMarkup(previousBundle, source)]);
    assert.equal(after_, before_);
  });
}
