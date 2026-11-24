'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const y = require('../../c4/c4-yaml.js');
const modelApi = require('../../c4/c4-model.js');
const p = require('../../c4/c4-projection.js');
const { fixture } = require('./helpers.js');

const REFERENCE = fixture('course-registration.yml');

/** The model of YAML text; fails when the text itself has diagnostics, so every fixture is a valid design. */
function load(text) {
  const { model, diagnostics } = modelApi.normalize(y.parse(text), { source: 'embed' });
  assert.deepEqual(diagnostics, [], 'fixture diagnostics');
  return model;
}

/** The reference model with `insert` placed right after the line `anchor` (both whole lines of YAML). */
function referenceWith(anchor, insert) {
  assert.ok(REFERENCE.includes(anchor), `anchor ${anchor} is in the reference model`);
  return load(REFERENCE.replace(anchor, `${anchor}\n${insert}`));
}

/** The reference model plus a scenario `probe` whose step list is `stepsYaml` (indented as the items of `steps:`). */
function referenceWithProbe(stepsYaml) {
  return referenceWith('scenarios:', `  probe:\n    steps:\n${stepsYaml}`);
}

const reference = load(REFERENCE);

/** Statuses of one step list: a message's status, or 'fragment' for a fragment. */
function statuses(stepStatuses) {
  return stepStatuses.map((entry) => (entry.kind === 'fragment' ? 'fragment' : entry.status));
}

/** Statuses of each branch of the fragment at `index`, keyed by the branch's guard. */
function branchStatuses(stepStatuses, index) {
  return Object.fromEntries(stepStatuses[index].branches.map((branch) => [branch.when, statuses(branch.steps)]));
}

function byJson(list) {
  return list.map((item) => JSON.stringify(item)).sort();
}

/** The named fields of `entry`. The projection gains fields (UML-view editing spec §4.1), so a test pins only the fields it names. */
function pick(entry, names) {
  return Object.fromEntries(names.map((name) => [name, entry[name]]));
}

/** Asserts the fields `expected` names on `actual`, and no others. */
function assertFields(actual, expected, message) {
  assert.deepEqual(pick(actual, Object.keys(expected)), expected, message);
}

const RELATION_FIELDS = ['type', 'sourceId', 'targetId', 'label'];
const MESSAGE_FIELDS = ['type', 'from', 'to', 'label', 'arrow', 'operation'];
const HOSTED_FIELDS = ['instanceId', 'elementId', 'name', 'type'];
const LINK_FIELDS = ['sourceId', 'targetId', 'label', 'technology', 'async'];

// ---- Code view: UML class diagram ----------------------------------------------------------

test('the code view lists classes, realizations, and labelled dependencies', () => {
  const view = p.projectView(reference, 'code of policy');
  assert.equal(view.notation, 'uml-class');
  assert.equal(view.title, 'Code view: Enrollment Policy');
  assert.deepEqual(view.diagnostics, []);
  assert.deepEqual(view.uml.classes.map(({ id, kind }) => [id, kind]),
    [['EnrollmentPolicy', 'class'], ['EnrollmentRule', 'interface'], ['PrerequisiteRule', 'class'], ['UnitCapRule', 'class']]);
  assertFields(view.uml.classes[1], {
    id: 'EnrollmentRule', name: 'EnrollmentRule', kind: 'interface', keyword: null,
    attributes: [], operations: ['+ evaluate(student, section): RuleResult'], external: false,
  });
  assert.deepEqual(byJson(view.uml.relations.map((relation) => pick(relation, RELATION_FIELDS))), byJson([
    { type: 'dependency', sourceId: 'EnrollmentPolicy', targetId: 'EnrollmentRule', label: 'asks each rule to evaluate the student with' },
    { type: 'implements', sourceId: 'PrerequisiteRule', targetId: 'EnrollmentRule', label: null },
    { type: 'implements', sourceId: 'UnitCapRule', targetId: 'EnrollmentRule', label: null },
  ]));
});

