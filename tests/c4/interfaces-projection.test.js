'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const y = require('../../c4/c4-yaml.js');
const modelApi = require('../../c4/c4-model.js');
const p = require('../../c4/c4-projection.js');
const { fixture } = require('./helpers.js');

// Interfaces in the view catalog and in C4, dynamic, and deployment projections (spec §5.1, §5.2 items 9–12, §5.3
// rules 1–3, §6.3 deployment paths).

const REFERENCE = fixture('course-registration-interfaces.yml');

function load(text) {
  return modelApi.normalize(y.parse(text), { source: 'file' }).model;
}

/** `text` with `from` replaced by `to`; fails when `from` is absent, so an edit cannot silently miss. */
function replaced(text, from, to) {
  assert.ok(text.includes(from), `the model text contains ${from}`);
  return text.replace(from, to);
}

const model = load(REFERENCE);
const events = load(fixture('interfaces-events.yml'));
const endpoint = load(fixture('interfaces-endpoint.yml'));

const WEB_TO_COORDINATOR = '          coordinator: {description: submits plans to, technology: JSON/HTTPS, uses: enrollment-api.submit-plan}';
const REGISTRATION_DESCRIPTION = '    description: Plans term schedules and enrolls students in their sections.\n';
const API_PROVIDES = '        provides:\n          enrollment-api:\n';
const INGRESS_COLLABORATOR = '            collaborators:\n              api-pod: forwards HTTPS requests to\n';

/** The only edge from `sourceId` to `targetId`; fails when there is none or several. */
function edgeBetween(view, sourceId, targetId) {
  const found = view.edges.filter((edge) => edge.sourceId === sourceId && edge.targetId === targetId);
  assert.equal(found.length, 1, `one edge ${sourceId}->${targetId} in ${JSON.stringify(view.edges.map((edge) => edge.id))}`);
  return found[0];
}

function nodeInterfaces(view, id) {
  return view.nodes.find((node) => node.id === id).interfaces;
}

/** Every message item of a sequence diagram, fragments included, in order. */
function messageItems(items) {
  return items.flatMap((item) => (item.type === 'fragment' ? item.branches.flatMap((branch) => messageItems(branch.items)) : [item]));
}

// ---- Selectors, listing, and breadcrumbs (spec §5.1) ---------------------------------------

test('interface selectors with the wrong scope are diagnosed', () => {
  assert.equal(p.resolveView(model, 'interfaces of student').diagnostic.rule, 'view/wrong-scope-type');
  assert.equal(p.resolveView(model, 'interfaces of EnrollmentPolicy').diagnostic.rule, 'view/wrong-scope-type');
  assert.equal(p.resolveView(model, 'interface nowhere').diagnostic.rule, 'view/unknown-selector');
  const d = p.resolveView(model, 'interface of api').diagnostic;
  assert.equal(d.rule, 'view/unknown-selector');
  assert.match(d.message, /interfaces of api/);
  assert.equal(p.resolveView(model, 'code of policy with interfaces').diagnostic.rule, 'view/wrong-scope-type');
  assert.ok(p.resolveView(model, 'code of policy with patterns').request);
  assert.ok(p.resolveView(model, 'dynamic enroll with interfaces').request);
  assert.ok(p.resolveView(model, 'interface Enrollment-API').request);
  const wrongProvider = p.resolveView(model, 'interface enrollment-api of web').diagnostic;
  assert.equal(wrongProvider.rule, 'view/wrong-scope-type');
  assert.match(wrongProvider.message, /Registration API/);
});

test('an interface selector naming its provider resolves', () => {
  assert.equal(p.resolveView(model, 'interface enrollment-api of api').request.canonical, 'interface enrollment-api');
  assert.ok(p.resolveView(model, 'interfaces of api').request);
});

test('listViews lists interface views only on request', () => {
  const base = ['landscape', 'context of registration', 'containers of registration', 'components of api',
    'code of policy', 'dynamic enroll', 'deployment production'];
  assert.deepEqual(p.listViews(model).map(v => v.selector), base);
  assert.deepEqual(p.listViews(model, { interfaces: true }).map(v => v.selector), base.concat([
    'interfaces of registration', 'interfaces of web', 'interfaces of api', 'interfaces of coordinator',
    'interfaces of billing-gateway', 'interfaces of billing', 'interface enrollment-api', 'interface tuition-charges']));
});

