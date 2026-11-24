'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const y = require('../../c4/c4-yaml.js');
const model = require('../../c4/c4-model.js');
const { fixture, rulesOf } = require('./helpers.js');

/** Normalizes YAML text the way an embed (default) or an opened file does. */
function load(text, source = 'embed') {
  return model.normalize(y.parse(text), { source });
}

/** The only diagnostic of a result; fails when there are none or several. */
function onlyDiagnostic({ diagnostics }) {
  assert.equal(diagnostics.length, 1, JSON.stringify(diagnostics, null, 2));
  return diagnostics[0];
}

test('the reference model normalizes without diagnostics', () => {
  const { model: m, diagnostics } = load(fixture('course-registration.yml'), 'file');
  assert.deepEqual(diagnostics, []);
  assert.equal(m.elements.size, 14);
  assert.deepEqual(m.rootIds, ['student', 'registration', 'billing']);
  assert.equal(m.schemaVersion, 'c4-design/1');
  assert.deepEqual(m.meta, {
    name: 'Course Registration',
    description: 'Students build a conflict-free term schedule and enroll in its sections.',
    status: 'proposed',
    enterprise: 'UCLA',
    view: null,
  });
});

test('the elements tree links parents and children in document order', () => {
  const { model: m } = load(fixture('course-registration.yml'), 'file');
  const registration = m.elements.get('registration');
  assert.equal(registration.type, 'system');
  assert.equal(registration.parentId, null);
  assert.deepEqual(registration.childIds, ['web', 'api', 'db']);
  assert.deepEqual(m.elements.get('api').childIds, ['coordinator', 'policy', 'seats', 'billing-gateway']);
  const policyClass = m.elements.get('EnrollmentPolicy');
  assert.equal(policyClass.type, 'code');
  assert.equal(policyClass.parentId, 'policy');
  assert.deepEqual(policyClass.path, ['systems', 'registration', 'containers', 'api', 'components', 'policy', 'code', 'EnrollmentPolicy']);
});

test('defaults apply: name from id, application and class kinds, in_enterprise when enterprise is set', () => {
  const { model: reference } = load(fixture('course-registration.yml'), 'file');
  assert.equal(reference.elements.get('api').kind, 'application');
  assert.equal(reference.elements.get('EnrollmentPolicy').kind, 'class');
  assert.equal(reference.elements.get('billing').inEnterprise, true);

  const { model: m, diagnostics } = load([
    'people:',
    '  student:',
    'systems:',
    '  s:',
    '    containers:',
    '      c:',
    '        components:',
    '          k:',
    '            code:',
    '              Rule:',
  ].join('\n'));
  assert.deepEqual(diagnostics, []);
  const student = m.elements.get('student');
  assert.equal(student.name, 'student');
  assert.equal(student.external, false);
  assert.equal(student.inEnterprise, false, 'no enterprise boundary without a top-level enterprise');
  assert.equal(m.elements.get('c').kind, 'application');
  assert.equal(m.elements.get('Rule').kind, 'class');
  assert.equal(m.elements.get('k').kind, null);
});

test('an explicit in_enterprise overrides the enterprise default', () => {
  const { model: m } = load('enterprise: UCLA\nsystems:\n  saas:\n    external: true\n    in_enterprise: false\n');
  const saas = m.elements.get('saas');
  assert.equal(saas.external, true);
  assert.equal(saas.inEnterprise, false);
});

test('an unknown key is reported at the key with a suggestion', () => {
  const diagnostic = onlyDiagnostic(load('systems:\n  s:\n    responsibilites: []\n'));
  assert.equal(diagnostic.rule, 'schema/unknown-key');
  assert.equal(diagnostic.severity, 'error');
  assert.equal(diagnostic.category, 'schema');
  assert.equal(diagnostic.element, 's');
  assert.deepEqual(diagnostic.path, ['systems', 's', 'responsibilites']);
  assert.deepEqual(diagnostic.range, { start: { line: 3, col: 5 }, end: { line: 3, col: 20 } });
  assert.match(diagnostic.message, /responsibilities/);
});

test('an unknown top-level key is reported with a suggestion', () => {
  const diagnostic = onlyDiagnostic(load('poeple:\n  student:\n'));
  assert.equal(diagnostic.rule, 'schema/unknown-key');
  assert.match(diagnostic.message, /people/);
});

test('x- keys are accepted', () => {
  const { diagnostics } = load('x-owner: CS 130\nsystems:\n  s:\n    x-note: draft\n    responsibilities:\n      - do: x\n        x-ref: 3\n');
  assert.deepEqual(diagnostics, []);
});

test('responsibilities on a person is a misplaced field', () => {
  const diagnostic = onlyDiagnostic(load('people:\n  p:\n    responsibilities: [do plan a term]\n'));
  assert.equal(diagnostic.rule, 'schema/misplaced-field');
  assert.equal(diagnostic.severity, 'error');
  assert.equal(diagnostic.range.start.line, 3);
  assert.match(diagnostic.message, /description/);
});

