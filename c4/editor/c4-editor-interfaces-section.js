(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../c4-core.js'), function () {
      return { interfacesShared: require('./c4-editor-interfaces-shared.js') };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.interfacesSection = factory(root.ArchUMLC4, function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (C4, editorParts) {
  'use strict';

  // The Interfaces section of a system, container, or component (spec §9.5), a unit of the interface forms
  // (c4-editor-interfaces.js): a row per interface the element provides, its shorthand syntax lines with
  // Describe fully, and the new-interface row.

  /**
   * The Interfaces section. `kit` is the interface forms' context (c4-editor-interfaces.js). Returns
   * `section(model, element)` and `shorthandBody(element, declared)`.
   */
  function createInterfacesSection(kit) {
    const { state, dom, announce, field, formSection, button, listEditor, textList, run, problem, lockReason, touchesLock,
      addRowUnlessLocked, requestFocus, view, definitionTerms, shown, renameLock, moveMapEntry, openForm, openChangeIdDialog } = kit;
    const { styleChoices, TEXT, interfacesOfElement, problemCount, plural, slug, onEnter } = editorParts().interfacesShared;

    function section(model, element) {
      const declared = interfacesOfElement(model, element.id);
      const providesPath = element.path.concat('provides');
      const reason = lockReason(providesPath);
      const rows = listEditor({
        name: 'interfaces',
        label: 'Interfaces',
        itemName: 'interface',
        items: declared,
        locked: touchesLock(providesPath) ? (reason || kit.lockedText) : null,
        rowLocked: (index) => lockReason(declared[index].path),
        renderRow: (item) => interfaceRow(model, element, item),
        onMove: declared.some((item) => item.shorthand) ? undefined
          : (from, to) => moveMapEntry(providesPath, declared.map((item) => item.id), from, to, `Move an interface of ${element.name}`),
        onRemove: (index) => run({ op: 'removeInterface', interfaceId: declared[index].id }, `Remove ${declared[index].name}`),
        extraItems: (index) => [{
          label: 'Change interface id…',
          unavailable: renameLock(declared[index].path, declared[index].name, 'id', { declared: declared[index] }) || (declared[index].shorthand ? `Error: ${declared[index].name} is a shorthand list; describe it fully first.` : null),
          run: (context) => openChangeIdDialog(declared[index], {
            returnFocus: context && context.returnFocus, focusAfter: (newId) => `iface-row-${slug(newId)}` }),
        }],
        emptyFocusKey: 'iface-new-name',
      });
      return formSection('interfaces', 'Interfaces', [
        definitionTerms('iface-section', ['interface-description']),
        reason ? dom.el('p', { class: 'c4-editor__lock-note', text: reason }) : null,
        declared.length > 0 ? rows : dom.el('p', { class: 'c4-editor__field-hint', text: TEXT.empty(element.name) }),
        addRowUnlessLocked(providesPath, '*', ['interfaces', 'interface'], () => newInterface(element)),
        dom.el('div', { class: 'c4-editor__inspector-actions' }, button('Show interfaces view',
          () => state.openView(`interfaces of ${element.id}`), { 'data-c4-focus-key': 'iface-show-view' })),
      ]);
    }

    function interfaceRow(model, element, declared) {
      const operations = plural(declared.operations.length, 'operation', 'operations');
      const style = styleChoices().find((choice) => choice.value === (declared.style || '')).word;
      const problems = problemCount(shown(declared));
      const summary = [style, operations, problems].filter(Boolean).join(', ');
      return dom.el('div', { class: 'c4-editor__interface-row' }, [
        button(declared.name, () => openForm(declared.id), { class: 'c4-editor__button c4-editor__interface-open',
          'data-c4-focus-key': `iface-row-${slug(declared.id)}` }),
        dom.el('p', { class: 'c4-editor__interface-summary', text: declared.shorthand ? `${operations}; shorthand list` : summary }),
        declared.shorthand ? shorthandBody(element, declared) : null,
      ]);
    }

    /** The syntax lines of a shorthand list, edited inline, and Describe fully (spec §9.5). */
    function shorthandBody(element, declared) {
      const providesPath = element.path.concat('provides');
      return [
        textList({ key: `iface-${slug(declared.id)}-lines`, label: 'Syntax lines', itemName: 'syntax line', items: element.provides,
          path: providesPath, write: (items) => run({ op: 'setList', elementId: element.id, field: 'provides', items }, `Edit the syntax lines of ${element.name}`) }),
        lockReason(providesPath) ? null : button('Describe fully', () => describeFully(element), { 'data-c4-focus-key': `iface-${slug(declared.id)}-describe` }),
      ];
    }

    function describeFully(element) {
      if (run({ op: 'expandProvidesShorthand', elementId: element.id }, `Describe the interface of ${element.name} fully`)) {
        announce(`The interface of ${element.name} is described fully; its operation ids are kept.`);
        requestFocus(`iface-row-${slug(element.id)}`);
      }
    }

    function newInterface(element) {
      const nameKey = 'iface-new-name';
      const styleKey = 'iface-new-style';
      const add = () => {
        const name = kit.byKey(nameKey).value.trim();
        const style = kit.byKey(styleKey).value || null;
        if (name === '') return problem(nameKey, 'Error: Name the interface first, such as Enrollment API.');
        const result = state.dispatch({ op: 'addInterface', elementId: element.id, name, style }, { label: `Add an interface to ${element.name}` });
        if (!result.ok) return problem(nameKey, state.refusalText(result));
        view.newStyle = '';
        announce(`Added the interface ${name} to ${element.name}.`);
        openForm(result.selection.interfaceId, { focusKey: 'title' });
        return true;
      };
      const nameField = field({ key: nameKey, label: 'New interface name', value: '', path: element.path.concat('provides'), lintPath: null,
        onCommit: () => {} });
      const styleField = field({ key: styleKey, label: 'Style of the new interface', control: 'select', value: view.newStyle,
        choices: styleChoices(), path: element.path.concat('provides'), lintPath: null, onCommit: (value) => { view.newStyle = value; } });
      nameField.querySelector('input').addEventListener('keydown', onEnter(add));
      styleField.querySelector('select').addEventListener('keydown', onEnter(add));
      return dom.el('div', { class: 'c4-editor__list-add c4-editor__interface-add' }, [nameField, styleField, button('Add interface', add)]);
    }

    return { section, shorthandBody };
  }

  return { createInterfacesSection };
});
