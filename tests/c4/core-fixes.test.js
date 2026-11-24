'use strict';
// Departures from the spec found while validating the C4 tutorial drafts against the core:
// A. `view:` assertions test what UML-notation views draw (spec §5.1, §5.3, §6.3, §8);
// B. `check()` reports a saved view whose selector names nothing or an element of the wrong type (spec §4.8, §5.1, §7.2);
// C. `same_as_seed` compares an element's own content as written, so deleting another element does not change it (spec §8).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCore, fixture } = require('./helpers.js');

const C4 = loadCore();
const REFERENCE_TEXT = fixture('course-registration-interfaces.yml');
const reference = C4.load(REFERENCE_TEXT);

/** A small design: a student uses a web app that submits plans to an API, and one scenario follows both relationships. */
const SMALL_TEXT = `schema: c4-design/1
name: Repro
people:
  student:
    name: Student
    description: Plans a term schedule.
    collaborators:
      web: plans a schedule using
systems:
  reg:
    name: Registration
    description: Enrolls students in sections.
    containers:
      web:
        name: Web App
        description: Shows a student's plan.
        technology: TypeScript, React
        collaborators:
          api: {description: submits plans to, technology: JSON/HTTPS}
      api:
        name: Registration API
        description: Decides whether a student may enroll.
        technology: Python, FastAPI
scenarios:
  enroll:
    title: Enroll
    steps:
      - "student -> web": submits a plan using
      - "web -> api": submits the plan to
`;
const API_BLOCK = `      api:
        name: Registration API
        description: Decides whether a student may enroll.
        technology: Python, FastAPI
`;

/** `text` with each `[from, to]` replacement applied once; every `from` must occur. */
function edit(text, ...replacements) {
  return replacements.reduce((current, [from, to]) => {
    assert.ok(current.includes(from), `${JSON.stringify(from)} occurs in the design`);
    return current.replace(from, to);
  }, text);
}

function evaluate(design, predicate, context = {}) {
  return C4.query.evaluate(design, predicate, Object.assign({ checksConfig: {} }, context));
}

function passes(design, predicate, context) {
  const result = evaluate(design, predicate, context);
  assert.equal(result.passed, true, result.message);
  return result;
}

function fails(design, predicate, context) {
  const result = evaluate(design, predicate, context);
  assert.equal(result.passed, false, `${JSON.stringify(predicate)} should fail`);
  return result.message;
}

const errorsOf = (design) => C4.check(design, {}).filter((diagnostic) => diagnostic.severity === 'error');

// ---- A. View assertions on UML-notation views ---------------------------------------------------

test('a view assertion on a dynamic view tests the scenario participants', () => {
  const small = C4.load(SMALL_TEXT);
  passes(small, { view: { view: 'dynamic enroll', shows: ['student', 'web', 'api'] } });
  assert.equal(fails(small, { view: { view: 'dynamic enroll', hides: ['api'] } }),
    'The view dynamic enroll shows api, which it should not');

  const view = 'dynamic enroll';
  passes(reference, { view: { view, shows: ['web', 'coordinator', 'policy', 'seats', 'billing-gateway'] } });
  passes(reference, { view: { view, shows: [{ type: 'component', in: 'api' }], hides: ['student', 'api', 'db'] } });
  assert.equal(fails(reference, { view: { view, shows: ['db'] } }), 'The view dynamic enroll does not show db');
  fails(reference, { view: { view, hides: [{ type: 'container' }] } });
});

test('a dynamic view no longer shows a participant whose steps were removed', () => {
  const withoutBilling = C4.load(edit(REFERENCE_TEXT, ['              - coordinator -> billing-gateway: asks for tuition charges through\n', '']));
  passes(withoutBilling, { view: { view: 'dynamic enroll', hides: ['billing-gateway'] } });
  fails(withoutBilling, { view: { view: 'dynamic enroll', shows: ['web', 'coordinator', 'policy', 'seats', 'billing-gateway'] } });
});

test('a view assertion on a code view tests the classes it draws', () => {
  const view = 'code of policy';
  passes(reference, { view: { view, shows: ['EnrollmentPolicy', 'EnrollmentRule', { type: 'code', name: 'UnitCapRule' }] } });
  passes(reference, { view: { view, hides: ['policy', 'coordinator', 'web'] } });
  fails(reference, { view: { view, hides: ['EnrollmentRule'] } });
});

test('a view assertion on a deployment view tests its nodes and the elements they host', () => {
  const view = 'deployment production';
  passes(reference, { view: { view, shows: ['web', 'api', 'db', 'billing'] } });
  passes(reference, { view: { view, shows: ['api-pod', 'laptop'] } });
  passes(reference, { view: { view, hides: ['coordinator', 'student', { type: 'component' }] } });
  assert.equal(fails(reference, { view: { view, hides: ['api'] } }), 'The view deployment production shows api, which it should not');
  fails(reference, { view: { view, hides: ['ingress'] } });
  assert.equal(fails(reference, { view: { view, shows: ['api-pods'] } }), 'unknown element api-pods');
});

test('a deployment node id is not an element outside its deployment view', () => {
  assert.equal(fails(reference, { view: { view: 'containers of registration', hides: ['api-pod'] } }), 'unknown element api-pod');
});

test('a view assertion on an interfaces view tests its consumers, scope, and providers', () => {
  const view = 'interfaces of api';
  passes(reference, { view: { view, shows: ['web', 'api', 'billing'] } });
  passes(reference, { view: { view, hides: ['coordinator', 'student', 'db'] } });
  fails(reference, { view: { view, hides: ['billing'] } });
  passes(reference, { view: { view: 'interfaces of coordinator', shows: ['web', 'coordinator'], hides: ['api'] } });
});

