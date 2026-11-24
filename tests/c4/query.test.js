'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const y = require('../../c4/c4-yaml.js');
const modelApi = require('../../c4/c4-model.js');
const checks = require('../../c4/c4-checks.js');
const query = require('../../c4/c4-query.js');
const { fixture } = require('./helpers.js');

const REFERENCE_TEXT = fixture('course-registration.yml');

function load(text) {
  return modelApi.normalize(y.parse(text), { source: 'file' }).model;
}

const reference = load(REFERENCE_TEXT);

/** The checks function a host hands to the evaluator: run the rules, then apply the step's configuration. */
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

/** The reference design with `replacements` applied to its text, as a learner's edited file. */
function edited(...replacements) {
  const text = replacements.reduce((current, [from, to]) => {
    assert.ok(current.includes(from), `${from} is in the fixture`);
    return current.replace(from, to);
  }, REFERENCE_TEXT);
  return load(text);
}

// ---- The spec section 8 examples ---------------------------------------------------------------

test('the context view of the reference model shows a person named adviser or advisor only when one exists', () => {
  const message = fails({ view: { view: 'context of registration', shows: [{ type: 'person', name_any: ['adviser', 'advisor'] }] } });
  assert.match(message, /context of registration/);
  passes({ view: { view: 'context of registration', shows: [{ type: 'person', name_any: ['student'] }] } });
});

test('a count of the decisions that refine a given decision, owned by components, is exact', () => {
  passes({ count: { responsibility: { of: { type: 'component' }, kind: 'decide', refines: 'api-eligibility' } }, equals: 1 });
  fails({ count: { responsibility: { of: { type: 'component' }, kind: 'decide', refines: 'api-eligibility' } }, equals: 2 });
});

test('absent passes when no responsibility of the element refines the decision', () => {
  passes({ absent: { responsibility: { of: 'coordinator', refines: 'api-eligibility' } } });
  fails({ absent: { responsibility: { of: 'policy', refines: 'api-eligibility' } } });
});

test('every element in a container must satisfy the element filter', () => {
  passes({ every: { type: 'component', in: 'api' }, satisfies: { responsibilities_at_least: 1 } });
  fails({ every: { type: 'component', in: 'api' }, satisfies: { responsibilities_at_least: 2 } });
});

test('a checks predicate over categories passes on the reference model', () => {
  passes({ checks: { max_errors: 0, max_warnings: 0, categories: ['model', 'c4', 'xlevel', 'rdd'] } });
});

test('checks fails naming the findings when a selected rule reports above the limit', () => {
  const model = load('systems:\n  s:\n    name: Planner\n    description: Plans schedules for students.\n    containers:\n      b:\n        name: Backend\n');
  const message = fails({ checks: { max_warnings: 0, rules: ['c4/no-description'] } }, model);
  assert.match(message, /c4\/no-description/);
});

test('the enrollment steps include a reply inside an alt fragment', () => {
  passes({ exists: { step: { scenario: 'enroll', from: 'coordinator', to: 'web', in_fragment: 'alt', reply: true } } });
});

test('the model keeps both requirements', () => {
  passes({ count: { requirement: {} }, equals: 2 });
});

// ---- Author errors -----------------------------------------------------------------------------

test('unknown keys are author errors with a suggestion', () => {
  const predicate = { exists: { element: { nmae: 'Student' } } };
  const { ok, errors } = query.validatePredicate(predicate);
  assert.equal(ok, false);
  assert.match(errors[0].message, /nmae/);
  assert.match(errors[0].message, /name/);
  const result = evaluate(predicate);
  assert.equal(result.passed, false);
  assert.match(result.message, /name/);
});

test('exactly one assertion and one query are required', () => {
  assert.equal(query.validatePredicate({}).ok, false);
  assert.equal(query.validatePredicate({ exists: { element: {} }, absent: { element: {} } }).ok, false);
  assert.equal(query.validatePredicate({ exists: {} }).ok, false);
  assert.equal(query.validatePredicate({ exists: { element: {}, requirement: {} } }).ok, false);
});

