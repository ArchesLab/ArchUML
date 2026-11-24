(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.anchoredForm = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The anchored form (UML-view editing spec §5.3–§5.5, §7.7; plan Task 42): a small form in a dialog beside what it
  // was opened from. The relationship form and the link, step, and fragment forms of the UML views are each one of
  // these, so they open, anchor, confirm, and cancel the same way. The dialog is the editor's (`dom.openDialog`, through
  // the shared commands' `trackedDialog`, which closes the open menu first and closes the dialog when the editor goes),
  // so it lives in the editor root and works in full screen. Enter or the default button confirms; Escape or Cancel
  // closes it with nothing done, and focus returns to `returnFocus`.

  const DEFAULT_ACTIONS = Object.freeze({ cancel: 'Cancel', submit: 'OK' });

  /**
   * Opens one anchored form. `spec`:
   * - `body` (an element: the form's fields), `title` (the dialog's heading and accessible name);
   * - `placement`: `anchor` (an element) or `point` (`{ x, y }`, client px) to sit beside; without either the dialog is
   *   placed as any other;
   * - `onSubmit()`: runs on each submit; a result with `ok: false` keeps the form open (the form shows its own problem),
   *   any other result closes it and is what the promise resolves;
   * - `returnFocus`: where focus goes when the form closes (default: the element focused when it opened);
   * - `initialFocus` (an element of `body`), `submitLabel` and `cancelLabel` (the two buttons' words);
   * - `using`: `{ dom, openDialog(body, dialogOptions) → Promise }`, the editor's DOM utilities and dialog opener.
   * Resolves `onSubmit`'s result, or null when the form was cancelled.
   */
  function openAnchoredForm(spec) {
    const { body, title, placement = {}, onSubmit, returnFocus, initialFocus, using } = spec;
    const labels = { cancel: spec.cancelLabel || DEFAULT_ACTIONS.cancel, submit: spec.submitLabel || DEFAULT_ACTIONS.submit };
    const closed = using.openDialog(body, {
      title,
      actions: [{ label: labels.cancel, value: null }, { label: labels.submit, value: 'submit', isDefault: true }],
      initialFocus,
      returnFocus,
    });
    const dialog = body.closest('dialog');
    const form = body.closest('form');
    const place = () => anchor(using.dom, dialog, placement);
    place();
    // A disclosure opened inside makes the form taller: placed again, it stays inside the viewport (WCAG 2.4.11).
    // `toggle` does not bubble, so it is heard while it travels down to the disclosure.
    body.addEventListener('toggle', place, true);
    let result = null;
    form.addEventListener('submit', (event) => {
      result = onSubmit();
      if (result && result.ok === false) event.preventDefault();
    });
    return closed.then((value) => (value === null ? null : result));
  }

  /** Puts `dialog` beside `placement`'s anchor or point; a placement with neither leaves it where dialogs go. */
  function anchor(dom, dialog, placement) {
    if (!placement.anchor && !placement.point) return;
    dialog.classList.add('c4-editor__dialog--anchored');
    dom.placeNear(dialog, placement);
  }

  return { openAnchoredForm };
});
