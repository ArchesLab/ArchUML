(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../c4-core.js'), function () {
      return {
        state: require('./c4-editor-state.js'),
        interfaces: require('./c4-editor-interfaces.js'),
        actionsShared: require('./c4-editor-actions-shared.js'),
        actionsFields: require('./c4-editor-actions-fields.js'),
        anchoredForm: require('./c4-editor-anchored-form.js'),
      };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.actionsRelationshipForm = factory(root.ArchUMLC4, function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (C4, editorParts) {
  'use strict';

  // The anchored relationship form (spec §9.2 "Relationship details"), a unit of the shared commands
  // (c4-editor-actions.js): the relationship fields (Ruling 6) in a dialog beside what it was opened from, its "More"
  // with the Uses picker (spec §9.5), and "Add an interface to <target>", which hands focus to the inspector.

  // The element types whose inspector form has an Interfaces section (code elements list syntax lines instead).
  const INTERFACE_PROVIDERS = new Set(['system', 'container', 'component']);

  /**
   * The relationship form. `actions` is the shared context of createActions (state, dom, reading the model, results,
   * dialogs) with the relationship commands, through which the form adds and updates.
   */
  function createRelationshipForm(actions) {
    const { options, state, dom, ids, frames, lockedFields, announce, model, elementOf, nameOf, relationshipOf, readOnlyReason,
      missingElement, missingRelationship, succeed, refuse, dispatch, cancelled, openAnchoredForm, addRelationship,
      updateRelationship, relationshipDiagnostics } = actions;
    const { DEFAULT_CONNECTOR, changedFields, valuesOf, sentence, relationshipPhrase } = editorParts().actionsShared;
    const { buildRelationshipFields } = editorParts().actionsFields;
    let interfaceRequests = 0;

    /**
     * The anchored relationship form (spec §9.2 "Relationship details"): for `{ sourceId, targetId }` it adds a new
     * relationship, for `{ relationshipId }` it edits one. Enter confirms; Escape adds or changes nothing.
     * `placement`: `anchor` or `point` to sit beside, and `returnFocus`; for a canvas gesture (UML-view editing plan
     * Task 36) also `lead`, a sentence shown above the fields that says why the form opened, and `alsoDispatch`,
     * commands written with a new relationship in one batch, so the gesture is one change and one undo step. Resolves
     * the command's result; after "Add an interface to <target>" it also carries `focusHandedOff: true`, since focus
     * then waits in the inspector and the caller must not move it back.
     */
    function openRelationshipForm(target, placement = {}) {
      const existing = target.relationshipId ? relationshipOf(target.relationshipId) : null;
      const sourceId = existing ? existing.sourceId : target.sourceId;
      const targetId = existing ? existing.targetId : target.targetId;
      const problem = readOnlyReason() || (target.relationshipId && !existing ? missingRelationship(target.relationshipId) : null)
        || missingElement(sourceId) || missingElement(targetId);
      if (problem) return Promise.resolve(refuse(problem));
      const fields = buildRelationshipFields({ dom, ids, frames }, {
        name: 'relationship-form',
        sourceName: nameOf(sourceId),
        targetName: nameOf(targetId),
        values: existing ? valuesOf(existing) : {},
      });
      if (placement.lead) addLead(fields, placement.lead);
      if (existing) fields.showDiagnostics(relationshipDiagnostics(existing.id));
      // "Add an interface to <target>" in More's empty state submits the form first, so the learner's work is kept.
      let addInterfaceAfter = false;
      const submitThenAddInterface = () => {
        const form = fields.element.closest('form');
        addInterfaceAfter = true;
        form.requestSubmit(form.querySelector('button[type="submit"]'));
      };
      const uses = usesDisclosure(existing, sourceId, targetId, canAddInterfaceTo(targetId) ? submitThenAddInterface : null);
      if (uses) fields.element.appendChild(uses.element);
      const closed = openAnchoredForm({
        body: fields.element,
        title: existing ? 'Edit relationship' : 'Add relationship',
        placement,
        returnFocus: placement.returnFocus,
        initialFocus: fields.inputs.description,
        submitLabel: existing ? 'Save' : 'Add',
        onSubmit() {
          if (!fields.validate({ requireDescription: !existing || existing.description !== null })) return { ok: false };
          const values = fields.getValues();
          const picker = uses ? uses.picker : null;
          const result = existing ? saveRelationship(existing, values, picker)
            : addRelationshipUsing(Object.assign({ sourceId, targetId }, values), picker, placement.alsoDispatch || []);
          if (!result.ok) fields.showLocalProblem('description', result.message);
          return result;
        },
      });
      // A refused submit keeps the form open; only the submit the button started may go on to the interface.
      fields.element.closest('form').addEventListener('submit', (event) => {
        if (event.defaultPrevented) addInterfaceAfter = false;
      });
      return closed.then((result) => {
        if (result !== null && addInterfaceAfter && result.ok) {
          openNewInterface(targetId);
          return Object.assign({}, result, { focusHandedOff: true });
        }
        if (result !== null) return result;
        return cancelled(existing ? `Kept ${relationshipPhrase(model(), existing)}.`
          : `No relationship added from ${nameOf(sourceId)} to ${nameOf(targetId)}.`);
      });
    }

    /**
     * Puts the sentence `lead` above the form's fields and adds it to the Description field's description, so a screen
     * reader that lands in the field hears why the form opened.
     */
    function addLead(fields, lead) {
      const paragraph = dom.el('p', { id: ids('relationship-form-lead'), class: 'c4-editor__form-lead', text: lead });
      fields.element.prepend(paragraph);
      const description = fields.inputs.description;
      description.setAttribute('aria-describedby', [paragraph.id, description.getAttribute('aria-describedby')].filter(Boolean).join(' '));
    }

    /**
     * The anchored form's "More" (spec §9.5): a collapsed disclosure holding the Uses picker of
     * `c4-editor-interfaces.js`, which only collects the choice; the form writes it on submit. Null when the interfaces
     * part is not loaded. Like the inspector, a lock anywhere under the relationship's `uses` disables every box,
     * because `setUses` rewrites the whole list.
     */
    function usesDisclosure(existing, sourceId, targetId, onAddInterface) {
      const parts = editorParts() || {};
      if (!parts.interfaces || typeof parts.interfaces.createUsesPicker !== 'function') return null;
      const path = existing ? existing.path.concat('uses') : null;
      const picker = parts.interfaces.createUsesPicker({
        dom, ids, announce, design: state.getDesign(), name: 'relationship-form-uses', path,
        locked: path && parts.state.touchesLockedPath(path, lockedFields) ? 'Locked: given by the task, so it cannot be changed here.' : null,
        sourceId, targetId, responsibility: existing ? existing.responsibility : null,
        uses: existing ? existing.uses.filter((use) => !use.inherited) : [],
        onAddInterface,
      });
      const element = dom.el('details', { class: 'c4-editor__inspector-disclosure' }, [
        dom.el('summary', { class: 'c4-editor__inspector-summary', text: 'More' }),
        picker.element,
      ]);
      return { element, picker };
    }

    /**
     * Whether the anchored form may offer "Add an interface to <target>": the inspector is there to take the new
     * interface's name, the target is a software system, container, or component (the elements whose form has an
     * Interfaces section), and no lock covers a new entry under its `provides`.
     */
    function canAddInterfaceTo(targetId) {
      const parts = editorParts() || {};
      const element = elementOf(targetId);
      if (!parts.inspector || !element || !INTERFACE_PROVIDERS.has(element.type)) return false;
      return !parts.state.touchesLockedPath(element.path.concat('provides', '*'), lockedFields);
    }

    /**
     * Opens the target in the inspector with focus on its new interface's name: a selection carrying a focus request
     * for the `provides` field (as Problems › Show sends one), with the inspector region expanded (Ruling 17).
     */
    function openNewInterface(targetId) {
      const element = elementOf(targetId);
      if (!element) return;
      interfaceRequests += 1;
      state.select({ elementId: targetId, focus: { path: element.path.concat('provides'), request: `relationship-form-${interfaceRequests}` } });
      if (options.layout && typeof options.layout.revealRegion === 'function') options.layout.revealRegion('inspector');
      announce(`Name the new interface of ${element.name}, then choose it under Uses.`);
    }

    /** The form's submit for a declared relationship: its changed fields and its `uses` as one undo step. */
    function saveRelationship(relationship, values, picker) {
      const usesCommand = picker ? picker.commandFor(relationship.id) : null;
      if (usesCommand === null) return updateRelationship(relationship.id, values);
      const problem = readOnlyReason();
      if (problem) return refuse(problem);
      const written = changedFields(relationship, values);
      const commands = Object.keys(written).length === 0 ? []
        : [Object.assign({ op: 'updateRelationship', relationshipId: relationship.id }, written)];
      const phrase = relationshipPhrase(model(), relationship);
      const result = dispatch({ op: 'batch', commands: commands.concat(usesCommand) }, `Edit ${phrase}`);
      return result.ok ? succeed(`Updated ${phrase}.`) : result;
    }

    /**
     * The form's submit for a new relationship. With interfaces chosen, a dry run learns the id the core gives the
     * relationship (Ruling 14), so the relationship and its `uses` are one batch: one change and one undo step. The
     * commands `alsoDispatch` (a canvas gesture's) join that batch after them.
     */
    function addRelationshipUsing(fields, picker, alsoDispatch) {
      const { sourceId, targetId, description, technology = '', connector = DEFAULT_CONNECTOR } = fields;
      const usesChosen = Boolean(picker) && picker.getUses().length > 0;
      if (!usesChosen && alsoDispatch.length === 0) return addRelationship(fields);
      const problem = readOnlyReason() || missingElement(sourceId) || missingElement(targetId);
      if (problem) return refuse(problem);
      const add = { op: 'addRelationship', sourceId, targetId, description, technology: technology || null, connector };
      const dryRun = C4.edit(state.getDesign(), add);
      if (dryRun.error) return refuse(`Error: ${dryRun.message}.`, dryRun.error);
      const relationshipId = dryRun.selection.relationshipId;
      const label = `Add a relationship from ${nameOf(sourceId)}`;
      const uses = usesChosen ? [picker.commandFor(relationshipId)] : [];
      const result = dispatch({ op: 'batch', commands: [add].concat(uses, alsoDispatch) }, label);
      if (!result.ok) return result;
      return succeed(`Added: ${sentence(nameOf(sourceId), description, nameOf(targetId), technology)}.`, { relationshipId });
    }

    return { openRelationshipForm };
  }

  return { createRelationshipForm };
});
