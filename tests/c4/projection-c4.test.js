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

const reference = load(REFERENCE);

function nodeIds(view) {
  return view.nodes.map((node) => node.id).sort();
}

function node(view, id) {
  return view.nodes.find((candidate) => candidate.id === id);
}

function edgePairs(view) {
  return view.edges.map((edge) => `${edge.sourceId}->${edge.targetId}`).sort();
}

function edgesBetween(view, sourceId, targetId) {
  return view.edges.filter((edge) => edge.sourceId === sourceId && edge.targetId === targetId);
}

function onlyEdge(view, sourceId, targetId) {
  const edges = edgesBetween(view, sourceId, targetId);
  assert.equal(edges.length, 1, `exactly one ${sourceId}->${targetId} edge`);
  return edges[0];
}

/** The fields of an edge that a reader sees in the diagram. */
function drawn(edge) {
  const { description, technology, async, derived, unassigned } = edge;
  return { description, technology, async, derived, unassigned };
}

test('context view keeps the focal system and its direct neighbours', () => {
  const view = p.projectView(reference, 'context of registration');
  assert.deepEqual(view.diagnostics, []);
  assert.equal(view.notation, 'c4');
  assert.equal(view.title, 'System context view: Course Registration');
  assert.deepEqual(nodeIds(view), ['billing', 'registration', 'student']);
  assert.deepEqual(edgePairs(view), ['registration->billing', 'student->registration']);
  assert.deepEqual(drawn(onlyEdge(view, 'student', 'registration')),
    { description: 'plans a schedule and enrolls using', technology: null, async: false, derived: true, unassigned: false });
  assert.deepEqual(drawn(onlyEdge(view, 'registration', 'billing')),
    { description: 'requests tuition charges from', technology: null, async: true, derived: true, unassigned: false });
});

test('container view lifts component relationships to containers', () => {
  const view = p.projectView(reference, 'containers of registration');
  assert.deepEqual(nodeIds(view), ['api', 'billing', 'db', 'student', 'web']);
  assert.deepEqual(edgePairs(view), ['api->billing', 'api->db', 'student->web', 'web->api']);
  assert.deepEqual(drawn(onlyEdge(view, 'student', 'web')),
    { description: 'plans a schedule and enrolls using', technology: null, async: false, derived: false, unassigned: false });
  assert.deepEqual(drawn(onlyEdge(view, 'web', 'api')),
    { description: 'submits plans to', technology: 'JSON/HTTPS', async: false, derived: true, unassigned: false });
  assert.deepEqual(drawn(onlyEdge(view, 'api', 'db')),
    { description: 'writes seat holds to', technology: 'SQL/TCP', async: false, derived: true, unassigned: false });
  assert.deepEqual(drawn(onlyEdge(view, 'api', 'billing')),
    { description: 'requests tuition charges from', technology: 'AMQP', async: true, derived: true, unassigned: false });
  assert.deepEqual(onlyEdge(view, 'web', 'api').sources, ['web->coordinator']);
  assert.equal(view.elementCount, 5);
  assert.equal(view.large, false);
  assert.equal(view.title, 'Container view: Course Registration');
  assert.equal(view.key, 'containers of registration');
});

test('container view draws its system as the scope boundary around the containers', () => {
  const view = p.projectView(reference, 'containers of registration');
  assert.deepEqual(view.boundaries, [{ id: 'registration', kind: 'scope', label: 'Course Registration',
    typeLabel: 'Software System', parentBoundaryId: null, memberIds: ['web', 'api', 'db'] }]);
  assert.equal(node(view, 'api').boundaryId, 'registration');
  assert.equal(node(view, 'student').boundaryId, null);
});

test('nodes carry their drill target', () => {
  const view = p.projectView(reference, 'containers of registration');
  assert.equal(node(view, 'api').drill, 'components of api');
  assert.equal(node(view, 'web').drill, null);
});

