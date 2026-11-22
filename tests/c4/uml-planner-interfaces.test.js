'use strict';

// The interfaces view planner (UML-view editing spec §5.5, §4.2, §14 D3; plan Task 46): what each gesture on an
// interfaces view, `interfaces of ‹element›` drawn as a UML component diagram, changes in design.yml, and when it is
// refused. Each row runs through the C4 model adapter (plan Task 36) on a real editor state, the real C4 core, and
// the real shared actions, so the oracle is the model the editor holds afterwards, or the refusal's code with the text
// unchanged. Only the relationship form is a fake: it is a dialog, and the planner's part ends when it opens it with
// the right ends, lead, and extra commands (the fake writes them as the form's submit does, so their effect is checked
// on the real core).
//
// The drawing of `interfaces of api` (course-registration-interfaces.yml): the Planner Web App (e1) uses the
// Registration API's Enrollment API (ball p1, socket r1); the Registration API (e2, the subject) uses the Billing
// System's Tuition Charges (ball p2 on e3, socket r2).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadCore, fixture } = require('./helpers.js');

const C4 = loadCore();
const EDITOR = path.join(__dirname, '..', '..', 'c4', 'editor');
const { createEditorState } = require(path.join(EDITOR, 'c4-editor-state.js'));
const { createActions } = require(path.join(EDITOR, 'c4-editor-actions.js'));
const refusals = require(path.join(EDITOR, 'c4-editor-uml-refusals.js'));
const layout = require(path.join(EDITOR, 'c4-editor-uml-layout.js'));
const { createUmlAdapter } = require(path.join(EDITOR, 'c4-editor-uml-adapter.js'));
const { placeholderName, modelWideWording } = require(path.join(EDITOR, 'c4-editor-actions-shared.js'));
const interfacesView = require(path.join(EDITOR, 'c4-editor-uml-interfaces.js'));
const { revisionOf } = require(path.join(__dirname, '..', '..', 'diagram-editor', 'de-operations.js'));

const DESIGN = fixture('course-registration-interfaces.yml');
const VIEW = 'interfaces of api';
const USE_OF_ENROLLMENT = 'web->coordinator';

// The Registration API also provides Schedule API, which nothing uses yet: drawn as a ball of its own.
const PROVIDES = '        provides:\n';
const WITH_SCHEDULE = (() => {
  assert.ok(DESIGN.includes(PROVIDES), 'the fixture still has the provides map of the Registration API');
  return DESIGN.replace(PROVIDES, `${PROVIDES}          schedule-api:\n            name: Schedule API\n            operations:\n              list-sections: GET /v1/sections\n`);
})();

// ---- The harness ----------------------------------------------------------------------------------------------

/**
 * An editor on `text` with `interfaces of api` open: its state, the real shared actions (confirmations answer yes),
 * and the C4 model adapter serving the interfaces view module. `forms` records each opening of the relationship form,
 * and `confirms` each confirmation the adapter asked; `announced` what the shared actions said.
 */
function harness({ text = DESIGN, view = VIEW, lockedFields } = {}) {
  const changes = [];
  const announced = [];
  const state = createEditorState({ text, view, profile: 'expert', lockedFields, host: { onTextChange: (changed, info) => changes.push(info) } });
  const dom = { createMenus: () => ({}), createAnnouncer: () => () => {} };
  const actions = createActions({}, { state, dom, ids: { next: (prefix) => prefix }, announce: (message) => announced.push(message),
    host: { confirm: async () => true } });
  const forms = [];
  // The form's submit: the new relationship and the commands the canvas asked for, in one batch (one undo step).
  actions.openRelationshipForm = (target, placement) => {
    forms.push({ target, placement });
    const add = { op: 'addRelationship', sourceId: target.sourceId, targetId: target.targetId, description: 'sends plans to' };
    return Promise.resolve(state.dispatch({ op: 'batch', commands: [add].concat(placement.alsoDispatch || []) }, { label: 'Add a relationship' }));
  };
  const confirms = [];
  const adapter = createUmlAdapter({ state, actions, views: { 'uml-component': interfacesView }, refusals, layout, profile: 'expert',
    confirm: (request) => { confirms.push(request); return Promise.resolve(true); }, dialogs: {}, forms: {} });
  return { state, adapter, changes, forms, confirms, announced, model: () => state.getDesign().model };
}