test('breadcrumbs treat interface views as views of their element', () => {
  const crumbs = sel => p.breadcrumbs(model, p.resolveView(model, sel).request).map(b => b.label);
  assert.deepEqual(crumbs('interfaces of api'), ['Landscape', 'Context: Course Registration', 'Containers: Course Registration', 'Interfaces of Registration API']);
  assert.deepEqual(crumbs('interface enrollment-api'), ['Landscape', 'Context: Course Registration', 'Containers: Course Registration', 'Interface description: Enrollment API']);
});

// ---- Provided, required, and consumers (spec §5.3 rules 1–3) -------------------------------

test('provided and required sets follow spec §5.3', () => {
  assert.deepEqual(p.providedInterfaces(model, 'api'), [{ interfaceId: 'enrollment-api', name: 'Enrollment API',
    declaredOnId: null, declaredOnName: null, delegatedFromId: null, delegatedFromName: null }]);
  assert.deepEqual(p.providedInterfaces(model, 'coordinator'), [{ interfaceId: 'enrollment-api', name: 'Enrollment API',
    declaredOnId: null, declaredOnName: null, delegatedFromId: 'api', delegatedFromName: 'Registration API' }]);
  assert.deepEqual(p.providedInterfaces(model, 'registration'), []);
  assert.deepEqual(p.requiredInterfaces(model, 'registration'),
    [{ interfaceId: 'tuition-charges', name: 'Tuition Charges', providerId: 'billing' }]);

  assert.deepEqual(p.providedInterfaces(endpoint, 'api'), [{ interfaceId: 'enrollment-endpoint', name: 'Enrollment endpoint',
    declaredOnId: 'endpoint', declaredOnName: 'Enrollment Endpoint', delegatedFromId: null, delegatedFromName: null }]);

  assert.deepEqual(p.providedInterfaces(events, 'orders').map((provided) => provided.interfaceId), ['order-events']);
  assert.deepEqual(p.requiredInterfaces(events, 'shipping'),
    [{ interfaceId: 'order-events', name: 'Order events', providerId: 'orders' }]);
  assert.deepEqual(p.requiredInterfaces(events, 'orders'), []);
  assert.deepEqual(p.requiredInterfaces(events, 'order-topic'), []);
});

test('consumers are lifted, and broker peers carry their topic', () => {
  const triples = (m, id) => p.interfaceConsumers(m, id).map((consumer) => [consumer.interfaceId, consumer.elementId, consumer.throughId]);
  assert.deepEqual(triples(model, 'billing'), [['tuition-charges', 'registration', null]]);
  assert.deepEqual(triples(events, 'orders'), [['order-events', 'analytics', null], ['order-events', 'shipping', 'order-topic']]);
  assert.deepEqual(p.interfaceConsumers(model, 'billing').map((consumer) => consumer.person), [false]);
});

// ---- Interfaces on edges and nodes (spec §5.2 items 9–11) ----------------------------------

test('derived edges carry the interfaces of their sources', () => {
  const containers = p.projectView(model, 'containers of registration');
  assert.deepEqual(edgeBetween(containers, 'web', 'api').interfaces,
    [{ interfaceId: 'enrollment-api', name: 'Enrollment API', operationIds: ['submit-plan'], inherited: false }]);
  assert.deepEqual(edgeBetween(containers, 'api', 'billing').interfaces,
    [{ interfaceId: 'tuition-charges', name: 'Tuition Charges', operationIds: ['charge-tuition'], inherited: false }]);
  assert.deepEqual(edgeBetween(containers, 'api', 'db').interfaces, []);
  const context = p.projectView(model, 'context of registration');
  assert.deepEqual(edgeBetween(context, 'registration', 'billing').interfaces,
    [{ interfaceId: 'tuition-charges', name: 'Tuition Charges', operationIds: ['charge-tuition'], inherited: false }]);
});

