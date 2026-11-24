'use strict';

// `layout compact` for class diagrams that draw packages as nodes (a package
// line without braces) beside packages drawn as frames. A package node is a
// box like a class: no frame may lie over it unless it is a member, and no
// relationship may run through it unless it ends there. Measured from the
// rendered SVG in the browser.
const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { launchBrowser, openDiagramPage } = require('./support/diagram-page');
const { measurePackageDrawing, packageDefects, smallestTextOnScreen } = require('./support/package-drawings');

// A module view: a model package with an inheritance tree, and two modules
// shown as package nodes that depend on it through each other.
const MODULES = `@startuml
layout compact PANE
package shop {
  abstract class Item {
    + {abstract} price()
    + {abstract} deadline(start)
  }
  class Ticket {
    + price()
    + deadline(start)
  }
  class Room {
    + price()
    + deadline(start)
  }
  class Tour {
    + price()
    + deadline(start)
  }
  abstract class Transport {
    + deadline(start)
  }
  class Bus {
    + price()
  }
}
Ticket --|> Item
Room --|> Item
Tour --|> Item
Transport --|> Item
Bus --|> Transport
package payloads
package checkout
payloads ..> shop : «import»
checkout ..> payloads : «use»
note left of payloads
Folder with its name inside:
a module without its contents.
end note
note right of checkout
The module depends on the
other without importing it.
end note
@enduml`;

const STRUCTURE = { members: { shop: ['Item', 'Ticket', 'Room', 'Tour', 'Transport', 'Bus'] } };
const PANES = [{ width: 977, height: 719 }, { width: 1100, height: 800 }, { width: 700, height: 800 }];

// Segments of the routes that pass through the inside of a box that is at
// neither end of the route.
function routesThroughBoxes(drawing) {
  const inside = (p, b) => p.x > b.x + 1 && p.x < b.x + b.width - 1 && p.y > b.y + 1 && p.y < b.y + b.height - 1;
  const touches = (p, b) => p.x >= b.x - 1 && p.x <= b.x + b.width + 1 && p.y >= b.y - 1 && p.y <= b.y + b.height + 1;
  const found = [];
  for (const route of drawing.routes) {
    const ends = [route.points[0], route.points[route.points.length - 1]];
    for (const box of drawing.boxes) {
      if (ends.some((p) => touches(p, box))) continue;
      for (let i = 1; i < route.points.length; i++) {
        const a = route.points[i - 1], b = route.points[i];
        const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2);
        for (let k = 1; k < steps; k++) {
          const p = { x: a.x + (b.x - a.x) * k / steps, y: a.y + (b.y - a.y) * k / steps };
          if (inside(p, box)) { found.push(`${route.id || 'hierarchy'} through ${box.id}`); k = steps; i = route.points.length; }
        }
      }
    }
  }
  return found;
}

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { if (browser) await browser.close(); });

for (const pane of PANES) {
  const size = `${pane.width}x${pane.height}`;
  test(`compact module view for ${size}: frames hold exactly their members and no line runs through a package node`, async () => {
    const page = await openDiagramPage(browser);
    try {
      const drawing = await measurePackageDrawing(page, 'UMLClassDiagram', MODULES.replace('PANE', size), pane);
      assert.equal(drawing.issues, null, 'the drawing has no layout issues');
      assert.deepEqual(packageDefects(drawing, STRUCTURE), []);
      assert.deepEqual(routesThroughBoxes(drawing), []);
    } finally {
      await page.close();
    }
  });
}

// A subclass that is its parent's only one sits straight below it, also
// when its parent is one of a row of siblings the squeeze evens out: the
// evened row takes the subclass along. Before, evening moved Transport
// alone, the squeeze bent its line and was rejected, and compact kept the
// unsqueezed drawing (13.3 px against the default drawing's 11.9 px at
// 977x719, where the squeezed one has 17.0 px). A fifth larger text than
// the default drawing's is what a closed-up drawing gives here.
for (const pane of PANES) {
  const size = `${pane.width}x${pane.height}`;
  test(`compact module view for ${size}: the squeeze closes the inheritance rows, the only subclass straight below its parent`, async () => {
    const page = await openDiagramPage(browser);
    try {
      const compact = await measurePackageDrawing(page, 'UMLClassDiagram', MODULES.replace('PANE', size), pane);
      const normal = await measurePackageDrawing(page, 'UMLClassDiagram', MODULES.replace('layout compact PANE\n', ''), pane);
      const at = Object.fromEntries(compact.boxes.map((b) => [b.id, b]));
      const centre = (b) => b.x + b.width / 2;
      assert.ok(Math.abs(centre(at.Bus) - centre(at.Transport)) < 1,
        `Bus centred at ${centre(at.Bus).toFixed(1)}, Transport at ${centre(at.Transport).toFixed(1)}`);
      const now = smallestTextOnScreen(compact, pane), was = smallestTextOnScreen(normal, pane);
      assert.ok(now >= 1.2 * was, `compact ${now.toFixed(2)} px, default ${was.toFixed(2)} px`);
    } finally {
      await page.close();
    }
  });
}

// A module that only one other module uses sits beside the module it
// uses, which also depends on the package frame: both dependencies then run
// straight, «use» across and «import» up to the frame.
const bendsOf = (route) => {
  let count = 0;
  for (let i = 2; i < route.points.length; i++) {
    const a = route.points[i - 2], b = route.points[i - 1], c = route.points[i];
    if (Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) > 1e-6) count++;
  }
  return count;
};
for (const pane of PANES) {
  const size = `${pane.width}x${pane.height}`;
  test(`compact module view for ${size}: the module dependencies run straight`, async () => {
    const page = await openDiagramPage(browser);
    try {
      const drawing = await measurePackageDrawing(page, 'UMLClassDiagram', MODULES.replace('PANE', size), pane);
      const at = Object.fromEntries(drawing.boxes.map((b) => [b.id, b]));
      const touches = (p, b) => p.x >= b.x - 1 && p.x <= b.x + b.width + 1 && p.y >= b.y - 1 && p.y <= b.y + b.height + 1;
      const module = drawing.routes.filter((r) => [r.points[0], r.points[r.points.length - 1]].some((p) => touches(p, at.payloads)));
      assert.equal(module.length, 2, 'two lines meet payloads');
      assert.deepEqual(module.map(bendsOf), [0, 0], 'neither line bends');
    } finally {
      await page.close();
    }
  });
}
