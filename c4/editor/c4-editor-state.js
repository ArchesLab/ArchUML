(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../c4-core.js'));
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.state = factory(root.ArchUMLC4);
  }
})(typeof self !== 'undefined' ? self : this, function (C4) {
  'use strict';

  // The editor's DOM-free state: the document text, the open view, the selection, undo, the read-only mode for
  // YAML errors, and the diagnostics the configuration and display mode let through (spec §3.4, §7.2, §7.3, §9.2,
  // §9.3). It speaks to the host only through `options.host` and to the model only through the `ArchUMLC4` facade,
  // so every UI module (and a test) drives the same rules.

  const UNDO_LIMIT = 100;
  // The selector of the whole-model view, which the editor shows only before a model has a system of its own (ED-10).
  const LANDSCAPE = 'landscape';
  const COALESCE_MS = 600;
  const EVENTS = ['text', 'view', 'selection', 'diagnostics', 'mode'];
  const DISPLAY_MODES = ['live', 'on-request', 'after-submit'];
  const PROFILES = ['novice', 'expert'];
  const HOST_UNDO_METHODS = ['performUndo', 'performRedo', 'canUndo', 'canRedo'];
  // The optional host members the editor calls (spec §3.4; docs/c4-editor.md). One that is given must be a function.
  const HOST_CALLBACKS = ['onViewChange', 'onSelectionChange', 'openFile', 'saveFile', 'exportSvg', 'copyText', 'confirm',
    'announce', 'createSourceEditor', 'onRequestCheck', 'onRequestSave', 'onCheckNow', 'onSubmitForReview'];
  // Info rules the novice profile still shows: their quick fix is how a novice moves a relationship down a level (§7.2).
  const NOVICE_INFO_RULES = new Set(['xlevel/unreceived', 'xlevel/unsent']);
  // What a lock refusal says cannot happen to the element a command acts on (lockedSentence); otherwise "changed".
  const LOCK_OUTCOMES = {
    deleteElement: 'it cannot be deleted',
    moveElement: 'it cannot be moved',
    pinPosition: 'it cannot be moved',
    changeElementId: 'its id cannot be changed',
  };
  const REFUSALS = {
    'read-only': 'This model is read-only',
    'yaml-errors': 'Fix the YAML errors first',
  };
  // The selection keys that name something the model must still contain for the selection to survive new text.
  const SELECTION_TARGETS = {
    elementId: (model, id) => model.elements.has(id),
    relationshipId: (model, id) => model.relationships.some((relationship) => relationship.id === id),
    interfaceId: (model, id) => model.interfaces.has(id),
    scenarioId: (model, id) => model.scenarios.has(id),
    environmentId: (model, id) => model.environments.has(id),
  };

  /**
   * Creates the state of one editor. `options`: `text` (default empty), `host` (spec §3.4; `onTextChange` is required, and the four
   * undo methods when `host.undo === 'host'`), `view`, `profile` ('novice' | 'expert', default 'expert'), `checks`
   * (`display` plus the `check` configuration), `readOnly`, `lockedFields` (spec §11: commands that would change a
   * locked node are refused), `source` (passed to `ArchUMLC4.load`), and `now` (the clock undo coalescing reads;
   * default `Date.now`). Throws a TypeError for a host or option outside the contract.
   */
  function createEditorState(options) {
    const host = checkedHost(options.host);
    const profile = checkedChoice('profile', options.profile || 'expert', PROFILES);
    const checkConfig = Object.assign({}, options.checks);
    const display = checkedChoice('checks.display', checkConfig.display || 'live', DISPLAY_MODES);
    delete checkConfig.display;
    const history = host.undo === 'host' ? hostHistory(host) : snapshotHistory(options.now || Date.now);
    const listeners = new Map(EVENTS.map((event) => [event, new Set()]));
    const touched = new Set();
    const lockedFields = options.lockedFields || [];

    let text = options.text === undefined ? '' : options.text;
    let design = load(text);
    let readableDesign = design.model === null ? null : design;
    let version = 0;
    let selection = null;
    let released = display === 'live';
    let diagnosticsCache = null;
    let mode = modeOf(design);
    const initialView = resolveView(options.view || null);
    let view = initialView.selector;
    let viewProblem = initialView.problem;

    function load(nextText) {
      return C4.load(nextText, { source: options.source });
    }

    function emit(event, ...values) {
      listeners.get(event).forEach((listener) => listener(...values));
    }

    // ---- Text --------------------------------------------------------------------------------

    /**
     * Takes `nextText` as the document and brings the mode, view, and selection up to date before anyone hears of
     * it, so every listener reads one consistent state. The view and selection stay unless the new model lacks them.
     */
    function adopt(nextText, info, toHost, loaded = load(nextText)) {
      const before = { reason: mode.reason, view, selection };
      text = nextText;
      design = loaded;
      if (design.model !== null) readableDesign = design;
      diagnosticsCache = null;
      mode = modeOf(design);
      view = resolveView(view, { requested: false }).selector;
      if (selection !== null && !survives(selection)) selection = null;

      if (toHost) host.onTextChange(text, info);
      emit('text', text, info);
      if (mode.reason !== before.reason) emit('mode', getMode());
      if (view !== before.view) announceView();
      if (selection !== before.selection) announceSelection();
      emitDiagnostics();
    }

    /** A change the editor made: it reaches the host with the next version number. */
    function emitChange(nextText, { reason, edits, label }, loaded) {
      version += 1;
      adopt(nextText, { reason, edits, version, label }, true, loaded);
    }

    /**
     * Text from the host. Never calls `onTextChange`; equal text, which includes the host's echo of the editor's
     * last emitted change, is a no-op.
     */
    function setText(nextText, { reason = 'external' } = {}) {
      if (nextText === text) return;
      history.recordExternal(text);
      adopt(nextText, { reason, edits: spliceBetween(text, nextText), version, label: null }, false);
    }

    /** Text typed in the editor's own YAML surface; unlike `setText`, the host hears about it. */
    function applySourceText(nextText, { label = 'Edit YAML' } = {}) {
      if (options.readOnly || nextText === text) return false;
      history.recordEdit(text, label);
      emitChange(nextText, { reason: 'source', edits: spliceBetween(text, nextText), label });
      return true;
    }

    /**
     * Applies a core edit command; returns `{ ok, error, message, selection }` and selects the core's selection. A
     * command that would change a locked node (spec §11) is refused with `error: 'locked'`, whichever part sent it:
     * its `message` is the learner's sentence ("Locked: …", see lockedSentence) and `lockedPath` the dotted YAML path,
     * for the host and diagnostics. `refusalText(result)` turns any refusal into the sentence to show.
     */
    function dispatch(command, { label = labelOf(command.op) } = {}) {
      if (mode.readOnly) return refusal(mode.reason);
      const result = C4.edit(design, command);
      if (result.error) return { ok: false, error: result.error, message: result.message || REFUSALS[result.error] || null, selection: null };
      if (result.text !== text) {
        const next = load(result.text);
        const locked = changedLockedPath(design, next, lockedFields);
        if (locked !== null) return lockedRefusal(command, locked);
        history.recordEdit(text, label);
        emitChange(result.text, { reason: 'edit', edits: result.edits, label }, next);
      }
      if (result.selection) select(result.selection);
      return { ok: true, error: null, message: null, selection: result.selection || null };
    }

    /**
     * The refusal `dispatch(command)` would give for a lock (`{ ok: false, error: 'locked', message, lockedPath }`), or
     * null (also null for a command the core refuses). Changes nothing: a part asks before it confirms a command with
     * the learner, so a lock is named before any question.
     */
    function lockRefusal(command) {
      if (mode.readOnly || lockedFields.length === 0) return null;
      const result = C4.edit(design, command);
      if (result.error || result.text === text) return null;
      const locked = changedLockedPath(design, load(result.text), lockedFields);
      return locked === null ? null : lockedRefusal(command, locked);
    }

    /**
     * The refusal for `command`, which would change the locked `path`: it names the drawn thing that holds the path
     * (lockedSubject; not the path) and, when the command acts on the element that holds it, what cannot happen to it
     * (deleted, renamed, moved).
     */
    function lockedRefusal(command, path) {
      const owner = elementHolding(design.model, path);
      const outcome = owner !== null && command.elementId === owner.id ? lockOutcome(command) : undefined;
      const subject = lockedSubject(design, path, { command, view });
      return { ok: false, error: 'locked', message: lockedSentence(subject, outcome), lockedPath: path.join('.'), selection: null };
    }

    // ---- Undo --------------------------------------------------------------------------------

    function stepHistory(direction) {
      if (options.readOnly) return false;
      const step = history[direction](text);
      if (step === null) return false;
      if (step.text !== null) {
        emitChange(step.text, { reason: direction, edits: spliceBetween(text, step.text), label: step.label });
      }
      return true;
    }

    // ---- Mode --------------------------------------------------------------------------------

    function modeOf(current) {
      const errors = current.model === null ? current.diagnostics : [];
      const reason = options.readOnly ? 'read-only' : errors.length > 0 ? 'yaml-errors' : null;
      return { readOnly: reason !== null, reason, errors };
    }

    function getMode() {
      return { readOnly: mode.readOnly, reason: mode.reason, errors: mode.errors.slice() };
    }

    // ---- View --------------------------------------------------------------------------------

    /**
     * `{ selector, problem }`: the canonical selector, or the default view and the diagnostic of an unknown one. The
     * editor has no landscape level (decision ED-10): a landscape request opens the default view, the context view of
     * the first internal system, unless the model has none yet. Called again on every text change with the open view
     * (`{ requested: false }`), it keeps a landscape already open, so an edit never switches views under the reader.
     */
    function resolveView(selector, { requested = true } = {}) {
      if (readableDesign === null) return { selector, problem: null };
      if (selector === null) return { selector: C4.defaultView(readableDesign), problem: null };
      const projected = C4.project(readableDesign, selector);
      if (projected.type === LANDSCAPE && requested) return { selector: C4.defaultView(readableDesign), problem: null };
      if (projected.type !== null) return { selector: projected.selector, problem: null };
      return { selector: C4.defaultView(readableDesign), problem: projected.diagnostics[0] || null };
    }

    /** The trail the editor shows for `viewModel`: the core's breadcrumbs without the landscape (ED-10). */
    function breadcrumbs(viewModel) {
      return viewModel ? viewModel.breadcrumbs.filter((crumb) => crumb.selector !== LANDSCAPE) : [];
    }

    function announceView() {
      if (host.onViewChange) host.onViewChange(view);
      emit('view', view);
    }

    function openView(selector) {
      const resolved = resolveView(selector);
      viewProblem = resolved.problem;
      if (resolved.selector !== view) {
        view = resolved.selector;
        announceView();
      }
      return { ok: resolved.problem === null, selector: view, problem: resolved.problem };
    }

    // ---- Selection ---------------------------------------------------------------------------

    function select(target) {
      const wanted = selectionOf(target);
      const next = wanted && survives(wanted) ? wanted : null;
      if (JSON.stringify(next) === JSON.stringify(selection)) return;
      selection = next;
      announceSelection();
    }

    function announceSelection() {
      if (host.onSelectionChange) host.onSelectionChange(selection);
      emit('selection', selection);
    }

    function survives(candidate) {
      if (readableDesign === null) return true;
      return Object.keys(SELECTION_TARGETS).every((key) =>
        !(key in candidate) || SELECTION_TARGETS[key](readableDesign.model, candidate[key]));
    }

    // ---- Diagnostics -------------------------------------------------------------------------

    function getDiagnostics() {
      if (!released) return [];
      if (diagnosticsCache === null) diagnosticsCache = computeDiagnostics();
      return diagnosticsCache.slice();
    }

    function computeDiagnostics() {
      const found = C4.check(design, checkConfig);
      if (profile !== 'novice') return found;
      const deferred = deferredIncompleteness(found);
      return found.filter((diagnostic) => !deferred(diagnostic)
        && (diagnostic.severity !== 'info' || NOVICE_INFO_RULES.has(diagnostic.rule)));
    }

    /**
     * The novice profile defers an incompleteness finding until focus has left its subject once: the interface for
     * a finding about an interface, else the element. The core's `suppressIncompleteFor` holds a finding back when
     * either its element or its interface is listed, so an interface finding would wait for its provider too. The
     * state therefore asks the core which rules it holds back (one check with every id listed) and defers by
     * subject itself. Returns the predicate for one diagnostic of `found`.
     */
    function deferredIncompleteness(found) {
      if (design.model === null) return () => false;
      const { elements, interfaces } = design.model;
      const everyId = [...elements.keys(), ...interfaces.keys()];
      const kept = C4.check(design, Object.assign({}, checkConfig, { suppressIncompleteFor: everyId }));
      const heldRules = rulesWithFewer(kept, found);
      const untouchedElements = new Set([...elements.keys()].filter((id) => !touched.has(id)));
      const untouchedInterfaces = new Set([...interfaces.keys()].filter((id) => !touched.has(id)).map(lowerCase));
      return (diagnostic) => heldRules.has(diagnostic.rule) && (diagnostic.interface
        ? untouchedInterfaces.has(lowerCase(diagnostic.interface))
        : untouchedElements.has(diagnostic.element));
    }

    function emitDiagnostics() {
      if (released && listeners.get('diagnostics').size > 0) emit('diagnostics', getDiagnostics());
    }

    function markTouched(id) {
      if (touched.has(id)) return;
      touched.add(id);
      if (profile !== 'novice') return;
      diagnosticsCache = null;
      emitDiagnostics();
    }

    function release() {
      released = true;
      emitDiagnostics();
      return getDiagnostics();
    }

    // ---- Events ------------------------------------------------------------------------------

    /**
     * Subscribes `listener` and returns the function that unsubscribes it. Events: `text` (text, info) after every
     * change, including `setText`; `mode` (getMode()) when the read-only reason changes; `view` (selector);
     * `selection` (selection or null); `diagnostics` (the diagnostics) when released diagnostics may have changed.
     */
    function on(event, listener) {
      if (!listeners.has(event)) throw new TypeError(`The C4 editor state has no event ${JSON.stringify(event)}`);
      if (typeof listener !== 'function') throw new TypeError('A listener must be a function');
      listeners.get(event).add(listener);
      return function unsubscribe() { listeners.get(event).delete(listener); };
    }

    return {
      getText: () => text,
      setText,
      applySourceText,
      dispatch,
      lockRefusal,
      refusalText,
      undo: () => stepHistory('undo'),
      redo: () => stepHistory('redo'),
      canUndo: () => !options.readOnly && history.canUndo(),
      canRedo: () => !options.readOnly && history.canRedo(),
      /** The label of the step Undo would take back ("Rename Student"), or null: none, a host's change, a host history. */
      undoLabel: () => (options.readOnly ? null : history.undoLabel()),
      /** The label of the step Redo would repeat, or null. */
      redoLabel: () => (options.readOnly ? null : history.redoLabel()),
      /** The design visual commands and dry runs work on: the last one whose YAML could be read. */
      getDesign: () => readableDesign || design,
      openView,
      breadcrumbs,
      getView: () => view,
      /** The diagnostic of the unknown selector the last `openView` (or `options.view`) replaced, else null. */
      getViewProblem: () => viewProblem,
      select,
      getSelection: () => selection,
      getDiagnostics,
      markTouched,
      /** Releases the diagnostics of `checks.display: 'on-request'` ("Check now"); returns them. */
      checkNow: () => (display === 'after-submit' ? [] : release()),
      /** Releases the diagnostics in every display mode ("Submit for review"); returns them. */
      submitForReview: release,
      /**
       * Whether the diagnostics are released: always under `checks.display: 'live'`, otherwise after Check now or Submit
       * for review. Until then a refusal says no more than the forms show (UML-view editing spec §5.1, withheld checks).
       */
      checksReleased: () => released,
      isReadOnly: () => mode.readOnly,
      getMode,
      on,
    };
  }

  // ---- Undo histories ----------------------------------------------------------------------------

  /**
   * Text snapshots (spec §9.2): at most UNDO_LIMIT steps; an edit within COALESCE_MS of the previous edit joins its
   * step. Text from the host is a step of its own. `undo`/`redo` take the current text and return the step to
   * restore, `{ text, label }`, or null.
   */
  function snapshotHistory(now) {
    const past = [];
    const future = [];
    let lastEditAt = -Infinity;

    function push(stack, step) {
      stack.push(step);
      if (stack.length > UNDO_LIMIT) stack.shift();
    }

    function recordEdit(previousText, label) {
      const at = now();
      if (at - lastEditAt > COALESCE_MS) push(past, { text: previousText, label });
      lastEditAt = at;
      future.length = 0;
    }

    function recordExternal(previousText) {
      push(past, { text: previousText, label: null });
      lastEditAt = -Infinity;
      future.length = 0;
    }

    function labelOnTop(stack) {
      return stack.length > 0 ? stack[stack.length - 1].label : null;
    }

    function move(from, to, currentText) {
      if (from.length === 0) return null;
      const step = from.pop();
      push(to, { text: currentText, label: step.label });
      lastEditAt = -Infinity;
      return step;
    }

    return {
      recordEdit,
      recordExternal,
      undo: (currentText) => move(past, future, currentText),
      redo: (currentText) => move(future, past, currentText),
      canUndo: () => past.length > 0,
      canRedo: () => future.length > 0,
      undoLabel: () => labelOnTop(past),
      redoLabel: () => labelOnTop(future),
    };
  }

  /** `undo: 'host'`: one undo stack, the host's; the editor records nothing and changes no text itself. */
  function hostHistory(host) {
    return {
      recordEdit() {},
      recordExternal() {},
      // A step with no text: the host performs it and sends the resulting text back through setText.
      undo() { host.performUndo(); return { text: null, label: null }; },
      redo() { host.performRedo(); return { text: null, label: null }; },
      canUndo: () => Boolean(host.canUndo()),
      canRedo: () => Boolean(host.canRedo()),
      // The host's stack (Monaco's, in a tutorial) has no step labels.
      undoLabel: () => null,
      redoLabel: () => null,
    };
  }

  // ---- Helpers -----------------------------------------------------------------------------------

  function checkedHost(host) {
    if (!host || typeof host.onTextChange !== 'function') {
      throw new TypeError('The C4 editor needs host.onTextChange(text, info)');
    }
    checkedChoice('host.undo', host.undo || 'editor', ['editor', 'host']);
    const notCallable = HOST_CALLBACKS.filter((name) => host[name] !== undefined && typeof host[name] !== 'function');
    if (notCallable.length > 0) throw new TypeError(`host.${notCallable.join(', host.')} must be a function when given`);
    const missing = host.undo === 'host' ? HOST_UNDO_METHODS.filter((name) => typeof host[name] !== 'function') : [];
    if (missing.length > 0) throw new TypeError(`With undo: 'host', the host must provide ${missing.join(', ')}`);
    return host;
  }

  function checkedChoice(name, value, allowed) {
    if (!allowed.includes(value)) {
      throw new TypeError(`${name} must be one of ${allowed.join(', ')}, not ${JSON.stringify(value)}`);
    }
    return value;
  }

  function refusal(error) {
    return { ok: false, error, message: REFUSALS[error], selection: null };
  }

  /**
   * A selection object from `select`'s argument: an element id, a selection object, or null. A step of a scenario is
   * the kind `{ scenarioId, step: { containerPath, index } }` (UML-view editing spec §7.6); the core's selection after a
   * step command, `{ scenarioId, containerPath, index }`, becomes that kind, so every reader sees one shape.
   */
  function selectionOf(target) {
    if (target === null || target === undefined) return null;
    if (typeof target === 'string') return { elementId: target };
    const selection = Object.assign({}, target);
    if (selection.scenarioId && !selection.step && Array.isArray(selection.containerPath) && Number.isInteger(selection.index)) {
      selection.step = { containerPath: selection.containerPath, index: selection.index };
      delete selection.containerPath;
      delete selection.index;
    }
    if (selection.step) selection.step = { containerPath: selection.step.containerPath.slice(), index: selection.step.index };
    return selection;
  }

  /** The rule ids with fewer diagnostics in `subset` than in `all`: the rules a check configuration held back. */
  function rulesWithFewer(subset, all) {
    const counts = new Map();
    all.forEach((diagnostic) => counts.set(diagnostic.rule, (counts.get(diagnostic.rule) || 0) + 1));
    subset.forEach((diagnostic) => counts.set(diagnostic.rule, counts.get(diagnostic.rule) - 1));
    return new Set([...counts].filter(([, missing]) => missing > 0).map(([rule]) => rule));
  }

  /** Interface ids compare ignoring case, as the core's `suppressIncompleteFor` compares them. */
  function lowerCase(id) {
    return String(id).toLowerCase();
  }

  /** "setElementField" → "Set element field": the default label of a command's change. */
  function labelOf(op) {
    const words = String(op).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  /** One `{ offset, length, text }` splice turning `before` into `after`: the span between their common ends. */
  function spliceBetween(before, after) {
    if (before === after) return [];
    const shorter = Math.min(before.length, after.length);
    let start = 0;
    while (start < shorter && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;
    let end = 0;
    while (end < shorter - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end += 1;
    return [{ offset: start, length: before.length - start - end, text: after.slice(start, after.length - end) }];
  }

  // ---- Locked fields (spec §11) ------------------------------------------------------------------

  /**
   * Whether the YAML `path` (an array of keys and list indices, or the same written with dots) lies under one of the
   * `lockedFields` patterns (spec §11; Ruling 24 as amended by the plan review): a pattern is split on `.`; a `*`
   * segment matches exactly one key or list index; a lock covers the node it matches and every descendant; nothing
   * under a lock is exempt. One definition for every surface: the visual editor and the tutorial's YAML revert.
   */
  function isLockedPath(path, lockedFields) {
    const segments = pathSegments(path);
    return locksCovering(segments, lockedFields).length > 0;
  }

  /** The lock patterns, split on `.`, that cover the path `segments`: each matches a prefix of it. */
  function locksCovering(segments, lockedFields) {
    return (lockedFields || []).map((pattern) => String(pattern).split('.'))
      .filter((lock) => lock.length <= segments.length && lock.every((segment, index) => segment === '*' || segment === segments[index]));
  }

  /**
   * Whether a write that replaces the node at `path` would reach a lock: a lock covers `path` (isLockedPath), or a
   * lock lies inside it, so rewriting, removing, or reordering the node would change the locked part too. A `*` in
   * `path` stands for an entry not written yet (a new key or index), which only a `*` lock segment covers.
   */
  function touchesLockedPath(path, lockedFields) {
    if (isLockedPath(path, lockedFields)) return true;
    const segments = pathSegments(path);
    return (lockedFields || []).some((pattern) => {
      const lock = String(pattern).split('.');
      return lock.length > segments.length && segments.every((segment, index) => lock[index] === '*' || lock[index] === segment);
    });
  }

  /**
   * The path of the node a write must leave as it was to keep every lock that `path` touches (touchesLockedPath): the
   * outermost locked node that covers `path` (a prefix of it), else `path` itself when locks lie inside it. Null when
   * `path` touches no lock. The tutorial's YAML surface restores this node and keeps every other change.
   */
  function lockedNodeOf(path, lockedFields) {
    const segments = pathSegments(path);
    if (!touchesLockedPath(segments, lockedFields)) return null;
    const covering = locksCovering(segments, lockedFields).map((lock) => lock.length);
    return covering.length > 0 ? segments.slice(0, Math.min(...covering)) : segments;
  }

  function pathSegments(path) {
    return (Array.isArray(path) ? path : String(path).split('.')).map(String);
  }

  /**
   * The sentence a learner reads when a lock (spec §11) stops a change: "Locked: <subject> or a part of it is given by
   * the task, so <outcome> here." Without a subject: "Locked: given by the task, so <outcome> here." Every surface
   * words a lock this way, so a refusal and a lock note never differ for one rule.
   */
  function lockedSentence(subject, outcome = 'it cannot be changed') {
    return subject ? `Locked: ${subject} or a part of it is given by the task, so ${outcome} here.`
      : `Locked: given by the task, so ${outcome} here.`;
  }

  /** What cannot happen to the element a refused `command` acts on, in the words of lockedSentence. */
  function lockOutcome(command) {
    if (command.op === 'setElementField' && command.field === 'name') return 'it cannot be renamed';
    return LOCK_OUTCOMES[command.op];
  }

  /**
   * What a lock refusal names (UML-view editing spec §5.1): the drawn thing whose YAML node holds the locked `path`, as
   * the subject of lockedSentence, or null when the path names nothing drawn (the sentence then has no subject). The
   * subject is, in this order: the name of the element that holds the path (as before); "step <n> of <scenario>" for
   * the step of a scenario's own list that holds it (a fragment is one step, its branches are parts of it, and n
   * counts as the scenario form does); "the steps of <scenario>" for the scenario, its step list, or a step not written
   * yet; "the link from <A> to <B>" or "node <name>" in a deployment environment; "the lifeline order in this view" or
   * "the positions in this view" for a layout part of the open view `view` (bends count as positions). A path that
   * names a section as a whole is narrowed by the refused `command` (its `scenarioId`, its `viewKey`). Every subject
   * names something in `design`, the model before the refused change, so nothing new is said to be given by the task.
   */
  function lockedSubject(design, path, { command = {}, view = null } = {}) {
    if (!design || design.model === null) return null;
    const segments = pathSegments(path);
    const owner = elementHolding(design.model, segments);
    if (owner !== null) return owner.name || owner.id;
    const section = LOCK_SUBJECTS[segments[0]];
    return section ? section(design, segments, command, view) : null;
  }

  // The drawn things of the sections beside the element tree that a lock refusal can name (lockedSubject).
  const LOCK_SUBJECTS = {
    scenarios: scenarioLockSubject,
    deployment: deploymentLockSubject,
    layout: layoutLockSubject,
  };

  function scenarioLockSubject(design, path, command) {
    const scenario = design.model.scenarios.get(path.length > 1 ? path[1] : command.scenarioId);
    if (!scenario) return null;
    const title = scenario.title || scenario.id;
    if (path.length <= 2) return `the steps of ${title}`;
    if (path[2] !== 'steps') return null;
    const step = path.slice(0, 4);
    return step.length === 4 && valueAt(plainData(design), step) !== undefined ? `step ${Number(step[3]) + 1} of ${title}` : `the steps of ${title}`;
  }

  function deploymentLockSubject(design, path) {
    const environment = design.model.environments.get(path[1]);
    if (!environment) return null;
    let holder = null;
    environment.nodes.forEach((node) => {
      const holds = node.path.length <= path.length && node.path.every((key, index) => String(key) === path[index]);
      if (holds && (holder === null || node.path.length > holder.path.length)) holder = node;
    });
    if (holder === null) return null;
    const [field, targetId] = path.slice(holder.path.length);
    const target = field === 'collaborators' ? environment.nodes.get(targetId) : undefined;
    const linked = target !== undefined && holder.relationships.some((link) => link.targetId === targetId);
    return linked ? `the link from ${holder.name} to ${target.name}` : `node ${holder.name}`;
  }

  function layoutLockSubject(design, path, command, view) {
    const viewKey = path.length > 1 ? path[1] : command.viewKey;
    if (viewKey === undefined || view === null || C4.project(design, viewKey).key !== C4.project(design, view).key) return null;
    const writesOnlyLifelines = command.lifelines !== undefined && command.positions === undefined && command.routes === undefined;
    const part = path.length > 2 ? path[2] : (writesOnlyLifelines ? 'lifelines' : 'positions');
    return part === 'lifelines' ? 'the lifeline order in this view' : 'the positions in this view';
  }

  /** The element whose YAML node holds `path` (the deepest one, so a component wins over its container), or null. */
  function elementHolding(model, path) {
    let holder = null;
    for (const element of model ? model.elements.values() : []) {
      const holds = element.path.length <= path.length && element.path.every((key, index) => String(key) === String(path[index]));
      if (holds && (holder === null || element.path.length > holder.path.length)) holder = element;
    }
    return holder;
  }

  /**
   * The sentence to show for a refused dispatch `result`: a lock refusal as it is, any other as "Error: …", finished
   * with a full stop unless the message already ends in a question or exclamation mark.
   */
  function refusalText(result) {
    if (result.error === 'locked') return result.message;
    const message = result.message || 'The model could not be changed';
    return `Error: ${message}${/[?!]$/.test(message) ? '' : '.'}`;
  }

  /**
   * The sentence the editor shows when its mode refuses every change, `reason` 'read-only' or 'yaml-errors': what
   * `refusalText` makes of such a dispatch's refusal. The refusal table of the UML views shows these words.
   */
  function modeRefusalText(reason) {
    return refusalText(refusal(reason));
  }

  /**
   * The first concrete path, matched by a lock pattern in either design, whose YAML value differs between `before`
   * and `after` (a node added, removed, moved, or rewritten under a lock), or null. Values compare as plain data, so
   * comments and layout around a locked node may change while its content stays.
   */
  function changedLockedPath(before, after, lockedFields) {
    if (lockedFields.length === 0) return null;
    const [old, next] = [plainData(before), plainData(after)];
    for (const pattern of lockedFields) {
      const lock = String(pattern).split('.');
      const paths = matchingPaths(old, lock).concat(matchingPaths(next, lock));
      const changed = paths.find((path) => JSON.stringify(valueAt(old, path)) !== JSON.stringify(valueAt(next, path)));
      if (changed) return changed;
    }
    return null;
  }

  function plainData(design) {
    return design.parsed && design.parsed.document ? design.parsed.document.toJS() : null;
  }

  /** Every concrete path in `data` that the lock pattern `lock` matches (`*` = any one key or index there). */
  function matchingPaths(data, lock, prefix = []) {
    if (lock.length === 0) return [prefix];
    if (data === null || typeof data !== 'object') return [];
    const [head, ...rest] = lock;
    const keys = head === '*' ? Object.keys(data) : Object.prototype.hasOwnProperty.call(data, head) ? [head] : [];
    return keys.flatMap((key) => matchingPaths(data[key], rest, prefix.concat(key)));
  }

  function valueAt(data, path) {
    return path.reduce((node, key) => (node !== null && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, key)
      ? node[key] : undefined), data);
  }

  return {
    createEditorState: createEditorState, isLockedPath: isLockedPath, touchesLockedPath: touchesLockedPath, lockedNodeOf: lockedNodeOf,
    lockedSentence: lockedSentence, lockedSubject: lockedSubject, modeRefusalText: modeRefusalText,
  };
});
