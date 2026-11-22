(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(function () {
      return { inspectorShared: require('./c4-editor-inspector-shared.js') };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.inspectorFocus = factory(function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (editorParts) {
  'use strict';

  // The inspector's render cycle (c4-editor-inspector.js): it renders the form after the state's events, at most once
  // per turn, and keeps focus and an unsaved draft across each re-render (Review Focus 2); it answers the focus
  // requests of commands and of Problems › Show. It also disposes, before each render, what the last form made.

  /**
   * The render cycle of one inspector. `inspector` is the inspector's shared context: `element` (the inspector's
   * element), `state`, `view` (`openDisclosures`), `localProblems` (cleared after each render), `content()` (the form's
   * nodes), and `resolveFocusPath(selection, path)`. Returns `scheduleRender`, `render`, `disposeOnRender`,
   * `trackList`, `byKey`, `requestFocus`, `focusAfterRender`, `rememberRow`, `live`, and `teardown`.
   */
  function createRenderCycle(inspector) {
    const { element, state, view, localProblems, content, resolveFocusPath } = inspector;
    const { startsWith, cssEscape } = editorParts().inspectorShared;
    let renderTimer = null;
    // True while the old form is being replaced: removing a focused field fires its `change`, which must not commit
    // the learner's unsaved draft (Review Focus 2).
    let replacing = false;
    let pendingFocus = null;
    let handledFocusRequest = null;
    let lists = [];
    // Things a form made that must be disposed before the form is replaced (definition popovers).
    let renderOwned = [];
    let rowKeyByRelationship = new Map();

    /**
     * Renders after the current event has finished, so a commit made while focus moves on (Tab) re-renders after the
     * focus has landed, and several state events in one turn render once.
     */
    function scheduleRender() {
      if (renderTimer === null) renderTimer = setTimeout(render, 0);
    }

    function render() {
      clearTimeout(renderTimer);
      renderTimer = null;
      const snapshot = focusSnapshot();
      lists.forEach((list) => list.destroy());
      lists = [];
      disposeRenderOwned();
      rowKeyByRelationship = new Map();
      const next = content().filter(Boolean);
      replacing = true;
      try {
        element.replaceChildren(...next);
      } finally {
        replacing = false;
      }
      localProblems.clear();
      restoreFocus(snapshot);
    }

    /** Keeps `handle` (with `dispose()`) until the next render or destroy, which dispose it. */
    function disposeOnRender(handle) {
      renderOwned.push(handle);
    }

    /** Keeps a list editor until the next render or teardown, which destroy it. */
    function trackList(list) {
      lists.push(list);
    }

    function disposeRenderOwned() {
      renderOwned.forEach((handle) => handle.dispose());
      renderOwned = [];
    }

    /** The focused control's key and, for a text field with an unsaved draft, the draft and its selection. */
    function focusSnapshot() {
      const active = element.ownerDocument.activeElement;
      if (!active || !element.contains(active)) return null;
      const key = active.getAttribute('data-c4-focus-key');
      if (!key) return null;
      const isText = 'defaultValue' in active && typeof active.value === 'string' && active.type !== 'checkbox';
      const draft = isText && active.value !== active.defaultValue ? active.value : null;
      return { key, draft, start: isText ? active.selectionStart : null, end: isText ? active.selectionEnd : null };
    }

    function restoreFocus(snapshot) {
      const request = focusRequest();
      if (request) {
        focusField(request);
        return;
      }
      const wanted = resolvePendingFocus() || snapshot;
      pendingFocus = null;
      if (wanted && wanted.element) {
        if (wanted.element.isConnected) wanted.element.focus();
        return;
      }
      if (!wanted) return;
      const target = byKey(wanted.key);
      if (!target) return;
      target.focus({ preventScroll: false });
      if (wanted.draft !== null && wanted.draft !== undefined && 'value' in target && wanted.draft !== target.defaultValue) {
        target.value = wanted.draft;
        carryDraft(target);
        if (wanted.start !== null && typeof target.setSelectionRange === 'function') {
          try { target.setSelectionRange(wanted.start, wanted.end); } catch (error) { /* a number input has no selection */ }
        }
      }
    }

    /**
     * A draft restored by script fires no `change` when focus leaves (Chrome), so it is committed on blur, or on Enter
     * in a one-line field, unless the learner's own later edit already fired `change`.
     */
    function carryDraft(target) {
      let settled = false;
      const flush = () => {
        if (settled || replacing || !target.isConnected) return;
        settled = true;
        if (target.value !== target.defaultValue) target.dispatchEvent(new Event('change'));
      };
      target.addEventListener('change', () => { settled = true; }, { once: true });
      target.addEventListener('blur', flush, { once: true });
      if (target.tagName === 'INPUT') {
        target.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' && !event.isComposing) flush();
        });
      }
    }

    function byKey(key) {
      return key ? element.querySelector(`[data-c4-focus-key="${cssEscape(key)}"]`) : null;
    }

    /** A focus key wanted by the last command: `{ key }`, or the row of a moved relationship. */
    function resolvePendingFocus() {
      if (!pendingFocus) return null;
      if (pendingFocus.element) return pendingFocus;
      if (pendingFocus.relationshipId) {
        const key = rowKeyByRelationship.get(pendingFocus.relationshipId);
        if (key) return { key, draft: null };
        // The moved relationship no longer touches this element in the open view: show its own form.
        const relationshipId = pendingFocus.relationshipId;
        pendingFocus = { key: 'relationship-description' };
        state.select({ relationshipId });
        return null;
      }
      return { key: pendingFocus.key, draft: null };
    }

    /** Focuses the control with focus key `key` (or the element `key`, such as an opener outside the inspector) after the next render. */
    function requestFocus(key) {
      pendingFocus = typeof key === 'string' ? { key } : { element: key };
      if (renderTimer === null) {
        const target = typeof key === 'string' ? byKey(key) : key;
        if (target) {
          pendingFocus = null;
          target.focus();
        }
      }
    }

    /**
     * Focuses after the next render, which it schedules: `{ key }`, or `{ relationshipId }` for the row that shows that
     * relationship (a relationship moved with "Move to…").
     */
    function focusAfterRender(request) {
      pendingFocus = request;
      scheduleRender();
    }

    /** Notes that the row with focus key `rowKey` shows the relationship `relationshipId`, until the next render. */
    function rememberRow(relationshipId, rowKey) {
      rowKeyByRelationship.set(relationshipId, rowKey);
    }

    /** A Problems › Show request carried by the selection (`focus: { path, request }`), once per request. */
    function focusRequest() {
      const selection = state.getSelection();
      const request = selection && selection.focus;
      if (!request || request.request === handledFocusRequest) return null;
      handledFocusRequest = request.request;
      return request.path;
    }

    /** Focuses the field whose YAML path is `path`, or the deepest one that contains it; opens its disclosure. */
    function focusField(requested) {
      const path = resolveFocusPath(state.getSelection(), requested);
      const wanted = JSON.stringify(path);
      const candidates = [...element.querySelectorAll('[data-c4-path]')];
      const exact = candidates.find((node) => node.getAttribute('data-c4-path') === wanted);
      const target = exact || candidates
        .map((node) => ({ node, path: JSON.parse(node.getAttribute('data-c4-path')) }))
        .filter((candidate) => startsWith(path, candidate.path))
        .sort((a, b) => b.path.length - a.path.length)
        .map((candidate) => candidate.node)[0];
      if (!target) return;
      const disclosure = target.closest('details');
      if (disclosure && !disclosure.open) {
        view.openDisclosures.add(disclosure.getAttribute('data-c4-disclosure'));
        render();
        focusField(path);
        return;
      }
      target.focus();
    }

    /** `commit` unless the change event comes from a field the re-render is removing. */
    function live(commit) {
      return (...values) => (replacing ? undefined : commit(...values));
    }

    /** Stops rendering and disposes what the last form made (the inspector is being destroyed). */
    function teardown() {
      clearTimeout(renderTimer);
      renderTimer = null;
      lists.forEach((list) => list.destroy());
      disposeRenderOwned();
    }

    return { scheduleRender, render, disposeOnRender, trackList, byKey, requestFocus, focusAfterRender, rememberRow, live, teardown };
  }

  return { createRenderCycle };
});
