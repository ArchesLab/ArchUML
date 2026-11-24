'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const y = require('../../c4/c4-yaml.js');
const modelApi = require('../../c4/c4-model.js');
const checks = require('../../c4/c4-checks.js');
const { fixture } = require('./helpers.js');

// The interface rules of the consistency checks (spec §7.2, category `interface`), the interface entries of the rule
// catalog, the interface-aware `c4/cross-container-technology`, and the configuration of incompleteness rules.

const REFERENCE = fixture('course-registration-interfaces.yml');
const SHOP = fixture('interfaces-shop.yml');
const EVENTS = fixture('interfaces-events.yml');
const ENDPOINT = fixture('interfaces-endpoint.yml');
const BOOKING = fixture('interfaces-l14-booking.yml');
const MILESTONE_1 = fixture('course-registration.yml');

const M1_WEB_TO_COORDINATOR = '          coordinator: {description: submits plans to, technology: JSON/HTTPS}';
const M1_WEB_TO_API_USING_COORDINATOR = '          api: {description: submits plans to, technology: JSON/HTTPS, uses: coordinator.evaluate}';
const M1_SWITCHED_ON = replaced(MILESTONE_1, M1_WEB_TO_COORDINATOR, M1_WEB_TO_API_USING_COORDINATOR);
const REFERENCE_WEB_TO_COORDINATOR = '          coordinator: {description: submits plans to, technology: JSON/HTTPS, uses: enrollment-api.submit-plan}';
const REFERENCE_REALIZES = '                realizes: [api-eligibility, api-holds, api-billing]';

/** Every message and hint the tests in this file produced, for the vocabulary test at the end. */
const producedTexts = [];

/** `text` with `from` replaced by `to`; fails when `from` is absent, so an edit cannot silently miss. */
function replaced(text, from, to) {
  assert.ok(text.includes(from), `the model text contains ${from}`);
  return text.replace(from, to);
}

/** Parses and normalizes YAML text, keeping the parse for diagnostic ranges. */
function load(text) {
  const parsed = y.parse(text);
  const { model, diagnostics } = modelApi.normalize(parsed);
  return { text, parsed, model, modelDiagnostics: diagnostics };
}

/** The semantic diagnostics of a model text. */
function checked(text) {
  const { parsed, model } = load(text);
  return checks.run(model, { parsed });
}

/**
 * The interface diagnostics of a model text. Texts that echo only the fixtures' own interface descriptions (not values
 * edited in by a test) are collected for the reference-vocabulary test; `echoesTest: true` leaves them out.
 */
function interfaceDiagnostics(text, { echoesTest = false } = {}) {
  const found = checked(text).filter((diagnostic) => diagnostic.category === 'interface');
  if (!echoesTest) found.forEach((diagnostic) => producedTexts.push(diagnostic.message, diagnostic.hint));
  return found;
}

function ofRule(text, ruleId, options) {
  return interfaceDiagnostics(text, options).filter((diagnostic) => diagnostic.rule === ruleId);
}

/** 1-based number of the first line of `text` that contains `needle`. */
function lineOf(text, needle) {
  const index = text.split('\n').findIndex((line) => line.includes(needle));
  assert.notEqual(index, -1, `${needle} is in the model text`);
  return index + 1;
}

/** What the Problems list shows of each diagnostic: rule, severity, element, and line. */
function seen(diagnostics) {
  return diagnostics.map((diagnostic) => ({
    rule: diagnostic.rule, severity: diagnostic.severity, element: diagnostic.element,
    line: diagnostic.range && diagnostic.range.start.line,
  }));
}

/** Asserts that `text` reports exactly one `ruleId` diagnostic, with the severity and element, on the needle's line. */
function expectOne(text, ruleId, { severity, element, needle }, options) {
  const found = ofRule(text, ruleId, options);
  assert.deepEqual(seen(found), [{ rule: ruleId, severity, element, line: lineOf(text, needle) }]);
  return found[0];
}

function expectNone(text, ruleId, options) {
  assert.deepEqual(seen(ofRule(text, ruleId, options)), []);
}

function indented(lines, spaces) {
  return lines.map((line) => ' '.repeat(spaces) + line);
}

// ---- A small library model outside the reference domain --------------------------------------

const BOOK_FIELDS = [
  'title:',
  '  type: string',
  '  meaning: the title printed on the cover',
  'copies:',
  '  type: integer',
  '  meaning: copies of the book the library owns',
  '  unit: copies',
];

const CATALOG_INTERFACE = [
  'name: Catalog Service',
  'description: Finds books in the catalog of the library.',
  'style: rest',
  'technology: JSON/HTTPS',
  'version: 2',
  'operations:',
  '  find-book:',
  '    syntax: GET /v2/books/{isbn}',
  '    input:',
  '      isbn:',
  '        type: string',
  '        meaning: the international standard book number printed on the book',
  '        format: 13 digits without hyphens',
  '    output: Book',
  '    purpose: When a client asks for a book by its number, the service returns what the catalog records about it.',
  '    errors:',
  '      not-found:',
  '        code: 404',
  '        when: no book has this number; the client tells the reader that the book is unknown',
  '    examples:',
  '      - input: {isbn: "9780134494166"}',
  '        output: {title: Clean Architecture, copies: "3"}',
  '    realizes: [api-find]',
  'types:',
  '  Book:',
  '    description: What the catalog records about one book.',
  '    fields:',
];

/** The library model: a web app that uses the Catalog Service of the catalog API, whose Book has `bookFields`. */
function library(bookFields = BOOK_FIELDS) {
  return [
    'schema: c4-design/1',
    'name: City Library',
    'people:',
    '  reader:',
    '    name: Reader',
    '    description: Borrows books from the library.',
    '    collaborators:',
    '      web: searches the catalog using',
    'systems:',
    '  library:',
    '    name: City Library',
    '    description: Lends books to the readers of one city.',
    '    containers:',
    '      web:',
    '        name: Library Web App',
    '        technology: TypeScript, React',
    '        description: Lets readers search the catalog in the browser.',
    '        collaborators:',
    '          api: {description: looks up books through, technology: JSON/HTTPS, uses: catalog-api.find-book}',
    '      api:',
    '        name: Catalog API',
    '        technology: Go',
    '        description: Answers questions about the books the library holds.',
    '        responsibilities:',
    '          - know: which books the library holds',
    '            id: api-find',
    '        provides:',
    '          catalog-api:',
    ...indented(CATALOG_INTERFACE, 12),
    ...indented(bookFields, 18),
    '',
  ].join('\n');
}

