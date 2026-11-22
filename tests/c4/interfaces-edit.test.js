'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const YAML = require('../../vendor/yaml/2.9.1/yaml.js');
const y = require('../../c4/c4-yaml.js');
const model = require('../../c4/c4-model.js');
const edit = require('../../c4/c4-edit.js');
const { fixture } = require('./helpers.js');

// Interface edit commands and their cascades (spec §4.10, §4.11 "Text splices", §9.5).

const COURSE = fixture('course-registration-interfaces.yml');
const SHOP = fixture('interfaces-shop.yml');
const EVENTS = fixture('interfaces-events.yml');

/** The `{ text, parsed, model }` design that edit commands take. */
function design(text) {
  const parsed = y.parse(text);
  return { text, parsed, model: model.normalize(parsed, { source: 'file' }).model };
}

function loaded(text) {
  return model.normalize(y.parse(text), { source: 'file' });
}

/** Applies `command` to `text`; fails unless the command succeeds and its edits produce its text. */
function applied(text, command) {
  const result = edit.apply(design(text), command);
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(y.applyEdits(text, result.edits), result.text, 'the edits turn the input into the returned text');
  return result;
}

/** The refusal `command` gets on `text`; fails when the command succeeds. */
function refusalOf(text, command) {
  const result = edit.apply(design(text), command);
  assert.equal(result.edits, undefined, `${JSON.stringify(command)} returns no edits`);
  assert.equal(result.text, undefined, `${JSON.stringify(command)} returns no text`);
  return result;
}

function dataAt(text, path) {
  return path.reduce((value, segment) => (value == null ? undefined : value[segment]), y.toData(y.parse(text)));
}

/** `text` with its one occurrence of `from` replaced by `to`. */
function variant(text, from, to) {
  assert.equal(text.split(from).length, 2, `the text holds ${JSON.stringify(from)} once`);
  return text.replace(from, to);
}

function rulesOf(text) {
  return loaded(text).diagnostics.map((diagnostic) => diagnostic.rule);
}

const WEB_COLLABORATORS = ['systems', 'registration', 'containers', 'web', 'collaborators'];
const API = ['systems', 'registration', 'containers', 'api'];
const ENROLLMENT_API = API.concat('provides', 'enrollment-api');
const SUBMIT_PLAN = ENROLLMENT_API.concat('operations', 'submit-plan');
const TUITION_CHARGES = ['systems', 'billing', 'provides', 'tuition-charges'];

// ---- uses ------------------------------------------------------------------------------------

test('setUses removes and adds uses inside a flow map', () => {
  const removed = applied(COURSE, { op: 'setUses', relationshipId: 'web->coordinator', uses: [] });
  assert.equal(removed.text, variant(COURSE,
    'coordinator: {description: submits plans to, technology: JSON/HTTPS, uses: enrollment-api.submit-plan}',
    'coordinator: {description: submits plans to, technology: JSON/HTTPS}'));
  assert.deepEqual(removed.selection, { relationshipId: 'web->coordinator' });

  const restored = applied(removed.text, { op: 'setUses', relationshipId: 'web->coordinator', uses: ['enrollment-api.submit-plan'] });
  assert.equal(restored.text, COURSE);
});

test('setUses turns a string collaborator into a block map', () => {
  const unchanged = edit.apply(design(COURSE), { op: 'setUses', relationshipId: 'coordinator->billing-gateway', uses: [] });
  assert.deepEqual(unchanged.edits, []);
  assert.equal(unchanged.text, COURSE);

  const providing = variant(COURSE, '            name: Billing Gateway\n',
    '            name: Billing Gateway\n            provides: ["request(enrollment) -> ChargeId"]\n');
  const used = applied(providing, { op: 'setUses', relationshipId: 'coordinator->billing-gateway', uses: ['billing-gateway.request'] });
  assert.equal(used.text, variant(providing, '              billing-gateway: asks for tuition charges through\n',
    '              billing-gateway:\n' +
    '                description: asks for tuition charges through\n' +
    '                uses: billing-gateway.request\n'));

  const emptied = applied(used.text, { op: 'setUses', relationshipId: 'coordinator->billing-gateway', uses: [] });
  assert.equal(emptied.text, variant(providing, '              billing-gateway: asks for tuition charges through\n',
    '              billing-gateway:\n                description: asks for tuition charges through\n'));
  const relationship = loaded(emptied.text).model.relationships.find((r) => r.id === 'coordinator->billing-gateway');
  assert.deepEqual(relationship.uses, []);
});

test('setUses writes several entries as a flow list', () => {
  const both = applied(SHOP, { op: 'setUses', relationshipId: 'app->payments', uses: ['card-payments.charge', 'card-payments.refund'] });
  assert.equal(both.text, variant(SHOP, 'uses: card-payments.charge\n', 'uses: [card-payments.charge, card-payments.refund]\n'));
  const one = applied(both.text, { op: 'setUses', relationshipId: 'app->payments', uses: ['card-payments.charge'] });
  assert.equal(one.text, SHOP);
});

test('setUses refuses unknown and forbidden interfaces', () => {
  assert.equal(refusalOf(COURSE, { op: 'setUses', relationshipId: 'web->coordinator', uses: ['enrolment-api'] }).error, 'unknown-interface');
  assert.equal(refusalOf(COURSE, { op: 'setUses', relationshipId: 'web->coordinator', uses: ['enrollment-api.submit'] }).error,
    'unknown-interface');
  assert.equal(refusalOf(COURSE, { op: 'setUses', relationshipId: 'seats->db', uses: ['enrollment-api'] }).error, 'interface-provider');
});

// ---- Shorthand to full form ------------------------------------------------------------------

const SHOP_WITH_USE = variant(SHOP, '    description: Charges credit and debit cards for online shops.\n',
  '    description: Charges credit and debit cards for online shops.\n' +
  '    collaborators:\n' +
  '      app: {description: confirms each paid order to, uses: app.post-orders}\n');
const SHOP_PROVIDES = '        provides: ["GET /readers/{id}", "POST /orders"]\n';
const SHOP_EXPANDED = '        provides:\n' +
  '          app:\n' +
  '            name: Shop App interface\n' +
  '            operations:\n' +
  '              get-readers-id: GET /readers/{id}\n' +
  '              post-orders: POST /orders\n';

test('expanding a shorthand list writes the full form in one splice over the old value', () => {
  const result = applied(SHOP_WITH_USE, { op: 'expandProvidesShorthand', elementId: 'app' });
  assert.equal(result.text, variant(SHOP_WITH_USE, SHOP_PROVIDES, SHOP_EXPANDED));
  assert.deepEqual(result.selection, { elementId: 'app', interfaceId: 'app' });
  assert.equal(result.edits.length, 1);
  const [splice] = result.edits;
  assert.equal(SHOP_WITH_USE.slice(splice.offset, splice.offset + splice.length), ' ["GET /readers/{id}", "POST /orders"]',
    'the one splice replaces the old provides value');
  assert.equal(refusalOf(SHOP, { op: 'expandProvidesShorthand', elementId: 'payments' }).error, 'not-shorthand');
});

