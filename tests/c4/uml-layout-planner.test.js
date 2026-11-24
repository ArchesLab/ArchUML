'use strict';

// The layout planner of the C4 editor's UML-notation views (UML-view editing spec §6, plan Task 36): what a move, a
// drop, a return to automatic layout, and Reset layout write through `setUmlLayout`, and when they refuse. The planner
// is DOM-free: each test builds the view's context from the C4 core (the drawing's `toUml` result and the view model),
// gives the scene facts a drawing would give (every drawn position, the stored bends a move shifted), and applies the
// plan's commands to the design with `ArchUMLC4.edit`, as the editor state does. Its oracle is the layout the model then
// holds. The view module is a fake that says which boxes hold a position and why another holds none.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadCore, fixture } = require('./helpers.js');

const C4 = loadCore();
const { revisionOf } = require(path.join(__dirname, '..', '..', 'diagram-editor', 'de-operations.js'));
const layout = require(path.join(__dirname, '..', '..', 'c4', 'editor', 'c4-editor-uml-layout.js'));

const REFERENCE = fixture('course-registration-interfaces.yml');
const POLICY = 'code of policy';
const CLASSES = ['EnrollmentPolicy', 'EnrollmentRule', 'PrerequisiteRule', 'UnitCapRule'];
// Where a drawing of code of policy without positions puts its four classes (scene facts: top-left corners).
const DRAWN = {
  EnrollmentPolicy: { x: 20, y: 20 }, EnrollmentRule: { x: 300, y: 20 },
  PrerequisiteRule: { x: 150, y: 240 }, UnitCapRule: { x: 450, y: 240 },
};
const STORED = {
  EnrollmentPolicy: [80, 40], EnrollmentRule: [420, 40], PrerequisiteRule: [300, 300], UnitCapRule: [540, 300],
};
const COLLABORATOR_ROUTE = { from: 'EnrollmentPolicy', to: 'EnrollmentRule', relation: 'collaborator' };

/** The reference model with a layout entry for `selector` written as `entryYaml` (indented under the key). */
function withLayout(selector, entryYaml) {
  return `${REFERENCE}layout:\n  ${selector}:\n${entryYaml}`;
}

/** The reference model keeping STORED for code of policy, and, when `bend` is set, the collaborator line's bend. */
function pinnedPolicy({ bend = false } = {}) {
  const positions = CLASSES.map((id) => `      ${id}: [${STORED[id].join(', ')}]\n`).join('');
  const routes = bend ? '    routes:\n      - {from: EnrollmentPolicy, to: EnrollmentRule, relation: collaborator, points: [[200, 90], [260, 60], [420, 90]]}\n' : '';
  return withLayout(POLICY, `    positions:\n${positions}${routes}`);
}

/** The context a view module gets for view `selector` of the model `text` (plan Task 34), with `extra` fields. */
function contextOf(text, selector, extra = {}) {
  const design = C4.load(text);
  const viewModel = C4.project(design, selector);
  const uml = C4.toUml(viewModel);
  return Object.assign({
    design, viewModel, uml, profile: 'expert', checksReleased: true, revision: revisionOf(uml.text),
    layout: viewModel.layout, droppedRoutes: [],
  }, extra);
}

/** A fake view module whose boxes `holding` (aliases) hold a position; every other box is refused with `refusal`. */
function fakeModule(holding, refusal = null) {
  return {
    holders: () => new Set(holding),
    layoutRefusal: (ref) => (holding.includes(ref) ? null : refusal),
  };
}

/** The design after the plan's commands, run as one batch, as the editor state dispatches them. */
function applied(context, plan, before = []) {
  assert.equal(plan.kind, 'commands', `the plan writes (it is ${plan.kind}${plan.code ? ` ${plan.code}` : ''})`);
  const result = C4.edit(context.design, { op: 'batch', commands: before.concat(plan.commands) });
  assert.equal(result.error, undefined, `the core takes the plan's commands (${result.message})`);
  return C4.load(result.text);
}

const positionsOf = (design, selector) => Object.fromEntries(design.model.layout.get(selector).positions);
const routeLine = (uml) => uml.source.lines.findIndex((entry) => entry && entry.kind === 'relation' && entry.relation === 'collaborator');
const setUmlLayouts = (plan) => plan.commands.filter((command) => command.op === 'setUmlLayout');

