'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const y = require('../../c4/c4-yaml.js');
const modelApi = require('../../c4/c4-model.js');
const { loadCore, fixture } = require('./helpers.js');

// References into interfaces (spec §4.6, §4.8, §4.11; decision J7): collaborator and step `uses`, collaborator
// `responsibility`, operation `realizes`, and the type references inside an interface.

const REFERENCE = fixture('course-registration-interfaces.yml');
const EVENTS = fixture('interfaces-events.yml');
const ENDPOINT = fixture('interfaces-endpoint.yml');

const WEB_TO_COORDINATOR = '          coordinator: {description: submits plans to, technology: JSON/HTTPS, uses: enrollment-api.submit-plan}';
const WEB_USES_PATH = ['systems', 'registration', 'containers', 'web', 'collaborators', 'coordinator', 'uses'];

function load(text) {
  return modelApi.normalize(y.parse(text));
}

/** `text` with `from` replaced by `to`; fails when `from` is absent, so an edit cannot silently miss. */
function replaced(text, from, to) {
  assert.ok(text.includes(from), `the model text contains ${from}`);
  return text.replace(from, to);
}

/** The reference model with the web app's relationship to the coordinator written as `line`. */
function withWebToCoordinator(line) {
  return load(replaced(REFERENCE, WEB_TO_COORDINATOR, line));
}

function relationship(m, id) {
  return m.relationships.find((candidate) => candidate.id === id);
}

/** The only diagnostic of a result; fails when there are none or several. */
function onlyDiagnostic({ diagnostics }) {
  assert.equal(diagnostics.length, 1, JSON.stringify(diagnostics, null, 2));
  return diagnostics[0];
}

function errorsAndWarnings(found) {
  return found.filter((diagnostic) => diagnostic.severity !== 'info');
}

test('uses resolves to interfaces and operations', () => {
  const { model: m, diagnostics } = load(REFERENCE);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(relationship(m, 'web->coordinator').uses, [{
    interfaceId: 'enrollment-api', operationId: 'submit-plan', text: 'enrollment-api.submit-plan', path: WEB_USES_PATH,
    kind: 'request', inherited: false,
  }]);
  assert.deepEqual(relationship(m, 'billing-gateway->billing').uses.map((use) => [use.interfaceId, use.operationId, use.kind]),
    [['tuition-charges', 'charge-tuition', 'request']]);

  const listed = withWebToCoordinator(
    '          coordinator: {description: submits plans to, technology: JSON/HTTPS, uses: [enrollment-api, enrollment-api.submit-plan]}');
  assert.deepEqual(listed.diagnostics, []);
  assert.deepEqual(relationship(listed.model, 'web->coordinator').uses.map((use) => [use.interfaceId, use.operationId, use.text, use.path]), [
    ['enrollment-api', null, 'enrollment-api', WEB_USES_PATH.concat(0)],
    ['enrollment-api', 'submit-plan', 'enrollment-api.submit-plan', WEB_USES_PATH.concat(1)],
  ]);
});

test('a uses entry matches the interface id ignoring case and keeps the declared id', () => {
  const { model: m, diagnostics } = withWebToCoordinator(
    '          coordinator: {description: submits plans to, technology: JSON/HTTPS, uses: Enrollment-API.submit-plan}');
  assert.deepEqual(diagnostics, []);
  const [use] = relationship(m, 'web->coordinator').uses;
  assert.equal(use.interfaceId, 'enrollment-api');
  assert.equal(use.text, 'Enrollment-API.submit-plan');
});

test('a malformed uses entry is a schema value error at the entry', () => {
  const found = onlyDiagnostic(withWebToCoordinator(
    '          coordinator: {description: submits plans to, technology: JSON/HTTPS, uses: [enrollment-api.submit-plan.v1]}'));
  assert.equal(found.rule, 'schema/value');
  assert.deepEqual(found.path, WEB_USES_PATH.concat(0));
  assert.equal(found.element, 'web');
});

