'use strict';

// The operation vocabulary (UML-view editing spec §3.4; plan Task 21): every operation an edit adapter
// takes, with the fields its row names, the verdict shape, and the revision token both adapters share.
// The operations are those of spec §3.4 that the classic editor's commands build (plan Tasks 11-16),
// with the fields those tasks refined; fields only the classic editor sends are optional.

const test = require('node:test');
const assert = require('node:assert/strict');

const operations = require('../../diagram-editor/de-operations.js');

const MEMBER = { family: 'member', fields: ['owner', 'list', 'index', 'text'] };

// Each operation: its family, its required fields, the fields a sender may add, and for fragment.add the
// alternatives of which exactly one is present.
const EXPECTED = {
  'layout.setMode': { family: 'layout', fields: ['mode'] },
  'layout.set': { family: 'layout', fields: ['positions', 'routes'] },
  'layout.reset': { family: 'layout', fields: ['target'] },
  'element.add': { family: 'element', fields: ['tool', 'name', 'into', 'anchor', 'placed'] },
  'element.rename': { family: 'element', fields: ['ref', 'text'], optional: ['part'] },
  'element.update': { family: 'element', fields: ['ref', 'changes'] },
  'element.duplicate': { family: 'element', fields: ['refs', 'offset'], optional: ['scope'] },
  'element.remove': { family: 'element', fields: ['ref'] },
  'element.reparent': { family: 'element', fields: ['ref', 'parent'] },
  'selection.remove': { family: 'element', fields: ['elements', 'relations', 'fragments', 'activations'] },
  'member.add': MEMBER,
  'member.update': MEMBER,
  'member.remove': MEMBER,
  'relation.add': { family: 'relation', fields: ['tool', 'from', 'to', 'label'] },
  'relation.update': { family: 'relation', fields: ['ref', 'changes'] },
  'relation.rewire': { family: 'relation', fields: ['ref', 'end', 'to'], optional: ['relation'] },
  'relation.invert': { family: 'relation', fields: ['ref'] },
  'lifeline.add': { family: 'sequence', fields: ['tool', 'name'] },
  'lifeline.reorder': { family: 'sequence', fields: ['order'] },
  'message.move': { family: 'sequence', fields: ['ref', 'at'] },
  'fragment.add': { family: 'sequence', fields: ['operator'], oneOf: ['at', 'wrap'], optional: ['guard'] },
  'fragment.update': { family: 'sequence', fields: ['ref', 'operator', 'guard'] },
  'fragment.addBranch': { family: 'sequence', fields: ['ref', 'guard'] },
  'fragment.removeBranch': { family: 'sequence', fields: ['ref', 'branch'] },
  'fragment.unwrap': { family: 'sequence', fields: ['ref'] },
  'fragment.move': { family: 'sequence', fields: ['ref', 'at'] },
  'activation.add': { family: 'sequence', fields: ['lifeline', 'slots'] },
  'activation.set': { family: 'sequence', fields: ['ref', 'lifeline', 'slots'] },
  'source.replace': { family: 'source', fields: ['text'] },
  'source.insertLines': { family: 'source', fields: ['lines', 'at'], optional: ['frame'] },
  'source.replaceLines': { family: 'source', fields: ['range', 'lines'] },
  'source.removeLines': { family: 'source', fields: ['range'] },
  'source.moveLines': { family: 'source', fields: ['line', 'swapWith'] },
  'source.replaceDeclaration': { family: 'source', fields: ['ref', 'text'] },
};

/** An operation's row as plain data: its family and its field lists, sorted, with empty lists left out. */
function rowOf(definition) {
  const row = { family: definition.family, fields: [...definition.fields].sort() };
  if (definition.optional && definition.optional.length) row.optional = [...definition.optional].sort();
  if (definition.oneOf && definition.oneOf.length) row.oneOf = [...definition.oneOf].sort();
  return row;
}

/** A complete operation `op` with every required field, and `at` for fragment.add. */
function completeOperation(op) {
  const definition = EXPECTED[op];
  const operation = { op, revision: operations.revisionOf('') };
  for (const field of definition.fields) operation[field] = null;
  if (definition.oneOf) operation[definition.oneOf[0]] = null;
  return operation;
}

test('every operation of spec §3.4 is defined with its fields', () => {
  assert.deepEqual(Object.keys(operations.OPERATIONS).sort(), Object.keys(EXPECTED).sort());
  for (const [op, definition] of Object.entries(EXPECTED)) {
    assert.deepEqual(rowOf(operations.OPERATIONS[op]), rowOf(definition), op);
  }
});

test('validate accepts an operation with its revision and every required field, a field set to null too', () => {
  for (const op of Object.keys(EXPECTED)) {
    assert.equal(operations.validate(completeOperation(op)), null, op);
  }
});

test('validate names a missing required field', () => {
  const operation = completeOperation('element.rename');
  delete operation.text;

  const problem = operations.validate(operation);

  assert.equal(typeof problem, 'string');
  assert.match(problem, /element\.rename/);
  assert.match(problem, /\btext\b/);
});

test('validate names a missing revision and an unknown operation', () => {
  const withoutRevision = completeOperation('relation.invert');
  delete withoutRevision.revision;

  assert.match(operations.validate(withoutRevision), /\brevision\b/);
  assert.match(operations.validate({ op: 'element.teleport', revision: 'r0:0' }), /element\.teleport/);
  assert.match(operations.validate({ revision: 'r0:0' }), /\bop\b/);
});

test('validate asks a fragment.add for exactly one of at and wrap', () => {
  const neither = { op: 'fragment.add', revision: 'r0:0', operator: 'alt' };
  const both = { ...neither, at: { beforeLine: 2 }, wrap: { fromLine: 2, toLine: 3 } };

  assert.match(operations.validate(neither), /\bat\b.*\bwrap\b/);
  assert.match(operations.validate(both), /\bat\b.*\bwrap\b/);
  assert.equal(operations.validate({ ...neither, wrap: { fromLine: 2, toLine: 3 }, guard: '' }), null);
});

test('accepted and refused build the two verdicts of spec §3.4', () => {
  const select = { id: 'Order', kind: 'node' };
  const offer = { label: 'Open the view', action: 'open-view' };

  assert.deepEqual({ ...operations.accepted(select, 'Added Order.') }, { ok: true, select, message: 'Added Order.' });
  assert.deepEqual(
    { ...operations.refused('relation/unmatched', 'Connection not found in the source', 'Could not locate that relation in the source.', offer) },
    { ok: false, code: 'relation/unmatched', summary: 'Connection not found in the source', message: 'Could not locate that relation in the source.', offer },
  );
  assert.equal(operations.refused('cancelled', 'Cancelled', null).offer, null, 'a refusal without an offer has offer null');
});

test('revisionOf is r, the FNV-1a 32-bit hash of the UTF-16 code units in eight lowercase hex digits, a colon, and the length', () => {
  // Test vectors of the FNV-1a 32-bit hash: the empty string, "a", and "foobar".
  assert.equal(operations.revisionOf(''), 'r811c9dc5:0');
  assert.equal(operations.revisionOf('a'), 're40c292c:1');
  assert.equal(operations.revisionOf('foobar'), 'rbf9cf968:6');
  // A code unit above 0xff takes part whole, so two texts differing only there differ.
  assert.notEqual(operations.revisionOf('Ā'), operations.revisionOf('\u0000'));
});
