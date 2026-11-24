'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Yaml = require('../../vendor/yaml/2.9.1/yaml.js');
const y = require('../../c4/c4-yaml.js');
const modelApi = require('../../c4/c4-model.js');
const checks = require('../../c4/c4-checks.js');
const query = require('../../c4/c4-query.js');
const { fixture } = require('./helpers.js');

const REFERENCE_TEXT = fixture('course-registration-interfaces.yml');
const SEED_TEXT = fixture('interfaces-step2-seed.yml');
const SPEC_PATH = path.join(__dirname, '..', '..', '..', '..', 'docs', 'superpowers', 'specs', '2026-11-08-c4-model-design.md');

function load(text) {
  return modelApi.normalize(y.parse(text), { source: 'file' }).model;
}

const reference = load(REFERENCE_TEXT);
const seed = load(SEED_TEXT);

function runChecks(model, options) {
  return checks.applyConfig(checks.run(model), model, options);
}

function contextWith(overrides = {}) {
  return Object.assign({ seedModel: reference, checks: runChecks, rules: checks.RULES, checksConfig: {} }, overrides);
}

function evaluate(predicate, model = reference, context = contextWith()) {
  return query.evaluate(model, predicate, context);
}

function passes(predicate, model, context) {
  const result = evaluate(predicate, model, context);
  assert.equal(result.passed, true, result.message);
}

function fails(predicate, model, context) {
  const result = evaluate(predicate, model, context);
  assert.equal(result.passed, false, 'the predicate should fail');
  return result.message;
}

/** `base` text with `replacements` applied (each `from` must occur), loaded as a learner's edited file. */
function editedFrom(base, replacements) {
  const text = replacements.reduce((current, [from, to]) => {
    assert.ok(current.includes(from), `${from} is in the fixture`);
    return current.replace(from, to);
  }, base);
  return load(text);
}

const edited = (...replacements) => editedFrom(REFERENCE_TEXT, replacements);

const REALIZES_LINE = '                realizes: [api-eligibility, api-holds, api-billing]\n';
const POLICY_DECIDE = '              - decide: whether prerequisites and unit caps allow enrollment\n                refines: api-eligibility\n';
const SEATS_DO = '              - do: hold every requested seat atomically, or none\n                refines: api-holds\n';
const SUBMIT_PLAN_SYNTAX = '              submit-plan:\n                syntax: POST /v1/enrollments\n';
const WEB_USES = ', uses: enrollment-api.submit-plan}';

/** The reference model whose operation lists the two refining responsibilities instead of their parents. */
const REFINEMENT_EDITS = [
  [POLICY_DECIDE, POLICY_DECIDE.replace('refines', 'id: policy-decide-1\n                refines')],
  [SEATS_DO, SEATS_DO.replace('refines', 'id: seats-do-1\n                refines')],
  [REALIZES_LINE, '                realizes: [policy-decide-1, seats-do-1]\n'],
];

// ---- The spec section 8 examples ---------------------------------------------------------------

function specInterfaceExamples() {
  const spec = fs.readFileSync(SPEC_PATH, 'utf8');
  const anchor = spec.indexOf('Each example below passes on the §4.2 reference model');
  assert.ok(anchor > 0, 'the spec introduces the twelve interface examples');
  const block = /```yaml\n([\s\S]*?)```/.exec(spec.slice(anchor));
  return Yaml.parse(block[1]).tests;
}

const EXAMPLES = specInterfaceExamples();

test('the spec lists twelve interface examples', () => {
  assert.equal(EXAMPLES.length, 12);
});

test('the twelve interface examples in spec §8 pass on the reference model', () => {
  EXAMPLES.forEach(({ description, c4 }) => {
    const result = evaluate(c4);
    assert.equal(result.passed, true, `${description}: ${result.message}`);
  });
});

test('the step 2 seed passes only the examples it should', () => {
  const passed = EXAMPLES.map(({ c4 }) => evaluate(c4, seed, contextWith({ seedModel: seed })).passed);
  const passing = passed.flatMap((ok, index) => (ok ? [index + 1] : []));
  assert.deepEqual(passing, [1, 7, 8, 9]);
});

// ---- realizes (J12) ----------------------------------------------------------------------------

