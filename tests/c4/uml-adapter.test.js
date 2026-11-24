'use strict';

// The C4 model adapter (UML-view editing spec §3.4, §5.1, plan Task 36): what the diagram editor reads of a drawn
// UML-notation view, and how an operation of the module becomes one batch through the editor state, a shared action, a
// form, or a refusal in the learner's words. The editor state and the C4 core are real; the view module, the shared
// actions, the forms, and the confirmation are fakes at the ports this work owns. Every oracle reads the state's text,
// the host's change log, or the verdict's code; words are compared only with the function that owns them.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadCore, fixture } = require('./helpers.js');

const C4 = loadCore();
const EDITOR = path.join(__dirname, '..', '..', 'c4', 'editor');
const operations = require(path.join(__dirname, '..', '..', 'diagram-editor', 'de-operations.js'));
const { createEditorState } = require(path.join(EDITOR, 'c4-editor-state.js'));
const refusals = require(path.join(EDITOR, 'c4-editor-uml-refusals.js'));
const layout = require(path.join(EDITOR, 'c4-editor-uml-layout.js'));
const { createUmlAdapter } = require(path.join(EDITOR, 'c4-editor-uml-adapter.js'));

const REFERENCE = fixture('course-registration-interfaces.yml');
const POLICY = 'code of policy';
const ADD_CLASS = { op: 'addElement', parentId: 'policy', type: 'code', kind: 'class', name: 'New class' };
const UNKNOWN_END = { op: 'addRelationship', sourceId: 'EnrollmentPolicy', targetId: 'nowhere', description: 'asks', technology: null };
const EXTENDS_INTERFACE = { op: 'setList', elementId: 'PrerequisiteRule', field: 'extends', items: ['EnrollmentRule'] };
const EXTENDS_VALUES = { Source: 'PrerequisiteRule', Target: 'EnrollmentRule', relation: 'extends', sourceKind: 'class', targetKind: 'interface' };
const NOTATIONS = { code: 'uml-class', dynamic: 'uml-sequence', deployment: 'uml-deployment', interfaces: 'uml-component' };

/** A fake view module: `plan(operation)` answers with `planned`, and every call is recorded. */
function fakeModule({ planned = { kind: 'commands', commands: [ADD_CLASS], label: 'Add a class', select: null, message: 'Added a class.' },
  fromForm = () => ({ kind: 'commands', commands: [ADD_CLASS], label: 'Add a class', select: null, message: 'Added a class.' }),
  targets = () => [] } = {}) {
  const calls = { plan: 0, fromForm: 0, targets: 0 };
  const module = {
    notation: 'uml-class',
    editable: true,
    plan: (operation, context) => { calls.plan += 1; return typeof planned === 'function' ? planned(operation, context) : planned; },
    fromForm: (form, values, context) => { calls.fromForm += 1; return fromForm(form, values, context); },
    targets: (request, context) => { calls.targets += 1; return targets(request, context); },
    holders: () => new Set(),
    layoutRefusal: () => null,
  };
  return { module, calls };
}

/**
 * An editor state on `text` with `view` open and an adapter over it. Every module given serves all four notations.
 * The host records each change it is told; the clock advances a second per reading, so one undo step is one edit.
 */
function harness({ text = REFERENCE, view = POLICY, module = fakeModule().module, readOnly, lockedFields, actions = {}, forms = {},
  confirm = () => Promise.resolve(true), dialogs = {} } = {}) {
  const changes = [];
  let clock = 0;
  const state = createEditorState({ text, view, readOnly, lockedFields, now: () => (clock += 1000),
    host: { onTextChange: (changed, info) => changes.push(info) } });
  const views = Object.fromEntries(Object.values(NOTATIONS).map((notation) => [notation, module]));
  const adapter = createUmlAdapter({ state, actions, views, refusals, layout, confirm, dialogs, forms });
  return { state, adapter, changes };
}

/** An operation of the module's vocabulary built against the adapter's current reading. */
function operation(adapter, op, fields = {}) {
  return Object.assign({ op, revision: adapter.contents().revision }, fields);
}

const ADD = (adapter) => operation(adapter, 'element.add', { tool: 'class', name: null, into: null, anchor: null, placed: 'automatic' });