// Review Focus 1: the expanded interface keeps its element's id, so `uses: app.post-orders` still resolves (spec §4.11).
test('expanding a shorthand list keeps its derived operation ids', () => {
  const result = applied(SHOP_WITH_USE, { op: 'expandProvidesShorthand', elementId: 'app' });
  const { model: reloaded, diagnostics } = loaded(result.text);
  const app = reloaded.interfaces.get('app');
  assert.equal(app.shorthand, false);
  assert.equal(app.name, 'Shop App interface');
  assert.deepEqual(app.operations.map((operation) => operation.id), ['get-readers-id', 'post-orders']);
  assert.deepEqual(diagnostics.filter((d) => d.rule.startsWith('model/')), []);
  assert.deepEqual(reloaded.relationships.find((r) => r.id === 'payments->app').uses.map((use) => use.text), ['app.post-orders']);
});

test('addInterface on a shorthand element expands first and returns one result', () => {
  const result = applied(SHOP, { op: 'addInterface', elementId: 'app', name: 'Order Events', style: 'event' });
  assert.equal(result.text, variant(SHOP, SHOP_PROVIDES, SHOP_EXPANDED +
    '          order-events:\n            name: Order Events\n            style: event\n'));
  assert.deepEqual(result.selection, { elementId: 'app', interfaceId: 'order-events' });
  assert.equal(result.edits.length, 1);
  const [splice] = result.edits;
  const undone = y.applyEdits(result.text,
    [{ offset: splice.offset, length: splice.text.length, text: SHOP.slice(splice.offset, splice.offset + splice.length) }]);
  assert.equal(undone, SHOP);
});

test('addInterface gives a slug id unique among elements and interfaces, ignoring case', () => {
  const result = applied(COURSE, { op: 'addInterface', elementId: 'web', name: 'Billing' });
  assert.deepEqual(result.selection, { elementId: 'web', interfaceId: 'billing-2' });
  assert.equal(refusalOf(COURSE, { op: 'addInterface', elementId: 'web', name: 'X', id: 'Tuition-Charges' }).error, 'id-taken');
  assert.equal(refusalOf(COURSE, { op: 'addInterface', elementId: 'web', name: 'X', id: '1x' }).error, 'id-format');
  assert.equal(refusalOf(COURSE, { op: 'addInterface', elementId: 'student', name: 'X' }).error, 'invalid-field');
  assert.equal(refusalOf(COURSE, { op: 'addInterface', elementId: 'web', name: 'X', style: 'restful' }).error, 'invalid-style');
});

// ---- Operations ------------------------------------------------------------------------------

test('addOperation writes the string form and updateOperation switches to the map form only when needed', () => {
  const added = applied(COURSE, { op: 'addOperation', interfaceId: 'enrollment-api', syntax: 'GET /v1/enrollments/{id}' });
  assert.deepEqual(added.selection, { interfaceId: 'enrollment-api', operationId: 'get-v1-enrollments-id' });
  const operation = loaded(added.text).model.interfaces.get('enrollment-api').operations[1];
  assert.equal(operation.id, 'get-v1-enrollments-id');
  assert.equal(operation.syntax, 'GET /v1/enrollments/{id}');
  const path = ENROLLMENT_API.concat('operations', 'get-v1-enrollments-id');
  assert.equal(dataAt(added.text, path), 'GET /v1/enrollments/{id}');

  const resyntaxed = applied(added.text, { op: 'updateOperation', interfaceId: 'enrollment-api', operationId: 'get-v1-enrollments-id',
    field: 'syntax', value: 'GET /v1/enrollments/{enrollment_id}' });
  assert.equal(dataAt(resyntaxed.text, path), 'GET /v1/enrollments/{enrollment_id}');

  const purposed = applied(resyntaxed.text, { op: 'updateOperation', interfaceId: 'enrollment-api', operationId: 'get-v1-enrollments-id',
    field: 'purpose', value: 'Reports the outcome of one enrollment.' });
  assert.ok(purposed.text.includes(
    '              get-v1-enrollments-id:\n' +
    '                syntax: GET /v1/enrollments/{enrollment_id}\n' +
    '                purpose: Reports the outcome of one enrollment.\n'), purposed.text);
});

test('operations of a shorthand interface stay syntax lines', () => {
  const added = applied(SHOP, { op: 'addOperation', interfaceId: 'app', syntax: 'DELETE /orders/{id}' });
  assert.equal(added.selection.operationId, 'delete-orders-id');
  assert.deepEqual(dataAt(added.text, ['systems', 'shop', 'containers', 'app', 'provides']),
    ['GET /readers/{id}', 'POST /orders', 'DELETE /orders/{id}']);
  assert.equal(refusalOf(SHOP, { op: 'updateOperation', interfaceId: 'app', operationId: 'post-orders', field: 'purpose', value: 'x' }).error,
    'shorthand');
});

test('moveOperation reorders operations with their text', () => {
  const moved = applied(SHOP, { op: 'moveOperation', interfaceId: 'card-payments', from: 1, to: 0 });
  assert.deepEqual(loaded(moved.text).model.interfaces.get('card-payments').operations.map((o) => o.id), ['refund', 'charge']);
  const back = applied(moved.text, { op: 'moveOperation', interfaceId: 'card-payments', from: 0, to: 1 });
  assert.deepEqual(loaded(back.text).model.interfaces.get('card-payments').operations.map((o) => o.id), ['charge', 'refund']);
});

// ---- Fields, values, restrictions, errors, examples --------------------------------------------

const UNITS_BLOCK = '              units:\n' +
  '                type: number\n' +
  '                meaning: units the student enrolled in by this attempt\n' +
  '                unit: quarter units\n';

test('setField writes the type string, a flow map for syntax, and a block map once a meaning is set', () => {
  const units = (field) => ({ op: 'setField', interfaceId: 'tuition-charges', owner: { typeName: 'ChargeRequested' }, fieldName: 'units', field });
  const typed = applied(COURSE, units({ type: 'number' }));
  assert.equal(typed.text, variant(COURSE, UNITS_BLOCK, '              units: number\n'));
  assert.deepEqual(typed.selection, { interfaceId: 'tuition-charges', typeName: 'ChargeRequested', fieldName: 'units' });

  const optional = applied(typed.text, units({ type: 'number', required: false }));
  assert.equal(optional.text, variant(COURSE, UNITS_BLOCK, '              units: {type: number, required: false}\n'));

  const meant = applied(optional.text, units({ unit: 'items', meaning: 'credits counted', type: 'number' }));
  assert.equal(meant.text, variant(COURSE, UNITS_BLOCK,
    '              units:\n                type: number\n                meaning: credits counted\n                unit: items\n'));

  const spelled = applied(meant.text, units({ type: 'str' }));
  assert.equal(spelled.text, variant(COURSE, UNITS_BLOCK, '              units: string\n'));
  const spelledMap = applied(COURSE, units({ type: 'List<int>', meaning: 'units per section' }));
  assert.equal(spelledMap.text, variant(COURSE, UNITS_BLOCK,
    '              units:\n                type: integer[]\n                meaning: units per section\n'));
});

