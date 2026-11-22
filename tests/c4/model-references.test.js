'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const y = require('../../c4/c4-yaml.js');
const model = require('../../c4/c4-model.js');
const { fixture, rulesOf } = require('./helpers.js');

function load(text, source = 'embed') {
  return model.normalize(y.parse(text), { source });
}

function reference() {
  return load(fixture('course-registration.yml'), 'file');
}

/** The only diagnostic of a result; fails when there are none or several. */
function onlyDiagnostic({ diagnostics }) {
  assert.equal(diagnostics.length, 1, JSON.stringify(diagnostics, null, 2));
  return diagnostics[0];
}

/** A system `s` with two sibling containers `a` and `b` (b nests component `b1`), plus extra lines for `a`. */
function siblings(aLines) {
  return [
    'systems:',
    '  s:',
    '    containers:',
    '      a:',
    ...aLines.map((line) => '        ' + line),
    '      b:',
    '        components:',
    '          b1:',
  ].join('\n');
}

test('the reference model resolves every reference', () => {
  const { model: m, diagnostics } = reference();
  assert.deepEqual(diagnostics, []);
  assert.equal(m.relationships.length, 8);
  const ids = m.relationships.map((relationship) => relationship.id);
  assert.ok(ids.includes('web->coordinator'));
  const billing = m.relationships.find((relationship) => relationship.id === 'billing-gateway->billing');
  assert.equal(billing.sourceId, 'billing-gateway');
  assert.equal(billing.targetId, 'billing');
  assert.equal(billing.description, 'requests tuition charges from');
  assert.equal(billing.connector, 'message');
  assert.equal(billing.async, true);
  assert.equal(billing.technology, 'AMQP');
  assert.equal(billing.choices.technology.chosen, 'RabbitMQ');
  const web = m.relationships.find((relationship) => relationship.id === 'web->coordinator');
  assert.equal(web.connector, 'call', 'call is the default connector');
  assert.equal(web.async, false);
  assert.equal(web.technology, 'JSON/HTTPS');
});

test('the reference model indexes responsibilities, requirements, decisions, and environments', () => {
  const { model: m } = reference();
  assert.equal(m.responsibilityById.get('api-holds').ownerId, 'api');
  assert.deepEqual(m.responsibilityById.get('api-holds').refines, ['sys-holds']);
  assert.deepEqual([...m.responsibilityById.keys()], ['sys-eligibility', 'sys-holds', 'api-eligibility', 'api-holds']);
  assert.deepEqual(m.requirements.get('FR-09'), {
    id: 'FR-09', text: 'A student is enrolled in every section of a plan, or in none.', kind: null, path: ['requirements', 'FR-09'],
  });
  const decision = m.decisions.get('one-database');
  assert.equal(decision.status, 'accepted');
  assert.deepEqual(decision.affects, ['db', 'seats']);
  assert.deepEqual(decision.alternatives, ['a separate seat service with its own store']);
  const production = m.environments.get('production');
  assert.deepEqual(production.rootNodeIds, ['laptop', 'campus-cloud', 'data-centre']);
  assert.deepEqual(production.nodes.get('campus-cloud').childIds, ['ingress', 'api-pod', 'postgres']);
  assert.equal(production.nodes.get('browser').parentId, 'laptop');
  assert.deepEqual(production.nodes.get('data-centre').hosts, ['billing']);
  assert.deepEqual(production.nodes.get('ingress').relationships, [{
    targetId: 'api-pod', description: 'forwards HTTPS requests to', technology: null,
    path: ['deployment', 'production', 'nodes', 'campus-cloud', 'nodes', 'ingress', 'collaborators', 'api-pod'],
  }]);
});

test('deployment node instances convert to an integer', () => {
  const { model: m, diagnostics } = load([
    'deployment:',
    '  prod:',
    '    nodes:',
    '      pod: {instances: "3"}',
    '      single: {}',
    '      bad: {instances: many}',
  ].join('\n'));
  const nodes = m.environments.get('prod').nodes;
  assert.equal(nodes.get('pod').instances, 3);
  assert.equal(nodes.get('single').instances, 1, 'one instance by default');
  assert.deepEqual(rulesOf(diagnostics), ['schema/type']);
  assert.deepEqual(diagnostics[0].path, ['deployment', 'prod', 'nodes', 'bad', 'instances']);
});