test('the first move in code of policy pins all four classes, the moved one at its new place', () => {
  const context = contextOf(REFERENCE, POLICY);

  const plan = layout.planMove({ positions: { UnitCapRule: { x: 600.4, y: 380.6 } }, routes: [], facts: { positions: DRAWN } },
    context, fakeModule(CLASSES));

  assert.equal(setUmlLayouts(plan).length, 1, 'one setUmlLayout');
  assert.deepEqual(positionsOf(applied(context, plan), POLICY), {
    EnrollmentPolicy: [20, 20], EnrollmentRule: [300, 20], PrerequisiteRule: [150, 240], UnitCapRule: [600, 381],
  });
});

test('the first move in interfaces of api pins every drawn box through one setUmlLayout, and the view\'s toUml text then carries "layout ports facing"', () => {
  const context = contextOf(REFERENCE, 'interfaces of api');
  const boxes = Object.keys(context.uml.ids).filter((alias) => /^e\d+$/.test(alias));
  const drawn = { e1: { x: 60, y: 40 }, e2: { x: 60, y: 260 }, e3: { x: 440, y: 260 } };
  assert.deepEqual(boxes.sort(), Object.keys(drawn), 'precondition: the view draws three boxes');

  const plan = layout.planMove({ positions: { e1: { x: 60, y: 480 } }, routes: [], facts: { positions: drawn } }, context, fakeModule(boxes));

  assert.equal(plan.commands.length, 1, 'the plan is one command');
  assert.equal(setUmlLayouts(plan).length, 1, 'and it is setUmlLayout');
  const after = applied(context, plan);
  assert.deepEqual(positionsOf(after, 'interfaces of api'), { web: [60, 480], api: [60, 260], billing: [440, 260] });
  assert.match(C4.toUml(C4.project(after, 'interfaces of api')).text, /^layout ports facing$/m);
});

test('a tile dropped in code of policy without positions pins the four classes and the new one at the drop point', () => {
  const context = contextOf(REFERENCE, POLICY);
  const add = { op: 'addElement', parentId: 'policy', type: 'code', kind: 'class', name: 'New class' };
  const newId = C4.edit(context.design, add).selection.elementId;

  const plan = layout.planMove({ added: { [newId]: { x: 700, y: 60 } }, facts: { positions: DRAWN } }, context, fakeModule(CLASSES));

  assert.deepEqual(positionsOf(applied(context, plan, [add]), POLICY), {
    EnrollmentPolicy: [20, 20], EnrollmentRule: [300, 20], PrerequisiteRule: [150, 240], UnitCapRule: [450, 240], [newId]: [700, 60],
  });
});

test('a later move writes only the moved box and its shifted bends', () => {
  const context = contextOf(pinnedPolicy({ bend: true }), POLICY);
  const routeId = `rel:${routeLine(context.uml)}`;
  const shifted = [{ x: 260, y: 140 }, { x: 260, y: 60 }, { x: 420, y: 90 }];

  const plan = layout.planMove({
    positions: { EnrollmentPolicy: { x: 140, y: 90 } }, routes: [],
    facts: { positions: DRAWN, shiftedRoutes: { [routeId]: { points: shifted } } },
  }, context, fakeModule(CLASSES));

  const [command] = setUmlLayouts(plan);
  assert.deepEqual(Object.keys(command.positions), ['EnrollmentPolicy'], 'only the moved box is written');
  assert.deepEqual(command.routes, [Object.assign({}, COLLABORATOR_ROUTE, { points: [[260, 140], [260, 60], [420, 90]] })]);
  const after = applied(context, plan);
  assert.deepEqual(positionsOf(after, POLICY), Object.assign({}, STORED, { EnrollmentPolicy: [140, 90] }));
  assert.deepEqual(after.model.layout.get(POLICY).routes.map((route) => route.points), [[[260, 140], [260, 60], [420, 90]]]);
});

test('a moved bend of the dependency is written as a collaborator route of its drawn ends', () => {
  const context = contextOf(pinnedPolicy(), POLICY);
  const routeId = `rel:${routeLine(context.uml)}`;

  const plan = layout.planMove({ positions: {}, routes: [{ id: routeId, points: [{ x: 200, y: 90 }, { x: 300, y: 10 }] }], facts: { positions: DRAWN } },
    context, fakeModule(CLASSES));

  assert.deepEqual(applied(context, plan).model.layout.get(POLICY).routes,
    [Object.assign({}, COLLABORATOR_ROUTE, { points: [[200, 90], [300, 10]] })]);
});