test('setField edits an inline input map and refuses an input written as a type', () => {
  const charge = { interfaceId: 'card-payments', owner: { operationId: 'charge', part: 'input' } };
  const added = applied(SHOP, Object.assign({ op: 'setField', fieldName: 'currency', field: { type: 'string', values: ['USD'] } }, charge));
  assert.ok(added.text.includes('              currency: {type: string, values: [USD]}\n            output: Charge\n'), added.text);
  const removed = applied(added.text, Object.assign({ op: 'setField', fieldName: 'currency', field: null }, charge));
  assert.equal(removed.text, SHOP);
  assert.equal(refusalOf(COURSE, { op: 'setField', interfaceId: 'enrollment-api', owner: { operationId: 'submit-plan', part: 'input' },
    fieldName: 'x', field: { type: 'string' } }).error, 'not-inline');
});

test('setValues writes a list or a map of meanings', () => {
  const status = (values) => ({ op: 'setValues', interfaceId: 'enrollment-api', owner: { typeName: 'EnrollmentOutcome' }, fieldName: 'status', values });
  const valuesMap = '                    values:\n' +
    '                      enrolled: the student now holds a seat in every section of the plan\n' +
    '                      refused: the student holds no new seat; reason says why\n';
  const listed = applied(COURSE, status(['a', 'b']));
  assert.equal(listed.text, variant(COURSE, valuesMap, '                    values: [a, b]\n'));
  const meant = applied(listed.text, status({ a: 'first', b: 'second' }));
  assert.equal(meant.text, variant(COURSE, valuesMap, '                    values:\n                      a: first\n                      b: second\n'));
});

test('setValues turns a type string into a flow map', () => {
  const result = applied(SHOP, { op: 'setValues', interfaceId: 'card-payments', owner: { typeName: 'Charge' }, fieldName: 'id', values: ['ch_1'] });
  assert.equal(result.text, variant(SHOP, '              id: string    #', '              id: {type: string, values: [ch_1]}    #'));
});

test('setRestrictions and setError write at the interface or operation level', () => {
  const when = 'the API is down for maintenance; the client tries again after the time in Retry-After';
  const interfaceLevel = applied(COURSE, { op: 'setError', interfaceId: 'enrollment-api', name: 'unavailable', value: { code: '503', when } });
  assert.ok(interfaceLevel.text.includes(
    'the client waits for the Retry-After time and tries again\n' +
    `              unavailable:\n                when: ${when}\n                code: 503\n            operations:\n`), interfaceLevel.text);
  assert.deepEqual(loaded(interfaceLevel.text).model.interfaces.get('enrollment-api').errors.map((e) => [e.name, e.code]).pop(),
    ['unavailable', '503']);

  const operationLevel = applied(COURSE, { op: 'setError', interfaceId: 'enrollment-api', operationId: 'submit-plan', name: 'unavailable', value: when });
  assert.ok(operationLevel.text.includes(
    'lets the student remove it\n' +
    `                  unavailable: ${when}\n                examples:\n`), operationLevel.text);
  assert.deepEqual(operationLevel.selection, { interfaceId: 'enrollment-api', operationId: 'submit-plan' });

  const restricted = applied(COURSE, { op: 'setRestrictions', interfaceId: 'enrollment-api', operationId: 'submit-plan',
    items: ['Only while the enrollment window of the term is open.'] });
  assert.ok(restricted.text.includes('                  - A refused outcome changes nothing.\n' +
    '                restrictions:\n                  - Only while the enrollment window of the term is open.\n                errors:\n'),
  restricted.text);
  const cleared = applied(COURSE, { op: 'setRestrictions', interfaceId: 'enrollment-api', items: [] });
  assert.deepEqual(loaded(cleared.text).model.interfaces.get('enrollment-api').restrictions, []);
  assert.equal(dataAt(cleared.text, ENROLLMENT_API.concat('restrictions')), undefined);
});

test('examples are written from the text the user typed', () => {
  const inputText = '{student_id: "905123456", term: 2027-spring, section_ids: ["187204"]}';
  const outputText = '{status: refused, units_enrolled: 4, decided_at: "2027-03-30T08:00:00-07:00", reason: section full}';
  const added = applied(COURSE, { op: 'addExample', interfaceId: 'enrollment-api', operationId: 'submit-plan', inputText, outputText });
  assert.ok(added.text.includes('                    note: Two 4-unit sections that do not clash.\n' +
    `                  - input: ${inputText}\n                    output: ${outputText}\n`), added.text);
  const example = loaded(added.text).model.interfaces.get('enrollment-api').operations[0].examples[1];
  assert.equal(example.outputText, outputText);
  assert.equal(example.output.units_enrolled, '4');

  const broken = refusalOf(added.text, { op: 'updateExample', interfaceId: 'enrollment-api', operationId: 'submit-plan', index: 1,
    outputText: '{status: refused,' });
  assert.equal(broken.error, 'example-syntax');
  assert.equal(broken.line, 1);
  assert.equal(typeof broken.message, 'string');
  assert.equal(refusalOf(COURSE, { op: 'addExample', interfaceId: 'enrollment-api', operationId: 'submit-plan', inputText: 'a: b' }).error,
    'example-syntax');
});

// ---- Types and vocabulary --------------------------------------------------------------------

test('renameType rewrites lists and inline references in the same interface only', () => {
  const text = variant(variant(COURSE,
    '                    constraints: 1 to 8 items, no duplicates\n',
    '                    constraints: 1 to 8 items, no duplicates\n                  previous: EnrollmentOutcome[]\n'),
  '                unit: US cents\n',
  '                unit: US cents\n              outcome: EnrollmentOutcome\n');
  const result = applied(text, { op: 'renameType', interfaceId: 'enrollment-api', typeName: 'EnrollmentOutcome', newName: 'PlanOutcome' });
  let expected = variant(text, '              EnrollmentOutcome:\n', '              PlanOutcome:\n');
  expected = variant(expected, 'output: EnrollmentOutcome\n', 'output: PlanOutcome\n');
  expected = variant(expected, 'previous: EnrollmentOutcome[]\n', 'previous: PlanOutcome[]\n');
  assert.equal(result.text, expected);
  assert.deepEqual(result.selection, { interfaceId: 'enrollment-api', typeName: 'PlanOutcome' });
});

test('setType refuses to delete a referenced type', () => {
  const refused = refusalOf(COURSE, { op: 'setType', interfaceId: 'enrollment-api', typeName: 'EnrollmentOutcome', value: null });
  assert.equal(refused.error, 'type-in-use');
  assert.deepEqual(refused.uses, ['submit-plan output']);
});

test('setVocabularyTerm writes the top-level and the interface vocabulary', () => {
  const shared = applied(COURSE, { op: 'setVocabularyTerm', interfaceId: null, term: 'term', meaning: 'one academic quarter' });
  assert.ok(shared.text.includes('most courses are worth 4 quarter units\n  term: one academic quarter\n'), shared.text);
  const local = applied(COURSE, { op: 'setVocabularyTerm', interfaceId: 'tuition-charges', term: 'charge', meaning: 'one amount owed' });
  assert.deepEqual(loaded(local.text).model.interfaces.get('tuition-charges').vocabulary.map((v) => [v.term, v.meaning]),
    [['charge', 'one amount owed']]);
});

// ---- Identity and cascades -------------------------------------------------------------------

