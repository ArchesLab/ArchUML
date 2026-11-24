(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../c4-core.js'), function () {
      return { actionsShared: require('./c4-editor-actions-shared.js') };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.actionsElements = factory(root.ArchUMLC4, function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (C4, editorParts) {
  'use strict';

  // Element commands (spec §9.2), a unit of the shared commands (c4-editor-actions.js): Delete with confirmation,
  // Move to… another parent, pinning a position, a text edited in place (ED-12), Zoom in, and the element's context
  // menus. Renaming and Change id… are in c4-editor-actions-ids.js.

  /**
   * The element commands. `actions` is the shared context of createActions (state, dom, menus, reading the model,
   * results, dialogs) with the commands of the canvas unit (where a pin is drawn) and the id unit (Change id…).
   */
  // The element texts editElementText writes with setElementField (a responsibility goes through updateResponsibility).
  const ELEMENT_TEXT_FIELDS = ['description', 'technology'];

  function createElementCommands(actions) {
    const { state, dom, host, menus, announce, model, elementOf, nameOf, readOnlyReason, lockedProblem, missingElement,
      succeed, refuse, dispatch, unopened, finish, trackedDialog, isDestroyed, drawnCorners, landingOf, openChangeIdDialog } = actions;
    const { PARENT_TYPE, CHILD_VIEW, TYPE_NAMES, elementName, namesakeNotes, plural, modelWideWording } = editorParts().actionsShared;

    /**
     * Deletes an element after `host.confirm` (or the editor's own dialog) has listed every reference that goes
     * with it (spec §4.10, §9.2). `wording: 'model-wide'` words the result for a canvas that shows only part of the
     * model (UML-view editing spec §5.1). Resolves `{ ok, cancelled?, removed? }`.
     */
    async function deleteElement(elementId, { returnFocus = null, wording = null } = {}) {
      const command = { op: 'deleteElement', elementId };
      const problem = readOnlyReason() || missingElement(elementId);
      if (problem) return refuse(problem);
      const locked = lockedProblem(command);
      if (locked) return refuse(locked, 'locked');
      const name = nameOf(elementId);
      const dependents = C4.dependentsOf(state.getDesign(), elementId);
      const confirmed = await confirm(deleteRequest(elementOf(elementId), dependents, returnFocus));
      if (isDestroyed()) return { ok: false, cancelled: true };
      if (!confirmed) {
        announce(`Kept ${name}.`);
        return { ok: false, cancelled: true };
      }
      const count = dependents.length;
      const words = wording === 'model-wide' ? modelWideWording.elementDeletion(name, count) : {
        message: count === 0 ? `Deleted ${name}.` : `Deleted ${name} and ${plural(count, 'reference')} to it.`,
        label: `Delete ${name}`,
      };
      const result = dispatch(command, words.label);
      return result.ok ? succeed(words.message, { removed: count }) : result;
    }

    function deleteRequest(element, dependents, trigger) {
      const name = element.name || element.id;
      const inside = element.childIds.length > 0 ? ' and everything inside it' : '';
      const references = dependents.length === 1 ? 'this reference' : `these ${dependents.length} references`;
      const lead = dependents.length === 0
        ? `${name}${inside} will be removed.`
        : `${name}${inside} will be removed, together with ${references} to it:`;
      const details = dependents.map((dependent) => dependent.label);
      const message = [lead].concat(details.map((detail) => `• ${detail}`), ['You can undo this.']).join('\n');
      return { title: `Delete ${name}?`, message, lead, details, confirmLabel: 'Delete', cancelLabel: 'Cancel', trigger };
    }

    /** `host.confirm(request)`, or a labelled modal dialog in the root that starts on Cancel. */
    function confirm(request) {
      if (typeof host.confirm === 'function') return Promise.resolve(host.confirm(request)).then(Boolean);
      const body = dom.el('div', { class: 'c4-editor__confirm' }, [
        dom.el('p', { text: request.lead }),
        request.details.length === 0 ? null
          : dom.el('ul', { class: 'c4-editor__confirm-list' }, request.details.map((detail) => dom.el('li', { text: detail }))),
        dom.el('p', { text: 'You can undo this.' }),
      ]);
      return trackedDialog(body, {
        title: request.title,
        actions: [{ label: request.cancelLabel, value: false, isDefault: true }, { label: request.confirmLabel, value: true }],
        returnFocus: request.trigger,
      }).then((value) => value === true);
    }

    /** The elements `elementId` may move into, in the model's order: those of its parent's type, except its parent. */
    function parentCandidates(elementId) {
      const element = elementOf(elementId);
      const parentType = element ? PARENT_TYPE[element.type] : undefined;
      if (!parentType) return [];
      return [...model().elements.values()]
        .filter((candidate) => candidate.type === parentType && candidate.id !== element.parentId)
        .map((candidate) => candidate.id);
    }

    function moveElementTo(elementId, newParentId) {
      const problem = readOnlyReason() || missingElement(elementId) || missingElement(newParentId);
      if (problem) return refuse(problem);
      const name = nameOf(elementId);
      const result = dispatch({ op: 'moveElement', elementId, newParentId }, `Move ${name}`);
      return result.ok ? succeed(`Moved ${name} into ${nameOf(newParentId)}.`) : result;
    }

    /**
     * Pins the element's box with its top-left corner at `x`, `y` in the layout of the view `viewKey` (a drag, Move…,
     * M, or the Position controls; spec §9.2), as one undo step, and announces where the element is drawn: `how` says
     * how it moved ("up by 10"; by default "to x, y").
     */
    function pinElement(elementId, { viewKey, x, y, how }) {
      const problem = readOnlyReason() || missingElement(elementId);
      if (problem) return refuse(problem);
      const name = nameOf(elementId);
      const pin = [Math.round(x), Math.round(y)];
      const before = drawnCorners();
      const result = dispatch({ op: 'pinPosition', viewKey, elementId, x: pin[0], y: pin[1] }, `Move ${name}`);
      if (!result.ok) return result;
      const landing = landingOf(elementId, pin, before);
      return succeed(`Moved ${name} ${how || `to ${pin[0]}, ${pin[1]}`}${landing.nudged}; position pinned.${landing.madeRoom}`);
    }

    /**
     * Writes one text of an element, edited in place on the canvas (ED-12): `part` is 'description', 'technology', or
     * `{ responsibility: index }`. One undo step with the inspector's label; an empty description or technology removes
     * the field (as the inspector's fields do), an empty responsibility is refused. Unchanged text writes nothing.
     * Resolves `{ ok, unchanged? }`; a refusal (read-only, a lock, the core's) is announced with its reason.
     */
    function editElementText(elementId, part, value) {
      const problem = readOnlyReason() || missingElement(elementId);
      if (problem) return refuse(problem);
      const element = elementOf(elementId);
      const name = nameOf(elementId);
      const text = String(value).trim();
      if (typeof part === 'object' && part !== null) {
        const index = part.responsibility;
        const number = index + 1;
        const current = element.responsibilities[index];
        if (!current) return refuse(`Error: ${name} has no responsibility ${number}.`);
        if (text === '') return refuse(`Error: A responsibility needs some text; remove responsibility ${number} in the inspector instead.`);
        if (text === current.text) return { ok: true, unchanged: true };
        const result = dispatch({ op: 'updateResponsibility', elementId, index, text }, `Edit a responsibility of ${name}`);
        return result.ok ? succeed(`Changed responsibility ${number} of ${name}.`) : result;
      }
      if (!ELEMENT_TEXT_FIELDS.includes(part)) return refuse(`Error: ${part} is not a text of an element.`);
      const written = text === '' ? null : text;
      if (written === (element[part] || null)) return { ok: true, unchanged: true };
      const result = dispatch({ op: 'setElementField', elementId, field: part, value: written }, `Edit the ${part} of ${name}`);
      if (!result.ok) return result;
      return succeed(written === null ? `Removed the ${part} of ${name}.` : `Changed the ${part} of ${name}.`);
    }

    /** Opens the view one level inside the element; the view change is announced by whoever announces views. */
    function zoomIn(elementId) {
      const element = elementOf(elementId);
      if (!element) return refuse(missingElement(elementId));
      if (!CHILD_VIEW[element.type]) return refuse(`Error: A ${TYPE_NAMES[element.type]} has no view inside it.`);
      const result = state.openView(`${CHILD_VIEW[element.type]} of ${elementId}`);
      return result.ok ? { ok: true, selector: result.selector } : refuse(`Error: ${result.problem.message}`);
    }

    // ---- Menus -------------------------------------------------------------------------------

    /**
     * The context menu of an element (spec §9.2): Move… and Add relationship (only when the opener passes
     * `onMove` / `onAddRelationship`, the canvas's own modes), Move to…, Zoom in, Change id…, and Delete.
     * `placement`: `anchor` or `point` (client coordinates), `returnFocus`, and `onDone(result)` after a command.
     * Every menu opener returns the menu's handle `{ element, close }`, or null (announced) when it cannot open.
     */
    function openElementMenu(elementId, placement = {}) {
      const element = elementOf(elementId);
      if (!element) return unopened(missingElement(elementId));
      const reason = readOnlyReason();
      const run = (command) => (context) => finish(placement, command(context));
      const items = [];
      if (placement.onMove) items.push({ label: 'Move…', unavailable: reason, run: () => placement.onMove(elementId) });
      if (placement.onAddRelationship) {
        items.push({ label: 'Add relationship', unavailable: reason, run: () => placement.onAddRelationship(elementId) });
      }
      if (PARENT_TYPE[element.type]) {
        items.push({ label: 'Move to…', unavailable: reason || noParentReason(element),
          run: (context) => openMoveToMenu(elementId, Object.assign({}, placement, context)) });
      }
      if (CHILD_VIEW[element.type]) items.push({ label: 'Zoom in', run: run(() => zoomIn(elementId)) });
      items.push({ label: 'Change id…', unavailable: reason, run: run((context) => openChangeIdDialog(elementId, context)) });
      items.push({ label: 'Delete', unavailable: reason, run: run((context) => deleteElement(elementId, context)) });
      return menus.open({ label: `Actions for ${element.name || elementId}`, groups: [{ label: null, items }], placement, message: reason });
    }

    function noParentReason(element) {
      return parentCandidates(element.id).length > 0 ? null
        : `Error: There is no other ${TYPE_NAMES[PARENT_TYPE[element.type]]} to move ${element.name || element.id} into.`;
    }

    /** The menu of the elements `elementId` can move into, grouped by their own parent. */
    function openMoveToMenu(elementId, placement = {}) {
      const current = model();
      const groups = [];
      parentCandidates(elementId).forEach((id) => {
        const parentId = current.elements.get(id).parentId;
        const label = parentId === null ? null : elementName(current, parentId);
        let group = groups.find((candidate) => candidate.key === parentId);
        if (!group) groups.push(group = { key: parentId, label, ids: [], items: [] });
        group.ids.push(id);
      });
      groups.forEach((group) => {
        const notes = namesakeNotes(current, group.ids);
        group.items = group.ids.map((id) => ({ label: elementName(current, id), note: notes.get(id),
          run: () => finish(placement, moveElementTo(elementId, id)) }));
      });
      return menus.open({ label: `Move ${nameOf(elementId)} into`, groups, placement });
    }

    return { deleteElement, parentCandidates, moveElementTo, pinElement, editElementText, zoomIn, openElementMenu, openMoveToMenu };
  }

  return { createElementCommands };
});