test('return to automatic layout removes one position', () => {
  const context = contextOf(pinnedPolicy(), POLICY);

  const plan = layout.planReset({ element: 'UnitCapRule' }, context);

  const expected = Object.assign({}, STORED);
  delete expected.UnitCapRule;
  assert.deepEqual(positionsOf(applied(context, plan), POLICY), expected);
});

test('Reset layout removes the view\'s entry', () => {
  const context = contextOf(pinnedPolicy({ bend: true }), POLICY);

  const after = applied(context, layout.planReset('all', context));

  assert.equal(after.model.layout.get(POLICY), undefined, 'the model keeps no layout for the view');
  assert.doesNotMatch(after.text, /code of policy:/, 'the YAML has no entry for it');
});

test('a dropped route is removed at the next layout write and the message names it', () => {
  const dropped = [COLLABORATOR_ROUTE];
  const context = contextOf(pinnedPolicy({ bend: true }), POLICY, { droppedRoutes: dropped });

  const plan = layout.planMove({ positions: { UnitCapRule: { x: 560, y: 320 } }, routes: [], facts: { positions: DRAWN } },
    context, fakeModule(CLASSES));

  assert.equal(applied(context, plan).model.layout.get(POLICY).routes.length, 0, 'the stored bend is gone');
  assert.ok(plan.message.includes(layout.droppedRoutesSentence(dropped, context)), `the message says so: ${plan.message}`);
  assert.match(layout.droppedRoutesSentence(dropped, context), /EnrollmentPolicy[^]*EnrollmentRule/, 'the sentence names the line by its ends');
});

test('two dependencies in one direction between one pair refuse layout/parallel-lines', () => {
  const added = C4.edit(C4.load(REFERENCE), {
    op: 'addRelationship', sourceId: 'EnrollmentPolicy', targetId: 'EnrollmentRule', description: 'also checks', technology: null,
  });
  const context = contextOf(added.text, POLICY);
  const routeId = `rel:${routeLine(context.uml)}`;

  const plan = layout.planMove({ positions: {}, routes: [{ id: routeId, points: [{ x: 200, y: 90 }, { x: 300, y: 10 }] }], facts: { positions: DRAWN } },
    context, fakeModule(CLASSES));

  assert.deepEqual(plan, { kind: 'refuse', code: 'layout/parallel-lines', values: { A: 'EnrollmentPolicy', B: 'EnrollmentRule' }, offer: null });
});

test('a box that holds no position refuses with the module\'s layoutRefusal', () => {
  const context = contextOf(REFERENCE, 'deployment production');
  const refusal = { code: 'layout/inside-node', values: { Name: 'Web browser', Parent: 'Student\'s computer' } };
  const module = fakeModule(['laptop', 'campus_cloud', 'data_centre'], refusal);

  const plan = layout.planMove({ positions: { browser: { x: 300, y: 300 } }, routes: [], facts: { positions: {} } }, context, module);

  assert.deepEqual(plan, { kind: 'refuse', code: refusal.code, values: refusal.values, offer: null });
});

test('the free place lies right of the drawn boxes', () => {
  const boxes = { a: { x: 20, y: 20, width: 200, height: 100 }, b: { x: 300, y: 200, width: 150, height: 80 }, c: { x: 40, y: 400, width: 80, height: 60 } };
  const context = contextOf(REFERENCE, POLICY, { boxes });

  const place = layout.freePlace(context);

  for (const [name, box] of Object.entries(boxes)) assert.ok(place.x > box.x + box.width, `right of box ${name}: ${JSON.stringify(place)}`);
  assert.ok(Number.isFinite(place.y), 'a place has a y');
});

test('a move in a drawing fitted with a shift writes the box\'s kept place in the layout\'s frame, and the message names it', () => {
  // The renderer drew the kept boxes 10 units left of and 49 units below their kept places (it fits the drawing).
  const frame = { x: -10, y: 49 };
  const context = contextOf(pinnedPolicy(), POLICY, { frame });
  const drawnAt = { x: STORED.EnrollmentPolicy[0] + frame.x + 30, y: STORED.EnrollmentPolicy[1] + frame.y };

  const plan = layout.planMove({ positions: { EnrollmentPolicy: drawnAt }, routes: [], facts: {} }, context, fakeModule(CLASSES));

  assert.deepEqual(positionsOf(applied(context, plan), POLICY).EnrollmentPolicy, [STORED.EnrollmentPolicy[0] + 30, STORED.EnrollmentPolicy[1]]);
  assert.equal(plan.message, `Moved EnrollmentPolicy to ${STORED.EnrollmentPolicy[0] + 30}, ${STORED.EnrollmentPolicy[1]}.`);
});

