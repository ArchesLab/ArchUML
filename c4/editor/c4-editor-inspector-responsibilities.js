(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(function () {
      return {
        inspectorShared: require('./c4-editor-inspector-shared.js'),
      };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.inspectorResponsibilities = factory(function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (editorParts) {
  'use strict';

  // The element form's Responsibilities (spec §9.1, §9.3), built from the inspector's kit (c4-editor-inspector-kit.js):
  // each responsibility's kind (KNOW, DO, DECIDE) and text, reordered and removed with the list editor, the new
  // responsibility row, and the sentence frame of each kind while the `sentenceFrames` scaffold is on.

  const RESPONSIBILITY_KINDS = [{ value: 'know', label: 'KNOW' }, { value: 'do', label: 'DO' }, { value: 'decide', label: 'DECIDE' }];
  // Sentence frames (spec §9.3): visible hint text beside the field, never its value.
  const RESPONSIBILITY_FRAMES = {
    know: (name) => `${name} can tell its clients … (for example, which seats are held for each attempt).`,
    do: (name) => `${name} makes sure that … (an action and the guarantee it keeps).`,
    decide: (name) => `${name} decides whether … (a judgment that applies a rule).`,
  };

  /**
   * The Responsibilities section. `inspector` is the inspector's shared context: the kit, `dom`, and `announce`.
   * Returns `responsibilitiesSection(current)`.
   */
  function createResponsibilitiesSection(inspector) {
    const { dom, announce, field, formSection, button, listEditor, run, problem, lockReason, touchesLock, isScaffoldOn,
      requestFocus, scheduleRender, byKey } = inspector;
    const { TEXT, onEnter } = editorParts().inspectorShared;
    // What the section keeps between renders: the kind chosen for the new responsibility.
    const view = { newResponsibilityKind: null };

    function responsibilitiesSection(current) {
      const listPath = current.path.concat('responsibilities');
      const reason = lockReason(listPath);
      const frames = isScaffoldOn('sentenceFrames');
      const update = (index, changes, label) => run(Object.assign({ op: 'updateResponsibility', elementId: current.id, index }, changes), label);
      const rows = listEditor({
        name: 'responsibilities',
        label: 'Responsibilities',
        itemName: 'responsibility',
        items: current.responsibilities,
        locked: touchesLock(listPath) ? (reason || TEXT.locked) : null,
        rowLocked: (index) => lockReason(listPath.concat(index)),
        renderRow: (responsibility, index) => responsibilityRow(current, responsibility, index, frames, update),
        onMove: (from, to) => run({ op: 'moveResponsibility', elementId: current.id, from, to }, `Move a responsibility of ${current.name}`),
        onRemove: (index) => run({ op: 'removeResponsibility', elementId: current.id, index }, `Remove a responsibility of ${current.name}`),
        emptyFocusKey: 'responsibility-new',
      });
      return formSection('responsibilities', 'Responsibilities', [
        reason ? dom.el('p', { class: 'c4-editor__lock-note', text: reason }) : null,
        current.responsibilities.length > 0 ? rows
          : dom.el('p', { class: 'c4-editor__field-hint', text: `What must ${current.name} know, do, or decide?` }),
        reason ? null : newResponsibility(current, frames),
      ]);
    }

    function responsibilityRow(current, responsibility, index, frames, update) {
      const number = index + 1;
      const kind = responsibility.kind || '';
      const choices = (kind === '' ? [{ value: '', label: 'Choose…' }] : []).concat(RESPONSIBILITY_KINDS);
      return dom.el('div', { class: 'c4-editor__responsibility' }, [
        field({ key: `responsibility-${index}-kind`, label: `Kind of responsibility ${number}`, labelHidden: true, control: 'select',
          value: kind, choices, path: responsibility.path, lintPath: null, quietLock: true,
          onCommit: (value) => update(index, { kind: value }, `Change the kind of a responsibility of ${current.name}`) }),
        field({ key: `responsibility-${index}-text`, label: `Responsibility ${number}`, labelHidden: true, value: responsibility.text,
          path: responsibility.path, quietLock: true, hint: frames ? frameFor(kind, current.name) : null,
          onCommit: (value) => (value.trim() === ''
            ? problem(`responsibility-${index}-text`, `Error: A responsibility needs some text; to remove it, choose Remove in its menu.`)
            : update(index, { text: value.trim() }, `Edit a responsibility of ${current.name}`)) }),
      ]);
    }

    function frameFor(kind, name) {
      return RESPONSIBILITY_FRAMES[kind] ? RESPONSIBILITY_FRAMES[kind](name) : 'Choose KNOW, DO, or DECIDE first.';
    }

    function newResponsibility(current, frames) {
      const kindKey = 'responsibility-new-kind';
      const textKey = 'responsibility-new';
      const kindValue = view.newResponsibilityKind || 'do';
      const add = () => {
        const kind = byKey(kindKey).value;
        const text = byKey(textKey).value.trim();
        if (text === '') return problem(textKey, `Error: Write what ${current.name} must ${kind === 'know' ? 'know' : kind} first.`);
        if (run({ op: 'addResponsibility', elementId: current.id, kind, text }, `Add a responsibility to ${current.name}`)) {
          announce(`Added responsibility ${current.responsibilities.length + 1}: ${kind.toUpperCase()} ${text}.`);
          requestFocus(textKey);
        }
        return true;
      };
      const kindField = field({ key: kindKey, label: 'Kind of the new responsibility', control: 'select', value: kindValue,
        choices: RESPONSIBILITY_KINDS, path: current.path.concat('responsibilities'), lintPath: null,
        onCommit: (value) => { view.newResponsibilityKind = value; scheduleRender(); } });
      const textField = field({ key: textKey, label: 'New responsibility', value: '', path: current.path.concat('responsibilities'),
        lintPath: null, hint: frames ? frameFor(kindValue, current.name) : null, onCommit: () => {} });
      textField.querySelector('input').addEventListener('keydown', onEnter(add));
      return dom.el('div', { class: 'c4-editor__list-add c4-editor__responsibility' }, [kindField, textField,
        button('Add responsibility', add)]);
    }

    return { responsibilitiesSection };
  }

  return { createResponsibilitiesSection };
});