test('changeInterfaceId rewrites uses and selectors', () => {
  const text = variant(COURSE, 'enterprise: UCLA\n', 'enterprise: UCLA\nview: interface enrollment-api\n');
  const result = applied(text, { op: 'changeInterfaceId', interfaceId: 'enrollment-api', newId: 'enrollments' });
  let expected = variant(text, 'view: interface enrollment-api\n', 'view: interface enrollments\n');
  expected = variant(expected, 'uses: enrollment-api.submit-plan}', 'uses: enrollments.submit-plan}');
  expected = variant(expected, '          enrollment-api:\n', '          enrollments:\n');
  assert.equal(result.text, expected);
  assert.deepEqual(result.selection, { interfaceId: 'enrollments' });

  assert.equal(refusalOf(SHOP, { op: 'changeInterfaceId', interfaceId: 'app', newId: 'shop-app' }).error, 'shorthand');
  assert.equal(refusalOf(COURSE, { op: 'changeInterfaceId', interfaceId: 'enrollment-api', newId: 'tuition-charges' }).error, 'id-taken');
  assert.equal(refusalOf(COURSE, { op: 'changeInterfaceId', interfaceId: 'enrollment-api', newId: 'Tuition-Charges' }).error, 'id-taken');
  assert.equal(refusalOf(COURSE, { op: 'changeInterfaceId', interfaceId: 'enrollment-api', newId: 'billing' }).error, 'id-taken');
  assert.equal(refusalOf(COURSE, { op: 'changeInterfaceId', interfaceId: 'enrollment-api', newId: 'enrollments.v2' }).error, 'id-format');
});

const STEP_USES = '      - {from: web, to: coordinator, description: submits the plan to, uses: enrollment-api.submit-plan}\n';

test('renameOperation rewrites operation uses only', () => {
  let text = variant(COURSE, '      - web -> coordinator: submits the plan to\n', STEP_USES);
  text = variant(text, '        collaborators:\n          coordinator:',
    '        collaborators:\n          api: {description: reads course data from, uses: enrollment-api}\n          coordinator:');
  assert.deepEqual(rulesOf(text).filter((rule) => rule.startsWith('model/')), []);
  const result = applied(text, { op: 'renameOperation', interfaceId: 'enrollment-api', operationId: 'submit-plan', newId: 'enroll' });
  let expected = variant(text, '              submit-plan:\n', '              enroll:\n');
  expected = variant(expected, 'technology: JSON/HTTPS, uses: enrollment-api.submit-plan}', 'technology: JSON/HTTPS, uses: enrollment-api.enroll}');
  expected = variant(expected, STEP_USES, STEP_USES.replace('submit-plan', 'enroll'));
  assert.equal(result.text, expected);
  assert.ok(result.text.includes('uses: enrollment-api}'), 'a whole-interface use stays');
  assert.deepEqual(result.selection, { interfaceId: 'enrollment-api', operationId: 'enroll' });
});

test('changeElementId rewrites the shorthand interface\'s references and of-clauses', () => {
  let text = variant(SHOP_WITH_USE, 'name: Campus Shop\nsystems:', 'name: Campus Shop\nview: interface app\nsystems:');
  text += 'views:\n  shop-interfaces: {view: interfaces of app}\n  card-card: {view: interface card-payments of payments}\n';
  assert.deepEqual(rulesOf(text).filter((rule) => rule.startsWith('model/') || rule.startsWith('view/')), []);

  const renamed = applied(text, { op: 'changeElementId', elementId: 'app', newId: 'shop-app' });
  assert.ok(renamed.text.includes('uses: shop-app.post-orders}'));
  assert.ok(renamed.text.includes('{view: interfaces of shop-app}'));
  assert.ok(renamed.text.includes('view: interface shop-app\n'));
  assert.ok(renamed.text.includes('      shop-app: {description: confirms each paid order to'));
  assert.deepEqual(rulesOf(renamed.text).filter((rule) => rule.startsWith('model/') || rule.startsWith('view/')), []);

  const provider = applied(text, { op: 'changeElementId', elementId: 'payments', newId: 'card-provider' });
  assert.ok(provider.text.includes('{view: interface card-payments of card-provider}'));
  assert.deepEqual(rulesOf(provider.text).filter((rule) => rule.startsWith('model/') || rule.startsWith('view/')), []);
});

test('renames keep how a selector is written, with suffix included', () => {
  const text = SHOP_WITH_USE + 'views:\n' +
    '  shop-styles: {view: Container  of shop WITH Styles}\n' +
    '  card-card: {view: Interface Card-Payments  Of payments}\n' +
    'layout:\n' +
    '  Containers of shop with interfaces:\n' +
    '    app: [10, 20]\n';
  assert.deepEqual(rulesOf(text).filter((rule) => rule.startsWith('model/') || rule.startsWith('view/')), []);

  const store = applied(text, { op: 'changeElementId', elementId: 'shop', newId: 'store' });
  let expected = variant(text, '  shop:\n    name: Campus Shop\n', '  store:\n    name: Campus Shop\n');
  expected = variant(expected, '{view: Container  of shop WITH Styles}', '{view: Container  of store WITH Styles}');
  expected = variant(expected, '  Containers of shop with interfaces:\n', '  Containers of store with interfaces:\n');
  assert.equal(store.text, expected);

  const cards = applied(text, { op: 'changeInterfaceId', interfaceId: 'card-payments', newId: 'cards' });
  assert.ok(cards.text.includes('{view: Interface cards  Of payments}'), cards.text);
  const provider = applied(text, { op: 'changeElementId', elementId: 'payments', newId: 'card-provider' });
  assert.ok(provider.text.includes('{view: Interface Card-Payments  Of card-provider}'), provider.text);
});

test('changeElementId refuses an id an interface already has, ignoring case', () => {
  assert.equal(refusalOf(COURSE, { op: 'changeElementId', elementId: 'db', newId: 'Enrollment-API' }).error, 'id-taken');
  applied(SHOP, { op: 'changeElementId', elementId: 'app', newId: 'App' });
});

// An interface may share its own provider's id (spec §4.11; the model accepts it).
test('an interface may take its own provider\'s id, and its provider may take its interface\'s id', () => {
  const added = applied(COURSE, { op: 'addInterface', elementId: 'api', name: 'Api', id: 'api' });
  assert.deepEqual(added.selection, { elementId: 'api', interfaceId: 'api' });
  assert.deepEqual(rulesOf(added.text), []);

  const renamedInterface = applied(COURSE, { op: 'changeInterfaceId', interfaceId: 'enrollment-api', newId: 'api' });
  assert.deepEqual(renamedInterface.selection, { interfaceId: 'api' });
  assert.deepEqual(rulesOf(renamedInterface.text), []);

  const renamedProvider = applied(COURSE, { op: 'changeElementId', elementId: 'api', newId: 'enrollment-api' });
  assert.deepEqual(renamedProvider.selection, { elementId: 'enrollment-api' });
  assert.deepEqual(rulesOf(renamedProvider.text), []);

  assert.equal(refusalOf(COURSE, { op: 'addInterface', elementId: 'web', name: 'X', id: 'api' }).error, 'id-taken',
    'another element\'s id stays taken');
  assert.equal(refusalOf(COURSE, { op: 'changeInterfaceId', interfaceId: 'enrollment-api', newId: 'web' }).error, 'id-taken');
  assert.equal(refusalOf(COURSE, { op: 'changeElementId', elementId: 'web', newId: 'enrollment-api' }).error, 'id-taken',
    'another provider\'s interface id stays taken');
});