test('an explicit summary without uses carries the uses it summarizes', () => {
  const summarized = load(replaced(REFERENCE, REGISTRATION_DESCRIPTION, REGISTRATION_DESCRIPTION +
    '    collaborators:\n      billing: {description: requests tuition charges from, technology: AMQP, connector: message}\n'));
  const edge = edgeBetween(p.projectView(summarized, 'context of registration'), 'registration', 'billing');
  assert.equal(edge.derived, false);
  assert.deepEqual(edge.interfaces,
    [{ interfaceId: 'tuition-charges', name: 'Tuition Charges', operationIds: ['charge-tuition'], inherited: true }]);
});

test('a summary summarizes the lower-level relationships inside its pair, not itself', () => {
  const summarized = load(replaced(REFERENCE, REGISTRATION_DESCRIPTION, REGISTRATION_DESCRIPTION +
    '    collaborators:\n      billing: {description: requests tuition charges from, technology: AMQP, connector: message}\n'));
  const summary = summarized.relationships.find((relationship) => relationship.sourceId === 'registration' && relationship.targetId === 'billing');
  const summarizedPairs = p.summarizedBy(summarized, summary).map((relationship) => [relationship.sourceId, relationship.targetId]);
  assert.deepEqual(summarizedPairs, [['billing-gateway', 'billing']]);
});

test('an explicit relationship keeps its own interfaces when it wins over derived ones', () => {
  const explicit = load(replaced(REFERENCE, WEB_TO_COORDINATOR, WEB_TO_COORDINATOR +
    '\n          api: {description: makes API calls to, technology: JSON/HTTPS, uses: enrollment-api}'));
  const edge = edgeBetween(p.projectView(explicit, 'containers of registration'), 'web', 'api');
  assert.equal(edge.derived, false);
  assert.deepEqual(edge.interfaces, [{ interfaceId: 'enrollment-api', name: 'Enrollment API', operationIds: [], inherited: false }]);
});

test('a relationship without technology takes the agreed technology of its interfaces', () => {
  const technologyOf = (text) => {
    const edge = edgeBetween(p.projectView(load(text), 'containers of registration'), 'web', 'api');
    return [edge.technology, edge.technologySource];
  };
  assert.deepEqual(technologyOf(REFERENCE), ['JSON/HTTPS', 'relationship']);
  const untyped = replaced(REFERENCE, WEB_TO_COORDINATOR,
    '          coordinator: {description: submits plans to, uses: enrollment-api.submit-plan}');
  assert.deepEqual(technologyOf(untyped), ['JSON/HTTPS', 'interface']);
  const twoTechnologies = replaced(replaced(REFERENCE, WEB_TO_COORDINATOR,
    '          coordinator: {description: submits plans to, uses: [enrollment-api.submit-plan, plans-api]}'),
  API_PROVIDES, '        provides:\n          plans-api:\n            name: Plans API\n            style: rpc\n' +
    '            technology: gRPC\n            operations:\n              list-plans: ListPlans(student) -> Plan[]\n' +
    '          enrollment-api:\n');
  assert.deepEqual(technologyOf(twoTechnologies), [null, null]);
});

test('nodes list provided interfaces only when annotated', () => {
  const plain = p.projectView(model, 'containers of registration');
  plain.nodes.forEach((node) => {
    assert.deepEqual(node.interfaces, [], node.id);
    assert.deepEqual(node.annotations, [], node.id);
    assert.equal(node.pinAdjusted, false, node.id);
  });
  const annotated = p.projectView(model, 'Containers of registration with Interfaces');
  assert.deepEqual(nodeInterfaces(annotated, 'api'),
    [{ interfaceId: 'enrollment-api', name: 'Enrollment API', declaredOnName: null, delegatedFromName: null }]);
  assert.deepEqual(nodeInterfaces(annotated, 'billing'),
    [{ interfaceId: 'tuition-charges', name: 'Tuition Charges', declaredOnName: null, delegatedFromName: null }]);
  assert.deepEqual(nodeInterfaces(annotated, 'student'), []);
  assert.equal(annotated.selector, 'containers of registration with interfaces');
  assert.deepEqual(annotated.annotations, ['interfaces']);
  assert.equal(annotated.key, 'containers of registration');
  assert.equal(plain.selector, 'containers of registration');
  assert.deepEqual(plain.annotations, []);
  assert.deepEqual(annotated.nodes.map((node) => node.id), plain.nodes.map((node) => node.id));
  assert.deepEqual(annotated.edges.map((edge) => edge.id), plain.edges.map((edge) => edge.id));

  const components = p.projectView(model, 'components of api with interfaces');
  assert.deepEqual(nodeInterfaces(components, 'coordinator'),
    [{ interfaceId: 'enrollment-api', name: 'Enrollment API', declaredOnName: null, delegatedFromName: 'Registration API' }]);
});