const KINDS_AND_LIFTS = [
  '              audit:',
  '                kind: function',
  '                collaborators:',
  '                  seats: holds a seat with',
  '                  db: logs the decision in',
  '                  billing: reports the charge to',
  '                  student: notifies',
  '              rules:',
  '                kind: module',
  '                operations: ["+ load(): list"]',
].join('\n');

test('function and module code kinds carry keywords', () => {
  const model = referenceWith('            code:', KINDS_AND_LIFTS);
  const classes = p.projectView(model, 'code of policy').uml.classes;
  const audit = classes.find((entry) => entry.id === 'audit');
  const rules = classes.find((entry) => entry.id === 'rules');
  assert.deepEqual([audit.kind, audit.keyword], ['function', 'function']);
  assert.deepEqual(audit.operations, ['audit()'], 'a function is drawn with one operation');
  assert.deepEqual([rules.kind, rules.keyword, rules.operations], ['module', 'module', ['+ load(): list']]);
});

test('collaborators outside the component are lifted with C4 keywords', () => {
  const model = referenceWith('            code:', KINDS_AND_LIFTS);
  const { classes, relations } = p.projectView(model, 'code of policy').uml;
  const keywordOf = (id) => classes.find((entry) => entry.id === id).keyword;
  assert.deepEqual(['seats', 'db', 'billing', 'student'].map(keywordOf), ['component', 'container', 'software system', 'person']);
  assert.equal(classes.find((entry) => entry.id === 'billing').external, true);
  assert.deepEqual(relations.filter((relation) => relation.sourceId === 'audit').map((relation) => [relation.type, relation.targetId, relation.label]), [
    ['dependency', 'seats', 'holds a seat with'],
    ['dependency', 'db', 'logs the decision in'],
    ['dependency', 'billing', 'reports the charge to'],
    ['dependency', 'student', 'notifies'],
  ]);
});

test('a collaborator inside another component is lifted to that component', () => {
  const model = referenceWith('              - do: request tuition charges for a completed enrollment', [
    '            code:',
    '              ChargeRequest:',
    '                collaborators: {EnrollmentPolicy: checks the decision with}',
  ].join('\n'));
  const { classes, relations } = p.projectView(model, 'code of policy').uml;
  assert.equal(classes.find((entry) => entry.id === 'billing-gateway').keyword, 'component');
  assert.ok(relations.some((relation) => relation.sourceId === 'billing-gateway' && relation.targetId === 'EnrollmentPolicy'
    && relation.label === 'checks the decision with'));
});

test('an extends target that names no element is left out of the class diagram', () => {
  const text = REFERENCE.replace('                implements: [EnrollmentRule]', '                implements: [EnrollmentRule]\n                extends: MissingBase');
  const { model, diagnostics } = modelApi.normalize(y.parse(text), { source: 'embed' });
  assert.ok(diagnostics.some((diagnostic) => diagnostic.rule === 'model/unknown-reference'), 'the model reports the unknown target');
  const { classes, relations } = p.projectView(model, 'code of policy').uml;
  assert.equal(classes.length, 4);
  assert.ok(!relations.some((relation) => relation.type === 'extends'));
});

for (const target of ['policy', 'api']) {
  test(`an extends target that is the component or its ancestor (${target}) is left out of the class diagram`, () => {
    const text = REFERENCE.replace('                implements: [EnrollmentRule]', `                implements: [EnrollmentRule]\n                extends: ${target}`);
    const { model, diagnostics } = modelApi.normalize(y.parse(text), { source: 'embed' });
    assert.ok(diagnostics.some((diagnostic) => diagnostic.rule === 'model/wrong-type-reference'), 'the model reports the wrong-type target');
    const { classes, relations } = p.projectView(model, 'code of policy').uml;
    assert.deepEqual(classes.map((entry) => entry.id), ['EnrollmentPolicy', 'EnrollmentRule', 'PrerequisiteRule', 'UnitCapRule']);
    assert.ok(!relations.some((relation) => relation.type === 'extends'));
  });
}

