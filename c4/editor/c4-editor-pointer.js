(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.pointer = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The canvas's one pointer dispatcher (spec §9.2, Ruling 4). Every pointer gesture on the canvas region starts
  // here, so no two listeners ever handle the same press: a press goes to the first registered gesture that claims
  // it (Task 6 registers move, connect, and palette drops), else to panning when it lands on empty canvas; a second
  // touch turns the gesture into a pinch; Ctrl/Cmd+wheel (also a trackpad pinch) magnifies. Panning and magnifying
  // are navigation, so they change no model and need no undo step; the scrollbars and the zoom buttons are their
  // single-pointer alternatives (WCAG 2.5.7).

  // How strongly one wheel unit magnifies: 100 units of deltaY change the magnification by about 18%.
  const WHEEL_SENSITIVITY = 1 / 600;
  const WHEEL_LINE_PX = 16;

  /**
   * Starts dispatching the pointer input of `region` (the canvas scroll region). `options`:
   * `magnification` (the mount's magnification API: `level()`, `set(level)`), and `isEmpty(target)`, true when a
   * press on `target` lands on empty canvas (not on an element, a handle, a badge, or a control).
   * Returns `{ use(gesture), destroy() }`. `use` registers a gesture `{ start(event) }` ahead of panning and returns
   * the function that unregisters it: `start(event, press)` receives each primary `pointerdown` and returns null to
   * pass, or a session `{ move(event), end(event), cancel(), deferCapture? }` that then receives the press's moves, its
   * release (on pointer up, WCAG 2.5.2), or its cancellation (pointer cancel, lost capture, a second finger). The
   * region captures the pointer at once, unless the session sets `deferCapture` and calls `press.capture()` when it
   * starts dragging: until then a click or double-click keeps its own target (an element of the drawing).
   */
  function createPointerDispatcher(region, options) {
    const { magnification, isEmpty } = options;
    const gestures = [];
    const touches = new Map();
    let active = null;
    let pinch = null;

    function onPointerDown(event) {
      if (event.pointerType === 'touch') touches.set(event.pointerId, point(event));
      if (touches.size === 2) {
        startPinch();
        return;
      }
      if (!event.isPrimary || event.button !== 0 || active !== null) return;
      const press = { capture: () => capture(event.pointerId) };
      const session = claim(event, press);
      if (session === null) return;
      active = { pointerId: event.pointerId, session, captured: false };
      if (!session.deferCapture) capture(event.pointerId);
    }

    function capture(pointerId) {
      if (active === null || active.pointerId !== pointerId || active.captured) return;
      active.captured = true;
      if (region.isConnected) region.setPointerCapture(pointerId);
    }

    function claim(event, press) {
      for (const gesture of gestures) {
        const session = gesture.start(event, press);
        if (session) return session;
      }
      return isEmpty(event.target) ? startPan(event) : null;
    }

    // A session that has not captured the pointer may be released outside the region: the document still hears it.
    function onDocumentPointerEnd(event) {
      if (active === null || active.captured || active.pointerId !== event.pointerId || region.contains(event.target)) return;
      if (event.type === 'pointerup') onPointerUp(event);
      else onPointerCancel(event);
    }

    function onPointerMove(event) {
      if (touches.has(event.pointerId)) touches.set(event.pointerId, point(event));
      if (pinch !== null) {
        updatePinch();
      } else if (active !== null && active.pointerId === event.pointerId) {
        active.session.move(event);
      }
    }

    function onPointerUp(event) {
      touches.delete(event.pointerId);
      if (pinch !== null) {
        if (touches.size < 2) pinch = null;
        return;
      }
      if (active === null || active.pointerId !== event.pointerId) return;
      const { session } = active;
      active = null;
      session.end(event);
    }

    function onPointerCancel(event) {
      touches.delete(event.pointerId);
      if (touches.size < 2) pinch = null;
      if (active !== null && active.pointerId === event.pointerId) cancelActive();
    }

    function cancelActive() {
      const { session } = active;
      active = null;
      session.cancel();
    }

    // ---- Panning (spec §9.2: drag empty canvas space) --------------------------------------------------

    /** Scrolls the region with the pointer, so the drawing follows the hand; the press also focuses the region. */
    function startPan(event) {
      event.preventDefault();
      if (!region.contains(region.ownerDocument.activeElement)) region.focus({ preventScroll: true });
      const origin = { x: event.clientX, y: event.clientY, left: region.scrollLeft, top: region.scrollTop };
      region.classList.add('is-panning');
      const stop = () => region.classList.remove('is-panning');
      return {
        move(moved) {
          region.scrollLeft = origin.left - (moved.clientX - origin.x);
          region.scrollTop = origin.top - (moved.clientY - origin.y);
        },
        end: stop,
        cancel() {
          region.scrollLeft = origin.left;
          region.scrollTop = origin.top;
          stop();
        },
      };
    }

    // ---- Magnifying (spec §9.2: Ctrl/Cmd+wheel or pinch) ------------------------------------------------

    /**
     * Sets the magnification to `level` and scrolls so the drawing's point under `anchor` (client coordinates)
     * stays under it.
     */
    function magnifyAround(level, anchor) {
      const before = magnification.level();
      const after = magnification.set(level);
      if (after === before) return;
      const box = region.getBoundingClientRect();
      const x = anchor.x - box.left;
      const y = anchor.y - box.top;
      region.scrollLeft = ((region.scrollLeft + x) * after) / before - x;
      region.scrollTop = ((region.scrollTop + y) * after) / before - y;
    }

    function onWheel(event) {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * WHEEL_LINE_PX : event.deltaY;
      magnifyAround(magnification.level() * Math.exp(-delta * WHEEL_SENSITIVITY), point(event));
    }

    function startPinch() {
      if (active !== null) cancelActive();
      pinch = { spread: spread(), level: magnification.level() };
    }

    function updatePinch() {
      if (touches.size < 2 || pinch.spread === 0) return;
      const [first, second] = [...touches.values()];
      magnifyAround(pinch.level * (spread() / pinch.spread), { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 });
    }

    function spread() {
      const [first, second] = [...touches.values()];
      return Math.hypot(first.x - second.x, first.y - second.y);
    }

    const controller = new AbortController();
    const listen = { signal: controller.signal };
    region.addEventListener('pointerdown', onPointerDown, listen);
    region.addEventListener('pointermove', onPointerMove, listen);
    region.addEventListener('pointerup', onPointerUp, listen);
    region.addEventListener('pointercancel', onPointerCancel, listen);
    region.addEventListener('lostpointercapture', onPointerCancel, listen);
    region.addEventListener('wheel', onWheel, { signal: controller.signal, passive: false });
    const doc = region.ownerDocument;
    doc.addEventListener('pointerup', onDocumentPointerEnd, { signal: controller.signal, capture: true });
    doc.addEventListener('pointercancel', onDocumentPointerEnd, { signal: controller.signal, capture: true });

    return {
      use(gesture) {
        gestures.push(gesture);
        return function unregister() {
          const index = gestures.indexOf(gesture);
          if (index >= 0) gestures.splice(index, 1);
        };
      },
      destroy() {
        if (active !== null) cancelActive();
        controller.abort();
        gestures.length = 0;
        touches.clear();
        region.classList.remove('is-panning');
      },
    };
  }

  function point(event) {
    return { x: event.clientX, y: event.clientY };
  }

  return { createPointerDispatcher: createPointerDispatcher };
});