test("a custom view's annotations and the suffix combine", () => {
  const withOverview = load(`${REFERENCE}\nviews:\n  overview: {view: containers of registration, annotations: [patterns]}\n`);
  const view = p.projectView(withOverview, 'overview with interfaces');
  assert.deepEqual(view.annotations, ['interfaces', 'patterns']);
  assert.equal(view.key, 'overview');
  assert.equal(view.selector, 'overview with interfaces');
  assert.equal(p.resolveView(withOverview, 'overview with tactics').request.canonical, 'overview with tactics');
});

test('an annotation that the base view of a custom view does not take is diagnosed', () => {
  const withJourney = load(`${REFERENCE}\nviews:\n  journey: {view: dynamic enroll}\n`);
  assert.equal(p.resolveView(withJourney, 'journey with styles').diagnostic.rule, 'view/wrong-scope-type');
});

// ---- Deployment paths (spec §6.3) and dynamic operations (spec §5.2 item 12) ---------------

test('an explicit node route replaces the derived browser-to-pod path', () => {
  const linkTexts = (m) => p.projectView(m, 'deployment production').uml.links
    .map((link) => `${link.sourceId}->${link.targetId}: ${link.label}`);
  assert.deepEqual(linkTexts(model), [
    'api->db: writes seat holds to',
    'api->billing: requests tuition charges from',
    'browser->ingress: sends HTTPS requests to',
    'ingress->api-pod: forwards HTTPS requests to',
  ]);
  const withoutRoute = load(replaced(REFERENCE, INGRESS_COLLABORATOR, ''));
  assert.ok(linkTexts(withoutRoute).includes('web->api: submits plans to'));
});

test('dynamic views with interfaces name the operation of each step', () => {
  const annotated = messageItems(p.projectView(model, 'dynamic enroll with interfaces').uml.items);
  assert.deepEqual(annotated[0].operation, { interfaceId: 'enrollment-api', operationId: 'submit-plan', syntax: 'POST /v1/enrollments' });
  assert.equal(annotated[0].label, 'submits the plan to [JSON/HTTPS] (POST /v1/enrollments)');
  annotated.filter((item) => item.from === 'coordinator' && item.to !== 'web')
    .forEach((item) => assert.equal(item.operation, null, `${item.from}->${item.to}`));
  const plain = messageItems(p.projectView(model, 'dynamic enroll').uml.items);
  plain.forEach((item) => assert.equal(item.operation, null, `${item.from}->${item.to}`));
  assert.equal(plain[0].label, 'submits the plan to [JSON/HTTPS]');
});

test("a step's own uses names its operation in an annotated dynamic view", () => {
  // The relationship uses the whole interface, so only the step itself names one operation.
  const wholeInterface = replaced(REFERENCE, WEB_TO_COORDINATOR,
    '          coordinator: {description: submits plans to, technology: JSON/HTTPS, uses: enrollment-api}');
  const scenario = (firstStep) => load(replaced(wholeInterface, '      - web -> coordinator: submits the plan to\n', firstStep));
  const firstItem = (m) => messageItems(p.projectView(m, 'dynamic enroll with interfaces').uml.items)[0];
  assert.equal(firstItem(scenario('      - web -> coordinator: submits the plan to\n')).operation, null);
  const named = firstItem(scenario('      - {from: web, to: coordinator, description: submits the plan to, uses: Enrollment-API.submit-plan}\n'));
  assert.deepEqual(named.operation, { interfaceId: 'enrollment-api', operationId: 'submit-plan', syntax: 'POST /v1/enrollments' });
});