/** The module's context for `interfaces of api` of `text`, as the adapter builds it (plan Task 34). */
function contextOf(text = DESIGN) {
  const design = C4.load(text);
  const viewModel = C4.project(design, VIEW);
  const uml = C4.toUml(viewModel);
  return { design, viewModel, uml, profile: 'expert', checksReleased: true, revision: revisionOf(uml.text), layout: viewModel.layout, droppedRoutes: [] };
}

/** An operation built against the adapter's current reading. */
function operation(h, op, fields = {}) {
  return Object.assign({ op, revision: h.adapter.contents().revision }, fields);
}

/** The alias of the ball (role 'provided') or socket ('required') of `interfaceId` on the box of `elementId`. */
function portAlias(h, role, interfaceId, elementId) {
  const port = h.adapter.contents().elements.find((candidate) => candidate.kind === `${role}-interface`
    && candidate.ref.interfaceId === interfaceId && candidate.ref.elementId === elementId);
  assert.ok(port, `the drawing has the ${role} interface ${interfaceId} on ${elementId}`);
  return port.id;
}

/** The alias of the box of `elementId`. */
function boxAlias(h, elementId) {
  const box = h.adapter.contents().elements.find((candidate) => candidate.kind === 'component' && candidate.ref.elementId === elementId);
  assert.ok(box, `the drawing has a box for ${elementId}`);
  return box.id;
}

/** The relation reference (spec §3.4) of the line of `interfaceId` used by `consumerId`. */
function lineRef(h, interfaceId, consumerId) {
  const line = h.adapter.contents().relations.find((candidate) => candidate.kind === 'assembly'
    && candidate.ref.interfaceId === interfaceId && candidate.ref.consumerId === consumerId);
  assert.ok(line, `the drawing has a line of ${interfaceId} used by ${consumerId}`);
  return { routeId: line.routeId, line: line.line, candidates: [] };
}

/** Applies `op` and checks that it was refused with `code` and changed nothing. */
async function assertRefused(h, op, code) {
  const before = h.state.getText();
  const verdict = await h.adapter.apply(op);
  assert.equal(verdict.ok, false, `${op.op} is refused`);
  assert.equal(verdict.code, code, `${op.op} is refused with ${code} (${verdict.message})`);
  assert.equal(h.state.getText(), before, 'no text changed');
  return verdict;
}

/** Applies `op` and checks that it was accepted as one change, one undo step. */
async function assertApplied(h, op) {
  const verdict = await h.adapter.apply(op);
  assert.equal(verdict.ok, true, `${op.op} is accepted (${verdict.code}: ${verdict.message})`);
  assert.equal(h.changes.length, 1, 'one change, so one undo step');
  return verdict;
}

const relationship = (h, id) => h.model().relationships.find((candidate) => candidate.id === id) || null;
const usesOf = (h, id) => relationship(h, id).uses.map((use) => use.text);

// ---- Rows that change the model (spec §5.5) -------------------------------------------------------------------

test('Add a provided interface writes addInterface { elementId: api, name: "New interface" }', async () => {
  const h = harness();
  const before = [...h.model().interfaces.keys()];

  await assertApplied(h, operation(h, 'element.add', { tool: 'provide', name: null, into: null, anchor: null, placed: 'click', facts: { positions: {} } }));

  const added = [...h.model().interfaces.values()].filter((declared) => !before.includes(declared.id));
  assert.deepEqual(added.map((declared) => [declared.providerId, declared.name]), [['api', placeholderName('interface')]]);
});

