'use strict';

// The dynamic view planner (UML-view editing spec §5.3, §7.3, §7.4; plan Task 44): what each gesture on a dynamic
// view, `dynamic ‹scenario›` drawn as a UML sequence diagram, changes in design.yml, and when it is refused. Each row
// runs through the C4 model adapter (plan Task 36) on a real editor state, the real C4 core, and the real shared
// actions, so the oracle is the model the editor holds afterwards, or the refusal's code with the text unchanged. The
// anchored step and fragment forms, the confirmation, and the relationship form are fakes: they are dialogs (plan
// Task 45 builds them), and a planner's part ends when it opens them with the right values and turns their answer
// into commands.

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
const dynamicView = require(path.join(EDITOR, 'c4-editor-uml-dynamic.js'));
const { revisionOf } = require(path.join(__dirname, '..', '..', 'diagram-editor', 'de-operations.js'));

// The reference model, and the fixture with the probe scenario (an async relationship, a loop in an alt, and the
// scenario whose steps the lifeline policy sends and receives twice).
const REFERENCE = fixture('course-registration.yml');
const EDITING = fixture('uml-editing.yml');
const ENROLL = 'dynamic enroll';
const PROBE = 'dynamic probe';
// A scenario made with "New scenario…": no step yet, so no lifeline (Review Focus 1).
const EMPTY_SCENARIO = REFERENCE.replace('scenarios:\n', 'scenarios:\n  drop-a-section:\n    title: Drop a section\n');

// The lines of `dynamic enroll` (both models draw it alike): the messages by step number, the alt, and its branches.
const ENROLL_LINES = { step1: 11, step2: 12, alt: 13, step3: 14, step4: 15, else: 16, step5: 17, end: 18, enduml: 19 };

// ---- The harness ----------------------------------------------------------------------------------------------

/**
 * An editor on `text` with `view` open: its state, the real shared actions, and the C4 model adapter serving the
 * dynamic view module. `answers.step` and `answers.fragment` answer the anchored forms (by default they confirm what
 * the form opened with, as a form resolves its initial values with the learner's choices written over them);
 * `answers.confirm` answers a confirmation (by default yes). Every opening is recorded.
 */
function harness({ text = REFERENCE, view = ENROLL, profile = 'expert', checks, answers = {} } = {}) {
  const changes = [];
  let clock = 0;
  const state = createEditorState({ text, view, profile, checks, now: () => (clock += 1000),
    host: { onTextChange: (changed, info) => changes.push(info) } });
  const dom = { createMenus: () => ({}), createAnnouncer: () => () => {} };
  const actions = createActions({}, { state, dom, ids: { next: (prefix) => prefix }, announce: () => {}, host: { confirm: async () => true } });
  const opened = { step: [], fragment: [], confirm: [], relationshipForm: [], rename: [] };
  const rename = actions.renameElement;
  actions.renameElement = (...args) => {
    opened.rename.push(args);
    return rename(...args);
  };
  // The relationship form's submit, as the form does it: the new relationship and the gesture's commands in one batch.
  actions.openRelationshipForm = (target, placement) => {
    opened.relationshipForm.push({ target, placement });
    const add = { op: 'addRelationship', sourceId: target.sourceId, targetId: target.targetId, description: 'pushes seat counts to' };
    const result = state.dispatch({ op: 'batch', commands: [add].concat(placement.alsoDispatch || []) }, { label: 'Add a relationship' });
    return Promise.resolve({ ok: result.ok });
  };
  const formOf = (name, confirmed) => (initial) => {
    opened[name].push(initial);
    const answer = answers[name] === undefined ? confirmed : answers[name];
    return Promise.resolve(typeof answer === 'function' ? answer(initial) : answer);
  };
  // A form resolves its initial values with the learner's choices written over them (c4-editor-uml-dynamic.js).
  const forms = { step: formOf('step', (initial) => Object.assign({}, initial)), fragment: formOf('fragment', (initial) => Object.assign({}, initial)) };
  const confirm = (request) => {
    opened.confirm.push(request);
    const answer = answers.confirm === undefined ? true : answers.confirm;
    return Promise.resolve(typeof answer === 'function' ? answer(request) : answer);
  };
  const adapter = createUmlAdapter({ state, actions, views: { 'uml-sequence': dynamicView }, refusals, layout, profile,
    confirm, dialogs: {}, forms });
  return { state, adapter, changes, opened, model: () => state.getDesign().model };
}