const LIBRARY = library();

/**
 * A library whose catalog API has two components: `search` calls `index`, which provides `book-index` (its YAML
 * keys given as `interfaceLines`), so every use of the interface stays inside one container.
 */
function libraryComponents(interfaceLines) {
  return [
    'schema: c4-design/1',
    'name: City Library',
    'systems:',
    '  library:',
    '    name: City Library',
    '    description: Lends books to the readers of one city.',
    '    containers:',
    '      api:',
    '        name: Catalog API',
    '        technology: Go',
    '        description: Answers questions about the books the library holds.',
    '        components:',
    '          search:',
    '            name: Search Handler',
    '            technology: Go package',
    '            description: Answers catalog searches.',
    '            collaborators:',
    '              index: {description: looks up matching books in, uses: book-index}',
    '          index:',
    '            name: Book Index',
    '            technology: Go package',
    '            description: Keeps the searchable index of books.',
    '            provides:',
    '              book-index:',
    ...indented(interfaceLines, 16),
    '',
  ].join('\n');
}

// ---- Whole models ----------------------------------------------------------------------------

test('the interface reference model has no interface diagnostics', () => {
  const { parsed, model } = load(REFERENCE);
  const diagnostics = checks.applyConfig(checks.run(model, { parsed }), model, { parsed });
  assert.deepEqual(diagnostics.filter((diagnostic) => ['error', 'warning'].includes(diagnostic.severity)), []);
  assert.deepEqual(diagnostics.filter((diagnostic) => diagnostic.category === 'interface'), []);
});

test('the library model the rule cases start from has no interface diagnostics', () => {
  assert.deepEqual(load(LIBRARY).modelDiagnostics, []);
  assert.deepEqual(seen(interfaceDiagnostics(LIBRARY)), []);
});

test('the shop example reports exactly the interface diagnostics its comments name', () => {
  const found = interfaceDiagnostics(SHOP);
  assert.deepEqual(found.map((diagnostic) => `${diagnostic.rule} ${diagnostic.severity} ${diagnostic.element}`).sort(), [
    'interface/no-errors warning payments',
    'interface/no-meaning info payments',
    'interface/no-meaning info payments',
    'interface/no-purpose warning payments',
    'interface/unused info app',
    'interface/unused-operation info payments',
  ]);
  const about = (ruleId) => found.filter((diagnostic) => diagnostic.rule === ruleId)
    .map((diagnostic) => ({ interface: diagnostic.interface, operation: diagnostic.operation, field: diagnostic.field }));
  assert.deepEqual(about('interface/unused-operation'), [{ interface: 'card-payments', operation: 'refund', field: null }]);
  assert.deepEqual(about('interface/no-meaning'), [
    { interface: 'card-payments', operation: null, field: 'id' },
    { interface: 'card-payments', operation: null, field: 'status' },
  ]);
  assert.deepEqual(about('interface/unused'), [{ interface: 'app', operation: null, field: null }]);
});

test('the event fixture reports only the missing errors of an event, as info', () => {
  assert.deepEqual(interfaceDiagnostics(EVENTS).map(({ rule, severity, element }) => ({ rule, severity, element })),
    [{ rule: 'interface/no-errors', severity: 'info', element: 'orders' }]);
});

test("the lecture's createBooking loads with suggestions, not errors", () => {
  const all = checked(BOOKING);
  assert.deepEqual(all.filter((diagnostic) => diagnostic.severity === 'error'), []);
  const found = interfaceDiagnostics(BOOKING);
  assert.deepEqual(found.map((diagnostic) => `${diagnostic.rule} ${diagnostic.severity}`).sort(), [
    'interface/no-errors warning',
    'interface/no-format warning',
    'interface/no-meaning info',
    'interface/no-purpose warning',
    'interface/type-spelling info',
    'interface/type-spelling info',
    'interface/undefined-type warning',
    'interface/unused info',
  ]);
  const fieldOf = (ruleId) => found.filter((diagnostic) => diagnostic.rule === ruleId).map((diagnostic) => diagnostic.field);
  assert.deepEqual(fieldOf('interface/no-format'), ['date']);
  assert.deepEqual(fieldOf('interface/no-meaning'), ['paymentReference']);
  const spellings = found.filter((diagnostic) => diagnostic.rule === 'interface/type-spelling').map((diagnostic) => diagnostic.message);
  assert.equal(spellings.length, 2);
  assert.ok(spellings[0].startsWith('str is written string'), spellings[0]);
  assert.ok(spellings[1].startsWith('dateTime is written datetime'), spellings[1]);
  const undefinedType = found.find((diagnostic) => diagnostic.rule === 'interface/undefined-type');
  assert.match(undefinedType.message, /^PaymentMethod is used as a type but not described\./);
  assert.equal(undefinedType.hint, 'Add PaymentMethod under Types, or use a primitive such as string.');
});

// ---- Syntactic view --------------------------------------------------------------------------