test('adding one on a neighbour is interfaces/declared-elsewhere with the offer to open its owner\'s interfaces view', async () => {
  const h = harness();

  const verdict = await assertRefused(h, operation(h, 'element.add', { tool: 'provide', name: null, into: boxAlias(h, 'billing'), anchor: null, placed: 'dropped' }),
    'interfaces/declared-elsewhere');

  assert.equal(verdict.offer && verdict.offer.view, 'interfaces of billing');
  assert.equal(verdict.message, refusals.verdict('interfaces/declared-elsewhere', { Owner: 'Billing System' }).message,
    'an addition names no interface yet, so it gets the sentence of an addition');
});

test('a use from web to Enrollment API with a relationship writes setUses', async () => {
  // Schedule API is a second interface of the Registration API: the Planner Web App's relationship to the Registration
  // Coordinator, a part of the Registration API, may use it.
  const h = harness({ text: WITH_SCHEDULE });

  await assertApplied(h, operation(h, 'relation.add', { tool: 'use', from: boxAlias(h, 'web'), to: portAlias(h, 'provided', 'schedule-api', 'api'), label: null }));

  assert.deepEqual(usesOf(h, USE_OF_ENROLLMENT), ['enrollment-api.submit-plan', 'schedule-api'], 'the use joins the relationship\'s uses');
});

test('without one it opens the relationship form and writes batch[addRelationship, setUses]', async () => {
  const h = harness();

  await assertApplied(h, operation(h, 'relation.add', { tool: 'use', from: boxAlias(h, 'web'), to: portAlias(h, 'provided', 'tuition-charges', 'billing'), label: null }));

  assert.equal(h.forms.length, 1, 'the relationship form opened once');
  assert.deepEqual(h.forms[0].target, { sourceId: 'web', targetId: 'billing' });
  assert.match(h.forms[0].placement.lead, /adds that relationship to the model/, 'the form says that it adds a relationship to the model');
  assert.deepEqual(usesOf(h, 'web->billing'), ['tuition-charges'], 'the new relationship uses Tuition Charges');
});

test('renaming a ball runs actions.renameInterface with model-wide wording', async () => {
  const h = harness();

  await assertApplied(h, operation(h, 'element.rename', { ref: portAlias(h, 'provided', 'enrollment-api', 'api'), text: 'Enrolment API' }));

  assert.equal(h.model().interfaces.get('enrollment-api').name, 'Enrolment API', 'the name changes and the id stays');
  assert.deepEqual(h.announced, [modelWideWording.rename('Enrollment API', 'Enrolment API').message]);
});

test('renaming the socket of an interface the subject requires from Billing is interfaces/declared-elsewhere', async () => {
  const h = harness();

  await assertRefused(h, operation(h, 'element.rename', { ref: portAlias(h, 'required', 'tuition-charges', 'api'), text: 'Fees' }), 'interfaces/declared-elsewhere');
});

test('deleting a ball nothing uses runs removeInterface after its confirmation', async () => {
  const h = harness({ text: WITH_SCHEDULE });

  await assertApplied(h, operation(h, 'element.remove', { ref: portAlias(h, 'provided', 'schedule-api', 'api') }));

  assert.equal(h.confirms.length, 1, 'one confirmation was asked');
  assert.equal(h.confirms[0].title, 'Delete Schedule API?');
  assert.equal(h.model().interfaces.has('schedule-api'), false);
  assert.ok(h.model().interfaces.has('enrollment-api'), 'the other interface stays');
});

test('deleting a line removes the interface from every relationship behind it after a confirmation that lists them', async () => {
  const h = harness();

  await assertApplied(h, operation(h, 'selection.remove', { elements: [], relations: [lineRef(h, 'enrollment-api', 'web')], fragments: [], activations: [] }));

  assert.equal(h.confirms.length, 1, 'one confirmation was asked');
  assert.deepEqual(h.confirms[0].details, ['Planner Web App submits plans to Registration Coordinator'], 'it lists the relationship behind the line');
  assert.deepEqual(usesOf(h, USE_OF_ENROLLMENT), [], 'the use is gone');
  assert.equal(relationship(h, USE_OF_ENROLLMENT).description, 'submits plans to', 'the relationship stays');
});