test('technology on a system is a misplaced field', () => {
  const diagnostic = onlyDiagnostic(load('systems:\n  s:\n    technology: Java\n'));
  assert.equal(diagnostic.rule, 'schema/misplaced-field');
  assert.equal(diagnostic.element, 's');
  assert.match(diagnostic.message, /container/);
});

test('enum values are validated with suggestions', () => {
  const diagnostic = onlyDiagnostic(load('systems:\n  s:\n    containers:\n      c:\n        kind: databse\n'));
  assert.equal(diagnostic.rule, 'schema/value');
  assert.equal(diagnostic.severity, 'error');
  assert.deepEqual(diagnostic.range.start, { line: 5, col: 15 });
  assert.match(diagnostic.message, /database/);
});

test('stereotypes and status are enum values too', () => {
  const { diagnostics } = load('status: acepted\nsystems:\n  s:\n    containers:\n      c:\n        stereotypes: [coordinater]\n');
  assert.deepEqual(rulesOf(diagnostics), ['schema/value', 'schema/value']);
  assert.match(diagnostics[0].message, /accepted/);
  assert.match(diagnostics[1].message, /coordinator/);
});

test('typed fields convert and reject bad values', () => {
  const { model: m, diagnostics } = load('systems:\n  yes-ext:\n    external: true\n  no-ext:\n    external: False\n');
  assert.deepEqual(diagnostics, []);
  assert.equal(m.elements.get('yes-ext').external, true);
  assert.equal(m.elements.get('no-ext').external, false);

  const bad = load('systems:\n  s:\n    external: maybe\n');
  const diagnostic = onlyDiagnostic(bad);
  assert.equal(diagnostic.rule, 'schema/type');
  assert.equal(diagnostic.range.start.line, 3);
  assert.equal(bad.model.elements.get('s').external, false, 'a rejected value falls back to the default');
});

test('a text field given a collection is a type error', () => {
  const diagnostic = onlyDiagnostic(load('systems:\n  s:\n    name: [a, b]\n'));
  assert.equal(diagnostic.rule, 'schema/type');
  assert.deepEqual(diagnostic.path, ['systems', 's', 'name']);
});

test('ids must match the id pattern', () => {
  const result = load('people:\n  1st-user:\n  ok_id-2:\n');
  const diagnostic = onlyDiagnostic(result);
  assert.equal(diagnostic.rule, 'schema/id-format');
  assert.equal(diagnostic.range.start.line, 2);
  assert.ok(result.model.elements.has('ok_id-2'));
});

test('element ids are unique across types', () => {
  const { model: m, diagnostics } = load('people:\n  api:\nsystems:\n  s:\n    containers:\n      api:\n');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].rule, 'model/duplicate-id');
  assert.equal(diagnostics[0].severity, 'error');
  assert.deepEqual(diagnostics[0].path, ['systems', 's', 'containers', 'api']);
  assert.equal(diagnostics[0].range.start.line, 6);
  assert.equal(m.elements.get('api').type, 'person', 'the first declaration keeps the id');
  assert.deepEqual(m.elements.get('s').childIds, []);
});

test('schema version handling', () => {
  assert.deepEqual(load('people:\n  p:\n').diagnostics, []);
  assert.equal(load('people:\n  p:\n').model.schemaVersion, 'c4-design/1');

  const missingInFile = load('people:\n  p:\n', 'file');
  const info = onlyDiagnostic(missingInFile);
  assert.equal(info.rule, 'schema/version');
  assert.equal(info.severity, 'info');
  assert.equal(missingInFile.model.schemaVersion, null);

  const unknown = onlyDiagnostic(load('schema: c4-design/9\n', 'file'));
  assert.equal(unknown.rule, 'schema/version');
  assert.equal(unknown.severity, 'error');
  assert.equal(unknown.range.start.line, 1);

  const cs188 = load('schema_version: "1.0"\ncomponents:\n  CAN-001:\n    name: Planner\n', 'file');
  const cs188Error = onlyDiagnostic(cs188);
  assert.equal(cs188Error.rule, 'schema/version');
  assert.equal(cs188Error.severity, 'error');
  assert.match(cs188Error.message, /CS 188/);
  assert.equal(cs188.model.elements.size, 0);
});

test('YAML syntax errors yield yaml/syntax and no model', () => {
  const { model: m, diagnostics } = load('people:\n  p:\n    name: [unclosed\n');
  assert.equal(m, null);
  assert.ok(diagnostics.length > 0);
  assert.ok(diagnostics.every((diagnostic) => diagnostic.rule === 'yaml/syntax' && diagnostic.severity === 'error'));
  assert.equal(diagnostics[0].category, 'yaml');
  assert.ok(diagnostics[0].range.start.line >= 3);
});