test('a request may target the provider, a descendant, or an ancestor outside the source\'s chain', () => {
  const ancestorOfTarget = withWebToCoordinator(
    '          coordinator: {description: submits plans to, technology: JSON/HTTPS, uses: enrollment-api}');
  assert.deepEqual(ancestorOfTarget.diagnostics, []);
  assert.equal(relationship(ancestorOfTarget.model, 'web->coordinator').uses[0].kind, 'request');

  const descendantOfTarget = load(replaced(ENDPOINT,
    '          endpoint: {description: submits plans to, technology: JSON/HTTPS, uses: enrollment-endpoint.submit-plan}\n',
    '          endpoint: {description: submits plans to, technology: JSON/HTTPS, uses: enrollment-endpoint.submit-plan}\n' +
    '          api: {description: checks plans with, technology: JSON/HTTPS, uses: enrollment-endpoint}\n'));
  assert.deepEqual(descendantOfTarget.diagnostics, []);
  assert.equal(relationship(descendantOfTarget.model, 'web->api').uses[0].kind, 'request');

  const providerContainsSource = onlyDiagnostic(load(replaced(REFERENCE,
    'db: {description: writes seat holds to, technology: SQL/TCP}',
    'db: {description: writes seat holds to, technology: SQL/TCP, uses: enrollment-api}')));
  assert.equal(providerContainsSource.rule, 'model/interface-provider');
  assert.equal(providerContainsSource.severity, 'error');
  assert.equal(providerContainsSource.element, 'seats');
  assert.deepEqual(providerContainsSource.path,
    ['systems', 'registration', 'containers', 'api', 'components', 'seats', 'collaborators', 'db', 'uses']);
  assert.match(providerContainsSource.message, /Registration API/);

  const unrelatedProvider = onlyDiagnostic(withWebToCoordinator(WEB_TO_COORDINATOR +
    '\n          db: {description: reads saved plans from, technology: SQL/TCP, uses: tuition-charges}'));
  assert.equal(unrelatedProvider.rule, 'model/interface-provider');
  assert.equal(unrelatedProvider.element, 'web');
});

test('emitters and broker peers resolve by J7', () => {
  const { model: m, diagnostics } = load(EVENTS);
  assert.deepEqual(diagnostics, []);
  assert.equal(relationship(m, 'orders->order-topic').uses[0].kind, 'channel');
  assert.equal(relationship(m, 'orders->analytics').uses[0].kind, 'emit');
  assert.equal(relationship(m, 'shipping->order-topic').uses[0].kind, 'broker-peer');
  assert.equal(modelApi.useKind(m, 'shipping', 'order-topic', 'order-events'), 'broker-peer');
  assert.equal(modelApi.useKind(m, 'analytics', 'shipping', 'order-events'), null);

  const withoutPublisher = onlyDiagnostic(load(replaced(EVENTS,
    '          order-topic: {description: publishes placed orders to, technology: AMQP, connector: event, uses: order-events}\n', '')));
  assert.equal(withoutPublisher.rule, 'model/interface-provider');
  assert.equal(withoutPublisher.element, 'shipping');

  const commands = load(replaced(EVENTS, '            style: event\n', '            style: message\n'));
  const commandToSubscriber = onlyDiagnostic(commands);
  assert.equal(commandToSubscriber.rule, 'model/interface-provider');
  assert.deepEqual(commandToSubscriber.path,
    ['systems', 'orders-system', 'containers', 'orders', 'collaborators', 'analytics', 'uses']);
  assert.equal(relationship(commands.model, 'orders->order-topic').uses[0].kind, 'channel');
  assert.deepEqual(relationship(commands.model, 'orders->analytics').uses, []);
});