// ---- Scenario steps (spec §6.3) ------------------------------------------------------------

test('the enroll scenario classifies forward steps and a synchronous reply', () => {
  const steps = p.classifySteps(reference, 'enroll');
  assert.deepEqual(statuses(steps), ['forward', 'forward', 'fragment']);
  assert.deepEqual(branchStatuses(steps, 2), { eligible: ['forward', 'forward'], 'not eligible': ['reply'] });
  assert.deepEqual(steps[0].relationshipIds, ['web->coordinator']);
  assert.deepEqual(steps[2].branches[1].steps[0].relationshipIds, ['web->coordinator'], 'a reply is backed by the request it answers');
});

test('a forward step may run along a relationship derived from nested elements', () => {
  const model = referenceWithProbe('      - web -> api: submits the plan to');
  const [step] = p.classifySteps(model, 'probe');
  assert.deepEqual([step.status, step.relationshipIds, step.reason], ['forward', ['web->coordinator'], null]);
});

test('a reply needs an earlier unanswered forward step', () => {
  const model = referenceWithProbe([
    '      - coordinator -> web: reports the outcome to',
    '      - web -> coordinator: submits the plan to',
  ].join('\n'));
  const steps = p.classifySteps(model, 'probe');
  assert.deepEqual(statuses(steps), ['invalid', 'forward']);
  assert.match(steps[0].reason, /declare/i);
});

test('a step between elements with no relationship either way is invalid', () => {
  const model = referenceWithProbe('      - web -> policy: asks for a decision from');
  assert.deepEqual(statuses(p.classifySteps(model, 'probe')), ['invalid']);
});

test('a reply may answer a forward step that precedes its enclosing fragment', () => {
  const opt = referenceWithProbe([
    '      - web -> coordinator: submits the plan to',
    '      - opt:',
    '          when: the plan is refused',
    '          steps:',
    '            - coordinator -> web: reports the refusal to',
  ].join('\n'));
  const optSteps = p.classifySteps(opt, 'probe');
  assert.deepEqual(statuses(optSteps), ['forward', 'fragment']);
  assert.deepEqual(branchStatuses(optSteps, 1), { 'the plan is refused': ['reply'] });

  const nested = referenceWithProbe([
    '      - web -> coordinator: submits the plan to',
    '      - loop:',
    '          when: each section',
    '          steps:',
    '            - alt:',
    '                - when: full',
    '                  steps:',
    '                    - coordinator -> web: reports the full section to',
  ].join('\n'));
  const loop = p.classifySteps(nested, 'probe')[1];
  assert.equal(loop.branches[0].steps[0].branches[0].steps[0].status, 'reply');
});

test('each fragment branch starts from a copy of the open requests', () => {
  const siblings = referenceWithProbe([
    '      - web -> coordinator: submits the plan to',
    '      - alt:',
    '          - when: ok',
    '            steps:',
    '              - coordinator -> web: confirms the enrollment to',
    '          - when: refused',
    '            steps:',
    '              - coordinator -> web: reports the refusal to',
  ].join('\n'));
  assert.deepEqual(branchStatuses(p.classifySteps(siblings, 'probe'), 1), { ok: ['reply'], refused: ['reply'] });

  const after = referenceWithProbe([
    '      - web -> coordinator: submits the plan to',
    '      - opt:',
    '          when: refused',
    '          steps:',
    '            - coordinator -> web: reports the refusal to',
    '      - coordinator -> web: reports the outcome to',
  ].join('\n'));
  assert.deepEqual(statuses(p.classifySteps(after, 'probe')), ['forward', 'fragment', 'reply']);

  const twice = referenceWithProbe([
    '      - web -> coordinator: submits the plan to',
    '      - opt:',
    '          when: refused',
    '          steps:',
    '            - coordinator -> web: reports the refusal to',
    '            - coordinator -> web: reports the refusal again to',
  ].join('\n'));
  assert.deepEqual(branchStatuses(p.classifySteps(twice, 'probe'), 1), { refused: ['reply', 'invalid'] });
});

