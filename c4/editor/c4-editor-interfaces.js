(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../c4-core.js'), function () {
      return {
        scaffolds: require('./c4-editor-scaffolds.js'),
        interfacesShared: require('./c4-editor-interfaces-shared.js'),
        interfacesExamples: require('./c4-editor-interfaces-examples.js'),
        interfacesMeaning: require('./c4-editor-interfaces-meaning.js'),
        interfacesSemantic: require('./c4-editor-interfaces-semantic.js'),
        interfacesTypes: require('./c4-editor-interfaces-types.js'),
        interfacesSyntactic: require('./c4-editor-interfaces-syntactic.js'),
        interfacesSection: require('./c4-editor-interfaces-section.js'),
        interfacesForm: require('./c4-editor-interfaces-form.js'),
      };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.interfaces = factory(root.ArchUMLC4, function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (C4, editorParts) {
  'use strict';

  // Interfaces in the editor (spec §9.5): the Interfaces section of a system, container, or component, and the
  // interface form (Basics, then a tablist of the Syntactic view and the Semantic view). The forms are built from the
  // inspector's kit (fields, sections, disclosures, lists, locks, commands), so they label, lock, lint, and commit a
  // field the way every other form does; they write through the state's `dispatch` (core interface commands) and,
  // where the core has no command (reordering map entries), through the kit's splice writer. The DOM-free helpers
  // (which view holds a diagnostic, example flow text, Realizes groups, Uses groups) are exported for tests and other
  // parts. The Uses picker of a relationship is built here too, without the kit, so the inspector's relationship form
  // and the anchored relationship form (c4-editor-actions.js) place one control.
  //
  // This file holds what the interface forms share (their view state, locks on keys, diagnostics, opening a form,
  // Change interface id…) and creates their units, which share one context object: the Interfaces section
  // (c4-editor-interfaces-section.js), the interface form with its tabs (-form), the Syntactic view (-syntactic),
  // data types and fields (-types), the Semantic view (-semantic), examples (-examples), and the meaning of data with
  // the vocabulary (-meaning). The DOM-free helpers are in -shared.

  // ---- Forms -------------------------------------------------------------------------------------------------

  /**
   * The Interfaces section and the interface form, built from the inspector's `kit`: `state`, `dom`, `ids`,
   * `announce`, `options`, `field`, `formSection`, `disclosure`, `openDisclosure`, `button`, `listEditor`,
   * `textList`, `run`, `problem`, `problemsFor`, `problemText`, `lockReason`, `touchesLock`, `addRowUnlessLocked`, `requestFocus`,
   * `scheduleRender`, `splices`, and `dialogRoot` (the editor root, where dialogs mount). Returns `section(model, element)`, `formFor(model, selection)`,
   * `resolveFocusPath(selection, path)`, `open(interfaceId, options)`, `openChangeIdDialog(declared, options)`, and
   * `destroy()`.
   */
  function createInterfaceForms(kit) {
    const parts = editorParts();
    const { state, dom, ids, announce, field, button, problem, lockReason, touchesLock, requestFocus, scheduleRender } = kit;
    const { TEXT, focusPathFor, isAbout, interfaceIdOf, renameRewritePaths, samePath, moved, slug, onEnter } = parts.interfacesShared;
    const options = kit.options || {};
    const view = {
      tabs: new Map(), showAll: false, needsOnly: false, newStyle: '', returnFocus: null,
      handledFocusRequest: null, drafts: new Map(),
      // Inputs and outputs whose picker says Inline fields before their first field is written (see payloadEditor).
      inlinePending: new Set(),
    };
    let checked = { text: null, diagnostics: [] };
    const openDialogs = new Set();
    let selectedInterfaceId = interfaceIdOf(state.getSelection());
    const unsubscribeSelection = state.on('selection', markTouchedOnSelectionChange);

    const isNovice = () => options.profile === 'novice';

    /** The sentence frame of a field (spec §9.3), or null while the `sentenceFrames` scaffold is off. */
    function frame(kind, context) {
      const scaffolds = editorParts().scaffolds;
      return scaffolds.isScaffoldOn(options, 'sentenceFrames') ? scaffolds.frameFor(kind, context) : null;
    }

    /**
     * "Definitions:" and a button per defined term (spec §9.3 definitions popovers), or null while the `definitions`
     * scaffold is off. The popovers are disposed when the inspector next renders.
     */
    function definitionTerms(key, terms) {
      const made = terms.map((term) => editorParts().scaffolds.createDefinitionTerm(term, { dom, ids, options, key: `${key}-${term}` }))
        .filter(Boolean);
      if (made.length === 0) return null;
      made.forEach((term) => kit.disposeOnRender(term));
      return dom.el('div', { class: 'c4-editor__terms' }, [
        dom.el('span', { class: 'c4-editor__terms-label', text: TEXT.definitions }),
        made.map((term) => term.element),
      ]);
    }

    /**
     * The novice profile reports an interface's incompleteness only once focus has left its form (spec §7.2), so a
     * learner is not told what is missing before starting. Two ways out count: focus leaving the form (below), and the
     * selection moving off the interface (markTouchedOnSelectionChange), which replaces the form and so takes focus out
     * of it even where the browser fires no focusout for the removed node (Firefox, after Back to <provider>).
     * Focus that moves within the form, to a dialog opened from it, or onto the form the inspector re-renders in its
     * place, has not left it; the check runs after the event, when that re-render has restored focus.
     */
    function markTouchedOnLeave(interfaceId) {
      return (event) => {
        const form = event.currentTarget;
        if (event.relatedTarget && form.contains(event.relatedTarget)) return;
        const doc = form.ownerDocument;
        doc.defaultView.setTimeout(() => {
          const active = doc.activeElement;
          const formNow = active ? active.closest('[data-c4-interface-form]') : null;
          const inDialog = Boolean(active && active.closest('dialog[open]'));
          if (!inDialog && !(formNow && formNow.getAttribute('data-c4-interface-form') === interfaceId)) state.markTouched(interfaceId);
        }, 0);
      };
    }

    /** Marks the interface touched that the selection has just moved off (see markTouchedOnLeave). */
    function markTouchedOnSelectionChange(selection) {
      const left = selectedInterfaceId;
      selectedInterfaceId = interfaceIdOf(selection);
      if (left !== null && left !== selectedInterfaceId) state.markTouched(left);
    }

    /** Every diagnostic the core reports now, whatever the display mode: what Unit and the filter apply to. */
    function coreDiagnostics() {
      const text = state.getText();
      if (checked.text !== text) checked = { text, diagnostics: C4.check(state.getDesign()) };
      return checked.diagnostics;
    }

    function coreFinds(rules, path) {
      return coreDiagnostics().some((diagnostic) => rules.includes(diagnostic.rule) && samePath(diagnostic.path || [], path));
    }

    function shown(declared) {
      return state.getDiagnostics().filter((diagnostic) => isAbout(declared, diagnostic));
    }

    // ---- Locks on keys (spec §11) --------------------------------------------------------------------------------

    /**
     * Why the YAML key at `path` (an interface id, an operation id, a type, field, or error name) cannot be renamed,
     * or null. A rename moves the key, so a lock on the entry or on anything under it would stop matching. With
     * `target` (`{ declared, operationId?, typeName? }`, see renameRewritePaths), a lock on a value elsewhere that the
     * rename rewrites, such as an operation's `output` or a relationship's `uses`, also refuses it.
     */
    function renameLock(path, name, what, target = null) {
      const own = lockReason(path) || (touchesLock(path) ? TEXT.keyLocked(name, what) : null);
      if (own || !target || (options.lockedFields || []).length === 0) return own;
      const rewritten = renameRewritePaths(state.getDesign(), target, (at) => kit.splices.dataAt(at));
      return rewritten.some((at) => touchesLock(at)) ? TEXT.referenceLocked(name, what) : null;
    }

    // ---- Shared bits ---------------------------------------------------------------------------------------------

    function moveMapEntry(mapPath, keys, from, to, label) {
      const order = moved(keys, from, to);
      return kit.splices.write(label, [(parsed, yaml) => yaml.moveEntry(parsed, mapPath, keys[from], mapPath, { order })]);
    }

    /** A text field and its Add button; `submit(text)` returns null when done, else the error text to show. */
    function addRow(key, label, buttonLabel, path, submit, hint) {
      const add = () => {
        const text = kit.byKey(key).value.trim();
        if (text === '') return problem(key, `Error: Fill in ${label.toLowerCase()} first.`);
        const failure = submit(text);
        if (failure) return problem(key, failure);
        requestFocus(key);
        return true;
      };
      const input = field({ key, label, value: '', path, lintPath: null, hint, onCommit: () => {} });
      input.querySelector('input').addEventListener('keydown', onEnter(add));
      return dom.el('div', { class: 'c4-editor__list-add' }, [input, button(buttonLabel, add)]);
    }

    /** A checkbox that changes only what the form shows, never the model: it stays usable when the model is read-only. */
    function viewToggle(key, label, isOn, onChange) {
      const id = ids(`insp-${slug(key)}`);
      return dom.el('div', { class: 'c4-editor__checkbox-row' }, [
        dom.el('input', { type: 'checkbox', id, class: 'c4-editor__checkbox', checked: isOn ? true : null, 'data-c4-focus-key': key,
          on: { change: (event) => onChange(event.currentTarget.checked) } }),
        dom.el('label', { for: id, class: 'c4-editor__field-label', text: label }),
      ]);
    }

    // ---- Opening and focus ----------------------------------------------------------------------------------------

    /**
     * Opens the interface form (spec §9.5; the interface card's "Edit <operation>" uses it): `operationId` opens that
     * operation in the Syntactic view, `focus: 'syntax'` puts focus on its syntax field, and Back returns focus to
     * `returnFocus`.
     */
    function open(interfaceId, { operationId = null, focus = null, returnFocus = null } = {}) {
      view.returnFocus = returnFocus;
      let focusKey = 'title';
      if (operationId) {
        view.tabs.set(interfaceId, 'syntactic');
        kit.openDisclosure(`iface-op-${slug(operationId)}`);
        if (focus === 'syntax') focusKey = `iface-op-${slug(operationId)}-syntax`;
      }
      state.select(operationId ? { interfaceId, operationId } : { interfaceId });
      scheduleRender();
      requestFocus(focusKey);
    }

    function openForm(interfaceId, { focusKey = 'title' } = {}) {
      view.returnFocus = null;
      state.select({ interfaceId });
      scheduleRender();
      requestFocus(focusKey);
    }

    /**
     * The "Change interface id…" dialog (spec §9.2): a labelled modal that validates on submit and keeps the dialog
     * open with the problem named; Cancel or Escape changes nothing and returns focus to `returnFocus`. After a
     * change, focus goes to the control `focusAfter(newId)` names. Resolves the command's result.
     */
    function openChangeIdDialog(declared, { returnFocus = null, focusAfter = () => 'iface-change-id' } = {}) {
      const input = dom.el('input', { type: 'text', id: ids('iface-change-id-input'), class: 'c4-editor__input', value: declared.id,
        autocomplete: 'off', spellcheck: 'false', 'aria-describedby': `${ids('iface-change-id-hint')} ${ids('iface-change-id-problem')}` });
      const problemText = dom.el('p', { id: ids('iface-change-id-problem'), class: 'c4-editor__field-problem c4-editor__field-problem--error',
        hidden: true });
      const body = dom.el('div', { class: 'c4-editor__fields' }, dom.el('div', { class: 'c4-editor__field' }, [
        dom.el('label', { for: input.id, class: 'c4-editor__field-label', text: 'New interface id' }),
        dom.el('p', { id: ids('iface-change-id-hint'), class: 'c4-editor__field-hint',
          text: `Letters, digits, - or _, starting with a letter. Every use of ${declared.name} is renamed too.` }),
        input,
        problemText,
      ]));
      const closed = dom.openDialog(kit.dialogRoot, {
        ids, body, title: `Change the id of ${declared.name}`, initialFocus: input, returnFocus,
        actions: [{ label: 'Cancel', value: null }, { label: 'Change id', value: 'change', isDefault: true }],
      });
      const dialog = body.closest('dialog');
      openDialogs.add(dialog);
      input.select();
      let result = null;
      input.form.addEventListener('submit', (event) => {
        const newId = input.value.trim();
        const before = state.getSelection();
        result = state.dispatch({ op: 'changeInterfaceId', interfaceId: declared.id, newId }, { label: `Change the id of ${declared.name}` });
        problemText.textContent = result.ok ? '' : state.refusalText(result);
        problemText.hidden = result.ok;
        if (result.ok) input.removeAttribute('aria-invalid');
        else {
          input.setAttribute('aria-invalid', 'true');
          event.preventDefault();
          return;
        }
        announce(`The id of ${declared.name} is now ${newId}.`);
        // The core selects the renamed interface; a change made from the element's Interfaces row stays on the element.
        if (!before || before.interfaceId !== declared.id) state.select(before);
        requestFocus(focusAfter(newId));
      });
      return closed.then((value) => {
        openDialogs.delete(dialog);
        if (value !== null) return result;
        announce(`Kept the id ${declared.id}.`);
        return { ok: false, cancelled: true };
      });
    }

    /** Closes any dialog this module opened and stops listening to the state (the inspector is being destroyed). */
    function destroy() {
      unsubscribeSelection();
      openDialogs.forEach((dialog) => dialog.close(''));
    }

    /** The YAML path a focus request for `path` should land on (see focusPathFor). */
    function resolveFocusPath(selection, path) {
      const model = state.getDesign().model;
      const declared = selection && selection.interfaceId && model ? model.interfaces.get(selection.interfaceId) : null;
      return declared ? focusPathFor(declared, state.getDiagnostics(), path) : path;
    }

    // ---- The units ------------------------------------------------------------------------------------------------

    // What every unit reads: the inspector's kit and the shared bits above. Each unit's builders join it as the unit
    // is created, so a unit can use the units made before it (the Semantic view places examples and the meaning of
    // data; the Syntactic view places the types' fields; the form places both views and the shorthand lines).
    const forms = Object.assign({}, kit, {
      options, view, isNovice, frame, definitionTerms, markTouchedOnLeave, coreFinds, shown, renameLock, moveMapEntry, addRow,
      viewToggle, openForm, openChangeIdDialog,
    });
    [parts.interfacesExamples.createExamplesEditor, parts.interfacesMeaning.createMeaningSections,
      parts.interfacesSemantic.createSemanticView, parts.interfacesTypes.createTypesEditor,
      parts.interfacesSyntactic.createSyntacticView, parts.interfacesSection.createInterfacesSection,
      parts.interfacesForm.createInterfaceForm].forEach((create) => Object.assign(forms, create(forms)));

    return { section: forms.section, formFor: forms.formFor, resolveFocusPath, open, openChangeIdDialog, destroy };
  }

  // ---- Uses picker (spec §9.5) -------------------------------------------------------------------------------

  /**
   * The Uses picker: one `<fieldset>` per group of usable interfaces (usesGroups), one checkbox per entry. It needs no
   * inspector kit, so the inspector's relationship form and the anchored relationship form's "More" place the same
   * control. `spec`: `dom`, `ids`, `design`, `name` (unique in the editor; prefixes ids and focus keys), `sourceId`,
   * `targetId`, `responsibility` (the collaborator's requested responsibility, or null), `uses` (the current entries,
   * `{ interfaceId, operationId }`, such as a relationship's `uses`), `path` (the YAML path of `uses`, for focus
   * requests; optional), `locked` (a reason the boxes are read-only, or null), `announce`, `onChange(texts)` (the
   * new `uses` texts; return false when they were not written, and the boxes go back), and `onAddInterface(targetId)`
   * (the empty state's button; without it, no button). The picker writes nothing itself. Returns
   * `{ element, getUses(), commandFor(relationshipId) }`: `getUses()` gives the checked entries' texts, and
   * `commandFor` the `setUses` command for a form that writes on submit (null when the choice is unchanged).
   */
  function createUsesPicker(spec) {
    const { usesGroups, sameUse, toggleUse, useText, slug } = editorParts().interfacesShared;
    const { dom, ids, design, name, sourceId, targetId, locked = null, path = null } = spec;
    const announce = spec.announce || (() => {});
    const { model } = design;
    const [source, target] = [model.elements.get(sourceId), model.elements.get(targetId)];
    const initial = (spec.uses || []).map((use) => ({ interfaceId: use.interfaceId, operationId: use.operationId || null }));
    let current = initial;
    const boxes = [];
    const groups = usesGroups(design, { sourceId, targetId, responsibility: spec.responsibility || null });
    const lockNote = locked ? dom.el('p', { id: ids(`${name}-lock`), class: 'c4-editor__lock-note', text: locked }) : null;

    function sync() {
      boxes.forEach(({ box, entry }) => { box.checked = current.some((use) => sameUse(use, entry)); });
    }

    function toggle(entry, checked) {
      const next = toggleUse(current, entry, checked);
      const written = spec.onChange ? spec.onChange(next.map(useText)) !== false : true;
      if (written) {
        current = next;
        announce(`${source.name} ${checked ? 'now uses' : 'no longer uses'} ${entry.label}.`);
      }
      sync();
    }

    function entryRow(entry) {
      const text = useText(entry);
      const box = dom.el('input', { type: 'checkbox', id: ids(`${name}-${slug(text)}`), class: 'c4-editor__checkbox',
        disabled: locked ? true : null, 'aria-describedby': lockNote ? lockNote.id : null,
        'data-c4-focus-key': `${name}-${slug(text)}`, 'data-c4-path': path ? JSON.stringify(path) : null });
      if (!locked) box.addEventListener('change', () => toggle(entry, box.checked));
      boxes.push({ box, entry });
      return dom.el('li', { class: 'c4-editor__checkbox-row' },
        [box, dom.el('label', { for: box.id, class: 'c4-editor__field-label', text: entry.label })]);
    }

    function groupFieldset(group) {
      return dom.el('fieldset', { class: 'c4-editor__uses-group' }, [
        dom.el('legend', { class: 'c4-editor__uses-legend', text: group.title }),
        group.interfaces.map((usable) => dom.el('fieldset', { class: 'c4-editor__uses-interface' }, [
          dom.el('legend', { class: 'c4-editor__uses-interface-name', text: usable.name }),
          dom.el('ul', { class: 'c4-editor__uses-entries' }, usable.entries.map(entryRow)),
        ])),
      ]);
    }

    function emptyState() {
      const canAdd = spec.onAddInterface && !locked;
      return [
        dom.el('p', { class: 'c4-editor__field-hint', text: `Neither ${target.name} nor the elements around it offer a described interface yet.` }),
        canAdd ? dom.el('button', { type: 'button', class: 'c4-editor__button', 'data-c4-focus-key': `${name}-add-interface`,
          on: { click: () => spec.onAddInterface(targetId) } }, `Add an interface to ${target.name}`) : null,
      ];
    }

    const element = dom.el('div', { class: 'c4-editor__uses' }, groups.length === 0 ? [lockNote, emptyState()] : [
      dom.el('p', { class: 'c4-editor__field-hint',
        text: `Choose the operations ${source.name} uses, or the whole interface when you are not sure which.` }),
      lockNote,
      groups.map(groupFieldset),
    ]);
    sync();
    const getUses = () => current.map(useText);
    const isUnchanged = () => getUses().join('\n') === initial.map(useText).join('\n');
    return {
      element,
      getUses,
      commandFor: (relationshipId) => (isUnchanged() ? null : { op: 'setUses', relationshipId, uses: getUses() }),
    };
  }

  // ---- The card's description as Markdown (spec §9.1 "Copy description", Ruling 26) -----------------------------

  /**
   * The description of an interface card (`ArchUMLC4.describe(cardView)`, `{ brief, sections }`) as Markdown, so the
   * copy says what the card and the Explain panel say: `# <title>` when `options.title` is given, the brief as a
   * paragraph, then `## <heading>` and one `- <item>` per item for each section. Line breaks inside a text become
   * spaces, so every item stays one list entry.
   */
  function cardMarkdown(description, { title = null } = {}) {
    const line = (text) => String(text).replace(/\s*\n\s*/g, ' ').trim();
    const blocks = (title ? [`# ${line(title)}`] : []).concat(line(description.brief));
    description.sections.forEach((section) => {
      blocks.push(`## ${line(section.heading)}`, section.items.map((item) => `- ${line(item)}`).join('\n'));
    });
    return `${blocks.join('\n\n')}\n`;
  }

  /**
   * A DOM-free helper of c4-editor-interfaces-shared.js under this part's name, read at call time as every part reads
   * its siblings (Ruling 13), so tests and other parts keep calling `interfaces.<name>`.
   */
  function sharedHelper(name) {
    return function () {
      return editorParts().interfacesShared[name].apply(null, arguments);
    };
  }

  return {
    styleChoices: sharedHelper('styleChoices'),
    createInterfaceForms: createInterfaceForms,
    renameRewritePaths: sharedHelper('renameRewritePaths'),
    viewOfPath: sharedHelper('viewOfPath'),
    diagnosticsByView: sharedHelper('diagnosticsByView'),
    focusPathFor: sharedHelper('focusPathFor'),
    payloadFields: sharedHelper('payloadFields'),
    exampleText: sharedHelper('exampleText'),
    realizesGroups: sharedHelper('realizesGroups'),
    usesGroups: sharedHelper('usesGroups'),
    toggleUse: sharedHelper('toggleUse'),
    useText: sharedHelper('useText'),
    derivedUses: sharedHelper('derivedUses'),
    createUsesPicker: createUsesPicker,
    cardMarkdown: cardMarkdown,
  };
});