test('empty, comment-only, and schema-only documents yield an empty model', () => {
  for (const text of ['', '# caption: nothing yet\n', '---\n', 'schema: c4-design/1\n', 'schema: c4-design/1\r\n']) {
    const { model: m, diagnostics } = load(text);
    assert.deepEqual(diagnostics, [], JSON.stringify(text));
    assert.equal(m.elements.size, 0);
    assert.deepEqual(m.rootIds, []);
  }
});

test('a document that is not a map is a type error with an empty model', () => {
  const result = load('- people\n');
  assert.equal(onlyDiagnostic(result).rule, 'schema/type');
  assert.equal(result.model.elements.size, 0);
});

test('responsibilities read shorthand and map forms', () => {
  const { model: m, diagnostics } = load([
    'requirements:',
    '  FR-07: A student can see why two sections clash.',
    'systems:',
    '  up:',
    '    responsibilities: [{decide: who may enroll, id: up-elig}]',
    '    containers:',
    '      s:',
    '        responsibilities:',
    '          - KNOW the open seats',
    '          - Track seats',
    '          - decide: whether a student may enroll',
    '            id: s-elig',
    '            refines: up-elig',
    '            requirements: [FR-07]',
  ].join('\n'));
  assert.deepEqual(diagnostics, []);
  const [know, untyped, decide] = m.elements.get('s').responsibilities;
  assert.deepEqual(know, {
    id: null, kind: 'know', text: 'the open seats', refines: [], requirements: [], ownerId: 's', index: 0,
    path: ['systems', 'up', 'containers', 's', 'responsibilities', 0],
  });
  assert.equal(untyped.kind, null);
  assert.equal(untyped.text, 'Track seats');
  assert.equal(decide.id, 's-elig');
  assert.equal(decide.kind, 'decide');
  assert.equal(decide.text, 'whether a student may enroll');
  assert.deepEqual(decide.refines, ['up-elig']);
  assert.deepEqual(decide.requirements, ['FR-07']);
  assert.equal(decide.index, 2);
});

test('a responsibility map needs exactly one of know, do, or decide', () => {
  const { diagnostics } = load('systems:\n  s:\n    responsibilities:\n      - know: a\n        do: b\n      - id: r\n');
  assert.deepEqual(rulesOf(diagnostics), ['schema/type', 'schema/type']);
  assert.deepEqual(diagnostics[1].path, ['systems', 's', 'responsibilities', 1]);
});

test('choices normalize technology, styles, patterns, and tactics', () => {
  const { model: reference } = load(fixture('course-registration.yml'), 'file');
  assert.deepEqual(reference.elements.get('api').choices, {
    technology: {
      chosen: 'FastAPI 0.115 on Python 3.12',
      alternatives: ['Django REST Framework', 'Flask'],
      because: 'typed request models and async database access',
      decision: null,
    },
    styles: ['layers'],
    patterns: [],
    tactics: [],
  });
  assert.deepEqual(reference.elements.get('EnrollmentRule').choices.patterns,
    [{ pattern: 'Strategy', role: 'Strategy', instance: 'eligibility-rules', decision: null }]);
  assert.equal(reference.elements.get('db').choices, null);

  const { model: m } = load('systems:\n  s:\n    choices:\n      patterns: ["Facade", "Strategy: Context"]\n');
  assert.deepEqual(m.elements.get('s').choices.patterns, [
    { pattern: 'Facade', role: null, instance: null, decision: null },
    { pattern: 'Strategy', role: 'Context', instance: null, decision: null },
  ]);
});

test('an unknown key inside choices is reported with a suggestion', () => {
  const diagnostic = onlyDiagnostic(load('systems:\n  s:\n    choices:\n      technology: {chosen: Go, becuase: fast}\n'));
  assert.equal(diagnostic.rule, 'schema/unknown-key');
  assert.match(diagnostic.message, /because/);
});

test('code elements carry attributes, operations, extends, and implements', () => {
  const { model: reference } = load(fixture('course-registration.yml'), 'file');
  assert.deepEqual(reference.elements.get('PrerequisiteRule').code, {
    attributes: [],
    operations: ['+ evaluate(student, section): RuleResult'],
    extends: [],
    implements: ['EnrollmentRule'],
  });
  assert.equal(reference.elements.get('policy').code, null);
});

test('list fields keep their text items', () => {
  const { model: reference } = load(fixture('course-registration.yml'), 'file');
  const coordinator = reference.elements.get('coordinator');
  assert.deepEqual(coordinator.stereotypes, ['coordinator']);
  assert.deepEqual(coordinator.provides, ['evaluate(proposal) -> Outcome']);
  assert.deepEqual(coordinator.invariants, ['never decides eligibility or writes seat state']);
  assert.deepEqual(reference.elements.get('seats').owns, ['seat holds']);
  assert.equal(coordinator.technology, 'Python module');
});
