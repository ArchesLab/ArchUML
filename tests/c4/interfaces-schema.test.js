'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../../c4/c4-schema.js');
const y = require('../../c4/c4-yaml.js');
const modelApi = require('../../c4/c4-model.js');
const p = require('../../c4/c4-projection.js');
const { fixture } = require('./helpers.js');

test('operation ids derive from a call, an HTTP method and path, or the first words', () => {
  assert.equal(schema.deriveOperationId('evaluate(plan) -> EnrollmentOutcome', new Set()), 'evaluate');
  assert.equal(schema.deriveOperationId('POST /orders', new Set()), 'post-orders');
  assert.equal(schema.deriveOperationId('GET /readers/{id}', new Set()), 'get-readers-id');
  assert.equal(schema.deriveOperationId('send ChargeRequested to the queue billing.charges', new Set()), 'send-chargerequested-to');
  assert.equal(schema.deriveOperationId('→ ★', new Set()), 'op');
  assert.equal(schema.deriveOperationId('POST /orders', new Set(['post-orders'])), 'post-orders-2');
});

test('operation ids ignore a UML visibility marker and leading underscores', () => {
  assert.equal(schema.deriveOperationId('+ decide(student, section): Decision', new Set()), 'decide');
  assert.equal(schema.deriveOperationId('_refresh(cache)', new Set()), 'refresh');
});

test('an operation id whose words start with a digit falls back to op', () => {
  assert.equal(schema.deriveOperationId('404 page for readers', new Set()), 'op');
  assert.equal(schema.deriveOperationId('', new Set()), 'op');
});

test('derived operation ids are stable for a list read twice', () => {
  const ids = (list) => { const taken = new Set(); return list.map((s) => schema.deriveOperationId(s, taken)); };
  const list = ['POST /orders', 'POST /orders', 'cancel(order)'];
  assert.deepEqual(ids(list), ['post-orders', 'post-orders-2', 'cancel']);
  assert.deepEqual(ids(list), ids(list));
});

test('type expressions read primitives, local types, lists, and other languages\' spellings', () => {
  assert.deepEqual(schema.parseTypeExpression('string[]'), { name: 'string', list: true, primitive: true, canonical: 'string[]', spelling: null });
  assert.deepEqual(schema.parseTypeExpression('EnrollmentOutcome'), { name: 'EnrollmentOutcome', list: false, primitive: false, canonical: 'EnrollmentOutcome', spelling: null });
  assert.deepEqual(schema.parseTypeExpression('str'), { name: 'string', list: false, primitive: true, canonical: 'string', spelling: 'str' });
  assert.deepEqual(schema.parseTypeExpression('dateTime'), { name: 'datetime', list: false, primitive: true, canonical: 'datetime', spelling: 'dateTime' });
  assert.equal(schema.parseTypeExpression('List<str>').canonical, 'string[]');
  assert.equal(schema.parseTypeExpression('list[Section]').canonical, 'Section[]');
  assert.equal(schema.parseTypeExpression('a number').invalid, true);
  assert.equal(schema.parseTypeExpression('string[][]').invalid, true);
});

test('a generic list spelling is kept as written and its element type is normalized', () => {
  assert.deepEqual(schema.parseTypeExpression('Array<int>'),
    { name: 'integer', list: true, primitive: true, canonical: 'integer[]', spelling: 'Array<int>' });
  assert.deepEqual(schema.parseTypeExpression('array<Section>'),
    { name: 'Section', list: true, primitive: false, canonical: 'Section[]', spelling: 'array<Section>' });
  assert.deepEqual(schema.parseTypeExpression('List<str[]>'), { text: 'List<str[]>', invalid: true });
});

