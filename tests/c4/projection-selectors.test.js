'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const y = require('../../c4/c4-yaml.js');
const modelApi = require('../../c4/c4-model.js');
const p = require('../../c4/c4-projection.js');
const { fixture } = require('./helpers.js');

function load(text) {
  return modelApi.normalize(y.parse(text), { source: 'file' }).model;
}

const model = load(fixture('course-registration.yml'));
const emptyModel = load('');

test('selectors parse to canonical form', () => {
  assert.equal(p.parseSelector('System Context of registration').canonical, 'context of registration');
  assert.equal(p.parseSelector('container of registration').canonical, 'containers of registration');
  assert.equal(p.parseSelector('dynamic enroll').type, 'dynamic');
  assert.equal(p.parseSelector('student-journey').type, 'custom');
  assert.ok(p.parseSelector('containers of').error);
});

function selectorFields(parsed) {
  const { type, scopeId, viewId, canonical } = parsed;
  return { type, scopeId, viewId, canonical };
}

test('a parsed selector names its type, scope, and custom view id', () => {
  assert.deepEqual(selectorFields(p.parseSelector('Components  of API')),
    { type: 'components', scopeId: 'API', viewId: null, canonical: 'components of API' });
  assert.deepEqual(selectorFields(p.parseSelector('student-journey')),
    { type: 'custom', scopeId: null, viewId: 'student-journey', canonical: 'student-journey' });
  assert.deepEqual(selectorFields(p.parseSelector('landscape')),
    { type: 'landscape', scopeId: null, viewId: null, canonical: 'landscape' });
});

test('a bare view keyword or a malformed selector is a syntax error', () => {
  assert.ok(p.parseSelector('containers').error);
  assert.ok(p.parseSelector('').error);
  assert.ok(p.parseSelector('code of a b').error);
});

test('the canonical selector of a parsed selector round-trips', () => {
  for (const text of ['landscape', 'context of registration', 'code of policy', 'dynamic enroll', 'deployment production', 'student-journey']) {
    assert.equal(p.canonicalSelector(p.parseSelector(text)), text);
  }
});

test('the reference model lists its views in a stable order', () => {
  assert.deepEqual(p.listViews(model).map(v => v.selector), ['landscape', 'context of registration',
    'containers of registration', 'components of api', 'code of policy', 'dynamic enroll', 'deployment production']);
});

test('listed views carry their type, scope, and title', () => {
  const byKey = new Map(p.listViews(model).map(v => [v.selector, v]));
  assert.deepEqual(byKey.get('containers of registration'),
    { selector: 'containers of registration', type: 'containers', scopeId: 'registration', title: 'Container view: Course Registration' });
  assert.equal(byKey.get('dynamic enroll').title, 'Dynamic view: Enroll in a planned schedule');
});

test('an empty model lists only the landscape', () => {
  assert.deepEqual(p.listViews(emptyModel).map(v => v.selector), ['landscape']);
});

test('custom views are listed after the built-in views', () => {
  const custom = load(fixture('course-registration.yml') + '\nviews:\n  student-journey:\n    view: containers of registration\n    title: Student journey\n');
  const last = p.listViews(custom).pop();
  assert.deepEqual(last, { selector: 'student-journey', type: 'custom', scopeId: null, title: 'Student journey' });
});

test('unknown and wrong-type selectors are diagnosed', () => {
  assert.equal(p.resolveView(model, 'containers of nowhere').diagnostic.rule, 'view/unknown-selector');
  assert.equal(p.resolveView(model, 'code of api').diagnostic.rule, 'view/wrong-scope-type');
  assert.equal(p.resolveView(model, 'components of registration').diagnostic.rule, 'view/wrong-scope-type');
});

test('unknown scenarios, environments, custom views, and malformed selectors are unknown selectors', () => {
  for (const text of ['dynamic nothing', 'deployment nowhere', 'no-such-view', 'containers of']) {
    const { diagnostic } = p.resolveView(model, text);
    assert.equal(diagnostic.rule, 'view/unknown-selector', text);
    assert.equal(diagnostic.severity, 'error');
    assert.equal(diagnostic.category, 'view');
  }
});

test('a resolvable selector yields a request with the model element id', () => {
  assert.deepEqual(selectorFields(p.resolveView(model, 'Container  of registration').request),
    { type: 'containers', scopeId: 'registration', viewId: null, canonical: 'containers of registration' });
  assert.equal(p.resolveView(model, 'landscape').request.type, 'landscape');
  assert.equal(p.resolveView(model, 'dynamic enroll').request.scopeId, 'enroll');
});