// ---- contents ----------------------------------------------------------------------------------------------------

/** The contents item standing for source line `index`: an element, a member, a relation, or a fragment's line. */
function itemAt(contents, index) {
  for (const element of contents.elements) {
    if (element.line === index) return { item: element, as: 'element' };
    const member = element.members.find((candidate) => candidate.line === index);
    if (member) return { item: member, owner: element, as: 'member' };
  }
  const relation = contents.relations.find((candidate) => candidate.line === index);
  if (relation) return { item: relation, as: 'relation' };
  const fragment = contents.fragments.find((candidate) => candidate.startLine === index || candidate.endLine === index
    || candidate.branches.some((branch) => branch.line === index));
  return fragment ? { item: fragment, as: 'fragment' } : null;
}

/** What the contents item for `entry` (a source-map line entry of view `viewModel`) must say of the model. */
function expectModelRef(found, entry, viewModel, design) {
  const scope = viewModel.scopeId;
  const expectations = {
    element: () => ['element', { elementId: entry.id }],
    participant: () => ['element', { elementId: entry.id }],
    box: () => ['element', { elementId: entry.id }],
    node: () => ['element', { environmentId: scope, nodeId: entry.id }],
    instance: () => ['element', { elementId: entry.elementId, nodeId: entry.nodeId, environmentId: scope }],
    port: () => ['element', { interfaceId: entry.interfaceId, elementId: entry.elementId, role: entry.role }],
    member: () => ['member', null],
    relation: () => ['relation', { relationshipId: entry.relationshipId, relation: entry.relation, from: entry.modelFrom, to: entry.modelTo }],
    message: () => ['relation', { scenarioId: scope, containerPath: entry.containerPath, index: entry.index }],
    link: () => ['relation', { environmentId: scope, from: entry.from, to: entry.to, derived: entry.derived, relationshipIds: entry.relationshipIds }],
    assembly: () => ['relation', { interfaceId: entry.interfaceId, providerId: entry.providerId, consumerId: entry.consumerId }],
    fragment: () => ['fragment', { scenarioId: scope, containerPath: entry.containerPath, index: entry.index }],
    branch: () => ['fragment', { scenarioId: scope, containerPath: entry.containerPath, index: entry.index }],
    'fragment-end': () => ['fragment', { scenarioId: scope, containerPath: entry.containerPath, index: entry.index }],
  };
  const [as, ref] = expectations[entry.kind]();
  assert.equal(found.as, as, `a ${entry.kind} line is ${as === 'element' ? 'an' : 'a'} ${as}`);
  if (as === 'member') {
    const declared = design.model.elements.get(entry.id).code[entry.list][entry.index];
    assert.deepEqual([found.owner.ref.elementId, found.item.list, found.item.index], [entry.id, entry.list, entry.index]);
    assert.equal(found.item.text, entry.synthesized ? null : declared, 'a member starts from the model\'s text');
    return;
  }
  assert.deepEqual(found.item.ref, ref);
}

test('contents maps every source line to elements, relations, and fragments with model refs and the text\'s revision', () => {
  for (const selector of [POLICY, 'dynamic enroll', 'deployment production', 'interfaces of api']) {
    const { adapter, state } = harness({ view: selector });
    const design = state.getDesign();
    const viewModel = C4.project(design, selector);
    const uml = C4.toUml(viewModel);

    const contents = adapter.contents();

    assert.equal(contents.revision, operations.revisionOf(uml.text), `${selector}: the revision is the drawn text's`);
    assert.equal(contents.type, uml.type, `${selector}: the drawing's type`);
    uml.source.lines.forEach((entry, index) => {
      if (entry === null) return;
      const found = itemAt(contents, index);
      assert.ok(found, `${selector}: line ${index} (${entry.kind}) has a contents item`);
      expectModelRef(found, entry, viewModel, design);
    });
    for (const element of contents.elements.filter((candidate) => candidate.kind !== 'box')) {
      assert.ok(Object.prototype.hasOwnProperty.call(uml.ids, element.id), `${selector}: element ${element.id} is a drawn alias`);
    }
  }
});