// ---- Layout keys -----------------------------------------------------------------------------

// A plain view and its annotated view share one layout entry, keyed without the suffix (spec §4.8, §4.10).
test('pinning in an annotated view writes the layout entry of its plain view', () => {
  const plain = applied(COURSE, { op: 'pinPosition', viewKey: 'containers of registration', elementId: 'web', x: 10, y: 20 });
  const annotated = applied(plain.text, { op: 'pinPosition', viewKey: 'containers of registration with interfaces', elementId: 'api', x: 30, y: 40 });
  assert.deepEqual(dataAt(annotated.text, ['layout']), { 'containers of registration': { web: ['10', '20'], api: ['30', '40'] } });
  assert.deepEqual(loaded(annotated.text).diagnostics, []);

  const fresh = applied(COURSE, { op: 'pinPosition', viewKey: 'Container of registration WITH interfaces', elementId: 'api', x: 30, y: 40 });
  assert.deepEqual(dataAt(fresh.text, ['layout']), { 'containers of registration': { api: ['30', '40'] } });
  const unpinned = applied(annotated.text, { op: 'unpinPosition', viewKey: 'containers of registration with interfaces', elementId: 'web' });
  assert.deepEqual(dataAt(unpinned.text, ['layout']), { 'containers of registration': { api: ['30', '40'] } });
});

test('deletes never edit inside a removed subtree', () => {
  // (a) A use of an interface whose provider is deleted inside the surviving target loses only that entry.
  let endpoint = variant(COURSE,
    'coordinator: {description: submits plans to, technology: JSON/HTTPS, uses: enrollment-api.submit-plan}',
    'api: {description: makes calls to, technology: JSON/HTTPS, uses: coordinator.evaluate}');
  endpoint = variant(endpoint, '            technology: Python module\n            stereotypes: [coordinator]\n',
    '            technology: Python module\n            stereotypes: [coordinator]\n            provides: ["evaluate(plan) -> EnrollmentOutcome"]\n');
  assert.deepEqual(rulesOf(endpoint).filter((rule) => rule.startsWith('model/')), []);
  const deleted = applied(endpoint, { op: 'deleteElement', elementId: 'coordinator' });
  assert.deepEqual(dataAt(deleted.text, WEB_COLLABORATORS.concat('api')), { description: 'makes calls to', technology: 'JSON/HTTPS' });

  // (b) The use inside a removed collaborator goes with it, in one edit.
  const billingGatewayCollaborators = ['systems', 'registration', 'containers', 'api', 'components', 'billing-gateway', 'collaborators'];
  const range = y.rangeOf(y.parse(COURSE), billingGatewayCollaborators, 'value');
  const billing = applied(COURSE, { op: 'deleteElement', elementId: 'billing' });
  const touching = billing.edits.filter((e) => e.offset < range.endOffset && e.offset + e.length > range.offset);
  assert.equal(touching.length, 1);
  assert.equal(dataAt(billing.text, billingGatewayCollaborators), undefined);

  // (c) The listing names the collaborator, not the use inside it.
  const dependents = edit.dependentsOf(design(COURSE), 'api');
  assert.ok(dependents.some((d) => JSON.stringify(d.path) === JSON.stringify(WEB_COLLABORATORS.concat('coordinator'))));
  assert.deepEqual(dependents.filter((d) => d.kind === 'uses'), []);
  assert.ok(dependents.every((d) => !dependents.some((other) => other !== d && other.path.length < d.path.length &&
    other.path.every((segment, i) => d.path[i] === segment))), 'no listed path lies inside another');

  // (d) A surviving ancestor's operation stops realizing the deleted descendant's responsibility.
  let realizing = variant(COURSE, 'realizes: [api-eligibility, api-holds, api-billing]', 'realizes: [api-eligibility, policy-decide-1]');
  realizing = variant(realizing, '                refines: api-eligibility\n',
    '                refines: api-eligibility\n                id: policy-decide-1\n');
  const policy = applied(realizing, { op: 'deleteElement', elementId: 'policy' });
  assert.ok(policy.text.includes('                realizes: [api-eligibility]\n'));
  assert.deepEqual(edit.dependentsOf(design(realizing), 'policy').filter((d) => d.kind === 'realizes').map((d) => d.path),
    [SUBMIT_PLAN.concat('realizes', 1)]);
});

test('removeOperation and removeResponsibility cascade', () => {
  const operation = applied(COURSE, { op: 'removeOperation', interfaceId: 'enrollment-api', operationId: 'submit-plan' });
  assert.deepEqual(dataAt(operation.text, WEB_COLLABORATORS.concat('coordinator')), { description: 'submits plans to', technology: 'JSON/HTTPS' });
  assert.equal(dataAt(operation.text, ENROLLMENT_API.concat('operations')), undefined);

  const responsibility = applied(COURSE, { op: 'removeResponsibility', elementId: 'api', index: 1 });
  assert.deepEqual(dataAt(responsibility.text, SUBMIT_PLAN.concat('realizes')), ['api-eligibility', 'api-billing']);
});

test('removeInterface removes the uses that name it, in relationships and steps', () => {
  const text = variant(COURSE, '      - web -> coordinator: submits the plan to\n', STEP_USES);
  assert.deepEqual(edit.interfaceDependentsOf(design(text), 'Enrollment-API').map((d) => [d.kind, d.path]), [
    ['uses', WEB_COLLABORATORS.concat('coordinator', 'uses')],
    ['uses', ['scenarios', 'enroll', 'steps', 0, 'uses']],
  ]);
  assert.deepEqual(edit.interfaceDependentsOf(design(text), 'no-such-interface'), []);
  const result = applied(text, { op: 'removeInterface', interfaceId: 'enrollment-api' });
  assert.deepEqual(result.selection, { elementId: 'api' });
  assert.equal(dataAt(result.text, ENROLLMENT_API), undefined);
  assert.equal(dataAt(result.text, API.concat('provides')), undefined, 'the emptied provides goes');
  assert.deepEqual(dataAt(result.text, ['scenarios', 'enroll', 'steps', 0]), { from: 'web', to: 'coordinator', description: 'submits the plan to' });
  assert.deepEqual(rulesOf(result.text).filter((rule) => rule.startsWith('model/')), []);
});

test('moving an element removes references that stop resolving', () => {
  const text = applied(COURSE, { op: 'addElement', parentId: 'registration', type: 'container', name: 'Worker' }).text;
  const usesPath = WEB_COLLABORATORS.concat('coordinator', 'uses');
  assert.deepEqual(edit.dependentsOf(design(text), 'coordinator', { newParentId: 'worker' }).map((d) => [d.kind, d.path]),
    [['uses', usesPath]]);
  const moved = applied(text, { op: 'moveElement', elementId: 'coordinator', newParentId: 'worker' });
  assert.equal(dataAt(moved.text, usesPath), undefined);
  assert.equal(typeof dataAt(moved.text, ['systems', 'registration', 'containers', 'worker', 'components', 'coordinator']), 'object');
  assert.deepEqual(rulesOf(moved.text).filter((rule) => rule.startsWith('model/')), []);
});