test('selector keywords match ignoring case, but ids match exactly (spec §4.10)', () => {
  assert.equal(p.parseSelector('CONTEXT of Reg').canonical, 'context of Reg');
  assert.equal(p.parseSelector('Dynamic Enroll').canonical, 'dynamic Enroll');
  assert.equal(p.parseSelector('Student-Journey').canonical, 'Student-Journey');
  const { diagnostic } = p.resolveView(model, 'components of API');
  assert.equal(diagnostic.rule, 'view/unknown-selector');
  assert.equal(diagnostic.message, 'There is no element named API');
  assert.equal(diagnostic.hint, 'Ids are case-sensitive; did you mean api?');
  assert.equal(p.resolveView(model, 'dynamic Enroll').diagnostic.rule, 'view/unknown-selector');
});

test('a mixed-case id is resolved, listed, and projected under its declared spelling', () => {
  const mixed = load(['systems:', '  Reg:', '    name: Registration', '    containers:', '      Web:', '        name: Web App'].join('\n'));
  assert.deepEqual(p.listViews(mixed).map(v => v.selector), ['landscape', 'context of Reg', 'containers of Reg']);
  const view = p.projectView(mixed, 'containers of Reg');
  assert.equal(view.key, 'containers of Reg');
  assert.deepEqual(view.nodes.map(n => n.id), ['Web']);
  assert.equal(p.projectView(mixed, 'containers of reg').diagnostics[0].rule, 'view/unknown-selector');
});

test('two systems whose ids differ only in case are two distinct views', () => {
  const twins = load(['systems:', '  Reg:', '    name: Reg One', '    containers:', '      a:', '        name: Alpha',
    '  reg:', '    name: Reg Two', '    containers:', '      b:', '        name: Beta'].join('\n'));
  const upper = p.projectView(twins, 'containers of Reg');
  const lower = p.projectView(twins, 'containers of reg');
  assert.equal(upper.title, 'Container view: Reg One');
  assert.deepEqual(upper.nodes.map(n => n.id), ['a']);
  assert.equal(lower.title, 'Container view: Reg Two');
  assert.deepEqual(lower.nodes.map(n => n.id), ['b']);
});

test('default view is the first internal system context, else landscape', () => {
  assert.equal(p.defaultView(model), 'context of registration');
  assert.equal(p.defaultView(emptyModel), 'landscape');
});

test('breadcrumbs lead from the landscape to the current view', () => {
  assert.deepEqual(p.breadcrumbs(model, p.resolveView(model, 'components of api').request).map(b => b.label),
    ['Landscape', 'Context: Course Registration', 'Containers: Course Registration', 'Components: Registration API']);
});

test('breadcrumbs of a code view reach down to the component, each linking to its selector', () => {
  const crumbs = p.breadcrumbs(model, p.resolveView(model, 'code of policy').request);
  assert.deepEqual(crumbs.map(b => b.selector), ['landscape', 'context of registration', 'containers of registration',
    'components of api', 'code of policy']);
  assert.equal(crumbs[4].label, 'Code: Enrollment Policy');
});

test('breadcrumbs of the landscape, a scenario, and an environment', () => {
  assert.deepEqual(p.breadcrumbs(model, p.resolveView(model, 'landscape').request).map(b => b.label), ['Landscape']);
  assert.deepEqual(p.breadcrumbs(model, p.resolveView(model, 'dynamic enroll').request),
    [{ selector: 'landscape', label: 'Landscape' }, { selector: 'dynamic enroll', label: 'Dynamic: Enroll in a planned schedule' }]);
  const crumbs = p.breadcrumbs(model, p.resolveView(model, 'deployment production').request);
  assert.equal(crumbs[1].selector, 'deployment production');
  assert.match(crumbs[1].label, /^Deployment: /);
});

test('drill targets point to the next level down', () => {
  assert.equal(p.drillTarget(model, 'registration'), 'containers of registration');
  assert.equal(p.drillTarget(model, 'api'), 'components of api');
  assert.equal(p.drillTarget(model, 'policy'), 'code of policy');
  assert.equal(p.drillTarget(model, 'web'), null);
  assert.equal(p.drillTarget(model, 'billing'), null);
});

test('people, code elements, and unknown ids have no drill target', () => {
  assert.equal(p.drillTarget(model, 'student'), null);
  assert.equal(p.drillTarget(model, 'EnrollmentPolicy'), null);
  assert.equal(p.drillTarget(model, 'nowhere'), null);
});