test('component view shows only elements connected to components', () => {
  const view = p.projectView(reference, 'components of api');
  assert.deepEqual(nodeIds(view), ['billing', 'billing-gateway', 'coordinator', 'db', 'policy', 'seats', 'web']);
  assert.deepEqual(edgePairs(view), ['billing-gateway->billing', 'coordinator->billing-gateway',
    'coordinator->policy', 'coordinator->seats', 'seats->db', 'web->coordinator']);
  assert.ok(view.edges.every((edge) => edge.derived === false));
  assert.equal(view.title, 'Component view: Registration API');
});

const LANDINGS = [
  'people:',
  '  student:',
  '    collaborators:',
  '      registration: plans a schedule using',
  'systems:',
  '  registration:',
  '    collaborators:',
  '      billing: requests tuition charges from',
  '    containers:',
  '      web: {name: Planner}',
  '      api: {name: API}',
  '  billing:',
  '    external: true',
].join('\n');

test('system-level relationships stay visible as boundary landings', () => {
  const view = p.projectView(load(LANDINGS), 'containers of registration');
  assert.deepEqual(nodeIds(view), ['api', 'billing', 'student', 'web']);
  assert.deepEqual(drawn(onlyEdge(view, 'student', 'registration')),
    { description: 'plans a schedule using', technology: null, async: false, derived: false, unassigned: true });
  assert.deepEqual(drawn(onlyEdge(view, 'registration', 'billing')),
    { description: 'requests tuition charges from', technology: null, async: false, derived: false, unassigned: true });
  assert.ok(view.legend.some((entry) => entry.key === 'unassigned'));
});

test('a boundary landing is dropped when a child-level edge covers it', () => {
  const covered = LANDINGS.replace('      registration: plans a schedule using', '      registration: plans a schedule using\n      web: plans a schedule using');
  const view = p.projectView(load(covered), 'containers of registration');
  assert.deepEqual(edgePairs(view), ['registration->billing', 'student->web']);
});

test('explicit relationships win over derived ones of the same synchrony', () => {
  const model = referenceWith('          coordinator: {description: submits plans to, technology: JSON/HTTPS}',
    '          api: makes API calls to');
  const edge = onlyEdge(p.projectView(model, 'containers of registration'), 'web', 'api');
  assert.deepEqual(drawn(edge), { description: 'makes API calls to', technology: null, async: false, derived: false, unassigned: false });
  assert.deepEqual(edge.sources, ['web->api']);
});

test('edges of different synchrony between one pair do not merge', () => {
  const model = load([
    'systems:',
    '  s:',
    '    containers:',
    '      web:',
    '        collaborators:',
    '          api: {description: publishes plan events to, connector: event}',
    '          worker: submits plans to',
    '      api:',
    '        components:',
    '          worker: {name: Worker}',
  ].join('\n'));
  const edges = edgesBetween(p.projectView(model, 'containers of s'), 'web', 'api');
  assert.deepEqual(edges.map(drawn), [
    { description: 'publishes plan events to', technology: null, async: true, derived: false, unassigned: false },
    { description: 'submits plans to', technology: null, async: false, derived: true, unassigned: false },
  ]);
  assert.equal(new Set(edges.map((edge) => edge.id)).size, 2, 'edge ids are distinct');
});

function twoSourceModel(firstTechnology, secondTechnology) {
  return load([
    'systems:',
    '  s:',
    '    containers:',
    '      web:',
    '        collaborators:',
    `          a: {description: submits plans to, technology: ${firstTechnology}}`,
    `          b: {description: fetches schedules from, technology: ${secondTechnology}}`,
    '      api:',
    '        components:',
    '          a: {name: A}',
    '          b: {name: B}',
  ].join('\n'));
}

test('merged derived edges show the first description and a count', () => {
  const edge = onlyEdge(p.projectView(twoSourceModel('JSON/HTTPS', 'gRPC'), 'containers of s'), 'web', 'api');
  assert.equal(edge.description, 'submits plans to');
  assert.equal(edge.moreCount, 1);
  assert.deepEqual(edge.sources, ['web->a', 'web->b']);
  assert.equal(edge.technology, null);
  assert.equal(edge.derived, true);
});

