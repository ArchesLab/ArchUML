'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const y = require('../../c4/c4-yaml.js');
const modelApi = require('../../c4/c4-model.js');
const { loadCore, fixture, rulesOf } = require('./helpers.js');

/** Normalizes YAML text the way an embed does. */
function load(text) {
  return modelApi.normalize(y.parse(text));
}

function shop() {
  return load(fixture('interfaces-shop.yml'));
}

/** The only diagnostic of a result; fails when there are none or several. */
function onlyDiagnostic({ diagnostics }) {
  assert.equal(diagnostics.length, 1, JSON.stringify(diagnostics, null, 2));
  return diagnostics[0];
}

/** A model with one container `api` whose `provides` holds the given YAML lines (indented under `provides:`). */
function providing(lines) {
  return [
    'systems:',
    '  s:',
    '    containers:',
    '      api:',
    '        provides:',
    ...lines.map((line) => '          ' + line),
  ].join('\n');
}

function operation(m, interfaceId, operationId) {
  return m.interfaces.get(interfaceId).operations.find((candidate) => candidate.id === operationId);
}

function field(fields, name) {
  return fields.find((candidate) => candidate.name === name);
}

/** The 1-based line a diagnostic's range starts on. */
function lineOf(diagnostic) {
  return diagnostic.range.start.line;
}

/** The 1-based line of the first line of `text` that contains `needle`. */
function lineContaining(text, needle) {
  return text.split('\n').findIndex((line) => line.includes(needle)) + 1;
}

// The revised §4.2 Enrollment API (spec §4.2) with the model's shared vocabulary.
const ENROLLMENT_API = [
  'vocabulary:',
  '  quarter unit: the UCLA credit unit; most courses are worth 4 quarter units',
  'systems:',
  '  registration:',
  '    containers:',
  '      api:',
  '        name: Registration API',
  '        provides:',
  '          enrollment-api:',
  '            name: Enrollment API',
  '            style: rest',
  '            technology: JSON/HTTPS',
  '            version: 1',
  '            restrictions:',
  '              - Only the Planner Web App may call it, acting for the signed-in student named in the request.',
  '              - A student may send at most 10 requests per minute.',
  '            errors:',
  '              unauthorized:',
  '                code: 401',
  '                when: the caller is not signed in as the student named in the request; the client asks the student to sign in again',
  '              too-many-requests:',
  '                code: 429',
  '                when: the student sent more than 10 requests in one minute; the client waits for the Retry-After time and tries again',
  '            operations:',
  '              submit-plan:',
  '                syntax: POST /v1/enrollments',
  '                input: EnrollmentRequest',
  '                output: EnrollmentOutcome',
  '                examples:',
  '                  - input: {student_id: "905123456", term: 2027-winter, section_ids: ["187204", "187310"]}',
  '                    output: {status: enrolled, units_enrolled: 8, decided_at: "2027-01-05T09:30:00-08:00"}',
  '                    note: Two 4-unit sections that do not clash.',
  '            types:',
  '              EnrollmentRequest:',
  '                description: One student\'s plan for one term.',
  '                fields:',
  '                  section_ids:',
  '                    type: string[]',
  '                    meaning: the sections the student wants to take together',
  '                    format: six-digit section ids',
  '                    constraints: 1 to 8 items, no duplicates',
  '              EnrollmentOutcome:',
  '                description: The decision for the whole plan.',
  '                fields:',
  '                  status:',
  '                    type: string',
  '                    meaning: whether the plan was accepted',
  '                    values:',
  '                      enrolled: the student now holds a seat in every section of the plan',
  '                      refused: the student holds no new seat; reason says why',
  '                  reason:',
  '                    type: string',
  '                    meaning: the reason for a refusal in words a student understands',
  '                    required: false',
].join('\n');

test('a shorthand provides list becomes one interface named after its element', () => {
  const { model: m, diagnostics } = shop();
  assert.deepEqual(diagnostics, []);
  const app = m.interfaces.get('app');
  assert.equal(app.providerId, 'app');
  assert.equal(app.shorthand, true);
  assert.equal(app.name, 'Shop App interface');
  assert.equal(app.style, null);
  assert.deepEqual(app.operations.map((o) => o.id), ['get-readers-id', 'post-orders']);
  assert.deepEqual(app.operations.map((o) => o.syntax), ['GET /readers/{id}', 'POST /orders']);
  assert.deepEqual(m.elements.get('app').provides, ['GET /readers/{id}', 'POST /orders']);
  assert.deepEqual(m.elements.get('app').interfaceIds, ['app']);
});

