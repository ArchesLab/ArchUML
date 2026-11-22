(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.dom = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Small DOM helpers shared by every C4 editor module (spec §9.1, §9.2).
  // Several editors can share a page, so nothing here keeps module-level state: every helper
  // takes the element it works in, and all state lives in the closures it returns.
  // Text only ever reaches the DOM through text nodes or textContent, never through markup.

  const LIVE_REGION_DELAY_MS = 50;
  const POPOVER_HIDE_DELAY_MS = 300;
  const ID_PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
  const ID_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
  // Attributes that would let a string become script, markup, or inline presentation.
  const FORBIDDEN_ATTRIBUTES = new Set(['style', 'innerhtml', 'outerhtml', 'srcdoc']);
  const FIELD_SELECTOR = 'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"]';

  // ---- Elements ------------------------------------------------------------------------------

  /**
   * Creates `<tag>` with `attrs` and `children`.
   * attrs: `text` sets textContent; `on` maps event names to listeners; `true` sets an empty
   * attribute; null, undefined, and false are skipped. Event-handler attributes (`on…`), `style`,
   * and markup properties throw a TypeError.
   * children: Nodes, strings or numbers (inserted as text nodes), nested arrays; null, undefined,
   * and booleans are skipped.
   */
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs || {})) {
      if (name === 'text') {
        if (value != null) node.textContent = String(value);
      } else if (name === 'on') {
        for (const [type, listener] of Object.entries(value || {})) node.addEventListener(type, listener);
      } else {
        assertSafeAttribute(name);
        if (value === true) node.setAttribute(name, '');
        else if (value != null && value !== false) node.setAttribute(name, String(value));
      }
    }
    appendChildren(node, children);
    return node;
  }

  function assertSafeAttribute(name) {
    const lower = name.toLowerCase();
    if (lower.startsWith('on') || FORBIDDEN_ATTRIBUTES.has(lower)) {
      throw new TypeError('el(): the attribute "' + name + '" is not allowed; use `on` for listeners and CSS classes for presentation');
    }
  }

  function appendChildren(node, children) {
    if (children == null || typeof children === 'boolean') return;
    if (Array.isArray(children)) {
      for (const child of children) appendChildren(node, child);
    } else if (typeof children === 'string' || typeof children === 'number') {
      node.appendChild(node.ownerDocument.createTextNode(String(children)));
    } else {
      node.appendChild(children);
    }
  }

  /**
   * Returns `id(name)`, which gives `<instanceId>-<name>`: the same id for the same name within
   * one editor, and different ids in editors with different instance ids.
   */
  function idFactory(instanceId) {
    if (typeof instanceId !== 'string' || !ID_PREFIX_PATTERN.test(instanceId)) {
      throw new TypeError('idFactory(): the instance id must start with a letter and use letters, digits, - or _');
    }
    return function id(name) {
      if (typeof name !== 'string' || !ID_NAME_PATTERN.test(name)) {
        throw new TypeError('id(): the name must use letters, digits, - or _');
      }
      return instanceId + '-' + name;
    };
  }

  // ---- Announcements -------------------------------------------------------------------------

  /**
   * Adds a polite live region to `root` and returns `announce(message)`. Each call clears the
   * region and writes the message 50 ms later, so a repeated message is spoken again.
   */
  function createAnnouncer(root) {
    const region = el('div', {
      class: 'c4-editor__live c4-editor__sr-only',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true',
    });
    root.appendChild(region);
    const view = root.ownerDocument.defaultView;
    let pending = null;
    return function announce(message) {
      view.clearTimeout(pending);
      region.textContent = '';
      pending = view.setTimeout(function () {
        pending = null;
        region.textContent = String(message);
      }, LIVE_REGION_DELAY_MS);
    };
  }

  // ---- Escape --------------------------------------------------------------------------------

  /**
   * Escape handling for the editor-wide layers (spec §9.2: menu, Move, full screen, selection).
   * `push({ close(event) })` adds a layer and returns `{ remove() }`. Each Escape pressed inside
   * `root` closes only the innermost layer and calls preventDefault; an Escape some inner widget
   * already prevented is ignored. Popovers and dialogs handle Escape on their own elements, which
   * the event reaches first, so they always close before any layer here.
   */
  function createEscapeStack(root) {
    const layers = [];
    function onKeydown(event) {
      if (event.key !== 'Escape' || event.defaultPrevented || layers.length === 0) return;
      const layer = layers.pop();
      event.preventDefault();
      layer.close(event);
    }
    root.addEventListener('keydown', onKeydown);
    return {
      push(layer) {
        layers.push(layer);
        return {
          remove() {
            const index = layers.indexOf(layer);
            if (index !== -1) layers.splice(index, 1);
          },
        };
      },
      dispose() {
        layers.length = 0;
        root.removeEventListener('keydown', onKeydown);
      },
    };
  }

  // ---- Dialogs -------------------------------------------------------------------------------

  /**
   * Opens a modal `<dialog>` inside `root` (so it also works in full screen) and resolves with the
   * chosen action's `value`, or null when cancelled with Escape.
   * options: `ids` (from idFactory, for the title's id), `title`, `body` (string, Node, or array),
   * `actions` ([{ label, value, isDefault }]; Enter in a field chooses the default action),
   * optional `initialFocus` (an element in the body) and `returnFocus` (defaults to the element
   * focused when the dialog opened).
   */
  function openDialog(root, options) {
    const doc = root.ownerDocument;
    const returnFocus = options.returnFocus || doc.activeElement;
    const depth = root.querySelectorAll('dialog[open]').length;
    const titleId = options.ids('dialog-' + depth + '-title');
    const actions = options.actions || [];

    const buttons = actions.map(function (action, index) {
      return el('button', {
        type: action.isDefault ? 'submit' : 'button',
        value: String(index),
        class: action.isDefault ? 'c4-editor__button c4-editor__button--primary' : 'c4-editor__button',
        text: action.label,
        on: action.isDefault ? null : { click: function () { dialog.close(String(index)); } },
      });
    });
    const body = el('div', { class: 'c4-editor__dialog-body' },
      typeof options.body === 'string' ? el('p', { text: options.body }) : options.body);
    const dialog = el('dialog', { class: 'c4-editor__dialog', 'aria-labelledby': titleId }, [
      el('form', { method: 'dialog', class: 'c4-editor__dialog-form' }, [
        el('h2', { id: titleId, class: 'c4-editor__dialog-title', text: options.title }),
        body,
        el('div', { class: 'c4-editor__dialog-actions' }, buttons),
      ]),
    ]);

    // The dialog sits between the focused control and the root, so this runs before the root's
    // Escape stack and the dialog closes before any editor-wide layer.
    dialog.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      dialog.close('');
    });

    const result = new Promise(function (resolve) {
      dialog.addEventListener('close', function () {
        const action = actions[Number(dialog.returnValue)];
        dialog.remove();
        if (returnFocus && returnFocus.isConnected) returnFocus.focus();
        resolve(dialog.returnValue !== '' && action ? action.value : null);
      }, { once: true });
    });

    root.appendChild(dialog);
    dialog.showModal();
    const defaultButton = buttons[actions.findIndex(function (action) { return action.isDefault; })];
    const focusTarget = options.initialFocus || body.querySelector(FIELD_SELECTOR) || defaultButton || buttons[0];
    if (focusTarget) focusTarget.focus();
    return result;
  }

  // ---- Popovers ------------------------------------------------------------------------------

  /**
   * Attaches a hover-and-focus popover to `anchor` (which needs an instance-prefixed id). The
   * popover mounts right after the anchor, describes it through aria-describedby, stays open while
   * the pointer is over the anchor or the popover or the anchor has focus (WCAG 1.4.13), and
   * closes on Escape without moving focus. Returns `{ element, show, hide, isOpen, dispose }`.
   */
  function createPopover(anchor, content) {
    if (!anchor.id) throw new TypeError('createPopover(): the anchor needs an id');
    const doc = anchor.ownerDocument;
    const view = doc.defaultView;
    const element = el('div', {
      id: anchor.id + '-popover',
      role: 'tooltip',
      class: 'c4-editor__popover',
      hidden: true,
    }, typeof content === 'string' ? el('p', { text: content }) : content);
    anchor.insertAdjacentElement('afterend', element);
    const describedBy = (anchor.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    anchor.setAttribute('aria-describedby', describedBy.concat(element.id).join(' '));

    let hovered = 0;
    let hideTimer = null;

    function isOpen() { return !element.hidden; }
    function show() {
      view.clearTimeout(hideTimer);
      if (isOpen()) return;
      element.hidden = false;
      // Capture on the document: the popover is the innermost Escape layer even when only hovered
      // and focus is elsewhere.
      doc.addEventListener('keydown', onEscape, true);
    }
    function hide() {
      view.clearTimeout(hideTimer);
      element.hidden = true;
      doc.removeEventListener('keydown', onEscape, true);
    }
    function scheduleHide() {
      view.clearTimeout(hideTimer);
      hideTimer = view.setTimeout(function () {
        if (hovered === 0 && doc.activeElement !== anchor) hide();
      }, POPOVER_HIDE_DELAY_MS);
    }
    function onEscape(event) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      hide();
    }
    function onEnter() { hovered += 1; show(); }
    function onLeave() { hovered = Math.max(0, hovered - 1); scheduleHide(); }
    function onBlur() { if (hovered === 0) hide(); }

    const listeners = [
      [anchor, 'focus', show], [anchor, 'blur', onBlur],
      [anchor, 'pointerenter', onEnter], [anchor, 'pointerleave', onLeave],
      [element, 'pointerenter', onEnter], [element, 'pointerleave', onLeave],
    ];
    for (const [target, type, listener] of listeners) target.addEventListener(type, listener);

    return {
      element: element,
      show: show,
      hide: hide,
      isOpen: isOpen,
      dispose() {
        hide();
        for (const [target, type, listener] of listeners) target.removeEventListener(type, listener);
        const remaining = (anchor.getAttribute('aria-describedby') || '').split(/\s+/).filter(function (token) {
          return token && token !== element.id;
        });
        if (remaining.length) anchor.setAttribute('aria-describedby', remaining.join(' '));
        else anchor.removeAttribute('aria-describedby');
        element.remove();
      },
    };
  }

  // ---- Scrolling -----------------------------------------------------------------------------

  /**
   * Scrolls `region` by the least amount that brings `element` fully into its visible box (or its
   * top-left corner, when the element is larger). Unlike scrollIntoView, the page never scrolls.
   */
  function revealInScrollRegion(element, region) {
    const box = region.getBoundingClientRect();
    const target = element.getBoundingClientRect();
    const top = box.top + region.clientTop;
    const left = box.left + region.clientLeft;
    region.scrollTop += overflowDelta(target.top, target.bottom, top, top + region.clientHeight);
    region.scrollLeft += overflowDelta(target.left, target.right, left, left + region.clientWidth);
  }

  /**
   * Scrolls the page by the least amount that shows `element` between its scroll margins (the site's sticky navbar
   * above, the read-aloud bar below; spec §9.2 Focus), as focus scrolling would if it honoured them. Inner scroll
   * regions are left alone: reveal the element in its own region first (revealInScrollRegion).
   */
  function revealInPage(element) {
    const view = element.ownerDocument.defaultView;
    const style = view.getComputedStyle(element);
    const target = element.getBoundingClientRect();
    const visibleTop = parseFloat(style.scrollMarginTop) || 0;
    const visibleBottom = view.innerHeight - (parseFloat(style.scrollMarginBottom) || 0);
    const delta = overflowDelta(target.top, target.bottom, visibleTop, visibleBottom);
    if (delta !== 0) view.scrollBy(0, delta);
  }

  function overflowDelta(start, end, visibleStart, visibleEnd) {
    if (start < visibleStart) return start - visibleStart;
    if (end > visibleEnd) return Math.min(end - visibleEnd, start - visibleStart);
    return 0;
  }

  // ---- Menus ---------------------------------------------------------------------------------

  /**
   * The editor's one menu implementation (spec §9.2), shared by the toolbar's menu buttons (Add, More) and the
   * context menus of the actions: one open menu at a time per instance, a `role="menu"` in a manual popover (the top
   * layer, so it also works in full screen) inside `root`, with items as buttons (`role="menuitem"`) in optional
   * labelled groups. Arrow keys, Home, and End move focus (wrapping), a letter moves to the next item that starts
   * with it, Escape or Tab closes it and returns focus to the opener, and a pointer down outside it (and outside its
   * anchor, which toggles it) closes it. An item with `unavailable` (a reason) shows and announces the reason and keeps
   * the menu open; any other item closes the menu first, then runs.
   * options: `ids` (an idFactory), `announce`, and `name` (the id stem, unique per instance in one editor).
   * Returns `{ open(spec), close(), isOpen(), dispose() }`.
   */
  function createMenus(root, options) {
    const ids = options.ids;
    const announce = options.announce;
    const name = options.name || 'menu';
    const doc = root.ownerDocument;
    let current = null;

    /**
     * `spec`: `label` (the menu's accessible name), `groups` ([{ label, items: [{ label, note, unavailable, run }] }];
     * a group without a label adds no wrapper), `placement` (`anchor` or `point`, and `returnFocus`), `message` (a
     * reason shown when it opens), `focusGroup` (the index of the group whose first item gets focus), `focusLast`
     * (focus the last item instead), and `onClose()` (after it closes, however it closes). `run(context)` receives
     * `{ anchor, point, returnFocus }`. Returns `{ element, close }`.
     */
    function open(spec) {
      close({ restoreFocus: false });
      const placement = spec.placement || {};
      const items = [];
      const firstOfGroup = [];
      const messageText = el('p', { id: ids(name + '-message'), class: 'c4-editor__menu-message', hidden: true });
      const list = el('div', { role: 'menu', id: ids(name), class: 'c4-editor__menu-list', 'aria-label': spec.label,
        'aria-describedby': messageText.id }, spec.groups.map(function (group) {
        firstOfGroup.push(items.length);
        if (group.items.length === 0) return null;
        const buttons = group.items.map(function (item) {
          const button = el('button', { type: 'button', role: 'menuitem', tabindex: '-1', class: 'c4-editor__menu-item',
            'aria-disabled': item.unavailable ? 'true' : null, on: { click: function () { activate(item); } } },
          [item.label, item.note ? [' ', el('span', { class: 'c4-editor__menu-item-note', text: item.note })] : null]);
          items.push(button);
          return button;
        });
        if (!group.label) return buttons;
        return el('div', { role: 'group', class: 'c4-editor__menu-group', 'aria-label': group.label },
          [el('div', { class: 'c4-editor__menu-group-label', 'aria-hidden': 'true', text: group.label }), buttons]);
      }));
      // Only the list scrolls, so a reason shown below it stays in view however long the list is.
      const popup = el('div', { class: 'c4-editor__menu', popover: 'manual', on: { keydown: onKeydown, focusout: onFocusout } },
        el('div', { class: 'c4-editor__menu-frame' }, [list, messageText]));

      // The message takes room from the list, so the focused item is revealed again (WCAG 2.4.11).
      function showMessage(text) {
        messageText.textContent = text;
        messageText.hidden = false;
        if (items.includes(doc.activeElement)) revealInScrollRegion(doc.activeElement, list);
      }

      function activate(item) {
        if (item.unavailable) {
          showMessage(item.unavailable);
          announce(item.unavailable);
          return;
        }
        const context = { anchor: placement.anchor, point: placement.point, returnFocus: placement.returnFocus };
        close({ restoreFocus: true });
        item.run(context);
      }

      function onKeydown(event) {
        if (event.defaultPrevented) return;
        const index = items.indexOf(doc.activeElement);
        if (event.key === 'Tab') {
          close({ restoreFocus: true });
          return;
        }
        const moves = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1 };
        if (event.key in moves) focusItem(moves[event.key]);
        else if (event.key === 'Escape') close({ restoreFocus: true });
        else if (isTypeAhead(event)) focusByLetter(items, index, event.key);
        else return;
        event.preventDefault();
      }

      function focusItem(index) {
        if (items.length > 0) items[(index + items.length) % items.length].focus();
      }


      function onFocusout(event) {
        if (event.relatedTarget && !popup.contains(event.relatedTarget)) close({ restoreFocus: false });
      }

      // A press on the anchor is left to the anchor, which toggles its own menu.
      function onPointerdown(event) {
        const anchor = placement.anchor;
        if (!popup.contains(event.target) && !(anchor && anchor.contains && anchor.contains(event.target))) close({ restoreFocus: false });
      }

      root.appendChild(popup);
      if (typeof popup.showPopover === 'function') popup.showPopover();
      placeNear(popup, placement);
      doc.addEventListener('pointerdown', onPointerdown, true);
      current = {
        popup, placement, onClose: spec.onClose || null,
        cleanup: function () { doc.removeEventListener('pointerdown', onPointerdown, true); },
      };
      if (spec.message) showMessage(spec.message);
      focusItem(spec.focusLast ? items.length - 1 : firstOfGroup[spec.focusGroup || 0] || 0);
      return { element: popup, close: function () { close({ restoreFocus: true }); } };
    }

    function close(closing) {
      if (!current) return;
      const restoreFocus = !closing || closing.restoreFocus !== false;
      const closed = current;
      current = null;
      closed.cleanup();
      closed.popup.remove();
      if (restoreFocus && closed.placement.returnFocus && closed.placement.returnFocus.isConnected) closed.placement.returnFocus.focus();
      if (closed.onClose) closed.onClose();
    }

    return {
      open: open,
      close: close,
      isOpen: function () { return current !== null; },
      dispose: function () { close({ restoreFocus: false }); },
    };
  }

  /** A printable key without Ctrl, Cmd, or Alt: type-ahead in a menu (spec §9.2). */
  function isTypeAhead(event) {
    return event.key.length === 1 && /\S/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey;
  }

  /** Focuses the next of `items` after index `from` (wrapping) whose text starts with `letter`; none moves nothing. */
  function focusByLetter(items, from, letter) {
    const wanted = letter.toLocaleLowerCase();
    for (let step = 1; step <= items.length; step += 1) {
      const item = items[(from + step) % items.length];
      if (item.textContent.trim().toLocaleLowerCase().startsWith(wanted)) {
        item.focus();
        return;
      }
    }
  }

  // ---- Placement -----------------------------------------------------------------------------

  const POPUP_MARGIN_PX = 8;
  const POPUP_GAP_PX = 4;

  /**
   * Places a top-layer popup (an open popover or modal dialog) below its `anchor` element or `point` (client
   * coordinates), or above it when there is no room below, inside the viewport. Writes the coordinates as the custom
   * properties the stylesheet reads, `--c4-popup-x` and `--c4-popup-y` (computed values, set through the CSSOM).
   */
  function placeNear(popup, placement) {
    const anchor = placement.anchor || null;
    const point = placement.point || null;
    const target = point ? { left: point.x, top: point.y, bottom: point.y }
      : anchor && anchor.isConnected ? anchor.getBoundingClientRect() : null;
    if (!target) return;
    const viewport = popup.ownerDocument.documentElement;
    const box = popup.getBoundingClientRect();
    const below = target.bottom + POPUP_GAP_PX;
    const above = target.top - POPUP_GAP_PX - box.height;
    const fitsBelow = below + box.height <= viewport.clientHeight - POPUP_MARGIN_PX;
    const top = fitsBelow || above < POPUP_MARGIN_PX ? below : above;
    popup.style.setProperty('--c4-popup-x', clamp(target.left, POPUP_MARGIN_PX, viewport.clientWidth - POPUP_MARGIN_PX - box.width) + 'px');
    popup.style.setProperty('--c4-popup-y', clamp(top, POPUP_MARGIN_PX, viewport.clientHeight - POPUP_MARGIN_PX - box.height) + 'px');
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(value, max));
  }

  return {
    el: el,
    idFactory: idFactory,
    createAnnouncer: createAnnouncer,
    createEscapeStack: createEscapeStack,
    openDialog: openDialog,
    createPopover: createPopover,
    revealInScrollRegion: revealInScrollRegion,
    revealInPage: revealInPage,
    createMenus: createMenus,
    isTypeAhead: isTypeAhead,
    focusByLetter: focusByLetter,
    placeNear: placeNear,
  };
});