test('a collaborator responsibility may belong to an ancestor of the target outside the source\'s chain', () => {
  const ancestorOfTarget = withWebToCoordinator('          coordinator: {description: submits plans to, technology: JSON/HTTPS, ' +
    'responsibility: api-holds, uses: enrollment-api.submit-plan}');
  assert.deepEqual(ancestorOfTarget.diagnostics, []);

  const ancestorOfSource = onlyDiagnostic(withWebToCoordinator('          coordinator: {description: submits plans to, ' +
    'technology: JSON/HTTPS, responsibility: sys-holds, uses: enrollment-api.submit-plan}'));
  assert.equal(ancestorOfSource.rule, 'model/responsibility-owner');
  assert.deepEqual(ancestorOfSource.path, WEB_USES_PATH.slice(0, -1).concat('responsibility'));
});

test('requests combine the responsibility with what the used operations realize', () => {
  const { model: m } = load(REFERENCE);
  assert.deepEqual(relationship(m, 'web->coordinator').requests, ['api-eligibility', 'api-holds', 'api-billing']);
  assert.deepEqual(relationship(m, 'coordinator->policy').requests, []);

  const asked = withWebToCoordinator('          coordinator: {description: submits plans to, technology: JSON/HTTPS, ' +
    'responsibility: api-holds, uses: enrollment-api.submit-plan}');
  assert.deepEqual(relationship(asked.model, 'web->coordinator').requests, ['api-holds', 'api-eligibility', 'api-billing']);

  const wholeInterface = withWebToCoordinator(
    '          coordinator: {description: submits plans to, technology: JSON/HTTPS, uses: enrollment-api}');
  assert.deepEqual(relationship(wholeInterface.model, 'web->coordinator').requests, ['api-eligibility', 'api-holds', 'api-billing']);
});

test('unknown interfaces, operations, and responsibilities are reported with suggestions', () => {
  const usesWith = (entry) => onlyDiagnostic(withWebToCoordinator(
    `          coordinator: {description: submits plans to, technology: JSON/HTTPS, uses: ${entry}}`));

  const misspeltInterface = usesWith('enrolment-api.submit-plan');
  assert.equal(misspeltInterface.rule, 'model/unknown-reference');
  assert.equal(misspeltInterface.element, 'web');
  assert.deepEqual(misspeltInterface.path, WEB_USES_PATH);
  assert.match(misspeltInterface.message, /enrollment-api/);

  const unknownOperation = usesWith('enrollment-api.submit');
  assert.equal(unknownOperation.rule, 'model/unknown-reference');
  assert.match(unknownOperation.message, /submit-plan/);

  const elementInsteadOfInterface = usesWith('api.submit-plan');
  assert.equal(elementInsteadOfInterface.rule, 'model/unknown-reference');
  assert.match(elementInsteadOfInterface.hint, /api is an element; name one of its interfaces: enrollment-api/);

  const unknownRealized = onlyDiagnostic(load(replaced(REFERENCE,
    'realizes: [api-eligibility, api-holds, api-billing]', 'realizes: [nope]')));
  assert.equal(unknownRealized.rule, 'model/unknown-reference');
  assert.equal(unknownRealized.element, 'api');
  assert.equal(unknownRealized.path[unknownRealized.path.length - 2], 'realizes');
});

test('realizes must name a responsibility of the provider or its descendants', () => {
  const foreign = onlyDiagnostic(load(replaced(REFERENCE,
    'realizes: [api-eligibility, api-holds, api-billing]', 'realizes: [sys-holds]')));
  assert.equal(foreign.rule, 'model/realizes-owner');
  assert.equal(foreign.severity, 'error');
  assert.equal(foreign.element, 'api');
  assert.match(foreign.message, /sys-holds/);

  const withCoordinatorId = replaced(REFERENCE, '              - do: sequence one enrollment attempt\n',
    '              - do: sequence one enrollment attempt\n                id: coordinator-do-1\n');
  const descendant = load(replaced(withCoordinatorId,
    'realizes: [api-eligibility, api-holds, api-billing]', 'realizes: [coordinator-do-1]'));
  assert.deepEqual(descendant.diagnostics, []);
});