test('setList refuses a full-form provides', () => {
  assert.equal(refusalOf(COURSE, { op: 'setList', elementId: 'api', field: 'provides', items: ['x'] }).error, 'provides-full-form');
  const result = applied(SHOP, { op: 'setList', elementId: 'app', field: 'provides', items: ['GET /readers/{id}', 'POST /orders', 'DELETE /orders/{id}'] });
  assert.deepEqual(dataAt(result.text, ['systems', 'shop', 'containers', 'app', 'provides']),
    ['GET /readers/{id}', 'POST /orders', 'DELETE /orders/{id}']);
});

// ---- Milestone 1 commands on the interface fixture (Review Focus 3) ----------------------------

/** Every Milestone 1 element command that applies to `reference`, with the shape its edits must have. */
function elementCommands(reference) {
  const commands = [];
  for (const element of reference.model.elements.values()) {
    const id = element.id;
    commands.push([{ op: 'deleteElement', elementId: id }, 'deletion']);
    commands.push([{ op: 'changeElementId', elementId: id, newId: `${id}Renamed` }, 'rename']);
    commands.push([{ op: 'setElementField', elementId: id, field: 'source', value: 'src/x' }, 'insertion']);
    commands.push([{ op: 'setElementField', elementId: id, field: 'name', value: null }, 'deletion']);
    const childType = { system: 'container', container: 'component', component: 'code' }[element.type];
    if (childType) commands.push([{ op: 'addElement', parentId: id, type: childType, name: 'Added Part' }, 'insertion']);
    if (element.type === 'component' && element.parentId === 'api') {
      commands.push([{ op: 'moveElement', elementId: id, newParentId: 'web' }, 'move']);
    }
  }
  return commands;
}

/** The Milestone 1 detail commands, as their own suite runs them on the Milestone 1 fixture. */
const DETAIL_COMMANDS = [
  [{ op: 'addResponsibility', elementId: 'api', kind: 'do', text: 'log every attempt' }, 'insertion'],
  [{ op: 'updateResponsibility', elementId: 'api', index: 0, text: 'decide eligibility' }],
  [{ op: 'updateResponsibility', elementId: 'seats', index: 0, kind: 'do', refines: 'api-holds' }],
  [{ op: 'removeResponsibility', elementId: 'api', index: 1 }, 'deletion'],
  [{ op: 'moveResponsibility', elementId: 'coordinator', from: 0, to: 1 }],
  [{ op: 'ensureResponsibilityId', elementId: 'coordinator', index: 0 }, 'insertion'],
  [{ op: 'addRelationship', sourceId: 'web', targetId: 'api', description: 'loads course data from' }, 'insertion'],
  [{ op: 'addRelationship', sourceId: 'coordinator', targetId: 'policy', description: 'asks for a waiver decision from', technology: 'Python call' }],
  [{ op: 'updateRelationship', relationshipId: 'web->coordinator', description: 'submits finished plans to' }],
  [{ op: 'updateRelationship', relationshipId: 'coordinator->policy', technology: 'Python call' }],
  [{ op: 'removeRelationship', relationshipId: 'billing-gateway->billing' }, 'deletion'],
  [{ op: 'setList', elementId: 'seats', field: 'owns', items: ['seat holds', 'waitlists'] }],
  [{ op: 'setChoices', elementId: 'api', choices: { styles: ['layers', 'client-server'] } }],
  [{ op: 'setChoices', relationshipId: 'coordinator->seats', choices: { tactics: ['retry'] } }],
  [{ op: 'addScenario', title: 'Drop a section' }, 'insertion'],
  [{ op: 'addStep', scenarioId: 'enroll', containerPath: [], index: 0, step: { from: 'student', to: 'web', description: 'opens the planner in' } }, 'insertion'],
  [{ op: 'addStep', scenarioId: 'enroll', containerPath: [2, 'alt', 1], index: 1, step: { from: 'web', to: 'coordinator', description: 'asks again', connector: 'message' } }, 'insertion'],
  [{ op: 'updateStep', scenarioId: 'enroll', containerPath: [], index: 0, step: { description: 'submits a plan to' } }],
  [{ op: 'removeStep', scenarioId: 'enroll', containerPath: [2, 'alt', 0], index: 0 }, 'deletion'],
  [{ op: 'moveStep', scenarioId: 'enroll', containerPath: [], from: 0, to: 1 }],
  [{ op: 'addFragment', scenarioId: 'enroll', containerPath: [], index: 3, operator: 'loop' }, 'insertion'],
  [{ op: 'addEnvironment', name: 'Staging' }, 'insertion'],
  [{ op: 'addNode', environmentId: 'production', parentNodeId: 'campus-cloud', kind: 'infrastructure', name: 'Firewall' }, 'insertion'],
  [{ op: 'updateNode', environmentId: 'production', nodeId: 'api-pod', field: 'instances', value: 5 }],
  [{ op: 'removeNode', environmentId: 'production', nodeId: 'api-pod' }, 'deletion'],
  [{ op: 'setHosts', environmentId: 'production', nodeId: 'postgres', hosts: ['db', 'api'] }],
  [{ op: 'setTopLevelEntry', section: 'requirements', id: 'FR-10', value: 'A student can drop a section.' }, 'insertion'],
  [{ op: 'setTopLevelEntry', section: 'views', id: 'storage', value: { view: 'containers of registration', include: ['db'] } }, 'insertion'],
  [{ op: 'removeTopLevelEntry', section: 'decisions', id: 'one-database' }, 'deletion'],
  [{ op: 'pinPosition', viewKey: 'containers of registration', elementId: 'api', x: 120, y: 40 }],
  [{ op: 'unpinPosition', viewKey: 'containers of registration', elementId: 'api' }, 'deletion'],
  [{ op: 'ensureSchemaHeader' }, 'insertion'],
  [{ op: 'batch', commands: [
    { op: 'addElement', parentId: 'registration', type: 'container', name: 'Search Index' },
    { op: 'pinPosition', viewKey: 'containers of registration', elementId: 'search-index', x: 0, y: 0 },
  ] }, 'one splice'],
];

/** Fails unless `result` succeeded, its edits produce its text without YAML errors, and they have `shape`. */
function assertPreserving(text, command, result, shape) {
  const where = JSON.stringify(command);
  assert.equal(result.error, undefined, `${where}: ${result.message}`);
  assert.equal(y.applyEdits(text, result.edits), result.text, where);
  assert.deepEqual(y.parse(result.text).errors, [], where);
  if (shape === 'insertion') assert.ok(result.edits.every((e) => e.length === 0), `${where} only inserts`);
  if (shape === 'deletion') assert.ok(result.edits.every((e) => e.text === ''), `${where} only deletes`);
  if (shape === 'one splice') assert.equal(result.edits.length, 1, where);
  if (shape === 'rename') {
    const renamed = (span) => span.replace(new RegExp(`(?<![A-Za-z0-9_-])${command.elementId}(?![A-Za-z0-9_-])`, 'g'), command.newId);
    for (const e of result.edits) assert.equal(e.text, renamed(text.slice(e.offset, e.offset + e.length)), `${where} only renames`);
  }
  if (shape === 'move') {
    // `web` has no components yet, so the moved entry arrives under a new `components:` key, unchanged; any other
    // edit removes a reference that stopped resolving.
    const insertion = result.edits.find((e) => e.length === 0 && e.text.startsWith('        components:\n'));
    const removal = result.edits.find((e) => insertion && e.text === '' &&
      insertion.text === '        components:\n' + text.slice(e.offset, e.offset + e.length));
    assert.ok(insertion && removal, `${where} moves the entry's text`);
    assert.ok(result.edits.every((e) => e === insertion || e.text === ''), `${where} otherwise only deletes`);
  }
}