test('a box moved to a place a hair left of or above the layout\'s origin is kept at 0, and design.yml has no -0', () => {
  const context = contextOf(pinnedPolicy(), POLICY);

  const plan = layout.planMove({ positions: { EnrollmentPolicy: { x: -0.3, y: -0.2 } }, routes: [], facts: {} }, context, fakeModule(CLASSES));

  const text = C4.edit(context.design, { op: 'batch', commands: plan.commands }).text;
  const [x, y] = positionsOf(C4.load(text), POLICY).EnrollmentPolicy;
  assert.deepEqual([Object.is(x, 0), Object.is(y, 0)], [true, true], 'the place is 0, 0');
  assert.equal(/EnrollmentPolicy: \[0, 0\]/.test(text), true, 'design.yml writes the place as [0, 0]');
  assert.equal(plan.message, 'Moved EnrollmentPolicy to 0, 0.');
});

test('a bend is written with the points the drawing gives, whatever the frame of the kept boxes', () => {
  const context = contextOf(pinnedPolicy({ bend: true }), POLICY, { frame: { x: -10, y: 49 } });
  const routeId = `rel:${routeLine(context.uml)}`;
  const points = [{ x: 200, y: 90 }, { x: 270, y: 70 }, { x: 420, y: 90 }];

  const plan = layout.planMove({ positions: {}, routes: [{ id: routeId, points }], facts: {} }, context, fakeModule(CLASSES));

  const route = applied(context, plan).model.layout.get(POLICY).routes.find((stored) => stored.from === 'EnrollmentPolicy');
  assert.deepEqual(route.points, [[200, 90], [270, 70], [420, 90]]);
});

// ---- After a drawing (c4-editor-uml-canvas.js): the layout's frame and the overlap check of §6 rule 4 ----------------

const umlCanvas = require(path.join(__dirname, '..', '..', 'c4', 'editor', 'c4-editor-uml-canvas.js'));
const box = (x, y, width = 100, height = 50) => ({ x, y, width, height });
/** Pairs of `items` that overlap, in the order of `ids` (the scene's overlapsAmong, on plain rectangles). */
const overlapsOf = (items) => (ids) => {
  const ordered = ids.map((id) => items.find((item) => item.id === id));
  const pairs = [];
  ordered.forEach((a, i) => ordered.slice(i + 1).forEach((b) => {
    if (a.box.x < b.box.x + b.box.width && b.box.x < a.box.x + a.box.width && a.box.y < b.box.y + b.box.height && b.box.y < a.box.y + a.box.height) {
      pairs.push([a.id, b.id]);
    }
  }));
  return pairs;
};

test('the layout\'s frame is a kept box\'s drawn place less its kept place, and none without a kept box', () => {
  const ids = { A: 'a', B: 'b' };
  const kept = { positions: new Map([['b', [40, 40]]]) };

  assert.deepEqual(umlCanvas.layoutFrame({ A: box(300, 30), B: box(30, 89) }, kept, ids), { x: -10, y: 49 });
  assert.equal(umlCanvas.layoutFrame({ A: box(300, 30) }, { positions: new Map() }, ids), null);
});

test('on a view\'s first drawing every overlap of a kept box is new, and the later box in reading order is named', () => {
  const items = [{ id: 'A', box: box(0, 0) }, { id: 'B', box: box(50, 20) }, { id: 'C', box: box(400, 0) }];

  const found = umlCanvas.overlapNotice(null, items, (id) => id === 'A', overlapsOf(items));

  assert.deepEqual(found.named, ['B', 'A']);
});

test('an overlap of two boxes neither of which keeps a position is not named', () => {
  const items = [{ id: 'A', box: box(0, 0) }, { id: 'B', box: box(50, 20) }];

  assert.equal(umlCanvas.overlapNotice(null, items, () => false, overlapsOf(items)).named, null);
});

test('the box whose rectangle changed since the last drawing is named first, compared in the layout\'s frame', () => {
  const before = [{ id: 'A', box: box(0, 0) }, { id: 'B', box: box(300, 0) }];
  const first = umlCanvas.overlapNotice(null, before, () => true, overlapsOf(before), { x: 0, y: 0 });
  // The drawing is fitted anew (every box shifted by 20, 30), and B is drawn over A, above it: A, which did not move in
  // the layout, is the later box in reading order, so only the frame tells B apart as the one that changed.
  const after = [{ id: 'A', box: box(20, 30) }, { id: 'B', box: box(40, 10) }];

  const found = umlCanvas.overlapNotice(first.drawn, after, () => true, overlapsOf(after), { x: 20, y: 30 });

  assert.deepEqual(found.named, ['B', 'A']);
});