test('collaborator string, map, and list forms produce relationships', () => {
  const { model: m, diagnostics } = load([
    'systems:',
    '  a:',
    '    collaborators:',
    '      b:',
    '        - sends orders to',
    '        - {description: receives invoices from, technology: SFTP, connector: shared-data}',
    '      c: {description: publishes order events to, connector: event}',
    '      d: queries stock levels from',
    '  b:',
    '  c:',
    '  d:',
  ].join('\n'));
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(m.relationships.map((relationship) => relationship.id), ['a->b', 'a->b#2', 'a->c', 'a->d']);
  const [first, second, event, plain] = m.relationships;
  assert.equal(first.description, 'sends orders to');
  assert.deepEqual(first.path, ['systems', 'a', 'collaborators', 'b', 0]);
  assert.equal(second.technology, 'SFTP');
  assert.equal(second.connector, 'shared-data');
  assert.equal(second.async, false);
  assert.equal(event.async, true);
  assert.equal(plain.description, 'queries stock levels from');
  assert.deepEqual(plain.path, ['systems', 'a', 'collaborators', 'd']);
});

test('an unknown collaborator target is reported at its key', () => {
  const result = load('systems:\n  a:\n    collaborators:\n      polcy: asks for a decision from\n  policy:\n');
  const diagnostic = onlyDiagnostic(result);
  assert.equal(diagnostic.rule, 'model/unknown-reference');
  assert.equal(diagnostic.severity, 'error');
  assert.equal(diagnostic.element, 'a');
  assert.deepEqual(diagnostic.range, { start: { line: 4, col: 7 }, end: { line: 4, col: 12 } });
  assert.match(diagnostic.message, /`policy`/, 'suggests the closest element id');
  assert.deepEqual(result.model.relationships, []);
});

test('collaborating with an ancestor or descendant is a containment link', () => {
  const { model: m, diagnostics } = load([
    'systems:',
    '  s:',
    '    collaborators:',
    '      c: delegates requests to',
    '    containers:',
    '      c:',
    '        collaborators:',
    '          s: reports its status to',
    '          c: calls itself through',
  ].join('\n'));
  assert.deepEqual(rulesOf(diagnostics), ['model/containment-link', 'model/containment-link', 'model/containment-link']);
  assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.range.start.line), [4, 8, 9]);
  assert.deepEqual(m.relationships, []);
});

test('refines must name a responsibility owned by an ancestor', () => {
  const { diagnostics } = load([
    'systems:',
    '  s:',
    '    responsibilities:',
    '      - {do: enroll students, id: s-enroll}',
    '    containers:',
    '      a:',
    '        responsibilities:',
    '          - {do: hold seats, id: a-hold, refines: s-enroll}',
    '      b:',
    '        responsibilities:',
    '          - {do: hold seats too, refines: [a-hold, nowhere]}',
  ].join('\n'));
  assert.deepEqual(rulesOf(diagnostics), ['model/refines-not-ancestor', 'model/unknown-reference']);
  assert.equal(diagnostics[0].element, 'b');
  assert.deepEqual(diagnostics[0].path, ['systems', 's', 'containers', 'b', 'responsibilities', 0, 'refines', 0]);
  assert.match(diagnostics[0].message, /`a`/, 'names the owner that is not an ancestor');
});

test('a collaborator responsibility may be owned by the target or its descendants', () => {
  const { model: m, diagnostics } = load([
    'systems:',
    '  s:',
    '    containers:',
    '      a:',
    '        collaborators:',
    '          b: {description: asks for seat holds from, responsibility: b1-hold}',
    '          c: {description: asks for seat holds from, responsibility: b1-hold}',
    '      b:',
    '        components:',
    '          b1:',
    '            responsibilities:',
    '              - {do: hold seats, id: b1-hold}',
    '      c:',
  ].join('\n'));
  assert.deepEqual(rulesOf(diagnostics), ['model/responsibility-owner']);
  assert.deepEqual(diagnostics[0].path, ['systems', 's', 'containers', 'a', 'collaborators', 'c', 'responsibility']);
  assert.equal(m.relationships[0].responsibility, 'b1-hold');
});

