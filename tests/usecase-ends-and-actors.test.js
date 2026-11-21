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

test('a use-case association may name an end in quotes', async () => {
  const relationships = await render('UMLUseCaseDiagram', wrap('actor User\nusecase "Log In"\nUser -- "Log In"\n"Log In" ..> "Log In" : <<include>>'),
    (container, model) => model.relationships.map(relationship => [relationship.from, relationship.to, relationship.type]));
  assert.deepEqual(relationships, [['User', 'Log In', 'association'], ['Log In', 'Log In', 'dependency']]);
});

test('an actor figure adds no editable routes of its own', async () => {
  const routes = await render('UMLUseCaseDiagram', wrap('actor User\nusecase "Login" as UC1\nUser -- UC1'),
    container => window.UMLShared.collectEditableRoutes(container.querySelector('svg')).length);
  assert.equal(routes, 1, 'the association is the only route');
});
