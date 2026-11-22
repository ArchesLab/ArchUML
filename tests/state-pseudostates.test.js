const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const path = require('node:path');
const { chromium } = require('playwright');

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser.close(); });

// Render one diagram and return what `inspect(container, parseResult)` reads from it.
async function render(module, source, inspect) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  try {
    await page.setContent('<html><body><div id="diagram"></div></body></html>');
    await page.addScriptTag({ path: path.join(__dirname, '../uml-bundle.js') });
    return await page.evaluate(({ module, source, inspect }) => {
      const container = document.getElementById('diagram');
      window[module].render(container, source);
      return new Function('container', 'model', 'return (' + inspect + ')(container, model)')(
        container, window[module].parse(source));
    }, { module, source, inspect: inspect.toString() });
  } finally {
    await page.close();
  }
}

const wrap = body => `@startuml\n${body}\n@enduml`;

const pseudostates = [
  { stereotype: 'choice', type: 'choice' },
  { stereotype: 'junction', type: 'junction' },
  { stereotype: 'history', type: 'history', symbol: 'H' },
  { stereotype: 'shallowHistory', type: 'history', symbol: 'H' },
  { stereotype: 'deepHistory', type: 'deepHistory', symbol: 'H*' },
  { stereotype: 'history*', type: 'deepHistory', symbol: 'H*' },
  { stereotype: 'fork', type: 'fork' },
  { stereotype: 'join', type: 'join' },
  { stereotype: 'terminate', type: 'terminate' },
];

for (const pseudostate of pseudostates) {
  test(`state P <<${pseudostate.stereotype}>> is a ${pseudostate.type} pseudostate drawn as a symbol`, async () => {
    const result = await render('UMLStateDiagram', wrap(`state A\nstate P <<${pseudostate.stereotype}>>\nA --> P : go`),
      (container, model) => ({
        type: model.states.find(state => state.name === 'P').type,
        texts: [...container.querySelectorAll('svg text')].map(text => text.textContent),
        drawn: container.querySelectorAll('[data-layout-id="P"]').length > 0,
        transitions: container.querySelectorAll('[data-layout-route-id][data-layout-target="P"]').length,
      }));
    assert.equal(result.type, pseudostate.type);
    assert.ok(result.drawn, 'the pseudostate has a symbol that carries its layout id');
    assert.ok(!result.texts.includes('P'), 'a pseudostate shows its symbol, not its name');
    if (pseudostate.symbol) assert.ok(result.texts.includes(pseudostate.symbol), `the symbol is labelled ${pseudostate.symbol}`);
    assert.equal(result.transitions, 1, 'the transition into the pseudostate is drawn');
  });
}

test('the strokes of a terminate cross and a fork bar are not transition routes', async () => {
  const routes = await render('UMLStateDiagram', wrap('state A\nstate Stop <<terminate>>\nstate Split <<fork>>\nA --> Split\nSplit --> Stop'),
    container => window.UMLShared.collectEditableRoutes(container.querySelector('svg')).length);
  assert.equal(routes, 2, 'only the two authored transitions are editable routes');
});

// The layout engine may rotate a diagram to fit its container, so the bar is
// judged against the way the transition into it actually runs.
for (const direction of ['vertical', 'horizontal']) {
  for (const containerWidth of [1400, 320]) {
    test(`a fork bar lies across the flow under layout ${direction} in a ${containerWidth}px container`, async () => {
      const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
      try {
        await page.setContent(`<html><body><div id="diagram" style="width:${containerWidth}px"></div></body></html>`);
        await page.addScriptTag({ path: path.join(__dirname, '../uml-bundle.js') });
        const shape = await page.evaluate(source => {
          const container = document.getElementById('diagram');
          window.UMLStateDiagram.render(container, source);
          const box = id => container.querySelector(`rect[data-layout-id="${id}"]`).getBBox();
          const from = box('A'), bar = box('Split');
          const dx = (bar.x + bar.width / 2) - (from.x + from.width / 2);
          const dy = (bar.y + bar.height / 2) - (from.y + from.height / 2);
          return { flowsDown: Math.abs(dy) > Math.abs(dx), barIsWide: bar.width > bar.height };
        }, wrap(`layout ${direction}\nstate A\nstate Split <<fork>>\nstate B\nstate C\nA --> Split\nSplit --> B\nSplit --> C`));
        assert.equal(shape.barIsWide, shape.flowsDown, 'a bar is wide when the flow runs down, tall when it runs across');
      } finally {
        await page.close();
      }
    });
  }
}

for (const declaration of ['state Ready <<stable>>', 'state Ready <<stable>> {\n  state Inner\n}']) {
  test(`a stereotype is shown above the name of ${declaration.includes('{') ? 'a composite' : 'a simple'} state`, async () => {
    const result = await render('UMLStateDiagram', wrap(`${declaration}\n[*] --> Ready`), (container, model) => {
      const find = content => [...container.querySelectorAll('svg text')].find(text => text.textContent === content);
      const stereotype = find('«stable»'), name = find('Ready');
      return {
        state: model.states.find(state => state.name === 'Ready'),
        stereotypeY: stereotype && stereotype.getBBox().y,
        nameY: name && name.getBBox().y,
      };
    });
    assert.equal(result.state.type, 'state', 'an unknown stereotype does not turn a state into a pseudostate');
    assert.equal(result.state.stereotype, 'stable');
    assert.ok(result.stereotypeY < result.nameY, 'the stereotype sits above the name');
  });
}

test('a stereotype named like a built-in property stays a stereotype', async () => {
  const state = await render('UMLStateDiagram', wrap('state Ready <<constructor>>\n[*] --> Ready'),
    (container, model) => model.states.find(candidate => candidate.name === 'Ready'));
  assert.deepEqual({ type: state.type, stereotype: state.stereotype }, { type: 'state', stereotype: 'constructor' });
});