test('every Milestone 1 command leaves text outside its edits unchanged on the interface fixture', () => {
  const reference = design(COURSE);
  for (const [command, shape] of elementCommands(reference).concat(DETAIL_COMMANDS)) {
    assertPreserving(COURSE, command, edit.apply(reference, command), shape);
  }
});

// ---- Every interface command -----------------------------------------------------------------

const EXAMPLE_INPUT = '{student_id: "905123456", term: 2027-spring, section_ids: ["187204"]}';

const COURSE_COMMANDS = [
  [{ op: 'addInterface', elementId: 'web', name: 'Planner Links', style: 'rest', technology: 'HTTPS' }, 'insertion'],
  [{ op: 'updateInterface', interfaceId: 'enrollment-api', field: 'version', value: '1.10' }],
  [{ op: 'updateInterface', interfaceId: 'tuition-charges', field: 'description', value: null }, 'deletion'],
  [{ op: 'removeInterface', interfaceId: 'enrollment-api' }, 'deletion'],
  [{ op: 'changeInterfaceId', interfaceId: 'enrollment-api', newId: 'enrollments' }],
  [{ op: 'setRestrictions', interfaceId: 'enrollment-api', operationId: 'submit-plan', items: ['Only while enrollment is open.'] }, 'insertion'],
  [{ op: 'setRestrictions', interfaceId: 'tuition-charges', items: [] }, 'deletion'],
  [{ op: 'addOperation', interfaceId: 'tuition-charges', syntax: 'send RefundRequested to the queue billing.refunds' }, 'insertion'],
  [{ op: 'updateOperation', interfaceId: 'enrollment-api', operationId: 'submit-plan', field: 'purpose', value: 'Enrolls a student.' }],
  [{ op: 'updateOperation', interfaceId: 'tuition-charges', operationId: 'charge-tuition', field: 'output', value: 'str' }, 'insertion'],
  [{ op: 'renameOperation', interfaceId: 'enrollment-api', operationId: 'submit-plan', newId: 'enroll' }],
  [{ op: 'removeOperation', interfaceId: 'tuition-charges', operationId: 'charge-tuition' }, 'deletion'],
  [{ op: 'setError', interfaceId: 'tuition-charges', name: 'queue-full', value: 'the queue is full; the sender tries again later' }, 'insertion'],
  [{ op: 'setError', interfaceId: 'enrollment-api', operationId: 'submit-plan', name: 'invalid-plan', value: null }, 'deletion'],
  [{ op: 'addExample', interfaceId: 'enrollment-api', operationId: 'submit-plan', inputText: EXAMPLE_INPUT, note: 'One section.' }, 'insertion'],
  [{ op: 'updateExample', interfaceId: 'enrollment-api', operationId: 'submit-plan', index: 0, outputText: '{status: refused}' }],
  [{ op: 'removeExample', interfaceId: 'tuition-charges', operationId: 'charge-tuition', index: 0 }, 'deletion'],
  [{ op: 'setType', interfaceId: 'enrollment-api', typeName: 'Section', value: { description: 'One scheduled offering.' } }, 'insertion'],
  [{ op: 'renameType', interfaceId: 'enrollment-api', typeName: 'EnrollmentRequest', newName: 'PlanRequest' }],
  [{ op: 'setField', interfaceId: 'enrollment-api', owner: { typeName: 'EnrollmentRequest' }, fieldName: 'note', field: { type: 'string', required: false } }, 'insertion'],
  [{ op: 'setField', interfaceId: 'tuition-charges', owner: { operationId: 'charge-tuition', part: 'output' }, fieldName: 'accepted', field: { type: 'boolean' } }, 'insertion'],
  [{ op: 'renameField', interfaceId: 'enrollment-api', owner: { typeName: 'EnrollmentOutcome' }, fieldName: 'reason', newName: 'refusal_reason' }],
  [{ op: 'setValues', interfaceId: 'enrollment-api', owner: { typeName: 'EnrollmentRequest' }, fieldName: 'term', values: ['2027-winter', '2027-spring'] }, 'insertion'],
  [{ op: 'setVocabularyTerm', interfaceId: null, term: 'term', meaning: 'one academic quarter' }, 'insertion'],
  [{ op: 'setVocabularyTerm', interfaceId: 'enrollment-api', term: 'plan', meaning: null }, 'deletion'],
  [{ op: 'setUses', relationshipId: 'web->coordinator', uses: [] }, 'deletion'],
  [{ op: 'deleteElement', elementId: 'billing' }, 'deletion'],
  [{ op: 'changeElementId', elementId: 'api', newId: 'registration-api' }],
];

const SHOP_COMMANDS = [
  [{ op: 'expandProvidesShorthand', elementId: 'app' }, 'one splice'],
  [{ op: 'addInterface', elementId: 'app', name: 'Order Events' }, 'one splice'],
  [{ op: 'setList', elementId: 'app', field: 'provides', items: ['GET /readers/{id}', 'POST /orders', 'DELETE /orders/{id}'] }],
  [{ op: 'addOperation', interfaceId: 'app', syntax: 'DELETE /orders/{id}' }, 'insertion'],
  [{ op: 'updateOperation', interfaceId: 'app', operationId: 'post-orders', field: 'syntax', value: 'POST /v2/orders' }],
  [{ op: 'removeOperation', interfaceId: 'app', operationId: 'get-readers-id' }, 'deletion'],
  [{ op: 'moveOperation', interfaceId: 'app', from: 1, to: 0 }],
  [{ op: 'moveOperation', interfaceId: 'card-payments', from: 1, to: 0 }],
  [{ op: 'changeInterfaceId', interfaceId: 'card-payments', newId: 'cards' }],
  [{ op: 'updateOperation', interfaceId: 'card-payments', operationId: 'refund', field: 'purpose', value: 'Returns money.' }],
  [{ op: 'setField', interfaceId: 'card-payments', owner: { typeName: 'Charge' }, fieldName: 'status', field: { type: 'string', meaning: 'whether the money moved', values: { succeeded: 'the money moved', failed: 'nothing was charged' } } }],
  [{ op: 'setField', interfaceId: 'card-payments', owner: { typeName: 'Charge' }, fieldName: 'id', field: { type: 'string', meaning: 'identifies the charge' } }],
  [{ op: 'setValues', interfaceId: 'card-payments', owner: { typeName: 'Charge' }, fieldName: 'status', values: ['succeeded', 'failed', 'pending'] }],
  [{ op: 'setVocabularyTerm', interfaceId: 'card-payments', term: 'idempotency key', meaning: null }, 'deletion'],
  [{ op: 'setUses', relationshipId: 'app->payments', uses: ['card-payments'] }],
  [{ op: 'renameType', interfaceId: 'card-payments', typeName: 'Charge', newName: 'ChargeResult' }],
  [{ op: 'deleteElement', elementId: 'payments' }, 'deletion'],
  [{ op: 'changeElementId', elementId: 'app', newId: 'shop-app' }],
];