test('a code element keeps its provides strings and declares no interface', () => {
  const ruleLine = '                operations: ["+ evaluate(student, section): RuleResult"]\n                choices: {patterns: [{pattern: Strategy, role: Strategy,';
  const reference = fixture('course-registration.yml');
  assert.ok(reference.includes(ruleLine));
  const withStrings = reference.replace(ruleLine,
    '                provides: ["+ evaluate(student, section): RuleResult"]\n' + ruleLine);
  const { model: m, diagnostics } = load(withStrings);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual([...m.interfaces.keys()], ['coordinator'], 'the coordinator\'s shorthand list is the only interface');
  assert.deepEqual(m.elements.get('EnrollmentRule').provides, ['+ evaluate(student, section): RuleResult']);
  assert.deepEqual(m.elements.get('EnrollmentRule').interfaceIds, []);

  const withMap = reference.replace(ruleLine,
    '                provides:\n                  rules:\n                    operations: {evaluate: evaluate(student)}\n' + ruleLine);
  const misplaced = onlyDiagnostic(load(withMap));
  assert.equal(misplaced.rule, 'schema/misplaced-field');
  assert.match(misplaced.message, /`operations`/);
  assert.equal(misplaced.element, 'EnrollmentRule');
  assert.deepEqual(misplaced.path.slice(-2), ['EnrollmentRule', 'provides']);
});

test('the full form keeps the syntactic and semantic views', () => {
  const { model: m } = shop();
  const cards = m.interfaces.get('card-payments');
  assert.equal(cards.providerId, 'payments');
  assert.equal(cards.shorthand, false);
  assert.equal(cards.name, 'Card Payments API');
  assert.equal(cards.style, 'rest');
  assert.equal(cards.technology, 'JSON/HTTPS');
  assert.equal(cards.version, '3');
  const charge = operation(m, 'card-payments', 'charge');
  assert.equal(charge.interfaceId, 'card-payments');
  assert.equal(charge.syntax, 'POST /v3/charges');
  assert.deepEqual(charge.input.fields.map((f) => f.name), ['amount', 'card_token', 'idempotency_key']);
  assert.equal(field(charge.input.fields, 'amount').unit, 'US cents');
  assert.equal(charge.output.typeText, 'Charge');
  assert.equal(charge.output.type.name, 'Charge');
  assert.equal(charge.purpose, 'When a shop sends an amount and a card token, the provider charges the card once and reports whether the money moved.');
  assert.deepEqual(charge.errors.map((e) => [e.name, e.code]), [['card-declined', '402'], ['invalid-amount', '400']]);
  assert.equal(charge.sideEffects.length, 1);
  assert.deepEqual(charge.restrictions, ['Callers authenticate with the shop\'s secret key.']);
  assert.equal(charge.examples[0].note, 'A 12.50 USD charge that succeeds.');
  assert.equal(charge.examples[0].inputText, '{amount: 1250, card_token: tok_visa, idempotency_key: order-77}');
  assert.deepEqual(charge.examples[0].output, { id: 'ch_1', status: 'succeeded' });
  assert.deepEqual(cards.vocabulary.map(({ term, meaning }) => ({ term, meaning })),
    [{ term: 'idempotency key', meaning: 'a client-chosen string that makes a repeated request take effect only once' }]);
  assert.deepEqual(m.elements.get('payments').interfaceIds, ['card-payments']);
});

test('operation, field, error, and value shorthands expand', () => {
  const { model: m } = shop();
  const refund = operation(m, 'card-payments', 'refund');
  assert.equal(refund.syntax, 'POST /v3/refunds');
  assert.equal(refund.purpose, null);
  assert.deepEqual(refund.errors, []);
  const charge = m.interfaces.get('card-payments').types.get('Charge');
  assert.equal(charge.description, 'The result of one charge.');
  const id = field(charge.fields, 'id');
  assert.equal(id.typeText, 'string');
  assert.equal(id.meaning, null);
  assert.equal(id.required, true);
  const status = field(charge.fields, 'status');
  assert.deepEqual(status.values, [{ value: 'succeeded', meaning: null }, { value: 'failed', meaning: null }]);
  assert.equal(status.valuesForm, 'list');

  const { model: withStringError, diagnostics } = load(providing([
    'orders:',
    '  operations:',
    '    cancel:',
    '      syntax: DELETE /orders/{id}',
    '      errors:',
    '        not-found: no order has this id; the client shows the order list again',
  ]));
  assert.deepEqual(diagnostics, []);
  const [notFound] = operation(withStringError, 'orders', 'cancel').errors;
  assert.equal(notFound.when, 'no order has this id; the client shows the order list again');
  assert.equal(notFound.code, null);
});