test('contents gives the drawn lines without the layout block, so the line a relation names is the one that draws it', () => {
  // code of policy keeps a position here, so its drawn text has a layout block above the lines the source map counts.
  const pinned = `${REFERENCE}layout:\n  ${POLICY}:\n    positions:\n      EnrollmentPolicy: [40, 40]\n`;
  const { adapter, state } = harness({ text: pinned });
  const uml = C4.toUml(C4.project(state.getDesign(), POLICY));
  const aliasOf = (id) => Object.keys(uml.ids).find((alias) => uml.ids[alias] === id);
  assert.ok(uml.text.split('\n').includes('@layout'), 'the drawn text has a layout block');

  const { lines } = adapter.contents();

  assert.equal(lines.length, uml.source.lines.length, 'one line for each line the source map counts');
  uml.source.lines.forEach((entry, index) => {
    if (entry === null || entry.kind !== 'relation') return;
    assert.match(lines[index], new RegExp(`^\\s*${aliasOf(entry.from)}\\s+\\S+\\s+${aliasOf(entry.to)}\\b`),
      `line ${index} draws the ${entry.relation} from ${entry.from} to ${entry.to}`);
  });
});

test('a dynamic view\'s contents count its message anchors and its relations in the same lines', () => {
  const { adapter } = harness({ view: 'dynamic enroll' });

  const contents = adapter.contents();

  assert.deepEqual(contents.lines, contents.sequenceLines);
  for (const relation of contents.relations) {
    assert.match(contents.lines[relation.line], /^\S+ --?>>? \S+/, `line ${relation.line} is the drawn message ${relation.routeId}`);
  }
});

test('a fragment\'s branches carry the model\'s guards, although the drawing replaces quotes, braces, and arrows', () => {
  const guard = 'seats["A"] > {0} -> ok';
  const text = REFERENCE.replace('- when: eligible', `- when: '${guard}'`);
  assert.notEqual(text, REFERENCE, 'the fixture has the guard "eligible"');
  const { adapter, state } = harness({ text, view: 'dynamic enroll' });
  const alt = state.getDesign().model.scenarios.get('enroll').steps.find((step) => step.kind === 'fragment');

  const [fragment] = adapter.contents().fragments;

  assert.deepEqual(fragment.branches.map((branch) => branch.guard), alt.branches.map((branch) => branch.when));
  assert.equal(fragment.branches[0].guard, guard);
});

test('in a deployment drawing every node and hosted instance can be pressed and moved (axis xy), whichever boxes hold positions', () => {
  const topLevel = (context) => new Set(Object.keys(context.uml.ids).filter((alias) => {
    const id = context.uml.ids[alias];
    const node = context.design.model.environments.get(context.viewModel.scopeId).nodes.get(id);
    return node && !node.parentId;
  }));
  const { module } = fakeModule();
  module.holders = topLevel;
  const { adapter } = harness({ view: 'deployment production', module });

  const boxes = adapter.contents().elements.filter((element) => element.kind === 'node' || element.kind === 'instance');

  assert.ok(boxes.some((element) => element.parentId !== null), 'the drawing has nested nodes or hosted instances');
  assert.deepEqual(boxes.filter((element) => element.axis !== 'xy').map((element) => element.id), [], 'each box is a pointer target');
});

test('outside a deployment drawing only the module\'s holders can be moved', () => {
  const { module } = fakeModule();
  module.holders = () => new Set(['EnrollmentPolicy']);
  const { adapter } = harness({ module });

  const axes = Object.fromEntries(adapter.contents().elements.map((element) => [element.id, element.axis]));

  assert.equal(axes.EnrollmentPolicy, 'xy');
  assert.equal(axes.EnrollmentRule, 'none');
});

test('tools gives the module\'s palette, each unavailable tool with the table\'s short reason and sentence', () => {
  const { module } = fakeModule();
  module.tools = () => ({ elements: [{ id: 'class', label: 'Class' }], unavailable: [{ id: 'note', label: 'Note', code: 'not-in-model/note' }] });
  const { adapter } = harness({ module });

  const palette = adapter.tools();

  const expected = refusals.verdict('not-in-model/note');
  assert.deepEqual(palette.elements.map((tool) => tool.id), ['class']);
  assert.deepEqual(palette.unavailable.map((tool) => [tool.id, tool.summary, tool.message]), [['note', expected.summary, expected.message]]);
});

