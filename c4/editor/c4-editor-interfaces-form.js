(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../c4-core.js'), function () {
      return { interfacesShared: require('./c4-editor-interfaces-shared.js') };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.interfacesForm = factory(root.ArchUMLC4, function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (C4, editorParts) {
  'use strict';

  // The interface form (spec §9.5), a unit of the interface forms (c4-editor-interfaces.js): the breadcrumb, Back,
  // Basics with Change interface id…, and the tablist of the Syntactic and Semantic views (the WAI-ARIA tabs pattern
  // with automatic activation), or the syntax lines of a shorthand list. A Problems › Show request selects the tab,
  // and reveals Unit or Format, that holds the field it names.

  /**
   * The interface form. `kit` is the interface forms' context (c4-editor-interfaces.js) with the units that build the
   * views, and `renameInterface` (the shared command the Name field renames through, which the inspector hands over).
   * Returns `formFor(model, selection)`.
   */
  function createInterfaceForm(kit) {
    const { state, dom, ids, field, formSection, button, run, problem, requestFocus, scheduleRender, view, definitionTerms,
      markTouchedOnLeave, renameLock, openChangeIdDialog, shorthandBody, syntacticView, semanticView, allFields, unitApplies,
      formatApplies, renameInterface } = kit;
    const { styleChoices, VIEWS, TEXT, viewOfPath, problemCount, diagnosticsByView, focusPathFor, samePath, optionalText,
      slug } = editorParts().interfacesShared;

    /** A new Problems › Show request selects the tab, and reveals Unit or Format, that holds the field it names. */
    function answerFocusRequest(declared, selection) {
      const request = selection.focus;
      if (!request || request.request === view.handledFocusRequest) return;
      view.handledFocusRequest = request.request;
      const target = focusPathFor(declared, state.getDiagnostics(), request.path);
      const tab = viewOfPath(declared, target);
      if (tab) view.tabs.set(declared.id, tab);
      const key = target[target.length - 1];
      if (key === 'unit' || key === 'format') view.showAll = view.showAll || !appliesAt(declared, target.slice(0, -1), key);
    }

    function appliesAt(declared, fieldPath, key) {
      const found = allFields(declared).find((entry) => samePath(entry.field.path, fieldPath));
      return Boolean(found) && (key === 'unit' ? unitApplies(found.field) : formatApplies(found.field));
    }

    function formFor(model, selection) {
      const declared = model.interfaces.get(selection.interfaceId);
      if (!declared) return null;
      answerFocusRequest(declared, selection);
      const provider = model.elements.get(declared.providerId);
      return dom.el('div', { class: 'c4-editor__inspector-form c4-editor__interface-form', 'data-c4-interface-form': declared.id,
        on: { focusout: markTouchedOnLeave(declared.id) } }, [
        dom.el('p', { class: 'c4-editor__breadcrumb', text: `${provider.name} › ${declared.name}` }),
        dom.el('h3', { class: 'c4-editor__inspector-title', tabindex: '-1', 'data-c4-focus-key': 'title', text: declared.name }),
        dom.el('div', { class: 'c4-editor__inspector-actions' }, [
          button(`Back to ${provider.name}`, () => back(declared), { 'data-c4-focus-key': 'iface-back' }),
          button('Show description card', () => state.openView(`interface ${declared.id}`), { 'data-c4-focus-key': 'iface-card' }),
        ]),
        kit.problemText(ids('insp-interface-problem'), kit.problemsFor('interface', declared.path, { exact: true })),
        definitionTerms('iface-form', declared.shorthand ? ['interface-description'] : ['interface-description', 'syntactic-view', 'semantic-view']),
        declared.shorthand ? shorthandForm(model, provider, declared) : [basicsSection(declared), tabs(model, declared)],
      ]);
    }

    function back(declared) {
      const opener = view.returnFocus;
      view.returnFocus = null;
      state.select({ elementId: declared.providerId });
      scheduleRender();
      requestFocus(opener && opener.isConnected ? opener : `iface-row-${slug(declared.id)}`);
    }

    function shorthandForm(model, provider, declared) {
      return formSection('iface-shorthand', 'Syntax lines', [
        dom.el('p', { class: 'c4-editor__field-hint', text: TEXT.shorthand }),
        shorthandBody(provider, declared),
      ]);
    }

    function basicsSection(declared) {
      const path = (key) => declared.path.concat(key);
      const update = (key, label) => (value) => run({ op: 'updateInterface', interfaceId: declared.id, field: key, value }, label);
      return formSection('iface-basics', 'Basics', dom.el('div', { class: 'c4-editor__fields' }, [
        field({ key: 'iface-name', label: 'Name', value: declared.name, path: path('name'), onCommit: (value) => {
          if (value.trim() === '') {
            problem('iface-name', 'Error: An interface needs a name; to remove it, choose Remove in its row\'s menu.');
            return;
          }
          // The shared rename, as the canvas's: an interface still named as it was added takes the id of its first name.
          const result = renameInterface(declared.id, value);
          if (!result.ok) problem('iface-name', result.message);
        } }),
        idField(declared),
        field({ key: 'iface-style', label: 'Style', control: 'select', value: declared.style || '', choices: styleChoices(), path: path('style'),
          onCommit: (value) => update('style', `Change the style of ${declared.name}`)(value || null) }),
        field({ key: 'iface-technology', label: 'Technology', value: declared.technology, path: path('technology'),
          hint: 'The protocol and document format, such as JSON/HTTPS.',
          onCommit: (value) => update('technology', `Edit the technology of ${declared.name}`)(optionalText(value)) }),
        field({ key: 'iface-version', label: 'Version', value: declared.version, path: path('version'),
          onCommit: (value) => update('version', `Edit the version of ${declared.name}`)(optionalText(value)) }),
        field({ key: 'iface-description', label: 'Description', control: 'textarea', value: declared.description, path: path('description'),
          onCommit: (value) => update('description', `Edit the description of ${declared.name}`)(optionalText(value)) }),
      ]));
    }

    function idField(declared) {
      const reason = renameLock(declared.path, declared.name, 'id', { declared });
      return dom.el('div', { class: 'c4-editor__field' }, [
        dom.el('p', { class: 'c4-editor__field-label', text: 'Id' }),
        dom.el('p', { class: 'c4-editor__id', text: declared.id }),
        reason ? dom.el('p', { class: 'c4-editor__lock-note', text: reason })
          : button('Change interface id…', (event) => openChangeIdDialog(declared, { returnFocus: event.currentTarget }),
            { 'data-c4-focus-key': 'iface-change-id' }),
      ]);
    }

    // ---- Tabs (spec §9.5; WAI-ARIA tabs pattern with automatic activation) ------------------------------------

    function tabs(model, declared) {
      const active = view.tabs.get(declared.id) || 'syntactic';
      const byView = diagnosticsByView(declared, state.getDiagnostics());
      const tabId = (name) => ids(`iface-tab-${name}`);
      const panelId = (name) => ids(`iface-panel-${name}`);
      const select = (name) => {
        view.tabs.set(declared.id, name);
        scheduleRender();
        requestFocus(`iface-tab-${name}`);
      };
      const onKeydown = (event) => {
        const index = VIEWS.findIndex((entry) => entry.name === active);
        const next = { ArrowRight: (index + 1) % VIEWS.length, ArrowLeft: (index + VIEWS.length - 1) % VIEWS.length,
          Home: 0, End: VIEWS.length - 1 }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        select(VIEWS[next].name);
      };
      const tablist = dom.el('div', { role: 'tablist', class: 'c4-editor__interface-tabs', 'aria-label': `Views of ${declared.name}`,
        on: { keydown: onKeydown } }, VIEWS.map((entry) => {
        const count = problemCount(byView[entry.name]);
        return dom.el('button', {
          type: 'button', role: 'tab', id: tabId(entry.name), class: 'c4-editor__interface-tab', 'aria-controls': panelId(entry.name),
          'aria-selected': entry.name === active ? 'true' : 'false', tabindex: entry.name === active ? '0' : '-1',
          'data-c4-focus-key': `iface-tab-${entry.name}`, on: { click: () => select(entry.name) },
        }, count ? `${entry.label}, ${count}` : entry.label);
      }));
      const panels = VIEWS.map((entry) => dom.el('div', {
        role: 'tabpanel', id: panelId(entry.name), class: 'c4-editor__interface-panel', 'aria-labelledby': tabId(entry.name),
        hidden: entry.name === active ? null : true,
      }, entry.name !== active ? null : entry.name === 'syntactic' ? syntacticView(model, declared) : semanticView(model, declared)));
      return [tablist, panels];
    }

    return { formFor };
  }

  return { createInterfaceForm };
});
