(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../c4-core.js'), function () {
      return {
        interfaces: require('./c4-editor-interfaces.js'),
        inspectorShared: require('./c4-editor-inspector-shared.js'),
      };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.inspectorRelationships = factory(root.ArchUMLC4, function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (C4, editorParts) {
  'use strict';

  // Relationships in the inspector (spec §9.1, §9.2, §9.5), built from the inspector's kit (c4-editor-inspector-kit.js):
  // the element form's Collaborators (the relationships it declares, with the shared relationship fields of Ruling 6)
  // and Relationships in this view (each drawn edge, with "Move to…"), the relationship form with its Uses picker
  // (c4-editor-interfaces.js), and the form of a derived edge with "Add a summary relationship".

  /**
   * The relationship sections and forms. `inspector` is the inspector's shared context: the kit, the render cycle's
   * `live`, `rememberRow`, and `focusAfterRender`, `state`, `dom`, `ids`, `announce`, `actions`, and the choices
   * section's `choicesBody`. Returns `collaboratorsSection(model, current)`, `relationshipsInViewSection(model,
   * current)`, `relationshipForm(model, relationshipId)`, and `derivedForm(model, selection)`.
   */
  function createRelationshipSections(inspector) {
    const { state, dom, ids, announce, actions, field, formSection, disclosure, button, listEditor, run, problem, lockReason,
      touchesLock, requestFocus, scheduleRender, byKey, live, rememberRow, focusAfterRender, choicesBody } = inspector;
    const { TEXT, hasInterfacesSection, relationshipById, sentenceOf, slug } = editorParts().inspectorShared;
    // What the section keeps between renders: the target chosen for the new collaborator.
    const view = { newCollaboratorTarget: null };

    // ---- Collaborators -------------------------------------------------------------------------

    function collaboratorsSection(model, current) {
      const declared = model.relationships.filter((relationship) => relationship.sourceId === current.id);
      const listPath = current.path.concat('collaborators');
      const reason = lockReason(listPath);
      const rows = listEditor({
        name: 'collaborators',
        label: 'Collaborators',
        itemName: 'collaborator',
        items: declared,
        locked: reason,
        rowLocked: (index) => lockReason(declared[index].path),
        renderRow: (relationship, index) => collaboratorRow(model, current, relationship, index),
        onRemove: (index) => actions.deleteRelationship(declared[index].id).ok,
        emptyFocusKey: 'collaborator-new-target',
      });
      return formSection('collaborators', 'Collaborators', [
        reason ? dom.el('p', { class: 'c4-editor__lock-note', text: reason }) : null,
        declared.length > 0 ? rows : dom.el('p', { class: 'c4-editor__field-hint', text: `${current.name} asks no other element for help yet.` }),
        reason ? null : newCollaborator(model, current),
      ]);
    }

    function targetChoices(model, current) {
      const names = new Map();
      model.elements.forEach((candidate) => names.set(candidate.name, (names.get(candidate.name) || 0) + 1));
      return [...model.elements.values()]
        .filter((candidate) => candidate.id !== current.id && !C4.isNested(model, candidate.id, current.id))
        .map((candidate) => ({ value: candidate.id, label: names.get(candidate.name) > 1 ? `${candidate.name} (${candidate.id})` : candidate.name }));
    }

    function collaboratorRow(model, current, relationship, index) {
      const key = `collaborator-${index}`;
      const legendId = ids(`insp-${key}-legend`);
      const fields = relationshipFields(model, relationship, key);
      return dom.el('div', { class: 'c4-editor__collaborator', role: 'group', 'aria-labelledby': legendId }, [
        dom.el('p', { id: legendId, class: 'c4-editor__field-label',
          text: `Collaborator ${index + 1}: ${model.elements.get(relationship.targetId).name}` }),
        field({ key: `${key}-target`, label: 'Target', control: 'select', value: relationship.targetId,
          choices: targetChoices(model, current), path: relationship.path, lintPath: null,
          onCommit: (targetId) => {
            // The move selects the moved relationship; the learner stays in this element's form.
            if (actions.moveRelationship(relationship.id, { targetId }).ok) state.select({ elementId: current.id });
            scheduleRender();
            requestFocus(`${key}-target`);
          } }),
        fields,
      ]);
    }

    /**
     * The shared relationship fields (Ruling 6) for a declared relationship, committing each field as it changes and
     * showing its diagnostics; read-only under a lock.
     */
    function relationshipFields(model, relationship, key) {
      const reason = lockReason(relationship.path);
      const builder = actions.createRelationshipFields({
        name: `insp-${slug(key)}`,
        sourceName: model.elements.get(relationship.sourceId).name,
        targetName: model.elements.get(relationship.targetId).name,
        values: { description: relationship.description || '', technology: relationship.technology || '', connector: relationship.connector },
        onChange: reason ? null : live((fieldName, values) => actions.updateRelationship(relationship.id, { [fieldName]: values[fieldName] })),
      });
      builder.showDiagnostics(actions.relationshipDiagnostics(relationship.id));
      Object.entries(builder.inputs).forEach(([fieldName, input]) => {
        input.setAttribute('data-c4-focus-key', `${key}-${fieldName}`);
        input.setAttribute('data-c4-path', JSON.stringify(relationship.path.concat(fieldName)));
        if (!reason) return;
        if (input.tagName === 'SELECT') input.disabled = true;
        else input.readOnly = true;
      });
      if (reason) {
        const note = dom.el('p', { id: ids(`insp-${slug(key)}-lock`), class: 'c4-editor__lock-note', text: reason });
        builder.element.prepend(note);
        Object.values(builder.inputs).forEach((input) => input.setAttribute('aria-describedby',
          `${note.id} ${input.getAttribute('aria-describedby') || ''}`.trim()));
      }
      return builder.element;
    }

    function newCollaborator(model, current) {
      const key = 'collaborator-new';
      const legendId = ids(`insp-${key}-legend`);
      const targetId = view.newCollaboratorTarget && model.elements.has(view.newCollaboratorTarget) ? view.newCollaboratorTarget : '';
      const builder = actions.createRelationshipFields({
        name: `insp-${key}`,
        sourceName: current.name,
        targetName: targetId ? model.elements.get(targetId).name : 'the target',
      });
      Object.entries(builder.inputs).forEach(([fieldName, input]) => input.setAttribute('data-c4-focus-key', `${key}-${fieldName}`));
      const add = () => {
        const chosen = byKey(`${key}-target`).value;
        if (chosen === '') return problem(`${key}-target`, `Error: Choose the element ${current.name} asks for help first.`);
        if (!builder.validate()) return false;
        const result = actions.addRelationship(Object.assign({ sourceId: current.id, targetId: chosen }, builder.getValues()));
        if (result.ok) {
          view.newCollaboratorTarget = null;
          // The new relationship is selected; the element stays in view, so its new row can be found.
          state.select({ elementId: current.id });
          requestFocus(`${key}-target`);
        }
        return result.ok;
      };
      const target = field({ key: `${key}-target`, label: 'Target', control: 'select', value: targetId,
        choices: [{ value: '', label: 'Choose the target…' }].concat(targetChoices(model, current)),
        path: current.path.concat('collaborators'), lintPath: null,
        onCommit: (value) => {
          view.newCollaboratorTarget = value;
          builder.setEnds(current.name, value ? model.elements.get(value).name : 'the target');
        } });
      return dom.el('div', { class: 'c4-editor__collaborator c4-editor__list-add', role: 'group', 'aria-labelledby': legendId }, [
        dom.el('p', { id: legendId, class: 'c4-editor__field-label', text: 'New collaborator' }),
        target,
        builder.element,
        button('Add collaborator', add),
      ]);
    }

    // ---- Relationships in this view ------------------------------------------------------------

    /**
     * The edges of the open view that touch the element (spec §9.1, Review Focus 4): outgoing and incoming declared
     * edges, and derived ones; each a button opening its form, and each declared one with "Move to…" (spec §9.2).
     */
    function relationshipsInViewSection(model, current) {
      const projected = C4.project(state.getDesign(), state.getView());
      const shown = projected.nodes.concat(projected.boundaries || []).some((node) => node.id === current.id);
      if (!shown) {
        return formSection('in-view', 'Relationships in this view', dom.el('p', { class: 'c4-editor__field-hint',
          text: `${current.name} is not drawn in the open view.` }));
      }
      const touching = projected.edges.filter((edge) => edge.sourceId === current.id || edge.targetId === current.id);
      const groups = [
        { key: 'outgoing', label: 'Outgoing', edges: touching.filter((edge) => !edge.derived && edge.sourceId === current.id) },
        { key: 'incoming', label: 'Incoming', edges: touching.filter((edge) => !edge.derived && edge.targetId === current.id) },
        { key: 'derived', label: 'Derived', edges: touching.filter((edge) => edge.derived) },
      ].filter((group) => group.edges.length > 0);
      if (groups.length === 0) {
        return formSection('in-view', 'Relationships in this view', dom.el('p', { class: 'c4-editor__field-hint',
          text: `No relationship of ${current.name} is drawn in this view.` }));
      }
      return formSection('in-view', 'Relationships in this view', groups.map((group) => {
        const labelId = ids(`insp-in-view-${group.key}`);
        return dom.el('div', { class: 'c4-editor__edge-group' }, [
          dom.el('p', { id: labelId, class: 'c4-editor__field-label', text: group.label }),
          dom.el('ul', { class: 'c4-editor__edge-list', 'aria-labelledby': labelId },
            group.edges.map((edge, index) => edgeRow(model, current, edge, `${group.key}-${index}`))),
        ]);
      }));
    }

    function edgeRow(model, current, edge, key) {
      const rowKey = `edge-${key}`;
      const name = (id) => model.elements.get(id).name;
      if (edge.derived) {
        const sources = edge.sources.map((id) => relationshipById(model, id)).filter(Boolean);
        sources.forEach((source) => rememberRow(source.id, rowKey));
        return dom.el('li', { class: 'c4-editor__edge-row' }, button([
          dom.el('span', { class: 'c4-editor__edge-ends', text: `${name(edge.sourceId)} → ${name(edge.targetId)}` }),
          ' ',
          dom.el('span', { class: 'c4-editor__edge-detail', text: `derived from ${sources.map((source) => sentenceOf(model, source)).join('; ')}` }),
        ], () => state.select({ edgeId: edge.id, sourceId: edge.sourceId, targetId: edge.targetId }),
        { class: 'c4-editor__button c4-editor__edge-button', 'data-c4-focus-key': rowKey }));
      }
      const relationship = relationshipById(model, edge.id);
      if (!relationship) return dom.el('li', { class: 'c4-editor__edge-row', text: `${name(edge.sourceId)} → ${name(edge.targetId)}` });
      rememberRow(relationship.id, rowKey);
      const sentence = sentenceOf(model, relationship);
      const locked = state.isReadOnly() ? null : lockReason(relationship.path);
      return dom.el('li', { class: 'c4-editor__edge-row' }, [
        button(sentence, () => state.select({ relationshipId: relationship.id }),
          { class: 'c4-editor__button c4-editor__edge-button', 'data-c4-focus-key': rowKey }),
        // Read-only mode is explained once above the form; a lock is explained on its row.
        state.isReadOnly() ? null : locked ? dom.el('span', { class: 'c4-editor__lock-note', text: locked })
          : button(['Move to…', dom.el('span', { class: 'c4-editor__sr-only', text: ` ${sentence}` })],
            (event) => openMoveMenu(relationship, event.currentTarget, current.id),
            { 'aria-haspopup': 'menu', 'data-c4-focus-key': `${rowKey}-move` }),
      ]);
    }

    /**
     * "Move to…" for a declared relationship (spec §9.2, the shared command): afterwards the element stays selected and
     * focus returns to the row that now shows the moved relationship, or to its own form when no row does.
     */
    function openMoveMenu(relationship, anchor, elementId) {
      actions.openRelationshipMoveMenu(relationship.id, {
        anchor,
        returnFocus: anchor,
        onDone: (result) => {
          if (!result || !result.ok || result.unchanged) return;
          if (elementId) state.select({ elementId });
          focusAfterRender(elementId ? { relationshipId: result.relationshipId } : { key: 'relationship-description' });
        },
      });
    }

    // ---- Relationship forms --------------------------------------------------------------------

    function relationshipForm(model, relationshipId) {
      const relationship = relationshipById(model, relationshipId);
      if (!relationship) return dom.el('p', { class: 'c4-editor__inspector-empty', tabindex: '-1', 'data-c4-focus-key': 'empty',
        text: 'This relationship is no longer in the model.' });
      const [source, target] = [model.elements.get(relationship.sourceId), model.elements.get(relationship.targetId)];
      const locked = lockReason(relationship.path);
      return dom.el('div', { class: 'c4-editor__inspector-form' }, [
        dom.el('h3', { class: 'c4-editor__inspector-title', tabindex: '-1', 'data-c4-focus-key': 'title',
          text: `Relationship: ${source.name} → ${target.name}` }),
        relationshipFields(model, relationship, 'relationship'),
        usesSection(relationship),
        dom.el('div', { class: 'c4-editor__inspector-actions' }, [
          locked || state.isReadOnly() ? null : button('Move to…', (event) => openMoveMenu(relationship, event.currentTarget, null),
            { 'aria-haspopup': 'menu', 'data-c4-focus-key': 'relationship-move' }),
          locked || state.isReadOnly() ? null : button('Delete relationship', () => {
            if (actions.deleteRelationship(relationship.id).ok) {
              state.select({ elementId: source.id });
              requestFocus('title');
            }
          }, { 'data-c4-focus-key': 'relationship-delete' }),
          button(`Show ${source.name}`, () => state.select({ elementId: source.id }), { 'data-c4-focus-key': 'relationship-source' }),
          button(`Show ${target.name}`, () => state.select({ elementId: target.id }), { 'data-c4-focus-key': 'relationship-target' }),
        ]),
        disclosure('relationship-choices', 'Design choices',
          () => choicesBody(relationship.choices, relationship.path.concat('choices'), { relationshipId: relationship.id })),
      ]);
    }

    /** Whether the element's Interfaces section offers its new-interface row (the condition `addRowUnlessLocked` applies). */
    function canAddInterfaceTo(element) {
      const providesPath = element.path.concat('provides');
      return hasInterfacesSection(element) && !lockReason(providesPath) && !touchesLock(providesPath.concat('*'));
    }

    /**
     * The Uses picker of a declared relationship (spec §9.5; built by c4-editor-interfaces.js): each choice is one
     * `setUses`; the empty state's button, offered when the target can take an interface, opens the target's Interfaces
     * section with focus on the new interface's name.
     */
    function usesSection(relationship) {
      const path = relationship.path.concat('uses');
      const { elements } = state.getDesign().model;
      const sourceName = elements.get(relationship.sourceId).name;
      const picker = editorParts().interfaces.createUsesPicker({
        dom, ids, announce, design: state.getDesign(), name: 'relationship-uses', path,
        // `setUses` rewrites the whole list, so a lock on one entry under `uses` disables every box.
        locked: touchesLock(path) ? (lockReason(path) || TEXT.locked) : null,
        sourceId: relationship.sourceId, targetId: relationship.targetId, responsibility: relationship.responsibility,
        uses: relationship.uses.filter((use) => !use.inherited),
        onChange: (uses) => run({ op: 'setUses', relationshipId: relationship.id, uses }, `Change the interfaces ${sourceName} uses`),
        // Offered only when the target's form will hold the new-interface field that takes focus (not for a person,
        // nor a locked `provides`), so the button never leaves focus nowhere.
        onAddInterface: canAddInterfaceTo(elements.get(relationship.targetId)) ? (targetId) => {
          state.select({ elementId: targetId });
          requestFocus('iface-new-name');
        } : null,
      });
      return formSection('uses', 'Uses', picker.element);
    }

    /** What a derived edge's sources use, read-only (spec §9.5): the union of their `uses`. */
    function derivedUsesSection(model, sources) {
      const used = editorParts().interfaces.derivedUses(model, sources);
      return formSection('uses', 'Uses', used.length === 0
        ? dom.el('p', { class: 'c4-editor__field-hint', text: 'None of these relationships names an interface it uses yet.' })
        : dom.el('ul', { class: 'c4-editor__uses-derived' }, used.map((use) => dom.el('li', { text: use.label }))));
    }

    /** A derived edge (spec §9.1): the relationships it is drawn from, and "Add a summary relationship". */
    function derivedForm(model, selection) {
      const projected = C4.project(state.getDesign(), state.getView());
      const edge = projected.edges.find((candidate) => candidate.id === selection.edgeId)
        || projected.edges.find((candidate) => candidate.derived && candidate.sourceId === selection.sourceId && candidate.targetId === selection.targetId);
      if (!edge || !model.elements.has(edge.sourceId) || !model.elements.has(edge.targetId)) {
        return dom.el('p', { class: 'c4-editor__inspector-empty', tabindex: '-1', 'data-c4-focus-key': 'empty',
          text: 'This derived relationship is no longer drawn in the open view.' });
      }
      const [source, target] = [model.elements.get(edge.sourceId), model.elements.get(edge.targetId)];
      const sources = edge.sources.map((id) => relationshipById(model, id)).filter(Boolean);
      return dom.el('div', { class: 'c4-editor__inspector-form' }, [
        dom.el('h3', { class: 'c4-editor__inspector-title', tabindex: '-1', 'data-c4-focus-key': 'title',
          text: `Derived relationship: ${source.name} → ${target.name}` }),
        dom.el('p', { text: TEXT.derivedLead }),
        dom.el('ul', { class: 'c4-editor__edge-list' }, sources.map((relationship, index) => dom.el('li', { class: 'c4-editor__edge-row' },
          button(sentenceOf(model, relationship), () => state.select({ relationshipId: relationship.id }),
            { class: 'c4-editor__button c4-editor__edge-button', 'data-c4-focus-key': `derived-source-${index}` })))),
        derivedUsesSection(model, sources),
        state.isReadOnly() || lockReason(source.path.concat('collaborators')) ? null
          : button('Add a summary relationship', (event) => {
            actions.openRelationshipForm({ sourceId: source.id, targetId: target.id }, { anchor: event.currentTarget, returnFocus: event.currentTarget })
              .then((result) => { if (result && result.ok) requestFocus('relationship-description'); });
          }, { 'data-c4-focus-key': 'derived-add-summary' }),
      ]);
    }

    return { collaboratorsSection, relationshipsInViewSection, relationshipForm, derivedForm };
  }

  return { createRelationshipSections };
});
