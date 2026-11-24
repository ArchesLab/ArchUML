'use strict';

// What the module adds for a host surface (UML-view editing spec §3.4; plan Task 38): two operations a host surface
// sends, `element.reparent` (a thing put into another one, or at the top level) and `fragment.removeBranch`, each with
// its command, and the text adapter's answer to both. The UML editor's classic surface sends neither, so the text
// adapter refuses them with `not-supported` and writes nothing.

const test = require('node:test');
const assert = require('node:assert/strict');

const operations = require('../../diagram-editor/de-operations.js');
const { createCommands } = require('../../diagram-editor/de-commands.js');
const { createTextAdapter } = require('../../diagram-editor/text/te-adapter.js');

/** Commands over a fake adapter that logs what it is asked to apply and accepts it, and a host that logs what it is told. */
function commandsWithLog() {
  const log = { applied: [], announced: [] };
  const adapter = {
    contents: () => ({ revision: 'r7' }),
    can: () => operations.accepted(null, null),
    targets: () => null,
    apply(operation) {
      log.applied.push(operation);
      return operations.accepted(null, 'Done.');
    },
  };
  const host = { announce: (message) => log.announced.push(message) };
  return { commands: createCommands({ adapter, host, selection: null }), log };
}

test('the vocabulary has element.reparent { ref, parent } and fragment.removeBranch { ref, branch }', () => {
  assert.deepEqual(operations.OPERATIONS['element.reparent'], { family: 'element', fields: ['ref', 'parent'] });
  assert.deepEqual(operations.OPERATIONS['fragment.removeBranch'], { family: 'sequence', fields: ['ref', 'branch'] });
  assert.equal(operations.validate({ op: 'element.reparent', revision: 'r1', ref: 'Pod', parent: null }), null,
    'a parent of null (the top level) is a parent');
  assert.equal(operations.validate({ op: 'fragment.removeBranch', revision: 'r1', ref: 'frag:3' }), 'fragment.removeBranch has no branch.');
});

test('reparent builds element.reparent, with null for the top level', async () => {
  const { commands, log } = commandsWithLog();

  await commands.reparent('Pod', 'Cloud');
  await commands.reparent('Pod', null);

  assert.deepEqual(log.applied.map((operation) => ({ op: operation.op, revision: operation.revision, ref: operation.ref, parent: operation.parent })), [
    { op: 'element.reparent', revision: 'r7', ref: 'Pod', parent: 'Cloud' },
    { op: 'element.reparent', revision: 'r7', ref: 'Pod', parent: null },
  ]);
  log.applied.forEach((operation) => assert.equal(operations.validate(operation), null));
  assert.deepEqual(log.announced, ['Done.', 'Done.'], 'each verdict is reported');
});

test('removeBranch builds fragment.removeBranch', async () => {
  const { commands, log } = commandsWithLog();

  const verdict = await commands.removeBranch('frag:3', 2);

  assert.equal(verdict.ok, true);
  assert.equal(log.applied.length, 1);
  const [operation] = log.applied;
  assert.deepEqual({ op: operation.op, revision: operation.revision, ref: operation.ref, branch: operation.branch },
    { op: 'fragment.removeBranch', revision: 'r7', ref: 'frag:3', branch: 2 });
  assert.equal(operations.validate(operation), null);
});

test('the text adapter refuses element.reparent and fragment.removeBranch with not-supported', () => {
  const text = '@startuml\nnode Cloud\nnode Pod\n@enduml';
  const writes = [];
  const adapter = createTextAdapter({ read: () => text, write: (written) => writes.push(written), type: () => 'deployment', bundle: {} });
  const revision = operations.revisionOf(text);

  for (const operation of [
    { op: 'element.reparent', revision, ref: 'Pod', parent: 'Cloud', undo: { key: null } },
    { op: 'fragment.removeBranch', revision, ref: 'frag:1', branch: 1, undo: { key: null } },
  ]) {
    const verdict = adapter.apply(operation);
    assert.equal(verdict.ok, false, operation.op);
    assert.equal(verdict.code, 'not-supported', operation.op);
    assert.equal(typeof verdict.message, 'string', `${operation.op} says why`);
    assert.ok(verdict.message.length > 0, `${operation.op} says why`);
    assert.ok(verdict.summary.length <= 60, `${operation.op}'s summary fits one line of a menu`);
  }
  assert.deepEqual(writes, [], 'nothing is written');
});