test('values maps, constraints, interface-level restrictions and errors, and the shared vocabulary are read', () => {
  const { model: m, diagnostics } = load(ENROLLMENT_API);
  assert.deepEqual(diagnostics, []);
  const api = m.interfaces.get('enrollment-api');
  const status = field(api.types.get('EnrollmentOutcome').fields, 'status');
  assert.deepEqual(status.values, [
    { value: 'enrolled', meaning: 'the student now holds a seat in every section of the plan' },
    { value: 'refused', meaning: 'the student holds no new seat; reason says why' },
  ]);
  assert.equal(status.valuesForm, 'map');
  assert.deepEqual(field(api.types.get('EnrollmentRequest').fields, 'section_ids').constraints, ['1 to 8 items, no duplicates']);
  assert.equal(api.restrictions.length, 2);
  assert.deepEqual(api.errors.map((e) => e.name), ['unauthorized', 'too-many-requests']);
  assert.deepEqual(m.vocabulary.map((v) => v.term), ['quarter unit']);
  assert.deepEqual(m.vocabulary[0].path, ['vocabulary', 'quarter unit']);
});

test('a document format has types and no operations', () => {
  const { model: m, diagnostics } = load(providing([
    'transcript:',
    '  name: Transcript',
    '  style: file',
    '  description: The courses a student completed, sent to another university.',
    '  types:',
    '    Transcript:',
    '      fields:',
    '        student_id: string',
    '        courses: string[]',
  ]));
  assert.deepEqual(diagnostics, []);
  const transcript = m.interfaces.get('transcript');
  assert.equal(transcript.documentFormat, true);
  assert.deepEqual(transcript.operations, []);
  assert.deepEqual([...transcript.types.keys()], ['Transcript']);
});

test('the provides list of a full-form element flattens to syntax lines', () => {
  const { model: m } = shop();
  assert.deepEqual(m.elements.get('payments').provides, ['POST /v3/charges', 'POST /v3/refunds']);
});

test('failsafe typing keeps version, codes, and example values verbatim', () => {
  const text = providing([
    'ledger:',
    '  version: 1.10',
    '  errors:',
    '    unauthorized: {code: 401, when: the caller is not signed in}',
    '  operations:',
    '    check:',
    '      syntax: GET /checks',
    '      output:',
    '        ok: {type: boolean, required: false}',
    '      examples:',
    '        - output: {ok: no, mode: on}',
  ]);
  const { model: m, diagnostics } = load(text);
  assert.deepEqual(diagnostics, []);
  const ledger = m.interfaces.get('ledger');
  assert.equal(ledger.version, '1.10');
  assert.equal(ledger.errors[0].code, '401');
  const check = operation(m, 'ledger', 'check');
  assert.deepEqual(check.examples[0].output, { ok: 'no', mode: 'on' });
  assert.equal(check.examples[0].outputText, '{ok: no, mode: on}');
  assert.equal(field(check.output.fields, 'ok').required, false);

  const maybe = text.replace('required: false', 'required: maybe');
  const problem = onlyDiagnostic(load(maybe));
  assert.equal(problem.rule, 'schema/type');
  assert.equal(lineOf(problem), lineContaining(maybe, 'required: maybe'));
  assert.equal(problem.range.start.col, maybe.split('\n')[lineOf(problem) - 1].indexOf('maybe') + 1, 'the range is the value');
});

test('field names that equal typed keys stay field names', () => {
  const { model: m, diagnostics } = load(providing([
    'hosts:',
    '  operations:',
    '    register:',
    '      syntax: register(host)',
    '      input: {required: boolean, external: {type: boolean, meaning: x}, instances: integer}',
  ]));
  assert.deepEqual(diagnostics, []);
  const fields = operation(m, 'hosts', 'register').input.fields;
  assert.deepEqual(fields.map((f) => [f.name, f.typeText]), [['required', 'boolean'], ['external', 'boolean'], ['instances', 'integer']]);
});

