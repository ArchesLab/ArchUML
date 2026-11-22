(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.lists = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The generic list editor of the C4 editor (spec §9.1, §9.2 "Reorder list items"): an ordered list of rows that
  // the caller fills, reordered by dragging a row by its handle (the default) or with Move up / Move down in the row's
  // menu (the single-pointer and keyboard alternative, WCAG 2.5.7), with Remove in the same menu, and every result
  // announced with the item's position. It owns no model knowledge: the caller writes each move or removal (one
  // command, one undo step) and re-renders; the list asks the caller to put focus back on the moved row by its key.

  const DRAG_THRESHOLD_PX = 4;

  /**
   * Builds one list. `options`:
   * - `dom`, `ids`, `announce`: the editor's DOM utilities, id factory, and polite announcer;
   * - `openMenu(spec)`: the shared menu builder (`actions.openMenu`);
   * - `name`: a key, unique in the editor, for ids and focus keys; `label`: the list's accessible name;
   * - `itemName`: the lower-case word for one item ("responsibility"), used in labels and announcements;
   * - `itemLabel(index)` (optional): the item's name when "<itemName> <position>" would repeat another list's, such as
   *   "step 1 of branch 2 of step 3" in a nested step list;
   * - `items`: the items; `renderRow(item, index)`: the row's content (a Node);
   * - `onMove(from, to)` (optional; without it rows cannot be reordered) and `onRemove(index)` (optional): write the
   *   change and return whether it was made;
   * - `extraItems(index)` (optional): more row-menu commands after Move and Remove, as `{ label, unavailable, run }`
   *   (the shared menu's item shape), such as "Change interface id…";
   * - `locked`: a reason ("Locked: …") that makes every row read-only, or null; `rowLocked(index)`: the same per row;
   * - `requestFocus(key)`: asks the caller to focus the control with that `data-c4-focus-key` after it re-renders;
   * - `emptyFocusKey`: where focus goes when the last item is removed.
   * Returns `{ element, menuKey(index), destroy() }`.
   */
  function createListEditor(options) {
    const { dom, ids, announce, name, itemName, items } = options;
    const canMove = typeof options.onMove === 'function' && !options.locked && items.length > 1;
    const canRemove = typeof options.onRemove === 'function' && !options.locked;
    const rowLocked = options.rowLocked || (() => null);
    const extraItems = options.extraItems || (() => []);
    const listId = ids(`${name}-list`);
    const nameOf = options.itemLabel || ((index) => `${itemName} ${index + 1}`);
    const capitalizedNameOf = (index) => nameOf(index).charAt(0).toUpperCase() + nameOf(index).slice(1);
    const menuKey = (index) => `${name}-${index}-menu`;
    let drag = null;

    const rows = items.map((item, index) => {
      const content = dom.el('div', { class: 'c4-editor__list-content' }, options.renderRow(item, index));
      const handle = canMove && !rowLocked(index)
        ? dom.el('span', { class: 'c4-editor__list-handle', 'data-c4-drag-handle': '', 'aria-hidden': 'true',
          on: { pointerdown: (event) => startDrag(event, index) } }, '⠿')
        : null;
      const menuButton = canMove || canRemove || extraItems(index).length > 0
        ? dom.el('button', { type: 'button', class: 'c4-editor__button c4-editor__list-menu', 'aria-haspopup': 'menu',
          'aria-label': `Actions for ${nameOf(index)}`, 'data-c4-focus-key': menuKey(index),
          on: { click: (event) => openRowMenu(index, event.currentTarget) } }, '⋯')
        : null;
      return dom.el('li', { class: 'c4-editor__list-row', 'data-c4-index': String(index) }, [handle, content, menuButton]);
    });
    const element = dom.el('ol', { id: listId, class: 'c4-editor__list', 'aria-label': options.label }, rows);

    // ---- Row menu (the single-pointer and keyboard alternative) ----------------------------------

    function openRowMenu(index, button) {
      const reason = options.locked || rowLocked(index);
      const moveItems = typeof options.onMove === 'function' ? [
        { label: 'Move up', unavailable: reason || (index === 0 ? `${capitalizedNameOf(index)} is already first.` : null),
          run: () => move(index, index - 1) },
        { label: 'Move down', unavailable: reason || (index === items.length - 1 ? `${capitalizedNameOf(index)} is already last.` : null),
          run: () => move(index, index + 1) },
      ] : [];
      const removeItems = typeof options.onRemove === 'function' ? [{ label: 'Remove', unavailable: reason, run: () => remove(index) }] : [];
      options.openMenu({
        label: `Actions for ${nameOf(index)}`,
        groups: [{ label: null, items: moveItems.concat(removeItems, extraItems(index)) }],
        placement: { anchor: button, returnFocus: button },
      });
    }

    function move(from, to) {
      if (!options.onMove(from, to)) return;
      announce(`Moved ${nameOf(from)} to position ${to + 1} of ${items.length}.`);
      options.requestFocus(menuKey(to));
    }

    function remove(index) {
      if (!options.onRemove(index)) return;
      announce(`Removed ${nameOf(index)}.`);
      const remaining = items.length - 1;
      options.requestFocus(remaining === 0 ? options.emptyFocusKey : menuKey(Math.min(index, remaining - 1)));
    }

    // ---- Dragging a row by its handle (the default) ------------------------------------------------

    /**
     * A drag starts on the handle's pointer down, shows the row following the pointer and the place it would land,
     * acts on pointer up (WCAG 2.5.2), and is cancelled by Escape or by a release where it started.
     */
    function startDrag(event, index) {
      if (event.button !== 0 || drag) return;
      event.preventDefault();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      drag = { index, target: index, startY: event.clientY, moved: false, handle, pointerId: event.pointerId };
      handle.addEventListener('pointermove', onDragMove);
      handle.addEventListener('pointerup', onDragEnd);
      handle.addEventListener('pointercancel', onDragCancel);
      handle.ownerDocument.addEventListener('keydown', onDragKeydown, true);
    }

    function onDragMove(event) {
      const offset = event.clientY - drag.startY;
      if (!drag.moved && Math.abs(offset) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      rows[drag.index].classList.add('c4-editor__list-row--dragging');
      rows[drag.index].style.setProperty('--c4-drag-offset', `${offset}px`);
      drag.target = dropIndex(event.clientY);
      rows.forEach((row, index) => {
        row.classList.toggle('c4-editor__list-row--drop-before', index === drag.target && drag.target < drag.index);
        row.classList.toggle('c4-editor__list-row--drop-after', index === drag.target && drag.target > drag.index);
      });
    }

    /** The index the dragged row would take: the number of other rows whose middle lies above the pointer. */
    function dropIndex(clientY) {
      return rows.filter((row, index) => {
        if (index === drag.index) return false;
        const box = row.getBoundingClientRect();
        return box.top + box.height / 2 < clientY;
      }).length;
    }

    function onDragEnd() {
      const { index, target, moved } = drag;
      endDrag();
      if (!moved) return;
      if (target === index) {
        announceCancelled(index);
        return;
      }
      move(index, target);
    }

    function onDragKeydown(event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      const { index } = drag;
      endDrag();
      announceCancelled(index);
    }

    function onDragCancel() {
      endDrag();
    }

    function announceCancelled(index) {
      announce(`Move canceled; ${nameOf(index)} stays at position ${index + 1} of ${items.length}.`);
    }

    function endDrag() {
      if (!drag) return;
      const { handle, pointerId } = drag;
      handle.removeEventListener('pointermove', onDragMove);
      handle.removeEventListener('pointerup', onDragEnd);
      handle.removeEventListener('pointercancel', onDragCancel);
      handle.ownerDocument.removeEventListener('keydown', onDragKeydown, true);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      rows.forEach((row) => {
        row.classList.remove('c4-editor__list-row--dragging', 'c4-editor__list-row--drop-before', 'c4-editor__list-row--drop-after');
        row.style.removeProperty('--c4-drag-offset');
      });
      drag = null;
    }

    return { element, menuKey, destroy: endDrag };
  }

  return { createListEditor: createListEditor };
});