test('hosts accept containers and systems; a component is a wrong-type reference worded in C4 terms', () => {
  const { model: m, diagnostics } = load([
    'systems:',
    '  s:',
    '    containers:',
    '      api:',
    '        components:',
    '          coordinator:',
    'deployment:',
    '  prod:',
    '    nodes:',
    '      pod: {hosts: [api, s, coordinator]}',
  ].join('\n'));
  const diagnostic = onlyDiagnostic({ diagnostics });
  assert.equal(diagnostic.rule, 'model/wrong-type-reference');
  assert.deepEqual(diagnostic.path, ['deployment', 'prod', 'nodes', 'pod', 'hosts', 2]);
  assert.match(diagnostic.message, /not separately deployable/);
  assert.match(diagnostic.message, /`api`/, 'names the container to host instead');
  assert.deepEqual(m.environments.get('prod').nodes.get('pod').hosts, ['api', 's']);
});

test('infrastructure nodes cannot host or nest', () => {
  const { diagnostics } = load([
    'systems:',
    '  s:',
    'deployment:',
    '  prod:',
    '    nodes:',
    '      lb:',
    '        kind: infrastructure',
    '        hosts: [s]',
    '        nodes:',
    '          inner:',
  ].join('\n'));
  assert.deepEqual(rulesOf(diagnostics), ['model/infrastructure-leaf', 'model/infrastructure-leaf']);
  assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.range.start.line), [8, 9]);
});

test('node ids are unique per environment', () => {
  const { diagnostics } = load([
    'deployment:',
    '  prod:',
    '    nodes:',
    '      cloud:',
    '        nodes:',
    '          db:',
    '      db:',
    '  test:',
    '    nodes:',
    '      db:',
  ].join('\n'));
  const diagnostic = onlyDiagnostic({ diagnostics });
  assert.equal(diagnostic.rule, 'model/duplicate-id');
  assert.equal(diagnostic.range.start.line, 7);
});

test('responsibility ids are unique across the model and match the id pattern', () => {
  const { model: m, diagnostics } = load([
    'systems:',
    '  a:',
    '    responsibilities: [{do: x, id: r1}]',
    '  b:',
    '    responsibilities: [{do: y, id: r1}, {do: z, id: 2nd}]',
  ].join('\n'));
  assert.deepEqual(rulesOf(diagnostics), ['model/duplicate-id', 'schema/id-format']);
  assert.deepEqual(diagnostics[0].path, ['systems', 'b', 'responsibilities', 0, 'id']);
  assert.equal(m.responsibilityById.get('r1').ownerId, 'a', 'the first declaration keeps the id');
});

test('other references are checked against their namespaces', () => {
  const { diagnostics } = load([
    'groups:',
    '  core: {name: Core}',
    'systems:',
    '  s:',
    '    group: cor',
    '    responsibilities: [{do: x, requirements: [FR-1]}]',
    '    choices: {technology: {chosen: Go, decision: nope}}',
    '    containers:',
    '      c:',
    '        components:',
    '          k:',
    '            code:',
    '              A: {extends: k}',
    'decisions:',
    '  d1: {title: T, affects: [ghost], supersedes: d0}',
    'views:',
    '  mine: {view: landscape, include: [phantom]}',
    'scenarios:',
    '  sc:',
    '    steps:',
    '      - s -> zz: asks',
  ].join('\n'));
  const ruleByPath = Object.fromEntries(diagnostics.map((diagnostic) => [diagnostic.path.join('.'), diagnostic.rule]));
  assert.deepEqual(ruleByPath, {
    'systems.s.group': 'model/unknown-reference',
    'systems.s.responsibilities.0.requirements.0': 'model/unknown-reference',
    'systems.s.choices.technology.decision': 'model/unknown-reference',
    'systems.s.containers.c.components.k.code.A.extends': 'model/wrong-type-reference',
    'decisions.d1.affects.0': 'model/unknown-reference',
    'decisions.d1.supersedes': 'model/unknown-reference',
    'views.mine.include.0': 'model/unknown-reference',
    'scenarios.sc.steps.0.s -> zz': 'model/unknown-reference',
  });
  assert.equal(diagnostics.length, 8);
  const group = diagnostics.find((diagnostic) => diagnostic.path.join('.') === 'systems.s.group');
  assert.match(group.message, /`core`/, 'suggests the closest group');
  const step = diagnostics.find((diagnostic) => diagnostic.path[0] === 'scenarios');
  assert.equal(step.range.start.col, 9, 'a shorthand step is reported at its key');
});

