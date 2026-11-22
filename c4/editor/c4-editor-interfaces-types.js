(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../c4-core.js'), function () {
      return { interfacesShared: require('./c4-editor-interfaces-shared.js') };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.interfacesTypes = factory(root.ArchUMLC4, function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (C4, editorParts) {
  'use strict';

  // The data types of an interface (spec §4.11, §9.5), a unit of the interface forms (c4-editor-interfaces.js): the
  // Types section of the Syntactic view, and the fields of a type or of an inline input or output (name, type, list,
  // required, allowed values, constraints).

  /**
   * The types and fields editors. `kit` is the interface forms' context (c4-editor-interfaces.js). Returns
   * `typesSection(declared)`, `fieldsEditor(declared, owner, fields, holderPath, newLabel)`,
   * `typeChoices(declared, current)`, and `inlinePendingKey(declared, operationId, part)`.
   */
  function createTypesEditor(kit) {
    const { state, dom, announce, field, formSection, disclosure, button, listEditor, textList, run, problem, lockReason,
      touchesLock, addRowUnlessLocked, requestFocus, view, renameLock, moveMapEntry, addRow } = kit;
    const { INLINE, schema, fieldData, optionalText, slug, onEnter } = editorParts().interfacesShared;

    function inlinePendingKey(declared, operationId, part) {
      return JSON.stringify([declared.id, operationId, part]);
    }

    /** The primitives and this interface's types; a current value outside them stays listed as written. */
    function typeChoices(declared, current) {
      const names = schema().PRIMITIVE_TYPES.concat([...declared.types.keys()]);
      const extra = current && current !== INLINE && !names.includes(current) ? [current] : [];
      return names.concat(extra).map((name) => ({ value: name, label: name }));
    }

    function typesSection(declared) {
      const types = [...declared.types.values()];
      const listPath = declared.path.concat('types');
      const rows = listEditor({
        name: 'iface-types',
        label: 'Types',
        itemName: 'type',
        items: types,
        locked: touchesLock(listPath) ? (lockReason(listPath) || kit.lockedText) : null,
        rowLocked: (index) => lockReason(types[index].path),
        renderRow: (type) => typeDisclosure(declared, type),
        onMove: (from, to) => moveMapEntry(listPath, types.map((type) => type.name), from, to, `Move a type of ${declared.name}`),
        onRemove: (index) => {
          const result = state.dispatch({ op: 'setType', interfaceId: declared.id, typeName: types[index].name, value: null },
            { label: `Remove ${types[index].name}` });
          if (!result.ok) announce(state.refusalText(result));
          return result.ok;
        },
        emptyFocusKey: 'iface-new-type',
      });
      return formSection('iface-types', 'Types', [
        types.length > 0 ? rows : dom.el('p', { class: 'c4-editor__field-hint', text: 'No types yet.' }),
        addRowUnlessLocked(listPath, '*', ['types', 'type'], () => addRow('iface-new-type', 'New type name', 'Add type', listPath, (typeName) => {
          const result = state.dispatch({ op: 'setType', interfaceId: declared.id, typeName, value: {} }, { label: `Add a type to ${declared.name}` });
          if (!result.ok) return state.refusalText(result);
          announce(`Added the type ${typeName}.`);
          return null;
        }, 'A name such as EnrollmentRequest: letters, digits, and underscores.')),
      ]);
    }

    function typeDisclosure(declared, type) {
      const key = `iface-type-${slug(type.name)}`;
      return disclosure(key, type.name, () => [
        field({ key: `${key}-name`, label: 'Name', value: type.name, path: type.path, lintPath: null,
          locked: renameLock(type.path, type.name, 'name', { declared, typeName: type.name }),
          onCommit: (value) => run({ op: 'renameType', interfaceId: declared.id, typeName: type.name, newName: value.trim() }, `Rename ${type.name}`) }),
        field({ key: `${key}-description`, label: 'Description', control: 'textarea', value: type.description, path: type.path.concat('description'),
          onCommit: (value) => run({ op: 'setType', interfaceId: declared.id, typeName: type.name, value: { description: optionalText(value) } },
            `Edit the description of ${type.name}`) }),
        fieldsEditor(declared, { typeName: type.name }, type.fields, type.path.concat('fields'), `field of ${type.name}`),
      ]);
    }

    /** The fields of a type or of an inline input or output: name, type, required, allowed values, constraints. */
    function fieldsEditor(declared, owner, fields, holderPath, newLabel) {
      const ownerKey = owner.typeName ? `type-${owner.typeName}` : `op-${owner.operationId}-${owner.part}`;
      const listKey = `iface-fields-${slug(ownerKey)}`;
      const write = (fieldName, value, label) => run({ op: 'setField', interfaceId: declared.id, owner, fieldName, field: value }, label);
      const rows = listEditor({
        name: listKey,
        label: owner.typeName ? `Fields of ${owner.typeName}` : `Fields of the ${owner.part} of ${owner.operationId}`,
        itemName: 'field',
        items: fields,
        locked: touchesLock(holderPath) ? (lockReason(holderPath) || kit.lockedText) : null,
        rowLocked: (index) => lockReason(fields[index].path),
        renderRow: (entry) => syntacticFieldRow(declared, owner, entry, write),
        onMove: (from, to) => moveMapEntry(holderPath, fields.map((entry) => entry.name), from, to, 'Move a field'),
        onRemove: (index) => write(fields[index].name, null, `Remove ${fields[index].name}`),
        emptyFocusKey: `${listKey}-new`,
      });
      return dom.el('div', { class: 'c4-editor__field-group' }, [
        fields.length > 0 ? rows : null,
        addRowUnlessLocked(holderPath, '*', ['fields', 'field'], () => newFieldRow(declared, owner, `${listKey}-new`, newLabel, holderPath)),
      ]);
    }

    function syntacticFieldRow(declared, owner, entry, write) {
      const key = `iface-field-${slug(entry.path.slice(declared.path.length).join('-'))}`;
      const change = (changes, label) => write(entry.name, fieldData(entry, changes), label);
      const typeName = entry.type && !entry.type.invalid ? entry.type.name : entry.typeText;
      const listed = Boolean(entry.type && entry.type.list);
      const values = entry.values ? entry.values.map((value) => value.value) : [];
      return dom.el('div', { class: 'c4-editor__interface-field' }, [
        field({ key: `${key}-name`, label: `Name of ${entry.name}`, value: entry.name, path: entry.path, lintPath: null,
          locked: renameLock(entry.path, entry.name, 'name'),
          onCommit: (value) => run({ op: 'renameField', interfaceId: declared.id, owner, fieldName: entry.name, newName: value.trim() },
            `Rename ${entry.name}`) }),
        field({ key: `${key}-type`, label: `Type of ${entry.name}`, control: 'select', value: typeName, choices: typeChoices(declared, typeName),
          path: entry.path.concat('type'), lintPath: entry.path, lintRules: ['interface/undefined-type', 'interface/type-spelling', 'interface/untyped-field'],
          onCommit: (value) => change({ type: `${value}${listed ? '[]' : ''}` }, `Change the type of ${entry.name}`) }),
        field({ key: `${key}-list`, label: `${entry.name} is a list`, control: 'checkbox', value: listed, path: entry.path.concat('type'), lintPath: null,
          onCommit: (isList) => change({ type: `${typeName}${isList ? '[]' : ''}` }, `Change the type of ${entry.name}`) }),
        field({ key: `${key}-required`, label: `${entry.name} is required`, control: 'checkbox', value: entry.required !== false,
          path: entry.path.concat('required'), lintPath: null,
          onCommit: (required) => change({ required: required ? null : false }, `Change whether ${entry.name} is required`) }),
        textList({ key: `${key}-values`, label: `Allowed values of ${entry.name}`, itemName: 'allowed value', items: values,
          path: entry.path.concat('values'), write: (items) => run({ op: 'setValues', interfaceId: declared.id, owner, fieldName: entry.name,
            values: items.length === 0 ? null : valuesKeepingMeanings(entry, items) }, `Edit the allowed values of ${entry.name}`) }),
        textList({ key: `${key}-constraints`, label: `Constraints of ${entry.name}`, itemName: 'constraint', items: entry.constraints,
          path: entry.path.concat('constraints'), write: (items) => change({ constraints: items.length > 0 ? items : null },
            `Edit the constraints of ${entry.name}`) }),
      ]);
    }

    /** New allowed values, keeping the meaning of each value that stays (a list while no value has a meaning). */
    function valuesKeepingMeanings(entry, items) {
      const meanings = new Map((entry.values || []).map((value) => [value.value, value.meaning]));
      if (!items.some((item) => meanings.get(item))) return items;
      return Object.fromEntries(items.map((item) => [item, meanings.get(item) || null]));
    }

    function newFieldRow(declared, owner, key, label, holderPath) {
      const typeKey = `${key}-type`;
      const add = () => {
        const fieldName = kit.byKey(key).value.trim();
        const type = kit.byKey(typeKey).value;
        if (fieldName === '') return problem(key, `Error: Name the new ${label} first.`);
        const command = { op: 'setField', interfaceId: declared.id, owner, fieldName, field: { type } };
        const payload = owner.part ? declared.operations.find((operation) => operation.id === owner.operationId)[owner.part] : null;
        // An input or output written as a type becomes inline fields with its first field, in one undo step.
        const result = payload && !payload.fields
          ? state.dispatch({ op: 'batch', commands: [{ op: 'updateOperation', interfaceId: declared.id, operationId: owner.operationId,
            field: owner.part, value: null }, command] }, { label: `Add the field ${fieldName}` })
          : state.dispatch(command, { label: `Add the field ${fieldName}` });
        if (!result.ok) return problem(key, state.refusalText(result));
        if (owner.part) view.inlinePending.delete(inlinePendingKey(declared, owner.operationId, owner.part));
        announce(`Added the field ${fieldName}: ${type}.`);
        requestFocus(key);
        return true;
      };
      const nameField = field({ key, label: `New ${label}`, value: '', path: holderPath, lintPath: null, onCommit: () => {} });
      const typeField = field({ key: typeKey, label: `Type of the new ${label}`, control: 'select', value: 'string',
        choices: typeChoices(declared, 'string'), path: holderPath, lintPath: null, onCommit: () => {} });
      nameField.querySelector('input').addEventListener('keydown', onEnter(add));
      typeField.querySelector('select').addEventListener('keydown', onEnter(add));
      return dom.el('div', { class: 'c4-editor__list-add' }, [nameField, typeField, button(`Add ${label.split(' of ')[0]}`, add)]);
    }

    return { typesSection, fieldsEditor, typeChoices, inlinePendingKey };
  }

  return { createTypesEditor };
});