test('a merged derived edge keeps the technology all its sources agree on', () => {
  const edge = onlyEdge(p.projectView(twoSourceModel('JSON/HTTPS', 'JSON/HTTPS'), 'containers of s'), 'web', 'api');
  assert.equal(edge.technology, 'JSON/HTTPS');
});

test('edges between two neighbours are drawn', () => {
  const model = referenceWith('    description: Charges tuition and fees for the university.',
    '    collaborators:\n      student: emails invoices to');
  const view = p.projectView(model, 'context of registration');
  assert.deepEqual(drawn(onlyEdge(view, 'billing', 'student')),
    { description: 'emails invoices to', technology: null, async: false, derived: false, unassigned: false });
});

const WITH_LEDGER = REFERENCE.replace('    description: Charges tuition and fees for the university.', [
  '    description: Charges tuition and fees for the university.',
  '    containers:',
  '      ledger:',
  '        name: Tuition Ledger',
  '        technology: Java',
].join('\n')) + [
  '',
  'views:',
  '  with-ledger:',
  '    view: containers of registration',
  '    title: Registration and the ledger',
  '    include: [ledger]',
  '  without-db:',
  '    view: containers of registration',
  '    exclude: [db]',
  '  declared-only:',
  '    view: containers of registration',
  '    derived: false',
  '',
].join('\n');

test('include adds a container of another system inside its system boundary', () => {
  const view = p.projectView(load(WITH_LEDGER), 'with-ledger');
  assert.equal(view.title, 'Registration and the ledger');
  assert.equal(view.key, 'with-ledger');
  assert.deepEqual(nodeIds(view), ['api', 'db', 'ledger', 'student', 'web']);
  assert.deepEqual(view.boundaries.find((boundary) => boundary.id === 'billing'), { id: 'billing', kind: 'system',
    label: 'Billing System', typeLabel: 'Software System, external', parentBoundaryId: null, memberIds: ['ledger'] });
  assert.equal(node(view, 'ledger').boundaryId, 'billing');
  assert.deepEqual(drawn(onlyEdge(view, 'api', 'billing')),
    { description: 'requests tuition charges from', technology: 'AMQP', async: true, derived: true, unassigned: false });
});

test('including a container of the focal system draws the system as a boundary that keeps its neighbours', () => {
  const model = load(`${REFERENCE}\nviews:\n  context-with-web:\n    view: context of registration\n    include: [web]\n`);
  const view = p.projectView(model, 'context-with-web');
  assert.deepEqual(nodeIds(view), ['billing', 'student', 'web']);
  const system = view.boundaries.find((boundary) => boundary.id === 'registration');
  assert.deepEqual({ kind: system.kind, memberIds: system.memberIds }, { kind: 'system', memberIds: ['web'] });
  assert.deepEqual(edgePairs(view), ['registration->billing', 'student->web']);
  assert.equal(onlyEdge(view, 'registration', 'billing').unassigned, false);
});

test('exclude removes elements and their edges', () => {
  const view = p.projectView(load(WITH_LEDGER), 'without-db');
  assert.deepEqual(nodeIds(view), ['api', 'billing', 'student', 'web']);
  assert.deepEqual(edgePairs(view), ['api->billing', 'student->web', 'web->api']);
});

test('excluding a component drops the neighbour that only it connected', () => {
  const model = load(`${REFERENCE}\nviews:\n  no-coordinator:\n    view: components of api\n    exclude: [coordinator]\n`);
  const view = p.projectView(model, 'no-coordinator');
  assert.deepEqual(nodeIds(view), ['billing', 'billing-gateway', 'db', 'policy', 'seats']);
  assert.deepEqual(edgePairs(view), ['billing-gateway->billing', 'seats->db']);
});