test('realizes counts refinements only when they cover the parent', () => {
  const covered = edited(...REFINEMENT_EDITS);
  passes({ exists: { operation: { of: 'enrollment-api', realizes: ['api-eligibility', 'api-holds'] } } }, covered);

  const firstRefinement = '                id: policy-decide-1\n                refines: api-eligibility\n';
  const secondRefinement = edited(...REFINEMENT_EDITS, [firstRefinement, `${firstRefinement}              - decide: whether the plan has at most eight sections\n`
    + '                id: policy-decide-2\n                refines: api-eligibility\n']);
  fails({ exists: { operation: { of: 'enrollment-api', realizes: 'api-eligibility' } } }, secondRefinement);
  passes({ exists: { operation: { of: 'enrollment-api', realizes: 'api-holds' } } }, secondRefinement);

  const holdsOnly = edited(...REFINEMENT_EDITS.slice(0, 2), [REALIZES_LINE, '                realizes: [api-holds]\n']);
  fails({ exists: { operation: { of: 'enrollment-api', realizes: ['api-eligibility', 'api-holds'] } } }, holdsOnly);
  passes({ exists: { operation: { of: 'enrollment-api', realizes: 'api-holds' } } }, holdsOnly);
});

test('realizes_any and realizes_at_least read the written list', () => {
  const linked = editedFrom(SEED_TEXT, [['                output: EnrollmentOutcome\n', '                output: EnrollmentOutcome\n                realizes: [coordinator-do-1]\n']]);
  passes({ exists: { operation: { of: 'enrollment-api', realizes_any: ['coordinator-do-1', 'seats-know-1'] } } }, linked);
  fails({ exists: { operation: { of: 'enrollment-api', realizes: 'api-eligibility' } } }, linked);
  passes({ exists: { operation: { of: 'enrollment-api', realizes_at_least: 1 } } }, linked);
  fails({ exists: { operation: { of: 'enrollment-api', realizes_at_least: 1 } } }, seed);
});

// ---- Inherited restrictions and errors, requests, uses -----------------------------------------

test('inherited restrictions and errors count for the operation', () => {
  const tenth = EXAMPLES[9].c4;
  passes(tenth);
  const withoutRestrictions = edited([
    '            restrictions:\n              - Only the Planner Web App may call it, acting for the signed-in student named in the request.\n'
      + '              - A student may send at most 10 requests per minute.\n', '']);
  fails(tenth, withoutRestrictions);
  passes({ exists: { operation: { of: 'enrollment-api', errors_at_least: 4 } } });
  fails({ exists: { operation: { of: 'enrollment-api', errors_at_least: 5 } } });
});

test('requests read the responsibilities realized by the used operation', () => {
  passes(EXAMPLES[10].c4);
  fails(EXAMPLES[10].c4, edited([WEB_USES, '}']));
  passes({ exists: { relationship: { from: 'web', to: 'api', requests: 'api-billing' } } });
});

test('whole-interface and operation uses match as specified', () => {
  const whole = edited([WEB_USES, ', uses: enrollment-api}']);
  passes({ exists: { relationship: { from: 'web', to: 'api', uses: 'enrollment-api' } } }, whole);
  fails({ exists: { relationship: { from: 'web', to: 'api', uses: 'enrollment-api.submit-plan' } } }, whole);
  passes({ exists: { relationship: { from: 'web', to: 'api', uses_interface: 'whole' } } }, whole);
  fails({ exists: { relationship: { from: 'web', to: 'api', uses_interface: 'whole' } } });
  passes({ exists: { relationship: { from: 'web', to: 'api', uses: ['tuition-charges', 'enrollment-api.submit-plan'] } } });
});

test('a declared summary relationship matches through the uses it inherits', () => {
  const summarized = edited(['    description: Plans term schedules and enrolls students in their sections.\n',
    '    description: Plans term schedules and enrolls students in their sections.\n'
    + '    collaborators:\n      billing: {description: requests tuition charges from, connector: message}\n']);
  passes({ exists: { relationship: { from: 'registration', to: 'billing', derived: 'exclude', uses: 'tuition-charges.charge-tuition' } } }, summarized);
  fails({ exists: { relationship: { from: 'registration', to: 'billing', derived: 'exclude', uses: 'enrollment-api' } } }, summarized);
});

test('uses_interface distinguishes relationships with and without interfaces', () => {
  passes({ exists: { relationship: { from: 'seats', to: 'db', uses_interface: 'absent' } } });
  fails({ exists: { relationship: { from: 'web', to: 'api', uses_interface: 'absent' } } });
});

// ---- Field filters -----------------------------------------------------------------------------

