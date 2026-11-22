'use strict';

// `layout compact` for an inheritance hierarchy whose subclasses live in
// another package (plugins extending a base package): every subclass sits
// below its parent, so each generalization runs straight down, and the
// drawing has no layout issues. Measured from the rendered SVG.
const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { launchBrowser, openDiagramPage } = require('./support/diagram-page');
const { measurePackageDrawing, packageDefects } = require('./support/package-drawings');

const PLUGINS = `@startuml
layout compact PANE
package base {
  abstract class Gateway {
    + {abstract} place(order)
    + {abstract} cancel(order)
  }
  class Unavailable
  class TicketGateway {
    + place(order)
    + cancel(order)
  }
  class HotelGateway {
    + place(order)
    + cancel(order)
  }
  class BusGateway {
    + place(order)
    + cancel(order)
  }
  class TourGateway {
    + place(order)
    + cancel(order)
  }
}
package plugins {
  class CampingGateway {
    + cancel(order)
  }
  class CoachGateway {
    + place(order)
  }
  class GuideGateway {
    + cancel(order)
  }
  class ManualOnly
}
TicketGateway --|> Gateway
HotelGateway --|> Gateway
BusGateway --|> Gateway
TourGateway --|> Gateway
CampingGateway --|> HotelGateway
CoachGateway --|> BusGateway
GuideGateway --|> TourGateway
Gateway ..> Unavailable : raises
CampingGateway ..> ManualOnly : raises
GuideGateway ..> ManualOnly : raises
@enduml`;

const STRUCTURE = { members: {
  base: ['Gateway', 'Unavailable', 'TicketGateway', 'HotelGateway', 'BusGateway', 'TourGateway'],
  plugins: ['CampingGateway', 'CoachGateway', 'GuideGateway', 'ManualOnly'],
} };
const PANES = [{ width: 977, height: 719 }, { width: 1100, height: 800 }, { width: 700, height: 800 }];
const PARENT = { CampingGateway: 'HotelGateway', CoachGateway: 'BusGateway', GuideGateway: 'TourGateway' };

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { if (browser) await browser.close(); });

for (const pane of PANES) {
  const size = `${pane.width}x${pane.height}`;
  test(`compact plugins for ${size}: each subclass in the other package sits straight below its parent`, async () => {
    const page = await openDiagramPage(browser);
    try {
      const drawing = await measurePackageDrawing(page, 'UMLClassDiagram', PLUGINS.replace('PANE', size), pane);
      assert.equal(drawing.issues, null, 'the drawing has no layout issues');
      assert.deepEqual(packageDefects(drawing, STRUCTURE), []);
      const at = Object.fromEntries(drawing.boxes.map((b) => [b.id, b]));
      const centre = (b) => b.x + b.width / 2;
      const off = Object.entries(PARENT).filter(([child, parent]) =>
        Math.abs(centre(at[child]) - centre(at[parent])) >= 1 || at[child].y <= at[parent].y + at[parent].height);
      assert.deepEqual(off.map(([child]) => child), []);
    } finally {
      await page.close();
    }
  });
}