// ---- can and apply: mode, revision, plans ------------------------------------------------------------------------

test('can refuses read-only and yaml-errors before asking the view module', () => {
  const readOnly = harness({ module: fakeModule().module, readOnly: true });
  const { module, calls } = fakeModule();
  const broken = harness({ module });
  const built = ADD(broken.adapter);
  broken.state.setText('schema: c4-design/1\nname: [unclosed\n');

  assert.equal(readOnly.adapter.can(ADD(readOnly.adapter)).code, 'read-only');
  assert.equal(readOnly.adapter.can(ADD(readOnly.adapter)).message, refusals.verdict('read-only').message);
  assert.equal(broken.adapter.can(built).code, 'yaml-errors');
  assert.equal(calls.plan, 0, 'the view module is not asked');
});

test('an operation built against another revision is refused stale and nothing is dispatched', async () => {
  const { module, calls } = fakeModule();
  const { adapter, state, changes } = harness({ module });
  const built = ADD(adapter);
  state.setText(C4.edit(C4.load(REFERENCE), ADD_CLASS).text);
  assert.notEqual(adapter.contents().revision, built.revision, 'precondition: the outside change redraws the view');

  const verdict = await adapter.apply(built);

  assert.equal(verdict.code, 'stale');
  assert.equal(verdict.message, refusals.verdict('stale').message);
  assert.equal(adapter.can(built).code, 'stale', 'can gives the same advice');
  assert.equal(calls.plan, 0, 'the view module is not asked');
  assert.equal(changes.length, 0, 'nothing reached the host');
});

test('an edit outside the drawing, such as a YAML comment, leaves an operation current', async () => {
  const { adapter, state, changes } = harness();
  const built = ADD(adapter);
  state.setText(`${REFERENCE}# a comment typed elsewhere\n`);

  const verdict = await adapter.apply(built);

  assert.equal(verdict.ok, true, `the operation is applied (${verdict.code})`);
  assert.equal(changes.length, 1);
});

test('a commands plan is one dispatch of one batch', async () => {
  const planned = {
    kind: 'commands', label: 'Add a class', message: 'Added a class.', select: { elementId: 'NewClass' },
    commands: [ADD_CLASS, { op: 'setUmlLayout', viewKey: POLICY, positions: { NewClass: [600, 40] } }],
  };
  const { adapter, state, changes } = harness({ module: fakeModule({ planned }).module });

  assert.equal(adapter.can(ADD(adapter)).ok, true, 'can accepts it');
  const verdict = await adapter.apply(ADD(adapter));

  assert.deepEqual(verdict, { ok: true, select: { elementId: 'NewClass' }, message: 'Added a class.' });
  assert.equal(changes.length, 1, 'one change reached the host');
  assert.equal(changes[0].label, 'Add a class', 'under the plan\'s undo label');
  const model = C4.load(state.getText()).model;
  assert.deepEqual(model.layout.get(POLICY).positions.get('NewClass'), [600, 40], 'both commands were written');
  state.undo();
  assert.equal(state.getText(), REFERENCE, 'one undo restores the text');
});

test('a refused dry run gives the core\'s code and dispatches nothing', async () => {
  const planned = { kind: 'commands', commands: [ADD_CLASS, UNKNOWN_END], label: 'Add', select: null, message: null };
  const { adapter, state, changes } = harness({ module: fakeModule({ planned }).module });
  const core = C4.edit(C4.load(REFERENCE), UNKNOWN_END);

  assert.equal(adapter.can(ADD(adapter)).code, core.error);
  const verdict = await adapter.apply(ADD(adapter));

  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, core.error);
  assert.equal(changes.length, 0, 'nothing reached the host');
  assert.equal(state.getText(), REFERENCE);
});

