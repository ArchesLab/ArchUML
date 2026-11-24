(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../c4-core.js'), function () {
      return { interfacesShared: require('./c4-editor-interfaces-shared.js') };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.interfacesMeaning = factory(root.ArchUMLC4, function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (C4, editorParts) {
  'use strict';

  // The meaning of data and the shared vocabulary in the Semantic view (spec §4.11, §9.5), a unit of the interface
  // forms (c4-editor-interfaces.js): each field's meaning, unit, format, the meanings of its allowed values, and its
  // example, filtered to the fields that need a unit or format; and the terms the interface defines.

  /**
   * The meaning of data and the vocabulary. `kit` is the interface forms' context (c4-editor-interfaces.js). Returns
   * `meaningOfData(declared)`, `vocabularySection(model, declared)`, and, for focus requests, `allFields(declared)`,
   * `unitApplies(entry)`, and `formatApplies(entry)`.
   */
  function createMeaningSections(kit) {
    const { dom, ids, announce, field, formSection, disclosure, button, listEditor, run, problem, lockReason, touchesLock,
      addRowUnlessLocked, requestFocus, scheduleRender, view, frame, definitionTerms, coreFinds, viewToggle } = kit;
    const { UNIT_RULES, FORMAT_RULES, PAYLOAD_PARTS, schema, fieldData, optionalText, slug, onEnter } = editorParts().interfacesShared;

    /** Every field of the interface with the label of its owner, in document order: inline fields, then types. */
    function allFields(declared) {
      const inline = declared.operations.flatMap((operation) => PAYLOAD_PARTS
        .filter(({ part }) => operation[part] && operation[part].fields)
        .flatMap(({ part }) => operation[part].fields.map((entry) => ({ field: entry, owner: `${operation.id} ${part}` }))));
      const typed = [...declared.types.values()].flatMap((type) => type.fields.map((entry) => ({ field: entry, owner: type.name })));
      return inline.concat(typed);
    }

    function unitApplies(entry) {
      return Boolean(entry.type) && (schema().NUMERIC_TYPES.includes(entry.type.name) || coreFinds(UNIT_RULES, entry.path));
    }

    function formatApplies(entry) {
      return Boolean(entry.type) && (schema().TEMPORAL_TYPES.includes(entry.type.name) || entry.type.name === 'string');
    }

    function needsUnitOrFormat(entry) {
      return coreFinds(UNIT_RULES.concat(FORMAT_RULES), entry.path);
    }

    function meaningOfData(declared) {
      const entries = allFields(declared).filter(({ field: entry }) => !view.needsOnly || needsUnitOrFormat(entry));
      const owners = [...new Set(entries.map((entry) => entry.owner))];
      return formSection('iface-meaning', 'Meaning of data', [
        dom.el('div', { class: 'c4-editor__meaning-filters' }, [
          viewToggle('iface-show-all', 'Show all properties', view.showAll, (on) => { view.showAll = on; scheduleRender(); requestFocus('iface-show-all'); }),
          viewToggle('iface-needs-only', 'Fields that need a unit or format', view.needsOnly,
            (on) => { view.needsOnly = on; scheduleRender(); requestFocus('iface-needs-only'); }),
        ]),
        entries.length === 0 ? dom.el('p', { class: 'c4-editor__field-hint',
          text: view.needsOnly ? 'No field needs a unit or format.' : 'No fields yet; add them in the Syntactic view.' }) : null,
        owners.map((owner) => [
          dom.el('h5', { class: 'c4-editor__meaning-owner', text: owner }),
          entries.filter((entry) => entry.owner === owner).map(({ field: entry }) => meaningRow(declared, entry)),
        ]),
      ]);
    }

    function meaningRow(declared, entry) {
      const owner = ownerOf(declared, entry);
      const key = `iface-meaning-${slug(entry.path.slice(declared.path.length).join('-'))}`;
      const labelId = ids(`insp-${key}-label`);
      const write = (changes, label) => run({ op: 'setField', interfaceId: declared.id, owner, fieldName: entry.name, field: fieldData(entry, changes) }, label);
      const property = (name, label, kind, rules) => field({ key: `${key}-${name}`, label, value: entry[name], path: entry.path.concat(name),
        lintPath: entry.path, lintRules: rules, hint: frame(kind, { field: entry.name }),
        onCommit: (value) => write({ [name]: optionalText(value) }, `Edit the ${label.toLowerCase()} of ${entry.name}`) });
      const valuesWithMeaning = entry.values ? entry.values.map((value) => field({ key: `${key}-value-${slug(value.value)}`,
        label: `Meaning of ${value.value}`, value: value.meaning, path: entry.path.concat('values', value.value), lintPath: null,
        onCommit: (text) => run({ op: 'setValues', interfaceId: declared.id, owner, fieldName: entry.name,
          values: Object.fromEntries(entry.values.map((other) => [other.value, other.value === value.value ? optionalText(text) : other.meaning])) },
        `Edit the meaning of ${value.value}`) })) : null;
      return dom.el('div', { class: 'c4-editor__meaning-row', role: 'group', 'aria-labelledby': labelId }, [
        dom.el('p', { id: labelId, class: 'c4-editor__meaning-name', text: `${entry.name}: ${entry.typeText}` }),
        property('meaning', 'Meaning', 'meaning', ['interface/no-meaning']),
        view.showAll || unitApplies(entry) ? property('unit', 'Unit', 'unit', UNIT_RULES) : null,
        view.showAll || formatApplies(entry) ? property('format', 'Format', 'format', FORMAT_RULES) : null,
        valuesWithMeaning,
        disclosure(`${key}-example`, entry.example ? `Example: ${entry.example}` : 'Example: none yet', () => [
          field({ key: `${key}-example`, label: 'Example', value: entry.example, path: entry.path.concat('example'), lintPath: null,
            onCommit: (value) => write({ example: optionalText(value) }, `Edit the example of ${entry.name}`) }),
        ]),
      ]);
    }

    /** The `owner` argument of the field commands for a field found by allFields. */
    function ownerOf(declared, entry) {
      const rest = entry.path.slice(declared.path.length);
      return rest[0] === 'types' ? { typeName: rest[1] } : { operationId: rest[1], part: rest[2] };
    }

    // ---- Vocabulary --------------------------------------------------------------------------------------------

    function vocabularySection(model, declared) {
      const path = declared.path.concat('vocabulary');
      const set = (term, meaning, label) => run({ op: 'setVocabularyTerm', interfaceId: declared.id, term, meaning }, label);
      const rows = listEditor({
        name: 'iface-vocabulary',
        label: `Terms of ${declared.name}`,
        itemName: 'term',
        items: declared.vocabulary,
        locked: touchesLock(path) ? (lockReason(path) || kit.lockedText) : null,
        rowLocked: (index) => lockReason(declared.vocabulary[index].path),
        renderRow: (entry, index) => field({ key: `iface-term-${index}`, label: `Meaning of ${entry.term}`, value: entry.meaning, path: entry.path,
          onCommit: (meaning) => (meaning.trim() === '' ? problem(`iface-term-${index}`, 'Error: A term needs a meaning; to remove it, choose Remove in its menu.')
            : set(entry.term, meaning.trim(), `Edit the term ${entry.term}`)) }),
        onRemove: (index) => set(declared.vocabulary[index].term, null, `Remove the term ${declared.vocabulary[index].term}`),
        emptyFocusKey: 'iface-new-term',
      });
      const add = () => {
        const term = kit.byKey('iface-new-term').value.trim();
        const meaning = kit.byKey('iface-new-term-meaning').value.trim();
        if (term === '') return problem('iface-new-term', 'Error: Write the term first.');
        if (meaning === '') return problem('iface-new-term-meaning', `Error: Say what ${term} means.`);
        if (set(term, meaning, `Add the term ${term}`)) {
          announce(`Added the term ${term}.`);
          requestFocus('iface-new-term');
        }
        return true;
      };
      const newTerm = () => {
        const newFields = [
          field({ key: 'iface-new-term', label: 'New term', value: '', path, lintPath: null, onCommit: () => {} }),
          field({ key: 'iface-new-term-meaning', label: 'Meaning of the new term', value: '', path, lintPath: null, onCommit: () => {} }),
        ];
        newFields.forEach((node) => node.querySelector('input').addEventListener('keydown', onEnter(add)));
        return dom.el('div', { class: 'c4-editor__list-add' }, [newFields, button('Add term', add)]);
      };
      return formSection('iface-vocabulary', 'Shared vocabulary', [
        definitionTerms('iface-vocabulary', ['shared-vocabulary'])
          || dom.el('p', { class: 'c4-editor__field-hint', text: 'Terms both sides agree on, so the same word means the same thing.' }),
        model.vocabulary.length > 0 ? dom.el('div', { class: 'c4-editor__field' }, [
          dom.el('p', { class: 'c4-editor__field-label', text: 'Terms every interface shares (from the model\'s vocabulary)' }),
          dom.el('dl', { class: 'c4-editor__facts' }, model.vocabulary.map((entry) => [dom.el('dt', { text: entry.term }), dom.el('dd', { text: entry.meaning })])),
        ]) : null,
        declared.vocabulary.length > 0 ? rows : dom.el('p', { class: 'c4-editor__field-hint', text: `${declared.name} defines no terms of its own yet.` }),
        addRowUnlessLocked(path, '*', ['terms', 'term'], newTerm),
      ]);
    }

    return { meaningOfData, vocabularySection, allFields, unitApplies, formatApplies };
  }

  return { createMeaningSections };
});