test('deleting a socket deletes its element\'s use of the interface after a confirmation, as its line does', async () => {
  const h = harness();

  await assertApplied(h, operation(h, 'element.remove', { ref: portAlias(h, 'required', 'enrollment-api', 'web') }));

  assert.equal(h.confirms.length, 1, 'one confirmation was asked');
  assert.deepEqual(usesOf(h, USE_OF_ENROLLMENT), [], 'the use is gone');
  assert.ok(h.model().interfaces.has('enrollment-api'), 'the interface stays');
});

test('declining the confirmation of a line\'s deletion changes nothing', async () => {
  const h = harness();
  const confirmLess = createUmlAdapter({ state: h.state, actions: {}, views: { 'uml-component': interfacesView }, refusals, layout, profile: 'expert',
    confirm: () => Promise.resolve(false), dialogs: {}, forms: {} });

  const verdict = await confirmLess.apply(operation(h, 'selection.remove', { elements: [], relations: [lineRef(h, 'enrollment-api', 'web')], fragments: [], activations: [] }));

  assert.deepEqual([verdict.ok, verdict.code], [false, 'cancelled']);
  assert.equal(h.changes.length, 0, 'nothing was written');
});

test('deleting two things at once is refused as one-at-a-time with its own words, and changes nothing', async () => {
  const h = harness();

  const verdict = await assertRefused(h, operation(h, 'selection.remove', {
    elements: [boxAlias(h, 'api')], relations: [lineRef(h, 'enrollment-api', 'web')], fragments: [], activations: [],
  }), 'one-at-a-time');

  assert.match(verdict.message, /deletes one thing at a time/);
});

test('renaming a component box runs the shared rename with model-wide wording', async () => {
  const h = harness();

  await assertApplied(h, operation(h, 'element.rename', { ref: boxAlias(h, 'web'), text: 'Planner App' }));

  assert.equal(h.model().elements.get('web').name, 'Planner App');
  assert.deepEqual(h.announced, [modelWideWording.rename('Planner Web App', 'Planner App').message]);
});

// ---- Rows that are refused (spec §5.5) ------------------------------------------------------------------------

test('moving an end, inverting, or editing the label is interfaces/assembly-ends, interfaces/assembly-direction, derived/assembly-label', async () => {
  const h = harness();
  const ref = lineRef(h, 'enrollment-api', 'web');

  await assertRefused(h, operation(h, 'relation.rewire', { ref, end: 'target', to: portAlias(h, 'provided', 'tuition-charges', 'billing') }), 'interfaces/assembly-ends');
  await assertRefused(h, operation(h, 'relation.invert', { ref }), 'interfaces/assembly-direction');
  await assertRefused(h, operation(h, 'relation.update', { ref, changes: { label: 'GET /v1/plans' } }), 'derived/assembly-label');
});

test('deleting a consumer box is interfaces/neighbour', async () => {
  const h = harness();

  const verdict = await assertRefused(h, operation(h, 'element.remove', { ref: boxAlias(h, 'web') }), 'interfaces/neighbour');

  assert.equal(verdict.message, refusals.verdict('interfaces/neighbour', { Name: 'Planner Web App', 'uses | provides': 'uses', Interface: 'Enrollment API' }).message);
});

test('a component, a port, or a note is refused', async () => {
  const h = harness();
  const add = (tool) => operation(h, 'element.add', { tool, name: null, into: null, anchor: null, placed: 'click' });

  await assertRefused(h, add('component'), 'interfaces/add-element');
  await assertRefused(h, add('portin'), 'not-in-model/port');
  await assertRefused(h, add('note'), 'not-in-model/note');
  assert.deepEqual(interfacesView.tools(contextOf()).unavailable.map((tool) => [tool.label, tool.code]),
    [['Component', 'interfaces/add-element'], ['Port', 'not-in-model/port'], ['Note', 'not-in-model/note']]);
});