test('interface/no-syntax: an operation needs a syntax line and an interface needs operations or types', () => {
  const noSyntax = replaced(LIBRARY, '              find-book:\n                syntax: GET /v2/books/{isbn}\n',
    '              find-book:\n');
  const operation = expectOne(noSyntax, 'interface/no-syntax', { severity: 'warning', element: 'api', needle: 'find-book:' });
  assert.equal(operation.message, 'find-book has no syntax line. A client cannot call an operation it cannot write down.');
  assert.equal(operation.operation, 'find-book');

  const emptyInterface = replaced(LIBRARY, '          catalog-api:\n',
    '          loans-api:\n            name: Loans Service\n            description: Lends books.\n          catalog-api:\n');
  const empty = expectOne(emptyInterface, 'interface/no-syntax', { severity: 'warning', element: 'api', needle: 'loans-api:' });
  assert.equal(empty.message, 'Loans Service has no operations and no types.');
  assert.equal(empty.hint, 'Add an operation a client can call, or the types of the document it exchanges.');

  const documentFormat = replaced(LIBRARY, '          catalog-api:\n', [
    '          loan-record:',
    '            name: Loan Record',
    '            description: The record of one loan that the library sends to the city archive.',
    '            types:',
    '              Loan: {description: One loan of one book.}',
    '          catalog-api:',
    '',
  ].join('\n'));
  expectNone(documentFormat, 'interface/no-syntax');
  expectNone(LIBRARY, 'interface/no-syntax');
});

test('interface/untyped-field: a field needs a type', () => {
  const text = library(['title: {meaning: the title printed on the cover}'].concat(BOOK_FIELDS.slice(3)));
  const found = expectOne(text, 'interface/untyped-field', { severity: 'warning', element: 'api', needle: 'title: {meaning' });
  assert.equal(found.message, 'Book.title has no Type. Without one, a client cannot tell a number from text.');
  assert.equal(found.field, 'title');
});

test('interface/undefined-type: a named type must be described, and prose is not a type', () => {
  const undescribed = replaced(LIBRARY, '                output: Book\n', '                output: Shelf\n');
  const shelf = expectOne(undescribed, 'interface/undefined-type', { severity: 'warning', element: 'api', needle: 'output: Shelf' });
  assert.equal(shelf.message, 'Shelf is used as a type but not described. A client needs its fields to build or read it.');
  assert.equal(shelf.hint, 'Add Shelf under Types, or use a primitive such as string.');

  const prose = library(BOOK_FIELDS.slice(0, 4).concat(['  type: a number'], BOOK_FIELDS.slice(5)));
  const number = expectOne(prose, 'interface/undefined-type', { severity: 'warning', element: 'api', needle: 'type: a number' });
  assert.equal(number.message, "'a number' is not a type.");
  assert.equal(number.hint, 'Use a primitive or a type of this interface; write a list as string[].');

  expectNone(replaced(LIBRARY, '                output: Book\n', '                output: Book[]\n'), 'interface/undefined-type');
});

test('interface/type-spelling: each spelling from another language is reported once per interface', () => {
  const text = library(BOOK_FIELDS.slice(0, 4).concat(['  type: int'], BOOK_FIELDS.slice(5), [
    'pages: {type: int, meaning: printed pages of the book, unit: pages}',
    'ratings: {type: List<int>, meaning: stars each reader gave the book, unit: stars}',
  ]));
  const found = ofRule(text, 'interface/type-spelling');
  assert.deepEqual(seen(found), [
    { rule: 'interface/type-spelling', severity: 'info', element: 'api', line: lineOf(text, 'type: int') },
    { rule: 'interface/type-spelling', severity: 'info', element: 'api', line: lineOf(text, 'List<int>') },
  ]);
  assert.equal(found[0].message, 'int is written integer in interface descriptions; both mean the same, and the editor writes the standard form.');
  assert.match(found[1].message, /^List<int> is written integer\[\] in interface descriptions/);
});

// ---- Semantic view ---------------------------------------------------------------------------

test('interface/no-purpose: operations of full-form interfaces and document formats state their purpose', () => {
  const refund = expectOne(SHOP, 'interface/no-purpose', { severity: 'warning', element: 'payments', needle: 'refund: POST' });
  assert.equal(refund.message, 'refund has no Purpose. A client cannot tell whether the operation fits its need.');
  assert.equal(refund.hint, 'Say when a client calls it and what the provider then does.');
  assert.equal(refund.operation, 'refund');

  const documentFormat = replaced(LIBRARY, '          catalog-api:\n', [
    '          loan-record:',
    '            name: Loan Record',
    '            types:',
    '              Loan: {description: One loan of one book.}',
    '          catalog-api:',
    '',
  ].join('\n'));
  expectOne(documentFormat, 'interface/no-purpose', { severity: 'warning', element: 'api', needle: 'loan-record:' });
});

const WITHOUT_OPERATION_ERRORS = replaced(LIBRARY, [
  '                errors:',
  '                  not-found:',
  '                    code: 404',
  '                    when: no book has this number; the client tells the reader that the book is unknown',
  '',
].join('\n'), '');

test('interface/no-errors: request and command operations list errors; others are asked about them', () => {
  const refund = expectOne(SHOP, 'interface/no-errors', { severity: 'warning', element: 'payments', needle: 'refund: POST' });
  assert.equal(refund.message, 'refund lists no errors. A client built by another team must know what can go wrong and what to do then.');
  assert.equal(refund.hint, 'What happens when the caller is not allowed, sends something invalid, or calls too often?');

  expectOne(WITHOUT_OPERATION_ERRORS, 'interface/no-errors', { severity: 'warning', element: 'api', needle: 'find-book:' });
  expectOne(replaced(WITHOUT_OPERATION_ERRORS, '            style: rest\n', '            style: message\n'), 'interface/no-errors',
    { severity: 'warning', element: 'api', needle: 'find-book:' });
  expectOne(replaced(WITHOUT_OPERATION_ERRORS, '            style: rest\n', ''), 'interface/no-errors',
    { severity: 'info', element: 'api', needle: 'find-book:' });

  const event = expectOne(EVENTS, 'interface/no-errors', { severity: 'info', element: 'orders', needle: 'order-placed:' });
  assert.equal(event.hint, 'What can a subscriber not rely on: can it receive this twice, out of order, or not at all?');

  const libraryStyle = libraryComponents([
    'name: Book Index',
    'style: library',
    'operations:',
    '  find:',
    '    syntax: find(words) -> Book[]',
    '    purpose: When the search handler passes the words of a query, the index returns the matching books.',
  ]);
  expectOne(libraryStyle, 'interface/no-errors', { severity: 'info', element: 'index', needle: '  find:' });

  const interfaceErrors = replaced(WITHOUT_OPERATION_ERRORS, '            operations:\n', [
    '            errors:',
    '              unavailable:',
    '                code: 503',
    '                when: the catalog is being rebuilt; the client tries again after a minute',
    '            operations:',
    '',
  ].join('\n'));
  expectNone(interfaceErrors, 'interface/no-errors');
});