test('excluding a component drops the external system that only it reached', () => {
  const model = load(`${REFERENCE}\nviews:\n  no-gateway:\n    view: components of api\n    exclude: [billing-gateway]\n`);
  const view = p.projectView(model, 'no-gateway');
  assert.deepEqual(nodeIds(view), ['coordinator', 'db', 'policy', 'seats', 'web']);
  assert.deepEqual(edgePairs(view), ['coordinator->policy', 'coordinator->seats', 'seats->db', 'web->coordinator']);
});

test('a boundary landing covered only by an excluded child is drawn again', () => {
  const covered = LANDINGS.replace('      registration: plans a schedule using', '      registration: plans a schedule using\n      web: plans a schedule using')
    + '\nviews:\n  no-web:\n    view: containers of registration\n    exclude: [web]\n';
  const view = p.projectView(load(covered), 'no-web');
  assert.deepEqual(nodeIds(view), ['api', 'billing', 'student']);
  assert.deepEqual(edgePairs(view), ['registration->billing', 'student->registration']);
  assert.equal(onlyEdge(view, 'student', 'registration').unassigned, true);
});

test('derived: false hides derived edges', () => {
  const view = p.projectView(load(WITH_LEDGER), 'declared-only');
  assert.deepEqual(edgePairs(view), ['student->web']);
});

test('the enterprise boundary encloses in-enterprise people and systems, including external ones', () => {
  const model = referenceWith('    description: Charges tuition and fees for the university.',
    '  saas:\n    name: Plagiarism Checker\n    external: true\n    in_enterprise: false');
  const view = p.projectView(model, 'landscape');
  assert.deepEqual(nodeIds(view), ['billing', 'registration', 'saas', 'student']);
  const enterprise = view.boundaries.find((boundary) => boundary.kind === 'enterprise');
  assert.equal(enterprise.label, 'UCLA');
  assert.deepEqual([...enterprise.memberIds].sort(), ['billing', 'registration', 'student']);
  assert.equal(node(view, 'billing').boundaryId, enterprise.id);
  assert.equal(node(view, 'saas').boundaryId, null);
});

test('container views draw no enterprise boundary', () => {
  const view = p.projectView(reference, 'containers of registration');
  assert.ok(view.boundaries.every((boundary) => boundary.kind !== 'enterprise'));
});

test('groups become boundaries inside the scope', () => {
  const model = load([
    'systems:',
    '  s:',
    '    groups:',
    '      front: {name: Front end}',
    '    containers:',
    '      web: {group: front}',
    '      api:',
    '        collaborators: {web: pushes updates to}',
  ].join('\n'));
  const view = p.projectView(model, 'containers of s');
  const group = view.boundaries.find((boundary) => boundary.kind === 'group');
  assert.deepEqual({ label: group.label, parentBoundaryId: group.parentBoundaryId, memberIds: group.memberIds },
    { label: 'Front end', parentBoundaryId: 's', memberIds: ['web'] });
  assert.equal(node(view, 'web').groupId, group.id);
  assert.equal(node(view, 'web').boundaryId, group.id);
  assert.notEqual(group.id, 'front', 'group boundary ids cannot collide with element ids');
  assert.ok(view.legend.some((entry) => entry.key === 'group'));
});

test('box text shows the description or the first three responsibilities', () => {
  const model = load([
    'systems:',
    '  s:',
    '    responsibilities: [DO a, KNOW b, DECIDE c, DO d, DO e]',
    '  t:',
    '    description: Takes payments.',
    '    responsibilities: [DO a]',
  ].join('\n'));
  const view = p.projectView(model, 'landscape');
  assert.deepEqual(node(view, 's').lines, ['DO a', 'KNOW b', 'DECIDE c', '+2 more']);
  assert.deepEqual(node(view, 't').lines, ['Takes payments.']);
});

