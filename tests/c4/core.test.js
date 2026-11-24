'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadCore, fixture } = require('./helpers.js');

const C4_ROOT = path.join(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(C4_ROOT, 'c4', 'manifest.json'), 'utf8'));
const SCHEMA_FILE = path.join(C4_ROOT, 'c4', 'schema', '1', 'design.schema.json');

const TIME_BOUND_MS = 3000;
const DELETE_TIME_BOUND_MS = 1000;

test('every manifest file loads in order in a classic-script context and publishes ArchUMLC4', () => {
  const context = vm.createContext({});
  context.self = context;
  manifest.core.forEach((file) => {
    vm.runInContext(fs.readFileSync(path.join(C4_ROOT, file), 'utf8'), context, { filename: file });
  });
  assert.equal(vm.runInContext('ArchUMLC4.version', context), '1.1.0');
  assert.equal(vm.runInContext('ArchUMLC4.SCHEMA_VERSION', context), 'c4-design/1');
});

test('require of c4-core.js returns the same facade in Node', () => {
  assert.equal(require('../../c4/c4-core.js'), loadCore());
  assert.equal(loadCore().version, '1.1.0');
});

test('load, check, and project the reference model end to end', () => {
  const core = loadCore();
  const design = core.load(fixture('course-registration.yml'), { source: 'file' });
  assert.deepEqual(core.check(design).filter((found) => found.severity !== 'info'), []);
  assert.equal(core.project(design, 'containers of registration').nodes.length, 5);
});

test('check applies the disable option to semantic diagnostics', () => {
  const core = loadCore();
  const design = core.load('systems:\n  shop:\n    name: Shop\n', { source: 'embed' });
  assert.ok(core.check(design).some((found) => found.rule === 'c4/no-description'));
  assert.ok(!core.check(design, { disable: ['c4/no-description'] }).some((found) => found.rule === 'c4/no-description'));
});

test('check reports a YAML syntax error as the only diagnostic of an unreadable design', () => {
  const core = loadCore();
  const design = core.load('systems: [unclosed', { source: 'embed' });
  assert.equal(design.model, null);
  assert.deepEqual(core.check(design).map((found) => found.rule), ['yaml/syntax']);
});

test('listViews and defaultView read the design model', () => {
  const core = loadCore();
  const design = core.load(fixture('course-registration.yml'), { source: 'file' });
  assert.deepEqual(core.listViews(design).map((view) => view.selector), [
    'landscape', 'context of registration', 'containers of registration', 'components of api',
    'code of policy', 'dynamic enroll', 'deployment production',
  ]);
  assert.equal(core.defaultView(design), 'context of registration');
});

test('edit applies a command to the design text', () => {
  const core = loadCore();
  const design = core.load('systems:\n  shop:\n    name: Shop\n', { source: 'embed' });
  const result = core.edit(design, { op: 'setElementField', elementId: 'shop', field: 'description', value: 'Sells things.' });
  assert.match(result.text, /description: Sells things\./);
  assert.equal(core.edit(design, { op: 'nonsense' }).error, 'unknown-command');
});

test('dependentsOf lists the references that a delete removes', () => {
  const core = loadCore();
  const design = core.load(fixture('course-registration.yml'), { source: 'file' });
  assert.ok(core.dependentsOf(design, 'db').length > 0);
  assert.deepEqual(core.dependentsOf(design, 'no-such-element'), []);
});

test('query evaluates a predicate against the design model', () => {
  const core = loadCore();
  const design = core.load(fixture('course-registration.yml'), { source: 'file' });
  const predicate = { exists: { element: { id: 'policy', type: 'component' } } };
  assert.deepEqual(core.query.validate(predicate), { ok: true, errors: [] });
  assert.equal(core.query.evaluate(design, predicate, {}).passed, true);
});

test('query reports an unreadable design as neither passed nor failed', () => {
  const core = loadCore();
  const design = core.load('systems: [unclosed', { source: 'embed' });
  assert.equal(core.query.evaluate(design, { exists: { element: { id: 'x' } } }, {}).passed, null);
});

