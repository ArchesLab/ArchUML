(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../c4-core.js'));
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.outline = factory(root.ArchUMLC4);
  }
})(typeof self !== 'undefined' ? self : this, function (C4) {
  'use strict';

  // The editor's outline (spec §9.1 Outline, §9.2): a `role="tree"` of the model (people; systems › containers ›
  // components › code; interfaces; scenarios; deployment environments › nodes; decisions; requirements) with a filter field,
  // the tree keys of the WAI-ARIA tree pattern, type-ahead, Enter to open an item's view, and re-parenting by drag
  // with the item menu's "Move to…" as the single-pointer and keyboard alternative. It edits nothing itself:
  // Delete, rename, and Move to… are the actions module's commands (Ruling 5), and views and the selection belong
  // to the state controller. Collapsed branches render no items (spec §9.2 performance: lazy subtrees).

  const TYPE_WORDS = {
    person: 'person',
    system: 'software system',
    container: 'container',
    component: 'component',
    code: 'code element',
  };
  // The view in which an element is one of the members (spec §9.1: Enter opens the item's view).
  const ELEMENT_VIEW = {
    person: () => 'landscape',
    system: (element) => `context of ${element.id}`,
    container: (element) => `containers of ${element.parentId}`,
    component: (element) => `components of ${element.parentId}`,
    code: (element) => `code of ${element.parentId}`,
  };
  // Which outline item a view's scope is, by view type; the outline opens down to it when the view changes.
  const SCOPE_KEY = {
    context: (id) => elementKey(id),
    containers: (id) => elementKey(id),
    components: (id) => elementKey(id),
    code: (id) => elementKey(id),
    dynamic: (id) => `scenario:${id}`,
    deployment: (id) => `environment:${id}`,
  };
  // The element types an element can be re-parented into, by its own type (spec §4.10 containment).
  const PARENT_TYPE = { container: 'system', component: 'container', code: 'component' };
  const TYPE_AHEAD_RESET_MS = 500;
  const DRAG_THRESHOLD_PX = 5;
  // How long a finger must rest on an item before it drags instead of scrolling (the platform long-press time).
  const LONG_PRESS_MS = 500;

  /**
   * Creates the outline in `region` (the outline region's body). `options`: `state` (createEditorState), `dom` (the
   * DOM utilities), `actions` (createActions: Delete, rename, Move to…, and the item menu), `ids` (an idFactory),
   * `announce` (the editor's polite announcer; created in `region` when absent), `escape` (the editor's Escape
   * stack, which cancels a drag; created on `region` when absent), and the mount's `options` (`reveal: 'on-request'`
   * keeps the outline collapsed below the open view's scope until `showInside`, spec §9.3). Returns
   * `{ element, focus, showInside, destroy }`.
   */
  function createOutline(region, options) {
    const { state, dom, actions, ids } = options;
    const doc = region.ownerDocument;
    const listening = new AbortController();
    const ownEscape = options.escape ? null : dom.createEscapeStack(region);
    const escape = options.escape || ownEscape;
    const announce = options.announce || dom.createAnnouncer(region);
    let revealOnRequest = Boolean(options.options && options.options.reveal === 'on-request');
    const expanded = new Set();
    const typeAhead = { text: '', at: -Infinity };
    let index = new Map();
    let filterText = '';
    let renaming = null;
    let drag = null;
    let suppressClick = false;
    let rendering = false;
    let previousOrder = [];

    const filter = dom.el('input', {
      type: 'search', id: ids('outline-filter'), class: 'c4-editor__outline-filter-input', autocomplete: 'off', spellcheck: 'false',
    });
    const tree = dom.el('ul', { role: 'tree', id: ids('outline-tree'), class: 'c4-editor__outline-tree', 'aria-label': 'Model outline' });
    const emptyText = dom.el('p', { class: 'c4-editor__outline-empty', hidden: true });
    const element = dom.el('div', { class: 'c4-editor__outline' }, [
      dom.el('div', { class: 'c4-editor__outline-filter' }, [
        dom.el('label', { for: filter.id, class: 'c4-editor__outline-filter-label', text: 'Filter the outline' }),
        filter,
      ]),
      tree,
      emptyText,
    ]);
    region.appendChild(element);

    // ---- Model ---------------------------------------------------------------------------------

    function rebuildIndex() {
      const model = state.getDesign().model;
      index = model ? indexTree(outlineTree(model)) : new Map();
    }

    /** Opens every branch from the top down to `key`, and `key` itself when `inclusive`. */
    function openPathTo(key, { inclusive = false } = {}) {
      let current = index.get(key);
      if (!current) return;
      if (inclusive && current.node.children.length > 0) expanded.add(key);
      while (current.parentKey !== null) {
        expanded.add(current.parentKey);
        current = index.get(current.parentKey);
      }
    }

    function openPathToView() {
      const design = state.getDesign();
      if (!design.model) return;
      const view = C4.listViews(design).find((candidate) => candidate.selector === state.getView());
      const scopeKey = view && view.scopeId !== null && SCOPE_KEY[view.type] ? SCOPE_KEY[view.type](view.scopeId) : null;
      if (scopeKey) openPathTo(scopeKey, { inclusive: !revealOnRequest });
    }

    function selectedKey() {
      return keyOfSelection(state.getSelection());
    }

    // ---- Rendering -----------------------------------------------------------------------------

    /**
     * Draws the tree from the index. Focus inside the tree stays on the same item (or, when that item is gone, on
     * the item after it in the last drawing, else the one before it), and an in-place rename survives.
     */
    function render() {
      const focus = focusedTarget();
      if (focus && focus.key) openPathTo(focus.key);
      const visible = filterText === '' ? null : filteredKeys(filterText);
      const roots = [...index.values()].filter((entry) => entry.parentKey === null).map((entry) => entry.node);
      const counter = { next: 0 };
      rendering = true;
      tree.replaceChildren(...roots.filter((node) => isShown(node, visible)).map((node) => renderItem(node, visible, counter)));
      rendering = false;
      const order = itemsInOrder().map(keyOfItem);
      showEmptyState(order.length === 0, visible);
      restoreFocus(focus, order);
      previousOrder = order;
      updateTabStop();
    }

    function isShown(node, visible) {
      return visible === null || visible.has(node.key);
    }

    function renderItem(node, visible, counter) {
      counter.next += 1;
      const labelId = ids(`outline-item-${counter.next}`);
      const shownChildren = node.children.filter((child) => isShown(child, visible));
      const open = shownChildren.length > 0 && (visible !== null || expanded.has(node.key));
      const selected = node.selection !== null ? String(node.key === selectedKey()) : null;
      const item = dom.el('li', {
        role: 'treeitem',
        class: 'c4-editor__outline-item',
        tabindex: '-1',
        'data-outline-key': node.key,
        'aria-labelledby': labelId,
        'aria-describedby': `${labelId}-detail`,
        'aria-expanded': shownChildren.length > 0 ? String(open) : null,
        'aria-selected': selected,
      }, [
        dom.el('div', { class: 'c4-editor__outline-row' }, [
          dom.el('span', { class: shownChildren.length > 0 ? 'c4-editor__outline-twisty' : 'c4-editor__outline-spacer', 'aria-hidden': 'true' }),
          dom.el('span', { class: 'c4-editor__outline-text' }, [
            renaming && renaming.key === node.key ? renameField(node, labelId) : null,
            dom.el('span', { id: labelId, class: 'c4-editor__outline-label', hidden: Boolean(renaming && renaming.key === node.key),
              text: node.label }),
            dom.el('span', { id: `${labelId}-detail`, class: 'c4-editor__outline-detail', text: node.detail }),
          ]),
          node.elementId ? dom.el('button', {
            type: 'button', tabindex: '-1', class: 'c4-editor__outline-more', 'aria-label': `Actions for ${node.label}`, text: '⋯',
          }) : null,
        ]),
        open ? dom.el('ul', { role: 'group', class: 'c4-editor__outline-group' },
          shownChildren.map((child) => renderItem(child, visible, counter))) : null,
      ]);
      return item;
    }

    function showEmptyState(empty, visible) {
      tree.hidden = empty;
      emptyText.hidden = !empty;
      if (!empty) return;
      if (visible !== null) emptyText.textContent = `No items match "${filterText}".`;
      else if (state.getDesign().model === null) emptyText.textContent = 'The outline appears once the YAML can be read.';
      else emptyText.textContent = 'The model has nothing in it yet.';
    }

    /** The keys of the items that match `text` (by name or id, ignoring case) and of all their ancestors. */
    function filteredKeys(text) {
      const wanted = text.toLowerCase();
      const keys = new Set();
      index.forEach((entry) => {
        if (entry.node.selection === null || !matches(entry.node, wanted)) return;
        for (let current = entry; current; current = index.get(current.parentKey)) keys.add(current.node.key);
      });
      return keys;
    }

    function matchCount(text) {
      const wanted = text.toLowerCase();
      return [...index.values()].filter((entry) => entry.node.selection !== null && matches(entry.node, wanted)).length;
    }

    // ---- Items and focus -----------------------------------------------------------------------

    function itemsInOrder() {
      return [...tree.querySelectorAll('[role="treeitem"]')];
    }

    function keyOfItem(item) {
      return item.getAttribute('data-outline-key');
    }

    function itemOf(key) {
      return itemsInOrder().find((item) => keyOfItem(item) === key) || null;
    }

    function itemFor(target) {
      const item = target instanceof Element ? target.closest('[role="treeitem"]') : null;
      return item && tree.contains(item) ? item : null;
    }

    /** What has focus in the tree before a redraw: `{ key, inRename }`, or null when focus is elsewhere. */
    function focusedTarget() {
      const active = doc.activeElement;
      const item = active ? itemFor(active) : null;
      return item ? { key: keyOfItem(item), inRename: active.classList.contains('c4-editor__outline-rename') } : null;
    }

    /** When no item survives (the last one was deleted), focus stays in the outline, on the filter field. */
    function restoreFocus(focus, order) {
      if (!focus) return;
      const key = order.includes(focus.key) ? focus.key : survivingNeighbour(focus.key, order);
      const item = key ? itemOf(key) : null;
      if (!item) {
        filter.focus();
        return;
      }
      const field = focus.inRename && key === focus.key ? item.querySelector('.c4-editor__outline-rename') : null;
      (field || item).focus();
    }

    /** The item after `key` in the last drawing that is still drawn, else the nearest one before it. */
    function survivingNeighbour(key, order) {
      const at = previousOrder.indexOf(key);
      if (at === -1) return order[0] || null;
      const after = previousOrder.slice(at + 1).find((candidate) => order.includes(candidate));
      return after || previousOrder.slice(0, at).reverse().find((candidate) => order.includes(candidate)) || null;
    }

    /** One tab stop: the focused item, else the selected one, else the first. */
    function updateTabStop() {
      const items = itemsInOrder();
      const active = itemFor(doc.activeElement);
      const stop = active || items.find((item) => item.getAttribute('aria-selected') === 'true') || items[0];
      items.forEach((item) => item.setAttribute('tabindex', item === stop ? '0' : '-1'));
    }

    function focusItem(item) {
      if (!item) return;
      item.focus();
      updateTabStop();
    }

    function setExpanded(item, open) {
      const key = keyOfItem(item);
      if (open) expanded.add(key);
      else expanded.delete(key);
      if (filterText === '') render();
    }

    // ---- Activation ----------------------------------------------------------------------------

    /** Enter or a click: a category opens or closes; anything else opens its view and becomes the selection. */
    function activate(item) {
      const { node } = index.get(keyOfItem(item));
      if (node.selection === null) {
        setExpanded(item, item.getAttribute('aria-expanded') !== 'true');
        return;
      }
      if (node.view) state.openView(node.view);
      state.select(node.selection);
    }

    function openItemMenu(item, placement) {
      const { node } = index.get(keyOfItem(item));
      if (!node.elementId) return;
      actions.openElementMenu(node.elementId, Object.assign({ returnFocus: item }, placement));
    }

    // ---- Keyboard ------------------------------------------------------------------------------

    function onTreeKeydown(event) {
      const item = event.target;
      if (item.getAttribute('role') !== 'treeitem' || event.defaultPrevented) return;
      const handled = navigationKey(event, item) || commandKey(event, item) || typeAheadKey(event, item);
      if (handled) event.preventDefault();
    }

    function navigationKey(event, item) {
      if (event.altKey || event.ctrlKey || event.metaKey) return false;
      const items = itemsInOrder();
      const at = items.indexOf(item);
      const open = item.getAttribute('aria-expanded');
      switch (event.key) {
        case 'ArrowDown': focusItem(items[at + 1]); return true;
        case 'ArrowUp': focusItem(items[at - 1]); return true;
        case 'Home': focusItem(items[0]); return true;
        case 'End': focusItem(items[items.length - 1]); return true;
        case 'ArrowRight':
          if (open === 'false') setExpanded(item, true);
          else if (open === 'true') focusItem(item.querySelector('[role="treeitem"]'));
          return true;
        case 'ArrowLeft':
          // While filtering, every branch with matches stays open, so Left always moves to the parent.
          if (open === 'true' && filterText === '') setExpanded(item, false);
          else focusItem(itemFor(item.parentElement));
          return true;
        default: return false;
      }
    }

    function commandKey(event, item) {
      const { node } = index.get(keyOfItem(item));
      const plain = !event.altKey && !event.ctrlKey && !event.metaKey;
      if (event.key === 'Enter' && plain && !event.shiftKey) {
        activate(item);
        return true;
      }
      if (!node.elementId) return false;
      if ((event.key === 'F10' && event.shiftKey && plain) || (event.key === 'ContextMenu' && plain)) {
        openItemMenu(item, { anchor: item.querySelector('.c4-editor__outline-row') });
        return true;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && plain) {
        actions.deleteElement(node.elementId, { returnFocus: item });
        return true;
      }
      if (event.key === 'F2' && plain && !event.shiftKey) {
        startRename(node);
        return true;
      }
      return false;
    }

    /**
     * Printable characters move focus to the next item whose name starts with the characters typed within the
     * last half second; the same letter typed again cycles through the items starting with it (spec §9.2: letters
     * never act as shortcuts in the outline, so every one is consumed).
     */
    function typeAheadKey(event, item) {
      if (event.key.length !== 1 || event.key === ' ' || event.altKey || event.ctrlKey || event.metaKey) return false;
      typeAhead.text = event.timeStamp - typeAhead.at > TYPE_AHEAD_RESET_MS ? event.key : typeAhead.text + event.key;
      typeAhead.at = event.timeStamp;
      const cycling = [...typeAhead.text].every((character) => character === typeAhead.text[0]);
      const wanted = (cycling ? typeAhead.text[0] : typeAhead.text).toLowerCase();
      const items = itemsInOrder();
      const at = items.indexOf(item);
      // A new letter searches after the focused item; a longer prefix may still match the focused item itself.
      const start = cycling ? at + 1 : at;
      const ordered = items.slice(start).concat(items.slice(0, start));
      focusItem(ordered.find((candidate) => labelOf(candidate).toLowerCase().startsWith(wanted)));
      return true;
    }

    function labelOf(item) {
      return index.get(keyOfItem(item)).node.label;
    }

    // ---- Rename in place (F2) ------------------------------------------------------------------

    function startRename(node) {
      renaming = { key: node.key, elementId: node.elementId, label: node.label, value: node.label, problem: null };
      render();
      const field = itemOf(node.key).querySelector('.c4-editor__outline-rename');
      field.focus();
      field.select();
    }

    function renameField(node, labelId) {
      const problemId = `${labelId}-rename-problem`;
      const field = dom.el('input', {
        type: 'text',
        class: 'c4-editor__outline-rename',
        value: renaming.value,
        autocomplete: 'off',
        'aria-label': `Name of ${renaming.label}`,
        'aria-invalid': renaming.problem ? 'true' : null,
        'aria-describedby': renaming.problem ? problemId : null,
        on: { keydown: onRenameKeydown, input: onRenameInput, blur: onRenameBlur },
      });
      return [
        field,
        renaming.problem ? dom.el('span', { id: problemId, class: 'c4-editor__outline-rename-problem', text: renaming.problem }) : null,
      ];
    }

    function onRenameInput(event) {
      renaming.value = event.target.value;
    }

    function onRenameKeydown(event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        commitRename({ keepOpenOnRefusal: true });
      } else if (event.key === 'Escape') {
        event.preventDefault();
        endRename();
      }
    }

    function onRenameBlur() {
      if (!rendering && renaming) commitRename({ keepOpenOnRefusal: false });
    }

    /** Renames through the actions; a refusal stays in the field (Enter) or is only announced (focus left). */
    function commitRename({ keepOpenOnRefusal }) {
      const pending = renaming;
      renaming = null;
      const result = actions.renameElement(pending.elementId, pending.value);
      if (result.ok || !keepOpenOnRefusal) {
        if (result.unchanged || !result.ok) render();
        // A first name can also give the element its id (actions.renameElement); after Enter, focus stays on its item.
        else if (keepOpenOnRefusal && result.elementId !== pending.elementId) focusItem(itemOf(elementKey(result.elementId)));
        return;
      }
      renaming = Object.assign(pending, { problem: result.message });
      render();
    }

    function endRename() {
      const key = renaming.key;
      renaming = null;
      render();
      focusItem(itemOf(key));
    }

    // ---- Pointer -------------------------------------------------------------------------------

    function onTreeClick(event) {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      const item = itemFor(event.target);
      if (!item || event.target.closest('.c4-editor__outline-rename')) return;
      if (event.target.closest('.c4-editor__outline-more')) {
        openItemMenu(item, { anchor: event.target.closest('.c4-editor__outline-more') });
        return;
      }
      focusItem(item);
      if (event.target.closest('.c4-editor__outline-twisty')) setExpanded(item, item.getAttribute('aria-expanded') !== 'true');
      else activate(item);
    }

    function onTreeContextMenu(event) {
      // A touch long press also fires contextmenu; the press in progress decides between dragging and the menu.
      if (drag && drag.touch) {
        event.preventDefault();
        return;
      }
      const item = itemFor(event.target);
      if (!item || !index.get(keyOfItem(item)).node.elementId) return;
      event.preventDefault();
      focusItem(item);
      openItemMenu(item, { point: { x: event.clientX, y: event.clientY } });
    }

    // ---- Re-parent by drag (spec §9.2) ---------------------------------------------------------
    //
    // A drag has two halves. `reparentDrag` is the outline's own half: what is dragged, which items accept it, and
    // what a drop, a refused drop, or a cancel does. The interim drag session below it is pointer mechanics, which
    // Ruling 4's addendum gives to the shared drag session in c4-editor-drag.js (Task 6 part B). That module does not
    // exist yet. When it lands, delete the interim session and have onPointerDown start a shared session with
    // `reparentDrag(item)`; the descriptor stays. Until then this is integration debt (see the Task 7 report).

    /**
     * The re-parent drag of the element that `item` shows, or null when that element cannot change parents.
     * `accepts(target)` says whether a treeitem is one of its valid parents (the actions' `parentCandidates`);
     * `drop(target)` runs one `moveElementTo`; `refuse()` and `cancel()` change nothing and announce why.
     */
    function reparentDrag(item) {
      const { node } = index.get(keyOfItem(item));
      if (!node.elementId || !PARENT_TYPE[node.elementType]) return null;
      let parentIds = null;
      const elementIdOf = (target) => index.get(keyOfItem(target)).node.elementId;
      return {
        source: item,
        label: node.label,
        accepts(target) {
          parentIds = parentIds || new Set(actions.parentCandidates(node.elementId));
          return parentIds.has(elementIdOf(target));
        },
        drop(target) {
          actions.moveElementTo(node.elementId, elementIdOf(target));
        },
        refuse() {
          const parentWord = TYPE_WORDS[PARENT_TYPE[node.elementType]];
          announce(`${node.label} was not moved. Drop it on a ${parentWord}, or choose Move to… in its menu.`);
        },
        cancel() {
          announce(`Stopped moving ${node.label}; nothing changed.`);
        },
      };
    }

    // ---- Interim drag session (until c4-editor-drag.js, Task 6 part B) --------------------------

    /**
     * A press on an item whose element can change parents. A mouse or pen press becomes a drag once the pointer has
     * moved DRAG_THRESHOLD_PX. A finger must first hold still for LONG_PRESS_MS, so a quick swipe still scrolls the
     * outline; lifting it after the long press without moving opens the item's menu (the touch context menu).
     * Dropping on a valid parent moves the element; dropping anywhere else, Escape, or a cancelled pointer changes
     * nothing.
     */
    function onPointerDown(event) {
      suppressClick = false;
      if (!event.isPrimary || event.button !== 0 || drag) return;
      const item = itemFor(event.target);
      if (!item || event.target.closest('.c4-editor__outline-more, .c4-editor__outline-twisty, .c4-editor__outline-rename')) return;
      const subject = reparentDrag(item);
      if (!subject) return;
      const touch = event.pointerType === 'touch';
      drag = { pointerId: event.pointerId, subject, x: event.clientX, y: event.clientY, touch, active: false, moved: false,
        longPress: touch ? setTimeout(onLongPress, LONG_PRESS_MS) : null };
    }

    function onLongPress() {
      drag.longPress = null;
      // A redraw while the finger was down replaced the pressed item; there is nothing left to drag.
      if (!drag.subject.source.isConnected) drag = null;
      else beginDrag();
    }

    function onPointerMove(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const travelled = Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= DRAG_THRESHOLD_PX;
      if (!drag.active) {
        if (!travelled) return;
        // A finger that moves before the long press is scrolling, not dragging.
        if (drag.touch) {
          endDrag();
          return;
        }
        beginDrag();
      }
      if (travelled) drag.moved = true;
      moveGhost(event.clientX, event.clientY);
      markHover(dropTargetAt(event.clientX, event.clientY));
    }

    function beginDrag() {
      const { subject } = drag;
      drag.active = true;
      subject.source.setPointerCapture(drag.pointerId);
      subject.source.classList.add('c4-editor__outline-item--dragging');
      itemsInOrder().forEach((item) => {
        if (subject.accepts(item)) item.classList.add('c4-editor__outline-item--drop-target');
      });
      drag.ghost = dom.el('div', { class: 'c4-editor__outline-ghost c4-editor__outline-ghost--measuring', 'aria-hidden': 'true',
        text: subject.label });
      element.appendChild(drag.ghost);
      // A size container is the containing block of fixed boxes inside it, so measure where (0, 0) lands (without
      // the ghost's offset from the pointer, which the stylesheet sets).
      const origin = drag.ghost.getBoundingClientRect();
      drag.origin = { x: origin.left, y: origin.top };
      drag.ghost.classList.remove('c4-editor__outline-ghost--measuring');
      moveGhost(drag.x, drag.y);
      drag.escapeLayer = escape.push({ close: cancelDrag });
      if (drag.touch) guardTouch();
    }

    /**
     * Until the finger lifts, it drags the item and nothing else: it must not scroll the page (touch-action cannot
     * change mid-touch), and lifting it must not also count as a tap, whose click would close the menu a long press
     * opens. The guard outlives the drag session and ends with the touch itself.
     */
    function guardTouch() {
      const guard = new AbortController();
      const { signal } = guard;
      doc.addEventListener('touchmove', (event) => event.preventDefault(), { passive: false, signal });
      doc.addEventListener('touchend', (event) => {
        event.preventDefault();
        guard.abort();
      }, { passive: false, signal });
      doc.addEventListener('touchcancel', () => guard.abort(), { signal });
    }

    function moveGhost(x, y) {
      drag.ghost.style.setProperty('--c4-outline-ghost-x', `${x - drag.origin.x}px`);
      drag.ghost.style.setProperty('--c4-outline-ghost-y', `${y - drag.origin.y}px`);
    }

    /** The valid drop target under the pointer, as its treeitem, or null. */
    function dropTargetAt(x, y) {
      const item = itemFor(doc.elementFromPoint(x, y));
      return item && drag.subject.accepts(item) ? item : null;
    }

    function markHover(target) {
      itemsInOrder().forEach((item) => item.classList.toggle('c4-editor__outline-item--drop-hover', item === target));
    }

    function onPointerUp(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const finished = drag;
      if (!finished.active) {
        endDrag();
        return;
      }
      const target = finished.moved ? dropTargetAt(event.clientX, event.clientY) : null;
      endDrag();
      suppressClick = true;
      if (!finished.moved) {
        focusItem(finished.subject.source);
        openItemMenu(finished.subject.source, { point: { x: event.clientX, y: event.clientY } });
      } else if (target) {
        finished.subject.drop(target);
      } else {
        finished.subject.refuse();
      }
    }

    function cancelDrag() {
      const { subject } = drag;
      endDrag();
      suppressClick = true;
      subject.cancel();
    }

    function onPointerCancel(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (drag.active) cancelDrag();
      else endDrag();
    }

    /** Ends the press or drag in progress without acting on it: removes the ghost, the cues, and the Escape layer. */
    function endDrag() {
      clearTimeout(drag.longPress);
      if (drag.active) {
        const { source } = drag.subject;
        drag.escapeLayer.remove();
        drag.ghost.remove();
        if (source.hasPointerCapture(drag.pointerId)) source.releasePointerCapture(drag.pointerId);
        itemsInOrder().forEach((item) => item.classList.remove('c4-editor__outline-item--dragging',
          'c4-editor__outline-item--drop-target', 'c4-editor__outline-item--drop-hover'));
      }
      drag = null;
    }

    // ---- Filter --------------------------------------------------------------------------------

    function onFilterInput() {
      filterText = filter.value.trim();
      render();
      if (filterText === '') return;
      const count = matchCount(filterText);
      announce(count === 0 ? `No items match "${filterText}".`
        : `${count} ${count === 1 ? 'item matches' : 'items match'} "${filterText}".`);
    }

    function onFilterKeydown(event) {
      if (event.key === 'Escape' && filter.value !== '') {
        event.preventDefault();
        filter.value = '';
        onFilterInput();
      } else if (event.key === 'ArrowDown' && !tree.hidden) {
        event.preventDefault();
        focusItem(itemsInOrder()[0]);
      }
    }

    // ---- State events --------------------------------------------------------------------------

    function onText() {
      if (drag) endDrag();
      rebuildIndex();
      if (renaming && !index.has(renaming.key)) renaming = null;
      render();
    }

    function onView() {
      openPathToView();
      render();
    }

    function onSelection() {
      const key = selectedKey();
      if (key) openPathTo(key);
      render();
    }

    const { signal } = listening;
    tree.addEventListener('keydown', onTreeKeydown, { signal });
    tree.addEventListener('click', onTreeClick, { signal });
    tree.addEventListener('contextmenu', onTreeContextMenu, { signal });
    tree.addEventListener('pointerdown', onPointerDown, { signal });
    tree.addEventListener('pointermove', onPointerMove, { signal });
    tree.addEventListener('pointerup', onPointerUp, { signal });
    tree.addEventListener('pointercancel', onPointerCancel, { signal });
    filter.addEventListener('input', onFilterInput, { signal });
    filter.addEventListener('keydown', onFilterKeydown, { signal });
    const unsubscribe = [state.on('text', onText), state.on('view', onView), state.on('selection', onSelection)];

    rebuildIndex();
    index.forEach((entry, key) => {
      if (entry.parentKey === null) expanded.add(key);
    });
    openPathToView();
    if (selectedKey()) openPathTo(selectedKey());
    render();

    return {
      element,
      /** Moves focus into the outline: the tree's tab stop, or the filter field when the tree is empty. */
      focus() {
        const stop = tree.querySelector('[role="treeitem"][tabindex="0"]');
        (stop || filter).focus();
      },
      /**
       * "Show inside" (spec §9.3, `reveal: 'on-request'`): opens the outline below the open view's scope, and from
       * now on each view's scope opens as with `reveal: 'all'`. Focus stays where it is.
       */
      showInside() {
        revealOnRequest = false;
        openPathToView();
        render();
      },
      /** Removes the outline, its listeners, and any drag in progress. */
      destroy() {
        if (drag) endDrag();
        listening.abort();
        unsubscribe.forEach((stop) => stop());
        if (ownEscape) ownEscape.dispose();
        element.remove();
      },
    };
  }

  // ---- The outline's items (DOM-free) --------------------------------------------------------

  /**
   * The outline's items for a normalized model, as category items in spec §9.1's order, each with `children`. An
   * item is `{ key, id, label, detail, children, selection, view, elementId?, elementType? }` (`id` is the model id
   * the filter also matches, null for a category): `selection` is what
   * Enter selects (null for a category), and `view` the selector Enter opens (null when the item has no view of its
   * own). Empty categories are left out.
   */
  function outlineTree(model) {
    const elements = [...model.elements.values()];
    const elementItem = (element) => ({
      key: elementKey(element.id),
      id: element.id,
      label: element.name || element.id,
      detail: element.external ? `external ${TYPE_WORDS[element.type]}` : TYPE_WORDS[element.type],
      selection: { elementId: element.id },
      view: ELEMENT_VIEW[element.type](element),
      elementId: element.id,
      elementType: element.type,
      children: element.childIds.map((id) => elementItem(model.elements.get(id))),
    });
    const nodeItem = (environment, node) => ({
      key: `node:${environment.id}/${node.id}`,
      id: node.id,
      label: node.name || node.id,
      detail: node.kind === 'infrastructure' ? 'infrastructure node' : 'deployment node',
      selection: { environmentId: environment.id, nodeId: node.id },
      view: `deployment ${environment.id}`,
      children: node.childIds.map((id) => nodeItem(environment, environment.nodes.get(id))),
    });
    const categories = [
      category('people', 'People', elements.filter((element) => element.type === 'person' && element.parentId === null).map(elementItem)),
      category('systems', 'Software systems', elements.filter((element) => element.type === 'system').map(elementItem)),
      // One top-level branch, not under each provider (spec §9.1): an interface is named with its provider, and Enter
      // opens its description card and selects it, which shows its form in the inspector.
      category('interfaces', 'Interfaces', [...model.interfaces.values()].map((declared) => ({
        key: interfaceKey(declared.id), id: declared.id,
        label: `${declared.name || declared.id} (${providerName(model, declared)})`,
        detail: declared.shorthand ? 'interface, syntax only' : 'interface',
        selection: { interfaceId: declared.id }, view: `interface ${declared.id}`, children: [],
      }))),
      category('scenarios', 'Scenarios', [...model.scenarios.values()].map((scenario) => ({
        key: `scenario:${scenario.id}`, id: scenario.id, label: scenario.title || scenario.id, detail: 'scenario',
        selection: { scenarioId: scenario.id }, view: `dynamic ${scenario.id}`, children: [],
      }))),
      category('environments', 'Deployment environments', [...model.environments.values()].map((environment) => ({
        key: `environment:${environment.id}`, id: environment.id, label: environment.name || environment.id, detail: 'deployment environment',
        selection: { environmentId: environment.id }, view: `deployment ${environment.id}`,
        children: environment.rootNodeIds.map((id) => nodeItem(environment, environment.nodes.get(id))),
      }))),
      category('decisions', 'Decisions', [...model.decisions.values()].map((decision) => ({
        key: `decision:${decision.id}`, id: decision.id, label: decision.title || decision.id,
        detail: decision.status ? `decision, ${decision.status}` : 'decision',
        selection: { decisionId: decision.id }, view: null, children: [],
      }))),
      category('requirements', 'Requirements', [...model.requirements.values()].map((requirement) => ({
        key: `requirement:${requirement.id}`, id: requirement.id, label: requirement.id, detail: requirement.text || 'requirement',
        selection: { requirementId: requirement.id }, view: null, children: [],
      }))),
    ];
    return categories.filter((item) => item.children.length > 0);
  }

  function category(name, label, children) {
    return { key: `category:${name}`, id: null, label, detail: `${children.length} ${children.length === 1 ? 'item' : 'items'}`,
      selection: null, view: null, children };
  }

  /** `key → { node, parentKey }` for every item of `items` and their descendants. */
  function indexTree(items) {
    const index = new Map();
    const visit = (node, parentKey) => {
      index.set(node.key, { node, parentKey });
      node.children.forEach((child) => visit(child, node.key));
    };
    items.forEach((item) => visit(item, null));
    return index;
  }

  function elementKey(id) {
    return `element:${id}`;
  }

  function providerName(model, declared) {
    const provider = model.elements.get(declared.providerId);
    return provider.name || provider.id;
  }

  function interfaceKey(id) {
    return `interface:${id}`;
  }

  /** The key of the item a state selection names, or null (a relationship has no outline item). */
  function keyOfSelection(selection) {
    if (!selection) return null;
    if (selection.interfaceId) return interfaceKey(selection.interfaceId);
    if (selection.nodeId) return `node:${selection.environmentId}/${selection.nodeId}`;
    if (selection.elementId) return elementKey(selection.elementId);
    if (selection.scenarioId) return `scenario:${selection.scenarioId}`;
    if (selection.environmentId) return `environment:${selection.environmentId}`;
    if (selection.decisionId) return `decision:${selection.decisionId}`;
    if (selection.requirementId) return `requirement:${selection.requirementId}`;
    return null;
  }

  function matches(node, wanted) {
    return node.label.toLowerCase().includes(wanted) || (node.id !== null && node.id.toLowerCase().includes(wanted));
  }

  return { createOutline: createOutline, outlineTree: outlineTree };
});