test('field filters read constraints, values, and type lists', () => {
  passes(EXAMPLES[11].c4);
  fails(EXAMPLES[11].c4, seed);
  fails({ exists: { operation: { of: 'enrollment-api', input_has_field: { name_any: ['section_ids'], constraints: 'absent' } } } });
  passes({ exists: { operation: { of: 'enrollment-api', output_has_field: { name_any: ['units_enrolled'], type_any: ['integer', 'number', 'decimal'] } } } });
});

test('a field type is compared in its standard spelling', () => {
  const listField = (type) => ({ exists: { operation: { of: 'enrollment-api', input_has_field: { name_any: ['section_ids'], type } } } });
  passes(listField('string[]'));
  passes(listField('List<string>'));
  fails(listField('string'));
});

test('values present, absent, and meaningful tell the three forms apart', () => {
  const statusValues = (values) => ({ exists: { operation: { of: 'enrollment-api', output_has_field: { name_any: ['status'], values } } } });
  passes(statusValues('meaningful'));
  passes(statusValues('present'));
  fails(statusValues('absent'));
  passes(statusValues('present'), seed);
  fails(statusValues('meaningful'), seed);
});

test('unit_any, meaning, and format read the field text', () => {
  passes({ exists: { operation: { of: 'enrollment-api', output_has_field: { name_any: ['decided_at'], format: 'present', unit: 'absent' } } } });
  fails({ exists: { operation: { of: 'enrollment-api', output_has_field: { name_any: ['decided_at'], unit_any: ['quarter'] } } } });
  passes({ exists: { operation: { of: 'tuition-charges', input_has_field: { name_any: ['amount'], unit_any: ['cents'], meaning: 'present' } } } }, reference);
});

// ---- Element, relationship, and interface queries ----------------------------------------------

test('provides_interface with an empty filter matches every provider', () => {
  const result = evaluate({ count: { element: { provides_interface: {} } }, equals: 3 });
  assert.equal(result.passed, true, result.message);
  assert.deepEqual([...result.matched].sort(), ['api', 'billing', 'coordinator']);
});

test('interface filters select by provider, containment, style, and use', () => {
  passes({ exists: { interface: { in: 'registration', style: 'rest' } } });
  passes({ exists: { interface: { of: 'billing', used_by: 'billing-gateway' } } });
  fails({ exists: { interface: { of: 'billing', used_by: 'web' } } });
  passes({ exists: { interface: { of: { type: 'container' }, name_any: ['enrollment'] } } });
  fails({ exists: { interface: { in: 'registration', style: 'message' } } });
});

test('operation filters select by interface, syntax, and the operation attributes', () => {
  passes({ exists: { operation: { of: { style: 'message' }, syntax_any: ['billing.charges'], examples_at_least: 1 } } });
  fails({ exists: { operation: { of: 'tuition-charges', purpose: 'absent' } } });
  passes({ exists: { operation: { id: 'charge-tuition', side_effects: 'present' } } });
  fails({ exists: { operation: { of: 'tuition-charges', id: 'submit-plan' } } });
});

// ---- same_as_seed on an interface --------------------------------------------------------------

test('same_as_seed on an interface compares the chosen part', () => {
  const asSeed = (part) => ({ same_as_seed: { interface: { id: 'enrollment-api' }, part } });
  const syntax = asSeed('syntax');
  const everything = { same_as_seed: { interface: { id: 'enrollment-api' } } };
  passes(syntax);
  passes(everything);

  const extraOperation = edited([SUBMIT_PLAN_SYNTAX, `              list-plans:\n                syntax: GET /v1/plans\n${SUBMIT_PLAN_SYNTAX}`]);
  fails(syntax, extraOperation);

  const rewordedPurpose = edited(['the API decides whether the student may enroll', 'the API checks whether the student may enroll']);
  passes(syntax, rewordedPurpose);
  fails(everything, rewordedPurpose);

  const descriptionOnly = edited(['            technology: Python module\n            stereotypes: [coordinator]\n',
    '            technology: Python module\n            description: Sequences enrollment attempts.\n            stereotypes: [coordinator]\n']);
  passes(syntax, descriptionOnly);
  passes(everything, descriptionOnly);
});