test('interface/no-unit: a number states its unit unless it is an identifier or an enumerated code', () => {
  const numbers = library([
    'weight: {type: number, meaning: shipping weight of the book}',
    'pages: {type: integer, meaning: printed pages}',
    'fine: {type: decimal, meaning: late fee in cents per day}',
  ]);
  const found = ofRule(numbers, 'interface/no-unit');
  assert.deepEqual(seen(found), ['weight:', 'pages:', 'fine:'].map((needle) => (
    { rule: 'interface/no-unit', severity: 'warning', element: 'api', line: lineOf(numbers, needle) })));
  assert.equal(found[0].message, 'Book.weight is a number with no Unit. Two teams can read the same number differently.');
  assert.equal(found[0].hint, 'Set Unit to what a value of 1 means (seconds, cents, kilograms, items).');
  assert.equal(found[2].hint, 'The meaning mentions a unit; put it in Unit so clients and checks can find it.');

  const exempt = library([
    'pages: {type: integer, meaning: printed pages, unit: items}',
    'condition:',
    '  type: integer',
    '  meaning: how worn the copy is',
    '  values: {"1": like new, "2": worn, "3": damaged}',
    'id: integer',
    'shelf_id: integer',
    'shelf_ids: integer[]',
    'shelfId: integer',
    'title: string',
  ]);
  expectNone(exempt, 'interface/no-unit');

  const valueList = library(['condition: {type: integer, meaning: how worn the copy is, values: ["1", "2", "3"]}']);
  expectOne(valueList, 'interface/no-unit', { severity: 'warning', element: 'api', needle: 'condition:' });

  const price = expectOne(library(['price: string']), 'interface/no-unit', { severity: 'info', element: 'api', needle: 'price:' });
  assert.equal(price.message, 'Book.price is text, but its name suggests a quantity. If it carries an amount, state its unit ' +
    'and what it includes (tax, fees), or make it a number with a Unit.');
});

test('interface/no-format: a date or time states its format', () => {
  const temporal = library(['due: {type: date, meaning: the day the loan ends}', 'returned: {type: datetime, meaning: the moment the book came back}',
    'opens: {type: time, meaning: when the branch opens}', 'loan: {type: duration, meaning: how long a loan lasts}']);
  const found = ofRule(temporal, 'interface/no-format');
  assert.deepEqual(seen(found), ['due:', 'returned:', 'opens:', 'loan:'].map((needle) => (
    { rule: 'interface/no-format', severity: 'warning', element: 'api', line: lineOf(temporal, needle) })));
  assert.equal(found[0].message, 'Book.due is a date or time with no Format. Which comes first, day or month, and in which time zone?');
  assert.equal(found[0].hint, 'State the order of the parts and the time zone, for example YYYY-MM-DD in local time of the venue.');

  const withoutFormat = replaced(REFERENCE, [
    '                    meaning: the moment the API decided the outcome',
    '                    format: ISO 8601 with a UTC offset',
  ].join('\n'), '                    meaning: the moment the API decided the outcome');
  expectOne(withoutFormat, 'interface/no-format', { severity: 'warning', element: 'api', needle: '                  decided_at:' }, { echoesTest: true });

  const names = library(['starts_on: string', 'created_at: string', 'birthday: string', 'seat: string', 'timeout: string']);
  const named = ofRule(names, 'interface/no-format');
  assert.deepEqual(seen(named), ['starts_on:', 'created_at:', 'birthday:'].map((needle) => (
    { rule: 'interface/no-format', severity: 'info', element: 'api', line: lineOf(names, needle) })));
  assert.equal(named[0].message, 'Book.starts_on is text, but its name suggests a date or time. State its Format.');
});

test('interface/example-mismatch: examples follow the declared types', () => {
  const example = '                    output: {status: enrolled, units_enrolled: 8, decided_at: "2027-01-05T09:30:00-08:00"}';
  const withOutput = (output) => replaced(REFERENCE, example, `                    output: ${output}`);
  const mismatch = (output) => ofRule(withOutput(output), 'interface/example-mismatch', { echoesTest: true });

  const renamed = withOutput('{status: enrolled, units: 8, decided_at: "2027-01-05T09:30:00-08:00"}');
  const [wrongKey] = ofRule(renamed, 'interface/example-mismatch', { echoesTest: true });
  assert.deepEqual(seen([wrongKey]), [{ rule: 'interface/example-mismatch', severity: 'warning', element: 'api',
    line: lineOf(renamed, '- input: {student_id') }]);
  assert.match(wrongKey.message, /^Example 1 of submit-plan does not match its types: .*\bunits is not a field of EnrollmentOutcome/);
  assert.match(wrongKey.message, /An example that contradicts the syntax misleads every client that copies it\.$/);

  assert.match(mismatch('{status: enrolled, units_enrolled: 8}')[0].message, /the required field decided_at is missing/);
  assert.match(mismatch('{status: accepted, units_enrolled: 8, decided_at: "2027-01-05T09:30:00-08:00"}')[0].message,
    /status: accepted is not one of its values/);
  assert.match(mismatch('{status: enrolled, units_enrolled: eight, decided_at: "2027-01-05T09:30:00-08:00"}')[0].message,
    /units_enrolled: eight is not a number/);
  expectNone(REFERENCE, 'interface/example-mismatch');

  const event = replaced(EVENTS, 'total: 2599', 'total: lots');
  const [found] = ofRule(event, 'interface/example-mismatch', { echoesTest: true });
  assert.match(found.message, /^Example 1 of order-placed does not match its types: total: lots is not a number/);
});

