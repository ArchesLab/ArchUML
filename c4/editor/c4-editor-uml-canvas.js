(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(globalThis, function () {
      return {
        umlAdapter: require('./c4-editor-uml-adapter.js'),
        umlRefusals: require('./c4-editor-uml-refusals.js'),
        umlLayout: require('./c4-editor-uml-layout.js'),
      };
    });
  } else {
    var parts = root.ArchUMLC4EditorParts = root.ArchUMLC4EditorParts || {};
    parts.umlCanvas = factory(root, function () { return root.ArchUMLC4EditorParts; });
  }
})(typeof self !== 'undefined' ? self : this, function (root, editorParts) {
  'use strict';

  // Editing on the canvas of an editable UML-notation view (UML-view editing spec §7.2–§7.7; plan Task 39). The canvas
  // (c4-editor-canvas.js) draws the view; this part then mounts or syncs one diagram-editor session on the drawing,
  // with the C4 model adapter (c4-editor-uml-adapter.js), the C4 editor as the session's host, and the C4 surface: the
  // module adds its aria-hidden hit layer for the pointer, and the canvas lays the listbox "Elements in this view" over
  // the drawing for the keyboard and assistive technology, with the option sets and boxes this part gives (`options`).
  //
  // The session's host services are the editor's (spec §2.4, §7.5): its announcements go to the editor's message region
  // with a kind (a verdict's offer becomes the region's offer button), its confirmations to the host's confirm or the
  // editor's dialog, its undo to the editor state's one stack, its Escape layers to the editor's Escape order, and its
  // selection to the editor state's single selection, through the view module's `selectionOf`. The module's gestures
  // join the canvas's pointer dispatcher, so the C4 editor's pan, wheel, and pinch stay as they are.
  //
  // A read-only editor mounts no session: it gets the same option sets and boxes, for its listbox and navigation alone.
  // The diagram editor's `core` group must be loaded (ArchUMLDiagramEditor and ArchUMLDiagramEditorParts); without it
  // the canvas does not create this part and draws the view as it did before.
  //
  // The C4 surface's ways into the session without a drag (Move and C modes, menus, in-place editors, the "⋯" button
  // of a selected line; spec §7.4) are the interaction part's (c4-editor-uml-interaction.js), which this part makes
  // with the session when it is loaded. This part owns what follows every drawing: the result of a drop that the
  // module applied without reporting it, and the overlap check of spec §6 rule 4 (see `overlapNotice`). Both are said
  // once the change's own announcements are made, in that order (`createAfterwards`).

  // The module's gestures a press on its hit layer starts, by the kind of target pressed (spec §3.8, plan Task 38).
  const HIT_GESTURES = [
    { selector: '.uml-pg-edit-hitbox', site: 'hitbox', gesture: 'element-move' },
    { selector: '.uml-pg-edge-hitbox', site: 'segment', gesture: 'route-edit' },
  ];
  const HOST_LAYER = '.uml-pg-edit-layer.is-host';
  // A drawn box's rectangle that moved by less than this, in drawing units, has not changed (the renderer rounds).
  const SAME_BOX_UNITS = 0.5;
  // What a drag ended by a new drawing says (the module's own words for a move without a press, diagram-editor §3.11).
  const DRAWING_CHANGED = 'The drawing changed, so the move was cancelled.';
  // How near a line's end lies to a box it ends at, in drawing units: a line's end touches the box's border.
  const TOUCH_TOLERANCE = 2;
  // What Enter does on an option of a view that opens nothing from its boxes and lines (spec §7.3, §7.4).
  const ENTER_OPENS_NOTHING = 'Enter: nothing to open';
  // How far from a lifeline's dashed line a press still lies on it, in drawing units (the module's own reach).
  const LIFELINE_REACH_UNITS = 36;
  // How far a press moves, in CSS px, before it is a drag rather than a click (the module's move threshold).
  const DRAG_START_PX = 3;

  /**
   * Attaches editing to the canvas of one editor. `options`:
   * - `canvas`: what the part uses of the canvas, `{ region, stage, redraw(), focusFirstOption(), revealInspector(),
   *   refs(), refAt(target), optionElement(ref), focusRef(ref), focusFor(selection), refreshOptions(),
   *   enterOpens(selection) }`: the options' refs in their order, the ref of the option an element is or lies in, an
   *   option's element, focus moves (each true when the option is drawn), the listbox laid again over the same drawing,
   *   and whether Enter on the option of `selection` opens a view;
   * - `state`, `actions`, `announce`, `escape`, `dom`, `ids`, `instanceId`: the editor's (the mount's part context);
   * - `dispatcher`: the canvas's pointer dispatcher (`use(gesture)`);
   * - `confirm(request)`: the host's yes-or-no question, or null (then the editor's own dialog asks);
   * - `dialogs`: `{ openMenu(spec) }`, the editor's menu helper for the adapter's chooser;
   * - `kit`: what this editor's forms are made with (`ArchUMLC4EditorParts.umlFormFactories[name](kit) → open`);
   * - `profile` ('novice' | 'expert') and `readOnly` (no session, no hit targets).
   * Returns `{ readOnly, sync(drawing), resync(), options(), select(selection), onKey(event), addTile(tile, use),
   * dropTile(tile, event), startDrawing(tool), contextMenu(event), palette(), resetLayout(), positionFor(selection),
   * destroy() }`. `sync` takes each new
   * drawing of an editable UML view, `{ svg, viewModel, uml, droppedRoutes, module }`, or null when another view is
   * drawn; `resync` builds the hit targets again over the same drawing (another magnification); `options()` gives the
   * listbox's option sets and the box of each option (`{ sets, boxOf(svg, ref) }`); `select` hands the editor's
   * selection to the session; `onKey`, `addTile`, `dropTile`, `startDrawing` (Add relationship), and `contextMenu` (a
   * right-click) are the interaction part's keys, palette tools, and menus;
   * `palette`, `resetLayout`, and `positionFor` serve the toolbar and the inspector (see the return).
   */
  function attachUmlEditing(options) {
    const { canvas, state, announce, escape, dom, ids } = options;
    const actions = options.actions || {};
    const parts = editorParts();
    const doc = canvas.region.ownerDocument;
    const editorRoot = canvas.region.closest('.c4-editor') || canvas.region;
    const readOnly = Boolean(options.readOnly);
    const profile = options.profile || 'expert';
    let drawing = null;
    let session = null;
    let interaction = null;
    let mirroring = false;
    let instruction = null;
    let stopGestures = null;
    // Verdicts already said through the session's host, so a result is never said twice.
    const reported = new WeakSet();
    const afterwards = createAfterwards((run) => {
      const timer = doc.defaultView.setTimeout(run, 0);
      return () => doc.defaultView.clearTimeout(timer);
    });

    // A drag that starts or ends places the "⋯" button again: it is absent while a drag runs (spec §3.11).
    const drags = createDragGuard(announce, () => {
      if (interaction) interaction.afterSelection();
    });
    const adapter = parts.umlAdapter.createUmlAdapter({
      state, actions, views: parts.umlViews || {}, refusals: parts.umlRefusals, layout: parts.umlLayout,
      confirm: confirmRequest, dialogs: options.dialogs || {}, forms: formsOf(options.kit), profile,
      drawing: () => drawing,
    });
    // The session's adapter: the C4 adapter, whose accepted verdicts are said once the change is drawn. A drop applies
    // its operation without reporting it (the module reports only refusals of a drag), and the C4 editor says every
    // change with its place (spec §7.4), so a result that no one said is said afterwards.
    const sessionAdapter = Object.assign({}, adapter, {
      apply(operation) {
        return Promise.resolve(adapter.apply(operation)).then((verdict) => {
          if (verdict && verdict.ok && verdict.message) afterwards.result(() => sayResult(verdict));
          return verdict;
        });
      },
    });

    const overlaps = createOverlapCheck({
      adapter: sessionAdapter, announce, afterwards, canvas, layout: parts.umlLayout, doc,
      drawing: () => drawing, viewContext: () => viewContext(), sceneFacts: () => sceneFacts(),
      say: (verdict) => host.announce(verdict.message, { verdict }),
    });

    // ---- The session's host (spec §2.4) ----------------------------------------------------------------------

    const host = {
      announce(message, { verdict = null } = {}) {
        if (verdict) reported.add(verdict);
        if (!message) return;
        announce(message, { kind: verdict && verdict.ok === false ? 'refusal' : 'result', offer: offerOf(verdict) });
      },
      status(text) {
        if (instruction) instruction.withdraw();
        instruction = text ? announce(text, { kind: 'instruction' }) : null;
      },
      confirm: confirmRequest,
      undo: () => state.undo(),
      redo: () => state.redo(),
      canUndo: () => state.canUndo(),
      canRedo: () => state.canRedo(),
      onSelectionChange: selectFromSession,
      openProperties: () => canvas.revealInspector(),
      registerEscape(layer) {
        const handle = escape.push({ close: (event) => layer.onKey(event) });
        return () => handle.remove();
      },
      autoLayout,
      // The drawing made again from the document as it is: a refused drop puts its preview back.
      redraw: () => canvas.redraw(),
    };

    /** Says an accepted verdict's result, unless the session's host said it already. */
    function sayResult(verdict) {
      if (!reported.has(verdict)) host.announce(verdict.message, { verdict });
    }

    /**
     * The region's offer for a verdict's offer (spec §3.4), or null when the offer names nothing this editor can run:
     * a view to open (`view`), a selection to show in the inspector (`select`), commands (`commands`), or an operation
     * of the module's vocabulary (`operation`). An operation applies through the session's adapter as of the drawing it
     * was refused on (its refs name that drawing's lines), so the adapter refuses it as stale on any other; the region
     * withdraws the offer with its message when the text changes. A view module decides which offers exist: the novice
     * profile is offered no relationship to declare (§5.1, D2), and an operation that adds one opens its form.
     */
    function offerOf(verdict) {
      const offer = verdict && verdict.offer;
      if (!offer || !offer.label) return null;
      if (typeof offer.view === 'string') return { label: offer.label, run: () => openViewAndFocus(offer.view) };
      if (offer.select) return { label: offer.label, run: () => showInInspector(offer.select) };
      if (Array.isArray(offer.commands)) {
        return { label: offer.label, run: () => state.dispatch({ op: 'batch', commands: offer.commands }, { label: offer.label }) };
      }
      if (offer.operation && drawing) {
        const operation = Object.assign({ revision: adapter.contents().revision }, offer.operation);
        return { label: offer.label, run: () => applyOffered(operation) };
      }
      return null;
    }

    /** Applies an offer's operation; a refusal is said (an accepted result is said once it is drawn). */
    function applyOffered(operation) {
      return sessionAdapter.apply(operation).then((verdict) => {
        if (!verdict.ok && verdict.message) host.announce(verdict.message, { verdict });
        return verdict;
      });
    }

    /**
     * Selects what an offer shows (a relationship, a node) and reveals it in the inspector. Focus (spec §7.7, accepting
     * an offer) is the canvas's selection rule (§7.6): the shown thing's option when this view draws it, else where the
     * message region gave it back.
     */
    function showInInspector(selection) {
      state.select(selection);
      canvas.revealInspector();
    }

    /** Opens the view `selector` and focuses its first option (spec §7.7, accepting an offer). */
    function openViewAndFocus(selector) {
      if (state.openView(selector).ok) canvas.focusFirstOption();
    }

    /**
     * A question before a change (spec §2.4 `confirm`): the host's when the request is yes-or-no and the host asks, else
     * the editor's dialog, whose buttons are the request's choices (resolving the chosen one, or null) or Cancel and
     * the confirming label (resolving true or false).
     */
    function confirmRequest(request) {
      if (!request.choices && typeof options.confirm === 'function') return Promise.resolve(options.confirm(request)).then(Boolean);
      const body = dom.el('div', { class: 'c4-editor__confirm' }, [
        dom.el('p', { text: request.lead || request.message || '' }),
        request.details && request.details.length > 0
          ? dom.el('ul', { class: 'c4-editor__confirm-list' }, request.details.map((detail) => dom.el('li', { text: detail })))
          : null,
      ]);
      const answers = request.choices
        ? request.choices.map((choice, index) => ({ label: choice.label, value: choice, isDefault: index === request.choices.length - 1 }))
        : [{ label: request.cancelLabel || 'Cancel', value: false, isDefault: true }, { label: request.confirmLabel || 'Continue', value: true }];
      return dom.openDialog(editorRoot, { ids, title: request.title, body, actions: answers })
        .then((value) => (request.choices ? value : value === true));
    }

    /**
     * The positions the renderer gives the open view without its layout entry (spec §2.4 `autoLayout`): the view is
     * drawn once more, out of sight in the stage, and each drawn box is measured.
     */
    function autoLayout() {
      if (!drawing || !session) return { positions: {} };
      const scratch = dom.el('div', { class: 'c4-editor__diagram c4-editor__auto-layout', 'aria-hidden': 'true' });
      canvas.stage.append(scratch);
      try {
        const { uml } = root.ArchUMLC4Render.renderDelegatedView(scratch, Object.assign({}, drawing.viewModel, { layout: null }), {});
        const svg = scratch.querySelector('svg');
        const found = Object.keys(uml.ids).map((alias) => {
          const box = root.UMLShared.renderedLayoutBox(svg, alias);
          return box ? { id: alias, label: alias, axis: 'xy', box } : null;
        }).filter(Boolean);
        return { positions: session.scene().positionsOf(found) };
      } finally {
        scratch.remove();
      }
    }

    // ---- Selection: the editor's single selection and the session's (spec §7.4 Selection, §7.6) -----------------

    /** What a view module reads of the drawn view (plan Task 34's context). */
    function viewContext() {
      return {
        design: state.getDesign(), viewModel: drawing.viewModel, uml: drawing.uml, profile,
        checksReleased: state.checksReleased(), layout: drawing.viewModel.layout,
      };
    }

    /**
     * The session's reference of the item that stands for `selection`: a line by the route the scene draws for it, a
     * box by its alias; null for a line the renderer draws without a route of its own (an inheritance branch).
     */
    function sessionRefOf(selection) {
      if (!drawing || !selection || typeof drawing.module.refOf !== 'function') return null;
      const ref = drawing.module.refOf(selection, viewContext());
      if (ref === null) return null;
      if (session.scene().routes(drawing.svg).some((route) => route.id === ref)) return { id: ref, kind: 'route' };
      const isLine = adapter.contents().relations.some((relation) => lineRefOf(relation) === ref);
      return isLine ? null : { id: ref, kind: 'node' };
    }

    /**
     * The session selected an item (a press on the drawing): the editor selects what its option stands for. A drawn
     * line that no option names (the renderer stamps no id on inheritance lines) is resolved by the boxes it touches
     * (spec §5.2 "Selecting an inheritance line"): see chooseDrawnLine.
     */
    function selectFromSession(selected) {
      if (mirroring || !drawing || !selected || !selected.id) return;
      const wanted = drawing.module.selectionOf(selected.id, viewContext());
      if (wanted !== null) state.select(wanted);
      else if (selected.kind === 'route' && !canvas.optionElement(selected.id)) chooseDrawnLine(selected.id);
    }

    /**
     * A press on the drawn line `routeId` that stands for one or more lines of the listbox: one is focused; on a shared
     * trunk, or a branch that stands for two lines, a chooser "Lines here" lists them by their options' names, and the
     * chosen one is focused (an inheritance line selects nothing in the model; its option is the selection). Both
     * wait until the press has ended, so its release and click neither close the chooser nor take the focus.
     */
    function chooseDrawnLine(routeId) {
      const reading = adapter.contents();
      const match = root.ArchUMLDiagramEditorParts.scene.readScene(drawing.svg, reading, doc.defaultView).relationRef(routeId, reading);
      const refs = match.candidates.map((line) => `rel:${line}`).filter((ref) => canvas.optionElement(ref));
      if (refs.length === 0) return;
      doc.defaultView.setTimeout(() => {
        if (refs.length === 1 || typeof actions.openMenu !== 'function') {
          canvas.focusRef(refs[0]);
          return;
        }
        actions.openMenu({
          label: 'Lines here',
          groups: [{ label: null, items: refs.map((ref) => ({ label: optionName(ref), run: () => canvas.focusRef(ref) })) }],
          placement: { anchor: canvas.optionElement(refs[0]), returnFocus: canvas.region },
        });
      }, 0);
    }

    /** Runs `change` while the session's own selection follows the editor's, so it is not handed back. */
    function mirrored(change) {
      mirroring = true;
      try {
        change();
      } finally {
        mirroring = false;
      }
    }

    // ---- Mounting, drawings, and gestures ------------------------------------------------------------------------

    function mount() {
      const editor = root.ArchUMLDiagramEditor;
      session = editor.mount({
        root: editorRoot,
        canvas: canvas.stage,
        adapter: sessionAdapter,
        host,
        surface: { attach: () => ({ detach() {} }) },
        viewport: 'host',
        bendNumbers: true,
        idPrefix: options.instanceId,
        // Snapping is on, as the classic editor's default: the module reads it from this element's `checked`.
        elements: { snapToggle: { checked: true } },
        env: {
          document: doc,
          now: () => Date.now(),
          schedule(fn, ms) {
            const timer = doc.defaultView.setTimeout(fn, ms);
            return () => doc.defaultView.clearTimeout(timer);
          },
          bundle: doc.defaultView,
        },
      });
      stopGestures = options.dispatcher.use({ start: startGesture });
      interaction = parts.umlInteraction ? parts.umlInteraction.createUmlInteraction({
        session: () => session, adapter: sessionAdapter, drawing: () => drawing, state, announce, escape, dom, ids, actions,
        canvas, root: editorRoot, say: (verdict) => host.announce(verdict.message, { verdict }),
        nameOf: optionName, selectionOf: (ref) => (drawing ? drawing.module.selectionOf(ref, viewContext()) : null),
        sceneFacts, viewContext, lifelineAt, anchorAt, dragging: () => drags.running(),
        selectedRef: () => {
          const ref = sessionRefOf(state.getSelection());
          return ref ? ref.id : null;
        },
      }) : null;
    }

    /** The name of the option `ref` in the drawn view's option sets, or the ref itself. */
    function optionName(ref) {
      const sets = drawing ? drawing.module.optionSets(viewContext()) : [];
      const found = sets.reduce((all, set) => all.concat(set.options), []).find((candidate) => candidate.ref === ref);
      return found ? found.name : ref;
    }

    /**
     * What the drawing shows of its boxes, for an operation's scene facts (spec §3.4): each drawn box's place
     * (`positions`, by alias) and rectangle (`boxes`, by alias), in drawing units.
     */
    function sceneFacts() {
      const scene = session.scene();
      return { positions: scene.positionsOf(scene.editables(drawing.svg)), boxes: overlaps.measure(drawing.svg) };
    }

    /**
     * A press on the session's hit layer starts the module's gesture for its target (spec §3.8): a box moves, a line's
     * segment bends; off the hit layer, a press on a lifeline's dashed line draws a message (startMessageDrag). The C4
     * dispatcher captures the pointer and hands the gesture its moves and its release.
     */
    function startGesture(event) {
      if (!session || !drawing || !event.target.closest) return null;
      // A press while a Move or C mode waits for a click is the mode's.
      const inMode = interaction ? interaction.pressInMode(event) : null;
      if (inMode) return inMode;
      const hit = event.target.closest(`${HOST_LAYER} .uml-pg-edit-hitbox, ${HOST_LAYER} .uml-pg-edge-hitbox`);
      if (!hit || !drawing.svg.contains(hit)) return startMessageDrag(event);
      const kind = HIT_GESTURES.find((candidate) => hit.matches(candidate.selector));
      const press = pressOn(hit, kind.site);
      const gesture = press && session.gestures.find((candidate) => candidate.id === kind.gesture);
      if (gesture && kind.site === 'hitbox' && moveRefused(press.item)) return clickThatSelects(event, hit, press, gesture);
      const started = gesture ? gesture.start(pressEvent(event, hit), press) || null : null;
      return started ? drags.hold(started) : null;
    }

    /**
     * Whether the adapter refuses a move of the drawn box `item` from where it is drawn (a ball; a lifeline head, which
     * moves only in the lifeline order): the question the module's move asks when it starts, with no scene facts yet.
     */
    function moveRefused(item) {
      const positions = { [item.id]: { x: item.box.x, y: item.box.y } };
      return !adapter.can({ op: 'layout.set', revision: adapter.contents().revision, positions, routes: [], facts: {} }).ok;
    }

    /**
     * A press on a box that cannot be moved here: a click selects what its option stands for (a ball its interface);
     * only a drag, once the pointer has moved, starts the module's move, which says why it is refused (spec §7.4).
     */
    function clickThatSelects(event, hit, press, gesture) {
      const from = { x: event.clientX, y: event.clientY };
      let dragged = null;
      return {
        move(moved) {
          if (dragged === null && Math.hypot(moved.clientX - from.x, moved.clientY - from.y) >= DRAG_START_PX) {
            dragged = gesture.start(pressEvent(event, hit), press) || { move() {}, end() {}, cancel() {} };
          }
          if (dragged) dragged.move(moved);
        },
        end(released) {
          if (dragged) {
            dragged.end(released);
            return;
          }
          const wanted = drawing ? drawing.module.selectionOf(press.item.id, viewContext()) : null;
          if (wanted !== null) state.select(wanted);
        },
        cancel(cancelled) {
          if (dragged) dragged.cancel(cancelled);
        },
      };
    }

    /**
     * A press on a lifeline's dashed line, below its head and off every hit target, in a sequence drawing: the module's
     * message drag (spec §7.4 "Draw a message": from one lifeline to another, at the height of the step). With no line
     * tool armed the drag draws the view's first one, which is put down again when the drag ends, so a drag never
     * leaves a tool armed. Null for any other press (the C4 editor's pan then takes it).
     */
    function startMessageDrag(event) {
      if (adapter.contents().type !== 'sequence' || !onLifelineBody(event)) return null;
      const gesture = session.gestures.find((candidate) => candidate.id === 'sequence-message');
      const layer = drawing.svg.querySelector(HOST_LAYER);
      const armed = session.tool();
      const tool = armed ? null : adapter.tools().relations[0] || null;
      if (!gesture || !layer || (!armed && !tool)) return null;
      if (tool) session.setTool({ kind: 'relation', spec: { id: tool.id, label: tool.label } });
      const press = { site: 'canvas', svg: drawing.svg, layer, landedOnInteractive: false, landedOnEdgeHitbox: false };
      // No element of its own takes the pointer: the C4 dispatcher holds it for the whole drag.
      const started = gesture.start(pressEvent(event, null), press) || null;
      if (!tool) return started ? drags.hold(started) : null;
      // Putting the tool down also takes back the module's word for the armed tool ("Tool stays active …").
      const putDown = () => {
        if (session) session.setTool(null);
        host.status('');
      };
      if (!started) {
        putDown();
        return null;
      }
      return drags.hold(Object.assign({}, started, {
        move: (moved) => started.move(moved),
        end(released) {
          const ended = started.end(released);
          putDown();
          return ended;
        },
        cancel(cancelled) {
          started.cancel(cancelled);
          putDown();
        },
      }));
    }

    /** Whether a press lies on a lifeline's dashed line below its head (in drawing units, as the drawing is scaled). */
    function onLifelineBody(event) {
      return lifelineAt(event) !== null;
    }

    /**
     * The alias of the lifeline whose dashed line, below its head, lies under the pointer event `event` in a sequence
     * drawing, or null (another drawing, or no lifeline there).
     */
    function lifelineAt(event) {
      if (!drawing || !session || adapter.contents().type !== 'sequence') return null;
      const svg = drawing.svg;
      const point = drawingPointOf(svg, event);
      const found = session.scene().editables(svg).find((item) => item.axis === 'x'
        && point.y > item.box.y + item.box.height
        && Math.abs(point.x - (item.box.x + item.box.width / 2)) <= LIFELINE_REACH_UNITS);
      return found ? found.id : null;
    }

    /**
     * The insertion anchor (`{ beforeLine }`, spec §3.4) at the height of the pointer event `event` in a sequence
     * drawing: where a message or fragment put there goes. Null in another drawing and at the end of the document,
     * which the view module reads as the end of the scenario.
     */
    function anchorAt(event) {
      if (!drawing || adapter.contents().type !== 'sequence') return null;
      const reading = adapter.contents();
      const point = drawingPointOf(drawing.svg, event);
      const anchor = root.ArchUMLDiagramEditorParts.scene.readScene(drawing.svg, reading, doc.defaultView).anchorAt(point.y, reading);
      return anchor.beforeLine === null ? null : anchor;
    }

    /** The module's press on the hit target `hit` (plan Task 38: `{ site, svg, layer, item | route, … }`), or null. */
    function pressOn(hit, site) {
      const svg = drawing.svg;
      const layer = hit.parentNode;
      const id = hit.getAttribute('data-layout-id');
      const scene = session.scene();
      if (site === 'hitbox') {
        const editables = scene.editables(svg);
        const item = editables.find((candidate) => candidate.id === id);
        return item ? { site, svg, layer, item, rect: hit, editables } : null;
      }
      const route = scene.routes(svg).find((candidate) => candidate.id === id);
      return route ? { site, svg, layer, route } : null;
    }

    /** Takes a new drawing of an edited view; null when the canvas draws a view this part does not edit. */
    function sync(next) {
      drawing = next;
      if (readOnly || drawing === null) {
        if (interaction) interaction.afterSync();
        return;
      }
      if (!session) mount();
      drawing.boxes = overlaps.measure(drawing.svg);
      drawing.frame = layoutFrame(drawing.boxes, drawing.viewModel.layout, drawing.uml.ids);
      drags.endForNewDrawing();
      resync();
      overlaps.check();
    }

    /** Builds the session's hit layer anew over the drawing (a new drawing, or another magnification). */
    function resync() {
      if (!session || !drawing) return;
      const revision = adapter.contents().revision;
      mirrored(() => session.sync({ svg: drawing.svg, revision }, { restore: sessionRefOf(state.getSelection()) }));
      if (interaction) interaction.afterSync();
    }

    function select(selection) {
      if (!session || !drawing) return;
      const ref = sessionRefOf(selection);
      mirrored(() => session.select(ref));
      if (interaction) interaction.afterSelection();
    }

    // ---- The listbox's options (spec §7.3) -------------------------------------------------------------------------

    /**
     * The option sets of the drawn view, each description completed for the C4 surface, and the box of each option:
     * a box's drawn box, a line's drawn route (see lineBoxesOf), a fragment's label (see fragmentBoxesOf).
     */
    function listboxOptions() {
      const context = viewContext();
      const contents = adapter.contents();
      const scene = root.ArchUMLDiagramEditorParts.scene.readScene(drawing.svg, contents, doc.defaultView);
      const lines = lineBoxesOf(scene, contents);
      const diagnostics = state.checksReleased() ? state.getDiagnostics() : [];
      const model = context.design.model;
      const problemsOf = (ref) => problemCountOf(drawing.module.selectionOf(ref, context), diagnostics, model);
      const unavailable = (ref) => (interaction ? interaction.unavailableReason(ref) : null);
      // What Enter does on an option (spec §7.3): where it opens a view (an interfaces view's neighbour), the view
      // module's description names it; elsewhere it opens nothing, and the option says so.
      const enter = (option) => {
        const selection = drawing.module.selectionOf(option.ref, context);
        return canvas.enterOpens && canvas.enterOpens(selection) ? null : ENTER_OPENS_NOTHING;
      };
      const fragments = fragmentBoxesOf(drawing.svg);
      return {
        sets: describedSets(drawing.module.optionSets(context), { problemsOf, enter, unavailable }),
        boxOf: (svg, ref) => lines.get(ref) || fragments.get(ref) || scene.boxOf(ref) || null,
      };
    }

    function destroy() {
      if (instruction) instruction.withdraw();
      afterwards.cancel();
      if (interaction) interaction.destroy();
      if (stopGestures) stopGestures();
      if (session) session.destroy();
      interaction = null;
      session = null;
      drawing = null;
    }

    /**
     * The palette of the drawn view (spec §5.6, §7.6): the adapter's `tools()`, `{ elements, relations, unavailable }`,
     * each unavailable one with its short reason and sentence. Null when no session edits a drawing.
     */
    function palette() {
      return session && drawing && interaction ? adapter.tools() : null;
    }

    /** Reset layout (spec §6 rule 3): the view's whole layout entry goes, as one change; a refusal is said. */
    function resetLayout() {
      if (!session || !drawing) return Promise.resolve(null);
      return sessionAdapter.apply({ op: 'layout.reset', revision: adapter.contents().revision, target: 'all' }).then((verdict) => {
        if (verdict && !verdict.ok && verdict.message) host.announce(verdict.message, { verdict });
        return verdict;
      });
    }

    /** What the inspector's Position section uses for the box of `selection` (null without one drawn here). */
    function positionFor(selection) {
      const ref = sessionRefOf(selection);
      if (!interaction || !session || !drawing || ref === null || ref.kind !== 'node') return null;
      const { positions } = interaction;
      const position = positions.positionOf(ref.id);
      return position && Object.assign({}, position, {
        moveBy: (dx, dy) => positions.moveBy(ref.id, dx, dy),
        moveTo: (x, y) => positions.moveTo(ref.id, x, y),
        returnToAutomatic: () => positions.returnToAutomatic(ref.id),
      });
    }

    return {
      readOnly, sync, resync, options: listboxOptions, select, destroy, palette, resetLayout, positionFor,
      // The keys of the C4 surface on an option of this view, and a palette tile chosen or dropped on it
      // (c4-editor-canvas-editing.js routes them here): true, or the addition's promise, when the interaction part took them.
      onKey: (event) => Boolean(interaction && session && drawing && interaction.onKey(event)),
      addTile: (tile, use) => (interaction && session && drawing ? interaction.addTile(tile, use) : null),
      dropTile: (tile, event) => (interaction && session && drawing ? interaction.dropTile(tile, event) : null),
      // Add relationship and a right-click (c4-editor-canvas-editing.js): true when the interaction part took them.
      startDrawing: (tool) => Boolean(interaction && session && drawing && interaction.startDrawing(tool)),
      contextMenu: (event) => Boolean(interaction && session && drawing && interaction.contextMenu(event)),
    };
  }

  /**
   * The module's drag the C4 dispatcher runs (spec Review Focus 2): `hold(started)` wraps a drag so that its release
   * ends it here first (the drawing its drop causes does not cancel it); `endForNewDrawing()`, when another drawing
   * comes before the release (YAML typed, a tutorial's Reset), ends it without a write: its preview went with the old
   * drawing, the learner hears why, and its release does nothing. `running()` says whether a drag is held;
   * `changed()` is called when one starts or ends.
   */
  function createDragGuard(announce, changed = () => {}) {
    let drag = null;
    return {
      hold(started) {
        const held = Object.assign({}, started, {
          move: (event) => started.move(event),
          end(event) {
            if (drag !== held) return;
            drag = null;
            started.end(event);
            changed();
          },
          cancel() {
            if (drag === held) drag = null;
            started.cancel();
            changed();
          },
        });
        drag = held;
        changed();
        return held;
      },
      running: () => drag !== null,
      endForNewDrawing() {
        if (drag === null) return;
        const ended = drag;
        drag = null;
        ended.cancel();
        announce(DRAWING_CHANGED, { kind: 'result' });
      },
    };
  }

  /**
   * The overlap check of spec §6 rule 4, after every drawing of an edited view: it compares the overlapping pairs in
   * which a box holds a position with those of the view's last drawing in this editor (one map per editor, by view
   * key), and names the first new pair, after the change's own announcements (`afterwards`), with the offer to move it
   * to a free place. `options`: the session's `adapter`, `announce`, `afterwards`, `canvas` (`focusFor`), the layout
   * planner (`layout`), `doc`, and `drawing()`, `viewContext()`, `sceneFacts()`, `say(verdict)`. Returns
   * `{ measure(svg), check() }`: `measure` gives each drawn box's rectangle by alias, in drawing units.
   */
  function createOverlapCheck(options) {
    const { adapter, announce, afterwards, canvas, layout, doc } = options;
    const drawnBefore = new Map();

    /**
     * The drawn boxes (`[{ id, box }]`, the scene's items in drawing order); a ball or socket sits on its component's
     * border and is no box of its own here. A box is measured by the bundle's
     * `renderedLayoutBox` where it gives one: the scene's own measure finds a class box by its name's text when the
     * class carries only a bounds id, and so measures the box on top when two classes overlap.
     */
    function drawnItems(svg) {
      const measure = root.UMLShared && root.UMLShared.renderedLayoutBox;
      return root.ArchUMLDiagramEditorParts.scene.readScene(svg, adapter.contents(), doc.defaultView).items()
        .filter((item) => item.axis !== 'port')
        .map((item) => ({ id: item.id, box: (measure && measure(svg, item.id)) || item.box }));
    }

    function measure(svg) {
      const boxes = {};
      drawnItems(svg).forEach((item) => { boxes[item.id] = item.box; });
      return boxes;
    }

    function check() {
      const drawing = options.drawing();
      const key = drawing.viewModel.key;
      const kept = drawing.viewModel.layout ? drawing.viewModel.layout.positions : new Map();
      const items = drawnItems(drawing.svg);
      const { ownedElementIds } = adapter.contents();
      const found = overlapNotice(drawnBefore.get(key) || null, items, (alias) => kept.has(drawing.uml.ids[alias]),
        (ids) => withoutNesting(overlappingPairs(items, ids), ownedElementIds), drawing.frame);
      drawnBefore.set(key, found.drawn);
      if (found.named) afterwards.notice(() => sayOverlap(found.named));
    }

    /** Says that box `moved` now overlaps box `other`, with the offer to move it to a free place. */
    function sayOverlap([moved, other]) {
      const drawing = options.drawing();
      if (!drawing || !drawing.uml.ids[moved] || !drawing.uml.ids[other]) return;
      const nameOf = (alias) => layout.displayName(drawing.uml.ids[alias], options.viewContext());
      announce(`${nameOf(moved)} now overlaps ${nameOf(other)}.`, {
        kind: 'notice', offer: { label: `Move ${nameOf(moved)} to a free place`, run: () => moveToFreePlace(moved) },
      });
    }

    /** The offer of an overlap: a move like any other, of box `alias` to the free place right of the drawn boxes. */
    function moveToFreePlace(alias) {
      const drawing = options.drawing();
      if (!drawing) return Promise.resolve(null);
      const facts = options.sceneFacts();
      const place = layout.freePlace({ boxes: facts.boxes });
      const selection = drawing.module.selectionOf(alias, options.viewContext());
      const operation = { op: 'layout.set', revision: adapter.contents().revision, positions: { [alias]: place }, routes: [], facts };
      return Promise.resolve(adapter.apply(operation)).then((verdict) => {
        if (!verdict.ok) options.say(verdict);
        else if (selection) canvas.focusFor(selection);
        return verdict;
      });
    }

    return { measure, check };
  }

  /**
   * What is said after a change is drawn, in order: the results nobody said yet (`result(say)`), then the overlap of the
   * drawing (`notice(say)`, the last one wins), at the next turn of `schedule(run) → cancel`, when the change's own
   * announcements are made. A notice is said last, so the message region keeps it with its offer.
   */
  function createAfterwards(schedule) {
    let results = [];
    let notice = null;
    let cancelPending = null;
    function flush() {
      cancelPending = null;
      const [said, last] = [results, notice];
      results = [];
      notice = null;
      said.forEach((say) => say());
      if (last) last();
    }
    function later() {
      if (cancelPending === null) cancelPending = schedule(flush);
    }
    return {
      result(say) { results.push(say); later(); },
      notice(say) { notice = say; later(); },
      cancel() {
        if (cancelPending) cancelPending();
        cancelPending = null;
        results = [];
        notice = null;
      },
    };
  }

  /**
   * The overlap of a drawing (spec §6 rule 4), DOM-free. `before` is the view's last drawing in this editor (`{ pairs,
   * rects }`, or null for its first), `items` the drawn boxes (`[{ id, box }]`, in drawing order), `holds(id)` whether a
   * box holds a position, and `overlapsAmong(ids)` the scene's overlapping pairs in the order of `ids`. Returns
   * `{ drawn, named }`: what to compare the next drawing with, and the first new pair in reading order (top to bottom,
   * then left to right) as `[moved, other]`, or null. A pair counts when one of its boxes holds a position; `moved` is
   * the box of the pair whose rectangle changed since `before`, else the later one in reading order. Rectangles are
   * compared in the layout's frame (`frame`, see layoutFrame): a drawing fitted anew shifts every kept box with it.
   */
  function overlapNotice(before, items, holds, overlapsAmong, frame = null) {
    const ordered = items.slice().sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
    const pairs = overlapsAmong(ordered.map((item) => item.id)).filter(([a, b]) => holds(a) || holds(b));
    const shift = frame || { x: 0, y: 0 };
    const rects = new Map(items.map((item) => [item.id, Object.assign({}, item.box, { x: item.box.x - shift.x, y: item.box.y - shift.y })]));
    const drawn = { pairs: new Set(pairs.map(pairKey)), rects };
    const first = pairs.find((pair) => !before || !before.pairs.has(pairKey(pair)));
    if (!first) return { drawn, named: null };
    const changed = first.filter((id) => !before || !sameBox(before.rects.get(id), rects.get(id)));
    const moved = changed.length === 1 ? changed[0] : first[1];
    return { drawn, named: [moved, first[0] === moved ? first[1] : first[0]] };
  }

  /**
   * Where the layout's origin lies in the drawing (`{ x, y }`), from a drawn box that keeps a position: the renderer
   * fits a drawing to its margins, so a box kept at (x, y) is drawn shifted by the same amount as every other. Null
   * when no drawn box keeps a position (the drawing's points are then taken as the layout's). `boxes` by alias,
   * `layout` the view's entry, `ids` the drawing's alias → model id map.
   */
  function layoutFrame(boxes, layout, ids) {
    const kept = layout ? layout.positions : new Map();
    const alias = Object.keys(boxes).find((candidate) => kept.has(ids[candidate]));
    if (alias === undefined) return null;
    const [x, y] = kept.get(ids[alias]);
    return { x: boxes[alias].x - x, y: boxes[alias].y - y };
  }

  /**
   * The pairs of `items` (`[{ id, box }]`) whose boxes overlap, each pair in the order of `ids`: the scene's
   * `overlapsAmong`, over boxes measured as drawnItems measures them.
   */
  function overlappingPairs(items, ids) {
    const overlaps = root.ArchUMLDiagramEditorParts.geometry.overlaps;
    const boxes = ids.map((id) => items.find((item) => item.id === id)).filter(Boolean);
    const pairs = [];
    boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => { if (overlaps(a.box, b.box)) pairs.push([a.id, b.id]); }));
    return pairs;
  }

  /**
   * `pairs` without those in which one box is drawn inside the other (a nested node or a hosted instance inside its
   * node): what a box holds is no overlap. `ownedElementIds(id)` gives the boxes drawn inside box `id` (contents).
   */
  function withoutNesting(pairs, ownedElementIds) {
    return pairs.filter(([a, b]) => !ownedElementIds(a).includes(b) && !ownedElementIds(b).includes(a));
  }

  /** One key per unordered pair of boxes. */
  function pairKey(pair) {
    return pair.slice().sort().join('\n');
  }

  function sameBox(a, b) {
    return Boolean(a && b) && ['x', 'y', 'width', 'height'].every((side) => Math.abs(a[side] - b[side]) < SAME_BOX_UNITS);
  }

  /** This editor's forms: each registered factory (`umlFormFactories`) made once with the editor's own kit. */
  function formsOf(kit) {
    const factories = editorParts().umlFormFactories || {};
    const forms = {};
    Object.keys(factories).forEach((name) => { forms[name] = factories[name](kit); });
    return forms;
  }

  /** The drawing point of `svg` (in its units) under the client point of the pointer event `event`. */
  function drawingPointOf(svg, event) {
    return new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
  }

  /** A pointer event as the module's gesture reads it when the press lands on `hit`: `currentTarget` is the hit target. */
  function pressEvent(event, hit) {
    return {
      type: event.type, clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId, pointerType: event.pointerType,
      button: event.button, buttons: event.buttons, detail: event.detail,
      shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey,
      target: event.target, currentTarget: hit,
      preventDefault: () => event.preventDefault(),
      stopPropagation: () => event.stopPropagation(),
    };
  }

  // ---- Descriptions and boxes (DOM-free) ---------------------------------------------------------------------------

  /**
   * `sets` with each option's description completed (spec §7.3): while a gesture marks targets, "not available: ‹short
   * reason›" for a target that is not possible (`unavailable(ref)`, spec §7.4 C mode); the view module's words (the type
   * line, "position kept"); the problem count `problemsOf(ref)` when there is one; then what Enter does, `enter(option)`.
   */
  function describedSets(sets, { problemsOf, enter, unavailable = () => null }) {
    return sets.map((set) => Object.assign({}, set, {
      options: set.options.map((option) => {
        const count = problemsOf(option.ref);
        const reason = unavailable(option.ref);
        const words = (reason ? [`not available: ${reason}`] : []).concat([option.description])
          .concat(count > 0 ? [`${count} ${count === 1 ? 'problem' : 'problems'}`] : [], [enter(option)])
          .filter(Boolean);
        return Object.assign({}, option, { description: words.join('; ') });
      }),
    }));
  }

  /**
   * The problem count of the option that stands for `selection` (spec §7.3), from `diagnostics` (each with the
   * `element` it names and the YAML `path` it lies at) of `model`: for an element, the diagnostics that name it; for a
   * step or a fragment (`{ scenarioId, step: { containerPath, index } }`), those at its place in the YAML or inside it;
   * for anything else, none.
   */
  function problemCountOf(selection, diagnostics, model) {
    if (!selection) return 0;
    if (selection.elementId) return diagnostics.filter((diagnostic) => diagnostic.element === selection.elementId).length;
    const scenario = selection.step ? model.scenarios.get(selection.scenarioId) : null;
    if (!scenario) return 0;
    const { containerPath, index } = selection.step;
    const holder = containerPath.length > 0 ? scenario.path.concat('steps', containerPath) : scenario.path;
    const place = holder.concat('steps', index);
    return diagnostics.filter((diagnostic) => Array.isArray(diagnostic.path)
      && place.every((key, at) => diagnostic.path[at] === key)).length;
  }

  /**
   * The ref of the listbox option of a relation of the drawn document (contents): the id of the route the renderer
   * draws for it (`rel:<line>`, a message's `seqmsg:<line>`), or `rel:<line>` for a line drawn without a route of its own.
   */
  function lineRefOf(relation) {
    return relation.routeId || `rel:${relation.line}`;
  }

  /**
   * The drawn box of each line option (see lineRefOf), in the drawing's units: the bounding box of the route the scene
   * draws for it. A line the renderer draws without a route of its own (a branch of a generalization or realization
   * tree) gets the routes whose end touches its source box, preferring one that also touches its target box; with
   * none, a box between its ends.
   */
  function lineBoxesOf(scene, contents) {
    const boxes = new Map();
    const routes = scene.routes();
    const items = scene.items();
    const named = new Set(contents.relations.map((relation) => relation.routeId).filter(Boolean));
    routes.forEach((route) => { if (named.has(route.id)) boxes.set(route.id, pointsBox(route.points)); });
    const unnamed = routes.filter((route) => !named.has(route.id));
    contents.relations.forEach((relation) => {
      const ref = lineRefOf(relation);
      if (boxes.has(ref)) return;
      const from = items.find((item) => item.id === relation.from);
      const to = items.find((item) => item.id === relation.to);
      if (!from || !to) return;
      const touching = unnamed.filter((route) => endsAt(route, from.box));
      const both = touching.filter((route) => endsAt(route, to.box));
      const chosen = both.length > 0 ? both : touching;
      boxes.set(ref, chosen.length > 0 ? unionBox(chosen.map((route) => pointsBox(route.points))) : betweenBoxes(from.box, to.box));
    });
    return boxes;
  }

  /**
   * The box of each drawn fragment of a sequence drawing, by its id (`frag:<line>`, as contents names it): the label
   * in its top-left corner, where the operator is written.
   */
  function fragmentBoxesOf(svg) {
    const boxes = new Map();
    root.ArchUMLDiagramEditorParts.scene.findRenderedFragments(svg).forEach((fragment) => boxes.set(fragment.id, fragment.labelBox));
    return boxes;
  }

  function pointsBox(points) {
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }

  function unionBox(boxes) {
    const x = Math.min(...boxes.map((box) => box.x));
    const y = Math.min(...boxes.map((box) => box.y));
    return { x, y, width: Math.max(...boxes.map((box) => box.x + box.width)) - x, height: Math.max(...boxes.map((box) => box.y + box.height)) - y };
  }

  /** The point halfway between the centres of two boxes, as an empty box (the overlay grows it to its least size). */
  function betweenBoxes(a, b) {
    return { x: (a.x + a.width / 2 + b.x + b.width / 2) / 2, y: (a.y + a.height / 2 + b.y + b.height / 2) / 2, width: 0, height: 0 };
  }

  /** Whether the first or the last point of `route` lies on or inside `box`. */
  function endsAt(route, box) {
    const ends = [route.points[0], route.points[route.points.length - 1]];
    return ends.some((point) => point.x >= box.x - TOUCH_TOLERANCE && point.x <= box.x + box.width + TOUCH_TOLERANCE
      && point.y >= box.y - TOUCH_TOLERANCE && point.y <= box.y + box.height + TOUCH_TOLERANCE);
  }

  /** Whether the page has the diagram editor's `core` group, which editing on a UML-notation canvas needs. */
  function isAvailable() {
    const moduleParts = root.ArchUMLDiagramEditorParts;
    return Boolean(root.ArchUMLDiagramEditor && moduleParts && moduleParts.operations && moduleParts.scene && editorParts().umlAdapter);
  }

  return {
    attachUmlEditing, isAvailable, describedSets, lineBoxesOf, problemCountOf, overlapNotice, withoutNesting, createAfterwards, layoutFrame,
    ENTER_OPENS_NOTHING,
  };
});