test('examples keep the spelling of their source', () => {
  const { model: m } = load(ENROLLMENT_API);
  const [example] = operation(m, 'enrollment-api', 'submit-plan').examples;
  assert.equal(example.outputText, '{status: enrolled, units_enrolled: 8, decided_at: "2027-01-05T09:30:00-08:00"}');
  assert.equal(example.inputText, '{student_id: "905123456", term: 2027-winter, section_ids: ["187204", "187310"]}');

  const { model: block, diagnostics } = load(providing([
    'enrollment:',
    '  operations:',
    '    enroll:',
    '      syntax: POST /enrollments',
    '      examples:',
    '        - input:',
    '            student_id: "905123456"   # quoted, so it stays text',
    '            term: \'2027-winter\'',
    '            section_ids:',
    '              - "187204"',
    '              - 187310',
    '            plan: {draft: yes,',
    '              terms: 1}',
    '          note: written as a block map',
  ]));
  assert.deepEqual(diagnostics, []);
  assert.equal(operation(block, 'enrollment', 'enroll').examples[0].inputText,
    '{student_id: "905123456", term: \'2027-winter\', section_ids: ["187204", 187310], plan: {draft: yes, terms: 1}}');
});

test('mixing strings and maps in provides is a type error', () => {
  const { model: m, diagnostics } = load(providing(['- GET /orders', '- orders: {name: Orders}']));
  assert.deepEqual(rulesOf(diagnostics), ['schema/type']);
  assert.equal(m.interfaces.size, 0);
});

test('an empty provides list or map declares no interface', () => {
  for (const empty of ['[]', '{}']) {
    const { model: m, diagnostics } = load(`systems:\n  s:\n    provides: ${empty}\n`);
    assert.deepEqual(diagnostics, [], empty);
    assert.equal(m.interfaces.size, 0, empty);
    assert.deepEqual(m.elements.get('s').interfaceIds, [], empty);
    assert.deepEqual(m.elements.get('s').provides, [], empty);
  }
});

test('unknown keys in interfaces, operations, types, fields, errors, and examples are reported with suggestions', () => {
  const text = providing([
    'orders:',
    '  stlye: rest',
    '  x-notes: kept for the team',
    '  operations:',
    '    place:',
    '      syntax: POST /orders',
    '      purpos: places an order',
    '      errors:',
    '        out-of-stock:',
    '          wehn: no copy is left',
    '      examples:',
    '        - ouptut: {id: o-1}',
    '          note: an order placed for one reader',
    '  types:',
    '    Order:',
    '      feilds:',
    '        id: string',
    '    Line:',
    '      fields:',
    '        quantity:',
    '          type: integer',
    '          meanig: copies ordered',
    '          constriants: "> 0"',
  ]);
  const { diagnostics } = load(text);
  const expected = [['stlye', 'style'], ['purpos', 'purpose'], ['wehn', 'when'], ['ouptut', 'output'], ['feilds', 'fields'],
    ['meanig', 'meaning'], ['constriants', 'constraints']];
  assert.deepEqual(rulesOf(diagnostics), expected.map(() => 'schema/unknown-key'));
  expected.forEach(([written, meant], index) => {
    const found = diagnostics[index];
    assert.match(found.message, new RegExp('`' + written + '`'));
    assert.match(found.message, new RegExp('did you mean `' + meant + '`'));
    assert.equal(lineOf(found), lineContaining(text, written + ':'));
    assert.equal(found.element, 'api');
  });
});

test('a comma inside a flow-map value is explained', () => {
  const stray = load(providing([
    'outcomes:',
    '  types:',
    '    Outcome:',
    '      fields:',
    '        units: {type: number, unit: quarter units, meaning: total units, after this attempt}',
  ]));
  const found = onlyDiagnostic(stray);
  assert.equal(found.rule, 'schema/unknown-key');
  assert.match(found.message, /`after this attempt`/);
  assert.match(found.hint, /block map/);

  const misspelt = onlyDiagnostic(load(providing(['outcomes:', '  stlye: rest'])));
  assert.equal(misspelt.rule, 'schema/unknown-key');
  assert.equal(misspelt.hint, null);
});

test('style values are validated with suggestions', () => {
  const found = onlyDiagnostic(load(providing(['orders:', '  style: restful'])));
  assert.equal(found.rule, 'schema/value');
  assert.match(found.message, /\brest\b/);
});

test('provides on a person is a misplaced field', () => {
  const found = onlyDiagnostic(load('people:\n  student:\n    provides: ["GET /me"]\n'));
  assert.equal(found.rule, 'schema/misplaced-field');
  assert.equal(found.message, 'People do not provide interfaces; they may use one through `uses`');
  assert.equal(found.element, 'student');
});

