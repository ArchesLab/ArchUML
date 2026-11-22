'use strict';

// The code view planner (UML-view editing spec §5.2, §7.3; plan Task 37): what each gesture on a code view,
// `code of ‹component›` drawn as a UML class diagram, changes in design.yml, and when it is refused. Each row runs
// through the C4 model adapter (plan Task 36) on a real editor state, the real C4 core, and the real shared actions,
// so the oracle is the model the editor holds afterwards, or the refusal's code with the text unchanged. Only the
// relationship form is a fake: it is a dialog, and a planner's part ends when it opens it with the right ends.

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
const { placeholderName } = require(path.join(EDITOR, 'c4-editor-actions-shared.js'));
const codeView = require(path.join(EDITOR, 'c4-editor-uml-code.js'));
const { revisionOf } = require(path.join(__dirname, '..', '..', 'diagram-editor', 'de-operations.js'));

const DESIGN = fixture('uml-editing.yml');
const POLICY = 'code of policy';
const SEATS = 'code of seats';
const POLICY_CODE = 'systems.registration.containers.api.components.policy.code';
const DEPENDENCY_ID = 'EnrollmentPolicy->EnrollmentRule';
const PROFILES = ['novice', 'expert'];

// ---- Variants of the fixture ----------------------------------------------------------------------------------

/** The fixture with `yaml` (code elements, indented as EnrollmentPolicy is) added to the code of Enrollment Policy. */
function withPolicyCode(yaml) {
  const marker = '          seats:\n            name: Seat Gateway\n';
  assert.ok(DESIGN.includes(marker), 'the fixture still has the Seat Gateway component after Enrollment Policy');
  return DESIGN.replace(marker, `${yaml}${marker}`);
}

// A class still named as the palette added it, and a function that declares no operation (drawn with its own call).
const WITH_NEW_CLASS = withPolicyCode('              NewClass: {name: New class, kind: class}\n');
const WITH_FUNCTION = withPolicyCode('              checkCap: {name: checkCap, kind: function}\n');
// An operation whose drawn text differs from its model text: the drawing replaces quotes, braces, and arrows.
const QUOTED = '+ evaluate(mode: "strict"): {passed} -> RuleResult';
const WITH_QUOTED = DESIGN.replace('                operations: ["+ decide(student, section): Decision"]',
  `                operations: ["+ decide(student, section): Decision", ${JSON.stringify(QUOTED)}]`);
// Every class of code of policy with a position: a view that holds positions.
const PINNED = `${DESIGN}layout:\n  ${POLICY}:\n    positions:\n${['EnrollmentPolicy', 'EnrollmentRule', 'PrerequisiteRule',
  'UnitCapRule', 'SeatHolds', 'SeatHoldRows'].map((id, index) => `      ${id}: [${40 + 200 * index}, 40]\n`).join('')}`;
// Seat Ledger also works with a second component of the Planner Web App: two dependencies drawn from Seat Ledger to
// the one Planner Web App box.
const PARALLEL = DESIGN.replace('                  seat-board: {description: pushes seat counts to, technology: WebSocket}\n',
  '                  seat-board: {description: pushes seat counts to, technology: WebSocket}\n'
  + '                  planner-view: {description: pushes plan changes to, technology: WebSocket}\n')
  .replace('          seat-board:\n            name: Live Seat Board\n',
    '          planner-view:\n            name: Plan View\n            technology: React component\n            description: Shows a plan.\n'
    + '          seat-board:\n            name: Live Seat Board\n');

// ---- The harness ----------------------------------------------------------------------------------------------

/**
 * An editor on `text` with `view` open: its state, the real shared actions (confirmations answer yes), and the C4
 * model adapter serving the code view module. `forms` records each opening of the relationship form.
 */
function harness({ text = DESIGN, view = POLICY, profile = 'expert', lockedFields } = {}) {
  const changes = [];
  let clock = 0;
  const state = createEditorState({ text, view, profile, lockedFields, now: () => (clock += 1000),
    host: { onTextChange: (changed, info) => changes.push(info) } });
  const dom = { createMenus: () => ({}), createAnnouncer: () => () => {} };
  const actions = createActions({}, { state, dom, ids: { next: (prefix) => prefix }, announce: () => {}, host: { confirm: async () => true } });
  const forms = [];
  actions.openRelationshipForm = (target, placement) => {
    forms.push({ target, placement });
    return Promise.resolve({ ok: false, cancelled: true });
  };
  const adapter = createUmlAdapter({ state, actions, views: { 'uml-class': codeView }, refusals, layout, profile,
    confirm: () => Promise.resolve(true), dialogs: {}, forms: {} });
  return { state, adapter, changes, forms, model: () => state.getDesign().model };
}