test('max_elements counts what a UML-notation view draws', () => {
  passes(reference, { view: { view: 'dynamic enroll', max_elements: 5 } });
  assert.equal(fails(reference, { view: { view: 'dynamic enroll', max_elements: 4 } }),
    'The view dynamic enroll shows 5 elements; at most 4 are allowed');
});

// ---- B. Saved views over a selector that names nothing ------------------------------------------

const withSavedView = (selector) => C4.load(`${SMALL_TEXT}views:
  who-decides:
    view: ${selector}
    description: For reviewers, shows which part decides.
`);

test('check reports a saved view whose selector names nothing as view/unknown-selector', () => {
  const design = withSavedView('components of API');
  const found = errorsOf(design).filter((diagnostic) => diagnostic.rule === 'view/unknown-selector');
  assert.equal(found.length, 1);
  const [diagnostic] = found;
  assert.equal(diagnostic.severity, 'error');
  assert.equal(diagnostic.category, 'view');
  assert.equal(diagnostic.element, null);
  assert.deepEqual(diagnostic.path, ['views', 'who-decides', 'view']);
  assert.equal(diagnostic.range.start.line, 32);
  assert.match(diagnostic.message, /who-decides/);
  assert.match(diagnostic.message, /There is no element named API/);
  assert.match(diagnostic.hint, /did you mean api/);
});

test('check reports a saved view over an element of the wrong type as view/wrong-scope-type', () => {
  const found = errorsOf(withSavedView('code of api')).map((diagnostic) => diagnostic.rule);
  assert.deepEqual(found, ['view/wrong-scope-type']);
});

test('check reports nothing for a saved view whose selector resolves', () => {
  assert.deepEqual(errorsOf(withSavedView('components of api')), []);
});

test('a checks predicate and a view assertion fail on a saved view that names nothing', () => {
  const design = withSavedView('components of API');
  const message = fails(design, { checks: { max_errors: 0 } });
  assert.match(message, /view\/unknown-selector/);
  assert.equal(fails(design, { view: { view: 'who-decides', hides: ['reg'] } }),
    'The view who-decides cannot be drawn. There is no element named API');
});

// ---- C. same_as_seed compares an element's own content -----------------------------------------

test('same_as_seed ignores the deletion of an element that a relationship of the compared element targets', () => {
  const seed = C4.load(SMALL_TEXT);
  const learner = C4.load(edit(SMALL_TEXT, [API_BLOCK, '']));
  passes(learner, { same_as_seed: { id: 'web' } }, { seedModel: seed.model });
  // The dangling collaborator entry is reported on its own, by the reference rule.
  const dangling = errorsOf(learner).filter((diagnostic) => diagnostic.rule === 'model/unknown-reference' && diagnostic.element === 'web');
  assert.equal(dangling.length, 1);
});

test('same_as_seed fails when the element itself was edited', () => {
  const seed = C4.load(SMALL_TEXT);
  const withoutCollaborator = C4.load(edit(SMALL_TEXT,
    ['        collaborators:\n          api: {description: submits plans to, technology: JSON/HTTPS}\n', '']));
  assert.equal(fails(withoutCollaborator, { same_as_seed: { id: 'web' } }, { seedModel: seed.model }),
    'web was changed; it should stay as it was');
  const otherTechnology = C4.load(edit(SMALL_TEXT, ['submits plans to, technology: JSON/HTTPS', 'submits plans to, technology: gRPC']));
  fails(otherTechnology, { same_as_seed: { id: 'web' } }, { seedModel: seed.model });
});

test('same_as_seed counts a change to a child as a change to its parent', () => {
  const policyEdit = ['whether prerequisites and unit caps allow enrollment', 'whether prerequisites hold'];
  assert.ok(REFERENCE_TEXT.includes(policyEdit[0]), 'the fixture states the policy decision');
  const learner = C4.load(edit(REFERENCE_TEXT, policyEdit));
  const context = { seedModel: reference.model };
  fails(learner, { same_as_seed: { id: 'policy' } }, context);
  assert.equal(fails(learner, { same_as_seed: { id: 'api' } }, context), 'api was changed; it should stay as it was');
  passes(learner, { same_as_seed: { id: 'web' } }, context);
});

test('same_as_seed ignores how the content is written: key order, flow or block style, and layout', () => {
  const seed = C4.load(SMALL_TEXT);
  const rewritten = C4.load(edit(SMALL_TEXT,
    ['        name: Web App\n        description: Shows a student\'s plan.\n', '        description: Shows a student\'s plan.\n        name: Web App\n'],
    ['          api: {description: submits plans to, technology: JSON/HTTPS}\n',
      '          api:\n            technology: JSON/HTTPS   # the wire format\n            description: submits plans to\n'])
    + 'layout:\n  containers of reg:\n    web: [10, 20]\n');
  passes(rewritten, { same_as_seed: { id: 'web' } }, { seedModel: seed.model });
});

test('same_as_seed fails when the element moved to another parent', () => {
  const seed = C4.load(SMALL_TEXT);
  const moved = C4.load(edit(SMALL_TEXT, [API_BLOCK, ''],
    ['scenarios:', `  other:\n    name: Other\n    description: Something else.\n    containers:\n${API_BLOCK}scenarios:`]));
  assert.equal(moved.model.elements.get('api').parentId, 'other');
  fails(moved, { same_as_seed: { id: 'api' } }, { seedModel: seed.model });
});