test('a core refusal whose code is in the table carries the table\'s sentence; another core refusal keeps the core\'s message', async () => {
  const tabled = harness({ module: fakeModule({ planned: { kind: 'commands', commands: [EXTENDS_INTERFACE], values: EXTENDS_VALUES } }).module });
  const passed = harness({ module: fakeModule({ planned: { kind: 'commands', commands: [UNKNOWN_END], values: {} } }).module });
  const core = C4.edit(C4.load(REFERENCE), UNKNOWN_END);

  const fromTable = await tabled.adapter.apply(ADD(tabled.adapter));
  const fromCore = await passed.adapter.apply(ADD(passed.adapter));

  const expected = refusals.verdict('extends-kind', EXTENDS_VALUES);
  assert.deepEqual([fromTable.code, fromTable.summary, fromTable.message], [expected.code, expected.summary, expected.message]);
  assert.equal(fromCore.code, core.error);
  assert.equal(fromCore.message, passed.state.refusalText(core), 'the core\'s message, as the editor shows a core refusal');
});

test('an offer whose commands the dry run refuses is not offered', async () => {
  const refusal = (commands) => ({ kind: 'refuse', code: 'interfaces/add-element', values: { Scope: 'Registration API' },
    offer: { label: 'Add it here instead', commands } });
  const refusedOffer = harness({ module: fakeModule({ planned: refusal([UNKNOWN_END]) }).module });
  const goodOffer = harness({ module: fakeModule({ planned: refusal([ADD_CLASS]) }).module });

  const without = await refusedOffer.adapter.apply(ADD(refusedOffer.adapter));
  const withOffer = await goodOffer.adapter.apply(ADD(goodOffer.adapter));

  assert.equal(without.code, 'interfaces/add-element');
  assert.equal(without.offer, null, 'the refused offer is dropped');
  assert.equal(refusedOffer.adapter.can(ADD(refusedOffer.adapter)).offer, null, 'can drops it too');
  assert.equal(withOffer.offer.label, 'Add it here instead', 'control: an offer the core takes is kept');
});

test('an action plan\'s verdict has no message, and the action\'s result is announced once', async () => {
  const announced = [];
  const calls = [];
  const actions = {
    renameElement(elementId, name, options) {
      calls.push([elementId, name, options]);
      announced.push(`Renamed ${elementId} to ${name}.`);
      return { ok: true, message: announced[announced.length - 1], elementId: 'SeatRule' };
    },
    deleteElement() {
      announced.push('Locked: given by the task, so it cannot be deleted here.');
      return Promise.resolve({ ok: false, error: 'locked', message: announced[announced.length - 1] });
    },
  };
  const renaming = { kind: 'action', action: 'renameElement', args: ['UnitCapRule', 'Seat Rule', { wording: 'model-wide' }], label: 'Rename' };
  const deleting = { kind: 'action', action: 'deleteElement', args: ['UnitCapRule'], label: 'Delete' };
  const renamed = harness({ actions, module: fakeModule({ planned: renaming }).module });
  const deleted = harness({ actions, module: fakeModule({ planned: deleting }).module });

  const accepted = await renamed.adapter.apply(operation(renamed.adapter, 'element.rename', { ref: 'UnitCapRule', text: 'Seat Rule' }));
  const refused = await deleted.adapter.apply(operation(deleted.adapter, 'element.remove', { ref: 'UnitCapRule' }));

  assert.deepEqual(calls, [['UnitCapRule', 'Seat Rule', { wording: 'model-wide' }]], 'the shared action ran with the plan\'s arguments');
  assert.deepEqual([accepted.ok, accepted.message, accepted.select], [true, null, { elementId: 'SeatRule' }]);
  assert.deepEqual([refused.ok, refused.code, refused.message], [false, 'locked', null]);
  assert.equal(announced.length, 2, 'each result was announced once, by its action');
});

// ---- Review Focus 2: the document changes while a form or a confirmation is open ---------------------------------

/** A form or confirmation that resolves with `value` after the document was changed from outside the editor. */
function resolvingAfterOutsideChange(getState, value) {
  return () => {
    getState().setText(`${REFERENCE}# Reset by the tutorial\n`);
    return Promise.resolve(value);
  };
}

test('a document changed while a form is open: confirming the form is refused stale and nothing is dispatched', async () => {
  let state = null;
  const { module, calls } = fakeModule({ planned: { kind: 'form', form: 'link', initial: { from: 'laptop' }, label: 'Link' } });
  const built = harness({ module, forms: { link: resolvingAfterOutsideChange(() => state, { description: 'calls' }) } });
  state = built.state;

  const verdict = await built.adapter.apply(ADD(built.adapter));

  assert.equal(verdict.code, 'stale');
  assert.equal(calls.fromForm, 0, 'the form\'s values are not planned');
  assert.equal(built.changes.length, 0, 'nothing reached the host');
  assert.equal(state.getText(), `${REFERENCE}# Reset by the tutorial\n`, 'the outside change stays');
});

