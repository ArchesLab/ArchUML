(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(function () {
      return {
        inspectorShared: require('./c4-editor-inspector-shared.js'),
      };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.inspectorIdentity = factory(function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (editorParts) {
  'use strict';

  // The element form's Basics and More (spec §9.1), built from the inspector's kit (c4-editor-inspector-kit.js): what
  // the element is (name, kind, technology, description, external, type, path), Delete, and the rest of its YAML that
  // has no section of its own (owned facts, invariants, quality, provides of a code element, stereotypes, group,
  // source, tags, and the id with Change id…).

  const KINDS = {
    container: ['application', 'browser_app', 'mobile_app', 'desktop_app', 'function', 'database', 'file_store', 'queue', 'topic'],
    code: ['class', 'interface', 'abstract_class', 'enum', 'function', 'module'],
  };
  const STEREOTYPES = ['information_holder', 'structurer', 'service_provider', 'coordinator', 'controller', 'interfacer'];
  const TEXT_LISTS = [
    { field: 'owns', label: 'Owns', itemName: 'owned fact' },
    { field: 'invariants', label: 'Invariants', itemName: 'invariant' },
    { field: 'quality', label: 'Quality', itemName: 'quality statement' },
    { field: 'tags', label: 'Tags', itemName: 'tag' },
  ];

  /**
   * The Basics and More of the element form. `inspector` is the inspector's shared context: the kit, `state`, `dom`,
   * `ids`, and `actions`. Returns `basicsSection(current, allows)`, `typeLine(model, current)`, and
   * `moreBody(model, current, allows)`.
   */
  function createIdentitySections(inspector) {
    const { state, dom, ids, actions, field, formSection, button, textList, run, problem, readOnlyReason, touchesLock,
      requestFocus } = inspector;
    const { TYPE_LABELS, TEXT, words } = editorParts().inspectorShared;

    function basicsSection(current, allows) {
      const path = (key) => current.path.concat(key);
      const set = (key, label) => (value) => run({ op: 'setElementField', elementId: current.id, field: key, value }, label);
      const textValue = (value) => (value.trim() === '' ? null : value.trim());
      return formSection('basics', 'Basics', dom.el('div', { class: 'c4-editor__fields' }, [
        field({ key: 'name', label: 'Name', value: current.name, path: path('name'),
          onCommit: (value) => {
            const result = actions.renameElement(current.id, value);
            if (!result.ok) problem('name', result.message);
          } }),
        allows('kind') ? field({ key: 'kind', label: 'Kind', control: 'select', value: current.kind, path: path('kind'),
          choices: KINDS[current.type].map((kind) => ({ value: kind, label: words(kind) })), onCommit: set('kind', `Change the kind of ${current.name}`) }) : null,
        allows('technology') ? field({ key: 'technology', label: 'Technology', value: current.technology, path: path('technology'),
          hint: 'Name it when it is known, or write TBD.', onCommit: (value) => set('technology', `Edit the technology of ${current.name}`)(textValue(value)) }) : null,
        field({ key: 'description', label: 'Description', control: 'textarea', value: current.description, path: path('description'),
          onCommit: (value) => set('description', `Edit the description of ${current.name}`)(textValue(value)) }),
        allows('external') ? field({ key: 'external', label: 'External (built and run by another team)', control: 'checkbox',
          value: current.external, path: path('external'), onCommit: (checked) => set('external', `Change ${current.name}`)(checked ? true : null) }) : null,
        allows('in_enterprise') ? field({ key: 'in_enterprise', label: 'In the enterprise', control: 'checkbox',
          value: current.inEnterprise, path: path('in_enterprise'), onCommit: (checked) => set('in_enterprise', `Change ${current.name}`)(checked) }) : null,
        dom.el('dl', { class: 'c4-editor__facts' }, [
          dom.el('dt', { text: 'Type' }), dom.el('dd', { text: TYPE_LABELS[current.type] }),
          dom.el('dt', { text: 'Path' }), dom.el('dd', { text: current.path.join(' › ') }),
        ]),
        deleteControl(current),
      ]));
    }

    /** "Delete <name>", or why it cannot be deleted: the read-only notice says so already; a lock on it or a part says why. */
    function deleteControl(current) {
      if (state.isReadOnly()) return null;
      if (touchesLock(current.path)) return dom.el('p', { class: 'c4-editor__lock-note', text: TEXT.deleteLocked(current.name) });
      return button(`Delete ${current.name}`, (event) => {
        actions.deleteElement(current.id, { returnFocus: event.currentTarget })
          .then((result) => { if (result.ok) requestFocus('empty'); });
      }, { 'data-c4-focus-key': 'delete' });
    }

    function typeLine(model, current) {
      const kind = current.type === 'container' && current.kind !== 'application' ? ` (${words(current.kind)})` : '';
      const external = current.external ? ', external' : '';
      const parent = current.parentId ? ` in ${model.elements.get(current.parentId).name}` : '';
      return `${TYPE_LABELS[current.type]}${kind}${external}${parent}`;
    }

    // ---- More ----------------------------------------------------------------------------------

    /**
     * Why the element's id cannot be changed here, or null. Renaming rewrites the element's YAML key, so a lock on
     * the element or on any part of it (its name, a responsibility) would stop matching and the task would lose it.
     */
    function changeIdLock(current) {
      if (state.isReadOnly()) return readOnlyReason();
      return touchesLock(current.path) ? TEXT.changeIdLocked(current.name) : null;
    }

    function moreBody(model, current, allows) {
      const setList = (fieldName) => (items) => run({ op: 'setList', elementId: current.id, field: fieldName, items },
        `Edit ${fieldName} of ${current.name}`);
      const designLists = allows('owns') ? TEXT_LISTS.filter((list) => list.field !== 'tags') : [];
      return [
        designLists.map((list) => textList({ key: list.field, label: list.label, itemName: list.itemName, items: current[list.field],
          path: current.path.concat(list.field), write: setList(list.field) })),
        current.type === 'code' ? providesField(model, current, setList('provides')) : null,
        allows('stereotypes') ? stereotypesField(current) : null,
        allows('group') ? groupField(model, current) : null,
        field({ key: 'source', label: 'Source', value: current.source, path: current.path.concat('source'),
          hint: 'Where the code of this element lives, such as a folder or a repository.',
          onCommit: (value) => run({ op: 'setElementField', elementId: current.id, field: 'source', value: value.trim() === '' ? null : value.trim() },
            `Edit the source of ${current.name}`) }),
        textList({ key: 'tags', label: 'Tags', itemName: 'tag', items: current.tags, path: current.path.concat('tags'), write: setList('tags') }),
        dom.el('div', { class: 'c4-editor__field' }, [
          dom.el('p', { class: 'c4-editor__field-label', text: 'Id' }),
          dom.el('p', { class: 'c4-editor__id', text: current.id }),
          changeIdLock(current) ? dom.el('p', { class: 'c4-editor__lock-note', text: changeIdLock(current) })
            : button('Change id…', (event) => actions.openChangeIdDialog(current.id, { returnFocus: event.currentTarget }),
              { 'data-c4-focus-key': 'change-id' }),
        ]),
      ];
    }

    /**
     * A code element's `provides` (its UML «interface» operations) with the list editor; a full-form map, which only
     * the Interfaces section of a system, container, or component describes, is shown read-only (spec §9.5; Ruling 21).
     */
    function providesField(model, current, write) {
      const fullForm = [...model.interfaces.values()].some((declared) => declared.providerId === current.id && !declared.shorthand);
      if (fullForm) return dom.el('p', { class: 'c4-editor__field c4-editor__provides-note', text: TEXT.fullFormProvides });
      return textList({ key: 'provides', label: 'Provides', itemName: 'interface', items: current.provides,
        path: current.path.concat('provides'), write });
    }

    function stereotypesField(current) {
      const path = current.path.concat('stereotypes');
      const legendId = ids('insp-stereotypes-label');
      const toggle = (stereotype) => (checked) => {
        const next = STEREOTYPES.filter((candidate) => (candidate === stereotype ? checked : current.stereotypes.includes(candidate)));
        return run({ op: 'setList', elementId: current.id, field: 'stereotypes', items: next }, `Edit the stereotypes of ${current.name}`);
      };
      return dom.el('div', { class: 'c4-editor__field', role: 'group', 'aria-labelledby': legendId }, [
        dom.el('p', { id: legendId, class: 'c4-editor__field-label', text: 'Stereotypes' }),
        STEREOTYPES.map((stereotype) => field({ key: `stereotype-${stereotype}`, label: words(stereotype), control: 'checkbox',
          value: current.stereotypes.includes(stereotype), path, lintPath: null, onCommit: toggle(stereotype) })),
      ]);
    }

    function groupField(model, current) {
      const scopeId = current.type === 'person' || current.type === 'system' ? null : current.parentId;
      const groups = [...model.groups.values()].filter((group) => (group.scopeId || null) === scopeId);
      if (groups.length === 0 && current.group === null) return null;
      return field({ key: 'group', label: 'Group', control: 'select', value: current.group || '', path: current.path.concat('group'),
        choices: [{ value: '', label: 'No group' }].concat(groups.map((group) => ({ value: group.id, label: group.name || group.id }))),
        onCommit: (value) => run({ op: 'setElementField', elementId: current.id, field: 'group', value: value === '' ? null : value },
          `Change the group of ${current.name}`) });
    }

    return { basicsSection, typeLine, moreBody };
  }

  return { createIdentitySections };
});
