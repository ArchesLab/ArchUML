'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const y = require('../../c4/c4-yaml.js');
const modelApi = require('../../c4/c4-model.js');
const p = require('../../c4/c4-projection.js');
const { fixture } = require('./helpers.js');

// The interfaces view (`interfaces of E`, notation uml-component) and the interface description card
// (`interface I`, notation interface-card), spec §5.3.

const REFERENCE = fixture('course-registration-interfaces.yml');
const SHOP = fixture('interfaces-shop.yml');

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
const shop = load(SHOP);

const WEB_TO_COORDINATOR = '          coordinator: {description: submits plans to, technology: JSON/HTTPS, uses: enrollment-api.submit-plan}';
const STUDENT_COLLABORATORS = '    collaborators:\n      web: plans a schedule and enrolls using\n';
const SUBMIT_PLAN_REALIZES = '                realizes: [api-eligibility, api-holds, api-billing]\n';
const SHOP_REFUND = '          refund: POST /v3/refunds\n';

function componentRoles(view) {
  return view.uml.components.map((component) => [component.id, component.role]);
}

function component(view, id) {
  return view.uml.components.find((entry) => entry.id === id);
}

function cardType(card, name) {
  const found = card.types.find((type) => type.name === name);
  assert.ok(found, `the card has a type ${name} in ${JSON.stringify(card.types.map((type) => type.name))}`);
  return found;
}

function fieldRow(type, name) {
  return type.fields.find((field) => field.name === name);
}

// ---- interfaces of E (spec §5.3 rules 1–6) ---------------------------------------------------

test('the interfaces view of the API shows its consumer, itself, and its provider', () => {
  const view = p.projectView(model, 'interfaces of api');
  assert.equal(view.notation, 'uml-component');
  assert.equal(view.title, 'Interface view: Registration API');
  assert.deepEqual(view.diagnostics, []);
  assert.equal(view.uml.direction, 'down');
  assert.deepEqual(componentRoles(view), [['web', 'consumer'], ['api', 'scope'], ['billing', 'provider']]);
  assert.deepEqual(view.uml.components[1].requires, [{ interfaceId: 'tuition-charges', name: 'Tuition Charges' }]);
  assert.equal(view.uml.components[2].external, true);
  assert.equal(view.uml.components[2].typeLabel, 'Software System, external');
  assert.deepEqual(view.uml.assemblies, [
    { interfaceId: 'enrollment-api', providerId: 'api', consumerId: 'web', label: 'POST /v1/enrollments', throughId: null, throughName: null },
    { interfaceId: 'tuition-charges', providerId: 'billing', consumerId: 'api', label: 'send ChargeRequested to the queue billing.charges',
      throughId: null, throughName: null },
  ]);
  assert.deepEqual(view.uml.people, []);
  assert.deepEqual(view.uml.notes, []);
  assert.equal(view.uml.emptyText, null);
});

test('the coordinator handles the API\'s interface', () => {
  const view = p.projectView(model, 'interfaces of coordinator');
  assert.deepEqual(componentRoles(view), [['web', 'consumer'], ['coordinator', 'scope']]);
  assert.equal(component(view, 'coordinator').provides[0].delegatedFromName, 'Registration API');
  assert.deepEqual(view.uml.notes, ['Enrollment API belongs to Registration API; Registration Coordinator handles its calls.']);
});

test('consumers and providers are lifted to the scope\'s level', () => {
  assert.deepEqual(componentRoles(p.projectView(model, 'interfaces of billing')), [['registration', 'consumer'], ['billing', 'scope']]);
  assert.deepEqual(componentRoles(p.projectView(model, 'interfaces of registration')), [['registration', 'scope'], ['billing', 'provider']]);
});

test('people appear as a note, not as components', () => {
  const withAdviser = load(replaced(REFERENCE, STUDENT_COLLABORATORS, STUDENT_COLLABORATORS +
    '  adviser:\n    name: Adviser\n    collaborators:\n' +
    '      api: {description: checks enrollment outcomes through, technology: JSON/HTTPS, uses: enrollment-api}\n'));
  const view = p.projectView(withAdviser, 'interfaces of api');
  assert.equal(component(view, 'adviser'), undefined);
  assert.deepEqual(view.uml.people, [{ id: 'adviser', name: 'Adviser', interfaceIds: ['enrollment-api'] }]);
  assert.equal(view.uml.notes[0], 'Also used directly by Adviser (person).');
  assert.ok(view.uml.assemblies.every((assembly) => assembly.consumerId !== 'adviser'));
});

