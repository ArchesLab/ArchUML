const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const path = require('node:path');
const { chromium } = require('playwright');

let browser;
before(async () => {
  const executablePath = process.env.PLAYWRIGHT_CHROME_EXECUTABLE;
  browser = await chromium.launch(executablePath ? { executablePath } : {});
});
after(async () => { if (browser) await browser.close(); });

const examples = [
  { name: 'a declaration after the first call', source: 'caller -> p : takeTurn()\nparticipant p: Player', label: 'p: Player' },
  { name: 'an instance named after its class', source: 'participant Player: Player\nPlayer -> other : next()', label: 'Player: Player' },
  { name: 'an anonymous instance declared after a call', source: 'caller -> p : takeTurn()\nparticipant p as : Player', label: ': Player' },
  { name: 'an actor declared after a call', source: 'human -> p : next()\nactor human: User', label: 'human: User' },
];

for (const example of examples) {
  for (const theme of ['light', 'dark']) {
    test(`${example.name} displays the full underlined lifeline label in ${theme} mode`, async () => {
      const page = await browser.newPage();
      try {
        await page.setContent(`<!doctype html><html class="${theme === 'dark' ? 'dark-mode' : ''}"><head><title>Sequence label verification</title></head><body><div id="diagram"></div></body></html>`);
        await page.addScriptTag({ path: path.join(__dirname, '../uml-bundle.js') });
        await page.evaluate(source => {
          window.UMLSequenceDiagram.render(document.getElementById('diagram'), source);
        }, example.source);
        const labels = await page.getByText(example.label, { exact: true }).evaluateAll(elements => elements.map(element => ({
          text: element.textContent,
          underline: getComputedStyle(element).textDecorationLine,
          width: element.getBoundingClientRect().width,
        })));
        assert.ok(labels.length > 0, `missing lifeline label ${example.label}`);
        for (const label of labels) {
          assert.equal(label.text, example.label);
          assert.ok(label.underline.includes('underline'), 'an instance label must be underlined');
          assert.ok(label.width > 0, 'the lifeline label must be visible');
        }
      } finally {
        await page.close();
      }
    });
  }
}