test('count needs exactly one comparator and every needs satisfies', () => {
  assert.equal(query.validatePredicate({ count: { element: {} } }).ok, false);
  assert.equal(query.validatePredicate({ count: { element: {} }, equals: 1, at_most: 2 }).ok, false);
  assert.equal(query.validatePredicate({ every: { type: 'component' } }).ok, false);
  assert.equal(query.validatePredicate({ exists: { element: {} }, equals: 1 }).ok, false);
});

test('a checks predicate whose rules cannot reach the asserted severity is rejected by validation', () => {
  const { ok, errors } = query.validatePredicate({ checks: { max_errors: 0, rules: ['c4/vague-relationship'] } });
  assert.equal(ok, false);
  assert.match(errors[0].message, /c4\/vague-relationship/);
});

test('checks predicates apply the configured severity before their filters', () => {
  const predicate = { checks: { max_warnings: 0, rules: ['c4/generic-name'] } };
  const config = { severity: { 'c4/generic-name': 'warning' } };
  assert.equal(query.validatePredicate(predicate).ok, false);
  assert.equal(query.validatePredicate(predicate, { checks: config }).ok, true);

  const design = (name) => load(`systems:\n  s:\n    name: Planner\n    description: Plans schedules for students.\n    containers:\n      b:\n        name: ${name}\n`);
  const context = contextWith({ checksConfig: config });
  assert.equal(evaluate(predicate, design('Backend'), context).passed, false);
  assert.equal(evaluate(predicate, design('Schedule Planner API'), context).passed, true);
});

test('checks rejects unknown rule ids and categories', () => {
  assert.equal(query.validatePredicate({ checks: { max_errors: 0, rules: ['c4/no-such-rule'] } }).ok, false);
  assert.equal(query.validatePredicate({ checks: { max_errors: 0, categories: ['nope'] } }).ok, false);
  assert.equal(query.validatePredicate({ checks: { rules: ['c4/no-description'] } }).ok, false);
});

// ---- Missing things are learner failures -------------------------------------------------------

test('predicates referencing unknown ids fail instead of passing vacuously', () => {
  const message = fails({ absent: { responsibility: { of: 'coordinator2', refines: 'api-eligibility' } } });
  assert.equal(message, 'unknown element coordinator2');
  assert.equal(fails({ exists: { responsibility: { refines: 'nope' } } }), 'unknown responsibility nope');
});

test('every over an empty set fails', () => {
  fails({ every: { type: 'component', in: 'web' }, satisfies: { responsibilities_at_least: 0 } });
});

test('a view selector or in_view naming a view or element missing from the model fails with a learner-facing message', () => {
  const missingView = { view: { view: 'who-decides', shows: ['student'] } };
  assert.equal(query.validatePredicate(missingView).ok, true);
  assert.equal(fails(missingView), 'No view named who-decides yet');

  const missingScope = { exists: { relationship: { from: 'web', to: 'coordinator', in_view: 'containers of registration2' } } };
  assert.equal(query.validatePredicate(missingScope).ok, true);
  assert.match(fails(missingScope), /registration2/);

  const malformed = query.validatePredicate({ view: { view: 'contxt of registration' } });
  assert.equal(malformed.ok, false);
  assert.match(malformed.errors[0].message, /contxt of registration/);
});

test('a step query naming a missing scenario fails with a learner-facing message', () => {
  const predicate = { exists: { step: { scenario: 'enrol', from: 'web', to: 'coordinator' } } };
  assert.equal(query.validatePredicate(predicate).ok, true);
  assert.equal(fails(predicate), 'No scenario named enrol yet');
});

test('a model that could not be loaded yields null', () => {
  assert.equal(evaluate({ exists: { element: {} } }, null).passed, null);
});

// ---- Relationships -----------------------------------------------------------------------------

