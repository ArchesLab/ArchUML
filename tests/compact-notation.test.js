'use strict';

// `layout compact` judges a drawing from the scene its renderer records, so
// whatever the renderer draws must be in that scene: packages (class and
// component diagrams), stereotypes (component and state diagrams), state
// pseudostates, and sequence guards with their backdrops. Each check below
// fails when the element is drawn but left out of the compact machinery.
// Geometric claims are measured from the rendered DOM; scene claims from the
// scene UMLCompactLayout.optimize returns, with the bundle run as in the
// worker (support/load-bundle.js).
const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { loadBundle } = require('./support/load-bundle');
const { launchBrowser, openDiagramPage, render, overlaps, contains, inkPixels } = require('./support/diagram-page');

const compact = (body, pane = '600x750') => `@startuml\nlayout compact ${pane}\n${body}\n@enduml`;

// A shop package with a catalog package inside it, and a class outside both.
const NESTED_CLASS_PACKAGES = `package shop {
  class Cart
  package catalog {
    class Product
    class Category
  }
}
class User
User --> Cart : owns
Cart --> Product : holds
Product --> Category : in`;

// Two packages whose classes the layout would interleave, and a class
// outside both.
const TWO_PACKAGES = `package orders {
  class Order {
    -id: int
    +total(): double
  }
  class LineItem {
    -qty: int
  }
}
package billing <<subsystem>> {
  class Invoice {
    -number: String
  }
  class Payment {
    -amount: double
    +authorize()
  }
}
class Customer {
  -name: String
}
Customer "1" --> "0..*" Order : places
Order "1" *-- "1..*" LineItem : contains
Order --> Invoice : generates
Invoice --> Payment : settledBy
Customer ..> Payment : pays`;

const PARTNERS = `package opc::partners {
  class SupplierProvider
  class ShuttleProvider
}
abstract class Provider
SupplierProvider --|> Provider
ShuttleProvider --|> Provider`;

const HEADLINER = `package Headliner {
  component OPC <<service>>
  component Loyalty <<service>>
}
component Partner <<external>>
OPC --> Loyalty
Loyalty --> Partner`;

// A provided interface joined to a required one, the ball and socket drawn
// beside the package's members.
const JOINED_IN_PACKAGE = `package "Order Processing Center" as OPC <<Subsystem>> {
  component Workflow {
    provide "orders" as w_orders
  }
  component Callbacks
}
component Website {
  require "orders" as site_orders
}
site_orders --> w_orders
Workflow --> Callbacks : notify`;

// A required interface of a member joined to a provided one outside; in a
// wide pane the ball and socket are drawn at the member.
const JOINED_AT_MEMBER = `package Backend {
  component Workflow {
    require "payments" as w_pay
  }
}
component Bank {
  provide "payments" as b_pay
}
w_pay --> b_pay`;

const STEREOTYPED_COMPONENTS = `component "Trip Website" as Website <<web application>> {
  portout "orders" as w_out
}
component OPC <<service>> {
  portin "orders" as opc_in
}
w_out --> opc_in`;

// No transition labels: the stereotype is the smallest text.
const STEREOTYPED_STATES = `[*] --> Idle
state Idle <<long-running>>
state Busy <<external>>
Idle --> Busy
Busy --> [*]`;

const JUNCTION = `[*] --> A
state J <<junction>>
A --> J : go
B --> J : go
J --> C
C --> [*]`;

const FORK_AND_JOIN = `[*] --> Split
state Split <<fork>>
state Merge <<join>>
Split --> Left
Split --> Right
Left --> Merge
Right --> Merge
Merge --> [*]`;

// test-uml.html-style guards over four lifelines; the long last guard does
// not fit beside its tab and takes its own row, across lifelines.
const GUARDS = [
  'participant site: TripWebsite',
  'participant po: PurchaseOrderService',
  'participant bank: Bank',
  'participant supplier: SupplierProvider',
  'site -> po: submit(tripOrder)',
  'activate po',
  'opt [the fan has a loyalty account]',
  'po -> bank: capture(cardToken, amount)',
  'end',
  'alt [decision is reject]',
  'po -> site: rejected',
  'else [every supplier order confirmed]',
  'po -> site: confirmed',
  'end',
  'opt [every supplier order cancelled or rejected by the gateway]',
  'po -> supplier: cancel(supplierOrder)',
  'end',
  'deactivate po',
].join('\n');

// ───── Scenes (worker-style render) ──────────────────────────────────