// ---- Responsibilities and boundaries ---------------------------------------------------------

test('interface/realizes-internal: an operation realizes what its provider promises', () => {
  const withIds = replaced(replaced(REFERENCE, '              - do: sequence one enrollment attempt',
    '              - do: sequence one enrollment attempt\n                id: coordinator-do-1'),
  '                refines: api-eligibility\n            code:', '                refines: api-eligibility\n                id: policy-decide-1\n            code:');
  const internal = replaced(withIds, REFERENCE_REALIZES, '                realizes: [api-eligibility, api-holds, coordinator-do-1]');
  const found = expectOne(internal, 'interface/realizes-internal',
    { severity: 'warning', element: 'api', needle: 'realizes: [api-eligibility, api-holds, coordinator-do-1]' }, { echoesTest: true });
  assert.equal(found.message, "submit-plan is linked to 'sequence one enrollment attempt', an obligation private to Registration " +
    'Coordinator. Clients rely on what Registration API promises, not on how its parts divide the work.');
  assert.equal(found.hint, 'Link the operation to the responsibility of Registration API that this one helps realize, or remove the link.');

  const refining = replaced(withIds, REFERENCE_REALIZES, '                realizes: [policy-decide-1, api-holds]');
  expectNone(refining, 'interface/realizes-internal', { echoesTest: true });
});

test('interface/in-process-across-boundary: an in-process interface is reachable only inside its container', () => {
  const found = expectOne(M1_SWITCHED_ON, 'interface/in-process-across-boundary',
    { severity: 'warning', element: 'web', needle: 'uses: coordinator.evaluate' });
  assert.equal(found.message, 'Registration Coordinator interface is an in-process interface of Registration Coordinator, and ' +
    'Planner Web App runs in another container. A component is not separately deployable: a client elsewhere reaches it ' +
    'through an interface offered over the network.');
  assert.equal(found.hint, 'Use the interface of the container the request enters, or set the remote style the component exposes.');

  expectNone(ENDPOINT, 'interface/in-process-across-boundary');

  const library = replaced(replaced(REFERENCE, '            stereotypes: [service_provider]\n', [
    '            stereotypes: [service_provider]',
    '            provides:',
    '              eligibility-checks:',
    '                style: library',
    '                operations:',
    '                  decide: decide(student, section) -> Decision',
    '',
  ].join('\n')), '              policy: asks for an eligibility decision from',
  '              policy: {description: asks for an eligibility decision from, uses: eligibility-checks.decide}');
  expectNone(library, 'interface/in-process-across-boundary', { echoesTest: true });
});

test('interface/requested-not-advertised: the used operation advertises the requested responsibility', () => {
  const requesting = (responsibility, realizes) => replaced(replaced(REFERENCE, REFERENCE_WEB_TO_COORDINATOR,
    `          coordinator: {description: submits plans to, technology: JSON/HTTPS, responsibility: ${responsibility}, ` +
    'uses: enrollment-api.submit-plan}'), REFERENCE_REALIZES, `                realizes: ${realizes}`);

  const text = requesting('api-holds', '[api-eligibility]');
  const found = expectOne(text, 'interface/requested-not-advertised',
    { severity: 'warning', element: 'web', needle: 'responsibility: api-holds' }, { echoesTest: true });
  assert.equal(found.message, "This relationship asks Registration Coordinator for 'hold a seat in every section of a plan, or in " +
    "none', but the operation it uses is linked to other responsibilities. Does the client call the right operation, or is " +
    "the operation's link incomplete?");

  expectNone(requesting('api-holds', '[api-eligibility, api-holds, api-billing]'), 'interface/requested-not-advertised', { echoesTest: true });
  const refinement = replaced(requesting('policy-decide-1', '[api-eligibility]'),
    '                refines: api-eligibility\n            code:', '                refines: api-eligibility\n                id: policy-decide-1\n            code:');
  expectNone(refinement, 'interface/requested-not-advertised', { echoesTest: true });
});

test('interface/syntax-only: a shorthand interface used across a boundary is asked to describe itself fully', () => {
  const found = expectOne(M1_SWITCHED_ON, 'interface/syntax-only',
    { severity: 'info', element: 'coordinator', needle: 'provides: ["evaluate' });
  assert.equal(found.message, 'Registration Coordinator interface lists only call syntax, and Planner Web App uses it across a ' +
    'container boundary. An independently built client also needs the purpose, the errors, and what the data means.');
  assert.equal(found.hint, 'Describe it fully.');

  const siblings = replaced(MILESTONE_1, '              db: {description: writes seat holds to, technology: SQL/TCP}', [
    '              db: {description: writes seat holds to, technology: SQL/TCP}',
    '              coordinator: {description: reports held seats to, uses: coordinator.evaluate}',
  ].join('\n'));
  expectNone(siblings, 'interface/syntax-only');
});

test('interface/no-meaning: fields and their values say what they mean', () => {
  const found = ofRule(SHOP, 'interface/no-meaning');
  assert.deepEqual(seen(found), [
    { rule: 'interface/no-meaning', severity: 'info', element: 'payments', line: lineOf(SHOP, 'id: string') },
    { rule: 'interface/no-meaning', severity: 'info', element: 'payments', line: lineOf(SHOP, 'status: {type: string') },
  ]);
  assert.equal(found[0].message, 'Charge.id has no Meaning. A team that never spoke to you will guess.');
  assert.equal(found[0].hint, 'What does this field identify or measure, and for whom?');
  assert.equal(found[1].message, 'Some values of Charge.status have no meaning.');
  assert.equal(found[1].hint, 'What does each value tell the client?');

  const inside = libraryComponents([
    'name: Book Index',
    'style: library',
    'operations:',
    '  find:',
    '    syntax: find(words) -> Hit[]',
    '    purpose: When the search handler passes the words of a query, the index returns the matching books.',
    'types:',
    '  Hit:',
    '    description: One matching book.',
    '    fields:',
    '      match: {type: string, meaning: how the book matched the words, values: [title, author]}',
  ]);
  expectNone(inside, 'interface/no-meaning');
});

