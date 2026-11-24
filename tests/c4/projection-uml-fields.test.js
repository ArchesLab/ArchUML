'use strict';

// The fields the projection adds so that a canvas edit on a UML view can name what it changes in the model
// (UML-view editing spec §4.1). The fixture uml-editing.yml says what each of its additions is for.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCore, fixture } = require('./helpers.js');

const core = loadCore();
const TEXT = fixture('uml-editing.yml');
const design = core.load(TEXT, { source: 'file' });
const { model } = design;

/** The fixture with `insert` placed right after the line `anchor` (both whole lines of YAML). */
function fixtureWith(anchor, insert) {
  assert.ok(TEXT.includes(anchor), `anchor ${anchor} is in the fixture`);
  return core.load(TEXT.replace(anchor, `${anchor}\n${insert}`), { source: 'file' });
}

/** The relationship the model declares from `sourceId` to `targetId`. */
function declared(sourceId, targetId) {
  const found = model.relationships.filter((relationship) => relationship.sourceId === sourceId && relationship.targetId === targetId);
  assert.equal(found.length, 1, `one relationship ${sourceId} -> ${targetId}`);
  return found[0];
}

/** The message items of a sequence item list, fragment contents included, in drawing order. */
function messagesOf(items) {
  return items.flatMap((item) => (item.type === 'fragment' ? item.branches.flatMap((branch) => messagesOf(branch.items)) : [item]));
}

// ---- Code view ---------------------------------------------------------------------------------

test('a lifted end keeps its declared element', () => {
  const { relations } = core.project(design, 'code of seats').uml;
  const relation = relations.find((candidate) => candidate.modelTargetId === 'seat-board');
  assert.ok(relation, 'the dependency on Live Seat Board is drawn');
  assert.deepEqual(
    [relation.type, relation.sourceId, relation.targetId, relation.modelSourceId, relation.lifted],
    ['dependency', 'SeatLedger', 'web', 'SeatLedger', { source: false, target: true }],
  );
  assert.equal(relation.relationshipId, declared('SeatLedger', 'seat-board').id);
});

test('an end drawn at the box of its own declared element is not lifted', () => {
  const relation = core.project(design, 'code of seats').uml.relations.find((candidate) => candidate.targetId === 'billing');
  assert.deepEqual([relation.modelTargetId, relation.lifted, relation.relationshipId],
    ['billing', { source: false, target: false }, declared('SeatLedger', 'billing').id]);
});

test('lifted boxes and code elements are told apart', () => {
  const { classes } = core.project(design, 'code of seats').uml;
  assert.deepEqual(Object.fromEntries(classes.map((entry) => [entry.id, entry.lifted])), { SeatLedger: false, web: true, billing: true });
});

test('an inheritance line follows no relationship and is drawn between its declared ends', () => {
  const { relations } = core.project(design, 'code of policy').uml;
  const realizations = relations.filter((relation) => relation.type === 'implements');
  assert.deepEqual(realizations.map((relation) => [relation.sourceId, relation.targetId, relation.modelSourceId, relation.modelTargetId,
    relation.lifted, relation.relationshipId]), [
    ['PrerequisiteRule', 'EnrollmentRule', 'PrerequisiteRule', 'EnrollmentRule', { source: false, target: false }, null],
    ['UnitCapRule', 'EnrollmentRule', 'UnitCapRule', 'EnrollmentRule', { source: false, target: false }, null],
  ]);
});

test('a function drawn with its own call as its operation is marked synthesized', () => {
  const withFunctions = fixtureWith('                attributes: ["- rows: list"]', [
    '              audit:',
    '                kind: function',
    '              notify:',
    '                kind: function',
    '                operations: ["+ notify(student)"]',
  ].join('\n'));
  const { classes } = core.project(withFunctions, 'code of policy').uml;
  const marks = Object.fromEntries(classes.map((entry) => [entry.id, [entry.operations, entry.synthesizedOperations]]));
  assert.deepEqual(marks.audit, [['audit()'], true]);
  assert.deepEqual(marks.notify, [['+ notify(student)'], false]);
  assert.deepEqual(marks.EnrollmentPolicy, [['+ decide(student, section): Decision'], false]);
});

// ---- Dynamic view ------------------------------------------------------------------------------

test('a step left out of the drawing does not shift the positions after it', () => {
  const { items } = core.project(design, 'dynamic probe').uml;
  const [first, third] = items;
  assert.deepEqual([first.from, first.to, first.step], ['web', 'coordinator', { containerPath: [], index: 0 }]);
  assert.deepEqual([third.from, third.to, third.step], ['coordinator', 'policy', { containerPath: [], index: 2 }]);
});