const TOPIC_MODEL = `schema: c4-design/1
name: Shop
systems:
  shop:
    name: Shop
    containers:
      orders:
        name: Orders
        collaborators:
          events: {description: publishes order events to, connector: event}
      events:
        name: Order events
        kind: topic
      mailer:
        name: Mailer
        collaborators:
          events: subscribes to
scenarios:
  notify:
    steps:
      - orders -> events: publishes the order to
      - events -> mailer: delivers the order event to
`;

test('a backward step over an asynchronous relationship is invalid unless it is a queue or topic delivery', () => {
  const steps = p.classifySteps(load(TOPIC_MODEL), 'notify');
  assert.deepEqual(statuses(steps), ['async', 'delivery']);
  assert.deepEqual(steps[1].relationshipIds, ['mailer->events']);

  const backward = referenceWithProbe([
    '      - billing-gateway -> billing: requests tuition charges from',
    '      - billing -> billing-gateway: confirms the charge to',
  ].join('\n'));
  assert.deepEqual(statuses(p.classifySteps(backward, 'probe')), ['async', 'invalid']);
});

test('message and stream steps are asynchronous', () => {
  const model = referenceWithProbe([
    '      - billing-gateway -> billing: requests tuition charges from',
    '      - {from: web, to: coordinator, description: streams draft changes to, connector: stream}',
  ].join('\n'));
  assert.deepEqual(statuses(p.classifySteps(model, 'probe')), ['async', 'async']);
});

// ---- Dynamic view: UML sequence diagram ----------------------------------------------------

test('the sequence model groups lifelines by container for components and by system for containers', () => {
  const view = p.projectView(reference, 'dynamic enroll');
  assert.equal(view.notation, 'uml-sequence');
  assert.equal(view.title, 'Dynamic view: Enroll in a planned schedule');
  const { participants, boxes } = view.uml;
  assert.deepEqual(boxes, [
    { id: 'registration', label: 'Course Registration', external: false },
    { id: 'api', label: 'Registration API', external: false },
  ]);
  assert.deepEqual(participants.map((participant) => participant.id), ['web', 'coordinator', 'policy', 'seats', 'billing-gateway']);
  assert.deepEqual(participants[0], { id: 'web', name: 'Planner Web App', kind: 'participant', boxId: 'registration' });
  assert.equal(participants[1].boxId, 'api');
});

test('people are actors, and people and software systems stand outside every box', () => {
  const model = referenceWithProbe([
    '      - student -> web: enrolls using',
    '      - billing-gateway -> billing: requests tuition charges from',
  ].join('\n'));
  const { participants, boxes } = p.projectView(model, 'dynamic probe').uml;
  assert.deepEqual(participants.find((participant) => participant.id === 'student'),
    { id: 'student', name: 'Student', kind: 'actor', boxId: null });
  assert.equal(participants.find((participant) => participant.id === 'billing').boxId, null);
  assert.deepEqual(boxes.map((box) => box.id), ['registration', 'api']);
});

test('sequence items mirror the steps with arrows, labels, and guarded fragments', () => {
  const { items } = p.projectView(reference, 'dynamic enroll').uml;
  assertFields(items[0], { type: 'message', from: 'web', to: 'coordinator', label: 'submits the plan to [JSON/HTTPS]', arrow: 'sync', operation: null });
  assert.equal(items[2].type, 'fragment');
  assert.equal(items[2].operator, 'alt');
  assert.deepEqual(items[2].branches.map((branch) => branch.guard), ['eligible', 'not eligible']);
  assert.deepEqual(items[2].branches[1].items.map((item) => pick(item, MESSAGE_FIELDS)), [
    { type: 'message', from: 'coordinator', to: 'web', label: 'reports the refusal and its reason to [JSON/HTTPS]', arrow: 'reply', operation: null },
  ]);
  const asyncItems = p.projectView(load(TOPIC_MODEL), 'dynamic notify').uml.items;
  assert.deepEqual(asyncItems.map((item) => item.arrow), ['async', 'async']);
});