test('a pair named once is not named again while it stays overlapped', () => {
  const items = [{ id: 'A', box: box(0, 0) }, { id: 'B', box: box(50, 20) }];
  const first = umlCanvas.overlapNotice(null, items, () => true, overlapsOf(items));

  assert.equal(umlCanvas.overlapNotice(first.drawn, items, () => true, overlapsOf(items)).named, null);
});

// ---- The listbox's lines and problem counts (c4-editor-uml-canvas.js, spec §7.3) -------------------------------------

/** A scene of drawn `routes` (`[{ id, points }]`) and boxes `items` (`[{ id, box }]`), as the diagram editor reads one. */
const sceneOf = (routes, items = []) => ({ routes: () => routes, items: () => items });
const route = (id, points) => ({ id, points: points.map(([x, y]) => ({ x, y })) });

test('every line the scene draws for a relation of the drawing is a line of the listbox, whatever its route id: a message\'s seqmsg route too', () => {
  const contents = { relations: [
    { line: 3, routeId: 'seqmsg:3', from: 'web', to: 'coordinator' },
    { line: 4, routeId: 'rel:4', from: 'coordinator', to: 'policy' },
  ] };
  const scene = sceneOf([route('seqmsg:3', [[10, 40], [210, 40]]), route('rel:4', [[210, 60], [410, 60]])]);

  const boxes = umlCanvas.lineBoxesOf(scene, contents);

  assert.deepEqual(boxes.get('seqmsg:3'), box(10, 40, 200, 0), 'a message is boxed by its drawn route');
  assert.deepEqual(boxes.get('rel:4'), box(210, 60, 200, 0));
});

test('a relation drawn without a route of its own is boxed by the unnamed routes that end at its source box', () => {
  const contents = { relations: [{ line: 2, routeId: null, from: 'A', to: 'B' }] };
  const scene = sceneOf([route('edge-0', [[50, 50], [50, 200]])], [{ id: 'A', box: box(0, 0) }, { id: 'B', box: box(0, 200) }]);

  assert.deepEqual(umlCanvas.lineBoxesOf(scene, contents).get('rel:2'), box(50, 50, 0, 150));
});

test('a step\'s or fragment\'s problem count counts the diagnostics at or inside it; an element\'s counts those naming it', () => {
  const C4design = C4.load(REFERENCE);
  const at = (...path) => ({ element: 'seats', path: ['scenarios', 'enroll', 'steps', ...path] });
  const diagnostics = [at(2, 'alt', 1, 'steps', 0), at(2, 'alt', 1, 'steps', 0, 'description'), at(1), { element: 'web', path: ['systems'] }];
  const model = C4design.model;

  assert.equal(umlCanvas.problemCountOf({ scenarioId: 'enroll', step: { containerPath: [2, 'alt', 1], index: 0 } }, diagnostics, model), 2,
    'both diagnostics of the step in branch 2 of the alt');
  assert.equal(umlCanvas.problemCountOf({ scenarioId: 'enroll', step: { containerPath: [], index: 2 } }, diagnostics, model), 2,
    'the alt counts the diagnostics of the steps inside it');
  assert.equal(umlCanvas.problemCountOf({ scenarioId: 'enroll', step: { containerPath: [], index: 0 } }, diagnostics, model), 0,
    'a step without a diagnostic has none');
  assert.equal(umlCanvas.problemCountOf({ elementId: 'seats' }, diagnostics, model), 3);
  assert.equal(umlCanvas.problemCountOf({ interfaceId: 'enrollment-api' }, diagnostics, model), 0, 'another selection counts none');
  assert.equal(umlCanvas.problemCountOf(null, diagnostics, model), 0);
});

test('a box drawn inside another (a nested node, a hosted instance) does not overlap the boxes around it', () => {
  const owned = { data_centre: ['api_pod', 'api'], api_pod: ['api'], laptop: [] };
  const pairs = [['data_centre', 'api_pod'], ['api', 'data_centre'], ['api_pod', 'api'], ['laptop', 'api_pod']];

  assert.deepEqual(umlCanvas.withoutNesting(pairs, (id) => owned[id] || []), [['laptop', 'api_pod']]);
});