test('container groups come from the parent system', () => {
  const { model: m, diagnostics } = load([
    'systems:',
    '  s:',
    '    groups: {edge: {name: Edge services}}',
    '    containers:',
    '      c: {group: edge}',
    '  t:',
    '    group: edge',
  ].join('\n'));
  assert.deepEqual(rulesOf(diagnostics), ['model/unknown-reference']);
  assert.deepEqual(diagnostics[0].path, ['systems', 't', 'group']);
  assert.deepEqual(m.groups.get('s/edge'), { id: 'edge', scopeId: 's', name: 'Edge services', description: null,
    path: ['systems', 's', 'groups', 'edge'] });
});

test('scenario steps parse shorthand, objects, and fragments in order', () => {
  const { model: m } = reference();
  const enroll = m.scenarios.get('enroll');
  assert.equal(enroll.title, 'Enroll in a planned schedule');
  assert.deepEqual(enroll.steps.map((step) => step.kind), ['message', 'message', 'fragment']);
  assert.deepEqual(enroll.steps[0], {
    kind: 'message', from: 'web', to: 'coordinator', description: 'submits the plan to', technology: null,
    connector: null, responsibility: null, uses: null, path: ['scenarios', 'enroll', 'steps', 0],
  });
  const alt = enroll.steps[2];
  assert.equal(alt.operator, 'alt');
  assert.deepEqual(alt.branches.map((branch) => branch.when), ['eligible', 'not eligible']);
  assert.deepEqual(alt.branches[0].steps.map((step) => step.to), ['seats', 'billing-gateway']);
  assert.deepEqual(alt.branches[1].steps[0].path, ['scenarios', 'enroll', 'steps', 2, 'alt', 1, 'steps', 0]);

  const { model: objects, diagnostics } = load([
    'systems:',
    '  a:',
    '  b:',
    'scenarios:',
    '  s:',
    '    steps:',
    '      - {from: a, to: b, description: publishes an event to, connector: event}',
    '      - loop: {when: each section, steps: [{"a -> b": holds a seat in}]}',
  ].join('\n'));
  assert.deepEqual(diagnostics, []);
  const [message, loop] = objects.scenarios.get('s').steps;
  assert.equal(message.connector, 'event');
  assert.equal(message.description, 'publishes an event to');
  assert.equal(loop.operator, 'loop');
  assert.equal(loop.branches.length, 1);
  assert.equal(loop.branches[0].when, 'each section');
  assert.equal(loop.branches[0].steps[0].description, 'holds a seat in');
});

test('layout keys are canonicalized: keyword lowercased and plural, id as declared', () => {
  const { model: m, diagnostics } = load([
    'systems:',
    '  Registration:',
    '    containers:',
    '      web:',
    'layout:',
    '  Container  of Registration:',
    '    web: [120, -40.5]',
  ].join('\n'));
  assert.deepEqual(diagnostics, []);
  assert.deepEqual([...m.layout.keys()], ['containers of Registration']);
  assert.deepEqual(m.layout.get('containers of Registration').get('web'), [120, -40.5]);

  const bad = onlyDiagnostic(load('layout:\n  landscape:\n    web: [left, 3]\n'));
  assert.equal(bad.rule, 'schema/type');
});

test('checks.ignore entries keep rule, element, and because', () => {
  const { model: m, diagnostics } = load([
    'checks:',
    '  ignore:',
    '    - {rule: c4/no-technology, element: db, because: chosen in sprint 3}',
    '    - {rule: rdd/vague}',
  ].join('\n'));
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(m.ignores, [
    { rule: 'c4/no-technology', element: 'db', because: 'chosen in sprint 3', path: ['checks', 'ignore', 0] },
    { rule: 'rdd/vague', element: null, because: null, path: ['checks', 'ignore', 1] },
  ]);
});

test('reserved view ids are rejected', () => {
  const { model: m, diagnostics } = load('views:\n  context: {view: landscape}\n  overview: {view: landscape, show_title: "false"}\n');
  const diagnostic = onlyDiagnostic({ diagnostics });
  assert.equal(diagnostic.rule, 'schema/value');
  assert.equal(diagnostic.range.start.line, 2);
  assert.deepEqual([...m.views.keys()], ['overview']);
  const overview = m.views.get('overview');
  assert.equal(overview.showTitle, false);
  assert.equal(overview.derived, true);
  assert.equal(overview.direction, 'down');
});
