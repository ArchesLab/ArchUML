(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.drag = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The editor's one drag model (spec §9.2 "Direct manipulation", Ruling 4 addendum). A press becomes a drag only once
  // the pointer has moved past a small threshold, so a click stays a click; a touch that rests long enough is a long
  // press instead (the context menu). While dragging, Escape cancels (WCAG 2.5.2: nothing happens until pointer up),
  // the F key is ignored (full screen must not toggle under a drag), and the click that follows the release is
  // swallowed, so dropping a palette tile never also clicks it. What the drag shows (a ghost, guides, valid targets)
  // and what a drop does (one command, one undo step, an announcement) belong to the gesture that owns the session.

  // Mouse and pen presses become drags after 4 CSS px; a finger is less precise.
  const THRESHOLD_PX = { mouse: 4, pen: 4, touch: 10 };
  // The platform's long-press time.
  const LONG_PRESS_MS = 500;
  const DROP_TARGET_CLASS = 'is-drop-target';
  const DROP_HOVER_CLASS = 'is-drop-hover';

  /**
   * One press that may become a drag. `spec`:
   * `event` (the `pointerdown`), and the gesture's callbacks, each optional:
   * `onBegin(event)` when the press becomes a drag (return false to refuse dragging: the press then does nothing);
   * `onMove(event)` for each move while dragging; `onDrop(event)` on release while dragging;
   * `onTap(event)` on a release that never became a drag; `onLongPress(event)` when a touch rests (the press then
   * ends); `onCancel()` when a drag is cancelled (Escape, a lost pointer, a second finger, or `cancel()`).
   * Returns the session `{ move(event), end(event), cancel(), deferCapture }`, which the canvas's pointer dispatcher
   * (or `track`) feeds; `deferCapture` asks the dispatcher to capture the pointer only when the drag begins.
   */
  function createDragSession(spec) {
    const start = spec.event;
    const doc = start.target.ownerDocument;
    const view = doc.defaultView;
    const threshold = THRESHOLD_PX[start.pointerType] || THRESHOLD_PX.mouse;
    let dragging = false;
    let finished = false;
    let refused = false;
    let longPressed = false;
    let longPress = start.pointerType === 'touch' && spec.onLongPress
      ? view.setTimeout(() => {
        longPress = null;
        if (dragging || finished) return;
        longPressed = true;
        finish();
        spec.onLongPress(start);
      }, LONG_PRESS_MS)
      : null;

    function onKeydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      } else if (isLetter(event, 'f')) {
        event.preventDefault();
      }
    }

    function begin(event) {
      dragging = true;
      clearLongPress();
      if (spec.onBegin && spec.onBegin(event) === false) {
        refused = true;
        return;
      }
      doc.addEventListener('keydown', onKeydown, true);
    }

    function move(event) {
      if (finished || refused) return;
      if (!dragging) {
        if (Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < threshold) return;
        begin(event);
        if (refused) return;
      }
      if (spec.onMove) spec.onMove(event);
    }

    function end(event) {
      // Lifting the finger after a long press is not a tap on what lies under it (the menu it opened keeps focus).
      if (longPressed) swallowTapOn(start.target, doc);
      if (finished) return;
      const wasDragging = dragging && !refused;
      finish();
      if (wasDragging) {
        swallowNextClick(doc);
        if (spec.onDrop) spec.onDrop(event);
      } else if (!refused && spec.onTap) {
        spec.onTap(event);
      }
    }

    function cancel() {
      if (finished) return;
      const wasDragging = dragging && !refused;
      finish();
      if (wasDragging && spec.onCancel) spec.onCancel();
    }

    function finish() {
      finished = true;
      clearLongPress();
      doc.removeEventListener('keydown', onKeydown, true);
    }

    function clearLongPress() {
      if (longPress !== null) view.clearTimeout(longPress);
      longPress = null;
    }

    return { move, end, cancel, deferCapture: true };
  }

  /**
   * Feeds `session` from a press outside the canvas's dispatcher (a palette tile): captures the pointer on the
   * pressed element and forwards its moves, release, and cancellation until the press ends. Returns `session`.
   */
  function track(event, session) {
    const element = event.currentTarget || event.target;
    const controller = new AbortController();
    const listen = { signal: controller.signal };
    const pointerId = event.pointerId;
    const mine = (handler) => (next) => {
      if (next.pointerId === pointerId) handler(next);
    };
    const stop = () => controller.abort();
    element.addEventListener('pointermove', mine((next) => session.move(next)), listen);
    element.addEventListener('pointerup', mine((next) => {
      stop();
      session.end(next);
    }), listen);
    const cancel = mine(() => {
      stop();
      session.cancel();
    });
    element.addEventListener('pointercancel', cancel, listen);
    element.addEventListener('lostpointercapture', cancel, listen);
    if (element.setPointerCapture) element.setPointerCapture(pointerId);
    return session;
  }

  /**
   * The valid drop targets' marks (spec §9.2: a thicker dashed outline, a non-colour cue, from the stylesheet):
   * `show(elements)` marks the valid targets, `hover(element | null)` the one under the pointer, `clear()` both.
   */
  function createTargetMarks() {
    let targets = [];
    let hovered = null;
    function hover(element) {
      if (hovered === element) return;
      if (hovered) hovered.classList.remove(DROP_HOVER_CLASS);
      hovered = element;
      if (hovered) hovered.classList.add(DROP_HOVER_CLASS);
    }
    return {
      show(elements) {
        targets.forEach((element) => element.classList.remove(DROP_TARGET_CLASS));
        targets = elements.slice();
        targets.forEach((element) => element.classList.add(DROP_TARGET_CLASS));
      },
      hover,
      clear() {
        hover(null);
        targets.forEach((element) => element.classList.remove(DROP_TARGET_CLASS));
        targets = [];
      },
    };
  }

  /** The click a drag's release produces is not a click on what lies under it. */
  function swallowNextClick(doc) {
    const view = doc.defaultView;
    const swallow = (event) => {
      event.preventDefault();
      event.stopPropagation();
      remove();
    };
    const remove = () => doc.removeEventListener('click', swallow, true);
    doc.addEventListener('click', swallow, true);
    view.setTimeout(remove, 0);
  }

  /**
   * A browser may still turn a long press into a tap when the finger lifts: the mouse press and click it makes on
   * `element` (not elsewhere, such as the menu the long press opened) are swallowed until that click or the next press.
   */
  function swallowTapOn(element, doc) {
    const swallow = (event) => {
      if (!element.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.type === 'click') remove();
    };
    const remove = () => {
      doc.removeEventListener('mousedown', swallow, true);
      doc.removeEventListener('click', swallow, true);
      doc.removeEventListener('pointerdown', remove, true);
    };
    doc.addEventListener('mousedown', swallow, true);
    doc.addEventListener('click', swallow, true);
    doc.addEventListener('pointerdown', remove, true);
  }

  /** The plain letter `letter` (either case) without Ctrl, Cmd, or Alt. */
  function isLetter(event, letter) {
    return event.key.toLowerCase() === letter && !event.ctrlKey && !event.metaKey && !event.altKey;
  }

  return { createDragSession, track, createTargetMarks, isLetter };
});