// The container js/uml-worker.js hands to a renderer.
function workerContainer() {
  let markup = '';
  const svg = { setAttribute() {}, getAttribute() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; } };
  return {
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

/** The compact drawing UMLCompactLayout chose: its markup, scene and metrics. */
function compactResult(renderer, source) {
  const window = loadBundle();
  window.getComputedStyle = () => ({ getPropertyValue: () => '' });
  let result = null;
  const optimize = window.UMLCompactLayout.optimize;
  window.UMLCompactLayout.optimize = function () {
    result = optimize.apply(this, arguments);
    return result;
  };
  window[renderer].render(workerContainer(), source);
  assert.ok(result, 'the compact search ran');
  return result;
}

function sceneNode(scene, id) {
  return scene.nodes.find((node) => node.id === id);
}

// The font sizes the markup draws text in.
function drawnFontSizes(svg) {
  return [...svg.matchAll(/<text\b[^>]*\bfont-size="([\d.]+)"/g)].map((m) => Number(m[1]));
}

test('a compact class diagram records its packages, nested, with their members and names', () => {
  const { scene, issues } = compactResult('UMLClassDiagram', compact(NESTED_CLASS_PACKAGES));
  assert.equal(issues, 0);
  const shop = sceneNode(scene, 'package:shop');
  const catalog = sceneNode(scene, 'package:catalog');
  assert.ok(shop && shop.container && shop.crossable, 'shop is a container lines may cross');
  assert.equal(catalog && catalog.parent, 'package:shop', 'catalog lies in shop');
  assert.equal(sceneNode(scene, 'Cart').parent, 'package:shop');
  assert.equal(sceneNode(scene, 'Product').parent, 'package:catalog');
  assert.equal(sceneNode(scene, 'User').parent, null);
  assert.equal(sceneNode(scene, 'package-tab:catalog').parent, 'package:catalog');
  assert.ok(scene.labels.some((label) => label.id === 'package-name:shop:0'), 'the name in the tab is a label');
});

test('a compact component diagram records its package and the members in it', () => {
  const { scene, issues } = compactResult('UMLComponentDiagram', compact(HEADLINER));
  assert.equal(issues, 0);
  assert.ok(sceneNode(scene, 'package:Headliner'), 'the package is in the scene');
  assert.equal(sceneNode(scene, 'OPC').parent, 'package:Headliner');
  assert.equal(sceneNode(scene, 'Partner').parent, null);
});

for (const [name, renderer, source] of [
  ['component stereotypes', 'UMLComponentDiagram', compact(STEREOTYPED_COMPONENTS)],
  ['component packages with stereotypes', 'UMLComponentDiagram', compact(JOINED_IN_PACKAGE)],
  ['state stereotypes', 'UMLStateDiagram', compact(STEREOTYPED_STATES)],
  ['class packages', 'UMLClassDiagram', compact(PARTNERS)],
]) {
  test(`${name}: no text in the compact drawing is smaller than the scene's smallest font`, () => {
    // The judge rates a drawing by its smallest text; text it was not told
    // about could be smaller than what it rated.
    const { svg, scene } = compactResult(renderer, source);
    const smallest = Math.min(...drawnFontSizes(svg));
    assert.ok(smallest >= scene.smallestFont, `drawn ${smallest} px, the scene says ${scene.smallestFont} px`);
  });
}

test('the squeeze keeps the separation a pair asks for on each axis, and no more', () => {
  const { UMLCompactLayout } = loadBundle();
  const clearances = { lanePitch: 10, boxClearance: 8, stub: 12, labelPad: 4 };
  const bodies = [
    { id: 'a', x: 0, y: 0, width: 40, height: 20, pinned: false },
    { id: 'b', x: 200, y: 0, width: 40, height: 20, pinned: false },
    { id: 'c', x: 0, y: 200, width: 40, height: 20, pinned: false },
  ];
  const empty = { nodes: [], routes: [], labels: [] };
  const separation = (a, b, axis) => (axis === 'x' ? (a === 'a' && b === 'b' ? 30 : 0) : (a === 'a' && b === 'c' ? 50 : 0));
  const plain = UMLCompactLayout.squeeze(bodies, empty, clearances);
  const kept = UMLCompactLayout.squeeze(bodies, empty, clearances, { separation });
  const gapX = (p) => p.b.x - (p.a.x + 40), gapY = (p) => p.c.y - (p.a.y + 20);
  assert.deepEqual([gapX(plain), gapY(plain)], [8, 8], 'without separation: the box clearance');
  assert.deepEqual([gapX(kept), gapY(kept)], [38, 58], 'with it: the clearance and the separation');
});

for (const [name, source] of [['a junction', JUNCTION], ['a fork and a join', FORK_AND_JOIN]]) {
  test(`compact state diagram with ${name} has no layout issues`, () => {
    // Transitions meet at these pseudostates by design; the judge must not
    // take their shared stretch for two lines run together.
    const { issues, metrics } = compactResult('UMLStateDiagram', compact(source));
    assert.equal(issues, 0, JSON.stringify(metrics.violations));
  });
}

// ───── Drawings (browser) ────────────────────────────────────────────

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { if (browser) await browser.close(); });

async function withPage(run) {
  const page = await openDiagramPage(browser);
  try { return await run(page); } finally { await page.close(); }
}