test('interface/no-example: an operation used across a boundary shows an example', () => {
  const withoutExamples = replaced(LIBRARY, [
    '                examples:',
    '                  - input: {isbn: "9780134494166"}',
    '                    output: {title: Clean Architecture, copies: "3"}',
    '',
  ].join('\n'), '');
  const found = expectOne(withoutExamples, 'interface/no-example', { severity: 'info', element: 'api', needle: 'find-book:' });
  assert.equal(found.message, 'find-book has no example. One request with its response shows a client more than a page of rules.');

  const unusedOperation = replaced(LIBRARY, '            types:\n', [
    '              list-books:',
    '                syntax: GET /v2/books',
    '                purpose: When a client asks for every book, the service returns the whole catalog.',
    '                realizes: [api-find]',
    '            types:',
    '',
  ].join('\n'));
  expectNone(unusedOperation, 'interface/no-example');
});

test('interface/unrealized: an operation of an internal element is linked to a responsibility', () => {
  const unlinked = replaced(LIBRARY, '                realizes: [api-find]\n', '');
  const found = expectOne(unlinked, 'interface/unrealized', { severity: 'info', element: 'api', needle: 'find-book:' });
  assert.equal(found.message, 'find-book is not linked to a responsibility of Catalog API. Which obligation does a client reach through it?');

  expectNone(SHOP, 'interface/unrealized');
  const withoutResponsibilities = replaced(unlinked, '        responsibilities:\n          - know: which books the library holds\n            id: api-find\n', '');
  expectNone(withoutResponsibilities, 'interface/unrealized');
});

test('interface/leaks-implementation: names do not reveal storage or runtime internals', () => {
  const leaking = replaced(library(['row_id: {type: string, meaning: the number the catalog gives the book}']),
    '                syntax: GET /v2/books/{isbn}', '                syntax: SELECT books {isbn}');
  const withTable = replaced(leaking, '              Book:\n', [
    '              ShelfTable:',
    '                description: Where the books stand.',
    '              Book:',
    '',
  ].join('\n'));
  const found = ofRule(withTable, 'interface/leaks-implementation');
  assert.deepEqual(seen(found).map(({ severity, element, line }) => ({ severity, element, line })).sort((a, b) => a.line - b.line),
    ['SELECT books', 'ShelfTable:', 'row_id:'].map((needle) => ({ severity: 'info', element: 'api', line: lineOf(withTable, needle) })));
  const rowId = found.find((diagnostic) => diagnostic.field === 'row_id');
  assert.equal(rowId.message, "Does 'row_id' tell clients how Catalog API stores or computes data? Names of tables, keys, and " +
    'locks tie clients to the implementation.');

  expectNone(library(['class_section: string', 'request_id: string', 'next_cursor: string']), 'interface/leaks-implementation',
    { echoesTest: true });
});

test('interface/conflicting-vocabulary: a term means one thing everywhere', () => {
  const vocabulary = '              plan: the sections a student wants to take together in one term';
  const redefined = replaced(REFERENCE, vocabulary, `${vocabulary}\n              quarter unit: a unit worth one fifth of a course`);
  const shared = expectOne(redefined, 'interface/conflicting-vocabulary',
    { severity: 'info', element: 'api', needle: 'quarter unit: a unit worth' }, { echoesTest: true });
  assert.equal(shared.message, "'quarter unit' means different things in Enrollment API and the shared vocabulary. Two systems " +
    'that read one word differently do not interoperate.');
  assert.equal(shared.hint, 'Agree on one meaning in the shared vocabulary, or use two terms.');

  const sameMeaning = replaced(REFERENCE, vocabulary,
    `${vocabulary}\n              " Quarter  unit ": The UCLA credit unit;  most courses are worth 4 quarter units`);
  expectNone(sameMeaning, 'interface/conflicting-vocabulary', { echoesTest: true });

  const twoInterfaces = replaced(REFERENCE, '                unit: US cents\n',
    '                unit: US cents\n        vocabulary:\n          section: a part of the tuition invoice\n');
  const both = expectOne(twoInterfaces, 'interface/conflicting-vocabulary',
    { severity: 'info', element: 'billing', needle: 'section: a part of the tuition invoice' }, { echoesTest: true });
  assert.match(both.message, /^'section' means different things in Enrollment API and Tuition Charges\./);
});

test('interface/style-mismatch: the connector and the used interface agree on synchrony', () => {
  const asyncRest = replaced(REFERENCE, REFERENCE_WEB_TO_COORDINATOR,
    '          coordinator: {description: submits plans to, technology: JSON/HTTPS, connector: message, uses: enrollment-api.submit-plan}');
  const found = expectOne(asyncRest, 'interface/style-mismatch',
    { severity: 'info', element: 'web', needle: 'connector: message, uses: enrollment-api' }, { echoesTest: true });
  assert.equal(found.message, 'The relationship is drawn as message but uses Enrollment API, a REST interface. Is the call synchronous or not?');

  const syncMessage = replaced(REFERENCE, '                connector: message\n', '                connector: call\n');
  expectOne(syncMessage, 'interface/style-mismatch', { severity: 'info', element: 'billing-gateway', needle: 'connector: call' },
    { echoesTest: true });
  expectNone(REFERENCE, 'interface/style-mismatch');
  expectNone(EVENTS, 'interface/style-mismatch');
});

const BILLING_USES = '                uses: tuition-charges.charge-tuition\n';
const REGISTRATION_SUMMARY = [
  '    collaborators:',
  '      billing: {description: requests tuition charges from, technology: AMQP, connector: message}',
  '    containers:',
  '',
].join('\n');

/** The reference model with a summary relationship from the registration system to billing (written as `summary`). */
function withRegistrationSummary(text, summary) {
  return replaced(text, '        requirements: [FR-11]\n    containers:\n', `        requirements: [FR-11]\n${summary}`);
}