test('relationship queries include derived relationships by default', () => {
  passes({ exists: { relationship: { from: 'web', to: 'api' } } });
  fails({ exists: { relationship: { from: 'web', to: 'api', derived: 'exclude' } } });
  passes({ exists: { relationship: { from: 'web', to: 'api', derived: 'only' } } });
  passes({ exists: { relationship: { from: 'web', to: 'coordinator', derived: 'exclude' } } });
  fails({ exists: { relationship: { from: 'web', to: 'coordinator', derived: 'only' } } });
});

test('relationship filters match descriptions, technology, connector, and element filters at each end', () => {
  passes({ exists: { relationship: { from: 'web', to: 'coordinator', technology_any: ['json'], description_any: ['submits'] } } });
  passes({ exists: { relationship: { from: 'billing-gateway', to: 'billing', connector: 'message', technology: 'present' } } });
  passes({ exists: { relationship: { from: { type: 'component' }, to: { external: true } } } });
  fails({ exists: { relationship: { from: 'web', to: 'coordinator', connector: 'message' } } });
  fails({ exists: { relationship: { from: 'web', to: 'coordinator', technology: 'absent' } } });
});

test('in_view restricts relationships to those drawn in the view', () => {
  passes({ exists: { relationship: { from: 'web', to: 'api', in_view: 'containers of registration' } } });
  fails({ exists: { relationship: { from: 'web', to: 'coordinator', in_view: 'containers of registration' } } });
});

// ---- Responsibilities and elements -------------------------------------------------------------

test('responsibility filters accept element filters for of and a leaf flag', () => {
  passes({ count: { responsibility: { of: { type: 'component', in: 'api' }, kind: 'know' } }, equals: 1 });
  // sys-eligibility, sys-holds, api-eligibility, and api-holds are refined; of the other eight, five are DO.
  passes({ count: { responsibility: { leaf: true, kind: 'do' } }, equals: 5 });
  passes({ count: { responsibility: { leaf: false } }, equals: 4 });
  passes({ exists: { responsibility: { id: 'api-holds', text_any: ['seat'] } } });
  fails({ exists: { responsibility: { id: 'api-holds', text_any: ['tuition'] } } });
});

test('owns_any matches owned facts by case-insensitive substring after normalization', () => {
  const matched = evaluate({ exists: { element: { owns_any: ['Seat-Hold'] } } });
  assert.equal(matched.passed, true);
  assert.deepEqual(matched.matched, ['seats']);
  fails({ exists: { element: { owns_any: ['seat reservation'] } } });
});

test('element filters match type, kind, name, stereotype, technology, pattern, and style', () => {
  passes({ exists: { element: { type: 'container', kind: 'database', name: 'registration database' } } });
  passes({ count: { element: { stereotype: 'interfacer' } }, equals: 2 });
  passes({ count: { element: { technology: 'absent', type: 'component' } }, equals: 0 });
  passes({ exists: { element: { technology_any: ['fastapi'], id: 'api' } } });
  passes({ exists: { element: { pattern: 'Strategy', pattern_role: 'Context' } } });
  fails({ exists: { element: { pattern: 'Strategy', pattern_role: 'Observer' } } });
  passes({ exists: { element: { style: 'layers' } } });
  passes({ exists: { element: { parent: 'api', name_any: ['gateway'] } } });
  passes({ exists: { element: { has_responsibility: { kind: 'decide', refines: 'api-eligibility' } } } });
});

test('count supports equals, at_least, and at_most', () => {
  const components = { element: { type: 'component' } };
  passes({ count: components, equals: 4 });
  passes({ count: components, at_least: 4 });
  passes({ count: components, at_most: 4 });
  fails({ count: components, at_least: 5 });
  fails({ count: components, at_most: 3 });
  fails({ count: components, equals: 3 });
});

// ---- Views, steps, requirements ----------------------------------------------------------------

test('view shows and hides accept ids and element filters', () => {
  const selector = 'containers of registration';
  passes({ view: { view: selector, shows: ['web', { type: 'container', kind: 'database' }] } });
  passes({ view: { view: selector, hides: ['coordinator', { type: 'component' }] } });
  fails({ view: { view: selector, hides: ['web'] } });
  fails({ view: { view: selector, shows: ['coordinator'] } });
  passes({ view: { view: selector, shows: ['registration'] } });
  passes({ view: { view: selector, max_elements: 20 } });
  fails({ view: { view: selector, max_elements: 2 } });
});