test('each box line says which part of the element it shows, so an editor can edit that part in place', () => {
  const model = load([
    'systems:',
    '  s:',
    '    responsibilities: [DO a, KNOW b, DECIDE c, DO d]',
    '  t:',
    '    description: Takes payments.',
  ].join('\n'));
  const view = p.projectView(model, 'landscape');
  assert.deepEqual(node(view, 's').lineParts, [
    { part: 'responsibility', index: 0 }, { part: 'responsibility', index: 1 }, { part: 'responsibility', index: 2 }, { part: 'more' },
  ]);
  assert.deepEqual(node(view, 't').lineParts, [{ part: 'description' }]);
});

test('type labels state the abstraction, technology, and external', () => {
  const containers = p.projectView(reference, 'containers of registration');
  assert.equal(node(containers, 'api').typeLabel, 'Container: Python, FastAPI');
  assert.equal(node(containers, 'billing').typeLabel, 'Software System, external');
  assert.equal(node(containers, 'student').typeLabel, 'Person');
  const model = load('systems:\n  s:\n    containers:\n      c:\n        components:\n          plain: {name: Plain}\n');
  assert.equal(node(p.projectView(model, 'components of c'), 'plain').typeLabel, 'Component');
});

test('the legend lists only the encodings used, in a fixed order', () => {
  const keys = (selector) => p.projectView(reference, selector).legend.map((entry) => entry.key);
  assert.deepEqual(keys('containers of registration'),
    ['person', 'container', 'browser_app', 'database', 'external', 'boundary-scope', 'async']);
  assert.deepEqual(keys('context of registration'), ['person', 'system', 'external', 'enterprise', 'async']);
  assert.ok(p.projectView(reference, 'context of registration').legend.every((entry) => entry.label));
});

test('a custom view with annotations adds the chosen patterns and styles to each box', () => {
  const model = load([
    'systems:',
    '  s:',
    '    containers:',
    '      api:',
    '        choices: {patterns: [Facade], styles: [layers], tactics: [retry]}',
    '      web: {name: Web}',
    'views:',
    '  annotated:',
    '    view: containers of s',
    '    annotations: [patterns, styles]',
  ].join('\n'));
  const view = p.projectView(model, 'annotated');
  assert.deepEqual(node(view, 'api').annotations, ['Facade', 'layers']);
  assert.deepEqual(node(view, 'web').annotations, []);
  assert.deepEqual(node(p.projectView(model, 'containers of s'), 'api').annotations, []);
});

function systemWithContainers(count) {
  const lines = ['systems:', '  s:', '    containers:'];
  for (let index = 1; index <= count; index += 1) lines.push(`      c${index}: {name: C${index}}`);
  return load(lines.join('\n'));
}

test('views over 20 elements project and are flagged large', () => {
  const atLimit = p.projectView(systemWithContainers(20), 'containers of s');
  assert.equal(atLimit.elementCount, 20);
  assert.equal(atLimit.large, false);
  const over = p.projectView(systemWithContainers(21), 'containers of s');
  assert.equal(over.elementCount, 21);
  assert.equal(over.large, true);
});

test('views carry breadcrumbs from the landscape down', () => {
  assert.deepEqual(p.projectView(reference, 'components of api').breadcrumbs.map((crumb) => crumb.selector),
    ['landscape', 'context of registration', 'containers of registration', 'components of api']);
});

test('an unknown selector projects to an empty view with its diagnostic', () => {
  const view = p.projectView(reference, 'containers of nowhere');
  assert.deepEqual(view.nodes, []);
  assert.deepEqual(view.edges, []);
  assert.deepEqual(view.diagnostics.map((diagnostic) => diagnostic.rule), ['view/unknown-selector']);
});

test('a custom view drawn over another custom view projects to an empty view with its diagnostic', () => {
  const model = load(`${REFERENCE}\nviews:\n  first:\n    view: containers of registration\n  second:\n    view: first\n`);
  const view = p.projectView(model, 'second');
  assert.deepEqual(view.nodes, []);
  assert.equal(view.key, 'second');
  assert.deepEqual(view.diagnostics.map((diagnostic) => diagnostic.rule), ['view/unknown-selector']);
});
