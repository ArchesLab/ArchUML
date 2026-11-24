'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const y = require('../../c4/c4-yaml.js');
const modelApi = require('../../c4/c4-model.js');
const p = require('../../c4/c4-projection.js');
const { describe } = require('../../c4/c4-describe.js');
const { toUml } = require('../../c4/c4-uml.js');
const { fixture } = require('./helpers.js');

// Accessible text of interface views and annotated views (spec §6.6), and the component-diagram text of
// `interfaces of E` (spec §6.6 rules).

function load(text) {
  return modelApi.normalize(y.parse(text), { source: 'file' }).model;
}

/** `text` with `from` replaced by `to`; fails when `from` is absent, so an edit cannot silently miss. */
function replaced(text, from, to) {
  assert.ok(text.includes(from), `the model text contains ${from}`);
  return text.replace(from, to);
}

const REFERENCE = fixture('course-registration-interfaces.yml');
const SHOP = fixture('interfaces-shop.yml');
const model = load(REFERENCE);
const shop = load(SHOP);
const endpoint = load(fixture('interfaces-endpoint.yml'));

function describeView(target, selector, options) {
  return describe(p.projectView(target, selector), options);
}

function items(description, heading) {
  const found = description.sections.find((section) => section.heading === heading);
  assert.ok(found, `the description has a ${heading} section in ${JSON.stringify(description.sections.map((entry) => entry.heading))}`);
  return found.items;
}

function allItems(description) {
  return description.sections.flatMap((section) => section.items);
}

function headings(description) {
  return description.sections.map((section) => section.heading);
}

// ---- interfaces of E ---------------------------------------------------------------------------

test('the interfaces view brief counts provided and required interfaces', () => {
  const description = describeView(model, 'interfaces of api');
  assert.equal(description.brief, 'Interface view of Registration API: provides 1 interface, requires 1 interface, 2 connected elements.');
  const lines = allItems(description);
  assert.ok(lines.includes('Registration API provides Enrollment API, used by Planner Web App (POST /v1/enrollments).'));
  assert.ok(lines.includes(
    'Registration API requires Tuition Charges from Billing System (send ChargeRequested to the queue billing.charges).'));
});

test('the legend of an interfaces view names its subject and no place', () => {
  assert.deepEqual(items(describeView(model, 'interfaces of api'), 'Legend'), ['Ball: an interface the element provides. Socket: an interface it requires. Ball in socket: the consumer uses '
    + 'that interface. The subject of this view is Registration API.']);
});

test('the interfaces view of the coordinator states the delegated interface in a note', () => {
  const lines = allItems(describeView(model, 'interfaces of coordinator'));
  assert.ok(lines.includes('Enrollment API belongs to Registration API; Registration Coordinator handles its calls.'));
});

test('an element without interfaces is described by the empty-state text instead of the legend', () => {
  const lines = allItems(describeView(model, 'interfaces of db'));
  assert.ok(lines.includes('Registration Database provides and uses no described interfaces yet.'));
  assert.ok(!lines.some((line) => line.startsWith('Ball:')));
});

test('a provided interface nothing uses is stated without a consumer', () => {
  const lines = allItems(describeView(shop, 'interfaces of app'));
  assert.ok(lines.includes('Shop App provides Shop App interface; no element uses it.'));
});

// ---- the interface card ------------------------------------------------------------------------

test('the card description has the syntactic, semantic, data-type, vocabulary, and used-by sections', () => {
  const description = describeView(model, 'interface enrollment-api');
  assert.equal(description.brief,
    'Interface description of Enrollment API (REST interface, JSON/HTTPS, version 1), provided by Registration API: 1 operation, 2 types, 4 errors.');
  assert.deepEqual(headings(description), ['Syntactic view', 'Semantic view', 'Data types', 'Shared vocabulary', 'Used by']);
  assert.ok(items(description, 'Syntactic view').includes('submit-plan: POST /v1/enrollments. Input: EnrollmentRequest. Output: EnrollmentOutcome.'));
  const types = items(description, 'Data types');
  assert.ok(types.includes('units_enrolled: number; unit: quarter units; meaning: total units the student holds in the term after this attempt.'));
  assert.ok(types.includes('status: string; one of enrolled (the student now holds a seat in every section of the plan), '
    + 'refused (the student holds no new seat; reason says why); meaning: whether the plan was accepted.'));
  assert.ok(types.includes('section_ids: string[]; constraints: 1 to 8 items, no duplicates; format: six-digit section ids; '
    + 'meaning: the sections the student wants to take together.'));
  assert.ok(types.includes('reason: string, optional; meaning: the reason for a refusal in words a student understands.'));
  const semantics = items(description, 'Semantic view');
  assert.ok(semantics.some((item) => item.startsWith('All operations: Usage restrictions: Only the Planner Web App may call it')));
  const submitPlan = semantics.find((item) => item.startsWith('submit-plan: POST /v1/enrollments. Purpose: When a client submits'));
  assert.ok(submitPlan, 'the semantic view has an item for submit-plan');
  assert.ok(submitPlan.includes('units_enrolled: 8'), 'the example is spelled from its source text');
  assert.ok(!submitPlan.includes('"units_enrolled'), 'the example keys are not quoted');
});