/** The module's context for `view` of `text`, as the adapter builds it (plan Task 34). */
function contextOf(text, view = ENROLL, profile = 'expert') {
  const design = C4.load(text);
  const viewModel = C4.project(design, view);
  const uml = C4.toUml(viewModel);
  return { design, viewModel, uml, profile, checksReleased: true, revision: revisionOf(uml.text), layout: viewModel.layout, droppedRoutes: [] };
}

/** An operation built against the adapter's current reading. */
function operation(h, op, fields = {}) {
  return Object.assign({ op, revision: h.adapter.contents().revision }, fields);
}

/** The relation reference (spec §3.4) of the message drawn on `line`. */
function messageRef(line) {
  return { routeId: `seqmsg:${line}`, line, candidates: [] };
}

/** A Message drawn from lifeline `from` to lifeline `to` before line `beforeLine` (the end of the scenario without one). */
function message(h, from, to, beforeLine) {
  const at = beforeLine === undefined ? { beforeLine: h.adapter.contents().sequenceLines.length - 1 } : { beforeLine };
  return operation(h, 'relation.add', { tool: 'message', from, to, label: null, at });
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

/** The steps of scenario `id` as `"from -> to"` texts and fragments as `{ operator, branches }`, for oracles. */
function stepsOf(h, id) {
  const shape = (steps) => steps.map((step) => (step.kind === 'fragment'
    ? { [step.operator]: step.branches.map((branch) => ({ when: branch.when, steps: shape(branch.steps) })) }
    : `${step.from} -> ${step.to}`));
  return shape(h.model().scenarios.get(id).steps);
}

const ENROLL_STEPS = ['web -> coordinator', 'coordinator -> policy', { alt: [
  { when: 'eligible', steps: ['coordinator -> seats', 'coordinator -> billing-gateway'] },
  { when: 'not eligible', steps: ['coordinator -> web'] },
] }];

// ---- Drawing a message (spec §5.3, first rows) ------------------------------------------------------------------

test('Message from web to coordinator at the end opens the step form with "submits the plan to" and confirming writes addStep', async () => {
  const h = harness();
  await assertApplied(h, message(h, 'web', 'coordinator'));
  const [initial] = h.opened.step;
  assert.equal(initial.description, 'submits the plan to', 'the description this scenario already gives that request');
  assert.deepEqual(initial.position, { containerPath: [], index: 3 });
  const added = h.model().scenarios.get('enroll').steps[3];
  assert.deepEqual([added.from, added.to, added.description], ['web', 'coordinator', 'submits the plan to']);
});

test('a reply from coordinator to web starts with an empty description', async () => {
  const h = harness({ answers: { step: null } });
  await assertRefused(h, message(h, 'coordinator', 'web'), 'cancelled');
  assert.equal(h.opened.step[0].description, '');
});

test('seats to web is step/no-relationship with no offer for a novice and the declare offer for an expert', async () => {
  const novice = harness({ profile: 'novice' });
  const refused = await assertRefused(novice, message(novice, 'seats', 'web'), 'step/no-relationship');
  assert.equal(refused.offer, null);
  const expert = harness({ profile: 'expert' });
  const offered = await assertRefused(expert, message(expert, 'seats', 'web'), 'step/no-relationship');
  assert.equal(offered.offer.label, 'Declare a relationship from Seat Gateway to Planner Web App…');
});

test('with checks withheld seats to web is step/not-available without reason or offer', async () => {
  const h = harness({ profile: 'expert', checks: { display: 'on-request' } });
  const verdict = await assertRefused(h, message(h, 'seats', 'web'), 'step/not-available');
  assert.equal(verdict.message, refusals.verdict('step/not-available', { Sender: 'Seat Gateway', Receiver: 'Planner Web App' }).message);
  assert.equal(verdict.offer, null);
});

test('a reply without a request offers "Add the request from <Receiver> to <Sender> first…", which opens the step form for the request at the same position', async () => {
  const h = harness({ answers: { step: null } });
  const verdict = await assertRefused(h, message(h, 'coordinator', 'web', ENROLL_LINES.step1), 'step/reply-without-request');
  assert.equal(verdict.offer.label, 'Add the request from Planner Web App to Registration Coordinator first…');
  await h.adapter.apply(operation(h, verdict.offer.operation.op, verdict.offer.operation));
  const [initial] = h.opened.step;
  assert.deepEqual([initial.from, initial.to, initial.position], ['web', 'coordinator', { containerPath: [], index: 0 }]);
});

test('a reply over the asynchronous relationship is step/asynchronous-no-reply', async () => {
  const h = harness({ text: EDITING, view: PROBE });
  await assertRefused(h, message(h, 'billing', 'billing_gateway'), 'step/asynchronous-no-reply');
});

test('api to coordinator is step/nested-ends and policy to policy step/same-element', async () => {
  const h = harness();
  await assertRefused(h, message(h, 'api', 'coordinator'), 'step/nested-ends');
  await assertRefused(h, message(h, 'policy', 'policy'), 'step/same-element');
});

test('accepting the expert offer opens the relationship form with the lead "This adds a relationship to the model. Seat Gateway will depend on Planner Web App in every scenario and every view, not only in this one. Is that the design you want?" and writes batch[addRelationship, addStep]', async () => {
  const h = harness({ profile: 'expert' });
  const verdict = await assertRefused(h, message(h, 'seats', 'web'), 'step/no-relationship');
  await assertApplied(h, operation(h, verdict.offer.operation.op, verdict.offer.operation));
  const [{ target, placement }] = h.opened.relationshipForm;
  assert.deepEqual(target, { sourceId: 'seats', targetId: 'web' });
  assert.equal(placement.lead, 'This adds a relationship to the model. Seat Gateway will depend on Planner Web App in every scenario and every view, not only in this one. Is that the design you want?');
  assert.ok(h.model().relationships.some((relationship) => relationship.sourceId === 'seats' && relationship.targetId === 'web'));
  assert.deepEqual(stepsOf(h, 'enroll'), ENROLL_STEPS.concat('seats -> web'));
});

// ---- Moving, editing, and deleting a message ------------------------------------------------------------------

test('a message moved into the alt\'s second branch writes moveStep with toContainerPath', async () => {
  const h = harness();
  const move = operation(h, 'message.move', { ref: messageRef(ENROLL_LINES.step2), at: { beforeLine: ENROLL_LINES.end } });
  const plan = dynamicView.plan(move, contextOf(REFERENCE));
  assert.deepEqual(plan.commands, [{ op: 'moveStep', scenarioId: 'enroll', containerPath: [], from: 1, to: 1, toContainerPath: [2, 'alt', 1] }]);
  await assertApplied(h, move);
  assert.deepEqual(stepsOf(h, 'enroll'), ['web -> coordinator', { alt: [
    { when: 'eligible', steps: ['coordinator -> seats', 'coordinator -> billing-gateway'] },
    { when: 'not eligible', steps: ['coordinator -> web', 'coordinator -> policy'] },
  ] }]);
});

test('a fragment into its own branch is fragment-into-itself', async () => {
  const h = harness();
  await assertRefused(h, operation(h, 'fragment.move', { ref: `frag:${ENROLL_LINES.alt}`, at: { beforeLine: ENROLL_LINES.step3 } }), 'fragment-into-itself');
});

test('moving an end or inverting writes updateStep', async () => {
  const rewired = harness();
  await assertApplied(rewired, operation(rewired, 'relation.rewire', { ref: messageRef(ENROLL_LINES.step2), end: 'target', to: 'seats' }));
  assert.equal(stepsOf(rewired, 'enroll')[1], 'coordinator -> seats');
  const inverted = harness();
  await assertApplied(inverted, operation(inverted, 'relation.invert', { ref: messageRef(ENROLL_LINES.step5) }));
  assert.deepEqual(stepsOf(inverted, 'enroll')[2].alt[1].steps, ['web -> coordinator']);
});

test('editing a message\'s label writes updateStep { description }', async () => {
  const h = harness();
  await assertApplied(h, operation(h, 'relation.update', { ref: messageRef(ENROLL_LINES.step1), changes: { label: 'sends the plan to' } }));
  assert.equal(h.model().scenarios.get('enroll').steps[0].description, 'sends the plan to');
});

test('deleting a message writes removeStep', async () => {
  const h = harness();
  await assertApplied(h, operation(h, 'selection.remove', { elements: [], relations: [messageRef(ENROLL_LINES.step2)], fragments: [], activations: [] }));
  assert.deepEqual(stepsOf(h, 'enroll'), [ENROLL_STEPS[0], ENROLL_STEPS[2]]);
});

test('a step form whose connector differs from the relationship\'s carries the warning and the relationship to open, and confirming writes updateStep { connector }', async () => {
  const h = harness();
  await assertApplied(h, operation(h, 'relation.update', { ref: messageRef(ENROLL_LINES.step1), changes: { connector: 'message' } }));
  const { connector } = h.opened.step[0];
  assert.equal(connector.label, 'Follows the relationship: call');
  assert.equal(connector.value, 'message');
  assert.equal(connector.warning, 'This step would be asynchronous, while the relationship it runs along is a call. A step usually follows its relationship; if every use is asynchronous, change the relationship\'s connector.');
  assert.equal(connector.relationshipId, 'web->coordinator');
  assert.equal(h.model().scenarios.get('enroll').steps[0].connector, 'message');
});

test('a return arrow is derived/arrow', async () => {
  const h = harness();
  await assertRefused(h, operation(h, 'relation.update', { ref: messageRef(ENROLL_LINES.step1), changes: { kind: 'return' } }), 'derived/arrow');
});

// ---- Fragments ------------------------------------------------------------------------------------------------

test('deleting a fragment that holds steps asks Delete with its steps, Unwrap instead, or Cancel', async () => {
  const removal = (h) => operation(h, 'selection.remove', { elements: [], relations: [], fragments: [`frag:${ENROLL_LINES.alt}`], activations: [] });
  const choose = (label) => (request) => request.choices.find((choice) => choice.label === label);
  const deleted = harness({ answers: { confirm: choose('Delete with its steps') } });
  await assertApplied(deleted, removal(deleted));
  assert.deepEqual(deleted.opened.confirm[0].choices.map((choice) => choice.label), ['Delete with its steps', 'Unwrap instead', 'Cancel']);
  assert.deepEqual(stepsOf(deleted, 'enroll'), ['web -> coordinator', 'coordinator -> policy']);
  const unwrapped = harness({ answers: { confirm: choose('Unwrap instead') } });
  await assertApplied(unwrapped, removal(unwrapped));
  assert.deepEqual(stepsOf(unwrapped, 'enroll'), ['web -> coordinator', 'coordinator -> policy', 'coordinator -> seats',
    'coordinator -> billing-gateway', 'coordinator -> web']);
  const cancelled = harness({ answers: { confirm: choose('Cancel') } });
  await assertRefused(cancelled, removal(cancelled), 'cancelled');
});

test('a fragment added at the end opens the fragment form, and confirming writes addFragment', async () => {
  const h = harness({ answers: { fragment: (initial) => Object.assign({}, initial, { guard: 'a seat is waitlisted' }) } });
  await assertApplied(h, operation(h, 'fragment.add', { operator: 'opt', at: { beforeLine: ENROLL_LINES.enduml } }));
  const [initial] = h.opened.fragment;
  assert.deepEqual([initial.operator, initial.position], ['opt', { containerPath: [], index: 3 }]);
  assert.deepEqual(stepsOf(h, 'enroll')[3], { opt: [{ when: 'a seat is waitlisted', steps: [] }] });
});

test('critical is not-in-model/fragment', async () => {
  const h = harness();
  await assertRefused(h, operation(h, 'fragment.add', { operator: 'critical', at: { beforeLine: ENROLL_LINES.enduml } }), 'not-in-model/fragment');
});

test('"Wrap in a fragment…" writes wrapSteps', async () => {
  const h = harness({ answers: { fragment: (initial) => Object.assign({}, initial, { operator: 'loop', guard: 'each section', last: initial.lastChoices[1].index }) } });
  const item = dynamicView.menu(`seqmsg:${ENROLL_LINES.step3}`, contextOf(REFERENCE)).find((candidate) => candidate.label === 'Wrap in a fragment…');
  await assertApplied(h, operation(h, item.operation.op, item.operation));
  assert.deepEqual(h.opened.fragment[0].lastChoices.map((choice) => choice.label), ['Step 3', 'Step 4']);
  assert.deepEqual(stepsOf(h, 'enroll')[2].alt[0], { when: 'eligible', steps: [{ loop: [{ when: 'each section',
    steps: ['coordinator -> seats', 'coordinator -> billing-gateway'] }] }] });
});

test('changing the one-branch loop of uml-editing.yml to opt writes setFragmentOperator', async () => {
  const h = harness({ text: EDITING, view: PROBE });
  await assertApplied(h, operation(h, 'fragment.update', { ref: 'frag:16', operator: 'opt', guard: null }));
  assert.deepEqual(stepsOf(h, 'probe')[3].alt[0].steps, [{ opt: [{ when: 'each section', steps: ['coordinator -> seats'] }] }]);
});

test('editing the alt\'s first guard writes setBranchGuard', async () => {
  const h = harness();
  await assertApplied(h, operation(h, 'fragment.update', { ref: `frag:${ENROLL_LINES.alt}`, operator: null, guard: { branch: null, text: 'eligible for every section' } }));
  assert.equal(stepsOf(h, 'enroll')[2].alt[0].when, 'eligible for every section');
});

test('adding a branch to the alt writes addBranch', async () => {
  const h = harness();
  await assertApplied(h, operation(h, 'fragment.addBranch', { ref: `frag:${ENROLL_LINES.alt}`, guard: { text: 'the plan is empty' } }));
  assert.deepEqual(stepsOf(h, 'enroll')[2].alt.map((branch) => branch.when), ['eligible', 'not eligible', 'the plan is empty']);
});

test('unwrapping the alt writes unwrapFragment', async () => {
  const h = harness();
  await assertApplied(h, operation(h, 'fragment.unwrap', { ref: `frag:${ENROLL_LINES.alt}` }));
  assert.deepEqual(stepsOf(h, 'enroll'), ['web -> coordinator', 'coordinator -> policy', 'coordinator -> seats',
    'coordinator -> billing-gateway', 'coordinator -> web']);
});

test('changing the two-branch alt to opt is single-branch; removing an only branch is last-branch; an empty guard is refused', async () => {
  const h = harness();
  await assertRefused(h, operation(h, 'fragment.update', { ref: `frag:${ENROLL_LINES.alt}`, operator: 'opt', guard: null }), 'single-branch');
  await assertRefused(h, operation(h, 'fragment.update', { ref: `frag:${ENROLL_LINES.alt}`, operator: null, guard: { branch: null, text: '  ' } }), 'empty-guard');
  const probe = harness({ text: EDITING, view: PROBE });
  await assertRefused(probe, operation(probe, 'fragment.removeBranch', { ref: 'frag:16', branch: 0 }), 'last-branch');
});

test('fragment.removeBranch of branch 2 writes removeBranch', async () => {
  const h = harness();
  await assertApplied(h, operation(h, 'fragment.removeBranch', { ref: `frag:${ENROLL_LINES.alt}`, branch: 1 }));
  assert.deepEqual(stepsOf(h, 'enroll')[2].alt.map((branch) => branch.when), ['eligible']);
});

// ---- Lifelines ------------------------------------------------------------------------------------------------

test('renaming a lifeline runs the shared rename with model-wide wording', async () => {
  const h = harness();
  await assertApplied(h, operation(h, 'element.rename', { ref: 'seats', text: 'Seat Store' }));
  assert.deepEqual(h.opened.rename, [['seats', 'Seat Store', { wording: 'model-wide' }]]);
  assert.equal(h.model().elements.get('seats').name, 'Seat Store');
});

test('reordering policy before coordinator writes lifelines', async () => {
  const h = harness();
  await assertApplied(h, operation(h, 'lifeline.reorder', { order: ['web', 'policy', 'coordinator', 'seats', 'billing_gateway'] }));
  assert.deepEqual(h.model().layout.get(ENROLL).lifelines, ['web', 'policy', 'coordinator', 'seats', 'billing-gateway']);
});

test('dropping policy left of web moves the whole Registration API box: [coordinator, policy, seats, billing-gateway, web]', async () => {
  const h = harness();
  await assertApplied(h, operation(h, 'lifeline.reorder', { order: ['policy', 'web', 'coordinator', 'seats', 'billing_gateway'] }));
  assert.deepEqual(h.model().layout.get(ENROLL).lifelines, ['coordinator', 'policy', 'seats', 'billing-gateway', 'web']);
});

test("the lifeline menu's Move left on policy names Enrollment Policy in its undo label and announcement", async () => {
  const h = harness();
  const item = dynamicView.menu('policy', contextOf(REFERENCE)).find((candidate) => candidate.label === 'Move left');
  const plan = dynamicView.plan(Object.assign({ revision: h.adapter.contents().revision }, item.operation), contextOf(REFERENCE));
  assert.equal(plan.label, 'Move Enrollment Policy');
  assert.equal(plan.message, 'Moved Enrollment Policy before Registration Coordinator.');
  await assertApplied(h, operation(h, item.operation.op, item.operation));
  assert.deepEqual(h.model().layout.get(ENROLL).lifelines, ['web', 'policy', 'coordinator', 'seats', 'billing-gateway']);
});

test('a reorder that names the lifeline it moves announces that lifeline, not its swapped neighbour', () => {
  const order = ['web', 'policy', 'coordinator', 'seats', 'billing_gateway'];
  const byPolicy = dynamicView.plan({ op: 'lifeline.reorder', order, moved: 'policy' }, contextOf(REFERENCE));
  const byCoordinator = dynamicView.plan({ op: 'lifeline.reorder', order, moved: 'coordinator' }, contextOf(REFERENCE));
  assert.equal(byPolicy.message, 'Moved Enrollment Policy before Registration Coordinator.');
  assert.equal(byCoordinator.message, 'Moved Registration Coordinator before Seat Gateway.');
  assert.deepEqual(byPolicy.commands, byCoordinator.commands, 'the same order is written either way');
});

test('a drag of policy out of the Registration API box announces the whole box', () => {
  const plan = dynamicView.plan({ op: 'lifeline.reorder', order: ['policy', 'web', 'coordinator', 'seats', 'billing_gateway'], moved: 'policy' },
    contextOf(REFERENCE));
  assert.match(plan.message, /^Moved the .+ box with its lifelines (before .+|to the end)\.$/);
});

// ---- A drag of a message or a lifeline head (spec §3.4 scene facts, §7.4) ---------------------------------------

test('a message drawn by a drag gives its place as the scene fact at, and the step form opens at that place', async () => {
  const h = harness({ answers: { step: null } });
  await h.adapter.apply(operation(h, 'relation.add', { tool: 'message', from: 'web', to: 'coordinator', label: null,
    facts: { at: { beforeLine: ENROLL_LINES.alt } } }));
  assert.deepEqual(h.opened.step[0].position, { containerPath: [], index: 2 }, 'before the alt, where the drag ended');
});

/** The drawn heads of `dynamic enroll` as a drag's scene facts give them: one x per lifeline, 200 apart, in drawn order. */
const DRAWN_HEADS = { web: { x: 0, y: 0 }, coordinator: { x: 200, y: 0 }, policy: { x: 400, y: 0 },
  seats: { x: 600, y: 0 }, billing_gateway: { x: 800, y: 0 } };

test('a lifeline head may start a sideways drag: the move asked from where the head is drawn is accepted', () => {
  const h = harness();
  const verdict = h.adapter.can(operation(h, 'layout.set', { positions: { policy: DRAWN_HEADS.policy }, routes: [], facts: {} }));
  assert.equal(verdict.ok, true, `${verdict.code}: ${verdict.message}`);
});

test('a lifeline head dropped between two others is the new lifeline order, announced with the head it moved', async () => {
  const h = harness();
  const drop = operation(h, 'layout.set', { positions: { policy: { x: 100, y: 40 } }, routes: [], facts: { positions: DRAWN_HEADS } });
  const verdict = await assertApplied(h, drop);
  assert.deepEqual(h.model().layout.get(ENROLL).lifelines, ['web', 'policy', 'coordinator', 'seats', 'billing-gateway']);
  assert.equal(verdict.message, 'Moved Enrollment Policy before Registration Coordinator.');
});

test('a head dropped where it keeps its place in the order writes nothing; a free position or a route is layout/sequence-order', async () => {
  const h = harness();
  const kept = await h.adapter.apply(operation(h, 'layout.set', { positions: { policy: { x: 430, y: 60 } }, routes: [],
    facts: { positions: DRAWN_HEADS } }));
  assert.equal(kept.ok, false);
  assert.equal(kept.code, 'cancelled', 'nothing to do, nothing said');
  assert.equal(h.changes.length, 0);
  await assertRefused(h, operation(h, 'layout.set', { positions: { api: { x: 10, y: 10 } }, routes: [], facts: {} }), 'layout/sequence-order');
  await assertRefused(h, operation(h, 'layout.set', { positions: {}, routes: [{ id: `seqmsg:${ENROLL_LINES.step1}`, points: [] }], facts: {} }),
    'layout/sequence-order');
});

test('deleting the lifeline policy removes every step it sends or receives, last to first, and keeps the element', async () => {
  const h = harness({ text: EDITING, view: PROBE });
  const removal = operation(h, 'element.remove', { ref: 'policy' });
  const plan = dynamicView.plan(removal, contextOf(EDITING, PROBE));
  assert.deepEqual(plan.commands.map((command) => [command.containerPath, command.index]), [[[], 6], [[], 2]], 'last to first');
  await assertApplied(h, removal);
  assert.equal(h.opened.confirm[0].details.length, 2, 'the confirmation lists both steps');
  assert.ok(!stepsOf(h, 'probe').some((step) => typeof step === 'string' && /\bpolicy\b/.test(step)));
  assert.ok(h.model().elements.has('policy'), 'the element stays in the model');
});

test('a lifeline alone is not-in-model/lifeline; activation and the others are not-in-model/sequence-detail; editing a box is derived/box', async () => {
  const h = harness();
  await assertRefused(h, operation(h, 'lifeline.add', { tool: 'participant', name: 'Registrar' }), 'not-in-model/lifeline');
  await assertRefused(h, operation(h, 'activation.add', { lifeline: 'coordinator', slots: { start: 0, end: 1 } }), 'not-in-model/sequence-detail');
  for (const tool of ['lost', 'found', 'create', 'destroy']) {
    await assertRefused(h, operation(h, 'relation.add', { tool, from: 'web', to: 'coordinator', label: null, at: null }), 'not-in-model/sequence-detail');
  }
  await assertRefused(h, operation(h, 'element.rename', { ref: 'api', text: 'Registration Service' }), 'derived/box');
});

// ---- Places, options, and selection (spec §7.3, §7.4) -------------------------------------------------------

test('places of step 1 enter and leave the alt\'s branches in reading order', () => {
  const places = dynamicView.places(`seqmsg:${ENROLL_LINES.step1}`, contextOf(REFERENCE));
  assert.deepEqual(places.map((place) => place.label), [
    'Where it is now',
    'Before the alt',
    'Before step 3, in alt, branch 1: eligible',
    'Before step 4, in alt, branch 1: eligible',
    'In alt, branch 1: eligible, at the end',
    'Before step 5, in alt, branch 2: not eligible',
    'In alt, branch 2: not eligible, at the end',
    'At the end of the scenario',
  ]);
  assert.deepEqual(places.map((place) => Boolean(place.current)), [true, false, false, false, false, false, false, false]);
});

test('the listbox offers Lifelines, then Steps in reading order, each saying what the drawing shows', () => {
  const sets = dynamicView.optionSets(contextOf(REFERENCE));
  assert.deepEqual(sets.map((set) => set.label), ['Lifelines', 'Steps']);
  assert.equal(sets[0].options[1].description, 'lifeline 2 of 5; in Registration API');
  assert.deepEqual(sets[1].options.map((option) => option.ref), ['seqmsg:11', 'seqmsg:12', 'frag:13', 'seqmsg:14', 'seqmsg:15', 'seqmsg:17']);
  assert.match(sets[1].options[5].description, /^reply/);
  assert.match(sets[1].options[5].description, /in alt, branch 2: not eligible/);
});

test('a step option selects the step kind, and the step selection finds its option again', () => {
  const context = contextOf(REFERENCE);
  const selection = dynamicView.selectionOf(`seqmsg:${ENROLL_LINES.step5}`, context);
  assert.deepEqual(selection, { scenarioId: 'enroll', step: { containerPath: [2, 'alt', 1], index: 0 } });
  assert.equal(dynamicView.refOf(selection, context), `seqmsg:${ENROLL_LINES.step5}`);
  assert.deepEqual(dynamicView.selectionOf('coordinator', context), { elementId: 'coordinator' });
});

test('the palette has Message and Fragment with its five operators, and lists the other sequence tools as unavailable', () => {
  const tools = dynamicView.tools(contextOf(REFERENCE));
  assert.deepEqual(tools.elements.map((tool) => tool.label), ['Message', 'Fragment']);
  assert.deepEqual(tools.elements[1].operators, ['alt', 'opt', 'loop', 'par', 'break']);
  assert.deepEqual(tools.unavailable.map((tool) => tool.id),
    ['critical', 'ref', 'neg', 'activation', 'create', 'destroy', 'lost', 'found', 'note']);
});

test('Review Focus 1: in an empty scenario Message opens the step form with every allowed sender and receiver at the end of the scenario', async () => {
  const h = harness({ text: EMPTY_SCENARIO, view: 'dynamic drop-a-section', answers: { step: null } });
  await h.adapter.apply(operation(h, 'element.add', { tool: 'message', name: null, into: null, anchor: null, placed: 'automatic' }));
  const [initial] = h.opened.step;
  const ends = C4.stepEnds(h.state.getDesign(), { scenarioId: 'drop-a-section', containerPath: [], index: 0 });
  assert.ok(ends.froms.length > 0, 'the model allows a first step');
  assert.deepEqual(initial.senders.map((sender) => sender.id), ends.froms);
  ends.froms.forEach((from) => assert.deepEqual(initial.receivers[from].map((receiver) => receiver.id), ends.tosOf(from)));
  assert.deepEqual(initial.position, { containerPath: [], index: 0 });
  assert.deepEqual(initial.places.map((place) => place.label), ['At the end of the scenario']);
});
