(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(function () {
      return {
        actionsShared: require('./c4-editor-actions-shared.js'),
        actionsFields: require('./c4-editor-actions-fields.js'),
        actionsCanvas: require('./c4-editor-actions-canvas.js'),
        actionsIds: require('./c4-editor-actions-ids.js'),
        actionsElements: require('./c4-editor-actions-elements.js'),
        actionsRelationships: require('./c4-editor-actions-relationships.js'),
        actionsRelationshipForm: require('./c4-editor-actions-relationship-form.js'),
        anchoredForm: require('./c4-editor-anchored-form.js'),
      };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.actions = factory(function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (editorParts) {
  'use strict';

  // The editor's shared commands (spec §9.2): element commands (Delete with confirmation, rename, Move to…,
  // Change id…, Zoom in, pinning a position), the renames of deployment nodes and provided interfaces (UML-view
  // editing spec §5.1), the palette and Add relationship hooks of the toolbar (Ruling 3, with
  // the canvas's modes registered through `attachCanvas`), relationship commands (add, update, delete, Move to… for
  // one end), the relationship-fields builder (Ruling 6), the anchored relationship form, the context menus that
  // offer these commands (built with the editor's one menu helper, c4-editor-dom.js), and the quick-fix registry
  // (Ruling 20). The canvas, outline, inspector, and panels call these commands instead of
  // editing on their own, so every edit is one `state.dispatch` (one undo step) and every result is announced.
  // It reads the model only through the `ArchUMLC4` facade and the state's `getDesign()`.
  //
  // This file holds what every command shares (reading the model, announcing results, the menus and dialogs) and
  // returns the commands as one module. The commands live in units by concern: the palette and the canvas's modes
  // (c4-editor-actions-canvas.js), renaming and ids (-ids), the other element commands and menus (-elements),
  // relationship commands and menus (-relationships), the anchored relationship form (-relationship-form), the
  // relationship-fields builder (-fields), and the DOM-free helpers they share (-shared).

  const READ_ONLY_REASONS = {
    'read-only': 'Error: This model is read-only, so it cannot be changed here.',
    'yaml-errors': 'Error: The YAML has errors. Fix them in the YAML first; until then the diagram shows the last model that could be read.',
  };
  // How a refusal is announced: shown in the editor's message region as one (UML-view editing spec §7.5, §14 D6).
  const AS_REFUSAL = Object.freeze({ kind: 'refusal' });

  /**
   * Creates the commands of one editor. `root` is the editor root, which holds its menus and dialogs. `options`:
   * `state` (createEditorState), `dom` (the DOM utilities), `host` (spec §3.4; `confirm` is optional), `ids` (an
   * idFactory), `announce` (the editor's `announce(message, { kind })`; a polite announcer is created in `root` when
   * absent), `scaffolds` (`sentenceFrames: false` hides the description's sentence frame), and the mount's `options`
   * (`lockedFields`). Every refusal is announced with `kind: 'refusal'`, so the editor also shows it.
   */
  function createActions(root, options) {
    const parts = editorParts();
    const { state, dom, ids } = options;
    const host = options.host || {};
    const announcer = options.announce || dom.createAnnouncer(root);
    const frames = !(options.scaffolds && options.scaffolds.sentenceFrames === false);
    const lockedFields = (options.options && options.options.lockedFields) || [];
    const menus = dom.createMenus(root, { ids, announce, name: 'menu' });
    const openDialogs = new Set();
    const { elementName } = parts.actionsShared;
    let destroyed = false;

    function announce(message, details) {
      if (!destroyed) announcer(message, details);
    }

    // ---- Reading the model -------------------------------------------------------------------

    function model() {
      return state.getDesign().model;
    }

    function elementOf(id) {
      const current = model();
      return current ? current.elements.get(id) || null : null;
    }

    function nameOf(id) {
      return elementName(model(), id);
    }

    function relationshipOf(id) {
      const current = model();
      return current ? current.relationships.find((relationship) => relationship.id === id) || null : null;
    }

    function readOnlyReason() {
      return state.isReadOnly() ? READ_ONLY_REASONS[state.getMode().reason] : null;
    }

    /** Why `command` would be refused for a lock (spec §11), asked before the learner confirms anything; or null. */
    function lockedProblem(command) {
      const refusal = state.lockRefusal(command);
      return refusal === null ? null : refusal.message;
    }

    function missingElement(elementId) {
      return elementOf(elementId) ? null : `Error: There is no element ${elementId}.`;
    }

    function missingRelationship(relationshipId) {
      return `Error: There is no relationship ${relationshipId}.`;
    }

    // ---- Results -----------------------------------------------------------------------------

    function succeed(message, extra) {
      announce(message);
      return Object.assign({ ok: true, message }, extra);
    }

    function refuse(message, error) {
      announce(message, AS_REFUSAL);
      return { ok: false, error: error || 'refused', message };
    }

    /** Dispatches one core command as one undo step; a refusal is announced with its reason. */
    function dispatch(command, label) {
      const result = state.dispatch(command, { label });
      return result.ok ? result : refuse(state.refusalText(result), result.error);
    }

    function unopened(message) {
      announce(message);
      return null;
    }

    function finish(placement, result) {
      Promise.resolve(result).then((settled) => {
        if (placement.onDone) placement.onDone(settled);
      });
      return result;
    }

    function cancelled(message) {
      announce(message);
      return { ok: false, cancelled: true };
    }

    // ---- Dialogs -----------------------------------------------------------------------------

    /** `dom.openDialog` for a body element of this module; the dialog closes when the actions are destroyed. */
    function trackedDialog(body, dialogOptions) {
      menus.close();
      const closed = dom.openDialog(root, Object.assign({ ids, body }, dialogOptions));
      const dialog = body.closest('dialog');
      openDialogs.add(dialog);
      return closed.then((value) => {
        openDialogs.delete(dialog);
        return value;
      });
    }

    /**
     * Runs `submit()` when the dialog's form is submitted (Enter or the default action); a result that is not ok
     * keeps the dialog open. Returns the last result.
     */
    function onSubmit(field, submit) {
      const outcome = { result: null };
      field.form.addEventListener('submit', (event) => {
        outcome.result = submit();
        if (!outcome.result.ok) event.preventDefault();
      });
      return outcome;
    }

    /**
     * An anchored form in this editor's dialogs (c4-editor-anchored-form.js; `spec` as `openAnchoredForm` there takes
     * it, without `using`): the relationship form and the forms of the UML views open through it. Resolves the submit's
     * result, or null when the form was cancelled. A page that loads the editor's scripts by hand without that part
     * gets the same form, made here from the same pieces.
     */
    function openAnchoredForm(spec) {
      const helper = editorParts().anchoredForm;
      if (helper) return helper.openAnchoredForm(Object.assign({}, spec, { using: { dom, openDialog: trackedDialog } }));
      const closed = trackedDialog(spec.body, {
        title: spec.title, initialFocus: spec.initialFocus, returnFocus: spec.returnFocus,
        actions: [{ label: spec.cancelLabel || 'Cancel', value: null }, { label: spec.submitLabel || 'OK', value: 'submit', isDefault: true }],
      });
      const placement = spec.placement || {};
      if (placement.anchor || placement.point) {
        const dialog = spec.body.closest('dialog');
        const place = () => dom.placeNear(dialog, placement);
        dialog.classList.add('c4-editor__dialog--anchored');
        place();
        spec.body.addEventListener('toggle', place, true);
      }
      let result = null;
      spec.body.closest('form').addEventListener('submit', (event) => {
        result = spec.onSubmit();
        if (result && result.ok === false) event.preventDefault();
      });
      return closed.then((value) => (value === null ? null : result));
    }

    function showFieldProblem(field, problemText, message) {
      problemText.textContent = message || '';
      problemText.hidden = !message;
      if (message) field.setAttribute('aria-invalid', 'true');
      else field.removeAttribute('aria-invalid');
    }

    // ---- The units ---------------------------------------------------------------------------

    // What every unit reads. Each unit's commands join it as the unit is created, so a unit can use the commands of
    // the units made before it: pinning announces where the canvas drew the element, the element menu offers
    // Change id…, and the relationship form adds and updates through the relationship commands.
    const context = {
      root, options, state, dom, ids, host, frames, lockedFields, menus, announce, model, elementOf, nameOf, relationshipOf,
      readOnlyReason, lockedProblem, missingElement, missingRelationship, succeed, refuse, dispatch, unopened, finish,
      cancelled, trackedDialog, onSubmit, openAnchoredForm, showFieldProblem, isDestroyed: () => destroyed,
    };
    const canvas = parts.actionsCanvas.createCanvasCommands(context);
    Object.assign(context, canvas);
    const idCommands = parts.actionsIds.createIdCommands(context);
    Object.assign(context, idCommands);
    const elements = parts.actionsElements.createElementCommands(context);
    Object.assign(context, elements);
    const relationships = parts.actionsRelationships.createRelationshipCommands(context);
    Object.assign(context, relationships);
    const relationshipForm = parts.actionsRelationshipForm.createRelationshipForm(context);

    // ---- Lifecycle ---------------------------------------------------------------------------

    /** Closes the open menu and dialogs (a dialog closes as cancelled) and removes every listener. */
    function destroy() {
      destroyed = true;
      canvas.forgetCanvas();
      menus.dispose();
      openDialogs.forEach((dialog) => dialog.close(''));
    }

    return {
      deleteElement: elements.deleteElement,
      renameElement: idCommands.renameElement,
      renameNode: idCommands.renameNode,
      renameInterface: idCommands.renameInterface,
      editElementText: elements.editElementText,
      parentCandidates: elements.parentCandidates,
      moveElementTo: elements.moveElementTo,
      pinElement: elements.pinElement,
      changeElementId: idCommands.changeElementId,
      zoomIn: elements.zoomIn,
      attachCanvas: canvas.attachCanvas,
      activatePaletteTile: canvas.activatePaletteTile,
      startPaletteDrag: canvas.startPaletteDrag,
      startRefineDrag: canvas.startRefineDrag,
      startAddRelationship: canvas.startAddRelationship,
      addElementFromTile: canvas.addElementFromTile,
      umlEditing: canvas.umlEditing,
      resetUmlLayout: canvas.resetUmlLayout,
      addRelationship: relationships.addRelationship,
      newRelationshipProblem: relationships.newRelationshipProblem,
      readOnlyReason,
      updateRelationship: relationships.updateRelationship,
      deleteRelationship: relationships.deleteRelationship,
      relationshipMoveCandidates: relationships.relationshipMoveCandidates,
      moveRelationship: relationships.moveRelationship,
      relationshipDiagnostics: relationships.relationshipDiagnostics,
      quickFixFor: relationships.quickFixFor,
      openElementMenu: elements.openElementMenu,
      openMoveToMenu: elements.openMoveToMenu,
      openRelationshipMenu: relationships.openRelationshipMenu,
      openRelationshipMoveMenu: relationships.openRelationshipMoveMenu,
      openChangeIdDialog: idCommands.openChangeIdDialog,
      openRelationshipForm: relationshipForm.openRelationshipForm,
      openAnchoredForm,
      createRelationshipFields: (spec) => parts.actionsFields.buildRelationshipFields({ dom, ids, frames }, spec),
      openMenu: menus.open,
      closeMenus: menus.close,
      destroy,
    };
  }

  return { createActions: createActions };
});