test('a document changed while a confirmation is open: confirming is refused stale and nothing is dispatched', async () => {
  let state = null;
  const planned = { kind: 'commands', commands: [ADD_CLASS], label: 'Add', select: null, message: null,
    confirm: { title: 'Add a class?', message: 'Add it?', details: [] } };
  const built = harness({ module: fakeModule({ planned }).module, confirm: resolvingAfterOutsideChange(() => state, true) });
  state = built.state;

  const verdict = await built.adapter.apply(ADD(built.adapter));

  assert.equal(verdict.code, 'stale');
  assert.equal(built.changes.length, 0, 'nothing reached the host');
  assert.equal(state.getText(), `${REFERENCE}# Reset by the tutorial\n`);
});

test('a confirmation with choices dispatches the chosen choice\'s commands, and Cancel changes nothing', async () => {
  const choices = [{ label: 'Add', commands: [ADD_CLASS] }, { label: 'Cancel', commands: null }];
  const planned = { kind: 'commands', commands: [], label: 'Add', select: null, message: 'Added.', confirm: { title: 'Add?', message: 'Add?', details: [], choices } };
  const chosen = harness({ module: fakeModule({ planned }).module, confirm: (request) => Promise.resolve(request.choices[0]) });
  const cancelled = harness({ module: fakeModule({ planned }).module, confirm: (request) => Promise.resolve(request.choices[1]) });

  const added = await chosen.adapter.apply(ADD(chosen.adapter));
  const kept = await cancelled.adapter.apply(ADD(cancelled.adapter));

  assert.equal(added.ok, true);
  assert.equal(C4.load(chosen.state.getText()).model.elements.has('NewClass'), true, 'the chosen commands were written');
  assert.deepEqual([kept.ok, kept.code, kept.message], [false, 'cancelled', null]);
  assert.equal(cancelled.changes.length, 0);
});

test('a chosen choice that carries its own message is announced with it; a choice without one, with the plan\'s', async () => {
  const unwrap = { label: 'Unwrap instead', commands: [ADD_CLASS], message: 'Unwrapped the alt; its steps stay.' };
  const plain = { label: 'Delete with its steps', commands: [ADD_CLASS] };
  const planned = { kind: 'commands', commands: [], label: 'Delete the alt', select: null, message: 'Removed the alt.',
    confirm: { title: 'Delete the alt?', message: 'It holds steps.', details: [], choices: [plain, unwrap, { label: 'Cancel', commands: null }] } };
  const withOwn = harness({ module: fakeModule({ planned }).module, confirm: (request) => Promise.resolve(request.choices[1]) });
  const withPlans = harness({ module: fakeModule({ planned }).module, confirm: (request) => Promise.resolve(request.choices[0]) });

  const own = await withOwn.adapter.apply(ADD(withOwn.adapter));
  const plans = await withPlans.adapter.apply(ADD(withPlans.adapter));

  assert.deepEqual([own.ok, own.message], [true, unwrap.message]);
  assert.deepEqual([plans.ok, plans.message], [true, planned.message]);
  assert.deepEqual(withOwn.changes.map((change) => change.label), [planned.label], 'the undo step keeps the plan\'s label');
});

test('two adapters given their own forms open only their own', async () => {
  const opened = { first: 0, second: 0 };
  const planned = { kind: 'form', form: 'step', initial: {}, label: 'Step' };
  const first = harness({ module: fakeModule({ planned }).module, forms: { step: () => { opened.first += 1; return Promise.resolve({}); } } });
  harness({ module: fakeModule({ planned }).module, forms: { step: () => { opened.second += 1; return Promise.resolve({}); } } });

  const verdict = await first.adapter.apply(ADD(first.adapter));

  assert.equal(verdict.ok, true, 'the form\'s plan was written');
  assert.deepEqual(opened, { first: 1, second: 0 });
});

