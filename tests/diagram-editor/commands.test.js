'use strict';

// The commands of a session (UML-view editing spec §2.1, §2.4, §3.4; plan Task 23): a command builds an operation
// from the document as the adapter reads it when the command runs, has the adapter apply it, and reports the
// verdict. A verdict with a message goes to host.announce with the verdict, so a host can show its offer; a verdict
// without one is not announced (a shared action of the C4 host announces itself). An accepted verdict's `select` is
// the selection the next sync brings back. The tests drive createCommands with a fake adapter and a fake host, the
// two ports the module owns.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCommands } = require('../../diagram-editor/de-commands.js');
const { accepted, refused } = require('../../diagram-editor/de-operations.js');

/** An adapter whose document is `state.revision` and whose apply answers `state.verdict`; it logs every call. */
function fakeAdapter(state) {
  const calls = [];
  return {
    calls,
    contents: () => {
      calls.push('contents');
      return { type: 'class', revision: state.revision, elements: [], relations: [], fragments: [], activations: [] };
    },
    tools: () => ({ elements: [], relations: [], unavailable: [] }),
    can: (operation) => {
      calls.push(['can', operation]);
      return accepted(null, null);
    },
    targets: (request) => {
      calls.push(['targets', request]);
      return state.advice === undefined ? null : state.advice;
    },
    apply: (operation) => {
      calls.push(['apply', operation]);
      return state.verdict;
    },
  };
}

/** A host that records what it is asked to announce. */
function fakeHost() {
  const announced = [];
  return { announced, announce: (message, options) => announced.push({ message, options }) };
}

function commandsOver(state) {
  const adapter = fakeAdapter(state);
  const host = fakeHost();
  const commands = createCommands({ adapter, host, scene: null, selection: null, env: {} });
  return { adapter, host, commands };
}

const RENAMED = { id: 'Invoice', kind: 'node' };

test('a refused verdict is announced with its verdict and changes nothing', async () => {
  const verdict = refused('rename/taken', 'Another class has that name', 'Not renamed: another class is called Invoice.', null);
  const { adapter, host, commands } = commandsOver({ revision: 'r1:10', verdict });

  const answer = await commands.rename({ id: 'Order', kind: 'node' }, 'Invoice');

  assert.equal(answer, verdict, 'run answers the adapter\'s verdict');
  assert.deepEqual(host.announced, [{ message: verdict.message, options: { verdict } }]);
  assert.equal(commands.restoreForNextSync(), null, 'a refusal brings no selection back');
  assert.equal(adapter.calls.filter((call) => call[0] === 'apply').length, 1, 'the operation was applied once, and nothing else was');
});

test('a verdict without a message is not announced', async () => {
  const { host, commands } = commandsOver({ revision: 'r1:10', verdict: accepted(RENAMED, null) });

  await commands.rename({ id: 'Order', kind: 'node' }, 'Invoice');

  assert.deepEqual(host.announced, []);
});

test('an accepted verdict\'s select is the restore of the next sync', async () => {
  const { host, commands } = commandsOver({ revision: 'r1:10', verdict: accepted(RENAMED, 'Renamed Order to Invoice.') });

  await commands.rename({ id: 'Order', kind: 'node' }, 'Invoice');

  assert.deepEqual(host.announced.map((entry) => entry.message), ['Renamed Order to Invoice.']);
  assert.deepEqual(commands.restoreForNextSync(), RENAMED, 'the next sync brings the renamed element back');
  assert.equal(commands.restoreForNextSync(), null, 'and only that sync');
});

test('commands read contents when they build an operation, not at sync', async () => {
  const state = { revision: 'r1:10', verdict: accepted(RENAMED, null) };
  const { adapter, commands } = commandsOver(state);
  adapter.contents();                       // the session's reading at sync
  state.revision = 'r2:12';                 // the document changes before the gesture

  await commands.rename({ id: 'Order', kind: 'node' }, 'Invoice');

  const [, operation] = adapter.calls.find((call) => call[0] === 'apply');
  assert.equal(operation.op, 'element.rename');
  assert.equal(operation.revision, 'r2:12', 'the operation carries the revision read when it was built');
  assert.deepEqual(operation.ref, { id: 'Order', kind: 'node' });
  assert.equal(operation.text, 'Invoice');
});

test('targetsFor asks the adapter once per request and returns null when it gives no advice', () => {
  const request = { op: 'relation.add', tool: 'association', from: 'Order', label: null, open: 'to' };
  const silent = commandsOver({ revision: 'r1:10' });

  assert.equal(silent.commands.targetsFor(request), null, 'no advice: no target is marked');
  assert.equal(silent.adapter.calls.filter((call) => call[0] === 'targets').length, 1);

  const advice = [{ ref: { id: 'Invoice', kind: 'node' }, ok: true, code: null, summary: null }];
  const advised = commandsOver({ revision: 'r1:10', advice });
  assert.deepEqual(advised.commands.targetsFor(request), advice);
  assert.equal(advised.adapter.calls.filter((call) => call[0] === 'targets').length, 1);
});