test('interface ids share the element namespace', () => {
  const twice = [
    'systems:',
    '  s:',
    '    containers:',
    '      a:',
    '        provides:',
    '          orders: {operations: {list: GET /orders}}',
    '      b:',
    '        provides:',
    '          orders: {operations: {list: GET /orders}}',
  ].join('\n');
  const duplicate = onlyDiagnostic(load(twice));
  assert.equal(duplicate.rule, 'model/duplicate-id');
  assert.equal(lineOf(duplicate), 9);
  assert.equal(duplicate.element, 'b');

  const elementNamed = onlyDiagnostic(load([
    'systems:',
    '  shop:',
    '    provides:',
    '      billing: {operations: {charge: POST /charges}}',
    '  billing:',
    '    name: Billing System',
  ].join('\n')));
  assert.equal(elementNamed.rule, 'model/duplicate-id');
  assert.match(elementNamed.message, /`billing`/);
  assert.match(elementNamed.message, /software system/);
  assert.equal(lineOf(elementNamed), 4);

  const caseOnly = onlyDiagnostic(load(providing([
    'EnrollmentAPI: {operations: {enroll: POST /enrollments}}',
    'enrollmentapi: {operations: {enroll: POST /enrollments}}',
  ])));
  assert.equal(caseOnly.rule, 'model/duplicate-id');
  assert.equal(lineOf(caseOnly), 7);

  assert.deepEqual(shop().diagnostics, [], 'the shorthand interface app shares its own element\'s id');

  const ownFullForm = load(providing(['api: {name: API interface, operations: {list: GET /orders}}']));
  assert.deepEqual(ownFullForm.diagnostics, [], 'a full-form interface may share its own providing element\'s id');
  assert.equal(ownFullForm.model.interfaces.get('api').providerId, 'api');
});

test('custom interface views accept only their fields', () => {
  const core = loadCore();
  const base = 'systems:\n  s:\n    containers:\n      api:\n      db:\nscenarios:\n  enroll:\n    steps: []\n';
  const interfacesOf = core.load(base + 'views:\n  x:\n    view: interfaces of api\n    include: [db]\n');
  const include = onlyDiagnostic(interfacesOf);
  assert.equal(include.rule, 'schema/misplaced-field');
  assert.deepEqual(include.path, ['views', 'x', 'include']);
  assert.match(include.message, /`interfaces of api`/);

  const single = core.load(base + 'views:\n  x:\n    view: interface enrollment-api\n    direction: down\n');
  const direction = onlyDiagnostic(single);
  assert.equal(direction.rule, 'schema/misplaced-field');
  assert.deepEqual(direction.path, ['views', 'x', 'direction']);

  const annotated = core.load(base + 'views:\n  x:\n    view: dynamic enroll\n    annotations: [interfaces]\n');
  assert.deepEqual(annotated.diagnostics, []);
  assert.deepEqual(annotated.model.views.get('x').annotations, ['interfaces']);
});

test('layout keys normalize to the selector key', () => {
  const { model: m, diagnostics } = load([
    'systems:',
    '  registration:',
    '    containers:',
    '      api:',
    'layout:',
    '  Containers of registration with interfaces:',
    '    api: [10, 20]',
  ].join('\n'));
  assert.deepEqual(diagnostics, []);
  assert.deepEqual([...m.layout.keys()], ['containers of registration']);
  assert.deepEqual(m.layout.get('containers of registration').get('api'), [10, 20]);
});

test('interface, operation, type, field, and error names are validated', () => {
  const text = providing([
    '1api:',
    '  errors:',
    '    Bad Error: something failed',
    '  operations:',
    '    9x: GET /x',
    '  types:',
    '    Enrollment-Request:',
    '      fields:',
    '        2nd: string',
  ]);
  const { diagnostics } = load(text);
  assert.deepEqual(rulesOf(diagnostics), ['schema/id-format', 'schema/id-format', 'schema/id-format', 'schema/id-format', 'schema/id-format']);
  const keyLines = ['1api:', 'Bad Error:', '9x:', 'Enrollment-Request:', '2nd:'].map((key) => lineContaining(text, key));
  assert.deepEqual(diagnostics.map(lineOf), keyLines);
  diagnostics.forEach((found) => {
    const line = text.split('\n')[lineOf(found) - 1];
    assert.equal(found.range.start.col, line.search(/\S/) + 1, 'the range starts at the key');
  });
});

test('an example needs input, output, or note', () => {
  const found = onlyDiagnostic(load(providing([
    'orders:',
    '  operations:',
    '    list:',
    '      syntax: GET /orders',
    '      examples: [{}]',
  ])));
  assert.equal(found.rule, 'schema/value');
  assert.deepEqual(found.path.slice(-2), ['examples', 0]);
});