test('the card description names who uses the interface and who handles it', () => {
  const used = items(describeView(model, 'interface enrollment-api'), 'Used by');
  assert.ok(used.includes('Planner Web App (Container: TypeScript, React): submit-plan.'));
  assert.ok(used.includes('Handled inside Registration API by Registration Coordinator (submit-plan).'));
});

test('the syntax-only panel leaves out meanings and absences', () => {
  const description = describeView(model, 'interface enrollment-api', { panels: 'syntax' });
  assert.deepEqual(headings(description), ['Syntactic view', 'Data types', 'Used by']);
  assert.ok(items(description, 'Data types').includes('units_enrolled: number.'));
  assert.ok(!allItems(description).some((item) => item.includes('not stated')));
  const shopCard = describeView(shop, 'interface card-payments', { panels: 'syntax' });
  assert.ok(!allItems(shopCard).some((item) => item.includes('not stated') || item.includes('not described')));
});

test('absences are stated neutrally without naming rules', () => {
  const semantics = items(describeView(shop, 'interface card-payments'), 'Semantic view');
  const refund = semantics.find((item) => item.startsWith('refund: POST /v3/refunds.'));
  assert.ok(refund.includes('Purpose: not stated.'));
  assert.ok(refund.includes('Errors: none stated.'));
  const shorthand = describeView(shop, 'interface app');
  assert.deepEqual(items(shorthand, 'Semantic view'), ['Semantic view: not described yet.']);
  [describeView(shop, 'interface card-payments'), shorthand].forEach((description) => allItems(description)
    .forEach((item) => assert.doesNotMatch(item, /interface\//)));
});

// ---- annotated views ---------------------------------------------------------------------------

test('annotated views mention interfaces and plain views do not', () => {
  const annotated = describeView(model, 'containers of registration with interfaces');
  const element = items(annotated, 'Containers').find((item) => item.startsWith('Registration API'));
  assert.ok(element.includes('Provides Enrollment API.'));
  assert.ok(items(annotated, 'Relationships').some((item) => item.startsWith('Planner Web App submits plans to Registration API')
    && item.includes('via Enrollment API')));
  const plain = describeView(model, 'containers of registration');
  assert.ok(!allItems(plain).some((item) => item.includes('via ') || item.includes('Provides ')));
  assert.equal(plain.brief, 'Container view of Course Registration: 3 containers, 1 person, 1 external system, 4 relationships.');
  const dynamic = describeView(model, 'dynamic enroll with interfaces');
  assert.ok(items(dynamic, 'Steps').some((item) => item.includes('(POST /v1/enrollments)')));
});

test('a boundary landing is described as a relationship to the boundary system', () => {
  const landings = load(['people:', '  student:', '    collaborators:', '      registration: plans a schedule using', 'systems:',
    '  registration:', '    name: Registration', '    containers:', '      web: {name: Planner}', '      api: {name: API}'].join('\n'));
  const lines = items(describeView(landings, 'containers of registration'), 'Relationships');
  assert.ok(lines.some((line) => line.startsWith('student plans a schedule using Registration') || line.startsWith('Student plans a schedule using Registration')),
    `a relationship to the Registration boundary is described in ${JSON.stringify(lines)}`);
});

// ---- the view direction ------------------------------------------------------------------------

test('every view model carries its direction, down unless a custom view says otherwise', () => {
  const withViews = load(REFERENCE + 'views:\n  sideways:\n    view: interfaces of api\n    direction: right\n'
    + '  wide:\n    view: containers of registration\n    direction: right\n');
  ['containers of registration', 'interfaces of api', 'interface enrollment-api', 'dynamic enroll', 'components of api', 'containers of nowhere']
    .forEach((selector) => assert.equal(p.projectView(withViews, selector).direction, 'down', selector));
  assert.equal(p.projectView(withViews, 'sideways').direction, 'right');
  assert.equal(p.projectView(withViews, 'wide').direction, 'right');
});

// ---- component text ----------------------------------------------------------------------------

test('component text matches the spec', () => {
  const { type, text, ids } = toUml(p.projectView(model, 'interfaces of api'));
  assert.equal(type, 'component');
  assert.equal(text, [
    '@startuml',
    'layout vertical',
    'component "Planner Web App" as e1 <<Container: TypeScript, React>> {',
    '  require "Enrollment API" as r1',
    '}',
    'component "Registration API" as e2 <<Container: Python, FastAPI>> {',
    '  provide "Enrollment API" as p1',
    '  require "Tuition Charges" as r2',
    '}',
    'component "Billing System" as e3 <<Software System, external>> {',
    '  provide "Tuition Charges" as p2',
    '}',
    'p1 --> r1 : POST /v1/enrollments',
    'p2 --> r2 : send ChargeRequested to the queue billing.charges',
    '@enduml',
  ].join('\n'));
  assert.deepEqual(ids, { e1: 'web', e2: 'api', e3: 'billing', p1: 'enrollment-api', r1: 'enrollment-api', r2: 'tuition-charges', p2: 'tuition-charges' });
});

test('each consumer gets its own ball', () => {
  const mobile = '      mobile:\n        name: Mobile App\n        kind: mobile_app\n        technology: Swift\n'
    + '        description: Enrolls students from a phone.\n        collaborators:\n'
    + '          api: {description: submits plans to, technology: JSON/HTTPS, uses: enrollment-api.submit-plan}\n';
  const withMobile = load(replaced(REFERENCE, '      api:\n        name: Registration API\n', `${mobile}      api:\n        name: Registration API\n`));
  const { text } = toUml(p.projectView(withMobile, 'interfaces of api'));
  const lines = text.split('\n');
  assert.equal(lines.filter((line) => line.startsWith('  provide "Enrollment API" as p')).length, 2);
  const assemblies = lines.filter((line) => /^p\d+ --> r\d+ : POST \/v1\/enrollments$/.test(line));
  assert.equal(assemblies.length, 2);
  assert.equal(new Set(assemblies.map((line) => line.split(' ')[0])).size, 2, 'each assembly starts at a different provide port');
});

test('offered-through and delegated marks stay out of port names', () => {
  const { text } = toUml(p.projectView(endpoint, 'interfaces of api'));
  const lines = text.split('\n');
  assert.ok(lines.includes('  provide "Enrollment endpoint" as p1'));
  assert.ok(!lines.some((line) => line.includes('offered through')));
});

test('generated component text cannot inject statements', () => {
  const hostile = load(SHOP
    .replace('name: Shop App', 'name: "<script>"')
    .replace('name: Payment Provider', 'name: "Seat {Gateway}"')
    .replace('technology: Python, Flask', 'technology: "a >> b <<c"')
    .replace('name: Card Payments API', 'name: "Evil\\" } --> x\\n@enduml"')
    .replace('syntax: POST /v3/charges', 'syntax: "a --> b }"'));
  const { text } = toUml(p.projectView(hostile, 'interfaces of payments'));
  const lines = text.split('\n');
  assert.equal(lines.filter((line) => line === '@startuml').length, 1);
  assert.equal(lines.filter((line) => line === '@enduml').length, 1);
  const components = lines.filter((line) => line.startsWith('component '));
  assert.equal(components.length, 2);
  components.forEach((line) => assert.match(line, /^component "[^"{}\n]*" as e\d+ <<[^<>{}\n"]*>> \{$/));
  const ports = lines.filter((line) => /^\s+(provide|require) /.test(line));
  assert.ok(ports.length >= 2);
  ports.forEach((line) => assert.match(line, /^ {2}(provide|require) "[^"{}\n]*" as [pr]\d+$/));
  const connectors = lines.filter((line) => /^p\d+ /.test(line));
  assert.equal(connectors.length, 1);
  assert.match(connectors[0], /^[p]\d+ --> r\d+( : [^\n]*)?$/);
  assert.ok(connectors[0].endsWith(' : a --> b }'));
  assert.equal(lines.length, 1 + 1 + components.length + ports.length + components.length + connectors.length + 1,
    'every line is the header, a direction, a component, a port, a closing brace, a connector, or the footer');
});

test('REST path templates keep their braces in connector labels', () => {
  const reading = load(replaced(SHOP, '    description: Charges credit and debit cards for online shops.\n',
    '    description: Charges credit and debit cards for online shops.\n    collaborators:\n'
    + '      app: {description: looks up readers in, uses: app.get-readers-id}\n'));
  const { text } = toUml(p.projectView(reading, 'interfaces of app'));
  assert.ok(text.split('\n').some((line) => /^p\d+ --> r\d+ : GET \/readers\/\{id\}$/.test(line)), text);
});

test('the direction is always emitted', () => {
  assert.equal(toUml(p.projectView(model, 'interfaces of api')).text.split('\n')[1], 'layout vertical');
  const sideways = load(REFERENCE + 'views:\n  sideways:\n    view: interfaces of api\n    direction: right\n');
  assert.equal(toUml(p.projectView(sideways, 'sideways')).text.split('\n')[1], 'layout horizontal');
});