test('interface/unspecified-use: a dependency on another software system names its interface', () => {
  const unspecified = replaced(REFERENCE, BILLING_USES, '');
  const found = expectOne(unspecified, 'interface/unspecified-use',
    { severity: 'info', element: 'billing-gateway', needle: '              billing:' }, { echoesTest: true });
  assert.equal(found.message, 'Billing Gateway depends on Billing System, another software system, but names no interface. ' +
    'Which interface does it use?');
  assert.equal(found.hint, 'Billing System offers Tuition Charges.');

  const [described] = ofRule(M1_SWITCHED_ON, 'interface/unspecified-use');
  assert.equal(described.hint, 'Billing System describes no interface yet; describe the one this team relies on.');

  expectNone(withRegistrationSummary(REFERENCE, REGISTRATION_SUMMARY), 'interface/unspecified-use', { echoesTest: true });
  const summaryNamesIt = withRegistrationSummary(unspecified, REGISTRATION_SUMMARY.replace('connector: message}',
    'connector: message, uses: tuition-charges.charge-tuition}'));
  expectNone(summaryNamesIt, 'interface/unspecified-use', { echoesTest: true });
  expectNone(REFERENCE, 'interface/unspecified-use');
});

test('interface/unused: an interface nobody uses is asked about, unless it is an entry point', () => {
  const extra = replaced(LIBRARY, '          catalog-api:\n', [
    '          loans-api:',
    '            name: Loans Service',
    '            description: Lends books to readers.',
    '            operations:',
    '              lend: POST /v2/loans',
    '          catalog-api:',
    '',
  ].join('\n'));
  const found = expectOne(extra, 'interface/unused', { severity: 'info', element: 'api', needle: 'loans-api:' });
  assert.equal(found.message, 'No relationship uses Loans Service. Is it an entry point for clients outside this model, or can it go?');
  expectNone(replaced(LIBRARY, 'uses: catalog-api.find-book}', 'uses: catalog-api}'), 'interface/unused');

  const pages = [
    '        provides:',
    '          planner-pages:',
    '            name: Planner Pages',
    '            description: The pages students plan their schedules on.',
    '            operations:',
    '              show-plan: GET /plans',
  ].join('\n');
  const onWeb = replaced(REFERENCE, '          - do: let students compare draft schedules\n',
    `          - do: let students compare draft schedules\n${pages}\n`);
  expectNone(onWeb, 'interface/unused', { echoesTest: true });
  const onDb = replaced(REFERENCE, '          - do: durably store plans, enrollment attempts, and seat holds\n',
    `          - do: durably store plans, enrollment attempts, and seat holds\n${pages}\n`);
  expectOne(onDb, 'interface/unused', { severity: 'info', element: 'db', needle: 'planner-pages:' }, { echoesTest: true });

  const emittedIntoTopicOnly = replaced(replaced(EVENTS,
    '          analytics: {description: delivers placed orders to, technology: HTTPS webhook, connector: event, uses: order-events.order-placed}',
    '          analytics: {description: delivers placed orders to, technology: HTTPS webhook, connector: event}'),
  '          order-topic: {description: subscribes to placed orders from, technology: AMQP, connector: event, uses: order-events.order-placed}',
  '          order-topic: {description: subscribes to placed orders from, technology: AMQP, connector: event}');
  expectOne(emittedIntoTopicOnly, 'interface/unused', { severity: 'info', element: 'orders', needle: 'order-events:' });
});

test('interface/unused-operation: an operation no client uses is asked about', () => {
  const found = expectOne(SHOP, 'interface/unused-operation', { severity: 'info', element: 'payments', needle: 'refund: POST' });
  assert.equal(found.message, 'No client uses refund. Does any client need it? An interface that offers only what clients use is easier to keep stable.');
  expectNone(replaced(SHOP, 'uses: card-payments.charge', 'uses: card-payments'), 'interface/unused-operation');
});

test('interface/no-version: an interface across a system boundary states its version', () => {
  const found = expectOne(replaced(SHOP, '        version: 3\n', ''), 'interface/no-version',
    { severity: 'info', element: 'payments', needle: 'card-payments:' });
  assert.equal(found.message, 'Card Payments API crosses a system boundary and states no Version. When it changes, how will ' +
    'clients know which description they implement?');
  expectNone(replaced(REFERENCE, '            version: 1\n', ''), 'interface/no-version');
});

test('interface/unbound-parameter: a placeholder is filled by an input field of the same name', () => {
  const unbound = replaced(LIBRARY, '                syntax: GET /v2/books/{isbn}', '                syntax: GET /v2/books/{number}');
  const found = expectOne(unbound, 'interface/unbound-parameter', { severity: 'info', element: 'api', needle: 'GET /v2/books/{number}' });
  assert.equal(found.message, 'The syntax of find-book has the placeholder {number}, but its input has no field number. ' +
    'A client cannot tell what to put there.');
  assert.equal(found.hint, 'Add an input field number with its type and meaning.');
  expectNone(LIBRARY, 'interface/unbound-parameter');

  const namedInput = replaced(replaced(LIBRARY, '                syntax: GET /v2/books/{isbn}', '                syntax: GET /v2/plans/{id}'),
    '              Book:\n', '              PlanRequest:\n                description: Which plan to read.\n                fields:\n' +
    '                  id: {type: string, meaning: the number of the plan}\n              Book:\n');
  expectOne(namedInput, 'interface/unbound-parameter', { severity: 'info', element: 'api', needle: 'GET /v2/plans/{id}' });
  const bound = replaced(namedInput, [
    '                input:',
    '                  isbn:',
    '                    type: string',
    '                    meaning: the international standard book number printed on the book',
    '                    format: 13 digits without hyphens',
  ].join('\n'), '                input: PlanRequest');
  expectNone(bound, 'interface/unbound-parameter');
  expectNone(SHOP, 'interface/unbound-parameter');
});

// ---- Interface-aware C4 rule, opt-in, and configuration --------------------------------------