/** What a reader checks of the packages in a drawing. */
async function drawnPackages(page, renderer, source) {
  await render(page, renderer, source);
  return page.evaluate(() => {
    const svg = document.querySelector('#diagram svg');
    // On screen: the drawing's viewport and each package part.
    const screen = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, right: b.right, bottom: b.bottom }; };
    const elements = [...svg.querySelectorAll('rect[data-layout-bounds-id], rect.uml-component-box')].map((el) => ({
      id: el.getAttribute('data-layout-bounds-id') || el.getAttribute('data-layout-id'), ...measure.box(el),
    }));
    return {
      issues: svg.getAttribute('data-uml-layout-issues'),
      view: screen(svg),
      onScreen: [...svg.querySelectorAll('g[data-uml-package] rect')].map(screen),
      packages: measure.packages(),
      elements,
      texts: measure.texts().filter((t) => t.text.trim()),
    };
  });
}

const PACKAGE_DRAWINGS = [
  ['nested class', 'UMLClassDiagram', NESTED_CLASS_PACKAGES, { shop: ['Cart', 'Product', 'Category'], catalog: ['Product', 'Category'] }, ['600x750', '1200x675']],
  // In a wide pane every placement the layout tries interleaves the two
  // packages (see REFERENCE.md, Compact Layout).
  ['two class', 'UMLClassDiagram', TWO_PACKAGES, { orders: ['Order', 'LineItem'], billing: ['Invoice', 'Payment'] }, ['600x750']],
  ['component', 'UMLComponentDiagram', HEADLINER, { Headliner: ['OPC', 'Loyalty'] }, ['600x750', '1200x675']],
  ['component with a joined interface', 'UMLComponentDiagram', JOINED_IN_PACKAGE, { OPC: ['Workflow', 'Callbacks'] }, ['600x750', '1200x675']],
];

for (const [kind, renderer, body, members, panes] of PACKAGE_DRAWINGS) {
  for (const pane of panes) {
    test(`compact ${kind} packages in a ${pane} pane: members inside, others out, names clear, all in view`, async () => {
      const drawn = await withPage((page) => drawnPackages(page, renderer, compact(body, pane)));
      assert.equal(drawn.issues, null, 'the drawing is free of layout issues');
      assert.equal(drawn.packages.length, Object.keys(members).length);
      for (const part of drawn.onScreen) assert.ok(contains(drawn.view, part, -0.5), 'every package lies inside the drawing');
      for (const pkg of drawn.packages) {
        for (const element of drawn.elements) {
          if (members[pkg.id].includes(element.id)) {
            assert.ok(contains(pkg.body, element, 1), `${element.id} is inside ${pkg.id}`);
          } else {
            assert.ok(!overlaps(pkg.body, element) && !overlaps(pkg.tab, element), `${element.id} stays out of ${pkg.id}`);
          }
        }
        for (const name of pkg.labels) {
          for (const other of drawn.texts) {
            if (pkg.labels.some((own) => own.text === other.text && Math.abs(own.x - other.x) < 0.5)) continue;
            assert.ok(!overlaps(name, other, -0.5), `the package name ${name.text} overlaps "${other.text}"`);
          }
        }
      }
    });
  }
}

test('compact component package encloses the joined ball and socket drawn at its member', async () => {
  const drawn = await withPage(async (page) => {
    await render(page, 'UMLComponentDiagram', compact(JOINED_AT_MEMBER, '1200x675'));
    return page.evaluate(() => ({
      pkg: measure.packages()[0],
      drawnAt: [...document.querySelectorAll('#diagram svg g[data-uml-drawn-at]')].map((g) => ({
        at: g.getAttribute('data-uml-drawn-at'), ...measure.box(g),
      })),
    }));
  });
  const atMembers = drawn.drawnAt.filter((group) => group.at === 'Workflow');
  assert.equal(atMembers.length, 1, 'the ball and socket are drawn at Workflow');
  for (const group of atMembers) assert.ok(contains(drawn.pkg.body, group, 0), `what is drawn at ${group.at} lies inside the package`);
});

test('compact sequence: no lifeline or activation bar shows through a guard', async () => {
  await withPage(async (page) => {
    await page.addStyleTag({ content: '#diagram svg { display: block; width: var(--uml-readable-width, auto); height: auto; }' });
    await render(page, 'UMLSequenceDiagram', compact(GUARDS));
    const selector = '#diagram svg text[data-layout-fragment-role]';
    const guards = await page.$$eval(selector, (texts) => texts.map((text) => {
      const box = text.getBoundingClientRect();
      return { text: text.textContent, x: box.x + 1, y: box.y + 1, width: box.width - 2, height: box.height - 2 };
    }));
    assert.equal(guards.length, 4);
    for (const guard of guards) {
      assert.equal(await inkPixels(page, guard, selector), 0, `something shows through ${guard.text}`);
    }
  });
});
