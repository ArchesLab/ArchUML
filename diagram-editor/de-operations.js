(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var parts = root.ArchUMLDiagramEditorParts = root.ArchUMLDiagramEditorParts || {};
    // A second load of the module replaces nothing (spec §2.2).
    if (!parts.operations) parts.operations = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The operation vocabulary of the diagram editor (UML-view editing spec §3.4; plan Task 21): every operation an
  // edit adapter takes, with the fields its row names; the two verdicts an adapter answers with; and the revision
  // token both adapters derive from their document's text, so an operation logged in one process replays in another.
  // It sits in the `core` group because every host needs it, also the C4 editor, which loads no text adapter.

  // Each operation: its family; `fields`, which every sender gives (a field may be null); `optional`, fields a
  // sender may add (refinements the classic editor's commands send, plan Tasks 11-16); and for fragment.add,
  // `oneOf`, of which exactly one is present: `at` for a palette stub, `wrap` for a wrap of messages.
  const MEMBER = { family: 'member', fields: ['owner', 'list', 'index', 'text'] };
  const OPERATIONS = Object.freeze({
    'layout.setMode': { family: 'layout', fields: ['mode'] },
    'layout.set': { family: 'layout', fields: ['positions', 'routes'] },
    'layout.reset': { family: 'layout', fields: ['target'] },
    'element.add': { family: 'element', fields: ['tool', 'name', 'into', 'anchor', 'placed'] },
    'element.rename': { family: 'element', fields: ['ref', 'text'], optional: ['part'] },
    'element.update': { family: 'element', fields: ['ref', 'changes'] },
    'element.duplicate': { family: 'element', fields: ['refs', 'offset'], optional: ['scope'] },
    'element.remove': { family: 'element', fields: ['ref'] },
    // A thing put into another one, or at the top level (`parent: null`); only a host surface sends it (plan Task 38).
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
    // Branch `branch` of the fragment `ref` taken away; only a host surface sends it (plan Task 38).
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
  });

  const has = (object, name) => Object.prototype.hasOwnProperty.call(object, name) && object[name] !== undefined;

  /**
   * What is wrong with `operation` as a sender built it, as one sentence, or null when nothing is: it names an
   * operation of the vocabulary, carries a revision, and has every field its row requires (a field set to null is
   * there). Validation of what the fields say belongs to the adapter's apply (spec §3.4).
   */
  function validate(operation) {
    if (!operation || typeof operation.op !== 'string') return 'The operation has no op naming what it does.';
    const definition = OPERATIONS[operation.op];
    if (!definition) return `${operation.op} is not an operation of the diagram editor.`;
    if (!has(operation, 'revision')) return `${operation.op} has no revision of the document it was built from.`;
    const missing = definition.fields.filter((field) => !has(operation, field));
    if (missing.length) return `${operation.op} has no ${missing.join(', ')}.`;
    if (definition.oneOf && definition.oneOf.filter((field) => has(operation, field)).length !== 1) {
      return `${operation.op} needs exactly one of ${definition.oneOf.join(' and ')}.`;
    }
    return null;
  }

  /** The verdict of a change made: `select` names the changed thing in the new drawing, `message` is its sentence. */
  function accepted(select, message) {
    return { ok: true, select: select, message: message };
  }

  /**
   * The verdict of a change refused, which changed nothing: a stable `code`, a one-line `summary` for menus and
   * choosers, the `message` to show and announce (none for `cancelled`), and at most one `offer`, or null.
   */
  function refused(code, summary, message, offer) {
    return { ok: false, code: code, summary: summary, message: message, offer: offer === undefined ? null : offer };
  }

  /** The revision token of a document (plan, Global Constraints): FNV-1a over its UTF-16 code units, and its length. */
  function revisionOf(text) {
    var hash = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return 'r' + hash.toString(16).padStart(8, '0') + ':' + text.length;
  }

  return { OPERATIONS, validate, accepted, refused, revisionOf };
});