test('a lock on the Registration API\'s provides refuses adding an interface with locked', async () => {
  const h = harness({ lockedFields: ['systems.registration.containers.api.provides'] });

  await assertRefused(h, operation(h, 'element.add', { tool: 'provide', name: null, into: null, anchor: null, placed: 'click' }), 'locked');
});

// ---- Layout (spec §4.2, §6) -----------------------------------------------------------------------------------

test('moving a box writes setUmlLayout positions for interfaces of api, and the first move pins every drawn box', async () => {
  const h = harness();
  const [web, api, billing] = ['web', 'api', 'billing'].map((id) => boxAlias(h, id));
  const facts = { positions: { [web]: { x: 40, y: 40 }, [api]: { x: 40, y: 300 }, [billing]: { x: 40, y: 560 } } };

  await assertApplied(h, operation(h, 'layout.set', { positions: { [web]: { x: 40, y: 820 } }, routes: [], facts }));

  const entry = h.model().layout.get(VIEW);
  assert.deepEqual(Object.fromEntries(entry.positions), { web: [40, 820], api: [40, 300], billing: [40, 560] });
});

test('moving a ball or socket is layout/port, and bending the line between a ball and its socket is layout/assembly', async () => {
  const h = harness();
  const facts = { positions: {} };

  await assertRefused(h, operation(h, 'layout.set', { positions: { [portAlias(h, 'provided', 'enrollment-api', 'api')]: { x: 10, y: 10 } }, routes: [], facts }), 'layout/port');
  await assertRefused(h, operation(h, 'layout.set', { positions: { [portAlias(h, 'required', 'enrollment-api', 'web')]: { x: 10, y: 10 } }, routes: [], facts }), 'layout/port');
  await assertRefused(h, operation(h, 'layout.set', { positions: {}, routes: [{ id: 'edge-0', points: [{ x: 0, y: 0 }, { x: 50, y: 50 }] }], facts }), 'layout/assembly');
  await assertRefused(h, operation(h, 'layout.set', { positions: {}, routes: [{ id: `rel:${lineRef(h, 'enrollment-api', 'web').line}`, points: [{ x: 0, y: 0 }, { x: 50, y: 50 }] }], facts }), 'layout/assembly');
});

// ---- Every code is a code of the reviewed table ---------------------------------------------------------------

/** Every operation a gesture on `interfaces of api` can build, on every drawn ref it can name. */
function everyOperation(context) {
  const reading = interfacesView.optionSets(context).flatMap((set) => set.options.map((option) => option.ref));
  const things = reading.filter((ref) => !/^rel:/.test(ref)).concat(Object.keys(context.uml.ids).filter((alias) => /^r\d+$/.test(alias)));
  const lines = reading.filter((ref) => /^rel:/.test(ref));
  const tools = ['provide', 'component', 'port', 'portin', 'portout', 'note'];
  return [].concat(
    tools.map((tool) => ({ op: 'element.add', tool, name: null, into: null })),
    things.map((ref) => ({ op: 'element.add', tool: 'provide', name: null, into: /^e\d+$/.test(ref) ? ref : null })),
    things.map((ref) => ({ op: 'element.rename', ref, text: 'Renamed' })),
    things.map((ref) => ({ op: 'element.remove', ref })),
    things.map((ref) => ({ op: 'element.duplicate', refs: [ref], offset: { x: 10, y: 10 } })),
    lines.map((ref) => ({ op: 'selection.remove', elements: [], relations: [ref], fragments: [], activations: [] })),
    [{ op: 'selection.remove', elements: things.slice(0, 2), relations: [], fragments: [], activations: [] }],
    things.flatMap((from) => things.flatMap((to) => ['use', 'depend', 'plain'].map((tool) => ({ op: 'relation.add', tool, from, to, label: null })))),
    lines.flatMap((ref) => [
      { op: 'relation.update', ref, changes: { label: 'x' } }, { op: 'relation.invert', ref },
      { op: 'relation.rewire', ref, end: 'source', to: things[0] },
    ]),
    things.map((ref) => ({ op: 'layout.set', positions: { [ref]: { x: 1, y: 1 } }, routes: [], facts: { positions: {} } })),
    lines.concat(['edge-0', 'edge-1']).map((id) => ({ op: 'layout.set', positions: {}, routes: [{ id, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }], facts: {} })),
    things.map((ref) => ({ op: 'layout.reset', target: { element: ref } })),
    lines.map((ref) => ({ op: 'layout.reset', target: { route: ref } })),
  );
}