test('a checks predicate through the facade sees the structural diagnostics of the design', () => {
  const core = loadCore();
  const design = core.load('systems:\n  shop:\n    name: Shop\n    description: Sells books to readers.\n    collaborators:\n      nowhere: asks for prices from\n',
    { source: 'file' });
  const predicate = { checks: { max_errors: 0, categories: ['model'] } };
  const result = core.query.evaluate(design, predicate, {});
  assert.equal(result.passed, false);
  assert.match(result.message, /model\/unknown-reference/);
  assert.equal(core.query.evaluate(core.load(fixture('course-registration.yml'), { source: 'file' }), predicate, {}).passed, true);
});

test('a host-supplied checks function replaces the facade default', () => {
  const core = loadCore();
  const design = core.load(fixture('course-registration.yml'), { source: 'file' });
  const finding = { rule: 'c4/no-description', severity: 'warning', category: 'c4', message: 'stub', element: 'web' };
  const result = core.query.evaluate(design, { checks: { max_warnings: 0 } }, { checks: () => [finding] });
  assert.equal(result.passed, false);
});

test('an unreadable design answers every facade call without throwing', () => {
  const core = loadCore();
  const design = core.load('systems:\n  a:\n    name: [unclosed\n', { source: 'embed' });
  assert.deepEqual(core.listViews(design), []);
  assert.equal(core.defaultView(design), null);
  assert.deepEqual(core.dependentsOf(design, 'a'), []);
  assert.deepEqual(core.classifySteps(design, 'enroll'), []);

  const view = core.project(design, 'Context of a');
  assert.equal(view.type, null);
  assert.equal(view.key, 'context of a');
  assert.deepEqual(view.diagnostics.map((found) => found.rule), ['yaml/syntax']);
  assert.equal(core.describe(view).brief, `This view cannot be drawn. ${view.diagnostics[0].message} (line 4).`);
});

test('classifySteps returns no steps for a scenario the design does not have', () => {
  const core = loadCore();
  assert.deepEqual(core.classifySteps(core.load(fixture('course-registration.yml'), { source: 'file' }), 'nothing'), []);
});

test('describe and toUml turn view models into text', () => {
  const core = loadCore();
  const design = core.load(fixture('course-registration.yml'), { source: 'file' });
  const containers = core.project(design, 'containers of registration');
  assert.match(core.describe(containers).brief, /Container view/);
  const code = core.toUml(core.project(design, 'code of policy'));
  assert.equal(code.type, 'class');
  assert.match(code.text, /EnrollmentPolicy/);
});

test('classifySteps mirrors the steps of a scenario', () => {
  const core = loadCore();
  const design = core.load(fixture('course-registration.yml'), { source: 'file' });
  const steps = core.classifySteps(design, 'enroll');
  assert.deepEqual(steps.map((step) => step.kind), ['message', 'message', 'fragment']);
});

test('extractEmbed reads the view key', () => {
  const core = loadCore();
  const text = 'view: containers of registration\nsystems:\n  registration:\n    name: Course Registration\n';
  assert.deepEqual(core.extractEmbed(text), { selector: 'containers of registration', text });
});

test('extractEmbed returns a null selector when the embed has no view key or is unreadable', () => {
  const core = loadCore();
  assert.equal(core.extractEmbed('systems:\n  a:\n    name: A\n').selector, null);
  assert.equal(core.extractEmbed('systems: [unclosed').selector, null);
});

test('rules publishes the rule metadata without check functions', () => {
  const rules = loadCore().rules;
  const unknownKey = rules.find((rule) => rule.id === 'schema/unknown-key');
  assert.equal(unknownKey.severity, 'error');
  assert.equal(unknownKey.category, 'schema');
  assert.ok(rules.every((rule) => typeof rule.check === 'undefined'));
});

test('the committed JSON Schema equals the generated one', () => {
  const committed = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  assert.deepEqual(committed, loadCore().toJsonSchema());
});