test('fragments, their branches, and the steps inside them carry their place in the step tree', () => {
  const alt = core.project(design, 'dynamic probe').uml.items.find((item) => item.type === 'fragment');
  assert.deepEqual([alt.operator, alt.step], ['alt', { containerPath: [], index: 3 }]);
  assert.deepEqual(alt.branches.map((branch) => [branch.guard, branch.index]), [['sections are open', 0], ['no section is open', 1]]);
  assert.deepEqual(alt.branches[1].items, [], 'the empty branch draws nothing');
  const [loop] = alt.branches[0].items;
  assert.deepEqual([loop.operator, loop.step], ['loop', { containerPath: [3, 'alt', 0], index: 0 }]);
  assert.deepEqual(loop.branches.map((branch) => branch.index), [0]);
  const [reserve] = loop.branches[0].items;
  assert.deepEqual([reserve.from, reserve.to, reserve.step], ['coordinator', 'seats', { containerPath: [3, 'alt', 0, 'steps', 0, 'loop'], index: 0 }]);
});

test('each message carries its status and the relationships it follows', () => {
  const messages = messagesOf(core.project(design, 'dynamic probe').uml.items);
  assert.deepEqual(messages.map((message) => [`${message.from}->${message.to}`, message.status, message.relationshipIds]), [
    ['web->coordinator', 'forward', ['web->coordinator']],
    ['coordinator->policy', 'forward', ['coordinator->policy']],
    ['coordinator->seats', 'forward', ['coordinator->seats']],
    ['db->seats', 'invalid', []],
    ['billing->billing-gateway', 'invalid', []],
    ['web->policy', 'invalid', []],
  ]);
});

test('each invalid step carries its reason code', () => {
  const steps = core.classifySteps(design, 'probe');
  const codes = steps.filter((step) => step.kind === 'message').map((step) => [step.status, step.reasonCode]);
  assert.deepEqual(codes, [
    ['forward', null],
    ['invalid', 'unknown-element'],
    ['forward', null],
    ['invalid', 'reply-without-request'],
    ['invalid', 'asynchronous-no-reply'],
    ['invalid', 'no-relationship'],
  ]);
  const drawn = messagesOf(core.project(design, 'dynamic probe').uml.items).filter((message) => message.status === 'invalid');
  assert.deepEqual(drawn.map((message) => message.reasonCode), ['reply-without-request', 'asynchronous-no-reply', 'no-relationship'],
    'a drawn invalid message carries the code of its step');
});

// ---- Deployment view ---------------------------------------------------------------------------

/** The hosted element `id` runs as: itself or its nearest ancestor that a node of the view hosts. */
function hostedAncestor(id, hostedIds) {
  for (let element = model.elements.get(id); element; element = model.elements.get(element.parentId)) {
    if (hostedIds.has(element.id)) return element.id;
  }
  return null;
}

test('a derived path lists every relationship it merges', () => {
  const { nodes, links } = core.project(design, 'deployment production').uml;
  const elementOf = new Map(nodes.flatMap((node) => node.hosted.map((instance) => [instance.instanceId, instance.elementId])));
  const hostedIds = new Set(elementOf.values());
  const derived = links.filter((link) => link.derived);
  assert.ok(derived.some((link) => link.relationshipIds.length > 1), 'some path merges several relationships');
  derived.forEach((link) => {
    const merged = model.relationships.filter((relationship) => relationship.async === link.async
      && hostedAncestor(relationship.sourceId, hostedIds) === elementOf.get(link.sourceId)
      && hostedAncestor(relationship.targetId, hostedIds) === elementOf.get(link.targetId));
    assert.deepEqual(link.relationshipIds, merged.map((relationship) => relationship.id), `${link.sourceId} -> ${link.targetId}`);
  });
});

test('a link between nodes is not derived and merges no relationship', () => {
  const links = core.project(design, 'deployment production').uml.links.filter((link) => !link.derived);
  assert.deepEqual(links.map((link) => [link.sourceId, link.targetId, link.relationshipIds]), [['ingress', 'api-pod', []]]);
});

test('each hosted instance names the node it runs on', () => {
  const { nodes } = core.project(design, 'deployment production').uml;
  const placements = nodes.flatMap((node) => node.hosted.map((instance) => [instance.instanceId, instance.nodeId]));
  assert.deepEqual(placements, [['web', 'browser'], ['api@api-pod', 'api-pod'], ['api@canary', 'canary'], ['db', 'postgres'],
    ['billing', 'data-centre']]);
});

// ---- Every UML view ----------------------------------------------------------------------------

test('every UML view model has layout null', () => {
  const views = core.listViews(design, { interfaces: true }).map((view) => core.project(design, view.selector))
    .filter((view) => view.notation.startsWith('uml-'));
  assert.deepEqual([...new Set(views.map((view) => view.notation))].sort(), ['uml-class', 'uml-component', 'uml-deployment', 'uml-sequence']);
  views.forEach((view) => assert.equal(view.layout, null, view.key));
});
