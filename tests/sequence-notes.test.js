'use strict';

// A note in a sequence diagram takes its own row. A combined fragment that
// follows a note starts clearly below it, so the note's border and the
// fragment's frame do not run together.
const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { launchBrowser, openDiagramPage, render } = require('./support/diagram-page');

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { if (browser) await browser.close(); });

test('a fragment that follows a note starts at least 16 px below it', async () => {
  const page = await openDiagramPage(browser);
  try {
    await render(page, 'UMLSequenceDiagram', [
      'participant task: CancellationTask',
      'participant order: TripOrder',
      'task -> order: mark_cancelling()',
      'note right of task',
      'A supplier order that fails stays',
      'cancelling and is tried again',
      'on the next run.',
      'end note',
      'opt [every supplier order cancelled]',
      'task -> order: mark_cancelled()',
      'end',
    ].join('\n'));
    const { note, frame } = await page.evaluate(() => ({
      note: measure.box(document.querySelector('#diagram svg .uml-note-box')),
      frame: measure.box(document.querySelector('#diagram svg rect[data-layout-fragment-id]')),
    }));
    const gap = frame.y - note.bottom;
    assert.ok(gap >= 16, `the fragment frame starts ${gap} px below the note`);
  } finally {
    await page.close();
  }
});