test('text fields accept strings, numbers, and booleans', () => {
  const text = loadCore().toJsonSchema().definitions.text;
  assert.deepEqual([...text.type].sort(), ['boolean', 'number', 'string']);
});

test('typed fields accept their value or its text form', () => {
  const { definitions } = loadCore().toJsonSchema();
  assert.ok(definitions.boolean.anyOf.some((option) => option.type === 'boolean'));
  assert.ok(definitions.boolean.anyOf.some((option) => option.type === undefined && option.enum.join() === 'true,false'));
  assert.ok(definitions.integer.anyOf.some((option) => option.type === 'string' && new RegExp(option.pattern).test('3')));
});

test('the JSON Schema allows exactly the fields the model schema allows on each element type', () => {
  const { definitions } = loadCore().toJsonSchema();
  Object.entries(require('../../c4/c4-schema.js').FIELDS).forEach(([type, fields]) => {
    assert.deepEqual(Object.keys(definitions[type].properties).sort(), fields.slice().sort(), type);
  });
});

const REFERENCES_PER_COMPONENT = 5;

/**
 * A 300-element model (9 people, 1 system, 10 containers of 28 components). Every component has a responsibility and
 * collaborates with five components of the next container, so each container has 140 incoming references.
 */
function generatedLargeModel() {
  const component = (c, k) => {
    const next = (c + 1) % 10;
    const collaborators = Array.from({ length: REFERENCES_PER_COMPONENT }, (_, r) =>
      `              c${next}-k${(k + r) % 28}: {description: asks for help with job ${k} from, technology: JSON/HTTPS}\n`).join('');
    return `          c${c}-k${k}:\n            name: Part ${c}-${k}\n            description: Does one small job in container ${c}.\n`
      + `            technology: Python module\n            responsibilities:\n              - do small job number ${k}\n`
      + `            collaborators:\n${collaborators}`;
  };
  const containers = Array.from({ length: 10 }, (_, c) => {
    const components = Array.from({ length: 28 }, (__, k) => component(c, k)).join('');
    return `      c${c}:\n        name: Container ${c}\n        description: Holds part of the system.\n        technology: Python\n        components:\n${components}`;
  }).join('');
  const people = Array.from({ length: 9 }, (_, p) => `  p${p}:\n    name: Person ${p}\n    description: Uses the big system.\n`
    + `    collaborators:\n      c${p}-k0: works with\n`).join('');
  return `people:\n${people}systems:\n  big:\n    name: Big System\n    description: A system with many parts.\n    containers:\n${containers}`;
}

test('a generated 300-element model loads, checks, and projects every view within 3 seconds', () => {
  const core = loadCore();
  const text = generatedLargeModel();
  const started = Date.now();
  const design = core.load(text, { source: 'file' });
  core.check(design);
  const views = core.listViews(design);
  views.forEach((view) => core.project(design, view.selector));
  const elapsed = Date.now() - started;
  assert.equal(design.model.elements.size, 9 + 1 + 10 + 280);
  assert.equal(design.model.relationships.length, 9 + 280 * REFERENCES_PER_COMPONENT);
  assert.ok(views.length > 10);
  assert.ok(elapsed < TIME_BOUND_MS, `took ${elapsed} ms`);
});

test('deleting a container of the 300-element model removes its 140 incoming references within 1 second', () => {
  const core = loadCore();
  const design = core.load(generatedLargeModel(), { source: 'file' });
  const started = Date.now();
  const result = core.edit(design, { op: 'deleteElement', elementId: 'c3' });
  const elapsed = Date.now() - started;
  const after = core.load(result.text, { source: 'file' }).model;
  assert.equal(after.elements.size, 300 - 29);
  assert.equal(after.relationships.filter((relationship) => relationship.targetId.startsWith('c3-')).length, 0);
  assert.equal(after.relationships.length, 9 + 280 * REFERENCES_PER_COMPONENT - 28 * REFERENCES_PER_COMPONENT * 2 - 1);
  assert.ok(elapsed < DELETE_TIME_BOUND_MS, `took ${elapsed} ms`);
});
