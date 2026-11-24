(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(globalThis, function () {
      return {
        dom: require('./c4-editor-dom.js'), overlay: require('./c4-editor-overlay.js'), pointer: require('./c4-editor-pointer.js'),
        canvasEditing: require('./c4-editor-canvas-editing.js'), card: require('./c4-editor-card.js'),
      };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.canvas = factory(root, function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (root, editorParts) {
  'use strict';

  // The editor's canvas (spec §9.1 Canvas, §9.2). It draws the current view with the normal renderer and, on a
  // C4-notation view, lays the accessible listbox of its elements over the drawing (c4-editor-overlay.js). It owns
  // navigation on the drawing: the roving tab stop, arrow keys in reading order with selection following focus,
  // zooming into an element (Enter, the zoom badge) and out of a view (Alt+ArrowUp), the focus rules
  // of spec §9.2 for those moves and for re-rendering, view announcements, and the one pointer dispatcher (pan,
  // Ctrl/Cmd+wheel, pinch; Ruling 4). Zooming in goes through the shared `actions.zoomIn` command (Ruling 5). Editing
  // on the drawing (drags, connecting, Move, text in place by F2 or a double-click, the context menu, Delete) is the
  // canvas-editing part (c4-editor-canvas-editing.js), which this canvas creates over a narrow surface of its drawing
  // and options. On a C4-notation view a double-click edits text and never zooms (ED-12).
  //
  // A UML-notation view (code, dynamic, deployment, interfaces) is drawn through the renderer's delegated-view seam. Its
  // view module, `ArchUMLC4EditorParts.umlViews[notation]`, decides what the canvas offers on it (UML-view editing spec
  // §7.2): when the module gives option sets, the same listbox lies over the drawing (c4-editor-overlay.js `attachUml`),
  // and the module maps each option to a selection and back; without a module, or without option sets, the drawing
  // has no listbox. On a view whose module is editable, and when the page has the diagram editor's `core` group, the
  // canvas also mounts or syncs one editing session on each drawing before it lays the listbox (c4-editor-uml-canvas.js,
  // spec §7.2): the session adds the pointer's hit targets, the listbox stays the keyboard's, and a selection made in the
  // outline or a form focuses its option (spec §7.6, §7.7). The interfaces view's module gives today's read-only listbox,
  // where Enter opens the focused element's own interfaces view. `interface <id>` gets the card's Edit buttons and the marks of the selected operation
  // (c4-editor-card.js). The editing part only ever sees C4-notation drawings and their options.

  const C4_SCOPED_VIEWS = { containers: 'container', components: 'component', code: 'code' };
  const TYPE_NOUNS = { container: ['container', 'containers'], component: ['component', 'components'], code: ['code element', 'code elements'] };
  // Presses that never pan: the overlay's targets and the canvas's own controls.
  // The interface card is text to read and select, so a press on it never pans either.
  const INTERACTIVE = '[role="option"], [data-c4-handle], [data-c4-zoom], [data-c4-scope-header], a, button, input, select, textarea, '
    + 'summary, [contenteditable], .c4-interface';
  const TYPING_TARGETS = 'input, select, textarea, [contenteditable=""], [contenteditable="true"]';
  const NEXT_KEYS = new Set(['ArrowRight', 'ArrowDown']);
  const PREVIOUS_KEYS = new Set(['ArrowLeft', 'ArrowUp']);
  // Help's rows for the keys onKeydown answers (spec §9.2). The C4 levels are "show the inside" and "go up", so they
  // never read as magnification, which the toolbar calls zoom.
  const HELP_KEYS = Object.freeze([
    ['Arrow keys', 'Move between the elements of the drawing'],
    ['Enter', 'Show the inside of the focused element; in an interfaces view, open its interfaces view; in a code view, nothing opens'],
    ['Alt+↑ (Option+↑ on a Mac)', 'Go up to the view that contains this one'],
  ]);
  // One drawing unit is one CSS px at 100%; below that, hit targets grow in drawing units to stay 24 CSS px.
  const MINIMUM_TARGET_PX = 24;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // The size of the drawing of a view the renderer draws nothing for (see emptyDrawing), in drawing units.
  const EMPTY_DRAWING = { width: 480, height: 160 };

  /**
   * Fills `region` (the mount's focusable canvas scroll region) with the drawing of the current view and keeps it
   * current. `context` is the mount's part context: `state`, `dom`, `ids`, `announce`, `actions` (for `zoomIn`; may
   * be null), `gate` (may be null), `magnification` (`level()`, `set()`, `onChange()`), and `options.palette`.
   * Returns `{ viewModel(), svgText(), focusElement(id), onEditOperation(listener), pointer, scopeHeader, destroy() }`:
   * `pointer` is the canvas's pointer dispatcher, on which other parts register their gestures (`pointer.use(gesture)`);
   * `scopeHeader` is the slot on the top edge of the view's scope boundary where the mount puts the carry-down tray
   * (spec §9.3); `onEditOperation(listener)` hears the interface card's "Edit <operation>" buttons (see
   * `editOperation`) and returns the function that stops listening. When the canvas-editing part and the actions are
   * loaded, it creates the editing part over its surface (see `surface` below).
   */
  function createCanvas(region, context) {
    const { state, dom, ids, announce, magnification } = context;
    const parts = editorParts();
    const instanceId = ids('canvas');
    const doc = region.ownerDocument;
    // data-uml-fit="off": the editor's own toolbar offers Fit, so the shared figure controls stay out of the canvas.
    const stage = dom.el('div', { class: 'c4-editor__stage', 'data-uml-fit': 'off' });
    // The scope's header (spec §9.3: the carry-down tray sits "in the scope's header, at the top of the boundary"). It
    // comes before the drawing, so Tab reaches it before the elements, and is laid on the boundary's top edge
    // (placeScopeHeader); without a drawn scope boundary it heads the stage.
    const scopeHeader = dom.el('div', { class: 'c4-editor__scope-header', 'data-c4-scope-header': '' });
    region.append(stage);

    let drawn = { text: null, view: null, viewModel: null, svgText: null, uml: null, svg: null, umlSvg: null, article: null };
    let overlay = null;
    let cardOverlay = null;
    // Editing on an editable UML-notation view (c4-editor-uml-canvas.js), made with the first such drawing; null before.
    let umlEditing = null;
    // The key of the last selection focusSelectedOption saw, so a new selection is told from the same one made again.
    let markedKey = null;
    const editListeners = new Set();
    let options = [];
    // The selection the last focused option stands for, so the tab stop comes back to the same model thing.
    let tabStop = null;
    let minimumTarget = MINIMUM_TARGET_PX;
    let emptyScope = null;
    const drawListeners = new Set();

    // ---- Drawing ------------------------------------------------------------------------------------------------

    /** Draws the current view when the text or the view changed; the focused element keeps focus (spec §9.2). */
    function draw() {
      const design = state.getDesign();
      const selector = state.getView();
      if (design.text === drawn.text && selector === drawn.view) return;
      const focused = focusedSelection();
      const hadFocus = region.contains(doc.activeElement) && doc.activeElement !== region;
      detachOverlay();
      detachCard();
      if (emptyScope) emptyScope.release();
      emptyScope = null;
      // A fresh element per drawing: the renderer marks its container (role, state, classes) for what it drew last.
      const diagram = dom.el('div', { class: 'c4-editor__diagram' });
      stage.replaceChildren(scopeHeader, diagram);
      drawn = Object.assign({ text: design.text, view: selector, uml: null, svg: null, umlSvg: null, article: null },
        drawing(diagram, design, selector), { unrendered: !isRendered() });
      const title = drawn.viewModel && drawn.viewModel.title;
      region.setAttribute('aria-label', title ? `Canvas: ${title}` : 'Canvas');
      emptyScope = emptyScopeFor(design, drawn.viewModel);
      if (emptyScope) stage.prepend(emptyScope.element);
      syncUmlEditing();
      attachOverlay();
      attachCard();
      placeScopeHeader();
      if (optionForSelection(focused)) focusInCanvas(optionForSelection(focused));
      else if (hadFocus && !region.contains(doc.activeElement)) region.focus({ preventScroll: true });
      notifyDraw('drawing');
    }

    /**
     * Whether the canvas is rendered now. A drawing made while it is not (the editor hidden behind another surface,
     * such as a tutorial's YAML surface) has no measured boxes: the renderer lays out text it cannot measure, and the
     * listbox finds no box for its options. Such a drawing is made again once the canvas is rendered (`unrendered`).
     */
    function isRendered() {
      return region.getClientRects().length > 0;
    }

    /** Draws the current view again, whatever was drawn before (the same text and view included). */
    function redraw() {
      drawn.text = null;
      draw();
    }

    /** Tells the editing part that the drawing ('drawing') or only its options ('overlay') were made again. */
    function notifyDraw(kind) {
      drawListeners.forEach((listener) => listener(kind));
    }

    function drawing(diagram, design, selector) {
      const message = (text, viewModel) => {
        diagram.append(dom.el('p', { class: 'c4-editor__canvas-message', text }));
        return { viewModel: viewModel || null, svgText: null };
      };
      if (design.model === null) return message('The drawing appears once the YAML can be read.');
      const viewModel = root.ArchUMLC4.project(design, selector);
      if (viewModel.type === null) {
        return message(`This view cannot be shown: ${viewModel.diagnostics.map((item) => item.message).join('; ')}.`);
      }
      if (viewModel.notation === 'c4' && viewModel.nodes.length === 0) return message('This view has no elements yet.', viewModel);
      try {
        const { svgText, uml, droppedRoutes } = renderInto(diagram, design, viewModel, context.options && context.options.palette);
        return {
          viewModel,
          svgText,
          uml,
          droppedRoutes,
          svg: viewModel.notation === 'c4' ? diagram.querySelector('svg') : null,
          umlSvg: uml ? diagram.querySelector('svg') : null,
          article: viewModel.notation === 'interface-card' ? diagram.querySelector('article.c4-interface') : null,
        };
      } catch (error) {
        // A view the renderer cannot draw yet (or a drawing that failed) is named as such, never an empty canvas.
        return message(`This view cannot be drawn yet: ${error.message}`, viewModel);
      }
    }

    // ---- The scope's header ------------------------------------------------------------------------------------

    /** The outline of the view's scope boundary in the drawing, or null (no C4 drawing, or no scope drawn). */
    function scopeBoundary() {
      const scopeId = drawn.viewModel && drawn.viewModel.scopeId;
      if (!drawn.svg || !scopeId) return null;
      const group = [...drawn.svg.querySelectorAll('[data-c4-boundary]')].find((node) => node.getAttribute('data-c4-boundary') === scopeId);
      return group ? group.querySelector('rect') || group : null;
    }

    /**
     * Lays the scope header on the boundary's top edge, left-aligned with it and as wide as it (positions are
     * measured, so they are set through the CSSOM). It rests above the edge, so it covers no element inside; where
     * the drawing leaves no room above, it starts at the top of the stage.
     */
    function placeScopeHeader() {
      const boundary = scopeBoundary();
      scopeHeader.classList.toggle('is-anchored', boundary !== null);
      if (boundary === null) return;
      const box = boundary.getBoundingClientRect();
      const frame = stage.getBoundingClientRect();
      const top = box.top - frame.top - stage.clientTop;
      scopeHeader.style.setProperty('--c4-scope-x', `${box.left - frame.left - stage.clientLeft}px`);
      scopeHeader.style.setProperty('--c4-scope-y', `${Math.max(0, top - scopeHeader.offsetHeight)}px`);
      scopeHeader.style.setProperty('--c4-scope-width', `${box.width}px`);
    }

    // ---- The listbox over the drawing (c4-editor-overlay.js) --------------------------------------------------

    /** The drawing that carries options: a C4-notation drawing or a UML-notation drawing. */
    function optionDrawing() {
      return drawn.svg || drawn.umlSvg;
    }

    /**
     * Whether the options are the editing part's: only those of a C4-notation drawing are. A UML-notation view is
     * edited through its view module (UML-view editing spec §7.3), never through this canvas's editing part.
     */
    function isEditable() {
      return drawn.svg !== null;
    }

    /**
     * The view module of the drawn UML-notation view (`ArchUMLC4EditorParts.umlViews[notation]`), or null: no
     * UML-notation drawing, or no module loaded for its notation. A module is `{ notation, editable }` and, when it
     * offers a listbox, `optionSets(context)`, `selectionOf(ref, context)`, and `refOf(selection, context)`.
     */
    function viewModule() {
      const modules = parts.umlViews;
      return drawn.umlSvg !== null && modules ? modules[drawn.viewModel.notation] || null : null;
    }

    /** What a view module reads of the drawn view: the design, the view model, and the `toUml` result drawn. */
    function viewContext() {
      const profile = context.options ? context.options.profile : 'expert';
      return { design: state.getDesign(), viewModel: drawn.viewModel, uml: drawn.uml, profile, layout: drawn.viewModel.layout };
    }

    function attachOverlay() {
      options = [];
      const svg = optionDrawing();
      if (!svg) return;
      minimumTarget = minimumTargetFor(svg);
      overlay = drawn.svg !== null
        ? parts.overlay.attach(drawn.svg, drawn.viewModel, {
          instanceId, design: state.getDesign(), problems: problemCounts(state.getDiagnostics()), minimumTarget,
        })
        : attachUmlOverlay();
      if (overlay === null) return;
      options = isUmlEdited() ? setsInReadingOrder(overlay.targets) : readingOrder(overlay.targets);
      markOptions();
    }

    /**
     * The listbox of the view module's option sets over the UML-notation drawing, or null when its module gives none.
     * On an edited view the sets and their boxes are the editing part's (lines included), and the options let every
     * press through to the session's hit targets; otherwise the options are read-only and take the presses.
     */
    function attachUmlOverlay() {
      const module = viewModule();
      if (!module || typeof module.optionSets !== 'function') return null;
      if (isUmlEdited()) {
        const { sets, boxOf } = umlEditing.options();
        return parts.overlay.attachUml(drawn.umlSvg, drawn.viewModel, sets, {
          instanceId, minimumTarget, within: stage, readOnly: umlEditing.readOnly, boxOf,
        });
      }
      return parts.overlay.attachUml(drawn.umlSvg, drawn.viewModel, module.optionSets(viewContext()), {
        instanceId, minimumTarget, within: stage, readOnly: true,
      });
    }

    // ---- Editing on a UML-notation view (c4-editor-uml-canvas.js) -----------------------------------------------

    /** Whether the drawn view is a UML-notation view that the editing part serves. */
    function isUmlEdited() {
      return umlEditing !== null && drawn.umlSvg !== null && isEditableModule(viewModule());
    }

    function isEditableModule(module) {
      return Boolean(module && module.editable && typeof module.optionSets === 'function');
    }

    /**
     * Hands a new drawing of an editable UML-notation view to the editing part, made with the first such drawing when
     * the page has the diagram editor (spec §7.2: draw, then mount or sync one session, then lay the listbox).
     */
    function syncUmlEditing() {
      const module = viewModule();
      if (drawn.umlSvg === null || !isEditableModule(module)) {
        if (umlEditing !== null) umlEditing.sync(null);
        return;
      }
      if (umlEditing === null) umlEditing = createUmlEditing();
      if (umlEditing === null) return;
      umlEditing.sync({ svg: drawn.umlSvg, viewModel: drawn.viewModel, uml: drawn.uml, droppedRoutes: drawn.droppedRoutes || [], module });
    }

    /** The editing part of this canvas, or null when it or the diagram editor's `core` group is not loaded. */
    function createUmlEditing() {
      if (!parts.umlCanvas || !parts.umlCanvas.isAvailable()) return null;
      const actions = context.actions || {};
      return parts.umlCanvas.attachUmlEditing({
        canvas: {
          region, stage,
          redraw,
          focusFirstOption() {
            if (options[0]) focusInCanvas(options[0]);
          },
          revealInspector() {
            if (context.layout && typeof context.layout.revealRegion === 'function') context.layout.revealRegion('inspector');
          },
          refs: () => options.map((option) => option.getAttribute('data-c4-option')),
          refAt(target) {
            const option = target && target.closest ? target.closest('[role="option"]') : null;
            return option && options.includes(option) ? option.getAttribute('data-c4-option') : null;
          },
          optionElement: (ref) => optionFor(ref),
          focusRef(ref) {
            const option = optionFor(ref);
            if (option) focusInCanvas(option);
            return option !== null;
          },
          focusFor(selection) {
            const option = optionForSelection(selection);
            if (option) focusInCanvas(option);
            return option !== null;
          },
          refreshOptions: () => refreshOverlay(),
          enterOpens: opensInterfacesView,
          onDraw(listener) {
            drawListeners.add(listener);
            return () => drawListeners.delete(listener);
          },
        },
        state, actions, announce, escape: context.escape, dom, ids, instanceId, dispatcher: pointer,
        confirm: context.host && typeof context.host.confirm === 'function' ? (request) => context.host.confirm(request) : null,
        dialogs: { openMenu: (spec) => actions.openMenu(spec) },
        kit: { state, dom, ids, actions, announce, escape: context.escape, root: region.closest('.c4-editor') || region },
        profile: context.options ? context.options.profile : 'expert',
        readOnly: Boolean(context.options && context.options.readOnly),
      });
    }

    /**
     * A selection made elsewhere (the outline, a form, a press on the drawing) focuses its option on an edited view
     * (spec §7.6, §7.7), unless focus is in a field, where the learner is typing, or the option has it already.
     */
    function focusSelectedOption(selection) {
      const key = keyOfSelection(selection);
      const changed = key !== markedKey;
      markedKey = key;
      if (!changed || !isUmlEdited()) return;
      const option = optionFor(key);
      const focused = doc.activeElement;
      if (!option || focused === option || (focused && focused.closest(`${TYPING_TARGETS}, [role="menu"], dialog`))) return;
      focusInCanvas(option);
    }

    function detachOverlay() {
      if (overlay) overlay.destroy();
      overlay = null;
      options = [];
    }

    /** Lays the overlay again over the same drawing (problem counts or the hit-target size changed). */
    function refreshOverlay() {
      if (!optionDrawing()) return;
      const focused = focusedSelection();
      detachOverlay();
      // The session's hit targets keep their least CSS size at the new magnification too.
      if (isUmlEdited()) umlEditing.resync();
      attachOverlay();
      if (optionForSelection(focused)) focusInCanvas(optionForSelection(focused));
      notifyDraw('overlay');
    }

    /** The smallest hit target in drawing units: 24 CSS px at the drawing's current scale, never below 24 units. */
    function minimumTargetFor(svg) {
      const units = svg.viewBox.baseVal && svg.viewBox.baseVal.width;
      const scale = units ? svg.getBoundingClientRect().width / units : 1;
      return scale > 0 && scale < 1 ? MINIMUM_TARGET_PX / scale : MINIMUM_TARGET_PX;
    }

    /** The option whose `data-c4-option` is `key`: an element id on a C4-notation view, a view module's ref otherwise. */
    function optionFor(key) {
      return options.find((option) => option.getAttribute('data-c4-option') === key) || null;
    }

    // ---- What the options stand for (optionKeys) ------------------------------------------------------------------
    //
    // Focus is kept across drawings by the selection an option stands for, so an option is found again by its model
    // id although its key (a UML view's ref) may change.

    /** The selection the option keyed `key` stands for, or null. */
    function selectionOfKey(key) {
      return optionKeys(drawn.svg !== null, viewModule(), viewContext).selectionOf(key);
    }

    /** The key of the option that stands for `selection`, or null. */
    function keyOfSelection(selection) {
      return optionKeys(drawn.svg !== null, viewModule(), viewContext).keyOf(selection);
    }

    /** The option of the current drawing that stands for `selection`, or null. */
    function optionForSelection(selection) {
      const key = keyOfSelection(selection);
      return key === null ? null : optionFor(key);
    }

    /** The selection the focused option stands for, or null when no option has focus. */
    function focusedSelection() {
      const focused = doc.activeElement;
      return focused && options.includes(focused) ? selectionOfKey(focused.getAttribute('data-c4-option')) : null;
    }

    /**
     * Marks the selected element's option (`aria-selected`, `is-selected`) and makes one option the tab stop: the
     * selected element, else the last one focused, else the first in reading order.
     */
    function markOptions() {
      const selection = state.getSelection();
      const selectedKey = keyOfSelection(selection);
      options.forEach((option) => {
        const selected = option.getAttribute('data-c4-option') === selectedKey;
        option.setAttribute('aria-selected', String(selected));
        option.classList.toggle('is-selected', selected);
      });
      const stop = optionFor(selectedKey) || optionForSelection(tabStop) || options[0];
      if (stop) setTabStop(stop);
    }

    function setTabStop(option) {
      tabStop = selectionOfKey(option.getAttribute('data-c4-option'));
      options.forEach((each) => each.setAttribute('tabindex', each === option ? '0' : '-1'));
    }

    /**
     * Moves focus to `target` inside the canvas (an option or the empty scope's Add button). Every focus move goes
     * through here or arrives by Tab or a click; either way onFocusIn reveals the target.
     */
    function focusInCanvas(target) {
      target.focus({ preventScroll: true });
    }

    /**
     * Shows `area` inside the canvas's scroll region, then in the page between the navbar and the read-aloud bar
     * (spec §9.2 Focus). The region keeps its scroll position across views, so this runs on every focus move.
     */
    function revealInCanvas(area) {
      revealInRegion(area);
      dom.revealInPage(area);
    }

    /**
     * Shows `area` inside the canvas's scroll region and below its top scroll padding: the room an editable editor keeps
     * at the canvas's top for the message region drawn over it, as tall as the region (UML-view editing spec §7.5), so
     * a revealed element is never hidden under a message (WCAG 2.4.11). Without the region the padding is 0 and this is
     * revealInScrollRegion.
     */
    function revealInRegion(area) {
      dom.revealInScrollRegion(area, region);
      const covered = coverBottom() - area.getBoundingClientRect().top;
      if (coverRoom() > 0 && covered > 0) region.scrollTop -= covered;
    }

    /** The room an editable editor keeps at the canvas's top for its message region (the top scroll padding), in px. */
    function coverRoom() {
      return parseFloat(doc.defaultView.getComputedStyle(region).scrollPaddingTop) || 0;
    }

    /** Where that room ends, in client px: what lies wholly above this line is hidden under the message region. */
    function coverBottom() {
      return region.getBoundingClientRect().top + region.clientTop + coverRoom();
    }

    /**
     * Whether the message region hides `area` entirely: `area` ends inside the room at the canvas's top. An area that
     * ends above the canvas's top edge was scrolled out of view by the learner; no message hides it.
     */
    function isHiddenByCover(area) {
      const box = area.getBoundingClientRect();
      const visibleTop = region.getBoundingClientRect().top + region.clientTop;
      return coverRoom() > 0 && box.bottom > visibleTop && box.bottom <= coverBottom();
    }

    /**
     * After what is drawn over the canvas's top edge changed (a message appeared, was replaced, or grew), reveals what
     * has focus inside the canvas (the empty scope's button with its note) when the message now hides it entirely
     * (WCAG 2.4.11). A focused element that still shows below the message, or that the learner scrolled out of view,
     * stays where it is, because a message that appears must not move the drawing under the pointer (UML-view editing
     * spec §7.5).
     */
    function revealFocusAgain() {
      const focused = doc.activeElement;
      if (!focused || focused === region || !region.contains(focused)) return;
      const area = emptyScope && focused === emptyScope.button ? emptyScope.element : focused;
      if (isHiddenByCover(area)) revealInCanvas(area);
    }

    /**
     * Focus arrived inside the canvas. The empty scope's button is revealed with its note, so the learner sees why
     * it is there. An option becomes the tab stop and the selection (selection follows focus, spec §9.1), and is
     * revealed.
     */
    function onFocusIn(event) {
      const target = event.target;
      if (emptyScope && target === emptyScope.button) {
        revealInCanvas(emptyScope.element);
        return;
      }
      if (drawn.article && drawn.article.contains(target)) {
        revealInCanvas(target);
        return;
      }
      const option = target;
      if (!options.includes(option)) return;
      setTabStop(option);
      option.classList.add('is-focused');
      revealInCanvas(option);
      const key = option.getAttribute('data-c4-option');
      const wanted = selectionOfKey(key);
      if (wanted !== null && keyOfSelection(state.getSelection()) !== key) state.select(wanted);
    }

    function onFocusOut(event) {
      if (options.includes(event.target)) event.target.classList.remove('is-focused');
    }

    // ---- Keys (spec §9.2) --------------------------------------------------------------------------------------

    function onKeydown(event) {
      if (event.defaultPrevented || event.target.closest(TYPING_TARGETS)) return;
      if (event.key === 'ArrowUp' && event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        zoomOut();
        return;
      }
      const option = event.target;
      if (!options.includes(option) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const step = NEXT_KEYS.has(event.key) ? 1 : PREVIOUS_KEYS.has(event.key) ? -1 : 0;
      if (step !== 0) {
        event.preventDefault();
        const next = options[options.indexOf(option) + step];
        if (next) focusInCanvas(next);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        openFrom(option.getAttribute('data-c4-option'));
      }
    }

    /**
     * Enter on the option keyed `key` (and a double-click on a UML-notation view): on a C4-notation view the inside of
     * its element, in an interfaces view its element's own interfaces view. On the other UML-notation views it opens
     * nothing.
     */
    function openFrom(key) {
      if (drawn.svg !== null) {
        zoomInto(key);
        return;
      }
      const selection = selectionOfKey(key);
      if (opensInterfacesView(selection)) openInterfacesOf(selection.elementId);
      else if (isInterfacesView() && selection && selection.elementId) {
        announce(`This is already the interfaces view of ${optionName(optionForSelection(selection))}.`);
      } else if (isUmlEdited()) announce(`There is nothing to open on ${optionName(optionFor(key))}.`);
    }

    function isInterfacesView() {
      return drawn.umlSvg !== null && drawn.viewModel.notation === 'uml-component';
    }

    /**
     * Whether Enter on the option of `selection` opens a view of a UML-notation drawing: in an interfaces view, the
     * interfaces view of a consumer or provider (spec §9.5); the subject's is the view shown. The editing part's option
     * descriptions say what Enter does by this rule.
     */
    function opensInterfacesView(selection) {
      return isInterfacesView() && Boolean(selection && selection.elementId) && selection.elementId !== drawn.viewModel.scopeId;
    }

    /**
     * In an interfaces view, Enter on a consumer or provider opens that element's own interfaces view (spec §9.5) and
     * focuses it there, where it is the subject of the view.
     */
    function openInterfacesOf(elementId) {
      state.openView(`interfaces of ${elementId}`);
      const option = optionForSelection({ elementId }) || options[0];
      if (option) focusInCanvas(option);
    }

    function optionName(option) {
      const title = option && option.querySelector('title');
      return title ? title.textContent : '';
    }

    // ---- Zooming between levels (spec §9.2 "Zoom into an element", "Zoom out", Focus) -------------------------

    /** Shows the inside of an element and focuses its first child, or the empty scope's Add button. */
    function zoomInto(elementId) {
      if (!context.actions || typeof context.actions.zoomIn !== 'function') return;
      const result = context.actions.zoomIn(elementId);
      if (!result.ok) return;
      if (emptyScope) {
        focusInCanvas(emptyScope.button);
        return;
      }
      const model = state.getDesign().model;
      const child = options.find((option) => {
        const element = model.elements.get(option.getAttribute('data-c4-option'));
        return element && element.parentId === elementId;
      });
      if (child || options[0]) focusInCanvas(child || options[0]);
    }

    /** Goes up to the view that contains this one and focuses the element just left (spec §9.2 Focus). */
    function zoomOut() {
      const viewModel = drawn.viewModel;
      // The editor's trail starts at the context view (ED-10), so going up stops there.
      const crumbs = state.breadcrumbs(viewModel);
      if (crumbs.length < 2) {
        announce('This is the top view; no view contains it.');
        return;
      }
      const left = viewModel.scopeId;
      state.openView(crumbs[crumbs.length - 2].selector);
      const option = optionForSelection({ elementId: left }) || options[0];
      if (option) focusInCanvas(option);
    }

    /** A double-click on a UML-notation view opens as Enter does; on a C4-notation view it is the editing part's (ED-12). */
    function onDoubleClick(event) {
      if (drawn.svg !== null) return;
      const option = event.target.closest('[role="option"]');
      if (option && options.includes(option)) openFrom(option.getAttribute('data-c4-option'));
    }

    function onClick(event) {
      const badge = event.target.closest('[data-c4-zoom]');
      if (badge && stage.contains(badge)) zoomInto(badge.getAttribute('data-c4-zoom'));
    }

    // ---- The interface card (spec §9.5: Edit buttons, the selected operation's marks) --------------------------------

    function attachCard() {
      if (drawn.article === null || !parts.card) return;
      cardOverlay = parts.card.attach(drawn.article, { dom, onEdit: editOperation });
      markCardSelection({ reveal: false });
    }

    function detachCard() {
      if (cardOverlay) cardOverlay.destroy();
      cardOverlay = null;
    }

    /** The operation of the card's interface that the selection names, or null. */
    function selectedOperationId() {
      const selection = state.getSelection();
      const card = drawn.viewModel && drawn.viewModel.card;
      if (!card || !selection || !selection.operationId || !selection.interfaceId) return null;
      return selection.interfaceId.toLowerCase() === card.id.toLowerCase() ? selection.operationId : null;
    }

    /**
     * Marks the selected operation's blocks (a thicker dashed outline and a "Selected" badge) and, when `reveal`, scrolls
     * its semantic block into the canvas region: the canvas follows the operation the inspector works on.
     */
    function markCardSelection({ reveal }) {
      if (!cardOverlay) return;
      const blocks = cardOverlay.markSelected(selectedOperationId());
      if (reveal && blocks.length > 0) revealInRegion(blocks[0]);
    }

    /**
     * An "Edit <operation>" button was pressed: each listener receives `{ interfaceId, operationId, returnFocus }` and
     * opens the operation in the interface form (the mount connects the inspector). `returnFocus` stands for the
     * button to come back to; it finds the button again on use, because editing the operation redraws the card.
     */
    function editOperation(operationId) {
      const interfaceId = drawn.viewModel.card.id;
      const current = () => {
        const card = cardOverlay && drawn.viewModel && drawn.viewModel.card;
        return card && card.id === interfaceId ? cardOverlay.editButton(operationId) : null;
      };
      const returnFocus = {
        get isConnected() { return current() !== null; },
        focus() {
          const again = current();
          if (again) focusInCanvas(again);
        },
      };
      if (editListeners.size === 0) announce(`Editing ${operationId} needs the inspector, which this editor does not show.`);
      editListeners.forEach((listener) => listener({ interfaceId, operationId, returnFocus }));
    }

    // ---- The empty scope (spec §9.2: "Add the first container/component") --------------------------------------

    /**
     * For a container, component, or code view whose scope has no children yet: a note and an "Add the first …"
     * button, which uses the palette's activation hook (Ruling 3), so the new element is selected with its name ready
     * for editing. Returns `{ element, button, release() }`, or null when the scope has children or nothing can add.
     */
    function emptyScopeFor(design, viewModel) {
      const type = viewModel && C4_SCOPED_VIEWS[viewModel.type];
      const scope = type && design.model.elements.get(viewModel.scopeId);
      const actions = context.actions;
      if (!scope || scope.childIds.length > 0 || !actions || typeof actions.activatePaletteTile !== 'function') return null;
      const [noun, plural] = TYPE_NOUNS[type];
      const tile = { kind: 'element', elementType: type, label: noun, scopeId: scope.id, view: viewModel.selector };
      const button = dom.el('button', {
        type: 'button', class: 'c4-editor__button c4-editor__button--primary',
        on: { click: (event) => actions.activatePaletteTile(tile, { source: 'empty-state', event }) },
      }, `Add the first ${noun}`);
      const element = dom.el('div', { class: 'c4-editor__empty-scope' }, [
        dom.el('p', { class: 'c4-editor__empty-scope-note', text: `${scope.name} has no ${plural} yet.` }),
        button,
      ]);
      const release = context.gate ? context.gate.gate(button) : () => {};
      return { element, button, release };
    }

    // ---- Wiring ------------------------------------------------------------------------------------------------

    const pointer = parts.pointer.createPointerDispatcher(region, {
      magnification,
      isEmpty: (target) => stage.contains(target) && !target.closest(INTERACTIVE),
    });
    const controller = new AbortController();
    const listen = { signal: controller.signal };
    region.addEventListener('focusin', onFocusIn, listen);
    region.addEventListener('focusout', onFocusOut, listen);
    region.addEventListener('keydown', onKeydown, listen);
    region.addEventListener('dblclick', onDoubleClick, listen);
    region.addEventListener('click', onClick, listen);
    const stops = [
      state.on('text', draw),
      state.on('view', () => {
        draw();
        if (drawn.viewModel) announce(root.ArchUMLC4.describe(drawn.viewModel).brief);
      }),
      state.on('selection', (selection) => {
        markOptions();
        if (isUmlEdited()) umlEditing.select(selection);
        focusSelectedOption(selection);
        markCardSelection({ reveal: true });
      }),
      state.on('diagnostics', refreshOverlay),
      magnification.onChange(() => {
        const svg = optionDrawing();
        if (svg && minimumTargetFor(svg) !== minimumTarget) refreshOverlay();
      }),
    ];
    if (context.layout && typeof context.layout.onCanvasCoverChange === 'function') {
      stops.push(context.layout.onCanvasCoverChange(revealFocusAgain));
    }
    // The header's own height (the tray appearing or going) and the stage's size (the drawing magnified) move where
    // the header rests; draw() places it for each new drawing. A stage that gets its size back after a drawing made
    // while it was not rendered (another surface shown) has its drawing made again (see isRendered).
    const resizes = typeof root.ResizeObserver === 'function' ? new root.ResizeObserver(() => {
      if (drawn.unrendered && isRendered()) redraw();
      else placeScopeHeader();
    }) : null;
    if (resizes) [scopeHeader, stage].forEach((observed) => resizes.observe(observed));
    draw();

    /**
     * What the editing part may use of this canvas: the scroll region and stage, `uml()` (see below), the drawing
     * (`svg()`, null without a C4-notation drawing) and its view model, the options in reading order, focus moves
     * (which reveal what they focus), `reveal(area)` (shows an area of the canvas below the message region and between
     * the page's bars), the pointer dispatcher, and `onDraw(listener)` (returns the function that stops listening). The
     * options of a UML-notation view are not the editing part's: it sees none there.
     */
    const surface = {
      region,
      stage,
      // The editing part of an edited UML-notation view, which takes the keys on its options, the palette's tools,
      // Add relationship, and a right-click there (spec §3.11, §7.4), and serves the toolbar's palette and Reset layout
      // and the inspector's Position section (§7.6) through the actions (c4-editor-actions-canvas.js); null on any
      // other view.
      uml: () => (isUmlEdited() ? {
        onKey: umlEditing.onKey, addTile: umlEditing.addTile, dropTile: umlEditing.dropTile, palette: umlEditing.palette,
        resetLayout: umlEditing.resetLayout, positionFor: umlEditing.positionFor, startDrawing: umlEditing.startDrawing,
        contextMenu: umlEditing.contextMenu,
      } : null),
      svg: () => drawn.svg,
      viewModel: () => drawn.viewModel,
      options: () => (isEditable() ? options.slice() : []),
      optionFor: (elementId) => (isEditable() ? optionFor(elementId) : null),
      focusOption: focusInCanvas,
      reveal: revealInCanvas,
      pointer,
      onDraw(listener) {
        drawListeners.add(listener);
        return () => drawListeners.delete(listener);
      },
    };
    const editing = parts.canvasEditing && context.actions ? parts.canvasEditing.createCanvasEditing(surface, context) : null;

    return {
      viewModel: () => drawn.viewModel,
      svgText: () => drawn.svgText,
      /** Focuses the option of `elementId` in the current drawing; false when the view does not show it. */
      focusElement(elementId) {
        const option = optionForSelection({ elementId });
        if (option) focusInCanvas(option);
        return option !== null;
      },
      onEditOperation(listener) {
        editListeners.add(listener);
        return () => editListeners.delete(listener);
      },
      pointer,
      scopeHeader,
      /** Help's `[key, effect]` rows for the keys the canvas answers: its navigation, then its editing part's keys. */
      helpKeys: () => HELP_KEYS.concat(editing ? editing.helpKeys : []),
      destroy() {
        if (resizes) resizes.disconnect();
        if (editing) editing.destroy();
        if (umlEditing) umlEditing.destroy();
        drawListeners.clear();
        editListeners.clear();
        detachCard();
        stops.forEach((stop) => stop());
        controller.abort();
        pointer.destroy();
        detachOverlay();
        if (emptyScope) emptyScope.release();
        stage.remove();
      },
    };
  }

  // ---- What the options stand for, reading order, and problem counts (DOM-free) ------------------------------------

  /**
   * How the options of a drawing name what they stand for. An option of a C4-notation drawing (`isC4`) is keyed by its
   * element's id and stands for the selection of that element. An option of a UML-notation drawing is keyed by its view
   * module's ref, which `module` maps to a selection and back with `selectionOf(ref, context)` and `refOf(selection,
   * context)`, `context` given by `contextOf()`; without a module or those members its options select nothing.
   * Returns `{ selectionOf(key) → selection | null, keyOf(selection) → key | null }`.
   */
  function optionKeys(isC4, module, contextOf) {
    if (isC4) {
      return { selectionOf: (key) => ({ elementId: key }), keyOf: (selection) => (selection && selection.elementId) || null };
    }
    const maps = (member) => module !== null && typeof module[member] === 'function';
    return {
      selectionOf: (key) => (maps('selectionOf') ? module.selectionOf(key, contextOf()) : null),
      keyOf: (selection) => (selection && maps('refOf') ? module.refOf(selection, contextOf()) : null),
    };
  }


  /**
   * The options in reading order (spec §9.2): rows from top to bottom, each left to right. An option joins the row
   * of the option that starts it when its vertical centre lies within that option's height.
   */
  function readingOrder(targets) {
    const boxes = targets.map((target) => ({
      target,
      x: Number(target.getAttribute('x')),
      y: Number(target.getAttribute('y')),
      height: Number(target.getAttribute('height')),
    })).sort((a, b) => a.y - b.y || a.x - b.x);
    const rows = [];
    boxes.forEach((box) => {
      const row = rows[rows.length - 1];
      if (row && box.y + box.height / 2 <= row.first.y + row.first.height) row.boxes.push(box);
      else rows.push({ first: box, boxes: [box] });
    });
    return rows.flatMap((row) => row.boxes.sort((a, b) => a.x - b.x)).map((box) => box.target);
  }

  /**
   * The options of an edited UML-notation drawing: set by set, as the listbox holds them (boxes, then lines), each set
   * in reading order. So the arrow keys go through the sets in the order assistive technology reads them, and a line,
   * which may cross the whole drawing, never lands between the boxes.
   */
  function setsInReadingOrder(targets) {
    const sets = [];
    targets.forEach((target) => {
      const set = sets[sets.length - 1];
      if (set && set.holder === target.parentNode) set.targets.push(target);
      else sets.push({ holder: target.parentNode, targets: [target] });
    });
    return sets.flatMap((set) => readingOrder(set.targets));
  }

  /** `{ elementId: count }` of the diagnostics that name an element (Ruling 11). */
  function problemCounts(diagnostics) {
    const counts = {};
    diagnostics.forEach((diagnostic) => {
      if (diagnostic.element) counts[diagnostic.element] = (counts[diagnostic.element] || 0) + 1;
    });
    return counts;
  }

  // ---- Rendering ---------------------------------------------------------------------------------------------------

  /**
   * Renders `viewModel` into `diagram` and returns `{ svgText, uml, droppedRoutes }`: the standalone SVG text for export
   * (null for an interface card, which is text) and, for a UML-notation view, the `toUml` result its drawing was made
   * from (null otherwise) and the stored routes the drawing left out (UML-view editing spec §6; empty otherwise). A C4-notation view is drawn with the pins its key keeps; a UML-notation view through the renderer's
   * delegated-view seam (UML-view editing spec §7.1), with the layout entry its view model carries.
   */
  function renderInto(diagram, design, viewModel, palette) {
    const renderer = root.ArchUMLC4Render;
    if (viewModel.notation === 'interface-card') {
      renderer.renderCard(diagram, viewModel);
      return { svgText: null, uml: null };
    }
    const { svgText, uml = null, droppedRoutes = [] } = viewModel.notation === 'c4'
      ? renderer.renderView(diagram, viewModel, { pins: design.model.layout.get(viewModel.key), palette })
      : renderer.renderDelegatedView(diagram, viewModel, { palette });
    if (uml !== null && svgText === null) diagram.append(emptyDrawing(diagram.ownerDocument));
    // Print gives a drawing too wide for 9 pt labels in a portrait column a landscape page, as it does figures.
    renderer.markPrintOrientation(diagram);
    // Both drawings leave the naming to their caller, as `render` does: the drawing is named by its brief
    // description, which the overlay turns into the group name of the editing canvas while it is attached.
    root.UMLShared.applySvgAccessibility(diagram, 'c4', null, root.ArchUMLC4.describe(viewModel).brief);
    return { svgText, uml, droppedRoutes };
  }

  /**
   * The drawing of a UML-notation view the renderer draws nothing for, such as a new scenario's dynamic view, which
   * has no lifeline yet (the renderer says so above it): an empty SVG of EMPTY_DRAWING units, which the editing part
   * edits like any other drawing, so the view's palette adds its first element (UML-view editing Review Focus 1).
   */
  function emptyDrawing(doc) {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${EMPTY_DRAWING.width} ${EMPTY_DRAWING.height}`);
    svg.setAttribute('width', String(EMPTY_DRAWING.width));
    svg.setAttribute('height', String(EMPTY_DRAWING.height));
    return svg;
  }

  return { createCanvas: createCanvas };
});
