(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.messages = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The message region (UML-view editing spec §7.5, §7.7, §14 D6): the one visible line above the canvas that shows
  // the current instruction (an armed tool or mode), or the last refusal, result, or notice, with an optional offer and
  // Dismiss. Its `show` is the report path every refusal takes. It owns how a message is shown and spoken: a refusal
  // gets the label "Not done:" with an icon, and the live region hears the message once, in the editor's own words.
  // The region itself is not live, so nothing is announced twice. A message stays until the next one replaces it or
  // the learner chooses Dismiss; the mount also clears it when the document changes or another view opens. It never
  // disappears on a timer. The mount places the region (directly before the canvas region, drawn over the canvas's top
  // edge) and decides when it exists (in an editable editor only).

  const KINDS = Object.freeze(['instruction', 'refusal', 'result', 'notice']);
  const REFUSAL_LABEL = 'Not done:';
  // Refusals that already say what they are, in the words existing announcements keep: the editor's errors and its
  // lock sentences (c4-editor-state.js). Any other refusal is announced with REFUSAL_LABEL before it.
  const SELF_NAMED_REFUSAL = /^(?:Error|Locked):/;
  // Shown after the label, the word "Error:" would repeat it.
  const ERROR_WORD = /^Error:\s*/;
  const SENTENCE_END = /[.!?:…]$/;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), '
    + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /** `message` checked against the contract of `show`; throws a TypeError for anything else. */
  function checkedMessage({ text, kind, offer = null } = {}) {
    if (typeof text !== 'string' || text.trim() === '') throw new TypeError('A message needs some text');
    if (!KINDS.includes(kind)) throw new TypeError(`A message's kind must be one of ${KINDS.join(', ')}`);
    if (offer !== null && (typeof offer.label !== 'string' || offer.label === '' || typeof offer.run !== 'function')) {
      throw new TypeError('An offer needs a label and a run function');
    }
    return Object.freeze({ text, kind, offer });
  }

  /**
   * What the live region says for `message` (`{ text, kind, offer }`): the text unchanged, except that a refusal which
   * does not begin with "Error:" or "Locked:" gets "Not done: " before it, so every refusal is announced as one; a
   * message with an offer ends with the offer's label.
   */
  function spokenText({ text, kind, offer = null }) {
    const said = kind === 'refusal' && !SELF_NAMED_REFUSAL.test(text) ? `${REFUSAL_LABEL} ${text}` : text;
    if (!offer) return said;
    return `${SENTENCE_END.test(said) ? said : `${said}.`} ${offer.label}`;
  }

  /** The text the region shows for `message`, after the label of a refusal: without a leading "Error:". */
  function shownText({ text, kind }) {
    return kind === 'refusal' ? text.replace(ERROR_WORD, '') : text;
  }

  /** The refusal's icon, a crossed circle. Decorative: the label beside it says the same in words. */
  function refusalIcon(doc) {
    const icon = doc.createElementNS(SVG_NS, 'svg');
    icon.setAttribute('class', 'c4-editor__message-icon');
    icon.setAttribute('viewBox', '0 0 16 16');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');
    const circle = doc.createElementNS(SVG_NS, 'circle');
    [['cx', '8'], ['cy', '8'], ['r', '6.5']].forEach(([name, value]) => circle.setAttribute(name, value));
    const cross = doc.createElementNS(SVG_NS, 'path');
    cross.setAttribute('d', 'M5.5 5.5l5 5M10.5 5.5l-5 5');
    icon.append(circle, cross);
    return icon;
  }

  /** The first element after `element` inside `root` that Tab reaches and that is drawn, or null. */
  function nextFocusable(root, element) {
    return [...root.querySelectorAll(FOCUSABLE)].find((candidate) => !element.contains(candidate)
      && Boolean(element.compareDocumentPosition(candidate) & 4 /* Node.DOCUMENT_POSITION_FOLLOWING */)
      && candidate.getClientRects().length > 0) || null;
  }

  /**
   * Creates one editor's message region. `root` is the editor root; `dom` the DOM utilities, `ids` the editor's
   * idFactory, and `announceLive(text)` writes one polite announcement. Returns:
   * - `element`: the region, a `section` named "Messages", for the mount to place;
   * - `show({ text, kind, offer })`: shows the message (kind 'instruction' | 'refusal' | 'result' | 'notice'; `offer`
   *   is null or `{ label, run }`) in place of the current one, without moving focus, and announces `spokenText` of it
   *   once. Returns `{ withdraw() }`, which removes this message if it is still the one shown (an armed mode's
   *   instruction, when the mode ends);
   * - `dismiss()`: removes the current message. When focus was on one of the region's buttons, it goes back to the
   *   option or control that had it before them (spec §7.7), else on to what follows the region;
   * - `destroy()`: removes the region; later calls change nothing.
   * Accepting the offer dismisses the message first, then runs the offer, which may move focus where its action goes.
   */
  function createMessageRegion(root, { dom, ids, announceLive }) {
    const doc = root.ownerDocument;
    const label = dom.el('span', { class: 'c4-editor__message-label' }, [refusalIcon(doc), REFUSAL_LABEL]);
    const paragraph = dom.el('p', { id: ids('messages-text'), class: 'c4-editor__message' });
    const offerButton = dom.el('button', {
      type: 'button', class: 'c4-editor__button', 'aria-describedby': paragraph.id, hidden: true, on: { click: acceptOffer },
    });
    const dismissButton = dom.el('button', {
      type: 'button', class: 'c4-editor__button', 'aria-describedby': paragraph.id, hidden: true, on: { click: () => dismiss() },
    }, 'Dismiss');
    const element = dom.el('section', {
      id: ids('messages'), class: 'c4-editor__messages', 'aria-label': 'Messages', on: { focusin: rememberFocus },
    }, [paragraph, dom.el('div', { class: 'c4-editor__message-actions' }, [offerButton, dismissButton])]);
    let current = null;
    let returnFocus = null;
    let destroyed = false;

    /** The text and buttons for `current` (none when it is null), with a class for its kind. */
    function render() {
      KINDS.forEach((kind) => element.classList.remove(`c4-editor__messages--${kind}`));
      if (current === null) {
        paragraph.replaceChildren();
      } else {
        element.classList.add(`c4-editor__messages--${current.kind}`);
        paragraph.replaceChildren(...(current.kind === 'refusal' ? [label, ' '] : []), shownText(current));
      }
      const offered = Boolean(current && current.offer);
      // A message without an offer that replaces one with an offer keeps focus in the region, on Dismiss.
      const offerHadFocus = !offered && current !== null && doc.activeElement === offerButton;
      offerButton.textContent = offered ? current.offer.label : '';
      offerButton.hidden = !offered;
      dismissButton.hidden = current === null;
      if (offerHadFocus) dismissButton.focus();
    }

    // Focus that enters the buttons from outside the region comes from the option or control Dismiss gives it back to.
    function rememberFocus(event) {
      if (!element.contains(event.relatedTarget)) returnFocus = event.relatedTarget;
    }

    function giveFocusBack() {
      const usable = returnFocus && returnFocus.isConnected && !element.contains(returnFocus) && returnFocus.getClientRects().length > 0;
      const target = usable ? returnFocus : nextFocusable(root, element);
      returnFocus = null;
      if (target) target.focus();
    }

    function show(message) {
      const shown = checkedMessage(message);
      if (destroyed) return { withdraw() {} };
      current = shown;
      render();
      announceLive(spokenText(shown));
      return {
        withdraw() {
          if (current === shown) dismiss();
        },
      };
    }

    function dismiss() {
      if (destroyed || current === null) return;
      const hadFocus = element.contains(doc.activeElement);
      current = null;
      render();
      if (hadFocus) giveFocusBack();
    }

    function acceptOffer() {
      if (current === null || current.offer === null) return;
      const { run } = current.offer;
      dismiss();
      run();
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      current = null;
      element.remove();
    }

    render();
    return { element, show, dismiss, destroy };
  }

  return { KINDS, createMessageRegion, spokenText, shownText };
});
