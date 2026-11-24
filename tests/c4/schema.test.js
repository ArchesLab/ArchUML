'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('../../vendor/yaml/2.9.1/yaml.js');
const schema = require('../../c4/c4-schema.js');
const { fixture } = require('./helpers.js');

test('responsibility shorthand reads KNOW, DO, and DECIDE case-insensitively', () => {
  assert.deepEqual(schema.parseResponsibilityShorthand('DO sequence one attempt'), { kind: 'do', text: 'sequence one attempt' });
  assert.deepEqual(schema.parseResponsibilityShorthand('decide whether a student may enroll'), { kind: 'decide', text: 'whether a student may enroll' });
  assert.deepEqual(schema.parseResponsibilityShorthand('Know the open seats'), { kind: 'know', text: 'the open seats' });
  assert.deepEqual(schema.parseResponsibilityShorthand('Track seats'), { kind: null, text: 'Track seats' });
});

test('responsibility shorthand ignores a leading verb that is only a word prefix', () => {
  assert.deepEqual(schema.parseResponsibilityShorthand('Document grades'), { kind: null, text: 'Document grades' });
});

test('step shorthand splits "a -> b" keys', () => {
  assert.deepEqual(schema.parseStepShorthand('web -> coordinator'), { from: 'web', to: 'coordinator' });
  assert.deepEqual(schema.parseStepShorthand('web->coordinator'), { from: 'web', to: 'coordinator' });
  assert.equal(schema.parseStepShorthand('web'), null);
  assert.equal(schema.parseStepShorthand('web -> '), null);
});

test('pattern shorthand reads pattern and role', () => {
  assert.deepEqual(schema.parsePatternShorthand('Strategy: Context'), { pattern: 'Strategy', role: 'Context' });
  assert.deepEqual(schema.parsePatternShorthand('Facade'), { pattern: 'Facade', role: null });
});

test('slugify produces valid ids for any name', () => {
  assert.equal(schema.slugify('Registration API', 'container'), 'registration-api');
  assert.equal(schema.slugify('Café Menü', 'container'), 'cafe-menu');
  assert.equal(schema.slugify('学生', 'person'), 'person');
  assert.equal(schema.slugify('3D Printer', 'container'), 'c-3d-printer');
  assert.equal(schema.slugify('Enrollment Policy', 'code'), 'EnrollmentPolicy');
  for (const name of ['', '   ', '---', '学生', '3D', 'a b c']) {
    for (const type of schema.ELEMENT_TYPES) {
      assert.match(schema.slugify(name, type), schema.ID_PATTERN, `${type}: "${name}"`);
    }
  }
});

test('uniqueId appends the first free numeric suffix', () => {
  assert.equal(schema.uniqueId('api', new Set()), 'api');
  assert.equal(schema.uniqueId('api', new Set(['api'])), 'api-2');
  assert.equal(schema.uniqueId('api', new Set(['api', 'api-2'])), 'api-3');
});

test('suggest proposes the closest known key', () => {
  assert.equal(schema.suggest('responsibilites', schema.FIELDS.component), 'responsibilities');
  assert.equal(schema.suggest('colaborators', schema.FIELDS.system), 'collaborators');
  assert.equal(schema.suggest('zzzz', schema.FIELDS.component), null);
});

test('suggest treats a transposition as one edit', () => {
  assert.equal(schema.suggest('naem', ['name', 'tags']), 'name');
});

test('a person has no responsibilities slot but a code element has no children keys', () => {
  assert.equal(schema.FIELDS.person.includes('responsibilities'), false);
  assert.equal(schema.FIELDS.person.includes('external'), true);
  assert.equal(schema.FIELDS.code.includes('operations'), true);
  assert.deepEqual(schema.CHILD_KEY, { system: 'containers', container: 'components', component: 'code' });
  assert.equal(schema.CHILD_KEY.code, undefined);
});

test('every child key is an allowed field of its parent type', () => {
  for (const [type, childKey] of Object.entries(schema.CHILD_KEY)) {
    assert.ok(schema.FIELDS[type].includes(childKey), `${type} allows ${childKey}`);
  }
});

test('connectors match the spec and exactly message, event, and stream are asynchronous', () => {
  assert.deepEqual(schema.CONNECTORS, ['call', 'message', 'event', 'stream', 'shared-data']);
  assert.deepEqual(schema.ASYNC_CONNECTORS, ['message', 'event', 'stream']);
});

test('every catalog pattern lists its required roles among its roles', () => {
  const names = Object.keys(schema.PATTERNS);
  assert.equal(names.length, 14);
  for (const name of names) {
    const { roles, required } = schema.PATTERNS[name];
    assert.ok(required.length > 0, `${name} has required roles`);
    for (const role of required) assert.ok(roles.includes(role), `${name} lists ${role}`);
  }
  assert.deepEqual(schema.PATTERNS.Observer.required, ['Subject', 'Observer']);
  assert.ok(schema.PATTERNS.Observer.roles.includes('ConcreteSubject'));
  assert.deepEqual(schema.PATTERNS.Command.required, ['Command', 'ConcreteCommand', 'Receiver', 'Invoker']);
});

test('canonical key order matches the spec', () => {
  assert.deepEqual(schema.CANONICAL_ORDER.slice(0, 3), ['name', 'description', 'kind']);
  assert.deepEqual(schema.CANONICAL_ORDER.slice(-2), ['tags', 'source']);
  assert.ok(schema.CANONICAL_ORDER.indexOf('collaborators') > schema.CANONICAL_ORDER.indexOf('responsibilities'));
});

test('the manifest lists the vendored parser first and every core module in load order', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'c4', 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.core.slice(0, 2), ['vendor/yaml/2.9.1/yaml.js', 'c4/c4-schema.js']);
  assert.equal(manifest.core.at(-1), 'c4/c4-core.js');
  assert.equal(manifest.core.length, 18);
});

test('the reference fixture parses as YAML', () => {
  const doc = yaml.parseDocument(fixture('course-registration.yml'), { schema: 'failsafe', uniqueKeys: true });
  assert.equal(doc.errors.length, 0);
  assert.equal(doc.get('schema'), schema.SCHEMA_VERSION);
});
