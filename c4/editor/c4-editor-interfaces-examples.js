(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../c4-core.js'), function () {
      return { interfacesShared: require('./c4-editor-interfaces-shared.js') };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.interfacesExamples = factory(root.ArchUMLC4, function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (C4, editorParts) {
  'use strict';

  // An operation's examples in the Semantic view (spec §9.5), a unit of the interface forms (c4-editor-interfaces.js):
  // each example's input, output, and note, and a new example built from one value box per field, or, for the
  // expert profile, written as YAML flow text. A draft that does not parse stays with its "Error:" line.

  /**
   * The examples editor. `kit` is the interface forms' context (c4-editor-interfaces.js). Returns
   * `examplesEditor(declared, operation)`.
   */
  function createExamplesEditor(kit) {
    const { state, dom, ids, announce, field, button, listEditor, run, problem, lockReason, touchesLock, addRowUnlessLocked,
      requestFocus, scheduleRender, view, isNovice, viewToggle } = kit;
    const { PAYLOAD_PARTS, TEXT, payloadFields, exampleText, optionalText, slug } = editorParts().interfacesShared;

    function draftOf(key) {
      if (!view.drafts.has(key)) view.drafts.set(key, { values: { input: {}, output: {} }, yaml: { input: '', output: '' }, note: '', asYaml: false, errors: {} });
      return view.drafts.get(key);
    }

    function examplesEditor(declared, operation) {
      const key = `iface-examples-${slug(operation.id)}`;
      const examplesPath = operation.path.concat('examples');
      const rows = listEditor({
        name: key,
        label: `Examples of ${operation.id}`,
        itemName: 'example',
        items: operation.examples,
        locked: touchesLock(examplesPath) ? (lockReason(examplesPath) || kit.lockedText) : null,
        rowLocked: (index) => lockReason(operation.examples[index].path),
        renderRow: (example, index) => exampleRow(declared, operation, example, index, key),
        onRemove: (index) => run({ op: 'removeExample', interfaceId: declared.id, operationId: operation.id, index }, `Remove an example of ${operation.id}`),
        emptyFocusKey: `${key}-new-note`,
      });
      return dom.el('div', { class: 'c4-editor__field c4-editor__text-list', role: 'group', 'aria-labelledby': ids(`insp-${key}-label`) }, [
        dom.el('p', { id: ids(`insp-${key}-label`), class: 'c4-editor__field-label', text: 'Examples' }),
        operation.examples.length > 0 ? rows : null,
        addRowUnlessLocked(examplesPath, String(operation.examples.length), ['examples', 'example'],
          () => newExample(declared, operation, key, examplesPath)),
      ]);
    }

    function exampleRow(declared, operation, example, index, key) {
      const rowKey = `${key}-${index}`;
      const update = (changes, label) => {
        const result = C4.edit(state.getDesign(), Object.assign({ op: 'updateExample', interfaceId: declared.id, operationId: operation.id, index }, changes));
        if (result.error === 'example-syntax') return problem(`${rowKey}-${Object.keys(changes)[0]}`, syntaxError(result));
        return run(Object.assign({ op: 'updateExample', interfaceId: declared.id, operationId: operation.id, index }, changes), label);
      };
      const textField = (part, label, value) => (isNovice()
        ? (value ? dom.el('p', { class: 'c4-editor__example-text' }, [dom.el('span', { class: 'c4-editor__field-label', text: `${label}: ` }), value]) : null)
        : field({ key: `${rowKey}-${part}`, label: `${label} of example ${index + 1}`, value, path: example.path.concat(part.replace('Text', '')),
          onCommit: (text) => update({ [part]: optionalText(text) }, `Edit an example of ${operation.id}`) }));
      return dom.el('div', { class: 'c4-editor__interface-example' }, [
        textField('inputText', 'Input', example.inputText),
        textField('outputText', 'Output', example.outputText),
        field({ key: `${rowKey}-note`, label: `Note of example ${index + 1}`, value: example.note, path: example.path.concat('note'),
          onCommit: (text) => update({ note: optionalText(text) }, `Edit an example of ${operation.id}`) }),
      ]);
    }

    /**
     * A new example built from one value box per field of the input and output (typed as the field's type); the
     * expert profile can write YAML flow text instead. Text that does not parse stays as a draft with "Error:" and the
     * parser's line, and nothing is written (spec §9.5).
     */
    function newExample(declared, operation, key, examplesPath) {
      const draft = draftOf(`${declared.id}.${operation.id}`);
      const asYaml = draft.asYaml && !isNovice();
      const draftField = (fieldKey, label, value, store, extra = {}) => field(Object.assign({ key: fieldKey, label, value, path: examplesPath,
        lintPath: null, onCommit: store }, extra));
      const boxes = PAYLOAD_PARTS.map(({ part, label }) => payloadFields(declared, operation, part).map((entry) => {
        const name = entry.name || '';
        const boxLabel = `${label}${entry.name ? ` ${entry.name}` : ''} (${entry.typeText || 'any'})`;
        return draftField(`${key}-new-${part}-${slug(name || 'value')}`, boxLabel, draft.values[part][name] || '',
          (value) => { draft.values[part][name] = value; });
      }));
      const yamlFields = PAYLOAD_PARTS.map(({ part, label }) => draftField(`${key}-new-${part}-yaml`, `${label} as YAML flow text`,
        draft.yaml[part], (value) => { draft.yaml[part] = value; delete draft.errors[part]; },
        { problems: draft.errors[part] ? [{ severity: 'error', text: draft.errors[part] }] : [] }));
      const toggle = isNovice() ? null : viewToggle(`${key}-as-yaml`, 'Write the new example as YAML', draft.asYaml, (on) => {
        draft.asYaml = on;
        scheduleRender();
        requestFocus(`${key}-as-yaml`);
      });
      const add = () => addExample(declared, operation, draft, asYaml, key);
      const noBoxes = boxes.every((list) => list.length === 0);
      return dom.el('div', { class: 'c4-editor__list-add c4-editor__interface-example', role: 'group', 'aria-labelledby': ids(`insp-${key}-new-label`) }, [
        dom.el('p', { id: ids(`insp-${key}-new-label`), class: 'c4-editor__field-label', text: 'New example' }),
        toggle,
        asYaml ? yamlFields : (noBoxes ? dom.el('p', { class: 'c4-editor__field-hint', text: TEXT.noPayloadFields }) : boxes),
        draftField(`${key}-new-note`, 'Note of the new example', draft.note, (value) => { draft.note = value; }),
        button('Add example', add, { 'data-c4-focus-key': `${key}-add` }),
      ]);
    }

    function addExample(declared, operation, draft, asYaml, key) {
      const textOf = (part) => (asYaml ? optionalText(draft.yaml[part])
        : exampleText(payloadFields(declared, operation, part), draft.values[part]));
      const command = { op: 'addExample', interfaceId: declared.id, operationId: operation.id,
        inputText: textOf('input'), outputText: textOf('output'), note: optionalText(draft.note) };
      if (command.inputText === null && command.outputText === null && command.note === null) {
        return problem(`${key}-add`, 'Error: Fill in a value or a note first.');
      }
      draft.errors = {};
      PAYLOAD_PARTS.forEach(({ part }) => {
        const alone = Object.assign({}, command, { inputText: null, outputText: null, note: 'check', [`${part}Text`]: command[`${part}Text`] });
        const result = command[`${part}Text`] === null ? {} : C4.edit(state.getDesign(), alone);
        if (result.error === 'example-syntax') draft.errors[part] = syntaxError(result);
      });
      if (Object.keys(draft.errors).length > 0) {
        announce(Object.values(draft.errors)[0]);
        scheduleRender();
        return false;
      }
      const result = state.dispatch(command, { label: `Add an example to ${operation.id}` });
      if (!result.ok) return problem(`${key}-add`, state.refusalText(result));
      view.drafts.delete(`${declared.id}.${operation.id}`);
      announce(`Added example ${operation.examples.length + 1} of ${operation.id}.`);
      requestFocus(`${key}-add`);
      return true;
    }

    function syntaxError(result) {
      return `Error: ${result.message} (line ${result.line}).`;
    }

    return { examplesEditor };
  }

  return { createExamplesEditor };
});
