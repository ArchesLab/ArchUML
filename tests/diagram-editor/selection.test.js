'use strict';

// The selection set of a session (UML-view editing spec §2.2, §3.3; plan Task 22): references `{ id, kind }` in the
// order they were selected, and the primary one, the latest selected, which the Properties pane follows.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSelection } = require('../../diagram-editor/de-selection.js');

const order = { id: 'Order', kind: 'node' };
const invoice = { id: 'Invoice', kind: 'node' };
const places = { id: 'rel:5', kind: 'route' };

test('toggle adds and removes; set replaces; the primary is the last set', () => {
  const selection = createSelection();

  selection.set(order);
  selection.toggle(places);
  assert.deepEqual(selection.all(), [order, places], 'toggle adds after what is selected');
  assert.deepEqual(selection.primary(), places, 'the reference added last is the primary');

  selection.toggle(places);
  assert.deepEqual(selection.all(), [order], 'toggle removes a selected reference');

  selection.set(invoice);
  assert.deepEqual(selection.all(), [invoice], 'set replaces the whole selection');
  assert.deepEqual(selection.primary(), invoice);
});

test('removing the primary makes the latest selected of the rest the primary, and removing the last leaves none', () => {
  const selection = createSelection();
  selection.set(order);
  selection.toggle(invoice);
  selection.toggle(places);

  selection.toggle(places);
  assert.deepEqual(selection.primary(), invoice);

  selection.toggle(order);
  assert.deepEqual(selection.primary(), invoice, 'removing another reference keeps the primary');

  selection.toggle(invoice);
  assert.equal(selection.primary(), null);
  assert.deepEqual(selection.all(), []);
});

test('toggle removes an id selected as another kind; has matches the kind only when it is given', () => {
  const selection = createSelection();
  selection.set(order);

  assert.equal(selection.has({ id: 'Order' }), true);
  assert.equal(selection.has({ id: 'Order', kind: 'node' }), true);
  assert.equal(selection.has({ id: 'Order', kind: 'route' }), false);
  assert.equal(selection.has({ id: 'Invoice' }), false);

  selection.toggle({ id: 'Order', kind: 'fragment' });
  assert.equal(selection.has({ id: 'Order' }), false);
});

test('clear and set(null) select nothing', () => {
  const selection = createSelection();
  selection.set(order);
  selection.clear();
  assert.deepEqual([selection.all(), selection.primary()], [[], null]);

  selection.set(order);
  selection.set(null);
  assert.deepEqual([selection.all(), selection.primary()], [[], null]);
});

test('a reference read from the selection is a copy: changing it changes nothing selected', () => {
  const selection = createSelection();
  selection.set(order);

  selection.primary().kind = 'route';
  selection.all()[0].id = 'Changed';

  assert.deepEqual(selection.primary(), order);
  assert.deepEqual(selection.all(), [order]);
});

test('two selections share nothing', () => {
  const first = createSelection();
  const second = createSelection();

  first.set(order);

  assert.deepEqual(second.all(), []);
  assert.equal(second.primary(), null);
});