test('step queries match endpoints, a fragment kind at any depth, and the reply classification', () => {
  const step = (fields) => ({ exists: { step: Object.assign({ scenario: 'enroll' }, fields) } });
  passes(step({ from: 'coordinator', to: 'web', in_fragment: 'alt', reply: true }));
  fails(step({ from: 'coordinator', to: 'web', in_fragment: 'alt', reply: false }));
  fails(step({ from: 'web', to: 'coordinator', in_fragment: 'alt' }));
  passes(step({ from: 'web', to: 'coordinator', reply: false }));
  passes(step({ from: 'coordinator', to: 'billing-gateway', in_fragment: 'alt' }));
  passes(step({ from: { type: 'container', kind: 'browser_app' }, to: 'coordinator' }));
  fails(step({ from: 'coordinator', to: 'web', in_fragment: 'loop' }));

  const nested = load(`${REFERENCE_TEXT.slice(0, REFERENCE_TEXT.indexOf('scenarios:'))}scenarios:
  retry:
    steps:
      - loop:
          when: until accepted
          steps:
            - opt:
                when: if slow
                steps:
                  - web -> coordinator: submits the plan to
`);
  passes(step({ scenario: 'retry', from: 'web', to: 'coordinator', in_fragment: 'loop' }), nested);
  passes(step({ scenario: 'retry', in_fragment: 'opt' }), nested);
  fails(step({ scenario: 'retry', in_fragment: 'alt' }), nested);
});

test('requirement queries match requirements by id, kind, and text', () => {
  passes({ exists: { requirement: { id: 'FR-09' } } });
  const clash = evaluate({ exists: { requirement: { text_any: ['clash'] } } });
  assert.equal(clash.passed, true);
  assert.deepEqual(clash.matched, ['FR-07']);
  passes({ count: { requirement: { kind: 'quality' } }, equals: 0 });
  const withoutRequirements = edited(['requirements:\n  FR-07: A student can see why two sections clash before enrolling.\n  FR-09: A student is enrolled in every section of a plan, or in none.\n', ''],
    ['        requirements: [FR-07]\n', ''], ['        requirements: [FR-09]\n', '']);
  fails({ count: { requirement: {} }, equals: 2 }, withoutRequirements);
});

// ---- same_as_seed ------------------------------------------------------------------------------

test('same_as_seed compares an element with the seed model, ignoring layout', () => {
  const predicate = { same_as_seed: { id: 'api' } };
  passes(predicate);
  const pinned = load(`${REFERENCE_TEXT}\nlayout:\n  containers of registration:\n    web: [10, 20]\n`);
  passes(predicate, pinned);
  const reworded = edited(['description: Decides eligibility and enrolls students atomically.', 'description: Decides who may enroll.']);
  fails(predicate, reworded);
  fails({ same_as_seed: { id: 'policy' } }, edited(['whether prerequisites and unit caps allow enrollment', 'whether prerequisites hold']));
});

test('same_as_seed fails when the element was deleted or when the filter matches nothing in the seed', () => {
  const withoutDb = edited(['      db:\n        name: Registration Database\n        kind: database\n        technology: PostgreSQL 16\n        description: Durably stores plans, enrollment attempts, and seat holds.\n        responsibilities:\n          - do: durably store plans, enrollment attempts, and seat holds\n', ''],
    ['              db: {description: writes seat holds to, technology: SQL/TCP}\n', ''],
    ['    affects: [db, seats]', '    affects: [seats]'],
    ['hosts: [db]', 'hosts: []']);
  assert.equal(withoutDb.elements.has('db'), false);
  fails({ same_as_seed: { type: 'container', kind: 'database' } }, withoutDb);
  fails({ same_as_seed: { type: 'person', name_any: ['adviser'] } });
});