test('offered-through interfaces are noted', () => {
  const view = p.projectView(endpoint, 'interfaces of api');
  const offered = component(view, 'api').provides.find((entry) => entry.interfaceId === 'enrollment-endpoint');
  assert.equal(offered.declaredOnName, 'Enrollment Endpoint');
  assert.deepEqual(view.uml.notes, ['Enrollment endpoint is offered through Enrollment Endpoint.']);
});

test('broker peers are drawn from the publisher with the topic in the label', () => {
  const view = p.projectView(events, 'interfaces of orders');
  assert.deepEqual(componentRoles(view), [['shipping', 'consumer'], ['analytics', 'consumer'], ['orders', 'scope']]);
  assert.deepEqual(view.uml.assemblies.map((assembly) => assembly.label),
    ['OrderPlaced on the topic orders.placed (through Order Topic)', 'OrderPlaced on the topic orders.placed']);
  assert.deepEqual(view.uml.assemblies.map((assembly) => [assembly.throughId, assembly.throughName]),
    [['order-topic', 'Order Topic'], [null, null]]);
});

test('an element without interfaces shows itself with an empty-state text', () => {
  const view = p.projectView(model, 'interfaces of db');
  assert.deepEqual(componentRoles(view), [['db', 'scope']]);
  assert.deepEqual(view.uml.assemblies, []);
  assert.equal(view.uml.emptyText, 'Registration Database provides and uses no described interfaces yet.');
});

test('assembly labels list two operations and count the rest; whole-interface uses have no label', () => {
  const threeOperations = replaced(REFERENCE, SUBMIT_PLAN_REALIZES, SUBMIT_PLAN_REALIZES +
    '              list-plans: GET /v1/plans\n              cancel-plan: DELETE /v1/enrollments/{id}\n');
  const listed = load(replaced(threeOperations, 'uses: enrollment-api.submit-plan}',
    'uses: [enrollment-api.submit-plan, enrollment-api.list-plans, enrollment-api.cancel-plan]}'));
  assert.equal(p.projectView(listed, 'interfaces of api').uml.assemblies[0].label, 'POST /v1/enrollments, GET /v1/plans (+1 more)');
  const whole = load(replaced(REFERENCE, 'uses: enrollment-api.submit-plan}', 'uses: enrollment-api}'));
  assert.equal(p.projectView(whole, 'interfaces of api').uml.assemblies[0].label, null);
});

test('exclude removes consumers and their assemblies; direction comes from a custom view', () => {
  const withViews = load(REFERENCE + 'views:\n  without-web:\n    view: interfaces of api\n    exclude: [web]\n' +
    '  sideways:\n    view: interfaces of api\n    direction: right\n');
  const excluded = p.projectView(withViews, 'without-web');
  assert.equal(component(excluded, 'web'), undefined);
  assert.deepEqual(excluded.uml.assemblies.map((assembly) => assembly.interfaceId), ['tuition-charges']);
  assert.equal(p.projectView(withViews, 'sideways').uml.direction, 'right');
});

// ---- interface I (spec §5.3, the card) -------------------------------------------------------

test('the card holds both views and the field rows', () => {
  const view = p.projectView(model, 'interface enrollment-api');
  assert.equal(view.notation, 'interface-card');
  assert.equal(view.title, 'Interface description: Enrollment API');
  assert.deepEqual(view.diagnostics, []);
  const { card } = view;
  assert.equal(card.typeLabel, 'REST interface · JSON/HTTPS · version 1');
  assert.deepEqual(card.provider, { id: 'api', name: 'Registration API', typeLabel: 'Container: Python, FastAPI' });
  assert.deepEqual(card.usedBy, [{ elementId: 'web', name: 'Planner Web App', typeLabel: 'Container: TypeScript, React', operationIds: ['submit-plan'] }]);
  assert.deepEqual(card.handledBy, [{ elementId: 'coordinator', name: 'Registration Coordinator', operationIds: ['submit-plan'] }]);
  assert.deepEqual(card.all.errors.map((error) => error.name), ['unauthorized', 'too-many-requests']);
  const [submit] = card.operations;
  assert.equal(submit.id, 'submit-plan');
  assert.equal(submit.syntax, 'POST /v1/enrollments');
  assert.deepEqual(submit.input, { typeText: 'EnrollmentRequest' });
  assert.deepEqual(submit.errors.map((error) => error.name), ['invalid-plan', 'unknown-section']);
  assert.equal(submit.examples[0].outputText, '{status: enrolled, units_enrolled: 8, decided_at: "2027-01-05T09:30:00-08:00"}');
  assert.deepEqual(submit.realizes, [
    { id: 'api-eligibility', kind: 'decide', text: 'whether a student may enroll in a section', ownerName: 'Registration API' },
    { id: 'api-holds', kind: 'do', text: 'hold a seat in every section of a plan, or in none', ownerName: 'Registration API' },
    { id: 'api-billing', kind: 'do', text: 'request the tuition charge for every completed enrollment', ownerName: 'Registration API' },
  ]);
  assert.deepEqual(card.types.map((type) => type.name), ['EnrollmentRequest', 'EnrollmentOutcome']);
  const outcome = cardType(card, 'EnrollmentOutcome');
  assert.deepEqual(fieldRow(outcome, 'units_enrolled'), {
    name: 'units_enrolled', typeText: 'number', required: true, inPath: false, values: null, constraints: [],
    meaning: 'total units the student holds in the term after this attempt', unit: 'quarter units', format: null, example: null,
  });
  assert.deepEqual(fieldRow(outcome, 'status').values, [
    { value: 'enrolled', meaning: 'the student now holds a seat in every section of the plan' },
    { value: 'refused', meaning: 'the student holds no new seat; reason says why' },
  ]);
  assert.deepEqual(card.vocabulary, [
    { term: 'section', meaning: 'one scheduled offering of a course in one term', shared: false },
    { term: 'plan', meaning: 'the sections a student wants to take together in one term', shared: false },
    { term: 'quarter unit', meaning: 'the UCLA credit unit; most courses are worth 4 quarter units', shared: true },
  ]);
});

