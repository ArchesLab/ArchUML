const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const path = require('node:path');
const { chromium } = require('playwright');

const examples = [
  {
    name: 'three-way result branch',
    source: `@startuml
state Evaluating
state Match
state NoMatch
state BudgetExceeded
[*] --> Evaluating
Evaluating --> Match : pattern found
Evaluating --> NoMatch : candidates exhausted
Evaluating --> BudgetExceeded : another check needed beyond budget
@enduml`,
    targets: { 'pattern found': 'Match', 'candidates exhausted': 'NoMatch', 'another check needed beyond budget': 'BudgetExceeded' },
  },
  {
    name: 'branch with a return transition',
    source: `@startuml
state InspectNext
state Advance
state Found
state Absent
[*] --> InspectNext
InspectNext --> Found : equals found
InspectNext --> Advance : other character
Advance --> InspectNext : next unexamined position
InspectNext --> Absent : end of input
@enduml`,
    targets: { 'equals found': 'Found', 'other character': 'Advance', 'next unexamined position': 'InspectNext', 'end of input': 'Absent' },
  },
];

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser.close(); });

for (const example of examples) {
  for (const theme of ['light', 'dark']) {
    test(`${example.name}: each label stays nearest its own transition in ${theme} mode`, async () => {
      const page = await browser.newPage({ viewport: { width: 1800, height: 1400 } });
      try {
        await page.setContent(`<html class="${theme === 'dark' ? 'dark-mode' : ''}"><body><div id="diagram"></div></body></html>`);
        await page.addScriptTag({ path: path.join(__dirname, '../uml-bundle.js') });
        const labels = await page.evaluate(source => {
          const container = document.getElementById('diagram');
          window.UMLStateDiagram.render(container, source);
          const routes = [...container.querySelectorAll('polyline[data-layout-target]')].map(route => ({
            id: route.getAttribute('data-layout-route-id'),
            target: route.getAttribute('data-layout-target'),
            points: [...route.points].map(point => ({ x: point.x, y: point.y })),
          }));
          function distanceToRoute(box, route) {
            let distance = Infinity;
            for (let i = 1; i < route.points.length; i++) {
              const start = route.points[i - 1], end = route.points[i];
              const dx = Math.max(Math.min(start.x, end.x) - box.x - box.width, box.x - Math.max(start.x, end.x), 0);
              const dy = Math.max(Math.min(start.y, end.y) - box.y - box.height, box.y - Math.max(start.y, end.y), 0);
              distance = Math.min(distance, Math.hypot(dx, dy));
            }
            return distance;
          }
          return [...container.querySelectorAll('text[data-layout-kind="edge-label"]')].map(label => {
            const routeId = label.getAttribute('data-layout-route-id');
            const own = routes.find(route => route.id === routeId);
            const box = label.getBBox();
            return {
              text: label.textContent,
              target: own && own.target,
              ownDistance: own && distanceToRoute(box, own),
              otherDistance: Math.min(...routes.filter(route => route.id !== routeId).map(route => distanceToRoute(box, route))),
            };
          });
        }, example.source);
        assert.equal(labels.length, Object.keys(example.targets).length, 'every authored transition label must render');
        for (const label of labels) {
          assert.equal(label.target, example.targets[label.text], `${label.text}: retain the authored destination`);
          assert.ok(label.ownDistance < label.otherDistance,
            `${label.text}: its own transition is ${label.ownDistance}px away, but another is ${label.otherDistance}px away`);
        }
      } finally {
        await page.close();
      }
    });
  }
}