// ---- Deployment view: UML deployment diagram -----------------------------------------------

test('the deployment model hosts container and system instances and derives links between instances', () => {
  const view = p.projectView(reference, 'deployment production');
  assert.equal(view.notation, 'uml-deployment');
  assert.equal(view.title, 'Deployment view: Production');
  const { nodes, links } = view.uml;
  assert.deepEqual(nodes.map((node) => node.id), ['laptop', 'browser', 'campus-cloud', 'ingress', 'api-pod', 'postgres', 'data-centre']);
  const apiPod = nodes.find((node) => node.id === 'api-pod');
  assertFields(apiPod, { id: 'api-pod', name: 'API pod', kind: 'environment', technology: 'Docker', instances: 3, parentId: 'campus-cloud' });
  assert.deepEqual(apiPod.hosted.map((instance) => pick(instance, HOSTED_FIELDS)),
    [{ instanceId: 'api', elementId: 'api', name: 'Registration API', type: 'container' }]);
  assert.deepEqual(nodes.find((node) => node.id === 'data-centre').hosted.map((instance) => pick(instance, HOSTED_FIELDS)),
    [{ instanceId: 'billing', elementId: 'billing', name: 'Billing System', type: 'system' }]);
  assert.deepEqual(byJson(links.map((link) => pick(link, LINK_FIELDS))), byJson([
    { sourceId: 'web', targetId: 'api', label: 'submits plans to', technology: 'JSON/HTTPS', async: false },
    { sourceId: 'api', targetId: 'db', label: 'writes seat holds to', technology: 'SQL/TCP', async: false },
    { sourceId: 'api', targetId: 'billing', label: 'requests tuition charges from', technology: 'AMQP', async: true },
    { sourceId: 'ingress', targetId: 'api-pod', label: 'forwards HTTPS requests to', technology: null, async: false },
  ]));
});

test('an element hosted on several nodes has one instance per node, each linked', () => {
  const model = referenceWith('          postgres: {name: Managed database, kind: environment, technology: PostgreSQL 16, hosts: [db]}',
    '          canary: {name: Canary pod, kind: environment, hosts: [api]}');
  const { nodes, links } = p.projectView(model, 'deployment production').uml;
  const instanceIds = nodes.flatMap((node) => node.hosted.map((hosted) => hosted.instanceId));
  assert.deepEqual(instanceIds.filter((id) => id.startsWith('api')), ['api@api-pod', 'api@canary']);
  assert.deepEqual(links.filter((link) => link.sourceId === 'web').map((link) => link.targetId), ['api@api-pod', 'api@canary']);
});

test('an instance whose element id is also a node id is named after its node', () => {
  const model = referenceWith('          postgres: {name: Managed database, kind: environment, technology: PostgreSQL 16, hosts: [db]}',
    '          db: {name: Replica host, kind: device}');
  const postgres = p.projectView(model, 'deployment production').uml.nodes.find((node) => node.id === 'postgres');
  assert.equal(postgres.hosted[0].instanceId, 'db@postgres');
});

test('a custom view over a UML view keeps its base notation and takes its own title', () => {
  const model = load(`${REFERENCE}\nviews:\n  checkout:\n    view: dynamic enroll\n    title: How an enrollment flows\n    description: The happy path and the refusal.\n`);
  const view = p.projectView(model, 'checkout');
  assert.deepEqual([view.key, view.type, view.notation, view.title, view.description],
    ['checkout', 'dynamic', 'uml-sequence', 'How an enrollment flows', 'The happy path and the refusal.']);
  assert.deepEqual(view.uml, p.projectView(model, 'dynamic enroll').uml);
});
