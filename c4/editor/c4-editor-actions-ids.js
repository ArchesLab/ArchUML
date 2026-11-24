(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../c4-core.js'), function () {
      return { actionsShared: require('./c4-editor-actions-shared.js') };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.actionsIds = factory(root.ArchUMLC4, function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (C4, editorParts) {
  'use strict';

  // Renaming and changing ids (spec §4.10, §9.2; UML-view editing spec §5.1), a unit of the shared commands
  // (c4-editor-actions.js): the rename of an element, a deployment node, and a provided interface, each with the
  // first-rename rule that also gives a thing just added the id of its name; Change id… for an element with its dialog;
  // and the id the core would suggest instead of a refused one.

  // The parts of a UML view's layout entry that hold a thing's own entries (`layout.<view>.<part>.<…>`).
  const OWN_LAYOUT_PARTS = new Set(['positions', 'routes', 'lifelines']);

  /** The rename and id commands. `actions` is the shared context of createActions (state, dom, results, dialogs). */
  function createIdCommands(actions) {
    const { state, dom, ids, model, elementOf, nameOf, readOnlyReason, lockedProblem, missingElement, succeed, refuse,
      dispatch, cancelled, trackedDialog, onSubmit, showFieldProblem } = actions;
    const { placeholderName, modelWideWording } = editorParts().actionsShared;

    // ---- Renames -----------------------------------------------------------------------------

    /**
     * Renames an element, model-wide. A thing added on a canvas carries its placeholder ("New container",
     * `new-container`) until its first rename, which also gives it the id of the committed name, so the YAML a learner
     * hands in and the selectors they type read like the names (spec §4.10, final review I6; UML-view editing spec
     * §5.1, §14 D1). `wording: 'model-wide'` words the result for a canvas that shows only part of where the name
     * appears. Resolves `{ ok, elementId }`, with the new id when it changed.
     */
    function renameElement(elementId, name, { wording = null } = {}) {
      const problem = readOnlyReason() || missingElement(elementId);
      if (problem) return refuse(problem);
      const element = elementOf(elementId);
      return rename({
        oldName: nameOf(elementId), currentName: element.name, name, wording, idKey: 'elementId', id: elementId,
        renameCommand: (value) => ({ op: 'setElementField', elementId, field: 'name', value }),
        firstRename: (newName) => elementFirstRename(element, newName),
      });
    }

    /** Renames a deployment node, with the first-rename rule of a node. Resolves `{ ok, nodeId }`, with the new id when it changed. */
    function renameNode(environmentId, nodeId, name) {
      const environment = model() ? model().environments.get(environmentId) : null;
      const node = environment ? environment.nodes.get(nodeId) : null;
      const problem = readOnlyReason() || (node ? null : `Error: There is no node ${nodeId} in the environment ${environmentId}.`);
      if (problem) return refuse(problem);
      return rename({
        oldName: node.name, currentName: node.name, name, wording: null, idKey: 'nodeId', id: nodeId,
        renameCommand: (value) => ({ op: 'updateNode', environmentId, nodeId, field: 'name', value }),
        firstRename: (newName) => nodeFirstRename(environment, node, newName),
      });
    }

    /**
     * Renames a provided interface, with the first-rename rule of an interface; `wording` as for renameElement.
     * Resolves `{ ok, interfaceId }`, with the new id when it changed.
     */
    function renameInterface(interfaceId, name, { wording = null } = {}) {
      const declared = model() ? model().interfaces.get(interfaceId) || null : null;
      const problem = readOnlyReason() || (declared ? null : `Error: There is no interface ${interfaceId}.`);
      if (problem) return refuse(problem);
      return rename({
        oldName: declared.name, currentName: declared.name, name, wording, idKey: 'interfaceId', id: interfaceId,
        renameCommand: (value) => ({ op: 'updateInterface', interfaceId, field: 'name', value }),
        firstRename: (newName) => interfaceFirstRename(declared, newName),
      });
    }

    /**
     * Writes a rename as one undo step and announces it. `request`: `oldName` (as announced), `currentName` (as
     * written), the typed `name`, `wording`, `idKey` and `id` (the result's key for the thing's id, and that id),
     * `renameCommand(newName)` (the command that writes the name), and `firstRename(newName)` (`{ newId, command }` when
     * the first-rename rule gives the thing a new id, else null). An empty name is refused; the same name changes
     * nothing. The id change joins the rename in one batch, unless a lock holds the id (a tutorial's locked path):
     * then the name changes alone.
     */
    function rename({ oldName, currentName, name, wording, idKey, id, renameCommand, firstRename }) {
      const newName = String(name).trim();
      if (newName === '') return refuse(`Error: A name needs some text; ${oldName} keeps its name until you type one.`);
      if (newName === currentName) return { ok: true, unchanged: true };
      const nameOnly = renameCommand(newName);
      const idChange = firstRename(newName);
      const withId = idChange === null ? null : { op: 'batch', commands: [nameOnly, idChange.command] };
      const newId = withId !== null && !lockedProblem(withId) ? idChange.newId : null;
      const words = renameWords(oldName, newName, newId, wording);
      const result = dispatch(newId === null ? nameOnly : withId, words.label);
      return result.ok ? succeed(words.message, { [idKey]: newId === null ? id : newId }) : result;
    }

    /** The announcement and undo label of a rename: today's, or the model-wide ones (UML-view editing spec §5.1). */
    function renameWords(oldName, newName, newId, wording) {
      if (wording === 'model-wide') return modelWideWording.rename(oldName, newName, newId);
      return { message: `Renamed ${oldName} to ${newName}${newId === null ? '' : `; its id is now ${newId}`}.`, label: `Rename ${oldName}` };
    }

    // ---- The first-rename rule, once for each kind (UML-view editing spec §5.1, §14 D1) -------------------------
    // A rename also gives the thing the id the core would give a new thing of the new name when (1) it still has its
    // placeholder name and the id that name got, (2) nothing refers to it but its own layout entries, (3) the open view
    // is not inside it, and (4) no lock holds its id (asked in `rename`). Each returns `{ newId, command }` or null.

    function elementFirstRename(element, newName) {
      const placeholder = placeholderName(element.type, element.kind);
      if (element.name !== placeholder || !hasPlaceholderId(element.id, suggestedId(element, placeholder))) return null;
      const design = state.getDesign();
      if (!onlyOwnLayoutEntries(design, element) || C4.project(design, state.getView()).scopeId === element.id) return null;
      return idChange(element.id, suggestedId(element, newName), (newId) => ({ op: 'changeElementId', elementId: element.id, newId }));
    }

    /** A node: no other node of its environment links to it; no view lies inside a node, and its layout entries are its own. */
    function nodeFirstRename(environment, node, newName) {
      const placeholder = placeholderName('node', node.kind);
      if (node.name !== placeholder || !hasPlaceholderId(node.id, suggestedNodeId(environment, node, placeholder))) return null;
      const linked = [...environment.nodes.values()].some((other) => other.id !== node.id
        && other.relationships.some((link) => link.targetId === node.id));
      if (linked) return null;
      return idChange(node.id, suggestedNodeId(environment, node, newName),
        (newId) => ({ op: 'changeNodeId', environmentId: environment.id, nodeId: node.id, newId }));
    }

    /** An interface: no `uses` entry and no stored view selector names it, and the open view is not its description card. */
    function interfaceFirstRename(declared, newName) {
      const placeholder = placeholderName('interface');
      if (declared.name !== placeholder || !hasPlaceholderId(declared.id, suggestedInterfaceId(declared, placeholder))) return null;
      const design = state.getDesign();
      const named = C4.interfaceDependentsOf(design, declared.id).length > 0 || C4.interfaceSelectorsOf(design, declared.id).length > 0;
      const openView = C4.project(design, state.getView());
      const cardOpen = openView.type === 'interface' && String(openView.scopeId).toLowerCase() === declared.id.toLowerCase();
      if (named || cardOpen) return null;
      return idChange(declared.id, suggestedInterfaceId(declared, newName), (newId) => ({ op: 'changeInterfaceId', interfaceId: declared.id, newId }));
    }

    /** `{ newId, command }` for a suggested id that differs from the present one, else null (the id stays). */
    function idChange(id, newId, commandFor) {
      return newId === null || newId === id ? null : { newId, command: commandFor(newId) };
    }

    /**
     * True when `id` is the id a placeholder name gets: `placeholderId` (the core's suggestion for that name now, which
     * is numbered while the thing itself holds the plain id) without or with a number suffix (`new-node`, `new-node-2`).
     */
    function hasPlaceholderId(id, placeholderId) {
      if (placeholderId === null) return false;
      // A slug holds only letters, digits, and hyphens, so it reads literally in a pattern.
      return new RegExp(`^${placeholderId.replace(/-\d+$/, '')}(-\\d+)?$`).test(id);
    }

    /**
     * True when nothing names the element but its own layout entries: its position in a C4 view (`layout.<view>.<id>`),
     * and in a UML view its position, a stored route with an end at it, and its place in a lifeline order. A view key
     * that names it (`components of <id>`) refers to it, and so does every entry that names a part of it.
     */
    function onlyOwnLayoutEntries(design, element) {
      const pathKey = (dependent) => JSON.stringify(dependent.path);
      const ofParts = new Set(element.childIds.flatMap((childId) => C4.dependentsOf(design, childId)).map(pathKey));
      const isLayoutEntry = ({ kind, path }) => kind === 'layout' && (path.length === 3 || (path.length === 4 && OWN_LAYOUT_PARTS.has(path[2])));
      return C4.dependentsOf(design, element.id).every((dependent) => isLayoutEntry(dependent) && !ofParts.has(pathKey(dependent)));
    }

    function suggestedNodeId(environment, node, name) {
      const dryRun = C4.edit(state.getDesign(), { op: 'addNode', environmentId: environment.id, parentNodeId: node.parentId, name });
      return dryRun.error ? null : dryRun.selection.nodeId;
    }

    function suggestedInterfaceId(declared, name) {
      const dryRun = C4.edit(state.getDesign(), { op: 'addInterface', elementId: declared.providerId, name });
      return dryRun.error ? null : dryRun.selection.interfaceId;
    }

    // ---- Change id… --------------------------------------------------------------------------

    /**
     * Gives the element `newId` and rewrites every reference to it. A refused id is named with the core's reason
     * and a suggestion: the id the core would give an element of this type named like the typed text (spec §9.2).
     */
    function changeElementId(elementId, newId) {
      const problem = readOnlyReason() || missingElement(elementId);
      if (problem) return refuse(problem);
      const typed = String(newId).trim();
      const name = nameOf(elementId);
      if (typed === elementId) return succeed(`Kept the id ${elementId}.`, { unchanged: true });
      const dryRun = C4.edit(state.getDesign(), { op: 'changeElementId', elementId, newId: typed });
      if (dryRun.error) {
        const suggestion = suggestedId(elementOf(elementId), typed || name);
        const hint = suggestion && suggestion !== typed ? `; try ${suggestion}` : '';
        return refuse(`Error: ${dryRun.message}${hint}.`, dryRun.error);
      }
      const result = dispatch({ op: 'changeElementId', elementId, newId: typed }, `Change the id of ${name}`);
      return result.ok ? succeed(`Changed the id of ${name} from ${elementId} to ${typed}.`, { elementId: typed }) : result;
    }

    function suggestedId(element, text) {
      const dryRun = C4.edit(state.getDesign(), { op: 'addElement', parentId: element.parentId, type: element.type, name: text });
      return dryRun.error ? null : dryRun.selection.elementId;
    }

    /** The "Change id…" dialog: validates on submit, names the problem, and suggests a fix (spec §9.2). */
    function openChangeIdDialog(elementId, { returnFocus = null } = {}) {
      const problem = readOnlyReason() || missingElement(elementId);
      if (problem) return Promise.resolve(refuse(problem));
      const name = nameOf(elementId);
      const field = dom.el('input', { type: 'text', id: ids('change-id'), class: 'c4-editor__input', value: elementId,
        autocomplete: 'off', spellcheck: 'false', 'aria-describedby': `${ids('change-id-hint')} ${ids('change-id-problem')}` });
      const problemText = dom.el('p', { id: ids('change-id-problem'), class: 'c4-editor__field-problem c4-editor__field-problem--error',
        hidden: true });
      const body = dom.el('div', { class: 'c4-editor__fields' }, [
        dom.el('div', { class: 'c4-editor__field' }, [
          dom.el('label', { for: field.id, class: 'c4-editor__field-label', text: 'New id' }),
          dom.el('p', { id: ids('change-id-hint'), class: 'c4-editor__field-hint',
            text: `Ids start with a letter and use letters, digits, - or _. Every reference to ${name} changes with it.` }),
          field,
          problemText,
        ]),
      ]);
      const closed = trackedDialog(body, {
        title: `Change the id of ${name}`,
        actions: [{ label: 'Cancel', value: null }, { label: 'Change id', value: 'change', isDefault: true }],
        initialFocus: field,
        returnFocus,
      });
      field.select();
      const outcome = onSubmit(field, () => {
        const result = changeElementId(elementId, field.value);
        showFieldProblem(field, problemText, result.ok ? null : result.message);
        return result;
      });
      return closed.then((value) => (value === null ? cancelled(`Kept the id ${elementId}.`) : outcome.result));
    }

    return { renameElement, renameNode, renameInterface, changeElementId, openChangeIdDialog };
  }

  return { createIdCommands };
});