// ViewModel.card is part of every ViewModel: the card on an interface card, null on every other view (contracts only grow).
test('every view other than an interface card has a null card', () => {
  const selectors = ['landscape', 'context of registration', 'containers of registration with interfaces', 'interfaces of api',
    'code of policy', 'dynamic enroll', 'deployment production', 'containers of nowhere'];
  selectors.forEach((selector) => assert.equal(p.projectView(model, selector).card, null, selector));
  assert.equal(p.errorView('containers of nowhere', []).card, null);
  assert.equal(p.projectView(model, 'interface enrollment-api').card.name, 'Enrollment API');
});

test('message, shorthand, and document-format interfaces project their own cards', () => {
  const message = p.projectView(model, 'interface tuition-charges').card;
  assert.equal(message.typeLabel, 'Message interface · AMQP, JSON · version 2');
  assert.equal(message.operations[0].output, null);
  assert.equal(message.operations[0].errors[0].code, null);

  const shorthand = p.projectView(shop, 'interface app').card;
  assert.equal(shorthand.shorthand, true);
  assert.equal(shorthand.typeLabel, 'Interface · syntax only');
  assert.deepEqual(shorthand.operations.map((operation) => operation.syntax), ['GET /readers/{id}', 'POST /orders']);
  assert.deepEqual(shorthand.operations.map((operation) => operation.purpose), [null, null]);

  const withFile = load(SHOP + '      settlement-file:\n        name: Settlement File\n        style: file\n        types:\n' +
    '          Settlement:\n            description: One day of settled charges.\n            fields:\n              charge_id: string\n');
  const documentFormat = p.projectView(withFile, 'interface settlement-file').card;
  assert.equal(documentFormat.documentFormat, true);
  assert.deepEqual(documentFormat.operations, []);
  assert.equal(documentFormat.typeLabel, 'File interface');
});

test('inline field maps and path parameters appear as table rows', () => {
  const charge = cardType(p.projectView(shop, 'interface card-payments').card, 'charge input');
  assert.deepEqual(charge.owner, { operationId: 'charge', part: 'input' });
  assert.deepEqual(charge.fields.map((field) => field.name), ['amount', 'card_token', 'idempotency_key']);

  const withPlans = load(replaced(SHOP, SHOP_REFUND, SHOP_REFUND +
    '          get-plan:\n            syntax: GET /v1/plans/{id}\n            input:\n              id:\n' +
    '                type: string\n                meaning: the plan to read\n' +
    '          get-charge:\n            syntax: GET /v3/charges/{id}\n            input: Charge\n'));
  const card = p.projectView(withPlans, 'interface card-payments').card;
  const getPlan = card.operations.find((operation) => operation.id === 'get-plan');
  assert.deepEqual(getPlan.placeholders, ['id']);
  assert.deepEqual(getPlan.input, { typeName: 'get-plan input' });
  assert.equal(fieldRow(cardType(card, 'get-plan input'), 'id').inPath, true);
  assert.equal(fieldRow(cardType(card, 'Charge'), 'id').inPath, true, 'a named input type binds its path parameter too');
  assert.equal(fieldRow(cardType(card, 'Charge'), 'status').inPath, false);
});