test('types from other languages load without errors', () => {
  const { model: m, diagnostics } = load(fixture('interfaces-l14-booking.yml'));
  assert.deepEqual(diagnostics.filter((diagnostic) => diagnostic.severity === 'error'), []);
  const fields = m.interfaces.get('flight-booking').operations[0].input.fields;
  const field = (name) => fields.find((candidate) => candidate.name === name);
  assert.deepEqual(field('flightNumber').type,
    { name: 'string', list: false, primitive: true, canonical: 'string', spelling: 'str', defined: true });
  assert.equal(field('paymentReference').type.defined, false);
});

test('type references know whether their interface defines the type', () => {
  const { model: m } = load(REFERENCE);
  const enrollment = m.interfaces.get('enrollment-api');
  const [submitPlan] = enrollment.operations;
  assert.equal(submitPlan.input.type.defined, true);
  assert.equal(submitPlan.output.type.defined, true);
  const sectionIds = enrollment.types.get('EnrollmentRequest').fields.find((candidate) => candidate.name === 'section_ids');
  assert.deepEqual(sectionIds.type, { name: 'string', list: true, primitive: true, canonical: 'string[]', spelling: null, defined: true });

  const foreignType = load(replaced(REFERENCE, '            input: ChargeRequested\n', '            input: EnrollmentRequest\n'));
  const [chargeTuition] = foreignType.model.interfaces.get('tuition-charges').operations;
  assert.equal(chargeTuition.input.type.defined, false, 'types are local to their interface');
});

test('a scenario step\'s uses must be among its relationship\'s uses', () => {
  const stepWith = (entry) => load(replaced(REFERENCE, '      - web -> coordinator: submits the plan to\n',
    `      - {from: web, to: coordinator, description: submits the plan to, uses: ${entry}}\n`));

  const backed = stepWith('enrollment-api.submit-plan');
  assert.deepEqual(backed.diagnostics, []);
  assert.deepEqual(backed.model.scenarios.get('enroll').steps[0].uses, {
    interfaceId: 'enrollment-api', operationId: 'submit-plan', text: 'enrollment-api.submit-plan',
    path: ['scenarios', 'enroll', 'steps', 0, 'uses'],
  });
  assert.equal(backed.model.scenarios.get('enroll').steps[1].uses, null, 'a shorthand step names no use of its own');

  const unbacked = onlyDiagnostic(stepWith('tuition-charges.charge-tuition'));
  assert.equal(unbacked.rule, 'xlevel/scenario-step');
  assert.equal(unbacked.severity, 'error');
  assert.equal(unbacked.category, 'xlevel');
  assert.equal(unbacked.element, 'web');
  assert.deepEqual(unbacked.path, ['scenarios', 'enroll', 'steps', 0, 'uses']);
});

test('a scenario step uses one operation, which must exist', () => {
  const stepWith = (entry) => onlyDiagnostic(load(replaced(REFERENCE, '      - web -> coordinator: submits the plan to\n',
    `      - {from: web, to: coordinator, description: submits the plan to, uses: ${entry}}\n`)));
  assert.equal(stepWith('enrollment-api').rule, 'schema/value');
  assert.equal(stepWith('enrollment-api.submit').rule, 'model/unknown-reference');
});

test('uses on a deployment-node collaborator is a misplaced field', () => {
  const found = onlyDiagnostic(load(replaced(REFERENCE, '              ingress: sends HTTPS requests to\n',
    '              ingress: {description: sends HTTPS requests to, uses: enrollment-api}\n')));
  assert.equal(found.rule, 'schema/misplaced-field');
  assert.deepEqual(found.path,
    ['deployment', 'production', 'nodes', 'laptop', 'nodes', 'browser', 'collaborators', 'ingress', 'uses']);
});

test('the endpoint model offers the remote interface on a component without errors or warnings', () => {
  const core = loadCore();
  const design = core.load(ENDPOINT, { source: 'file' });
  assert.deepEqual(design.diagnostics, []);
  assert.equal(design.model.elements.size, 15);
  assert.equal(design.model.interfaces.get('enrollment-endpoint').providerId, 'endpoint');
  assert.equal(relationship(design.model, 'web->endpoint').uses[0].kind, 'request');
  assert.deepEqual(errorsAndWarnings(core.check(design)), []);
});