test('uses references split at the single dot', () => {
  assert.deepEqual(schema.parseUsesRef('enrollment-api.submit-plan'), { interfaceId: 'enrollment-api', operationId: 'submit-plan' });
  assert.deepEqual(schema.parseUsesRef('enrollment-api'), { interfaceId: 'enrollment-api', operationId: null });
  assert.equal(schema.parseUsesRef('a.b.c').error, 'uses-syntax');
  assert.equal(schema.parseUsesRef('1api').error, 'uses-syntax');
  assert.equal(schema.parseUsesRef('api.').error, 'uses-syntax');
});

test('placeholders are read from syntax lines', () => {
  assert.deepEqual(schema.placeholders('DELETE /v1/enrollments/{id}'), ['id']);
  assert.deepEqual(schema.placeholders('GET /terms/{term}/sections/{section_id}'), ['term', 'section_id']);
  assert.deepEqual(schema.placeholders('evaluate(plan) -> EnrollmentOutcome'), []);
});

test('interface catalogs and key orders match spec §4.11', () => {
  assert.deepEqual(schema.INTERFACE_STYLES, ['rest', 'rpc', 'graphql', 'soap', 'message', 'event', 'stream', 'library', 'file']);
  assert.deepEqual(schema.INTERFACE_ORDER, ['name', 'description', 'style', 'technology', 'version', 'restrictions', 'errors', 'operations', 'types', 'vocabulary']);
  assert.deepEqual(schema.OPERATION_ORDER, ['syntax', 'input', 'output', 'purpose', 'side_effects', 'restrictions', 'errors', 'examples', 'realizes']);
  assert.deepEqual(schema.TYPE_ORDER, ['description', 'fields']);
  assert.deepEqual(schema.FIELD_ORDER, ['type', 'meaning', 'unit', 'format', 'required', 'values', 'constraints', 'example']);
  assert.deepEqual(schema.EXAMPLE_KEYS, ['input', 'output', 'note']);
  assert.deepEqual(schema.ERROR_KEYS, ['when', 'code']);
  assert.deepEqual(schema.PRIMITIVE_TYPES, ['string', 'integer', 'number', 'decimal', 'boolean', 'date', 'datetime', 'time', 'duration', 'uuid', 'uri', 'binary', 'any']);
  assert.deepEqual(schema.COLLABORATOR_ORDER, ['description', 'technology', 'connector', 'responsibility', 'uses', 'choices']);
  assert.deepEqual(schema.STEP_KEYS, ['from', 'to', 'description', 'technology', 'connector', 'responsibility', 'uses']);
  assert.ok(schema.RESERVED_VIEW_IDS.includes('interfaces') && schema.RESERVED_VIEW_IDS.includes('interface'));
  assert.ok(schema.ANNOTATION_BASES.interfaces.includes('dynamic') && !schema.ANNOTATION_BASES.interfaces.includes('code'));
  assert.ok(!('required' in schema.TYPED_FIELDS));
});

test('style groups, labels, and view fields match spec §5.1, §5.3, and §7.2', () => {
  assert.deepEqual(schema.STYLE_LABELS, { rest: 'REST', rpc: 'RPC', graphql: 'GraphQL', soap: 'SOAP', message: 'Message', event: 'Event', stream: 'Stream', library: 'Library', file: 'File' });
  assert.deepEqual(schema.ERROR_WARNING_STYLES, ['rest', 'rpc', 'graphql', 'soap', 'message']);
  assert.deepEqual(schema.SYNC_STYLES, ['rest', 'rpc', 'graphql', 'soap']);
  assert.deepEqual(schema.EMITTER_STYLES, ['event', 'stream']);
  assert.deepEqual(schema.BROKER_KINDS, ['queue', 'topic']);
  assert.deepEqual(schema.ANNOTATION_BASES, {
    interfaces: ['landscape', 'context', 'containers', 'components', 'dynamic'],
    styles: ['landscape', 'context', 'containers', 'components'],
    tactics: ['landscape', 'context', 'containers', 'components'],
    patterns: ['landscape', 'context', 'containers', 'components', 'code'],
  });
  assert.deepEqual(schema.INTERFACE_VIEW_FIELDS, {
    interfaces: ['view', 'title', 'description', 'show_title', 'exclude', 'direction'],
    interface: ['view', 'title', 'description', 'show_title'],
  });
  assert.ok(schema.TOP_LEVEL_KEYS.includes('vocabulary'));
});