// The one code outside the table is the module's own, as in the code, deployment, and dynamic views: a deletion of
// several things at once, which carries its own words.
const OWN_CODES = ['one-at-a-time'];

test('every code this module refuses with is a code of the reviewed refusal table, or one-at-a-time with its own words', () => {
  const table = new Set(refusals.codes().concat(OWN_CODES));
  const codes = new Set();
  for (const text of [DESIGN, WITH_SCHEDULE]) {
    const context = contextOf(text);
    everyOperation(context).forEach((op) => {
      const planned = interfacesView.plan(op, context);
      if (planned.kind !== 'refuse') return;
      codes.add(planned.code);
      if (OWN_CODES.includes(planned.code)) assert.ok(planned.summary && planned.message, `${planned.code} carries its own words`);
    });
    (interfacesView.targets({ op: 'relation.add', tool: 'use', from: 'e1', to: null, open: 'to' }, context) || [])
      .forEach((candidate) => { if (!candidate.ok) codes.add(candidate.code); });
    interfacesView.tools(context).unavailable.forEach((tool) => codes.add(tool.code));
  }

  assert.deepEqual([...codes].filter((code) => !table.has(code)), [], 'no code outside the table');
  assert.equal(table.has('layout/fixed-order'), false, 'the table no longer has layout/fixed-order');
  assert.ok(codes.has('layout/port') && codes.has('layout/assembly'), 'the sweep reached the layout refusals');
  assert.ok(codes.has('one-at-a-time'), 'the sweep reached a deletion of two things');
});

// ---- What the view offers -------------------------------------------------------------------------------------

test('the option sets are today\'s three sets of boxes, then Interfaces and Uses', () => {
  const sets = interfacesView.optionSets(contextOf());

  assert.deepEqual(sets.map((set) => [set.label, set.options.map((option) => option.name)]), [
    ['Using what Registration API provides', ['Planner Web App']],
    ['Subject of this view', ['Registration API']],
    ['Providing what Registration API requires', ['Billing System']],
    ['Interfaces', ['Enrollment API', 'Tuition Charges']],
    ['Uses', ['Planner Web App uses Enrollment API', 'Registration API uses Tuition Charges']],
  ]);
});

test('a ball says who provides it, and a use names the operations its consumer uses', () => {
  const sets = interfacesView.optionSets(contextOf());
  const description = (name) => sets.flatMap((set) => set.options).find((option) => option.name === name).description;

  assert.match(description('Enrollment API'), /^provided by Registration API;/);
  assert.match(description('Planner Web App uses Enrollment API'), /operation used: submit-plan \(POST \/v1\/enrollments\)$/);
});

test('C mode from the Planner Web App marks the balls it may use: not its own use of Enrollment API again', () => {
  const advice = interfacesView.targets({ op: 'relation.add', tool: 'use', from: 'e1', to: null, open: 'to' }, contextOf(WITH_SCHEDULE));

  assert.deepEqual(advice.map((candidate) => [interfaceOfBall(candidate.ref), candidate.ok]),
    [['schedule-api', true], ['enrollment-api', false], ['tuition-charges', true]]);
});

function interfaceOfBall(alias) {
  return contextOf(WITH_SCHEDULE).uml.ids[alias];
}

test('every drawn box holds a position, and no ball or socket does', () => {
  const context = contextOf();

  assert.deepEqual([...interfacesView.holders(context)].sort(), ['e1', 'e2', 'e3']);
});
