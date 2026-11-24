(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../c4-core.js'), function () {
      return { interfacesShared: require('./c4-editor-interfaces-shared.js') };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.interfacesSyntactic = factory(root.ArchUMLC4, function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (C4, editorParts) {
  'use strict';

  // The Syntactic view of the interface form (spec §9.5), a unit of the interface forms (c4-editor-interfaces.js):
  // each operation's id, syntax line, and input and output (a type, a list of it, or inline fields), then the types
  // (c4-editor-interfaces-types.js).

  /**
   * The Syntactic view. `kit` is the interface forms' context (c4-editor-interfaces.js) with the types unit. Returns
   * `syntacticView(model, declared)`.
   */
  function createSyntacticView(kit) {
    const { state, dom, announce, field, formSection, disclosure, listEditor, run, problem, lockReason, touchesLock,
      addRowUnlessLocked, scheduleRender, view, renameLock, addRow, typesSection, fieldsEditor, typeChoices,
      inlinePendingKey } = kit;
    const { INLINE, PAYLOAD_PARTS, TEXT, slug } = editorParts().interfacesShared;

    function syntacticView(model, declared) {
      return [operationsSection(declared), typesSection(declared)];
    }

    function operationsSection(declared) {
      const listPath = declared.path.concat('operations');
      const rows = listEditor({
        name: 'iface-operations',
        label: 'Operations',
        itemName: 'operation',
        items: declared.operations,
        locked: touchesLock(listPath) ? (lockReason(listPath) || kit.lockedText) : null,
        rowLocked: (index) => lockReason(declared.operations[index].path),
        renderRow: (operation) => operationDisclosure(declared, operation),
        onMove: (from, to) => run({ op: 'moveOperation', interfaceId: declared.id, from, to }, `Move an operation of ${declared.name}`),
        onRemove: (index) => run({ op: 'removeOperation', interfaceId: declared.id, operationId: declared.operations[index].id },
          `Remove ${declared.operations[index].id}`),
        emptyFocusKey: 'iface-new-operation',
      });
      return formSection('iface-operations', 'Operations', [
        declared.operations.length > 0 ? rows : dom.el('p', { class: 'c4-editor__field-hint',
          text: declared.types.size > 0 ? 'No operations: clients exchange the types below as a document.' : 'No operations yet.' }),
        addRowUnlessLocked(listPath, '*', ['operations', 'operation'], () => addRow('iface-new-operation', 'New operation syntax', 'Add operation', listPath, (syntax) => {
          const result = state.dispatch({ op: 'addOperation', interfaceId: declared.id, syntax }, { label: `Add an operation to ${declared.name}` });
          if (!result.ok) return state.refusalText(result);
          announce(`Added the operation ${result.selection.operationId}.`);
          return null;
        }, 'Write it as a client would, such as POST /v1/enrollments or evaluate(plan) -> Outcome.')),
      ]);
    }

    function operationDisclosure(declared, operation) {
      const key = `iface-op-${slug(operation.id)}`;
      const set = (fieldName, label) => (value) => run({ op: 'updateOperation', interfaceId: declared.id, operationId: operation.id,
        field: fieldName, value }, label);
      return disclosure(key, `${operation.id}: ${operation.syntax}`, () => [
        field({ key: `${key}-id`, label: 'Id', value: operation.id, path: operation.path, lintPath: null,
          locked: renameLock(operation.path, operation.id, 'id', { declared, operationId: operation.id }),
          onCommit: (value) => run({ op: 'renameOperation', interfaceId: declared.id, operationId: operation.id, newId: value.trim() },
            `Rename ${operation.id}`) }),
        field({ key: `${key}-syntax`, label: 'Syntax', value: operation.syntax, path: operation.path.concat('syntax'),
          lintPath: operation.path, lintRules: ['interface/no-syntax', 'interface/unbound-parameter'],
          onCommit: (value) => (value.trim() === '' ? problem(`${key}-syntax`, 'Error: An operation keeps its syntax line.')
            : set('syntax', `Edit the syntax of ${operation.id}`)(value.trim())) }),
        PAYLOAD_PARTS.map(({ part, label }) => payloadEditor(declared, operation, part, label, set)),
      ]);
    }

    /** The type picker of an operation's input or output, and the inline fields when it has (or gets) them. */
    function payloadEditor(declared, operation, part, label, set) {
      const key = `iface-op-${slug(operation.id)}-${part}`;
      const use = operation[part];
      // Choosing Inline fields writes nothing until the first field is added (newFieldRow), so the choice is kept here.
      const pendingKey = inlinePendingKey(declared, operation.id, part);
      const hasFields = Boolean(use && use.fields);
      const pending = view.inlinePending.has(pendingKey) && !hasFields;
      const current = pending || hasFields ? INLINE : !use ? '' : use.type ? use.type.name : use.typeText;
      const listed = Boolean(use && use.type && use.type.list);
      const path = operation.path.concat(part);
      const choose = (value) => {
        if (value === INLINE) {
          if (!hasFields) view.inlinePending.add(pendingKey);
          scheduleRender();
          return true;
        }
        view.inlinePending.delete(pendingKey);
        return set(part, `Change the ${part} of ${operation.id}`)(value === '' ? null : `${value}${listed ? '[]' : ''}`);
      };
      const choices = [{ value: '', label: 'None' }].concat(typeChoices(declared, current), [{ value: INLINE, label: 'Inline fields' }]);
      return dom.el('div', { class: 'c4-editor__payload' }, [
        field({ key: `${key}-type`, label: `${label} of ${operation.id}`, control: 'select', value: current, choices, path, onCommit: choose,
          hint: pending ? TEXT.inlinePending(part, use && use.typeText) : null }),
        current !== INLINE && use && use.type ? field({ key: `${key}-list`, label: `${label} is a list`, control: 'checkbox', value: listed,
          path, lintPath: null, onCommit: (isList) => set(part, `Change the ${part} of ${operation.id}`)(`${use.type.name}${isList ? '[]' : ''}`) }) : null,
        // Without an input or output yet, its fields can be added straight away; they are written as an inline map.
        current === INLINE || !use ? fieldsEditor(declared, { operationId: operation.id, part }, hasFields ? use.fields : [], path,
          `${part} field of ${operation.id}`) : dom.el('p', { class: 'c4-editor__field-hint', text: TEXT.inlineNote(part, use.typeText) }),
      ]);
    }

    return { syntacticView };
  }

  return { createSyntacticView };
});