/** The module's context for `view` of `text`, as the adapter builds it (plan Task 34). */
function contextOf(text, view = POLICY, profile = 'expert') {
  const design = C4.load(text);
  const viewModel = C4.project(design, view);
  const uml = C4.toUml(viewModel);
  return { design, viewModel, uml, profile, checksReleased: true, revision: revisionOf(uml.text), layout: viewModel.layout, droppedRoutes: [] };
}

/** An operation built against the adapter's current reading. */
function operation(h, op, fields = {}) {
  return Object.assign({ op, revision: h.adapter.contents().revision }, fields);
}

/** The relation reference (spec §3.4) of the drawn line from the box `from` to the box `to` (aliases, as drawn). */
function lineRef(h, from, to) {
  const relation = h.adapter.contents().relations.find((candidate) => candidate.from === from && candidate.to === to);
  assert.ok(relation, `the drawing has a line from ${from} to ${to}`);
  return { routeId: relation.routeId, line: relation.line, candidates: [] };
}

/** The route id the drawing gives the line from `from` to `to`, as a move's route names it. */
function routeIdOf(h, from, to) {
  return `rel:${lineRef(h, from, to).line}`;
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

const element = (h, id) => h.model().elements.get(id);
const relationship = (h, id) => h.model().relationships.find((candidate) => candidate.id === id) || null;
const positionsOf = (h, view) => {
  const entry = h.model().layout.get(view);
  return entry ? Object.fromEntries(entry.positions) : {};
};

// ---- Rows that change the model (spec §5.2) -------------------------------------------------------------------

// Each row: a gesture on code of policy (or a variant), what it must change, and whether a lock on the component's
// `code` path refuses it. The form row is checked separately, since a fake stands for the form.
const ROWS = [
  {
    name: 'Add Class writes addElement { parentId: policy, type: code, kind: class, name: "New class" }',
    op: (h) => operation(h, 'element.add', { tool: 'class', name: null, into: null, anchor: null, placed: 'automatic', facts: { at: null, positions: {} } }),
    check: (h) => {
      const added = element(h, 'NewClass');
      assert.deepEqual([added.parentId, added.type, added.kind, added.name], ['policy', 'code', 'class', placeholderName('code', 'class')]);
      assert.deepEqual(positionsOf(h, POLICY), {}, 'a view without positions gets none');
    },
  },
  {
    name: 'rename runs actions.renameElement',
    op: (h) => operation(h, 'element.rename', { ref: 'UnitCapRule', text: 'Unit Cap Rule' }),
    check: (h) => assert.equal(element(h, 'UnitCapRule').name, 'Unit Cap Rule', 'the name changes and the id stays'),
  },
  {
    name: 'editing a member writes setList with the line in its place',
    op: (h) => operation(h, 'member.update', { owner: 'EnrollmentPolicy', list: 'operations', index: 0, text: '+ decide(plan): Decision' }),
    check: (h) => assert.deepEqual(element(h, 'EnrollmentPolicy').code.operations, ['+ decide(plan): Decision']),
  },
  {
    name: 'adding an attribute writes setList with the new line',
    op: (h) => operation(h, 'member.add', { owner: 'UnitCapRule', list: 'attributes', index: 0, text: '- cap: int' }),
    check: (h) => assert.deepEqual(element(h, 'UnitCapRule').code.attributes, ['- cap: int']),
  },
  {
    name: 'deleting a member writes setList without it',
    op: (h) => operation(h, 'member.remove', { owner: 'Seat_Holds_2', list: 'attributes', index: 0, text: null }),
    check: (h) => assert.deepEqual(element(h, 'SeatHoldRows').code.attributes, []),
  },
  {
    name: 'a realization from UnitCapRule to EnrollmentRule that already exists is not drawn twice',
    refused: 'already-present',
    op: (h) => operation(h, 'relation.add', { tool: 'real', from: 'UnitCapRule', to: 'EnrollmentRule', label: null }),
  },
  {
    name: 'a generalization from SeatHolds to UnitCapRule writes extends',
    op: (h) => operation(h, 'relation.add', { tool: 'gen', from: 'Seat_Holds', to: 'UnitCapRule', label: null }),
    check: (h) => assert.deepEqual(element(h, 'SeatHolds').code.extends, ['UnitCapRule']),
  },
  {
    name: 'editing the dependency label writes updateRelationship { relationshipId: "EnrollmentPolicy->EnrollmentRule" }',
    op: (h) => operation(h, 'relation.update', { ref: lineRef(h, 'EnrollmentPolicy', 'EnrollmentRule'), changes: { label: 'asks every rule with' } }),
    check: (h) => assert.equal(relationship(h, DEPENDENCY_ID).description, 'asks every rule with'),
  },
  {
    name: 'moving the dependency\'s target to UnitCapRule calls actions.moveRelationship and keeps the declared source',
    op: (h) => operation(h, 'relation.rewire', { ref: lineRef(h, 'EnrollmentPolicy', 'EnrollmentRule'), end: 'target', to: 'UnitCapRule' }),
    check: (h) => {
      assert.equal(relationship(h, DEPENDENCY_ID), null, 'the relationship no longer ends at EnrollmentRule');
      const moved = h.model().relationships.find((candidate) => candidate.sourceId === 'EnrollmentPolicy' && candidate.targetId === 'UnitCapRule');
      assert.ok(moved, 'it runs from EnrollmentPolicy to UnitCapRule');
      assert.equal(moved.description, 'asks each rule to evaluate the student with', 'it keeps its description');
    },
  },
  {
    name: 'moving the target of PrerequisiteRule implements EnrollmentRule to a new interface writes one setList',
    text: withPolicyCode('              PlanRule: {kind: interface}\n'),
    op: (h) => operation(h, 'relation.rewire', { ref: lineRef(h, 'PrerequisiteRule', 'EnrollmentRule'), end: 'target', to: 'PlanRule' }),
    check: (h) => assert.deepEqual(element(h, 'PrerequisiteRule').code.implements, ['PlanRule']),
  },
  {
    name: 'moving the source of PrerequisiteRule implements EnrollmentRule to SeatHolds moves the entry in one batch',
    op: (h) => operation(h, 'relation.rewire', { ref: lineRef(h, 'PrerequisiteRule', 'EnrollmentRule'), end: 'source', to: 'Seat_Holds' }),
    check: (h) => {
      assert.deepEqual(element(h, 'PrerequisiteRule').code.implements, []);
      assert.deepEqual(element(h, 'SeatHolds').code.implements, ['EnrollmentRule']);
    },
  },
  {
    name: 'inverting the dependency turns the declared relationship around with the shared move action',
    op: (h) => operation(h, 'relation.invert', { ref: lineRef(h, 'EnrollmentPolicy', 'EnrollmentRule') }),
    check: (h) => assert.ok(h.model().relationships.some((candidate) => candidate.sourceId === 'EnrollmentRule' && candidate.targetId === 'EnrollmentPolicy')),
  },
  {
    name: 'deleting a realization removes the implements entry by its declared target id',
    text: withPolicyCode('              PlanRule: {kind: interface}\n').replace('                implements: [EnrollmentRule]\n                operations: ["+ evaluate(student, section): RuleResult"]\n                choices: {patterns: [{pattern: Strategy, role: ConcreteStrategy, instance: eligibility-rules}]}\n              UnitCapRule:',
      '                implements: [PlanRule, EnrollmentRule]\n                operations: ["+ evaluate(student, section): RuleResult"]\n                choices: {patterns: [{pattern: Strategy, role: ConcreteStrategy, instance: eligibility-rules}]}\n              UnitCapRule:'),
    op: (h) => operation(h, 'selection.remove', { elements: [], relations: [lineRef(h, 'PrerequisiteRule', 'EnrollmentRule')], fragments: [], activations: [] }),
    check: (h) => {
      assert.deepEqual(element(h, 'PrerequisiteRule').code.implements, ['PlanRule'], 'its other realization stays');
      assert.deepEqual(element(h, 'UnitCapRule').code.implements, ['EnrollmentRule'], 'the other class keeps its realization');
    },
  },
  {
    name: 'deleting the dependency runs the shared delete action',
    op: (h) => operation(h, 'selection.remove', { elements: [], relations: [lineRef(h, 'EnrollmentPolicy', 'EnrollmentRule')], fragments: [], activations: [] }),
    check: (h) => assert.equal(relationship(h, DEPENDENCY_ID), null),
  },
  {
    name: 'deleting a code element runs the shared delete action',
    op: (h) => operation(h, 'element.remove', { ref: 'Seat_Holds' }),
    check: (h) => {
      assert.equal(element(h, 'SeatHolds'), undefined);
      assert.ok(element(h, 'SeatHoldRows'), 'the class with the colliding alias stays');
    },
  },
];
const CHANGING_ROWS = ROWS.filter((row) => !row.refused);

for (const row of ROWS) {
  test(row.name, async () => {
    const h = harness({ text: row.text });

    if (row.refused) {
      await assertRefused(h, row.op(h), row.refused);
      return;
    }
    await assertApplied(h, row.op(h));
    row.check(h);
  });
}

test('the novice profile plans every row as the expert profile does', async () => {
  for (const row of CHANGING_ROWS) {
    const h = harness({ text: row.text, profile: 'novice' });

    await assertApplied(h, row.op(h));
    row.check(h);
  }
});

test('a lock on the component\'s code path refuses every row with locked, in both profiles', async () => {
  for (const profile of PROFILES) {
    for (const row of CHANGING_ROWS) {
      const h = harness({ text: row.text, profile, lockedFields: [POLICY_CODE] });

      await assertRefused(h, row.op(h), 'locked');
    }
  }
});

// ---- Additions and positions -----------------------------------------------------------------------------------

test('Add Class in a view that holds positions writes the class and its position in the same batch', async () => {
  const h = harness({ text: PINNED });

  const verdict = await assertApplied(h, operation(h, 'element.add',
    { tool: 'class', name: null, into: null, anchor: null, placed: 'dropped', facts: { at: { x: 1300.4, y: 220.6 }, positions: {} } }));

  assert.equal(element(h, 'NewClass').name, 'New class');
  assert.deepEqual(positionsOf(h, POLICY).NewClass, [1300, 221], 'the new class is pinned at the drop point');
  assert.deepEqual(verdict.select, { elementId: 'NewClass' }, 'the new class is selected, so its name is ready for editing');
});

test('a class added by a key in a view that holds positions goes to the free place right of the drawn boxes', async () => {
  const h = harness({ text: PINNED });

  await assertApplied(h, operation(h, 'element.add', { tool: 'class', name: null, into: null, anchor: null, placed: 'automatic', facts: { at: null, positions: {} } }));

  const free = layout.freePlace(contextOf(PINNED));
  assert.deepEqual(positionsOf(h, POLICY).NewClass, [free.x, free.y]);
});

test('a class dropped in a view without positions pins every drawn box and the new class (the first move)', async () => {
  const h = harness();
  const drawn = Object.fromEntries(Object.keys(contextOf(DESIGN).uml.ids).map((alias, index) => [alias, { x: 20 + 200 * index, y: 20 }]));

  await assertApplied(h, operation(h, 'element.add',
    { tool: 'interface', name: null, into: null, anchor: null, placed: 'dropped', facts: { at: { x: 500, y: 400 }, positions: drawn } }));

  const positions = positionsOf(h, POLICY);
  assert.deepEqual(positions.NewInterface, [500, 400], 'the new interface sits at the drop point');
  assert.deepEqual(positions.SeatHoldRows, [20 + 200 * 5, 20], 'the box drawn as Seat_Holds_2 is pinned under its model id');
  assert.equal(Object.keys(positions).length, 7);
});

test('each element tool adds its kind under its placeholder name', async () => {
  for (const [tool, kind] of [['abstract', 'abstract_class'], ['interface', 'interface'], ['enum', 'enum'], ['function', 'function'], ['module', 'module']]) {
    const h = harness();

    const verdict = await assertApplied(h, operation(h, 'element.add', { tool, name: null, into: null, anchor: null, placed: 'automatic', facts: {} }));

    const added = element(h, verdict.select.elementId);
    assert.deepEqual([added.parentId, added.kind, added.name], ['policy', kind, placeholderName('code', kind)], tool);
  }
});

// ---- Renames -------------------------------------------------------------------------------------------------

test('renaming the option of the class named "Seat_Holds" renames that element, not "Seat Holds"', async () => {
  const h = harness();
  const option = codeView.optionSets(contextOf(DESIGN)).flatMap((set) => set.options).find((candidate) => candidate.name === 'Seat_Holds');

  await assertApplied(h, operation(h, 'element.rename', { ref: option.ref, text: 'Seat Hold Rows' }));

  assert.equal(element(h, 'SeatHoldRows').name, 'Seat Hold Rows');
  assert.equal(element(h, 'SeatHolds').name, 'Seat Holds', 'the class whose alias collides keeps its name');
});

test('renaming a lifted box is outside-view with the offer to open its view', async () => {
  const h = harness({ view: SEATS });

  const verdict = await assertRefused(h, operation(h, 'element.rename', { ref: 'Planner_Web_App', text: 'Planner' }), 'outside-view');

  assert.equal(verdict.offer.kind, 'open-view');
  assert.equal(verdict.offer.view, 'containers of registration', 'the container view draws the Planner Web App among its siblings');
  const values = { Name: 'Planner Web App', type: 'container', Scope: 'Seat Gateway', 'view title': 'Container view: Course Registration' };
  assert.equal(verdict.message, refusals.verdict('outside-view', values).message);
  assert.equal(verdict.offer.label, refusals.verdict('outside-view', values).offer.label);
});

test('deleting a lifted box and editing one of its members are outside-view', async () => {
  const h = harness({ view: SEATS });

  await assertRefused(h, operation(h, 'element.remove', { ref: 'Billing_System' }), 'outside-view');
  await assertRefused(h, operation(h, 'member.add', { owner: 'Billing_System', list: 'operations', index: 0, text: '+ charge()' }), 'outside-view');
});

// ---- Members ------------------------------------------------------------------------------------------------

test('editing a member starts from the model\'s text and writes setList', async () => {
  const h = harness({ text: WITH_QUOTED });
  const owner = h.adapter.contents().elements.find((candidate) => candidate.id === 'EnrollmentPolicy');
  const member = owner.members.find((candidate) => candidate.index === 1);
  assert.equal(member.text, QUOTED, 'the in-place editor starts from the model\'s text, not the drawn look-alikes');

  await assertApplied(h, operation(h, 'member.update', { owner: owner.id, list: member.list, index: member.index, text: `${member.text} !` }));

  assert.deepEqual(element(h, 'EnrollmentPolicy').code.operations, ['+ decide(student, section): Decision', `${QUOTED} !`]);
});

test('deleting the one drawn operation of a function is derived/function-operation', async () => {
  const h = harness({ text: WITH_FUNCTION });

  await assertRefused(h, operation(h, 'member.remove', { owner: 'checkCap', list: 'operations', index: 0, text: null }), 'derived/function-operation');
});

test('editing the one drawn operation of a function writes the function\'s first operation', async () => {
  const h = harness({ text: WITH_FUNCTION });

  await assertApplied(h, operation(h, 'member.update', { owner: 'checkCap', list: 'operations', index: 0, text: 'checkCap(plan): bool' }));

  assert.deepEqual(element(h, 'checkCap').code.operations, ['checkCap(plan): bool']);
});

// ---- Lines --------------------------------------------------------------------------------------------------

test('a generalization from PrerequisiteRule to EnrollmentRule is extends-kind', async () => {
  const h = harness();

  const verdict = await assertRefused(h, operation(h, 'relation.add', { tool: 'gen', from: 'PrerequisiteRule', to: 'EnrollmentRule', label: null }), 'extends-kind');

  assert.equal(verdict.message, refusals.verdict('extends-kind', { Source: 'PrerequisiteRule', Target: 'EnrollmentRule', relation: 'extends',
    sourceKind: 'class', targetKind: 'interface' }).message);
});

test('a realization from a new class to EnrollmentRule writes implements', async () => {
  const h = harness({ text: WITH_NEW_CLASS });
  const alias = Object.keys(contextOf(WITH_NEW_CLASS).uml.ids).find((candidate) => contextOf(WITH_NEW_CLASS).uml.ids[candidate] === 'NewClass');

  await assertApplied(h, operation(h, 'relation.add', { tool: 'real', from: alias, to: 'EnrollmentRule', label: null }));

  assert.deepEqual(element(h, 'NewClass').code.implements, ['EnrollmentRule']);
});

test('a realization to PrerequisiteRule is implements-target', async () => {
  const h = harness();

  await assertRefused(h, operation(h, 'relation.add', { tool: 'real', from: 'UnitCapRule', to: 'PrerequisiteRule', label: null }), 'implements-target');
});

test('a generalization that would close a cycle is extends-cycle', async () => {
  const h = harness({ text: withPolicyCode('              BaseRule: {kind: class, extends: [UnitCapRule]}\n') });

  await assertRefused(h, operation(h, 'relation.add', { tool: 'gen', from: 'UnitCapRule', to: 'BaseRule', label: null }), 'extends-cycle');
});

test('a generalization to a lifted container is extends-target', async () => {
  const h = harness({ view: SEATS });

  await assertRefused(h, operation(h, 'relation.add', { tool: 'gen', from: 'SeatLedger', to: 'Planner_Web_App', label: null }), 'extends-target');
});

test('a dependency opens the relationship form from EnrollmentPolicy to UnitCapRule', async () => {
  const h = harness();

  const verdict = await h.adapter.apply(operation(h, 'relation.add', { tool: 'depend', from: 'EnrollmentPolicy', to: 'UnitCapRule', label: null }));

  assert.deepEqual(h.forms.map((form) => form.target), [{ sourceId: 'EnrollmentPolicy', targetId: 'UnitCapRule' }]);
  assert.equal(verdict.code, 'cancelled', 'closing the form changes nothing');
  assert.equal(h.state.getText(), DESIGN);
});

test('a dependency to a lifted box opens the form for a relationship to the element the box stands for', async () => {
  const h = harness({ view: SEATS });

  await h.adapter.apply(operation(h, 'relation.add', { tool: 'depend', from: 'Billing_System', to: 'SeatLedger', label: null }));

  assert.deepEqual(h.forms.map((form) => form.target), [{ sourceId: 'billing', targetId: 'SeatLedger' }]);
});

test('a dependency between two lifted boxes is outside-view/both-ends', async () => {
  const h = harness({ view: SEATS });

  const verdict = await assertRefused(h, operation(h, 'relation.add', { tool: 'depend', from: 'Planner_Web_App', to: 'Billing_System', label: null }),
    'outside-view/both-ends');

  assert.equal(verdict.offer.view, 'containers of registration');
  assert.deepEqual(h.forms, [], 'no form opens');
});

test('composition, aggregation, and association are not-in-model/association', async () => {
  for (const tool of ['compose', 'aggregate', 'assoc', 'biassoc', 'plain']) {
    const h = harness();

    await assertRefused(h, operation(h, 'relation.add', { tool, from: 'EnrollmentPolicy', to: 'UnitCapRule', label: null }), 'not-in-model/association');
  }
});

test('moving an end at a lifted box is outside-view/lifted-end', async () => {
  const h = harness({ view: SEATS });

  const verdict = await assertRefused(h, operation(h, 'relation.rewire', { ref: lineRef(h, 'SeatLedger', 'Planner_Web_App'), end: 'target', to: 'Billing_System' }),
    'outside-view/lifted-end');

  assert.equal(verdict.offer.view, 'components of web', 'the component view of the Planner Web App draws Live Seat Board');
});

test('turning a line with an end at a lifted box is outside-view/lifted-end', async () => {
  const h = harness({ view: SEATS });

  await assertRefused(h, operation(h, 'relation.invert', { ref: lineRef(h, 'SeatLedger', 'Planner_Web_App') }), 'outside-view/lifted-end');
});

test('moving a dependency end onto a lifted box when the other end is lifted too is outside-view/both-ends', async () => {
  const h = harness({ view: SEATS });

  await assertRefused(h, operation(h, 'relation.rewire', { ref: lineRef(h, 'SeatLedger', 'Billing_System'), end: 'source', to: 'Planner_Web_App' }),
    'outside-view/both-ends');
});

test('inverting PrerequisiteRule implements EnrollmentRule is refused with inheritanceProblem\'s code', async () => {
  const h = harness();
  const withoutEntry = C4.load(C4.edit(C4.load(DESIGN), { op: 'setList', elementId: 'PrerequisiteRule', field: 'implements', items: [] }).text);
  const code = C4.inheritanceProblem(withoutEntry, 'EnrollmentRule', 'implements', 'PrerequisiteRule');

  await assertRefused(h, operation(h, 'relation.invert', { ref: lineRef(h, 'PrerequisiteRule', 'EnrollmentRule') }), code);
});

test('inverting a generalization moves the entry to the other class in one batch', async () => {
  const h = harness({ text: withPolicyCode('              BaseRule: {kind: class, extends: [UnitCapRule]}\n') });

  await assertApplied(h, operation(h, 'relation.invert', { ref: lineRef(h, 'BaseRule', 'UnitCapRule') }));

  assert.deepEqual(element(h, 'BaseRule').code.extends, []);
  assert.deepEqual(element(h, 'UnitCapRule').code.extends, ['BaseRule']);
});

test('editing the dependency label of a line drawn to a lifted box changes the declared relationship', async () => {
  const h = harness({ view: SEATS });

  await assertApplied(h, operation(h, 'relation.update', { ref: lineRef(h, 'SeatLedger', 'Planner_Web_App'), changes: { label: 'streams seat counts to' } }));

  assert.equal(relationship(h, 'SeatLedger->seat-board').description, 'streams seat counts to');
});

// ---- Layout -----------------------------------------------------------------------------------------------------

test('a bend on the realization is layout/inheritance-line and a bend on the dependency writes a collaborator route', async () => {
  const refused = harness();
  await assertRefused(refused, operation(refused, 'layout.set',
    { positions: {}, routes: [{ id: routeIdOf(refused, 'PrerequisiteRule', 'EnrollmentRule'), points: [{ x: 100, y: 200 }] }], facts: {} }),
    'layout/inheritance-line');

  const h = harness();
  await assertApplied(h, operation(h, 'layout.set',
    { positions: {}, routes: [{ id: routeIdOf(h, 'EnrollmentPolicy', 'EnrollmentRule'), points: [{ x: 150, y: 90 }, { x: 220, y: 60 }, { x: 300, y: 90 }] }], facts: {} }));

  assert.deepEqual(h.model().layout.get(POLICY).routes.map((route) => [route.from, route.to, route.relation, route.points]),
    [['EnrollmentPolicy', 'EnrollmentRule', 'collaborator', [[150, 90], [220, 60], [300, 90]]]]);
});

test('moving a box writes its position under its model id', async () => {
  const h = harness({ text: PINNED });

  await assertApplied(h, operation(h, 'layout.set', { positions: { Seat_Holds_2: { x: 600, y: 300 } }, routes: [], facts: {} }));

  assert.deepEqual(positionsOf(h, POLICY).SeatHoldRows, [600, 300]);
});

test('a bend on one of two dependencies drawn in one direction between one pair is layout/parallel-lines', async () => {
  const h = harness({ text: PARALLEL, view: SEATS });
  const lines = h.adapter.contents().relations.filter((relation) => relation.from === 'SeatLedger' && relation.to === 'Planner_Web_App');
  assert.equal(lines.length, 2, 'two dependencies are drawn from Seat Ledger to the Planner Web App box');
  assert.equal(codeView.layoutRefusal(`rel:${lines[1].line}`, contextOf(PARALLEL, SEATS)).code, 'layout/parallel-lines',
    'the view module says so, so the surface offers no bend handle');

  await assertRefused(h, operation(h, 'layout.set', { positions: {}, routes: [{ id: `rel:${lines[0].line}`, points: [{ x: 10, y: 10 }] }], facts: {} }),
    'layout/parallel-lines');
});

test('a lock on the layout refuses a move with locked', async () => {
  const h = harness({ text: PINNED, lockedFields: ['layout'] });

  await assertRefused(h, operation(h, 'layout.set', { positions: { UnitCapRule: { x: 10, y: 10 } }, routes: [], facts: {} }), 'locked');
});

// ---- What the model has no place for ---------------------------------------------------------------------------

test('Duplicate, a note, and a keyword edit are not-in-model/duplicate, not-in-model/note, derived/keyword', async () => {
  const h = harness();

  await assertRefused(h, operation(h, 'element.duplicate', { refs: ['UnitCapRule'], offset: { x: 30, y: 30 } }), 'not-in-model/duplicate');
  await assertRefused(h, operation(h, 'element.add', { tool: 'note', name: null, into: null, anchor: 'UnitCapRule', placed: 'automatic', facts: {} }),
    'not-in-model/note');
  await assertRefused(h, operation(h, 'element.update', { ref: 'EnrollmentRule', changes: { stereotype: 'strategy' } }), 'derived/keyword');
});

test('every refusal shows the table\'s sentence, in both profiles', async () => {
  for (const profile of PROFILES) {
    const h = harness({ profile });

    const verdict = await assertRefused(h, operation(h, 'element.duplicate', { refs: ['UnitCapRule'], offset: { x: 30, y: 30 } }), 'not-in-model/duplicate');

    assert.equal(verdict.message, refusals.verdict('not-in-model/duplicate').message, profile);
  }
});

// ---- What the view offers (spec §7.3, §5.6) --------------------------------------------------------------------

test('the palette has Class, Abstract class, Interface, and Enum, and lists what this design model cannot record as unavailable', () => {
  const tools = codeView.tools(contextOf(DESIGN, POLICY, 'novice'));

  assert.deepEqual(tools.elements.map((tool) => tool.label), ['Class', 'Abstract class', 'Interface', 'Enum']);
  assert.deepEqual(tools.relations.map((tool) => tool.label), ['Generalization', 'Realization', 'Dependency']);
  assert.deepEqual(tools.unavailable.map((tool) => [tool.label, tool.code]), [
    ['Composition', 'not-in-model/association'], ['Aggregation', 'not-in-model/association'], ['Association', 'not-in-model/association'],
    ['Note', 'not-in-model/note'], ['Duplicate', 'not-in-model/duplicate'],
  ]);
  tools.unavailable.forEach((tool) => assert.ok(refusals.verdict(tool.code, tool.values).summary, `${tool.label} has a short reason`));
});

test('the unavailable kinds of line are marked as lines, so a drawn line\'s chooser can list them', () => {
  const tools = codeView.tools(contextOf(DESIGN, POLICY, 'novice'));

  assert.deepEqual(tools.unavailable.filter((tool) => tool.line).map((tool) => tool.label), ['Composition', 'Aggregation', 'Association']);
});

test('the expert profile adds Function and Module', () => {
  const tools = codeView.tools(contextOf(DESIGN, POLICY, 'expert'));

  assert.deepEqual(tools.elements.map((tool) => tool.label), ['Class', 'Abstract class', 'Interface', 'Enum', 'Function', 'Module']);
});

test('the listbox has the code elements of the component, the boxes outside it, and the lines', () => {
  const sets = codeView.optionSets(contextOf(DESIGN, SEATS));

  assert.deepEqual(sets.map((set) => set.label), ['Code elements of Seat Gateway', 'Outside Seat Gateway', 'Lines']);
  assert.deepEqual(sets[0].options.map((option) => [option.ref, option.name]), [['SeatLedger', 'SeatLedger']]);
  assert.deepEqual(sets[1].options.map((option) => [option.ref, option.name]), [['Planner_Web_App', 'Planner Web App'], ['Billing_System', 'Billing System']]);
  assert.equal(sets[2].options.length, 2);
  assert.match(sets[2].options[0].description, /Live Seat Board/, 'a line drawn to a lifted box says which element inside it it ends at');
});

test('an inheritance line\'s option is named by its ends and says it is routed for you', () => {
  const lines = codeView.optionSets(contextOf(DESIGN)).find((set) => set.label === 'Lines').options;
  const realization = lines.find((option) => option.name === 'PrerequisiteRule implements EnrollmentRule');

  assert.ok(realization, 'the realization is an option of its own');
  assert.match(realization.description, /routed for you/);
});

test('every drawn box holds a position', () => {
  const context = contextOf(DESIGN, SEATS);

  assert.deepEqual([...codeView.holders(context)].sort(), Object.keys(context.uml.ids).sort());
});

test('an option maps to the selection of its element or relationship and back', () => {
  const context = contextOf(DESIGN, SEATS);
  const lines = codeView.optionSets(context).find((set) => set.label === 'Lines').options;
  const toSeatBoard = lines.find((option) => codeView.selectionOf(option.ref, context).relationshipId === 'SeatLedger->seat-board');

  assert.deepEqual(codeView.selectionOf('Planner_Web_App', context), { elementId: 'web' });
  assert.equal(codeView.refOf({ elementId: 'web' }, context), 'Planner_Web_App');
  assert.ok(toSeatBoard, 'the line drawn to the Planner Web App box selects the declared relationship to Live Seat Board');
  assert.equal(codeView.refOf({ relationshipId: 'SeatLedger->seat-board' }, context), toSeatBoard.ref);
  assert.equal(codeView.refOf({ elementId: 'seat-board' }, context), null, 'an element the view does not draw has no option');
});

test('the boxes a gesture may end at are marked with the refusal of the others', () => {
  const h = harness();
  const request = { op: 'relation.add', revision: h.adapter.contents().revision, tool: 'real', from: 'UnitCapRule', label: null, open: 'to' };

  const answer = h.adapter.targets(request);

  const byRef = Object.fromEntries(answer.map((candidate) => [candidate.ref, candidate.code]));
  assert.equal(byRef.EnrollmentRule, 'already-present');
  assert.equal(byRef.PrerequisiteRule, 'implements-target');
  assert.equal(answer.find((candidate) => candidate.ref === 'PrerequisiteRule').summary, refusals.verdict('implements-target',
    { Target: 'PrerequisiteRule', targetKind: 'class' }).summary);
});

test('a dependency onto its own source is refused up front with the shared action\'s sentence, and a short reason for menus', () => {
  const context = contextOf(DESIGN);
  const shared = require(path.join(EDITOR, 'c4-editor-actions-shared.js'));
  const self = shared.endsProblem(context.design.model, 'EnrollmentPolicy', 'EnrollmentPolicy');

  const drawn = codeView.plan({ op: 'relation.add', tool: 'depend', from: 'EnrollmentPolicy', to: 'EnrollmentPolicy', label: null }, context);
  const line = context.uml.source.lines.findIndex((entry) => entry && entry.kind === 'relation' && entry.relationshipId === DEPENDENCY_ID);
  const moved = codeView.plan({ op: 'relation.rewire', ref: `rel:${line}`, end: 'target', to: 'EnrollmentPolicy' }, context);

  for (const [what, plan] of [['drawn', drawn], ['moved', moved]]) {
    assert.equal(plan.kind, 'refuse', `a dependency ${what} onto its source is refused`);
    assert.equal(plan.code, self.code);
    assert.equal(plan.message, self.message, 'the shared action owns the sentence');
    assert.ok(plan.summary && plan.summary.length <= 60, `a short reason of at most 60 characters: ${plan.summary}`);
  }
});

test('C mode\'s advice (a line without a kind yet) marks a box possible when any line kind fits, else gives the dependency\'s refusal', () => {
  const h = harness();
  const request = { op: 'relation.add', revision: h.adapter.contents().revision, tool: null, from: 'EnrollmentPolicy', label: null, open: 'to' };

  const answer = h.adapter.targets(request);

  const byRef = Object.fromEntries(answer.map((candidate) => [candidate.ref, candidate]));
  assert.equal(byRef.EnrollmentRule.ok, true, 'a dependency or a realization fits');
  assert.equal(byRef.PrerequisiteRule.ok, true, 'a dependency fits, though a class cannot be implemented');
  assert.equal(byRef.EnrollmentPolicy.ok, false, 'no line kind joins a class to itself');
  assert.equal(byRef.EnrollmentPolicy.code, 'self-loop', 'the dependency\'s refusal says why');
});