test('type and word catalogs match spec §4.11 and §7.2', () => {
  assert.deepEqual(schema.NUMERIC_TYPES, ['integer', 'number', 'decimal']);
  assert.deepEqual(schema.TEMPORAL_TYPES, ['date', 'datetime', 'time', 'duration']);
  assert.deepEqual(schema.TYPE_ALIASES, { str: 'string', int: 'integer', float: 'number', double: 'number', bool: 'boolean', dateTime: 'datetime', timestamp: 'datetime' });
  assert.deepEqual(schema.QUANTITY_WORDS, ['price', 'amount', 'cost', 'fee', 'weight', 'distance', 'size', 'temperature']);
  assert.deepEqual(schema.DATE_WORDS, ['date', 'time', 'deadline', 'birthday', 'dob']);
  assert.deepEqual(schema.DATE_SUFFIX_WORDS, ['at', 'on']);
  assert.deepEqual(schema.HTTP_METHODS, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
  assert.deepEqual(schema.LEAK_WORDS, ['sql', 'select', 'insert', 'table', 'column', 'row id', 'primary key', 'foreign key',
    'orm', 'dao', 'stored procedure', 'mutex', 'heap', 'pointer']);
});

test('type and field names follow their patterns', () => {
  assert.match('EnrollmentOutcome', schema.TYPE_NAME_PATTERN);
  assert.doesNotMatch('Enrollment-Outcome', schema.TYPE_NAME_PATTERN);
  assert.match('_links', schema.FIELD_NAME_PATTERN);
  assert.match('units-enrolled', schema.FIELD_NAME_PATTERN);
  assert.doesNotMatch('1st', schema.FIELD_NAME_PATTERN);
});

test('the selector grammar parses interface views, the with suffix, and layout keys', () => {
  assert.equal(schema.parseSelector('Interfaces of api').canonical, 'interfaces of api');
  assert.equal(schema.parseSelector('Interfaces of API').canonical, 'interfaces of API'); // element ids stay exact (spec §4.10)
  assert.equal(schema.parseSelector('interface Enrollment-API').interfaceId, 'enrollment-api');
  assert.equal(schema.parseSelector('Containers of registration with patterns, interfaces').canonical, 'containers of registration with interfaces, patterns');
  assert.equal(schema.selectorKey(schema.parseSelector('Containers of registration with interfaces')), 'containers of registration');
  const long = schema.parseSelector('Interface enrollment-api of api');
  assert.equal(long.canonical, 'interface enrollment-api');
  assert.equal(long.ofId, 'api');
  assert.ok(schema.parseSelector('containers of registration with colours').error);
  assert.equal(schema.canonicalSelector(schema.parseSelector('Container of Registration')), 'containers of Registration'); // ledger Ruling 1
});

test('a parsed selector names every part of the grammar', () => {
  assert.deepEqual(schema.parseSelector('Interface Enrollment-API of Api WITH Styles'), {
    type: 'interface', scopeId: null, interfaceId: 'enrollment-api', ofId: 'Api', viewId: null,
    annotations: ['styles'], base: 'interface enrollment-api', canonical: 'interface enrollment-api with styles',
  });
  assert.deepEqual(schema.parseSelector('student-journey with interfaces'), {
    type: 'custom', scopeId: null, interfaceId: null, ofId: null, viewId: 'student-journey',
    annotations: ['interfaces'], base: 'student-journey', canonical: 'student-journey with interfaces',
  });
});

test('annotations are deduplicated, and an empty or unknown one is a syntax error', () => {
  assert.equal(schema.parseSelector('landscape with styles, Styles').canonical, 'landscape with styles');
  assert.ok(schema.parseSelector('landscape with styles,').error);
  assert.ok(schema.parseSelector('landscape with').error);
  assert.ok(schema.parseSelector('interfaces of').error);
  assert.ok(schema.parseSelector('interface').error);
  assert.ok(schema.parseSelector('interfaces').error, 'a reserved word is not a custom view id');
});

test('the view key of selector text drops the suffix and keeps malformed text trimmed', () => {
  assert.equal(schema.selectorKey('Dynamic enroll  with interfaces'), 'dynamic enroll');
  assert.equal(schema.selectorKey('student-journey with interfaces'), 'student-journey');
  assert.equal(schema.selectorKey('  not  a selector '), 'not a selector');
});

test('layout keys written with a with suffix share the plain view key', () => {
  const { model } = modelApi.normalize(y.parse([
    'systems:',
    '  registration:',
    '    containers:',
    '      web:',
    'layout:',
    '  Containers of registration with interfaces:',
    '    web: [10, 20]',
  ].join('\n')), { source: 'file' });
  assert.deepEqual([...model.layout.keys()], ['containers of registration']);
});

const upper = (id) => id.toUpperCase();

test('renaming the ids in a selector keeps its keyword spelling, spacing, and with suffix', () => {
  assert.equal(schema.withSelectorScope('Container  of shop  WITH Styles ', upper, upper), 'Container  of SHOP  WITH Styles ');
  assert.equal(schema.withSelectorScope('system context of shop', upper, upper), 'system context of SHOP');
  assert.equal(schema.withSelectorScope('Interfaces of app with interfaces', upper, upper), 'Interfaces of APP with interfaces');
  assert.equal(schema.withSelectorScope('Interface Card-Payments  Of payments with styles', upper, (id) => `${id}-v2`),
    'Interface Card-Payments-v2  Of PAYMENTS with styles');
  assert.equal(schema.withSelectorScope('interface card-payments', upper, upper), 'interface CARD-PAYMENTS');
});

test('renaming the ids in a selector leaves scenario, environment, custom, and malformed selectors alone', () => {
  for (const text of ['dynamic enroll', 'deployment live with styles', 'landscape', 'student-journey', 'containers of shop with colours', 'interfaces of']) {
    assert.equal(schema.withSelectorScope(text, upper, upper), text, text);
  }
});

test('interface selectors resolve to an error diagnostic, not an exception, for names that do not exist', () => {
  const model = modelApi.normalize(y.parse(fixture('course-registration.yml')), { source: 'file' }).model;
  for (const text of ['interface no-such-interface', 'interfaces of nobody']) {
    assert.equal(p.resolveView(model, text).diagnostic.rule, 'view/unknown-selector', text);
  }
});

test('leak words are found after splitting names into words', () => {
  assert.deepEqual(schema.splitWords('SeatTable'), ['seat', 'table']);
  assert.deepEqual(schema.leakWords('row_id'), ['row id']);
  assert.deepEqual(schema.leakWords('SELECT * FROM seats'), ['select']);
  for (const name of ['class_section', 'section_ids', 'request_id', 'next_cursor']) assert.deepEqual(schema.leakWords(name), []);
});

test('names split at underscores, hyphens, dots, slashes, spaces, and lower-to-upper case changes', () => {
  assert.deepEqual(schema.splitWords('billing.charges/primaryKey seat_row-ID'), ['billing', 'charges', 'primary', 'key', 'seat', 'row', 'id']);
  assert.deepEqual(schema.leakWords('GET /seats/{primaryKey}/stored-procedure'), ['primary key', 'stored procedure']);
  assert.deepEqual(schema.leakWords('rowing identity'), []);
});

test('identifier field names are recognized', () => {
  for (const name of ['id', 'student_id', 'section_ids', 'studentId', 'sectionIds']) assert.match(name, schema.IDENTIFIER_FIELD_PATTERN);
  for (const name of ['units', 'amount', 'paid', 'width']) assert.doesNotMatch(name, schema.IDENTIFIER_FIELD_PATTERN);
});
