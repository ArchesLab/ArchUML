(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../c4-core.js'), function () {
      return { interfacesShared: require('./c4-editor-interfaces-shared.js') };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.interfacesSemantic = factory(root.ArchUMLC4, function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (C4, editorParts) {
  'use strict';

  // The Semantic view of the interface form (spec §9.5), a unit of the interface forms (c4-editor-interfaces.js):
  // restrictions and errors of every operation, then each operation's purpose, side effects, restrictions, errors,
  // examples (c4-editor-interfaces-examples.js), and the responsibilities it realizes, then the meaning of data and the
  // shared vocabulary (c4-editor-interfaces-meaning.js).

  /**
   * The Semantic view. `kit` is the interface forms' context (c4-editor-interfaces.js) with the examples and meaning
   * units. Returns `semanticView(model, declared)`.
   */
  function createSemanticView(kit) {
    const { state, dom, ids, announce, field, formSection, disclosure, button, listEditor, textList, run, problem, lockReason,
      touchesLock, addRowUnlessLocked, requestFocus, scheduleRender, isNovice, frame, renameLock, examplesEditor, meaningOfData,
      vocabularySection } = kit;
    const { TEXT, realizesGroups, responsibilityLabel, plural, optionalText, slug, onEnter } = editorParts().interfacesShared;

    function semanticView(model, declared) {
      return [
        formSection('iface-all-operations', 'All operations', [
          restrictionsList(declared, null, declared.restrictions, declared.path.concat('restrictions')),
          errorsEditor(declared, null, declared.errors, declared.path),
        ]),
        declared.operations.map((operation) => operationSemantics(model, declared, operation)),
        meaningOfData(declared),
        vocabularySection(model, declared),
      ];
    }

    function operationSemantics(model, declared, operation) {
      const key = `iface-sem-${slug(operation.id)}`;
      const set = (fieldName, label) => (value) => run({ op: 'updateOperation', interfaceId: declared.id, operationId: operation.id,
        field: fieldName, value }, label);
      const context = { provider: model.elements.get(declared.providerId).name, style: declared.style };
      const hintOf = (kind) => frame(kind, context);
      const purpose = field({ key: `${key}-purpose`, label: 'Purpose', control: 'textarea', value: operation.purpose,
        path: operation.path.concat('purpose'), lintPath: operation.path, lintRules: ['interface/no-purpose'], hint: hintOf('purpose'),
        onCommit: (value) => set('purpose', `Edit the purpose of ${operation.id}`)(optionalText(value)) });
      const sideEffects = () => textList({ key: `${key}-side-effects`, label: 'Side effects', itemName: 'side effect', items: operation.sideEffects,
        path: operation.path.concat('side_effects'), hint: hintOf('side_effect'),
        write: (items) => set('side_effects', `Edit the side effects of ${operation.id}`)(items) });
      const restrictions = () => restrictionsList(declared, operation, operation.restrictions, operation.path.concat('restrictions'));
      const errors = errorsEditor(declared, operation, operation.errors, operation.path);
      const examples = () => examplesEditor(declared, operation);
      const realizes = realizesGroup(model, declared, operation);
      const described = (count, one, many) => (count === 0 ? 'not described yet' : `${plural(count, one, many)} described`);
      const body = isNovice()
        ? [purpose, errors, realizes,
          disclosure(`${key}-side-effects-more`, `Side effects: ${described(operation.sideEffects.length, 'side effect', 'side effects')}`, sideEffects),
          disclosure(`${key}-restrictions-more`, `Restrictions: ${described(operation.restrictions.length, 'restriction', 'restrictions')}`, restrictions),
          disclosure(`${key}-examples-more`, `Examples: ${operation.examples.length === 0 ? 'none yet' : plural(operation.examples.length, 'example', 'examples')}`, examples)]
        : [purpose, sideEffects(), restrictions(), errors, examples(), realizes];
      return formSection(key, `${operation.id}: ${operation.syntax}`, body);
    }

    function restrictionsList(declared, operation, items, path) {
      const scope = operation ? operation.id : declared.name;
      return textList({ key: `iface-restrictions-${slug(operation ? operation.id : 'all')}`, label: operation ? 'Restrictions' : 'Restrictions of every operation',
        itemName: 'restriction', items, path, hint: frame('restriction', { style: declared.style }),
        write: (next) => run({ op: 'setRestrictions', interfaceId: declared.id, operationId: operation ? operation.id : null, items: next },
          `Edit the restrictions of ${scope}`) });
    }

    /** Errors as rows of name, code, and "Happens when …; the client should then …" (spec §9.5). */
    function errorsEditor(declared, operation, errors, holderPath) {
      const scope = operation ? operation.id : 'all';
      const key = `iface-errors-${slug(scope)}`;
      const errorsPath = holderPath.concat('errors');
      const write = (name, value, label) => run({ op: 'setError', interfaceId: declared.id, operationId: operation ? operation.id : null,
        name, value }, label);
      const valueOf = (when, code) => (code ? { when, code } : when);
      const rows = listEditor({
        name: key,
        label: operation ? 'Errors' : 'Errors of every operation',
        itemName: 'error',
        items: errors,
        locked: touchesLock(errorsPath) ? (lockReason(errorsPath) || kit.lockedText) : null,
        rowLocked: (index) => lockReason(errors[index].path),
        renderRow: (error, index) => {
          const rowKey = `${key}-${index}`;
          const number = index + 1;
          return dom.el('div', { class: 'c4-editor__interface-error' }, [
            field({ key: `${rowKey}-name`, label: `Name of error ${number}`, value: error.name, path: error.path, lintPath: null,
              locked: renameLock(error.path, error.name, 'name'),
              onCommit: (name) => run({ op: 'batch', commands: [
                { op: 'setError', interfaceId: declared.id, operationId: operation ? operation.id : null, name: error.name, value: null },
                { op: 'setError', interfaceId: declared.id, operationId: operation ? operation.id : null, name: name.trim(), value: valueOf(error.when, error.code) },
              ] }, `Rename the error ${error.name}`) }),
            field({ key: `${rowKey}-code`, label: `Code of error ${number}`, value: error.code, path: error.path.concat('code'), lintPath: null,
              onCommit: (code) => write(error.name, valueOf(error.when, optionalText(code)), `Edit the code of ${error.name}`) }),
            field({ key: `${rowKey}-when`, label: `When error ${number} happens`, control: 'textarea', value: error.when,
              path: error.path.concat('when'), hint: frame('error', {}),
              onCommit: (when) => (when.trim() === '' ? problem(`${rowKey}-when`, 'Error: Say when it happens and what the client should then do.')
                : write(error.name, valueOf(when.trim(), error.code), `Edit the error ${error.name}`)) }),
          ]);
        },
        onRemove: (index) => write(errors[index].name, null, `Remove the error ${errors[index].name}`),
        emptyFocusKey: `${key}-new-name`,
      });
      const lintRules = operation ? ['interface/no-errors'] : [];
      const problems = kit.problemsFor(`${key}-problems`, holderPath, { rules: lintRules });
      return dom.el('div', { class: 'c4-editor__field c4-editor__text-list', role: 'group', 'aria-labelledby': ids(`insp-${key}-label`) }, [
        dom.el('p', { id: ids(`insp-${key}-label`), class: 'c4-editor__field-label', text: operation ? 'Errors' : 'Errors of every operation' }),
        errors.length > 0 ? rows : dom.el('p', { class: 'c4-editor__field-hint', text: 'No errors yet.' }),
        operation ? kit.problemText(ids(`insp-${key}-problem`), problems) : null,
        addRowUnlessLocked(errorsPath, '*', ['errors', 'error'],
          () => newErrorRow(key, errorsPath, (name, code, when) => write(name, valueOf(when, code), `Add the error ${name}`))),
      ]);
    }

    function newErrorRow(key, errorsPath, add) {
      const [nameKey, codeKey, whenKey] = [`${key}-new-name`, `${key}-new-code`, `${key}-new-when`];
      const submit = () => {
        const name = kit.byKey(nameKey).value.trim();
        const code = optionalText(kit.byKey(codeKey).value);
        const when = kit.byKey(whenKey).value.trim();
        if (name === '') return problem(nameKey, 'Error: Name the error first, such as invalid-plan.');
        if (when === '') return problem(whenKey, 'Error: Say when it happens and what the client should then do.');
        if (add(name, code, when)) {
          announce(`Added the error ${name}.`);
          requestFocus(nameKey);
        }
        return true;
      };
      const fields = [
        field({ key: nameKey, label: 'New error name', value: '', path: errorsPath, lintPath: null, onCommit: () => {} }),
        field({ key: codeKey, label: 'New error code', value: '', path: errorsPath, lintPath: null, hint: 'The protocol\'s code, such as 422 (optional).', onCommit: () => {} }),
        field({ key: whenKey, label: 'When the new error happens', value: '', path: errorsPath, lintPath: null, hint: frame('error', {}), onCommit: () => {} }),
      ];
      fields.forEach((node) => node.querySelector('input').addEventListener('keydown', onEnter(submit)));
      return dom.el('div', { class: 'c4-editor__list-add c4-editor__interface-error' }, [fields, button('Add error', submit)]);
    }

    // ---- Realizes ----------------------------------------------------------------------------------------------

    function realizesGroup(model, declared, operation) {
      const key = `iface-realizes-${slug(operation.id)}`;
      const path = operation.path.concat('realizes');
      const groups = realizesGroups(model, declared.providerId);
      const problems = kit.problemsFor(`${key}-problems`, operation.path,
        { rules: ['interface/unrealized', 'interface/realizes-internal', 'model/realizes-owner'] });
      return dom.el('div', { class: 'c4-editor__field c4-editor__checkbox-group', role: 'group', 'aria-labelledby': ids(`insp-${key}-label`) }, [
        dom.el('p', { id: ids(`insp-${key}-label`), class: 'c4-editor__field-label', text: 'Realizes' }),
        dom.el('p', { class: 'c4-editor__field-hint', text: `Which responsibilities does a client reach through ${operation.id}?` }),
        groups.map((group) => dom.el('div', { class: 'c4-editor__realizes-owner', role: 'group', 'aria-labelledby': ids(`insp-${key}-${slug(group.owner.id)}`) }, [
          dom.el('p', { id: ids(`insp-${key}-${slug(group.owner.id)}`), class: 'c4-editor__realizes-owner-name', text: group.owner.name }),
          group.items.map((item) => realizesBox(declared, operation, group.owner, item, `${key}-${slug(group.owner.id)}-${item.index}`, path)),
        ])),
        kit.problemText(ids(`insp-${key}-problem`), problems),
      ]);
    }

    function realizesBox(declared, operation, owner, item, key, path) {
      const { responsibility } = item;
      const isChecked = responsibility.id !== null && operation.realizes.includes(responsibility.id);
      // Checking a responsibility without an id also writes its id, so its own path must be editable.
      const idLock = responsibility.id === null ? lockReason(responsibility.path) : null;
      // Every choice rewrites the whole realizes list, so a lock on any entry freezes every box.
      const listLock = touchesLock(path) ? (lockReason(path) || kit.lockedText) : null;
      return field({ key, label: responsibilityLabel(responsibility, owner), control: 'checkbox', value: isChecked,
        path: idLock ? responsibility.path : path, lintPath: null, quietLock: true, locked: idLock || listLock,
        hint: item.isPrivate && !isNovice() ? TEXT.privateTo(owner.name) : null,
        onCommit: (on) => toggleRealizes(declared, operation, owner, item, on) });
    }

    function toggleRealizes(declared, operation, owner, item, on) {
      const { responsibility } = item;
      const label = `Edit what ${operation.id} realizes`;
      const update = (value) => ({ op: 'updateOperation', interfaceId: declared.id, operationId: operation.id, field: 'realizes', value });
      if (!on) return run(update(operation.realizes.filter((id) => id !== responsibility.id)), label);
      if (responsibility.id !== null) return run(update(operation.realizes.concat(responsibility.id)), label);
      // The core generates the id; a dry run learns it, so the id and the realizes entry are one change (Ruling 14).
      const ensure = { op: 'ensureResponsibilityId', elementId: owner.id, index: item.index };
      const dryRun = C4.edit(state.getDesign(), ensure);
      if (dryRun.error) {
        announce(`Error: ${dryRun.message}.`);
        scheduleRender();
        return false;
      }
      return run({ op: 'batch', commands: [ensure, update(operation.realizes.concat(dryRun.selection.responsibilityId))] }, label);
    }

    return { semanticView };
  }

  return { createSemanticView };
});
