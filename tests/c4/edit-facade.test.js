'use strict';

// The edit facade (`ArchUMLC4.edit`, spec §4.9–§4.11) is assembled from its command modules twice: when Node
// `require`s c4-core.js, and when a page loads the manifest's `core` scripts in order as classic scripts. Both must
// reach every command family, the dependents queries, and the refusals the same way.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadCore, fixture } = require('./helpers.js');

const ARCHUML_ROOT = path.join(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ARCHUML_ROOT, 'c4', 'manifest.json'), 'utf8'));
const MODEL = fixture('course-registration-interfaces.yml');
const WITHOUT_HEADER = MODEL.replace(/^schema: .*\n/m, '');

/** The core as a page gets it: every `core` script of the manifest run in order in a fresh classic-script context. */
function classicCore() {
  const context = vm.createContext({});
  context.self = context;
  manifest.core.forEach((file) => {
    vm.runInContext(fs.readFileSync(path.join(ARCHUML_ROOT, file), 'utf8'), context, { filename: file });
  });
  return context.ArchUMLC4;
}

/** A value copied into this realm, so that strict deep equality can compare values of the two realms. */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** One command of each family the facade dispatches, each of which changes the fixture (or the model given after it). */
const COMMANDS = [
  ['an element', { op: 'addElement', type: 'system', name: 'Library Catalog' }],
  ['an element id', { op: 'changeElementId', elementId: 'api', newId: 'gateway' }],
  ['an element and its dependents', { op: 'deleteElement', elementId: 'db' }],
  ['an element move', { op: 'moveElement', elementId: 'policy', newParentId: 'web' }],
  ['a responsibility', { op: 'addResponsibility', elementId: 'web', kind: 'know', text: 'the draft schedules of a student' }],
  ['a relationship', { op: 'addRelationship', sourceId: 'student', targetId: 'billing', description: 'pays tuition through' }],
  ['the interfaces a relationship uses', { op: 'setUses', relationshipId: 'web->coordinator', uses: ['enrollment-api'] }],
  ['a list field', { op: 'setList', elementId: 'web', field: 'tags', items: ['frontend'] }],
  ['a scenario step', { op: 'addStep', scenarioId: 'enroll', containerPath: [], index: 0, step: { from: 'student', to: 'web', description: 'opens' } }],
  ['a deployment node', { op: 'addNode', environmentId: 'production', name: 'Backup Site' }],
  ['a top-level entry', { op: 'setTopLevelEntry', section: 'groups', id: 'campus', value: 'Campus systems' }],
  ['a pinned position', { op: 'pinPosition', viewKey: 'containers of registration', elementId: 'web', x: 40, y: 80 }],
  ['the schema header', { op: 'ensureSchemaHeader' }, WITHOUT_HEADER],
  ['an interface', { op: 'addInterface', elementId: 'billing', name: 'Refunds' }],
  ['an operation', { op: 'addOperation', interfaceId: 'enrollment-api', syntax: 'GET /v1/enrollments/{id}' }],
  ['an operation id', { op: 'renameOperation', interfaceId: 'enrollment-api', operationId: 'submit-plan', newId: 'enroll' }],
  ['a type field', {
    op: 'setField', interfaceId: 'enrollment-api', owner: { typeName: 'EnrollmentOutcome' }, fieldName: 'note',
    field: { type: 'string', meaning: 'a remark for the student' },
  }],
  ['an interface and its uses', { op: 'removeInterface', interfaceId: 'enrollment-api' }],
  ['a batch', {
    op: 'batch',
    commands: [{ op: 'addElement', type: 'person', name: 'Advisor' }, { op: 'pinPosition', viewKey: 'context of registration', elementId: 'advisor', x: 0, y: 0 }],
  }],
];

const node = loadCore();
const classic = classicCore();

COMMANDS.forEach(([family, command, model = MODEL]) => {
  test(`the classic-script facade edits ${family} as the Node facade does`, () => {
    const expected = node.edit(node.load(model), command);
    assert.equal(expected.error, undefined, `precondition: ${command.op} succeeds on the fixture (${expected.message})`);
    assert.notEqual(expected.text, model, `precondition: ${command.op} changes the fixture`);
    assert.deepEqual(plain(classic.edit(classic.load(model), command)), plain(expected));
  });
});

test('the classic-script facade refuses an unknown command and bad arguments as the Node facade does', () => {
  [{ op: 'noSuchCommand' }, { op: 'addElement', type: 'system', name: ' ' }, { op: 'renameOperation', interfaceId: 'nothing', operationId: 'x', newId: 'y' }]
    .forEach((command) => {
      const expected = node.edit(node.load(MODEL), command);
      assert.ok(expected.error, `precondition: ${command.op} is refused`);
      assert.deepEqual(plain(classic.edit(classic.load(MODEL), command)), plain(expected));
    });
});

test('the classic-script facade lists the dependents of an element and of an interface as the Node facade does', () => {
  const expected = [node.dependentsOf(node.load(MODEL), 'db'), node.interfaceDependentsOf(node.load(MODEL), 'enrollment-api')];
  assert.ok(expected.every((dependents) => dependents.length > 0), 'precondition: both have dependents in the fixture');
  const design = classic.load(MODEL);
  assert.deepEqual(plain([classic.dependentsOf(design, 'db'), classic.interfaceDependentsOf(design, 'enrollment-api')]), plain(expected));
});