test('same_as_seed on an interface fails when the interface moved, was deleted, or the filter matches nothing', () => {
  const start = REFERENCE_TEXT.indexOf('        provides:\n          enrollment-api:');
  const end = REFERENCE_TEXT.indexOf('        choices:\n          technology:\n            chosen: FastAPI');
  const block = REFERENCE_TEXT.slice(start, end);
  const withoutBlock = REFERENCE_TEXT.slice(0, start) + REFERENCE_TEXT.slice(end);
  const indented = block.replace(/^(?=.)/gm, '    ');
  const moved = editedFrom(withoutBlock, [['            stereotypes: [coordinator]\n', `            stereotypes: [coordinator]\n${indented}`]]);
  const deleted = editedFrom(withoutBlock, [[WEB_USES, '}']]);
  const everything = { same_as_seed: { interface: { id: 'enrollment-api' }, part: 'syntax' } };

  assert.equal(fails(everything, moved), 'enrollment-api moved from api to coordinator; it should stay as it was');
  assert.equal(fails(everything, deleted), 'enrollment-api was removed; it should stay as it was');
  assert.match(fails({ same_as_seed: { interface: { of: 'web' } } }), /starting design/);
});

// ---- Unresolved ids ----------------------------------------------------------------------------

test('unresolved interface, operation, and responsibility ids fail', () => {
  const message = (predicate) => fails(predicate);
  assert.equal(message({ exists: { relationship: { from: 'web', to: 'api', uses: 'enrolment-api' } } }), 'unknown interface enrolment-api');
  assert.equal(message({ exists: { operation: { of: 'enrollment-api', id: 'submit' } } }), 'unknown operation enrollment-api.submit');
  assert.equal(message({ exists: { interface: { has_operation: { realizes: 'nope' } } } }), 'unknown responsibility nope');
  assert.equal(message({ exists: { operation: { id: 'submit' } } }), 'unknown operation submit');
  assert.equal(message({ exists: { relationship: { from: 'web', to: 'api', requests: 'nope' } } }), 'unknown responsibility nope');
  assert.equal(message({ exists: { element: { provides_interface: { id: 'nope' } } } }), 'unknown interface nope');
  passes({ exists: { interface: { id: 'Enrollment-API' } } });
});

// ---- Author errors -----------------------------------------------------------------------------

function authorErrors(predicate) {
  return query.validatePredicate(predicate).errors.map((error) => error.message).join('\n');
}

test('unknown predicate keys are author errors with suggestions', () => {
  assert.match(authorErrors({ exists: { interface: { has_operations: {} } } }), /has_operation/);
  assert.match(authorErrors({ exists: { operation: { output_has_field: { unit_anyy: ['quarter'] } } } }), /unit_any/);
  assert.match(authorErrors({ exists: { operation: { realize_any: ['api-holds'] } } }), /realizes_any/);
});

test('keys left out of the vocabulary on purpose are unknown', () => {
  assert.match(authorErrors({ exists: { interface: { shorthand: true } } }), /Unknown key shorthand/);
  assert.match(authorErrors({ exists: { interface: { version: '1' } } }), /Unknown key version/);
  assert.match(authorErrors({ exists: { interface: { operations_at_least: 2 } } }), /Unknown key operations_at_least/);
});

test('the new keys accept their documented values and reject others', () => {
  assert.equal(query.validatePredicate(EXAMPLES[9].c4).ok, true);
  assert.match(authorErrors({ exists: { relationship: { uses_interface: 'some' } } }), /uses_interface.*present, absent, whole/);
  assert.match(authorErrors({ exists: { operation: { purpose: 'meaningful' } } }), /purpose.*present, absent/);
  assert.match(authorErrors({ exists: { operation: { output_has_field: { values: 'all' } } } }), /values.*present, absent, meaningful/);
  assert.match(authorErrors({ exists: { relationship: { uses: 'a.b.c' } } }), /uses/);
  assert.match(authorErrors({ same_as_seed: { interface: { id: 'x' }, part: 'whole' } }), /part.*all, syntax/);
  assert.match(authorErrors({ same_as_seed: { part: 'syntax' } }), /needs interface/);
});

test('a checks predicate over interface rules must reach the asserted severity', () => {
  assert.match(authorErrors({ checks: { max_errors: 0, rules: ['interface/no-unit'] } }), /max_errors can never fail/);
  assert.equal(query.validatePredicate({ checks: { max_warnings: 0, rules: ['interface/no-unit'] } }).ok, true);
  assert.match(authorErrors({ checks: { max_warnings: 0, rules: ['interface/no-meaning'] } }), /max_warnings can never fail/);
});