test("a used interface's technology satisfies c4/cross-container-technology", () => {
  const crossTechnology = (text) => checked(text).filter((diagnostic) => diagnostic.rule === 'c4/cross-container-technology')
    .map((diagnostic) => diagnostic.element);
  const untechnical = replaced(REFERENCE, REFERENCE_WEB_TO_COORDINATOR,
    '          coordinator: {description: submits plans to, uses: enrollment-api.submit-plan}');
  assert.deepEqual(crossTechnology(untechnical), []);

  const secondInterface = replaced(replaced(REFERENCE, REFERENCE_WEB_TO_COORDINATOR,
    '          coordinator: {description: submits plans to, uses: drafts.save-draft}'),
  '        provides:\n          enrollment-api:\n', [
    '        provides:',
    '          drafts:',
    '            name: Draft Plans',
    '            operations:',
    '              save-draft: PUT /drafts/{id}',
    '          enrollment-api:',
    '',
  ].join('\n'));
  assert.deepEqual(crossTechnology(secondInterface), ['web']);
});

test('interface rules stay silent on shorthand-only models', () => {
  assert.deepEqual(interfaceDiagnostics(MILESTONE_1), []);
  assert.deepEqual(interfaceDiagnostics(M1_SWITCHED_ON).map((diagnostic) => `${diagnostic.rule} ${diagnostic.element}`).sort(), [
    'interface/in-process-across-boundary web',
    'interface/syntax-only coordinator',
    'interface/unspecified-use billing-gateway',
  ]);
});

test('incompleteness rules on an interface wait until it has lost focus', () => {
  const { parsed, model } = load(SHOP);
  const shown = (options) => checks.applyConfig(checks.run(model, { parsed }), model, Object.assign({ parsed }, options))
    .filter((diagnostic) => diagnostic.operation === 'refund' || diagnostic.rule === 'interface/no-meaning')
    .map((diagnostic) => diagnostic.rule).sort();
  assert.deepEqual(shown({}), ['interface/no-errors', 'interface/no-meaning', 'interface/no-meaning', 'interface/no-purpose',
    'interface/unused-operation']);
  assert.deepEqual(shown({ suppressIncompleteFor: ['card-payments'] }),
    ['interface/no-meaning', 'interface/no-meaning', 'interface/unused-operation']);
  assert.deepEqual(shown({ suppressIncompleteFor: ['Card-Payments'] }),
    ['interface/no-meaning', 'interface/no-meaning', 'interface/unused-operation']);
});

test('the rule catalog describes every interface rule with its severity, rationale, and source', () => {
  const byId = new Map(checks.RULES.map((definition) => [definition.id, definition]));
  const expected = {
    'model/interface-provider': 'error', 'model/realizes-owner': 'error',
    'interface/no-syntax': 'warning', 'interface/untyped-field': 'warning', 'interface/undefined-type': 'warning',
    'interface/no-purpose': 'warning', 'interface/no-errors': 'warning', 'interface/no-unit': 'warning',
    'interface/no-format': 'warning', 'interface/example-mismatch': 'warning', 'interface/realizes-internal': 'warning',
    'interface/in-process-across-boundary': 'warning', 'interface/requested-not-advertised': 'warning',
    'interface/type-spelling': 'info', 'interface/syntax-only': 'info', 'interface/no-meaning': 'info',
    'interface/no-example': 'info', 'interface/unrealized': 'info', 'interface/leaks-implementation': 'info',
    'interface/conflicting-vocabulary': 'info', 'interface/style-mismatch': 'info', 'interface/unspecified-use': 'info',
    'interface/unused': 'info', 'interface/unused-operation': 'info', 'interface/no-version': 'info',
    'interface/unbound-parameter': 'info',
  };
  assert.deepEqual([...byId.keys()].filter((id) => id.startsWith('interface/')).sort(),
    Object.keys(expected).filter((id) => id.startsWith('interface/')).sort());
  Object.entries(expected).forEach(([id, severity]) => {
    const definition = byId.get(id);
    assert.equal(definition.severity, severity, id);
    assert.ok(definition.title && definition.rationale && definition.source, `${id} has a title, rationale, and source`);
  });
  const modelRationale = 'A reference that contradicts containment or the direction of a contract is invalid, like model/responsibility-owner.';
  assert.equal(byId.get('model/interface-provider').rationale, modelRationale);
  assert.equal(byId.get('model/realizes-owner').source, 'WirfsBrock2003');
  assert.equal(byId.get('interface/no-unit').message, '<field> is a number with no Unit. Two teams can read the same number differently.');
  assert.equal(byId.get('interface/no-unit').source, 'MCOMIB1999; Bass2012');
  assert.equal(byId.get('interface/type-spelling').source, '—');
  // Readers of the help text and REFERENCE.md cannot open the internal design specification (spec §7.1: a public
  // source), so no interface rule cites its sections, in the source or in the rationale.
  const interfaceRules = [...byId.values()].filter((definition) => definition.id.startsWith('interface/')
    || ['model/interface-provider', 'model/realizes-owner'].includes(definition.id));
  const citesSpecification = interfaceRules
    .filter((definition) => /§/.test(definition.source + definition.rationale)).map((definition) => definition.id);
  assert.deepEqual(citesSpecification, []);
});

// Runs last: it reads the texts every earlier test collected.
test('no interface message names a value of the reference model', () => {
  [REFERENCE, ENDPOINT, SHOP, EVENTS, BOOKING, MILESTONE_1, M1_SWITCHED_ON].forEach((text) => interfaceDiagnostics(text));
  const referenceTerms = ['quarter unit', 'US cents', 'nine digits', 'ISO 8601', 'six-digit', 'section', 'plan'];
  const texts = producedTexts.filter((text) => text !== null);
  assert.ok(texts.length > 50, `the earlier tests produced interface messages (${texts.length})`);
  texts.forEach((text) => referenceTerms.forEach((term) => {
    assert.ok(!new RegExp(`\\b${term}\\b`, 'i').test(text), `"${text}" names "${term}"`);
  }));
});