test('a form closed without values is cancelled with no message', async () => {
  const planned = { kind: 'form', form: 'step', initial: {}, label: 'Step' };
  const { adapter, changes } = harness({ module: fakeModule({ planned }).module, forms: { step: () => Promise.resolve(null) } });

  const verdict = await adapter.apply(ADD(adapter));

  assert.deepEqual([verdict.ok, verdict.code, verdict.message], [false, 'cancelled', null]);
  assert.equal(changes.length, 0);
});

test('the choose form opens the editor\'s menu over its options and plans with the chosen one', async () => {
  let menu = null;
  const dialogs = { openMenu: (spec) => { menu = spec; return { close() {} }; } };
  const options = [{ label: 'PrerequisiteRule implements EnrollmentRule', value: 'rel:13' }, { label: 'UnitCapRule implements EnrollmentRule', value: 'rel:14' }];
  const chosenValues = [];
  const { module } = fakeModule({
    planned: { kind: 'form', form: 'choose', initial: { label: 'Lines here', options }, label: 'Choose' },
    fromForm: (form, values) => { chosenValues.push([form, values]); return { kind: 'commands', commands: [ADD_CLASS], label: 'Add', select: null, message: null }; },
  });
  const { adapter } = harness({ module, dialogs });

  const pending = adapter.apply(ADD(adapter));
  assert.equal(menu.label, 'Lines here');
  assert.deepEqual(menu.groups[0].items.map((item) => item.label), options.map((option) => option.label));
  menu.onClose();
  menu.groups[0].items[1].run({});
  const verdict = await pending;

  assert.equal(verdict.ok, true);
  assert.deepEqual(chosenValues, [['choose', options[1]]], 'the chosen option, not the close, decides');
});

// ---- Locks, raw source, targets ----------------------------------------------------------------------------------

test('a locked path refuses with the state\'s lock sentence', async () => {
  const commands = [{ op: 'setUmlLayout', viewKey: POLICY, positions: { EnrollmentPolicy: [80, 40] } }];
  const { adapter, state, changes } = harness({
    lockedFields: ['layout'], module: fakeModule({ planned: { kind: 'commands', commands, label: 'Move', select: null, message: null } }).module,
  });
  const lock = state.lockRefusal({ op: 'batch', commands });
  assert.ok(lock, 'precondition: the state refuses the layout write for its lock');

  const advice = adapter.can(ADD(adapter));
  const verdict = await adapter.apply(ADD(adapter));

  assert.deepEqual([advice.code, advice.message], ['locked', lock.message]);
  assert.deepEqual([verdict.code, verdict.message], ['locked', lock.message]);
  assert.equal(changes.length, 0);
});

test('every source.* operation is refused not-in-model/source', async () => {
  const sourceOps = Object.keys(operations.OPERATIONS).filter((op) => operations.OPERATIONS[op].family === 'source');
  const { module, calls } = fakeModule();
  const { adapter, changes } = harness({ module });
  assert.ok(sourceOps.length >= 6, 'precondition: the raw-source family');

  for (const op of sourceOps) {
    const built = operation(adapter, op, { text: 'x', lines: [], at: null, range: null, line: 0, swapWith: 1, ref: null });
    assert.equal(adapter.can(built).code, 'not-in-model/source', `can ${op}`);
    assert.equal((await adapter.apply(built)).code, 'not-in-model/source', `apply ${op}`);
  }
  assert.equal(calls.plan, 0, 'the view module is not asked');
  assert.equal(changes.length, 0);
});

test('targets asks the module once', () => {
  const answer = [{ ref: 'EnrollmentRule', ok: true, code: null }, { ref: 'UnitCapRule', ok: false, code: 'extends-kind' }];
  const { module, calls } = fakeModule({ targets: () => answer });
  const { adapter } = harness({ module });

  const advice = adapter.targets(Object.assign(operation(adapter, 'relation.add', { tool: 'generalization', from: 'PrerequisiteRule', label: null }), { open: 'to' }));

  assert.equal(calls.targets, 1);
  assert.deepEqual(advice.map((candidate) => [candidate.ref, candidate.ok, candidate.code]), answer.map((candidate) => [candidate.ref, candidate.ok, candidate.code]));
});