const EVENT_COMMANDS = [
  [{ op: 'setUses', relationshipId: 'orders->analytics', uses: [] }, 'deletion'],
  [{ op: 'setUses', relationshipId: 'shipping->order-topic', uses: ['order-events'] }],
  [{ op: 'removeInterface', interfaceId: 'order-events' }, 'deletion'],
  [{ op: 'renameOperation', interfaceId: 'order-events', operationId: 'order-placed', newId: 'placed' }],
  [{ op: 'addExample', interfaceId: 'order-events', operationId: 'order-placed', outputText: '{order_id: o-1002, total: 0}' }, 'insertion'],
  [{ op: 'setError', interfaceId: 'order-events', operationId: 'order-placed', name: 'late', value: { when: 'the broker is down', code: '0' } }, 'insertion'],
  [{ op: 'deleteElement', elementId: 'orders' }, 'deletion'],
  [{ op: 'moveElement', elementId: 'shipping', newParentId: 'analytics' }],
];

/** The interface fixture with every indentation step four spaces wide, comments and flow styles kept. */
function fourSpaceCopy(text) {
  return YAML.parseDocument(text, { schema: 'failsafe' }).toString({ indent: 4, lineWidth: 0 });
}

const PRESERVATION_CASES = [
  ['the interface fixture', COURSE, COURSE_COMMANDS],
  ['the shop fixture', SHOP, SHOP_COMMANDS],
  ['the event fixture', EVENTS, EVENT_COMMANDS],
  ['a four-space copy', fourSpaceCopy(COURSE), COURSE_COMMANDS],
  ['a CRLF copy', COURSE.replace(/\n/g, '\r\n'), COURSE_COMMANDS],
];

test('every interface command leaves text outside its edits unchanged', () => {
  for (const [name, text, commands] of PRESERVATION_CASES) {
    const reference = design(text);
    assert.deepEqual(reference.parsed.errors, [], name);
    for (const [command, shape] of commands) {
      const result = edit.apply(reference, command);
      assert.equal(result.error, undefined, `${name}: ${JSON.stringify(command)}: ${result.message}`);
      assertPreserving(text, command, result, shape);
      if (text.includes('\r\n')) assert.doesNotMatch(result.text, /(^|[^\r])\n/, `${JSON.stringify(command)} writes only \\r\\n`);
    }
  }
});

/** Pairs of a command that adds something and the command that removes it again (given the first result). */
const ADD_THEN_REMOVE = [
  ['interface', COURSE, { op: 'addInterface', elementId: 'web', name: 'Planner Links' },
    (added) => ({ op: 'removeInterface', interfaceId: added.selection.interfaceId })],
  ['operation', COURSE, { op: 'addOperation', interfaceId: 'tuition-charges', syntax: 'send RefundRequested to the queue billing.refunds' },
    (added) => ({ op: 'removeOperation', interfaceId: 'tuition-charges', operationId: added.selection.operationId })],
  ['interface error', COURSE, { op: 'setError', interfaceId: 'tuition-charges', name: 'queue-full', value: { when: 'the queue is full', code: '503' } },
    () => ({ op: 'setError', interfaceId: 'tuition-charges', name: 'queue-full', value: null })],
  ['operation error', EVENTS, { op: 'setError', interfaceId: 'order-events', operationId: 'order-placed', name: 'late', value: 'the broker is down' },
    () => ({ op: 'setError', interfaceId: 'order-events', operationId: 'order-placed', name: 'late', value: null })],
  ['interface restriction', SHOP, { op: 'setRestrictions', interfaceId: 'card-payments', items: ['Callers use HTTPS.'] },
    () => ({ op: 'setRestrictions', interfaceId: 'card-payments', items: [] })],
  ['operation restriction', COURSE, { op: 'setRestrictions', interfaceId: 'enrollment-api', operationId: 'submit-plan', items: ['Only while enrollment is open.'] },
    () => ({ op: 'setRestrictions', interfaceId: 'enrollment-api', operationId: 'submit-plan', items: [] })],
  ['example', COURSE, { op: 'addExample', interfaceId: 'enrollment-api', operationId: 'submit-plan', inputText: EXAMPLE_INPUT, outputText: '{status: refused}' },
    () => ({ op: 'removeExample', interfaceId: 'enrollment-api', operationId: 'submit-plan', index: 1 })],
  ['first example', EVENTS, { op: 'addExample', interfaceId: 'order-events', operationId: 'order-placed', note: 'No order was placed.' },
    () => ({ op: 'removeExample', interfaceId: 'order-events', operationId: 'order-placed', index: 1 })],
  ['type', COURSE, { op: 'setType', interfaceId: 'enrollment-api', typeName: 'Section', value: { description: 'One scheduled offering.' } },
    () => ({ op: 'setType', interfaceId: 'enrollment-api', typeName: 'Section', value: null })],
  ['field', COURSE, { op: 'setField', interfaceId: 'enrollment-api', owner: { typeName: 'EnrollmentRequest' }, fieldName: 'note', field: { type: 'string', required: false } },
    () => ({ op: 'setField', interfaceId: 'enrollment-api', owner: { typeName: 'EnrollmentRequest' }, fieldName: 'note', field: null })],
  ['inline field', COURSE, { op: 'setField', interfaceId: 'tuition-charges', owner: { operationId: 'charge-tuition', part: 'output' }, fieldName: 'accepted', field: { type: 'boolean', meaning: 'whether Billing took the request' } },
    () => ({ op: 'setField', interfaceId: 'tuition-charges', owner: { operationId: 'charge-tuition', part: 'output' }, fieldName: 'accepted', field: null })],
  ['value', COURSE, { op: 'setValues', interfaceId: 'enrollment-api', owner: { typeName: 'EnrollmentRequest' }, fieldName: 'term', values: ['2027-winter', '2027-spring'] },
    () => ({ op: 'setValues', interfaceId: 'enrollment-api', owner: { typeName: 'EnrollmentRequest' }, fieldName: 'term', values: null })],
  ['shared vocabulary term', COURSE, { op: 'setVocabularyTerm', interfaceId: null, term: 'term', meaning: 'one academic quarter' },
    () => ({ op: 'setVocabularyTerm', interfaceId: null, term: 'term', meaning: null })],
  ['interface vocabulary term', COURSE, { op: 'setVocabularyTerm', interfaceId: 'tuition-charges', term: 'charge', meaning: 'one amount owed' },
    () => ({ op: 'setVocabularyTerm', interfaceId: 'tuition-charges', term: 'charge', meaning: null })],
  ['uses', SHOP, { op: 'setUses', relationshipId: 'app->payments', uses: ['card-payments.charge', 'card-payments.refund'] },
    () => ({ op: 'setUses', relationshipId: 'app->payments', uses: ['card-payments.charge'] })],
];

test('add then remove restores the original text', () => {
  for (const [name, text, add, remove] of ADD_THEN_REMOVE) {
    const added = applied(text, add);
    assert.notEqual(added.text, text, `${name} changes the text`);
    assert.equal(applied(added.text, remove(added)).text, text, name);
  }
});

test('commands are refused while YAML errors exist', () => {
  const broken = design('systems:\n  shop: {name: Shop, provides: [GET /x\n');
  assert.deepEqual(edit.apply(broken, { op: 'addOperation', interfaceId: 'shop', syntax: 'GET /y' }), { error: 'yaml-errors' });
});
